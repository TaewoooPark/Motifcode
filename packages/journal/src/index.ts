/**
 * The session journal.
 *
 * Append-only JSONL of everything that happened, written as it happens, so a
 * session survives the process that produced it. That is not a nice-to-have on
 * this stack: vLLM on GB10 has open reports of fatal engine errors, so a local
 * server dying mid-session is expected rather than exceptional, and a two-hour
 * run vanishing with it is the kind of experience users do not return from.
 *
 * Three things about v2 are corrections rather than additions.
 *
 * **Scopes.** Parent and every subagent wrote into one stream with no
 * namespace, and `toTrajectory` took the *first* `session_end` it found. A
 * child finishing first therefore labelled the run — so a root session that
 * crashed, timed out or lost the server could be exported as a success, on the
 * strength of a subagent having said `done`. Every record now carries a scope,
 * and only the root scope's ending describes the run.
 *
 * **Crash-safe reads.** Every line was parsed strictly, and one bad line made
 * the whole file disappear from `listSessions`. Since the bad line is almost
 * always the half-written last one after a hard kill, the runs most likely to
 * vanish were the runs that crashed — which is survivorship bias pointed
 * directly at the number being measured. A truncated tail is now expected and
 * reported; corruption in the middle is still refused, loudly.
 *
 * **`done` is not success.** The model saying it finished is a self-report. It
 * is not evidence that the tests pass, that the repository is intact, or that
 * an evaluator agrees. Grades come from a trusted grader outside the loop and
 * live in their own record, and every export that claims success reads that
 * record and not the agent's.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoopCheckpoint, LoopEvent, SessionEndReason } from "@motifcode/core";
import type { ChannelId, Message } from "@motifcode/protocol";

export const JOURNAL_VERSION = 2;

/* ------------------------------------------------------------------ */
/* contracts                                                          */
/* ------------------------------------------------------------------ */

export interface JournalHeaderV2 {
  schemaVersion: 2;
  runId: string;
  startedAt: string;
  harness: { version: string; gitSha?: string };
  repository: { cwd: string; baseCommit?: string; initialTreeHash?: string };
  model: { id: string; checkpointSha256?: string; tokenizerSha256?: string };
  serving: { engine?: string; engineVersion?: string; configHash?: string; endpoint?: string };
  prompt: { systemHash: string; toolSchemaHash: string };
  config: {
    initialChannel: ChannelId;
    channelPolicy: "fixed" | "adaptive";
    temperature: number;
    topP: number;
    seed?: number;
    maxTurns: number;
    maxOutputTokens?: number;
    maxRepairs: number;
    wallTimeoutMs?: number;
  };
  benchmark?: {
    manifestId: string;
    instanceId: string;
    configId: string;
    replicate: number;
  };
}

/**
 * How the agent's own run ended.
 *
 * Deliberately says nothing about whether the work was any good. `done` means
 * the model proposed a completion and confirmed it when challenged — a claim,
 * made by the thing being measured.
 */
export interface AgentResult {
  endReason: SessionEndReason;
  summary?: string;
  turns: number;
}

/**
 * What a trusted grader found, run outside the agent's environment.
 *
 * `not_run` is a real value and must survive: a run whose grader never
 * executed is not a pass and is not a fail, and quietly dropping it from the
 * denominator is how a benchmark flatters whichever configuration crashes most.
 */
export interface GraderResult {
  status: "passed" | "failed" | "infra_error" | "not_run";
  score: number;
  graderName: string;
  graderVersion: string;
  graderImageDigest?: string;
  startedAt: string;
  finishedAt: string;
  exitCode?: number;
  tests?: { name: string; status: "passed" | "failed" | "error"; durationMs?: number }[];
  patchSha256?: string;
  stdoutArtifact?: string;
  stderrArtifact?: string;
}

export type ScopeKind = "root" | "subagent";

export type JournalRecordV2 =
  | { t: "scope_start"; initialMessages: Message[]; task: string }
  | { t: "event"; event: LoopEvent }
  | { t: "checkpoint"; state: LoopCheckpoint }
  | { t: "scope_end"; result: AgentResult }
  | { t: "grade"; grade: GraderResult }
  | { t: "resume"; fromSeq: number; previousRunId?: string };

export interface JournalEnvelopeV2 {
  v: 2;
  seq: number;
  at: string;
  runId: string;
  scopeId: string;
  parentScopeId?: string;
  scopeKind: ScopeKind;
  agentName?: string;
  record: JournalRecordV2;
}

export type JournalLine = { t: "header"; header: JournalHeaderV2 } | JournalEnvelopeV2;

/* ------------------------------------------------------------------ */
/* writing                                                            */
/* ------------------------------------------------------------------ */

export interface ScopeIdentity {
  scopeId: string;
  scopeKind: ScopeKind;
  parentScopeId?: string;
  agentName?: string;
}

