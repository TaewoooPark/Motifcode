/**
 * Distillation and metrics.
 *
 * The export used to be a pretty-printed JSON *array* of metadata plus a list
 * of tool calls, and the guide told you to feed that array to a profiler that
 * reads line-delimited objects with a `text` field. The two had never been
 * connected — and connecting them would not have helped, because the export
 * carried no task, no assistant text, no reasoning, no tool output, no channel
 * and no grade.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopCheckpoint } from "@motifcode/core";
import {
  Journal,
  distil,
  newHeader,
  parseBreakageRate,
  parseJournal,
  renderProfileText,
  repairedCallRate,
  toTrajectories,
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

const grade = (status: GraderResult["status"]): GraderResult => ({
  status,
  score: status === "passed" ? 1 : 0,
  graderName: "toy",
  graderVersion: "1",
  startedAt: "",
  finishedAt: "",
});

function journal(channelPolicy: "fixed" | "adaptive" = "fixed"): Journal {
  const dir = mkdtempSync(join(tmpdir(), "motif-distil-"));
  return new Journal(
    join(dir, "s.jsonl"),
    newHeader({
      runId: "run-1",
      cwd: "/repo",
      model: "Motif-3",
      endpoint: "http://x",
      systemHash: "sys",
      toolSchemaHash: "tools",
      harnessVersion: "0.0.1",
      config: {
        initialChannel: "toolcall",
        channelPolicy,
        temperature: 1,
        topP: 0.95,
        maxTurns: 100,
        maxRepairs: 2,
      },
    }),
  );
}

function checkpointWith(messages: LoopCheckpoint["messages"]): LoopCheckpoint {
  return {
    scopeId: "root",
    afterSeq: 1,
    messages,
    turn: 1,
    currentChannel: "toolcall",
    initialChannel: "toolcall",
    breakage: {
      options: { consecutiveLimit: 2, rateLimit: 0.25, window: 12, hardLimit: 20 },
      state: { attempts: 1, failures: 0, repairs: 0, consecutive: 0 },
      recent: [],
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
    nextCallSequence: 2,
    transportErrors: 0,
    repo: { cwd: "/repo" },
  };
}

/** A finished session: one tool call, a grade, and a transcript. */
function completeSession(opts: { grade?: GraderResult["status"] } = {}): Journal {
  const j = journal();
  j.record(ROOT, { t: "scope_start", task: "fix the parser", initialMessages: [] });
  const sink = j.sinkFor(ROOT);
  sink({ type: "turn_start", turn: 1 });
  sink({ type: "usage", contextTokens: 100, kvBytes: 0, promptTokens: 120, completionTokens: 40, requestMs: 1000 });
  sink({
    type: "tool_start",
    call: { id: "root-c1", name: "bash", arguments: { command: "pytest" }, repaired: true, validated: true },
  });
  sink({ type: "tool_end", id: "root-c1", ok: false, output: "1 failed", ms: 500 });
  sink({ type: "repair", kind: "tool_failure", reason: "tool failure", attempt: 1, max: 2 });
  j.record(ROOT, {
    t: "checkpoint",
    state: checkpointWith([
      { role: "system", content: "sys" },
      { role: "user", content: "fix the parser" },
      { role: "assistant", content: "", reasoning_content: "look at the test", tool_calls: [{ id: "root-c1", type: "function", function: { name: "bash", arguments: { command: "pytest" } } }] },
      { role: "tool", tool_call_id: "root-c1", content: "1 failed" },
    ]),
  });
  j.record(ROOT, { t: "scope_end", result: { endReason: "done", summary: "fixed", turns: 1 } });
  if (opts.grade) j.record(ROOT, { t: "grade", grade: grade(opts.grade) });
  return j;
}

const parse = (j: Journal) => parseJournal(readFileSync(j.path, "utf8"));

/* ------------------------------------------------------------------ */

