/**
 * Record and replay.
 *
 * The value of this package is that a session recorded once — eventually, a
 * real one against Motif-3 — becomes a deterministic test forever. So the
 * round-trip has to be exact, and a replay that runs out of recorded turns has
 * to fail loudly rather than quietly returning something plausible.
 */

import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import { runLoop, type Executor, type LoopEvent } from "@motifcode/core";
import {
  FaultTransport,
  RecordingTransport,
  ReplayTransport,
  ScriptedTransport,
  damage,
  doneBody,
  toolCallBody,
} from "../src/index.js";

const base = { tools: [...CORE_TOOLS], system: "You are motifcode." };
const okExecutor: Executor = { run: async () => ({ ok: true, output: "ok" }) };

function record(): { events: LoopEvent[]; emit: (e: LoopEvent) => void } {
  const events: LoopEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

const SCRIPT = [
  toolCallBody("bash", { command: "ls" }, { reasoning: "orient" }),
  doneBody("finished"),
  doneBody("finished", { confirm: true }),
];

describe("record then replay", () => {
  it("reproduces the session exactly", async () => {
    const live = new RecordingTransport(new ScriptedTransport(SCRIPT));
    const first = record();
    const a = await runLoop({ ...base, transport: live, executor: okExecutor, emit: first.emit });

    const replayed = ReplayTransport.fromJSONL(live.toJSONL());
    const second = record();
    const b = await runLoop({ ...base, transport: replayed, executor: okExecutor, emit: second.emit });

    expect(b.reason).toBe(a.reason);
    expect(b.turns).toBe(a.turns);
    // Ids are counter-based, so compare event shapes rather than raw payloads.
    expect(second.events.map((e) => e.type)).toEqual(first.events.map((e) => e.type));
  });

  it("captures what was asked, not just what came back", async () => {
    const live = new RecordingTransport(new ScriptedTransport(SCRIPT));
    const { emit } = record();
    await runLoop({ ...base, transport: live, executor: okExecutor, emit });
    const first = live.exchanges[0]!;
    expect(first.request.toolNames[0]).toBe("done");
    expect(first.request.toolNames).toHaveLength(CORE_TOOLS.length);
    expect(first.request.lastRole).toBe("system");
  });

  it("fails loudly when the recording runs short", async () => {
    const replay = new ReplayTransport([]);
    await expect(replay.complete()).rejects.toThrow(/replay exhausted/);
  });

  it("survives a JSONL round-trip", async () => {
    const live = new RecordingTransport(new ScriptedTransport(SCRIPT));
    const { emit } = record();
    await runLoop({ ...base, transport: live, executor: okExecutor, emit });
    const jsonl = live.toJSONL();
    expect(jsonl.trim().split("\n")).toHaveLength(live.exchanges.length);
    const back = ReplayTransport.fromJSONL(jsonl);
    await expect(back.complete()).resolves.toMatchObject({ rawText: expect.any(String) });
  });
});

describe("fault injection", () => {
  it("bad_escape produces exactly the escape this model gets wrong", () => {
    const body = toolCallBody("bash", { command: "grep x f" });
    const broken = damage(body, "bad_escape");
    // `\$` and `\s` are not JSON escapes — this is the vendor-documented case.
    expect(broken).toContain("\\$HOME");
    expect(() => JSON.parse(broken.split("<tool_call>")[1]!.split("</tool_call>")[0]!)).toThrow();
  });

  it("truncate leaves an opener with no closer", () => {
    const broken = damage(toolCallBody("bash", { command: "ls -la /some/long/path" }), "truncate");
    expect(broken).toContain("<tool_call>");
    expect(broken).not.toContain("</tool_call>");
  });

  it("unclosed_think never closes the reasoning block", () => {
    const broken = damage(toolCallBody("bash", { command: "ls" }, { reasoning: "hm" }), "unclosed_think");
    expect(broken).not.toContain("</think>");
  });

  it("only damages the turns it was told to", async () => {
    const inner = new ScriptedTransport(SCRIPT);
    const t = new FaultTransport(inner, [{ at: [2], kind: "empty" }]);
    const a = await t.complete({ messages: [], tools: [] });
    const b = await t.complete({ messages: [], tools: [] });
    expect(a.rawText).not.toBe("");
    expect(b.rawText).toBe("");
  });
});
