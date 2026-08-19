/**
 * The journal.
 *
 * Three of these tests exist because the v1 behaviour they replace was
 * confidently wrong in a way that flattered the numbers: a subagent could label
 * the run, a crashed run disappeared from the listing, and the model's own
 * `done` counted as success.
 */

import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopCheckpoint } from "@motifcode/core";
import {
  Journal,
  checkResumable,
  listSessions,
  loadResume,
  newHeader,
  parseJournal,
  summarize,
  type GraderResult,
  type ScopeIdentity,
} from "../src/index.js";

const ROOT: ScopeIdentity = { scopeId: "root", scopeKind: "root" };
const CHILD: ScopeIdentity = {
  scopeId: "sub-explorer-001",
  scopeKind: "subagent",
  parentScopeId: "root",
  agentName: "explorer",
};

function header(overrides: Partial<Parameters<typeof newHeader>[0]> = {}) {
  return newHeader({
    runId: "run-1",
    cwd: "/repo",
    model: "Motif-3",
    endpoint: "http://127.0.0.1:8080",
    systemHash: "sys-hash",
    toolSchemaHash: "tools-hash",
    harnessVersion: "0.0.1",
    config: {
      initialChannel: "toolcall",
      channelPolicy: "fixed",
      temperature: 1,
      topP: 0.95,
      maxTurns: 100,
      maxRepairs: 2,
    },
    ...overrides,
  });
}

function newJournal(): Journal {
  const dir = mkdtempSync(join(tmpdir(), "motif-journal-"));
  return new Journal(join(dir, "s.jsonl"), header());
}

function checkpoint(overrides: Partial<LoopCheckpoint> = {}): LoopCheckpoint {
  return {
    scopeId: "root",
    afterSeq: 1,
    messages: [{ role: "user", content: "t" }],
    turn: 3,
    currentChannel: "toolcall",
    initialChannel: "toolcall",
    breakage: {
      options: { consecutiveLimit: 2, rateLimit: 0.25, window: 12, hardLimit: 20 },
      state: { attempts: 3, failures: 0, repairs: 0, consecutive: 0 },
      recent: [false, false, false],
    },
    loopGuard: {
      options: { repeatLimit: 3, stallLimit: 4 },
      lastSignature: "",
      repeats: 0,
      lastOutput: "",
      stalls: 0,
    },
    repairsThisTask: 0,
    pendingDone: null,
    nextCallSequence: 4,
    transportErrors: 0,
    repo: { cwd: "/repo" },
    ...overrides,
  };
}

const grade = (status: GraderResult["status"]): GraderResult => ({
  status,
  score: status === "passed" ? 1 : 0,
  graderName: "toy",
  graderVersion: "1",
  startedAt: "2026-08-20T00:00:00Z",
  finishedAt: "2026-08-20T00:00:01Z",
});

/* ------------------------------------------------------------------ */