describe("trajectories", () => {
  it("carries the task, the transcript, tool output and the grade", () => {
    const t = toTrajectories(parse(completeSession({ grade: "passed" })))[0]!;
    expect(t.task.text).toBe("fix the parser");
    expect(t.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(t.messages[2]!.reasoning_content).toBe("look at the test");
    expect(t.toolExecutions[0]).toMatchObject({ name: "bash", ok: false, output: "1 failed", repaired: true });
    expect(t.agentResult.endReason).toBe("done");
    expect(t.grade.status).toBe("passed");
  });

  it("gives an ungraded run a `not_run` grade rather than none", () => {
    // An absent grade filtered away later becomes an implicit pass. A value
    // that says `not_run` survives every filter and every join.
    const t = toTrajectories(parse(completeSession()))[0]!;
    expect(t.grade.status).toBe("not_run");
    expect(t.grade.score).toBe(0);
  });

  it("keeps child scopes out of the root export by default", () => {
    const j = completeSession({ grade: "passed" });
    j.record(CHILD, { t: "scope_start", task: "look around", initialMessages: [] });
    j.record(CHILD, { t: "scope_end", result: { endReason: "done", turns: 2 } });

    const roots = distil(parse(j), { format: "trajectory-jsonl", filter: "all" });
    expect(roots).toHaveLength(1);
    const withChildren = distil(parse(j), {
      format: "trajectory-jsonl",
      filter: "all",
      includeChildren: true,
    });
    expect(withChildren).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */

describe("filters read the grade, not the agent", () => {
  it("exports a passed run", () => {
    expect(distil(parse(completeSession({ grade: "passed" })), {
      format: "trajectory-jsonl",
      filter: "grader-passed",
    })).toHaveLength(1);
  });

  it("excludes a run the agent called done but the grader failed", () => {
    expect(distil(parse(completeSession({ grade: "failed" })), {
      format: "trajectory-jsonl",
      filter: "grader-passed",
    })).toHaveLength(0);
  });

  it("excludes an ungraded run rather than assuming it passed", () => {
    expect(distil(parse(completeSession()), {
      format: "trajectory-jsonl",
      filter: "grader-passed",
    })).toHaveLength(0);
  });

  it("can export failures on purpose", () => {
    expect(distil(parse(completeSession({ grade: "failed" })), {
      format: "trajectory-jsonl",
      filter: "grader-failed",
    })).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

describe("profile documents", () => {
  it("emits one JSON object per line with a text field", () => {
    // This is the shape the routing profiler reads. The old export was a
    // pretty-printed array, which it could not read at all.
    const lines = distil(parse(completeSession({ grade: "passed" })), {
      format: "profile-jsonl",
      filter: "grader-passed",
    });
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]!) as { id: string; text: string; source: Record<string, unknown> };
    expect(lines[0]).not.toContain("\n");
    expect(typeof doc.text).toBe("string");
    expect(doc.source).toMatchObject({ run_id: "run-1", grader_passed: true, initial_channel: "toolcall" });
  });

  it("renders task, reasoning, action and observation in order", () => {
    const t = toTrajectories(parse(completeSession({ grade: "passed" })))[0]!;
    const text = renderProfileText(t);
    expect(text.indexOf("# Task")).toBeLessThan(text.indexOf("# Reasoning"));
    expect(text.indexOf("# Reasoning")).toBeLessThan(text.indexOf("# Action"));
    expect(text.indexOf("# Action")).toBeLessThan(text.indexOf("# Observation"));
    expect(text).toContain("fix the parser");
    expect(text).toContain("pytest");
    expect(text).toContain("1 failed");
  });

  it("keeps the rendered text and the structured messages as separate fields", () => {
    // A profiler wants the token stream; a trainer wants roles it can mask.
    // Presenting one as the other measures the wrong distribution.
    const trajectory = JSON.parse(
      distil(parse(completeSession({ grade: "passed" })), {
        format: "trajectory-jsonl",
        filter: "grader-passed",
      })[0]!,
    ) as Record<string, unknown>;
    expect(trajectory).toHaveProperty("messages");
    expect(trajectory).not.toHaveProperty("text");
  });
});

/* ------------------------------------------------------------------ */

describe("metrics", () => {
  it("counts turns, calls, failures and repairs by cause", () => {
    const m = toTrajectories(parse(completeSession({ grade: "passed" })))[0]!.metrics;
    expect(m.rootTurns).toBe(1);
    expect(m.modelCalls).toBe(1);
    expect(m.toolCalls).toBe(1);
    expect(m.toolFailures).toBe(1);
    expect(m.repairedToolCalls).toBe(1);
    expect(m.repairTurns).toEqual({ parse: 0, refusal: 0, tool_failure: 1 });
    expect(m.promptTokens).toBe(120);
    expect(m.completionTokens).toBe(40);
  });

  it("keeps child turns out of the root count", () => {
    const j = completeSession({ grade: "passed" });
    j.record(CHILD, { t: "scope_start", task: "look", initialMessages: [] });
    j.sinkFor(CHILD)({ type: "turn_start", turn: 1 });
    j.sinkFor(CHILD)({ type: "turn_start", turn: 2 });
    j.record(CHILD, { t: "scope_end", result: { endReason: "done", turns: 2 } });

    const root = toTrajectories(parse(j)).find((t) => t.parentScopeId === undefined)!;
    expect(root.metrics.rootTurns).toBe(1);
    expect(root.metrics.childTurns).toBe(2);
  });

  it("groups by the channel the run started in, not the one it ended in", () => {
    // Reclassifying an adaptive run by where it ended up compares it against
    // runs that never had the chance to move.
    const j = journal("adaptive");
    j.record(ROOT, { t: "scope_start", task: "t", initialMessages: [] });
    const sink = j.sinkFor(ROOT);
    sink({ type: "turn_start", turn: 1 });
    sink({ type: "channel_downgrade", from: "toolcall", to: "object", reason: "2 consecutive parse failures" });
    sink({ type: "turn_start", turn: 2 });
    j.record(ROOT, { t: "scope_end", result: { endReason: "done", turns: 2 } });

    const m = toTrajectories(parse(j))[0]!.metrics;
    expect(m.initialChannel).toBe("toolcall");
    expect(m.finalChannel).toBe("object");
    expect(m.channelTurns).toMatchObject({ toolcall: 1, object: 1 });
    expect(m.channelTransitions[0]).toMatchObject({ from: "toolcall", to: "object" });
  });

  it("states the denominator for each rate", () => {
    const m = toTrajectories(parse(completeSession()))[0]!.metrics;
    // Breakage is over model calls; repaired-call rate is over parsed calls.
    // They are different questions and the two denominators differ.
    expect(parseBreakageRate(m)).toBe(0);
    expect(repairedCallRate(m)).toBe(1);
  });
});
