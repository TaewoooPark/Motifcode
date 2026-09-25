import { describe, expect, it, vi } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import { ScriptedTransport, toolCallBody } from "@motifcode/replay";
import { runLoop, type Executor, type LoopCheckpoint, type LoopEvent } from "../src/index.js";

const prose = '</think>먼저 호출합니다.\n```json\n{"server":"lab","method":"echo","args":{"text":"한글"}}\n```';
const feedback = "Use the registered tool only if the original task requires an unfinished action; otherwise explain in prose.";
const base = {
  tools: [...CORE_TOOLS], system: () => "stable system", userTask: "echo 한글",
  replyEnds: true, confirmDone: false, maxTurns: 8,
  replyRecovery: (content: string) => content.includes('"server":"lab"') ? feedback : undefined,
  emit: (_event: LoopEvent) => {},
};

describe("bounded reply recovery", () => {
  it("asks once, preserves the original task and response, and executes only the subsequent proper call", async () => {
    const transport = new ScriptedTransport([prose, toolCallBody("mcp", { server: "lab", method: "echo", args: { text: "한글" } }), "</think>Finished."]);
    const run = vi.fn<Executor["run"]>(async () => ({ ok: true, output: "observed" }));
    const events: LoopEvent[] = [];
    const result = await runLoop({ ...base, transport, executor: { run }, emit: (event) => events.push(event) });
    expect(result.reason).toBe("done");
    expect(transport.seen).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ name: "mcp", arguments: { server: "lab", method: "echo", args: { text: "한글" } } });
    expect(transport.seen[1]!.messages.slice(0, 2)).toEqual(transport.seen[0]!.messages.slice(0, 2));
    expect(transport.seen[1]!.messages.at(-2)).toMatchObject({ role: "assistant", content: prose.slice("</think>".length) });
    expect(transport.seen[1]!.messages.at(-1)).toMatchObject({ content: feedback });
    expect(events.filter((e) => e.type === "repair")).toEqual([{ type: "repair", kind: "parse", reason: "unexecuted tool arguments", attempt: 1, max: 1 }]);
  });

  it("accepts an explanation after clarification without ever executing the example", async () => {
    const transport = new ScriptedTransport([prose, "</think>This is only an example; no operation is requested."]);
    const run = vi.fn(async () => ({ ok: true, output: "unexpected" }));
    const result = await runLoop({ ...base, transport, executor: { run } });
    expect(result.reason).toBe("done");
    expect(run).not.toHaveBeenCalled();
  });

  it("stops repeated arguments as an unresolved task instead of claiming success", async () => {
    const transport = new ScriptedTransport([prose, prose, prose]);
    const run = vi.fn(async () => ({ ok: true, output: "unexpected" }));
    const events: LoopEvent[] = [];
    const result = await runLoop({ ...base, transport, executor: { run }, emit: (event) => events.push(event) });
    expect(result.reason).toBe("no_action_limit");
    expect(result.summary).toContain("No call was dispatched from that response");
    expect(transport.seen).toHaveLength(2);
    expect(run).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "notice", level: "warn", text: result.summary });
  });

  it("does not reset its budget after a successful call or resume", async () => {
    const checkpoints: LoopCheckpoint[] = [];
    const transport = new ScriptedTransport([prose, toolCallBody("mcp", { server: "lab", method: "echo", args: { text: "한글" } })]);
    const run = vi.fn(async () => ({ ok: true, output: "observed" }));
    await runLoop({ ...base, transport, executor: { run }, maxTurns: 2, onCheckpoint: (cp) => checkpoints.push(cp) });
    expect(checkpoints.at(-1)?.replyRepairs).toBe(1);
    const resumed = new ScriptedTransport([prose, prose]);
    const result = await runLoop({ ...base, transport: resumed, executor: { run }, resume: checkpoints.at(-1)! });
    expect(result.reason).toBe("no_action_limit");
    expect(resumed.seen).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("respects the task's turn limit", async () => {
    const transport = new ScriptedTransport([prose, "</think>Never reached"]);
    const result = await runLoop({ ...base, transport, executor: { run: async () => ({ ok: true, output: "unexpected" }) }, maxTurns: 1 });
    expect(result.reason).toBe("turn_limit");
    expect(transport.seen).toHaveLength(1);
  });

  it("does not make a recovery request after cancellation", async () => {
    const controller = new AbortController();
    const transport = new ScriptedTransport([prose, "</think>Never reached"]);
    const result = await runLoop({ ...base, transport, executor: { run: async () => ({ ok: true, output: "unexpected" }) }, signal: controller.signal,
      onCheckpoint: (cp) => { if (cp.replyRepairs) controller.abort(); },
    });
    expect(result.reason).toBe("aborted");
    expect(transport.seen).toHaveLength(1);
  });

  it("leaves ordinary replies and callers without the hook at one request", async () => {
    for (const options of [{ replyRecovery: undefined, response: prose }, { replyRecovery: base.replyRecovery, response: "</think>일반 답변입니다." }]) {
      const transport = new ScriptedTransport([options.response]);
      const result = await runLoop({ ...base, replyRecovery: options.replyRecovery, transport, executor: { run: async () => ({ ok: true, output: "unexpected" }) } });
      expect(result.reason).toBe("done");
      expect(transport.seen).toHaveLength(1);
    }
  });

  it.each(["object", "raw"] as const)("does not request native tool recovery in the experimental %s channel", async (channel) => {
    const replyRecovery = vi.fn(() => feedback);
    const transport = new ScriptedTransport([prose]);
    await runLoop({ ...base, transport, channel, replyRecovery, maxTurns: 1, executor: { run: async () => ({ ok: true, output: "unexpected" }) } });
    expect(replyRecovery).not.toHaveBeenCalled();
  });
});