describe("writing", () => {
  it("writes the header once and stamps every record with its scope", () => {
    const j = newJournal();
    j.record(ROOT, { t: "scope_start", task: "do it", initialMessages: [] });
    j.record(CHILD, { t: "scope_start", task: "look", initialMessages: [] });
    j.sinkFor(ROOT)({ type: "turn_start", turn: 1 });

    const parsed = parseJournal(readFileSync(j.path, "utf8"));
    expect(parsed.header?.runId).toBe("run-1");
    expect(parsed.records.map((r) => r.scopeId)).toEqual(["root", "sub-explorer-001", "root"]);
    expect(parsed.records[1]!.parentScopeId).toBe("root");
    expect(parsed.records.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("creates the file readable only by its owner", () => {
    const j = newJournal();
    j.record(ROOT, { t: "scope_start", task: "t", initialMessages: [] });
    // Journals hold tool output, hook payloads and whatever the repository
    // printed. Default permissions would put that in every process's reach.
    expect(statSync(j.path).mode & 0o777).toBe(0o600);
  });
});

/* ------------------------------------------------------------------ */

describe("a subagent cannot label the run", () => {
  it("takes the outcome from the root scope, not the first ending", () => {
    // The v1 bug, exactly: `.find` on the first `session_end` meant a child
    // finishing first labelled a run whose root had lost the server.
    const j = newJournal();
    j.record(ROOT, { t: "scope_start", task: "t", initialMessages: [] });
    j.record(CHILD, { t: "scope_end", result: { endReason: "done", summary: "found it", turns: 4 } });
    j.record(ROOT, { t: "scope_end", result: { endReason: "transport_error", turns: 9 } });

    const s = summarize(j.path, readFileSync(j.path, "utf8"))!;
    expect(s.outcome).toBe("transport_error");
  });

  it("reports the run as interrupted when the root never ended", () => {
    const j = newJournal();
    j.record(ROOT, { t: "scope_start", task: "t", initialMessages: [] });
    j.record(CHILD, { t: "scope_end", result: { endReason: "done", turns: 2 } });

    const s = summarize(j.path, readFileSync(j.path, "utf8"))!;
    expect(s.outcome).toBe("interrupted");
  });

  it("counts root and child events separately", () => {
    const j = newJournal();
    j.sinkFor(ROOT)({ type: "turn_start", turn: 1 });
    j.sinkFor(CHILD)({ type: "turn_start", turn: 1 });
    j.sinkFor(CHILD)({ type: "turn_start", turn: 2 });

    const s = summarize(j.path, readFileSync(j.path, "utf8"))!;
    expect(s.rootEvents).toBe(1);
    expect(s.childEvents).toBe(2);
  });

  it("keeps two runs of the same agent in separate scopes", () => {
    const j = newJournal();
    const a = { ...CHILD, scopeId: "sub-explorer-001" };
    const b = { ...CHILD, scopeId: "sub-explorer-002" };
    j.sinkFor(a)({ type: "turn_start", turn: 1 });
    j.sinkFor(b)({ type: "turn_start", turn: 1 });
    const parsed = parseJournal(readFileSync(j.path, "utf8"));
    expect(new Set(parsed.records.map((r) => r.scopeId)).size).toBe(2);
  });
});

/* ------------------------------------------------------------------ */

describe("a crashed run stays in the record", () => {
  it("keeps everything before a half-written final line", () => {
    // v1 parsed every line strictly, so one truncated tail removed the whole
    // file from the listing — and the truncated tail is what a hard kill
    // leaves. The runs most likely to vanish were the ones that crashed.
    const j = newJournal();
    j.record(ROOT, { t: "scope_start", task: "t", initialMessages: [] });
    j.sinkFor(ROOT)({ type: "turn_start", turn: 1 });
    const text = readFileSync(j.path, "utf8");
    const truncated = text.slice(0, text.length - 20);
    writeFileSync(j.path, truncated, "utf8");

    const parsed = parseJournal(truncated);
    expect(parsed.truncatedTail).toBe(true);
    expect(parsed.records).toHaveLength(1);

    const listed = listSessions(join(j.path, ".."));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.outcome).toBe("interrupted");
    expect(listed[0]!.truncatedTail).toBe(true);
  });

  it("reads a file whose last record is complete but unterminated", () => {
    const j = newJournal();
    j.record(ROOT, { t: "scope_end", result: { endReason: "done", turns: 1 } });
    const text = readFileSync(j.path, "utf8").replace(/\n$/, "");
    const parsed = parseJournal(text);
    expect(parsed.truncatedTail).toBe(false);
    expect(summarize(j.path, text)!.outcome).toBe("done");
  });

  it("refuses to salvage corruption in the middle", () => {
    const j = newJournal();
    j.sinkFor(ROOT)({ type: "turn_start", turn: 1 });
    j.sinkFor(ROOT)({ type: "turn_start", turn: 2 });
    const lines = readFileSync(j.path, "utf8").split("\n");
    lines[1] = "{ not json";
    const parsed = parseJournal(lines.join("\n"));
    expect(parsed.corruption).toBeDefined();
  });

  it("refuses a journal whose sequence numbers jump", () => {
    const j = newJournal();
    j.sinkFor(ROOT)({ type: "turn_start", turn: 1 });
    j.sinkFor(ROOT)({ type: "turn_start", turn: 2 });
    const lines = readFileSync(j.path, "utf8").trim().split("\n");
    const bad = JSON.parse(lines[2]!) as { seq: number };
    bad.seq = 9;
    lines[2] = JSON.stringify(bad);
    const parsed = parseJournal(lines.join("\n") + "\n");
    expect(parsed.corruption).toContain("sequence jumped");
  });
});

/* ------------------------------------------------------------------ */

describe("done is not a grade", () => {
  it("keeps the agent's ending and the grader's verdict apart", () => {
    const j = newJournal();
    j.record(ROOT, { t: "scope_end", result: { endReason: "done", summary: "fixed it", turns: 7 } });
    j.record(ROOT, { t: "grade", grade: grade("failed") });

    const s = summarize(j.path, readFileSync(j.path, "utf8"))!;
    // The agent believes it finished. The grader disagrees. Both are true
    // statements about different things, and only one of them is a score.
    expect(s.outcome).toBe("done");
    expect(s.grade?.status).toBe("failed");
    expect(s.grade?.score).toBe(0);
  });

  it("leaves the grade absent when nothing graded the run", () => {
    const j = newJournal();
    j.record(ROOT, { t: "scope_end", result: { endReason: "done", turns: 1 } });
    expect(summarize(j.path, readFileSync(j.path, "utf8"))!.grade).toBeUndefined();
  });

  it("does not let a child's grade stand in for the root's", () => {
    const j = newJournal();
    j.record(CHILD, { t: "grade", grade: grade("passed") });
    j.record(ROOT, { t: "scope_end", result: { endReason: "done", turns: 1 } });
    expect(summarize(j.path, readFileSync(j.path, "utf8"))!.grade).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe("resume", () => {
  const current = { systemHash: "sys-hash", toolSchemaHash: "tools-hash", model: "Motif-3" };

  function interrupted(cp = checkpoint()): Journal {
    const j = newJournal();
    j.record(ROOT, { t: "scope_start", task: "fix the parser", initialMessages: [] });
    j.record(ROOT, { t: "checkpoint", state: cp });
    return j;
  }

  it("restores the last checkpoint and the original task", () => {
    const j = interrupted();
    const state = loadResume(j.path);
    expect(state.interrupted).toBe(true);
    expect(state.task).toBe("fix the parser");
    expect(state.checkpoint?.turn).toBe(3);
    expect(checkResumable(state, current)).toBeNull();
  });

  it("refuses a changed tool schema", () => {
    const state = loadResume(interrupted().path);
    expect(checkResumable(state, { ...current, toolSchemaHash: "different" })).toContain(
      "tool schemas changed",
    );
  });

  it("refuses a changed system prompt", () => {
    const state = loadResume(interrupted().path);
    expect(checkResumable(state, { ...current, systemHash: "different" })).toContain(
      "system prompt changed",
    );
  });

  it("refuses a changed model", () => {
    const state = loadResume(interrupted().path);
    expect(checkResumable(state, { ...current, model: "something-else" })).toContain("Motif-3");
  });

  it("refuses to resume a finished session", () => {
    const j = interrupted();
    j.record(ROOT, { t: "scope_end", result: { endReason: "done", turns: 3 } });
    expect(checkResumable(loadResume(j.path), current)).toContain("already ended");
  });

  it("refuses when a mutating tool was in flight", () => {
    // The process died while `apply_patch` was running. Whether it applied is
    // not knowable from here, and re-running it is not a recovery.
    const j = interrupted(
      checkpoint({
        inFlightTool: { id: "root-c4", name: "apply_patch", argumentsHash: "abc", mutating: true },
      }),
    );
    const blocker = checkResumable(loadResume(j.path), current);
    expect(blocker).toContain("apply_patch");
    expect(blocker).toContain("unknowable");
  });

  it("allows resume when the in-flight tool only read", () => {
    const j = interrupted(
      checkpoint({
        inFlightTool: { id: "root-c4", name: "read", argumentsHash: "abc", mutating: false },
      }),
    );
    expect(checkResumable(loadResume(j.path), current)).toBeNull();
  });

  it("refuses when no checkpoint was ever written", () => {
    const j = newJournal();
    j.record(ROOT, { t: "scope_start", task: "t", initialMessages: [] });
    expect(checkResumable(loadResume(j.path), current)).toContain("no checkpoint");
  });
});
