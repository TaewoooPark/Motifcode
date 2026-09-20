/**
 * Streaming: the wire may stream, the response is still whole.
 */

import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import { HttpTransport, runLoop, type CompletionRequest, type Executor, type LoopEvent } from "../src/index.js";

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Cut at awkward places on purpose: a chunk boundary inside a line.
      const bytes = new TextEncoder().encode(body);
      const cut = Math.floor(bytes.length / 3);
      controller.enqueue(bytes.subarray(0, cut));
      controller.enqueue(bytes.subarray(cut, cut + 7));
      controller.enqueue(bytes.subarray(cut + 7));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  choices: [{ delta, finish_reason: null, index: 0 }],
  ...extra,
});

describe("the streaming transport", () => {
  it("hands out each piece and returns the assembled whole, tool calls joined by index", async () => {
    const seen: unknown[] = [];
    const t = new HttpTransport({
      endpoint: "http://x",
      model: "m",
      fetchImpl: (async (_u: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body));
        return sse([
          chunk({ role: "assistant", content: "" }),
          chunk({ reasoning: "think " }),
          chunk({ reasoning: "hard" }),
          chunk({ content: "Hel" }),
          chunk({ content: "lo" }),
          chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "bash", arguments: '{"comm' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'and": "ls"}' } }] }),
          { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 40 } } },
          "[DONE]",
        ]);
      }) as unknown as typeof fetch,
    });
    const deltas: unknown[] = [];
    const r = await t.complete({ messages: [{ role: "user", content: "x" }], tools: [], onDelta: (d) => deltas.push(d) });
    expect((seen[0] as { stream: boolean; stream_options: unknown }).stream).toBe(true);
    expect((seen[0] as { stream_options: { include_usage: boolean } }).stream_options).toEqual({ include_usage: true });
    expect(r.content).toBe("Hello");
    expect(r.reasoningContent).toBe("think hard");
    expect(r.toolCalls).toEqual([{ id: "t1", type: "function", function: { name: "bash", arguments: '{"command": "ls"}' } }]);
    expect(r.finishReason).toBe("tool_calls");
    expect(r.usage).toEqual({ promptTokens: 50, completionTokens: 9, cachedTokens: 40 });
    expect(deltas).toEqual([
      { reasoning: "think " },
      { reasoning: "hard" },
      { content: "Hel" },
      { content: "lo" },
      { tool: "bash" },
      { tool: "bash" },
    ]);
  });

  it("accepts a plain JSON answer to a streaming request, and still reports it once", async () => {
    // A proxy that ignores `stream` is not an error.
    const t = new HttpTransport({
      endpoint: "http://x",
      model: "m",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "whole", reasoning: "r" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const deltas: unknown[] = [];
    const r = await t.complete({ messages: [{ role: "user", content: "x" }], tools: [], onDelta: (d) => deltas.push(d) });
    expect(r.content).toBe("whole");
    expect(deltas).toEqual([{ reasoning: "r", content: "whole" }]);
  });

  it("sends stream: false when nobody is watching", async () => {
    const seen: unknown[] = [];
    const t = new HttpTransport({
      endpoint: "http://x",
      model: "m",
      fetchImpl: (async (_u: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    await t.complete({ messages: [{ role: "user", content: "x" }], tools: [] });
    expect((seen[0] as { stream: boolean }).stream).toBe(false);
    expect(seen[0]).not.toHaveProperty("stream_options");
  });
});

describe("the loop's stream events", () => {
  it("forwards pieces as stream events before the turn's own events", async () => {
    const pieces = [{ reasoning: "r1" }, { content: "part " }, { content: "two" }];
    const body = "</think>part two";
    const transport = {
      endpoint: "fake://",
      model: "m",
      complete: async (req: CompletionRequest) => {
        for (const p of pieces) req.onDelta?.(p);
        return { content: body, rawText: body, ms: 1 };
      },
    };
    const events: LoopEvent[] = [];
    const executor: Executor = { run: async () => ({ ok: true, output: "" }) };
    const r = await runLoop({
      transport,
      tools: [...CORE_TOOLS],
      system: () => "sys",
      userTask: "t",
      executor,
      emit: (e) => events.push(e),
      stream: true,
      replyEnds: true,
    });
    expect(r.reason).toBe("done");
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "stream")).toHaveLength(3);
    expect(types.indexOf("stream")).toBeGreaterThan(types.indexOf("turn_start"));
    expect(types.indexOf("content_delta")).toBeGreaterThan(types.lastIndexOf("stream"));
    const streamed = events.filter((e): e is Extract<LoopEvent, { type: "stream" }> => e.type === "stream");
    expect(streamed.map((e) => e.content ?? e.reasoning)).toEqual(["r1", "part ", "two"]);
  });
});
