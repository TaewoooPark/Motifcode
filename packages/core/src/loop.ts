/**
 * The agent loop.
 *
 * Ordinary in shape — ask, act, feed back — with four departures that all trace
 * to something specific about Motif-3:
 *
 *   1. A turn that produces no actions is not an answer. Finishing requires the
 *      `done` tool, because a dropped tool call and a final reply are otherwise
 *      indistinguishable, and that ambiguity is the documented way this model's
 *      sessions die quietly.
 *
 *   2. Failures get a structured repair turn rather than a free-form retry. The
 *      pruning literature found one repair turn erases a 2-bit quantisation
 *      penalty, and compressed models gain more from it than intact ones. We
 *      ship a pruned model; this loop is where that gain is collected.
 *
 *   3. Parse failures are budgeted, and crossing the budget changes the action
 *      channel rather than the prompt.
 *
 *   4. `done` is confirmed twice, following Terminus 2, so a hallucinated
 *      completion costs one turn instead of the task.
 */

import {
  ToolValidator,
  formatErrors,
  getChannel,
  looksLikeLeakedToolCall,
  parseToolCalls,
  repairContext,
  splitThinking,
  type Action,
  type ChannelId,
  type Tool,
} from "@motifcode/protocol";
import { BreakageBudget, LoopGuard, nextChannel, type BudgetState } from "./budget.js";
import type { EventSink, LoopEvent, SessionEndReason, ToolInvocation } from "./events.js";
import { Session } from "./session.js";
import { TransportError, type Transport } from "./transport.js";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Executor {
  /** Run one tool call. Never throws; failures come back as `ok: false`. */
  run(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult>;
}

export interface LoopOptions {
  transport: Transport;
  tools: Tool[];
  system: string;
  /**
   * The task this session exists to perform, verbatim.
   *
   * Required, and required to be non-blank. A session whose first request is
   * system-only asks the model to work on nothing, and every downstream
   * artifact — trajectory, benchmark row, profiling corpus — inherits that
   * emptiness while still looking like a real run. The one honest way to stop
   * that is to make the task impossible to omit.
   */
  userTask: string;
  executor: Executor;
  emit: EventSink;
  channel?: ChannelId;
  maxTurns?: number;
  maxRepairs?: number;
  /** Retries for a server that died mid-session; GB10 makes this routine. */
  maxServerRetries?: number;
  signal?: AbortSignal;
}

/** Thrown before any model request when the caller supplied no task. */
export class EmptyTaskError extends Error {
  constructor() {
    super("a session needs a non-empty task: the first user message cannot be blank");
    this.name = "EmptyTaskError";
  }
}

export interface LoopResult {
  reason: SessionEndReason;
  summary?: string;
  turns: number;
  budget: Readonly<BudgetState>;
  channel: ChannelId;
}

const MAX_TOOL_OUTPUT = 10_000;

/**
 * Keep the head and the tail, drop the middle.
 *
 * Following Terminus 2: the beginning of a long output says what happened and
 * the end says how it finished; the middle is usually the part nobody needs.
 */
export function clampOutput(text: string, maxBytes = MAX_TOOL_OUTPUT): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const buf = Buffer.from(text, "utf8");
  const head = buf.subarray(0, half).toString("utf8");
  const tail = buf.subarray(bytes - half).toString("utf8");
  const omitted = bytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
  return `${head}\n… ${omitted} bytes omitted …\n${tail}`;
}

/**
 * Why a turn's actions were refused as a batch.
 *
 * All-or-nothing is the point. A turn that asks for three things and gets one
 * of them wrong has left the repository in a state neither the model nor the
 * harness can describe: two edits applied, one not, and a repair prompt that
 * cannot say which. Refusing the whole turn costs one round trip and keeps the
 * tree in a state the next prompt can talk about.
 */
export type RefusalKind =
  /** An argument did not satisfy the tool's registered schema. */
  | "invalid_arguments"
  /** The payload was recovered by inventing structure, so it may be partial. */
  | "incomplete_payload"
  /** The server stopped at the token cap; anything after that point is missing. */
  | "output_truncated"
  /** `done` arrived alongside other actions, which has no coherent reading. */
  | "mixed_done";

export interface Refusal {
  kind: RefusalKind;
  detail: string;
}

/** Whitespace-insensitive comparison, so a reflowed summary still matches. */
function normalizeSummary(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `c${idCounter}`;
}

