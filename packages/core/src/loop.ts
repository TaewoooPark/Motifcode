/**
 * The agent loop.
 *
 * Ordinary in shape — ask, act, feed back — with departures that all trace to
 * something specific about Motif-3 or about the hardware it runs on:
 *
 *   1. A turn that produces no actions is not an answer. Finishing requires the
 *      `done` tool, because a dropped tool call and a final reply are otherwise
 *      indistinguishable, and that ambiguity is the documented way this model's
 *      sessions die quietly.
 *
 *   2. Nothing runs until the whole turn has been checked. Schema-invalid
 *      arguments, payloads recovered by inventing structure, and `done` mixed
 *      with other actions all refuse the turn as a batch rather than applying
 *      part of it.
 *
 *   3. Parse failures are budgeted. Crossing the budget can change the action
 *      channel, and a channel change is a real change: a different endpoint, a
 *      different request body, a different way of writing the transcript down.
 *
 *   4. `done` is proposed and then confirmed, so a hallucinated completion
 *      costs one turn instead of the task. Confirmation says the agent believes
 *      it is finished. It is not evidence that the work is correct — that comes
 *      from a grader outside this loop.
 *
 *   5. A dead server is an expected event, not an exception. A single local GPU
 *      serving this checkpoint falls over, and the loop distinguishes "the
 *      socket refused" from "the request was wrong".
 */

