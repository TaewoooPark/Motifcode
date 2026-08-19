/**
 * Record and replay.
 *
 * The value of this package is that a session recorded once — eventually, a
 * real one against Motif-3 — becomes a deterministic test forever. That is only
 * worth anything if the replay can fail. The old one could not: it stored a
 * message count, the last role and the tool names, then returned the next
 * canned answer regardless of what was asked. Every test below is a change that
 * used to pass unnoticed.
 */

import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import { runLoop, type Executor, type LoopEvent } from "@motifcode/core";
import {
  FaultTransport,
  RecordingExecutor,
  RecordingTransport,
  ReplayDivergence,
  ReplayExecutor,
  ReplayTransport,
  ScriptedTransport,
  assertConsumed,
  damage,
  normalizeEvents,
  doneBody,
  toJSONL,
  toolCallBody,
} from "../src/index.js";

const TASK = "rename the helper and update its callers";
const base = { tools: [...CORE_TOOLS], system: () => "You are motifcode.", userTask: TASK };
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

/** Run once against a script, capturing both the model and the tool boundary. */
async function capture(overrides: Partial<typeof base> = {}) {
  const transport = new RecordingTransport(new ScriptedTransport(SCRIPT));
  const executor = new RecordingExecutor(okExecutor);
  const { events, emit } = record();
  const result = await runLoop({ ...base, ...overrides, transport, executor, emit });
  return { transport, executor, events, result };
}

/** Replay a capture under possibly-different options. */
async function replay(
  cap: Awaited<ReturnType<typeof capture>>,
  overrides: Partial<typeof base> = {},
) {
  // Replaying a recording means standing in for the endpoint it was recorded
  // against; reporting a different model id would make the two event streams
  // differ for a reason that has nothing to do with the session.
  const transport = new ReplayTransport(cap.transport.exchanges, {
    endpoint: cap.transport.endpoint,
    model: cap.transport.model,
  });
  const executor = new ReplayExecutor(cap.executor.executions);
  const { events, emit } = record();
  const result = await runLoop({ ...base, ...overrides, transport, executor, emit });
  assertConsumed(transport, executor);
  return { events, result };
}

/* ------------------------------------------------------------------ */

