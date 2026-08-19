import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopEvent } from "@motifcode/core";
import {
  Journal,
  checkResumable,
  listSessions,
  loadResume,
  newHeader,
  toTrajectory,
} from "../src/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "motifcode-journal-"));
}

const HEADER = newHeader({
  sessionId: "s1",
  cwd: "/repo",
  model: "Motif-3-Coder-A13B",
  endpoint: "http://zgx-1c3b:8080",
  tools: ["done", "bash", "read"],
  toolsHash: "abc12345",
});

const RUN: LoopEvent[] = [
  {
    type: "session_start",
    model: HEADER.model,
    endpoint: HEADER.endpoint,
    channel: "toolcall",
    tools: HEADER.tools,
    toolsHash: HEADER.toolsHash,
  },
  { type: "turn_start", turn: 1 },
  { type: "tool_start", call: { id: "c1", name: "bash", arguments: { command: "ls" }, repaired: true, validated: true } },
  { type: "tool_end", id: "c1", ok: true, output: "a.ts", ms: 12 },
  { type: "parse_failure", kind: "unrecoverable", sample: "" },
  { type: "session_end", reason: "done", summary: "finished" },
];

describe("writing", () => {
  it("writes a header once, then one line per record", () => {
    const dir = tmp();
    const path = join(dir, "s1.jsonl");
    const j = new Journal(path, HEADER);
    j.user("fix the bug");
    for (const e of RUN) j.record(e);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1 + 1 + RUN.length);
    expect(JSON.parse(lines[0]!).t).toBe("header");
  });

  it("can be handed to the loop as an event sink", () => {
    const path = join(tmp(), "s.jsonl");
    const j = new Journal(path, HEADER);
    const sink = j.sink;
    for (const e of RUN) sink(e);
    expect(loadResume(path).events).toHaveLength(RUN.length);
  });
});

describe("resume", () => {
  it("round-trips a completed session", () => {
    const path = join(tmp(), "s.jsonl");
    const j = new Journal(path, HEADER);
    j.user("do the thing");
    for (const e of RUN) j.record(e);
    const state = loadResume(path);
    expect(state.userTurns).toEqual(["do the thing"]);
    expect(state.interrupted).toBe(false);
  });

  it("flags a session that ended without a session_end", () => {
    // Which on this stack usually means the model server died rather than that
    // the user quit — the case resume exists for.
    const path = join(tmp(), "s.jsonl");
    const j = new Journal(path, HEADER);
    for (const e of RUN.slice(0, 4)) j.record(e);
    expect(loadResume(path).interrupted).toBe(true);
  });

  it("refuses to resume into a different tool list", () => {
    // The frozen, canonically ordered tool array is what keeps the prefix
    // alive; resuming against a different one would silently discard it.
    const path = join(tmp(), "s.jsonl");
    const j = new Journal(path, HEADER);
    for (const e of RUN) j.record(e);
    const state = loadResume(path);
    expect(checkResumable(state, "abc12345")).toBeNull();
    expect(checkResumable(state, "deadbeef")).toMatch(/prompt prefix would not match/);
  });

  it("survives a truncated final line", () => {
    // Normal after a hard kill, which is the situation resume is for.
    const dir = tmp();
    const path = join(dir, "s.jsonl");
    const j = new Journal(path, HEADER);
    for (const e of RUN.slice(0, 3)) j.record(e);
    writeFileSync(path, readFileSync(path, "utf8") + '{"t":"event","at":"2026', "utf8");
    expect(listSessions(dir)).toHaveLength(0);
  });
});

describe("listing", () => {
  it("summarises each session with its outcome", () => {
    const dir = tmp();
    const done = new Journal(join(dir, "done.jsonl"), HEADER);
    for (const e of RUN) done.record(e);
    const cut = new Journal(join(dir, "cut.jsonl"), { ...HEADER, sessionId: "s2" });
    for (const e of RUN.slice(0, 3)) cut.record(e);

    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.header.sessionId === "s1")!.outcome).toBe("done");
    expect(sessions.find((s) => s.header.sessionId === "s2")!.outcome).toBe("interrupted");
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(listSessions(join(tmp(), "nope"))).toEqual([]);
  });
});

describe("trajectory export", () => {
  it("keeps only sessions that actually succeeded", () => {
    // The filter mirrors the recipe in Motif's own technical report: a failed
    // run is useful for tuning the harness and misleading as training data.
    const path = join(tmp(), "s.jsonl");
    const j = new Journal(path, HEADER);
    for (const e of RUN) j.record(e);
    const t = toTrajectory(loadResume(path))!;
    expect(t.outcome).toBe("done");
    expect(t.toolCalls).toEqual([
      { name: "bash", arguments: { command: "ls" }, ok: true, repaired: true },
    ]);
    expect(t.parseFailures).toBe(1);
  });

  it("drops a session that did not finish", () => {
    const path = join(tmp(), "s.jsonl");
    const j = new Journal(path, HEADER);
    for (const e of RUN.slice(0, 4)) j.record(e);
    expect(toTrajectory(loadResume(path))).toBeNull();
  });
});