import {
  ToolValidator,
  callDigest,
  formatErrors,
  getCodec,
  looksLikeLeakedToolCall,
  parseToolCalls,
  repairContext,
  splitThinking,
  type Action,
  type ChannelCodec,
  type ChannelId,
  type ChannelParse,
  type CompletionRequest,
  type Tool,
} from "@motifcode/protocol";
import { BreakageBudget, LoopGuard, nextChannel, type BudgetState } from "./budget.js";
import {
  PROTOCOL_VERSION,
  isMutating,
  type LoopCheckpoint,
  type RepoState,
} from "./checkpoint.js";
import type { EventSink, LoopEvent, SessionEndReason, ToolInvocation } from "./events.js";
import { Session } from "./session.js";
import { TransportError, backoffDelay, sleep, type Transport } from "./transport.js";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Executor {
  /** Run one tool call. Never throws; failures come back as `ok: false`. */
  run(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult>;
}

/**
 * Whether the loop may change channel mid-session.
 *
 * `fixed` is the setting every benchmark uses. A channel change is a prefix
 * break and a different wire protocol, so a run that silently switched would be
 * two experiments reported as one.
 */
export type ChannelPolicy = "fixed" | "adaptive";

export interface LoopOptions {
  transport: Transport;
  tools: Tool[];
  /**
   * The system prompt for a given channel.
   *
   * A function rather than a string because the channel can change, and the
   * system turn has to change with it: after a downgrade the old prompt would
   * be instructing the model in a format the parser no longer reads.
   */
  system: (channel: ChannelId) => string;
  /**
   * The task this session exists to perform, verbatim.
   *
   * Required, and required to be non-blank. A session whose first request is
   * system-only asks the model to work on nothing, and every downstream
   * artifact — trajectory, benchmark row, profiling corpus — inherits that
   * emptiness while still looking like a real run.
   */
  userTask: string;
  executor: Executor;
  emit: EventSink;
  channel?: ChannelId;
  channelPolicy?: ChannelPolicy;
  maxTurns?: number;
  maxRepairs?: number;
  /** Retries for a server that died mid-session; GB10 makes this routine. */
  maxServerRetries?: number;
  /** Output cap per model step. Sent on the wire, not merely assumed. */
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  signal?: AbortSignal;
  /** Injected for deterministic backoff in tests. */
  random?: () => number;
  /** Identifies this scope in the journal. Defaults to `root`. */
  scopeId?: string;
  /** Recorded in checkpoints so a resume can refuse a moved repository. */
  repo?: RepoState;
  /**
   * Continue an interrupted run instead of starting one.
   *
   * The caller is responsible for having checked compatibility and for having
   * refused a checkpoint with an uncertain in-flight mutating tool; see
   * `checkpoint.ts`.
   */
  resume?: LoopCheckpoint;
  /**
   * Called after every model response and around every tool call.
   *
   * Around, not after: the checkpoint written before a tool runs records the
   * intent, and the one after clears it. A crash between them is the only way
   * to know a command may have half-happened.
   */
  onCheckpoint?: (checkpoint: LoopCheckpoint) => void;
  /**
   * Lifecycle notifications for whatever runs hooks.
   *
   * `hooks` declared seven events and only two were ever called; `OnParseFail`
   * in particular was documented as the way a project collects its own corpus
   * of the failures it sees, and never fired. The loop knows when these happen
   * and nothing else does, so the notification has to originate here.
   */
  lifecycle?: (event: LifecycleEvent, context: LifecycleContext) => Promise<void>;
}

/** Points in a session that something outside the loop may want to observe. */
export type LifecycleEvent = "SessionStart" | "SessionEnd" | "OnParseFail" | "OnRepair";

export interface LifecycleContext {
  scopeId: string;
  turn: number;
  channel: ChannelId;
  detail?: string;
}

export interface ChannelTransition {
  turn: number;
  from: ChannelId;
  to: ChannelId;
  reason: string;
}

export interface LoopResult {
  reason: SessionEndReason;
  summary?: string;
  turns: number;
  budget: Readonly<BudgetState>;
  /** Where the session ended up. Use `initialChannel` to group runs. */
  channel: ChannelId;
  initialChannel: ChannelId;
  channelPolicy: ChannelPolicy;
  transitions: ChannelTransition[];
  transportErrors: number;
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

/** Thrown before any model request when the caller supplied no task. */
export class EmptyTaskError extends Error {
  constructor() {
    super("a session needs a non-empty task: the first user message cannot be blank");
    this.name = "EmptyTaskError";
  }
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

/**
 * Call ids come from a per-scope sequence held in the checkpoint.
 *
 * A module-global counter meant two sessions in one process interleaved their
 * ids, and a resumed session restarted from 1 and collided with ids already in
 * its own transcript.
 */
export function resetIds(): void {
  // Retained so existing callers keep working; ids are per-scope now, so there
  // is no global state left to reset.
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

  const resume = opts.resume;
  const scopeId = opts.scopeId ?? resume?.scopeId ?? "root";
  const repo: RepoState = opts.repo ?? resume?.repo ?? { cwd: process.cwd() };
  const initialChannel: ChannelId = resume?.initialChannel ?? opts.channel ?? "toolcall";
  const channelPolicy: ChannelPolicy = opts.channelPolicy ?? "fixed";
  let channel: ChannelId = resume?.currentChannel ?? initialChannel;
  let codec: ChannelCodec = getCodec(channel);

  // `system -> user(task)`. The task keeps its own turn and its own bytes: the
  // exact string the caller passed is what the model reads. On resume the whole
  // transcript comes back instead — assistant turns, tool results, the lot.
  const session = new Session({
    system: system(channel),
    tools,
    initialMessages: [{ role: "user", content: opts.userTask }],
  });
  if (resume) session.restoreMessages(resume.messages);
  const budget = resume ? BreakageBudget.restore(resume.breakage) : new BreakageBudget();
  const guard = resume ? LoopGuard.restore(resume.loopGuard) : new LoopGuard();
  const ctx = repairContext(tools);
  // One validator for every path that can produce a call. A second
  // implementation would be a second set of rules, and the gap between them is
  // where the bad call gets in.
  const validator = new ToolValidator(tools);

  const lifecycle = async (event: LifecycleEvent, detail?: string): Promise<void> => {
    if (!opts.lifecycle) return;
    await opts.lifecycle(event, {
      scopeId,
      turn,
      channel,
      ...(detail !== undefined ? { detail } : {}),
    });
  };

  const toolNames = tools.map((t) => ("function" in t && t.function ? t.function.name : ""));
  emit({
    type: "session_start",
    model: transport.model,
    endpoint: transport.endpoint,
    channel,
    tools: toolNames,
    toolsHash: hashTools(toolNames),
  });

  let turn = resume?.turn ?? 0;
  let repairsThisTask = resume?.repairsThisTask ?? 0;
  let pendingDone: string | null = resume?.pendingDone ?? null;
  let transportErrors = resume?.transportErrors ?? 0;
  let callSequence = resume?.nextCallSequence ?? 1;
  let seq = resume?.afterSeq ?? 0;
  const transitions: ChannelTransition[] = [];

  void lifecycle("SessionStart");

  const nextId = (): string => `${scopeId}-c${callSequence++}`;

  /**
   * Write a checkpoint.
   *
   * `inFlight` is set before a tool runs and cleared after. A checkpoint that
   * still carries one is the record of a command whose outcome nobody knows.
   */
  const checkpoint = (inFlight?: LoopCheckpoint["inFlightTool"]): void => {
    if (!opts.onCheckpoint) return;
    seq++;
    opts.onCheckpoint({
      scopeId,
      afterSeq: seq,
      messages: session.messages.map((m) => ({ ...m })),
      turn,
      currentChannel: channel,
      initialChannel,
      breakage: budget.capture(),
      loopGuard: guard.capture(),
      repairsThisTask,
      pendingDone,
      nextCallSequence: callSequence,
      transportErrors,
      repo,
      ...(inFlight ? { inFlightTool: inFlight } : {}),
    });
  };

  const finish = (reason: SessionEndReason, summary?: string): LoopResult => {
    // Fire and forget: a hook must not be able to prevent a session ending, and
    // awaiting one here would let a wedged script hold the process open.
    void lifecycle("SessionEnd", reason);
    emit({ type: "session_end", reason, summary });
    return {
      reason,
      summary,
      turns: turn,
      budget: budget.snapshot,
      channel,
      initialChannel,
      channelPolicy,
      transitions,
      transportErrors,
    };
  };

  const requestOptions = {
    ...(opts.maxOutputTokens !== undefined ? { maxTokens: opts.maxOutputTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.topP !== undefined ? { topP: opts.topP } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(signal ? { signal } : {}),
  };

  /**
   * Move to a new channel by starting a new session segment.
   *
   * Not by swapping a parser. The old transcript is written in a format the new
   * channel does not use, and dressing it up as the new one would show the model
   * a conversation it never had. Instead the segment restarts with the new
   * channel's system prompt and the original task, and says plainly that the
   * format changed. The filesystem is untouched, which is the state that
   * actually matters; only the conversation restarts.
   */
  const changeChannel = (to: ChannelId, reason: string): void => {
    transitions.push({ turn, from: channel, to, reason });
    emit({ type: "channel_downgrade", from: channel, to, reason });
    channel = to;
    codec = getCodec(to);
    session.restart(system(to), [
      {
        role: "user",
        content: [
          opts.userTask,
          "",
          "---",
          "",
          `Note: the action format changed to ${to} because ${reason}. Earlier turns of`,
          "this session used a different format and are not shown. Any files you already",
          "changed are still changed — check the working tree before redoing work.",
        ].join("\n"),
      },
    ]);
    budget.onChannelChange();
    guard.reset();
    pendingDone = null;
  };

  while (turn < maxTurns) {
    if (signal?.aborted) return finish("aborted");
    turn++;
    emit({ type: "turn_start", turn });

    const request: CompletionRequest = codec.buildRequest(session, tools, requestOptions);
    const { sharedChars, totalChars } = session.observePrefix(request.prompt ?? session.render());
    emit({ type: "prefix", sharedChars, totalChars });

    let response;
    let attempt = 0;
    for (;;) {
      try {
        response = await transport.complete(request);
        break;
      } catch (err) {
        // Only transport failures are handled here. An arbitrary exception out
        // of a transport is a bug in the harness or in a test double, and
        // reporting it as "the server died" hides it behind a plausible story.
        if (!TransportError.is(err)) throw err;
        const te = err;
        transportErrors++;
        if (te.kind === "aborted") return finish("aborted");
        if (!te.retryable || attempt >= maxServerRetries) {
          emit({ type: "notice", level: "error", text: `${te.kind}: ${te.message}` });
          return finish("transport_error");
        }
        attempt++;
        const delay = backoffDelay(attempt, opts.random ? { random: opts.random } : {});
        emit({
          type: "notice",
          level: "warn",
          text: `${te.kind}: ${te.message}; retry ${attempt}/${maxServerRetries} in ${delay}ms. Session state is intact.`,
        });
        try {
          await sleep(delay, signal);
        } catch {
          return finish("aborted");
        }
      }
    }

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

    emit({
      type: "usage",
      contextTokens: session.usage().tokens,
      kvBytes: session.usage().kvBytes,
      promptTokens: response.usage?.promptTokens,
      completionTokens: response.usage?.completionTokens,
      requestMs: response.ms,
    });

    checkpoint();

    const parsed: ChannelParse = codec.parse({ ...response, content: split.content }, ctx);
    if (parsed.analysis || parsed.plan) {
      emit({ type: "plan", analysis: parsed.analysis, plan: parsed.plan });
    }
    if (parsed.content) emit({ type: "content_delta", text: parsed.content });

    for (const sample of parsed.unrecoverable) {
      emit({ type: "parse_failure", kind: "unrecoverable", sample: sample.slice(0, 200) });
      await lifecycle("OnParseFail", sample.slice(0, 2000));
    }
    if (parsed.truncated) emit({ type: "parse_failure", kind: "truncated", sample: "" });
    for (const sample of parsed.invalidArguments ?? []) {
      emit({ type: "parse_failure", kind: "rejected", sample: sample.slice(0, 200) });
    }

    /** Record the model's turn and a harness reply, in this channel's format. */
    const handBack = (text: string): void => {
      session.appendAll(codec.serializeAssistant(split.content, split.reasoning, parsed));
      session.appendAll(codec.serializeHarnessTurn(text));
    };

    // No actions: either the model leaked broken syntax, or it tried to answer
    // in prose. Both are non-terminal here.
    if (parsed.actions.length === 0) {
      const leaked =
        parsed.unrecoverable.length > 0 ||
        parsed.truncated ||
        (parsed.invalidArguments?.length ?? 0) > 0 ||
        (channel === "toolcall" && looksLikeLeakedToolCall(parseToolCalls(split.content, ctx)));
      if (leaked && parsed.unrecoverable.length === 0 && !parsed.truncated) {
        emit({ type: "parse_failure", kind: "leaked", sample: parsed.content.slice(0, 200) });
      }
      budget.recordFailure();
      pendingDone = null;

      const downgrade = channelPolicy === "adaptive" ? budget.downgradeReason() : null;
      const to = downgrade ? nextChannel(channel) : null;
      if (downgrade && to) {
        changeChannel(to, downgrade);
        emit({ type: "repair", kind: "parse", reason: "channel changed", attempt: 1, max: 1 });
        checkpoint();
        continue;
      }
      if (budget.exhausted) return finish("breakage_limit");

      handBack(
        repairPrompt(
          leaked
            ? "Your last turn did not produce a usable action. It looks like action syntax that failed to parse."
            : "Your last turn produced no action.",
          channel,
        ),
      );
      emit({
        type: "repair",
        kind: "parse",
        reason: leaked ? "unparsed action" : "no action",
        attempt: 1,
        max: 1,
      });
      await lifecycle("OnRepair", leaked ? "unparsed action" : "no action");
      checkpoint();
      continue;
    }

    // ---- the action gate -------------------------------------------------
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
      // A turn whose actions cannot be run is a lost turn, exactly like one that
      // did not parse — so it counts against the same budget. Anything else
      // would let a model that emits well-formed nonsense run forever.
      budget.recordFailure();
      pendingDone = null;
      for (const r of refusals) {
        emit({ type: "parse_failure", kind: "rejected", sample: `${r.kind}: ${r.detail}`.slice(0, 200) });
      }
      if (budget.exhausted) return finish("breakage_limit");
      handBack(refusalPrompt(refusals, channel));
      emit({ type: "repair", kind: "refusal", reason: refusals[0]!.kind, attempt: 1, max: 1 });
      await lifecycle("OnRepair", refusals[0]!.detail);
      checkpoint();
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
        handBack(confirmationChallenge(doneAction.summary, channel));
        emit({ type: "notice", level: "info", text: "completion proposed; awaiting confirmation" });
        checkpoint();
        continue;
      }
      if (doneAction.confirm !== true) {
        handBack(
          "That was not a confirmation. To end the session, repeat the same summary with " +
            "`confirm: true`. To keep working, take the next action instead.",
        );
        emit({ type: "notice", level: "warn", text: "completion not confirmed; session continues" });
        checkpoint();
        continue;
      }
      if (normalizeSummary(doneAction.summary) !== pendingDone) {
        // A different summary is a different claim, and confirming a claim the
        // harness never proposed is not a confirmation of anything.
        const proposed = pendingDone;
        pendingDone = null;
        handBack(
          `The confirmation did not match the summary you proposed:\n\n${proposed}\n\n` +
            "Repeat that summary verbatim with `confirm: true`, or keep working.",
        );
        emit({ type: "notice", level: "warn", text: "confirmation summary did not match" });
        checkpoint();
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

    session.appendAll(codec.serializeAssistant(split.content, split.reasoning, parsed));

    let anyFailure = false;
    let combinedOutput = "";
    for (const call of calls) {
      emit({ type: "tool_start", call });
      // Durable intent, written before anything runs. Without it, a crash mid
      // `apply_patch` is indistinguishable from a crash before it.
      checkpoint({
        id: call.id,
        name: call.name,
        argumentsHash: callDigest(call.name, call.arguments),
        mutating: isMutating(call.name),
      });
      const started = Date.now();
      const result = await executor.run(call, signal);
      const output = clampOutput(result.output);
      emit({ type: "tool_end", id: call.id, ok: result.ok, output, ms: Date.now() - started });
      session.appendAll(
        codec.serializeObservation({
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
          output,
          ok: result.ok,
        }),
      );
      combinedOutput += output;
      if (!result.ok) anyFailure = true;
      checkpoint();
    }

    const verdict = guard.observe(LoopGuard.signature(calls), combinedOutput);
    if (verdict.tripped) {
      emit({ type: "loop_detected", signature: verdict.signature.slice(0, 120), repeats: verdict.repeats });
      return finish("loop_detected");
    }

    // The tool-failure repair turn.
    //
    // This is a product behaviour: a command exited non-zero, and the model is
    // handed the output rather than left to guess. It is deliberately *not* the
    // one-repair protocol from the pruning literature, which grades a first
    // attempt with an external test suite and shows the model the failing case
    // exactly once. Reporting one as the other would claim a result this loop
    // has not produced.
    if (anyFailure && repairsThisTask < maxRepairs) {
      repairsThisTask++;
      emit({ type: "repair", kind: "tool_failure", reason: "tool failure", attempt: repairsThisTask, max: maxRepairs });
      await lifecycle("OnRepair", "tool failure");
      session.appendAll(
        codec.serializeHarnessTurn(
          "The command above failed. Read its output carefully, identify the specific cause, " +
            "and fix it. Do not repeat the same command unchanged.",
        ),
      );
    } else if (!anyFailure) {
      repairsThisTask = 0;
    }
    checkpoint();
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
  const advice = refusals.some(
    (r) => r.kind === "output_truncated" || r.kind === "incomplete_payload",
  )
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
  for (const ch of names.join(" ")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type { LoopEvent };