/** Exposed for deterministic replay tests. */
export function resetIds(): void {
  idCounter = 0;
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const {
    transport,
    tools,
    system,
    executor,
    emit,
    maxTurns = 100,
    maxRepairs = 2,
    maxServerRetries = 3,
    signal,
  } = opts;

  if (opts.userTask.trim() === "") throw new EmptyTaskError();

  let channel: ChannelId = opts.channel ?? "toolcall";
  // `system -> user(task)`. The task keeps its own turn and its own bytes: the
  // exact string the caller passed is what the model reads.
  const session = new Session({
    system,
    tools,
    initialMessages: [{ role: "user", content: opts.userTask }],
  });
  const budget = new BreakageBudget();
  const guard = new LoopGuard();
  const ctx = repairContext(tools);
  // One validator for every path that can produce a call. A second
  // implementation would be a second set of rules, and the gap between them is
  // where the bad call gets in.
  const validator = new ToolValidator(tools);

  const toolNames = tools.map((t) => ("function" in t && t.function ? t.function.name : ""));
  emit({
    type: "session_start",
    model: transport.model,
    endpoint: transport.endpoint,
    channel,
    tools: toolNames,
    toolsHash: hashTools(toolNames),
  });

  let turn = 0;
  let repairsThisTask = 0;
  let pendingDone: string | null = null;
  let serverRetries = 0;

  const finish = (reason: SessionEndReason, summary?: string): LoopResult => {
    emit({ type: "session_end", reason, summary });
    return { reason, summary, turns: turn, budget: budget.snapshot, channel };
  };

  while (turn < maxTurns) {
    if (signal?.aborted) return finish("aborted");
    turn++;
    emit({ type: "turn_start", turn });

    const { sharedChars, totalChars } = session.renderWithPrefix();
    emit({ type: "prefix", sharedChars, totalChars });

    let response;
    try {
      response = await transport.complete({
        messages: [...session.history],
        tools,
        signal,
      });
      serverRetries = 0;
    } catch (err) {
      if (err instanceof TransportError && err.isServerDeath && serverRetries < maxServerRetries) {
        serverRetries++;
        emit({
          type: "notice",
          level: "warn",
          text: `server unavailable (${err.message}); retry ${serverRetries}/${maxServerRetries}. Session state is intact.`,
        });
        turn--;
        continue;
      }
      emit({ type: "notice", level: "error", text: String(err) });
      return finish("transport_error");
    }

    // The server's reasoning parser gives us `reasoning_content` directly; on
    // the raw path we split it ourselves. Either way it goes into history.
    // The server's reasoning parser gives us `reasoning_content` directly; on
    // the raw path we split it ourselves. Either way it goes into history.
    const split =
      response.reasoningContent !== undefined
        ? { reasoning: response.reasoningContent, content: response.content }
        : splitThinking(response.rawText);

    if (split.reasoning) {
      emit({ type: "reasoning_delta", text: split.reasoning });
      emit({ type: "reasoning_end", chars: split.reasoning.length, ms: response.ms });
    }

    const usage = session.usage();
    const outTokens = response.usage?.completionTokens ?? 0;
    emit({
      type: "usage",
      contextTokens: usage.tokens,
      kvBytes: usage.kvBytes,
      tokensPerSecond: response.ms > 0 ? (outTokens / response.ms) * 1000 : 0,
    });

    const parsed = getChannel(channel).parse(split.content, ctx, response.toolCalls);
    if (parsed.analysis || parsed.plan) {
      emit({ type: "plan", analysis: parsed.analysis, plan: parsed.plan });
    }
    if (parsed.content) emit({ type: "content_delta", text: parsed.content });

    for (const sample of parsed.unrecoverable) {
      emit({ type: "parse_failure", kind: "unrecoverable", sample: sample.slice(0, 200) });
    }
    if (parsed.truncated) {
      emit({ type: "parse_failure", kind: "truncated", sample: "" });
    }

    // No actions: either the model leaked broken syntax, or it tried to answer
    // in prose. Both are non-terminal here.
    if (parsed.actions.length === 0) {
      const leaked =
        parsed.unrecoverable.length > 0 ||
        parsed.truncated ||
        (channel === "toolcall" &&
          looksLikeLeakedToolCall(parseToolCalls(split.content, ctx)));
      if (leaked) {
        emit({ type: "parse_failure", kind: "leaked", sample: parsed.content.slice(0, 200) });
      }
      budget.recordFailure();

      const downgrade = budget.downgradeReason();
      if (downgrade) {
        const to = nextChannel(channel);
        if (to) {
          emit({ type: "channel_downgrade", from: channel, to, reason: downgrade });
          channel = to;
          budget.onChannelChange();
        } else if (budget.exhausted) {
          return finish("breakage_limit");
        }
      } else if (budget.exhausted) {
        return finish("breakage_limit");
      }

      session.appendAssistant({ content: split.content, reasoning: split.reasoning });
      session.append({
        role: "user",
        content: repairPrompt(
          leaked
            ? "Your last turn did not produce a usable action. It looks like tool-call syntax that failed to parse."
            : "Your last turn produced no action.",
          channel,
        ),
      });
      emit({ type: "repair", reason: leaked ? "unparsed action" : "no action", attempt: 1, max: 1 });
      continue;
    }

    // ---- the action gate -------------------------------------------------
    //
    // Everything between parsing and execution happens here, and nothing gets
    // past it partially. Each check below is a way a turn can parse cleanly and
    // still not mean what it appears to.
    const refusals: Refusal[] = [];

    // A response that hit the token cap is missing its tail by definition. The
    // bracket balancer will still produce valid JSON from what arrived, and a
    // command cut off mid-word balances exactly as cleanly as a whole one.
    if (response.finishReason === "length") {
      refusals.push({
        kind: "output_truncated",
        detail: "the response stopped at the output token cap, so the last action is incomplete",
      });
    }

    for (const a of parsed.actions) {
      if (a.repair && !a.repair.complete) {
        refusals.push({
          kind: "incomplete_payload",
          detail: `a ${a.kind === "done" ? "done" : a.name} action was only recoverable by inventing structure`,
        });
      }
    }

    const doneActions = parsed.actions.filter(
      (a): a is Extract<Action, { kind: "done" }> => a.kind === "done",
    );
    const toolActions = parsed.actions.filter(
      (a): a is Extract<Action, { kind: "tool" }> => a.kind === "tool",
    );
    if (doneActions.length > 0 && toolActions.length > 0) {
      refusals.push({
        kind: "mixed_done",
        detail: "`done` arrived in the same turn as other actions; finish or keep working, not both",
      });
    }

    for (const a of parsed.actions) {
      const name = a.kind === "done" ? "done" : a.name;
      const args =
        a.kind === "done"
          ? { summary: a.summary, ...(a.confirm !== undefined ? { confirm: a.confirm } : {}) }
          : a.arguments;
      const check = validator.validate(name, args);
      if (!check.ok) {
        refusals.push({ kind: "invalid_arguments", detail: `${name}: ${formatErrors(check.errors)}` });
      }
    }

    if (refusals.length > 0) {
      // A turn whose actions cannot be run is a lost turn, exactly like one
      // that did not parse — so it counts against the same budget. Anything
      // else would let a model that emits well-formed nonsense run forever.
      budget.recordFailure();
      pendingDone = null;
      for (const r of refusals) {
        emit({ type: "parse_failure", kind: "rejected", sample: `${r.kind}: ${r.detail}`.slice(0, 200) });
      }
      if (budget.exhausted) return finish("breakage_limit");
      session.appendAssistant({ content: split.content, reasoning: split.reasoning });
      session.append({
        role: "user",
        content: refusalPrompt(refusals, channel),
      });
      emit({ type: "repair", reason: refusals[0]!.kind, attempt: 1, max: 1 });
      continue;
    }

    const repaired = parsed.actions.some((a) => a.kind === "tool" && a.repaired);
    budget.recordSuccess(repaired);

    // Completion, in two steps.
    //
    // The first `done` is a proposal, never an ending — not even with
    // `confirm: true`, because a model that emits the confirmation flag on its
    // own first attempt has not been challenged. The second must carry
    // `confirm: true` *and* repeat the proposed summary; anything else means
    // the model answered a different question than the one it was asked.
    const doneAction = doneActions[0];
    if (doneAction) {
      if (pendingDone === null) {
        pendingDone = normalizeSummary(doneAction.summary);
        session.appendAssistant({ content: split.content, reasoning: split.reasoning });
        session.append({ role: "user", content: confirmationChallenge(doneAction.summary, channel) });
        emit({ type: "notice", level: "info", text: "completion proposed; awaiting confirmation" });
        continue;
      }
      if (doneAction.confirm !== true) {
        session.appendAssistant({ content: split.content, reasoning: split.reasoning });
        session.append({
          role: "user",
          content:
            "That was not a confirmation. To end the session, repeat the same summary with " +
            "`confirm: true`. To keep working, take the next action instead.",
        });
        emit({ type: "notice", level: "warn", text: "completion not confirmed; session continues" });
        continue;
      }
      if (normalizeSummary(doneAction.summary) !== pendingDone) {
        // A different summary is a different claim, and confirming a claim the
        // harness never proposed is not a confirmation of anything.
        const proposed = pendingDone;
        pendingDone = null;
        session.appendAssistant({ content: split.content, reasoning: split.reasoning });
        session.append({
          role: "user",
          content:
            `The confirmation did not match the summary you proposed:\n\n${proposed}\n\n` +
            "Repeat that summary verbatim with `confirm: true`, or keep working.",
        });
        emit({ type: "notice", level: "warn", text: "confirmation summary did not match" });
        continue;
      }
      return finish("done", doneAction.summary);
    }
    // Any other action withdraws a pending proposal: the model went back to
    // work, so the completion it proposed is no longer the state of the world.
    pendingDone = null;

    const calls: ToolInvocation[] = toolActions.map((a) => ({
      id: nextId(),
      name: a.name,
      arguments: a.arguments,
      repaired: a.repaired,
      validated: true,
    }));

    session.appendAssistant({
      content: parsed.content,
      reasoning: split.reasoning,
      toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
    });

    let anyFailure = false;
    let combinedOutput = "";
    for (const call of calls) {
      emit({ type: "tool_start", call });
      const started = Date.now();
      const result = await executor.run(call, signal);
      const output = clampOutput(result.output);
      emit({ type: "tool_end", id: call.id, ok: result.ok, output, ms: Date.now() - started });
      session.appendToolResult(call.id, output);
      combinedOutput += output;
      if (!result.ok) anyFailure = true;
    }

    const verdict = guard.observe(LoopGuard.signature(calls), combinedOutput);
    if (verdict.tripped) {
      emit({ type: "loop_detected", signature: verdict.signature.slice(0, 120), repeats: verdict.repeats });
      return finish("loop_detected");
    }

    // The repair turn. Not a retry — a structured hand-back of what failed, so
    // the model corrects rather than wanders.
    if (anyFailure && repairsThisTask < maxRepairs) {
      repairsThisTask++;
      emit({ type: "repair", reason: "tool failure", attempt: repairsThisTask, max: maxRepairs });
      session.append({
        role: "user",
        content:
          "The command above failed. Read its output carefully, identify the specific cause, " +
          "and fix it. Do not repeat the same command unchanged.",
      });
    } else if (!anyFailure) {
      repairsThisTask = 0;
    }

    if (session.needsCompaction()) {
      emit({ type: "notice", level: "info", text: "compacting context" });
      session.compact("(summary pending — the summariser lands with the skills package)");
    }
  }

  return finish("turn_limit");
}