describe("record then replay", () => {
  it("reproduces the session exactly", async () => {
    const cap = await capture();
    const again = await replay(cap);
    expect(again.result.reason).toBe(cap.result.reason);
    expect(again.result.turns).toBe(cap.result.turns);
    // The whole normalised event stream, not just the type sequence. Comparing
    // types alone passes for two runs that did entirely different things; the
    // only fields excluded are wall-clock timings, which cannot be expected to
    // repeat.
    expect(normalizeEvents(again.events)).toEqual(normalizeEvents(cap.events));
  });

  it("captures what was asked, not just what came back", async () => {
    const cap = await capture();
    const first = cap.transport.exchanges[0]!;
    expect(first.request.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(first.request.messages[1]!.content).toBe(TASK);
    expect(first.request.tools).toHaveLength(CORE_TOOLS.length);
    expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records tool results, so replay does not depend on the filesystem", async () => {
    const cap = await capture();
    expect(cap.executor.executions).toHaveLength(1);
    expect(cap.executor.executions[0]!.call.name).toBe("bash");
    expect(cap.executor.executions[0]!.result.output).toBe("ok");
  });

  it("survives a JSONL round-trip", async () => {
    const cap = await capture();
    const jsonl = toJSONL(cap.transport.exchanges);
    expect(jsonl.trim().split("\n")).toHaveLength(cap.transport.exchanges.length);
    const back = ReplayTransport.fromJSONL(jsonl);
    expect(back.remaining).toBe(cap.transport.exchanges.length);
  });
});

/* ------------------------------------------------------------------ */

describe("divergence is detected", () => {
  it("fails when the task changes by one character", async () => {
    const cap = await capture();
    await expect(replay(cap, { userTask: `${TASK}.` })).rejects.toThrow(ReplayDivergence);
  });

  it("fails when the system prompt changes", async () => {
    const cap = await capture();
    await expect(replay(cap, { system: () => "You are something else." })).rejects.toThrow(
      ReplayDivergence,
    );
  });

  it("fails when a tool description changes", async () => {
    // A description change rewrites every prompt and changes what the repair
    // oracle accepts. Hashing tool *names* missed it entirely.
    const cap = await capture();
    const tweaked = CORE_TOOLS.map((t, i) =>
      i === 1
        ? { ...t, function: { ...("function" in t ? t.function : t), description: "changed" } }
        : t,
    );
    await expect(replay(cap, { tools: tweaked as typeof base.tools })).rejects.toThrow(
      /tools\[1\]/,
    );
  });

  it("fails when the tool order changes", async () => {
    const cap = await capture();
    const reordered = [CORE_TOOLS[1]!, CORE_TOOLS[0]!, ...CORE_TOOLS.slice(2)];
    await expect(replay(cap, { tools: reordered as typeof base.tools })).rejects.toThrow(
      ReplayDivergence,
    );
  });

  it("names the field that diverged", async () => {
    const cap = await capture();
    await expect(replay(cap, { userTask: "something else entirely" })).rejects.toThrow(
      /messages\[1\] \(user\)/,
    );
  });

  it("fails when a tool result differs by one byte", async () => {
    const cap = await capture();
    const tampered = cap.executor.executions.map((e) => ({
      ...e,
      result: { ...e.result, output: `${e.result.output} ` },
    }));
    const transport = new ReplayTransport(cap.transport.exchanges);
    const executor = new ReplayExecutor(tampered);
    const { emit } = record();
    // The tool result feeds the next prompt, so a changed byte diverges at the
    // following request rather than at the call itself.
    await expect(
      runLoop({ ...base, transport, executor, emit }),
    ).rejects.toThrow(ReplayDivergence);
  });

  it("fails when tool arguments differ from the recording", async () => {
    const cap = await capture();
    const tampered = cap.executor.executions.map((e) => ({
      ...e,
      callHash: "0".repeat(64),
    }));
    const executor = new ReplayExecutor(tampered);
    const transport = new ReplayTransport(cap.transport.exchanges);
    const { emit } = record();
    await expect(runLoop({ ...base, transport, executor, emit })).rejects.toThrow(/arguments differ/);
  });

  it("fails when the run is shorter than the recording", async () => {
    const cap = await capture();
    // Only the first exchange is consumed before the loop would ask for more.
    const transport = new ReplayTransport(cap.transport.exchanges);
    const executor = new ReplayExecutor(cap.executor.executions);
    await transport.complete({
      ...cap.transport.exchanges[0]!.request,
    });
    expect(() => assertConsumed(transport, executor)).toThrow(/never requested/);
  });

  it("fails when the run is longer than the recording", async () => {
    const transport = new ReplayTransport([]);
    await expect(
      transport.complete({ messages: [], tools: [] }),
    ).rejects.toThrow(/replay exhausted/);
  });
});

/* ------------------------------------------------------------------ */

describe("failed turns replay too", () => {
  it("records a transport error and reproduces it", async () => {
    const { TransportError } = await import("@motifcode/core");
    const inner = new ScriptedTransport([
      new TransportError("engine core died", { kind: "http", status: 500 }),
      ...SCRIPT,
    ]);
    const transport = new RecordingTransport(inner);
    const executor = new RecordingExecutor(okExecutor);
    const { emit } = record();
    const live = await runLoop({ ...base, transport, executor, emit, random: () => 0 });
    expect(live.reason).toBe("done");
    expect(transport.exchanges[0]!.response.ok).toBe(false);

    const replayed = new ReplayTransport(transport.exchanges);
    const { emit: emit2 } = record();
    const again = await runLoop({
      ...base,
      transport: replayed,
      executor: new ReplayExecutor(executor.executions),
      emit: emit2,
      random: () => 0,
    });
    expect(again.reason).toBe("done");
    expect(again.transportErrors).toBe(live.transportErrors);
  });
});

/* ------------------------------------------------------------------ */

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

  it("strips structured tool calls as well as the text", async () => {
    // Damaging only `content` left the server-extracted calls intact, so the
    // loop read those and the fault changed nothing — the test proved the
    // fault had been ignored.
    const inner = new ScriptedTransport([
      {
        content: "</think>prose",
        rawText: "</think>prose",
        ms: 1,
        toolCalls: [{ id: "s1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      },
    ]);
    const t = new FaultTransport(inner, [{ at: [1], kind: "corrupt" }]);
    const res = await t.complete({ messages: [], tools: [] });
    expect(res.toolCalls).toBeUndefined();
  });

  it("marks a truncated response as length-capped, as a real server would", async () => {
    const inner = new ScriptedTransport([toolCallBody("bash", { command: "ls -la /x" })]);
    const t = new FaultTransport(inner, [{ at: [1], kind: "truncate" }]);
    const res = await t.complete({ messages: [], tools: [] });
    expect(res.finishReason).toBe("length");
  });
});
