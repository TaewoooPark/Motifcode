/**
 * Turning a journal into the two very different things people want from it.
 *
 * `motif distil` used to emit a pretty-printed JSON *array* of objects holding
 * metadata and a list of tool calls, and the guide told you to feed that array
 * to a profiler that reads line-delimited objects with a `text` field. The two
 * had never been connected. Nor would connecting them have helped: the export
 * carried no task, no assistant text, no reasoning, no tool output, no channel
 * and no grade, so it was insufficient as training data and insufficient as a
 * profiling corpus, in different ways.
 *
 * Those are separate contracts and they are separate here:
 *
 *   `trajectory-jsonl`  structured messages, tool executions, agent result and
 *                       grade — the shape training and analysis want.
 *   `profile-jsonl`     one rendered document per line, which is what the
 *                       routing profiler reads.
 *
 * The rendered text and the structured messages are never the same field. A
 * profiler wants the exact token stream the model would see; a trainer wants
 * roles it can mask. Presenting one as the other is how a corpus ends up
 * measuring the wrong distribution.
 */

import type { ChannelId, Message } from "@motifcode/protocol";
import type { LoopEvent, ParseFailureKind } from "@motifcode/core";
import type {
  AgentResult,
  GraderResult,
  JournalEnvelopeV2,
  JournalHeaderV2,
  ParsedJournal,
} from "./index.js";

/* ------------------------------------------------------------------ */
/* metrics                                                            */
/* ------------------------------------------------------------------ */

export interface ChannelTransitionRecord {
  turn: number;
  from: ChannelId;
  to: ChannelId;
  reason: string;
}

export interface RunMetrics {
  rootTurns: number;
  /**
   * Turns spent inside subagents.
   *
   * Reported, never folded into `rootTurns`. A configuration that delegates
   * heavily would otherwise look identical to one that does the work itself,
   * and the two have very different costs.
   */
  childTurns: number;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  parseFailures: Record<ParseFailureKind, number>;
  repairedToolCalls: number;
  /** Repair turns by cause; the three are not interchangeable. See E-008. */
  repairTurns: { parse: number; refusal: number; tool_failure: number };
  initialChannel: ChannelId;
  finalChannel: ChannelId;
  channelPolicy: "fixed" | "adaptive";
  channelTurns: Record<ChannelId, number>;
  channelTransitions: ChannelTransitionRecord[];
  promptTokens?: number;
  completionTokens?: number;
  wallMs: number;
  transportErrors: number;
}

const ZERO_PARSE_FAILURES: Record<ParseFailureKind, number> = {
  unrecoverable: 0,
  leaked: 0,
  truncated: 0,
  rejected: 0,
};

/**
 * Parse breakage rate.
 *
 * `parse-failed model turns / action-producing model turns`, stated because
 * the denominator is the whole argument. Dividing by *all* turns folds in the
 * turns that never tried to act, and dividing by successful parses inverts the
 * direction under load.
 */
export function parseBreakageRate(m: RunMetrics): number {
  const failed = Object.values(m.parseFailures).reduce((a, b) => a + b, 0);
  const denominator = m.modelCalls;
  return denominator === 0 ? 0 : failed / denominator;
}

/** Repaired calls over parsed calls — a different question from breakage. */
export function repairedCallRate(m: RunMetrics): number {
  return m.toolCalls === 0 ? 0 : m.repairedToolCalls / m.toolCalls;
}

/* ------------------------------------------------------------------ */
/* trajectories                                                       */
/* ------------------------------------------------------------------ */