function confirmationChallenge(summary: string, channel: ChannelId): string {
  const how =
    channel === "toolcall"
      ? "call `done` again with the same `summary` and `confirm: true`"
      : channel === "object"
        ? 'reply with the same "summary" plus "task_complete": true and "confirm": true'
        : "repeat the same <summary> with <task_complete>true</task_complete> and <confirm>true</confirm>";
  return [
    "Before this counts as finished: is the task actually complete? Ending the session",
    "means no further changes are possible.",
    "",
    "You proposed this summary:",
    "",
    summary,
    "",
    `If that is right, ${how}. If not, keep working — take the next action instead.`,
  ].join("\n");
}

function refusalPrompt(refusals: readonly Refusal[], channel: ChannelId): string {
  const lines = refusals.map((r) => `  - ${r.detail}`);
  const advice =
    refusals.some((r) => r.kind === "output_truncated" || r.kind === "incomplete_payload")
      ? "Emit the whole action again from the start. Keep long arguments — patches especially — short enough to finish in one response."
      : refusals.some((r) => r.kind === "mixed_done")
        ? "Send either the remaining actions or `done`, not both in one turn."
        : "Check each argument against the schema you were given: required fields, types, and no extra keys.";
  return [
    "None of the actions in that turn were run. The harness refuses a turn as a whole rather",
    "than applying part of it, so the repository is exactly as you left it.",
    "",
    ...lines,
    "",
    advice,
    "",
    repairPrompt("", channel).trim(),
  ].join("\n");
}

function repairPrompt(problem: string, channel: ChannelId): string {
  const how =
    channel === "toolcall"
      ? "Emit a well-formed `<tool_call>` block. Watch backslashes: inside JSON strings, shell `$` and regex metacharacters must be escaped or avoided."
      : channel === "object"
        ? "Reply with a single well-formed JSON object matching the schema you were given."
        : "Reply with the XML shape you were given. Command bodies are verbatim — do not escape anything inside them.";
  return `${problem}\n\n${how}\n\nEvery turn must contain at least one action, and the task ends only by calling \`done\`.`;
}

function hashTools(names: string[]): string {
  // Not cryptographic — just a stable fingerprint of the frozen tool list, so
  // the status line can show at a glance whether the prefix still matches.
  let h = 2166136261;
  for (const ch of names.join(" ")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type { LoopEvent };
