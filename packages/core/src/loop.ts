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
  executor: Executor;
  emit: EventSink;
  channel?: ChannelId;
  maxTurns?: number;
  maxRepairs?: number;
  /** Retries for a server that died mid-session; GB10 makes this routine. */
  maxServerRetries?: number;
  signal?: AbortSignal;
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

  let channel: ChannelId = opts.channel ?? "toolcall";
  const session = new Session({ system, tools });
  const budget = new BreakageBudget();
  const guard = new LoopGuard();
  const ctx = repairContext(tools);

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

    const repaired = parsed.actions.some((a) => a.kind === "tool" && a.repaired);
    budget.recordSuccess(repaired);

    // Completion, with the two-step confirmation Terminus 2 uses.
    const doneAction = parsed.actions.find((a): a is Extract<Action, { kind: "done" }> => a.kind === "done");
    if (doneAction) {
      if (pendingDone === null) {
        pendingDone = doneAction.summary;
        session.appendAssistant({ content: split.content, reasoning: split.reasoning });
        session.append({
          role: "user",
          content:
            "Are you sure the task is complete? This ends the session and no further changes are possible. " +
            "If so, call `done` again with `confirm: true`. If not, keep working.",
        });
        emit({ type: "notice", level: "info", text: "completion proposed; awaiting confirmation" });
        continue;
      }
      return finish("done", doneAction.summary || pendingDone);
    }
    pendingDone = null;

    const calls: ToolInvocation[] = parsed.actions
      .filter((a): a is Extract<Action, { kind: "tool" }> => a.kind === "tool")
      .map((a) => ({ id: nextId(), name: a.name, arguments: a.arguments, repaired: a.repaired }));

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