export interface ToolExecutionRecord {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  repaired: boolean;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface TrajectoryV2 {
  schemaVersion: 2;
  runId: string;
  scopeId: string;
  parentScopeId?: string;
  task: { text: string; source?: string; instanceId?: string };
  model: JournalHeaderV2["model"];
  config: JournalHeaderV2["config"];
  messages: Message[];
  toolExecutions: ToolExecutionRecord[];
  agentResult: AgentResult;
  /** Always present. `not_run` is a value, not an absence to be filtered away. */
  grade: GraderResult;
  metrics: RunMetrics;
}

const NOT_RUN: GraderResult = {
  status: "not_run",
  score: 0,
  graderName: "none",
  graderVersion: "0",
  startedAt: "",
  finishedAt: "",
};

interface ScopeSlice {
  scopeId: string;
  parentScopeId?: string;
  kind: "root" | "subagent";
  task: string;
  events: LoopEvent[];
  result?: AgentResult;
  grade?: GraderResult;
  messages: Message[];
}

function sliceByScope(records: readonly JournalEnvelopeV2[]): Map<string, ScopeSlice> {
  const scopes = new Map<string, ScopeSlice>();
  const ensure = (env: JournalEnvelopeV2): ScopeSlice => {
    let s = scopes.get(env.scopeId);
    if (!s) {
      s = {
        scopeId: env.scopeId,
        ...(env.parentScopeId !== undefined ? { parentScopeId: env.parentScopeId } : {}),
        kind: env.scopeKind,
        task: "",
        events: [],
        messages: [],
      };
      scopes.set(env.scopeId, s);
    }
    return s;
  };

  for (const env of records) {
    const s = ensure(env);
    switch (env.record.t) {
      case "scope_start":
        s.task = env.record.task;
        break;
      case "event":
        s.events.push(env.record.event);
        break;
      case "checkpoint":
        // The last checkpoint holds the full transcript, which is the only
        // place the assistant's own words survive in structured form.
        s.messages = env.record.state.messages;
        break;
      case "scope_end":
        s.result = env.record.result;
        break;
      case "grade":
        s.grade = env.record.grade;
        break;
      default:
        break;
    }
  }
  return scopes;
}

function metricsFor(
  slice: ScopeSlice,
  childSlices: readonly ScopeSlice[],
  header: JournalHeaderV2,
): RunMetrics {
  const parseFailures = { ...ZERO_PARSE_FAILURES };
  const repairTurns = { parse: 0, refusal: 0, tool_failure: 0 };
  const channelTurns: Record<ChannelId, number> = { toolcall: 0, object: 0, raw: 0 };
  const channelTransitions: ChannelTransitionRecord[] = [];

  let rootTurns = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let repairedToolCalls = 0;
  let promptTokens: number | undefined;
  let completionTokens = 0;
  let wallMs = 0;
  let transportErrors = 0;
  let channel: ChannelId = header.config.initialChannel;

  for (const e of slice.events) {
    switch (e.type) {
      case "turn_start":
        rootTurns = Math.max(rootTurns, e.turn);
        channelTurns[channel] += 1;
        break;
      case "usage":
        modelCalls += 1;
        if (e.promptTokens !== undefined) promptTokens = e.promptTokens;
        completionTokens += e.completionTokens ?? 0;
        wallMs += e.requestMs;
        break;
      case "parse_failure":
        parseFailures[e.kind] += 1;
        break;
      case "repair":
        repairTurns[e.kind] += 1;
        break;
      case "tool_start":
        toolCalls += 1;
        if (e.call.repaired) repairedToolCalls += 1;
        break;
      case "tool_end":
        if (!e.ok) toolFailures += 1;
        break;
      case "channel_downgrade":
        channelTransitions.push({
          turn: rootTurns,
          from: e.from,
          to: e.to,
          reason: e.reason,
        });
        channel = e.to;
        break;
      case "notice":
        if (e.level === "error") transportErrors += 1;
        break;
      default:
        break;
    }
  }

  return {
    rootTurns,
    childTurns: childSlices.reduce(
      (sum, c) => sum + c.events.filter((e) => e.type === "turn_start").length,
      0,
    ),
    modelCalls,
    toolCalls,
    toolFailures,
    parseFailures,
    repairedToolCalls,
    repairTurns,
    // Grouping is by where the run *started*. Reclassifying an adaptive run by
    // where it ended up compares it against runs that never had the chance to
    // move, and the comparison silently becomes about survivorship.
    initialChannel: header.config.initialChannel,
    finalChannel: channel,
    channelPolicy: header.config.channelPolicy,
    channelTurns,
    channelTransitions,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    completionTokens,
    wallMs,
    transportErrors,
  };
}

function toolExecutions(events: readonly LoopEvent[]): ToolExecutionRecord[] {
  const starts = new Map<string, Extract<LoopEvent, { type: "tool_start" }>>();
  const out: ToolExecutionRecord[] = [];
  for (const e of events) {
    if (e.type === "tool_start") starts.set(e.call.id, e);
    if (e.type === "tool_end") {
      const start = starts.get(e.id);
      if (!start) continue;
      out.push({
        id: e.id,
        name: start.call.name,
        arguments: start.call.arguments,
        repaired: start.call.repaired,
        ok: e.ok,
        output: e.output,
        durationMs: e.ms,
      });
    }
  }
  return out;
}

/** Every scope in a journal as a trajectory, root first. */
export function toTrajectories(parsed: ParsedJournal): TrajectoryV2[] {
  if (!parsed.header) return [];
  const header = parsed.header;
  const scopes = sliceByScope(parsed.records);
  const all = [...scopes.values()];
  const out: TrajectoryV2[] = [];

  for (const slice of all) {
    if (!slice.result) continue;
    const children = all.filter((s) => s.parentScopeId === slice.scopeId);
    out.push({
      schemaVersion: 2,
      runId: header.runId,
      scopeId: slice.scopeId,
      ...(slice.parentScopeId !== undefined ? { parentScopeId: slice.parentScopeId } : {}),
      task: { text: slice.task },
      model: header.model,
      config: header.config,
      messages: slice.messages,
      toolExecutions: toolExecutions(slice.events),
      agentResult: slice.result,
      grade: slice.grade ?? NOT_RUN,
      metrics: metricsFor(slice, children, header),
    });
  }
  return out.sort((a, b) => (a.parentScopeId === undefined ? -1 : b.parentScopeId === undefined ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* export formats                                                     */
/* ------------------------------------------------------------------ */

export type DistilFormat = "trajectory-jsonl" | "profile-jsonl";
export type DistilFilter = "grader-passed" | "grader-failed" | "all";

export function matchesFilter(t: TrajectoryV2, filter: DistilFilter): boolean {
  switch (filter) {
    case "grader-passed":
      // A journal with no grade is excluded rather than assumed. Treating
      // `not_run` as a pass is how an ungraded corpus becomes training data.
      return t.grade.status === "passed";
    case "grader-failed":
      return t.grade.status === "failed";
    case "all":
      return true;
  }
}

/**
 * One line per trajectory, holding the text a profiler reads.
 *
 * `text` is the canonical rendering of the whole trajectory in order: task,
 * the assistant's reasoning and actions, tool output, repair turns. It is a
 * document, not a transcript object — and it is deliberately a different field
 * from `messages`, which the trajectory format carries for training.
 */
export interface ProfileDocument {
  id: string;
  text: string;
  source: {
    run_id: string;
    scope_id: string;
    instance_id?: string;
    grader_passed: boolean;
    initial_channel: ChannelId;
  };
}

export function renderProfileText(t: TrajectoryV2): string {
  const parts: string[] = [`# Task\n${t.task.text}`];
  for (const m of t.messages) {
    if (m.role === "system" || m.role === "user") continue;
    if (m.role === "assistant") {
      if (m.reasoning_content) parts.push(`# Reasoning\n${m.reasoning_content}`);
      const body = typeof m.content === "string" ? m.content : "";
      if (body.trim() !== "") parts.push(`# Action\n${body}`);
      for (const tc of m.tool_calls ?? []) {
        const fn = tc.function ?? { name: tc.name ?? "", arguments: tc.arguments };
        parts.push(`# Action\n${fn.name} ${JSON.stringify(fn.arguments ?? {})}`);
      }
      continue;
    }
    if (m.role === "tool") {
      parts.push(`# Observation\n${typeof m.content === "string" ? m.content : ""}`);
    }
  }
  return parts.join("\n\n");
}

export function toProfileDocument(t: TrajectoryV2): ProfileDocument {
  return {
    id: `${t.runId}:${t.scopeId}`,
    text: renderProfileText(t),
    source: {
      run_id: t.runId,
      scope_id: t.scopeId,
      ...(t.task.instanceId !== undefined ? { instance_id: t.task.instanceId } : {}),
      grader_passed: t.grade.status === "passed",
      initial_channel: t.metrics.initialChannel,
    },
  };
}

export function distil(
  parsed: ParsedJournal,
  opts: { format: DistilFormat; filter: DistilFilter; includeChildren?: boolean },
): string[] {
  const trajectories = toTrajectories(parsed)
    .filter((t) => opts.includeChildren === true || t.parentScopeId === undefined)
    .filter((t) => matchesFilter(t, opts.filter));
  return trajectories.map((t) =>
    JSON.stringify(opts.format === "profile-jsonl" ? toProfileDocument(t) : t),
  );
}
