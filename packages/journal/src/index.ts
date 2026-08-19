/**
 * The session journal.
 *
 * Append-only JSONL of every event, written as it happens, so a session
 * survives the process that produced it.
 *
 * This is not a nice-to-have here. vLLM on GB10 has open reports of fatal
 * engine errors, so a local server dying mid-session is an expected event
 * rather than an edge case — and a two-hour agent run vanishing because the
 * backend fell over is the kind of experience users do not return from. Resume
 * is a precondition for shipping, not a feature.
 *
 * It doubles as the trajectory export. Motif's own software-engineering teacher
 * was trained on successful trajectories filtered by whether the repository's
 * tests passed; the same filter applies to these files. Weights are MIT and the
 * training framework is public, so the loop from "what this harness did" back
 * to "what the model learns" is one that can actually be closed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoopEvent } from "@motifcode/core";

export interface JournalHeader {
  version: 1;
  sessionId: string;
  startedAt: string;
  cwd: string;
  model: string;
  endpoint: string;
  /** Frozen tool list and its hash — a resume with a different list is not a resume. */
  tools: string[];
  toolsHash: string;
}

export type JournalRecord =
  | { t: "header"; header: JournalHeader }
  | { t: "user"; at: string; text: string }
  | { t: "event"; at: string; event: LoopEvent };

export interface SessionSummary {
  path: string;
  header: JournalHeader;
  events: number;
  lastAt?: string;
  outcome?: string;
}

/* ------------------------------------------------------------------ */

export class Journal {
  private headerWritten = false;

  constructor(
    readonly path: string,
    private readonly header: JournalHeader,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  private write(rec: JournalRecord): void {
    // Synchronous by design. An async write that has not flushed when the
    // process dies is exactly the record you needed.
    appendFileSync(this.path, JSON.stringify(rec) + "\n", "utf8");
  }

  private ensureHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    this.write({ t: "header", header: this.header });
  }

  user(text: string): void {
    this.ensureHeader();
    this.write({ t: "user", at: new Date().toISOString(), text });
  }

  record(event: LoopEvent): void {
    this.ensureHeader();
    this.write({ t: "event", at: new Date().toISOString(), event });
  }

  /** An event sink that can be handed straight to the loop. */
  get sink(): (event: LoopEvent) => void {
    return (e) => this.record(e);
  }
}

/* ------------------------------------------------------------------ */

export function parseJournal(text: string): JournalRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as JournalRecord);
}

export function summarize(path: string, text: string): SessionSummary | null {
  const records = parseJournal(text);
  const head = records.find((r): r is Extract<JournalRecord, { t: "header" }> => r.t === "header");
  if (!head) return null;
  const events = records.filter((r): r is Extract<JournalRecord, { t: "event" }> => r.t === "event");
  const end = [...events].reverse().find((r) => r.event.type === "session_end");
  return {
    path,
    header: head.header,
    events: events.length,
    lastAt: events[events.length - 1]?.at,
    outcome:
      end && end.event.type === "session_end" ? end.event.reason : events.length > 0 ? "interrupted" : undefined,
  };
}

/**
 * Sessions in a directory, newest first.
 *
 * `interrupted` is the outcome that matters: it means the process went away
 * without writing a `session_end`, which on this stack usually means the model
 * server died rather than that the user quit.
 */
export function listSessions(dir: string): SessionSummary[] {
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const s = summarize(path, readFileSync(path, "utf8"));
      if (s) out.push(s);
    } catch {
      // A truncated final line is normal after a hard kill; skip rather than
      // refusing to list anything.
    }
  }
  return out.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
}

export interface ResumeState {
  header: JournalHeader;
  /** User turns, in order, for replaying the conversation. */
  userTurns: string[];
  events: LoopEvent[];
  /** True when no `session_end` was written — the likely server-death case. */
  interrupted: boolean;
}

export function loadResume(path: string): ResumeState {
  const records = parseJournal(readFileSync(path, "utf8"));
  const header = records.find((r): r is Extract<JournalRecord, { t: "header" }> => r.t === "header")?.header;
  if (!header) throw new Error(`${path} has no header record`);
  const events = records
    .filter((r): r is Extract<JournalRecord, { t: "event" }> => r.t === "event")
    .map((r) => r.event);
  return {
    header,
    userTurns: records
      .filter((r): r is Extract<JournalRecord, { t: "user" }> => r.t === "user")
      .map((r) => r.text),
    events,
    interrupted: !events.some((e) => e.type === "session_end"),
  };
}

/**
 * Refuse to resume into a different tool list.
 *
 * The frozen, canonically ordered tool array is what keeps the prompt prefix
 * alive; resuming with a changed one would silently discard the cache the
 * original session built and produce a history rendered against different
 * tools. Better to say so than to quietly do the wrong thing.
 */
export function checkResumable(state: ResumeState, currentToolsHash: string): string | null {
  if (state.header.toolsHash !== currentToolsHash) {
    return (
      `this session was recorded with tool list #${state.header.toolsHash}, ` +
      `and the current one is #${currentToolsHash}. The prompt prefix would not match.`
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */

export interface Trajectory {
  sessionId: string;
  model: string;
  outcome: string;
  turns: number;
  toolCalls: { name: string; arguments: Record<string, unknown>; ok: boolean; repaired: boolean }[];
  /** Parse failures, which is the number this project exists to drive down. */
  parseFailures: number;
}

/**
 * Distil a journal into a training-shaped trajectory.
 *
 * The filter mirrors the recipe in Motif's own technical report: keep only
 * trajectories that actually succeeded. Everything else is a record of how not
 * to do it, which is useful for tuning the harness and misleading as training
 * data.
 */
export function toTrajectory(state: ResumeState): Trajectory | null {
  const end = state.events.find(
    (e): e is Extract<LoopEvent, { type: "session_end" }> => e.type === "session_end",
  );
  if (!end || end.reason !== "done") return null;

  const starts = state.events.filter(
    (e): e is Extract<LoopEvent, { type: "tool_start" }> => e.type === "tool_start",
  );
  const ends = new Map(
    state.events
      .filter((e): e is Extract<LoopEvent, { type: "tool_end" }> => e.type === "tool_end")
      .map((e) => [e.id, e.ok]),
  );

  return {
    sessionId: state.header.sessionId,
    model: state.header.model,
    outcome: end.reason,
    turns: state.events.filter((e) => e.type === "turn_start").length,
    toolCalls: starts.map((s) => ({
      name: s.call.name,
      arguments: s.call.arguments,
      ok: ends.get(s.call.id) ?? false,
      repaired: s.call.repaired,
    })),
    parseFailures: state.events.filter((e) => e.type === "parse_failure").length,
  };
}

export function newHeader(opts: {
  sessionId: string;
  cwd: string;
  model: string;
  endpoint: string;
  tools: string[];
  toolsHash: string;
}): JournalHeader {
  return { version: 1, startedAt: new Date().toISOString(), ...opts };
}