export class Journal {
  private headerWritten = false;
  private seq = 0;

  constructor(
    readonly path: string,
    private readonly header: JournalHeaderV2,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  private write(line: JournalLine): void {
    // Synchronous, and one record per write call. An async write that has not
    // flushed when the process dies is exactly the record you needed, and a
    // record split across two writes is the corrupt line that loses the file.
    appendFileSync(this.path, JSON.stringify(line) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  private ensureHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    this.write({ t: "header", header: this.header });
  }

  record(scope: ScopeIdentity, record: JournalRecordV2): number {
    this.ensureHeader();
    this.seq += 1;
    this.write({
      v: 2,
      seq: this.seq,
      at: new Date().toISOString(),
      runId: this.header.runId,
      scopeId: scope.scopeId,
      ...(scope.parentScopeId !== undefined ? { parentScopeId: scope.parentScopeId } : {}),
      scopeKind: scope.scopeKind,
      ...(scope.agentName !== undefined ? { agentName: scope.agentName } : {}),
      record,
    });
    return this.seq;
  }

  /** An event sink bound to one scope, ready to hand to the loop. */
  sinkFor(scope: ScopeIdentity): (event: LoopEvent) => void {
    return (event) => {
      this.record(scope, { t: "event", event });
    };
  }

  checkpointFor(scope: ScopeIdentity): (state: LoopCheckpoint) => void {
    return (state) => {
      this.record(scope, { t: "checkpoint", state });
    };
  }
}

export function newHeader(opts: {
  runId: string;
  cwd: string;
  model: string;
  endpoint: string;
  systemHash: string;
  toolSchemaHash: string;
  harnessVersion: string;
  config: JournalHeaderV2["config"];
  baseCommit?: string;
}): JournalHeaderV2 {
  return {
    schemaVersion: 2,
    runId: opts.runId,
    startedAt: new Date().toISOString(),
    harness: { version: opts.harnessVersion },
    repository: { cwd: opts.cwd, ...(opts.baseCommit ? { baseCommit: opts.baseCommit } : {}) },
    model: { id: opts.model },
    serving: { endpoint: opts.endpoint },
    prompt: { systemHash: opts.systemHash, toolSchemaHash: opts.toolSchemaHash },
    config: opts.config,
  };
}

/* ------------------------------------------------------------------ */
/* reading                                                            */
/* ------------------------------------------------------------------ */

export interface ParsedJournal {
  header?: JournalHeaderV2;
  records: JournalEnvelopeV2[];
  /** The file ended mid-record. Expected after a hard kill. */
  truncatedTail: boolean;
  /** A line other than the last failed to parse, or sequence numbers broke. */
  corruptAtSeq?: number;
  corruption?: string;
}

/**
 * Parse a journal, surviving the one failure that is normal.
 *
 * A file that ends without a newline and whose final line is invalid JSON is a
 * process that died mid-write. Everything before it is intact, so it is kept
 * and the tail is flagged. Anything else — a bad line in the middle, a sequence
 * number that repeats or goes backwards, a run id that changes — is corruption,
 * and salvaging it would mean guessing at what is missing.
 */
export function parseJournal(text: string): ParsedJournal {
  const endsCleanly = text.length === 0 || text.endsWith("\n");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const out: ParsedJournal = { records: [], truncatedTail: false };
  let lastSeq = 0;
  let runId: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const isLast = i === lines.length - 1;
    let parsed: JournalLine;
    try {
      parsed = JSON.parse(line) as JournalLine;
    } catch {
      if (isLast && !endsCleanly) {
        out.truncatedTail = true;
        break;
      }
      out.corruptAtSeq = lastSeq;
      out.corruption = `line ${i + 1} is not valid JSON`;
      return out;
    }
    if ("t" in parsed && parsed.t === "header") {
      out.header = parsed.header;
      runId = parsed.header.runId;
      continue;
    }
    const env = parsed as JournalEnvelopeV2;
    if (env.v !== 2 || typeof env.seq !== "number") {
      out.corruptAtSeq = lastSeq;
      out.corruption = `line ${i + 1} is not a v2 envelope`;
      return out;
    }
    if (env.seq !== lastSeq + 1) {
      out.corruptAtSeq = env.seq;
      out.corruption = `sequence jumped from ${lastSeq} to ${env.seq}`;
      return out;
    }
    if (runId !== undefined && env.runId !== runId) {
      out.corruptAtSeq = env.seq;
      out.corruption = `run id changed from ${runId} to ${env.runId}`;
      return out;
    }
    lastSeq = env.seq;
    out.records.push(env);
  }
  return out;
}

export type Outcome = SessionEndReason | "interrupted";

export interface SessionSummary {
  path: string;
  header: JournalHeaderV2;
  /** Records in the root scope only. Child work is counted separately. */
  rootEvents: number;
  childEvents: number;
  lastAt?: string;
  /** From the root scope's ending. A child finishing does not end the run. */
  outcome: Outcome;
  truncatedTail: boolean;
  grade?: GraderResult;
}

function rootScopeId(records: JournalEnvelopeV2[]): string | undefined {
  return records.find((r) => r.scopeKind === "root")?.scopeId;
}

export function summarize(path: string, text: string): SessionSummary | null {
  const parsed = parseJournal(text);
  if (!parsed.header) return null;
  if (parsed.corruption !== undefined) return null;

  const root = rootScopeId(parsed.records);
  const rootRecords = parsed.records.filter((r) => r.scopeId === root);
  const end = [...rootRecords].reverse().find((r) => r.record.t === "scope_end");
  const grade = [...rootRecords].reverse().find((r) => r.record.t === "grade");

  return {
    path,
    header: parsed.header,
    rootEvents: rootRecords.filter((r) => r.record.t === "event").length,
    childEvents: parsed.records.filter((r) => r.scopeId !== root && r.record.t === "event").length,
    lastAt: parsed.records[parsed.records.length - 1]?.at,
    // No root ending means the process went away without writing one, which on
    // this stack usually means the model server died rather than that the user
    // quit. Either way it is not a completion.
    outcome:
      end && end.record.t === "scope_end" ? end.record.result.endReason : "interrupted",
    truncatedTail: parsed.truncatedTail,
    ...(grade && grade.record.t === "grade" ? { grade: grade.record.grade } : {}),
  };
}

/**
 * Sessions in a directory, newest first.
 *
 * Truncated-tail runs are included. Dropping them would remove exactly the runs
 * that crashed, which is the population a stability comparison exists to
 * measure.
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
      // Unreadable file, as opposed to an unparseable one. Nothing to report.
    }
  }
  return out.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
}

/* ------------------------------------------------------------------ */
/* resume                                                             */
/* ------------------------------------------------------------------ */

export interface ResumeState {
  header: JournalHeaderV2;
  /** The last checkpoint written in the root scope, if any. */
  checkpoint?: LoopCheckpoint;
  task?: string;
  truncatedTail: boolean;
  corruption?: string;
  /** True when no root `scope_end` was written. */
  interrupted: boolean;
  finished: boolean;
}

export function loadResume(path: string): ResumeState {
  const parsed = parseJournal(readFileSync(path, "utf8"));
  if (!parsed.header) throw new Error(`${path} has no header record`);
  const root = rootScopeId(parsed.records);
  const rootRecords = parsed.records.filter((r) => r.scopeId === root);
  const lastCheckpoint = [...rootRecords].reverse().find((r) => r.record.t === "checkpoint");
  const start = rootRecords.find((r) => r.record.t === "scope_start");
  const end = rootRecords.find((r) => r.record.t === "scope_end");
  return {
    header: parsed.header,
    ...(lastCheckpoint && lastCheckpoint.record.t === "checkpoint"
      ? { checkpoint: lastCheckpoint.record.state }
      : {}),
    ...(start && start.record.t === "scope_start" ? { task: start.record.task } : {}),
    truncatedTail: parsed.truncatedTail,
    ...(parsed.corruption !== undefined ? { corruption: parsed.corruption } : {}),
    interrupted: end === undefined,
    finished: end !== undefined,
  };
}

/**
 * Why this session cannot be picked up where it left off.
 *
 * Fail-closed, and specific. "Cannot resume" with no reason invites the user to
 * try again with a flag; naming the mismatch tells them what would have to be
 * true instead.
 */
export function checkResumable(
  state: ResumeState,
  current: { systemHash: string; toolSchemaHash: string; model: string },
): string | null {
  if (state.corruption !== undefined) {
    return `this journal is corrupt (${state.corruption}); it cannot be salvaged`;
  }
  if (state.finished) {
    return "this session already ended; start a new run rather than resuming a finished one";
  }
  if (!state.checkpoint) {
    return "no checkpoint was written before the interruption; there is no state to restore";
  }
  if (state.header.prompt.toolSchemaHash !== current.toolSchemaHash) {
    return (
      "the tool schemas changed since this session was recorded. Resuming would render the " +
      "existing transcript against different tools and lose the prompt prefix"
    );
  }
  if (state.header.prompt.systemHash !== current.systemHash) {
    return "the system prompt changed since this session was recorded";
  }
  if (state.header.model.id !== current.model) {
    return `recorded against model ${state.header.model.id}, now ${current.model}`;
  }
  const inflight = state.checkpoint.inFlightTool;
  if (inflight?.mutating) {
    return (
      `the run stopped while \`${inflight.name}\` (${inflight.id}) was running, and whether it ` +
      "took effect is unknowable from here. Inspect the working tree, then start a new run"
    );
  }
  return null;
}
