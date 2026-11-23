/**
 * Streaming: the wire may stream, the response is still whole.
 */

import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import { HttpTransport, TransportError, runLoop, type CompletionRequest, type Executor, type LoopEvent } from "../src/index.js";

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

describe.each([false, true])("text-completion reasoning (stream=%s)", (stream) => {
  async function complete(choices: Record<string, unknown>[], raw = true) {
    const deltas: unknown[] = [];
    const transport = new HttpTransport({
      endpoint: "https://openrouter.ai/api", model: "m",
      fetchImpl: async () => stream
        ? sse([...choices.map((choice) => ({ choices: [choice] })), "[DONE]"])
        : new Response(JSON.stringify({ choices: [choices[0]] }), { headers: { "content-type": "application/json" } }),
    });
    const result = await transport.complete({
      messages: [{ role: "user", content: "test" }], tools: [],
      ...(raw ? { raw: true, prompt: "test" } : {}),
      ...(stream ? { onDelta: (delta) => deltas.push(delta) } : {}),
    });
    return { result, deltas };
  }

  it("keeps choice-level reasoning out of the text and preserves the final answer", async () => {
    const choices = stream
      ? [{ text: "", reasoning: "first " }, { text: "", reasoning: "second" }, { text: "answer", reasoning: null, finish_reason: "stop" }]
      : [{ text: "answer", reasoning: "first second", finish_reason: "stop" }];
    const { result, deltas } = await complete(choices);
    expect(result).toMatchObject({ content: "answer", rawText: "answer", reasoningContent: "first second", finishReason: "stop" });
    if (stream) expect(deltas).toEqual([{ reasoning: "first " }, { reasoning: "second" }, { content: "answer" }]);
  });

  it.each([{}, { reasoning: null }, { reasoning: "" }])("preserves inline reasoning for unsplit raw completions (%j)", async (fields) => {
    const { result } = await complete([{ ...fields, text: "inline</think>answer" }]);
    expect(result.reasoningContent).toBeUndefined();
    expect(result.rawText).toBe("inline</think>answer");
  });

  it("does not take completion-level metadata as evidence of a chat reasoning boundary", async () => {
    const { result } = await complete([{
      reasoning: "other metadata",
      ...(stream ? { delta: { content: "chat" } } : { message: { content: "chat" } }),
    }], false);
    expect(result.reasoningContent).toBeUndefined();
    expect(result.content).toBe("chat");
  });

  it("accepts the reasoning_content alias without duplicating an answer", async () => {
    const { result } = await complete([{ text: "answer", reasoning: "", reasoning_content: "separate" }]);
    expect(result.reasoningContent).toBe("separate");
    expect(result.content).toBe("answer");
  });
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

  it("turns an error the server writes into the stream into a retryable generation error", async () => {
    // Infron stops a Motif-3 sample that keeps repeating itself with an error
    // chunk, then closes with an ordinary `stop`. Read as a finished reply it
    // is an empty answer; read as an error it can be sampled again.
    const t = new HttpTransport({
      endpoint: "http://x",
      model: "m",
      fetchImpl: (async () =>
        sse([
          chunk({ reasoning: "OK let me just do it. I'll read the table.txt files for the" }),
          {
            choices: [],
            error: {
              code: "repetition_detected",
              message: "Repetition was detected in the model's output and generation was stopped. Retry, or send a `repetition_penalty` above 1.",
              param: "",
              type: "generation_error",
            },
          },
          { choices: [{ delta: { reasoning: " _" }, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 37047, completion_tokens: 12866 } },
          "[DONE]",
        ])) as unknown as typeof fetch,
    });
    const err = await t.complete({ messages: [{ role: "user", content: "x" }], tools: [], onDelta: () => {} }).catch((e: unknown) => e);
    expect(TransportError.is(err)).toBe(true);
    const te = err as TransportError;
    expect(te.kind).toBe("generation");
    expect(te.code).toBe("repetition_detected");
    expect(te.retryable).toBe(true);
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

describe.each([
  ["https://openrouter.ai/api/v1", true],
  ["https://llm.onerouter.pro", false],
  ["https://api-cbt.morphfactory.io", false],
  ["http://localhost:8189", false],
  ["https://openrouter.ai/api/custom", false],
  ["https://openrouter.ai/api/v1/v1", false],
  ["https://openrouter.ai.example.org/api", false],
] as const)("stream compatibility at %s", (endpoint, openRouter) => {
  function complete(events: unknown[], raw = false) {
    return new HttpTransport({ endpoint, model: "fixture", fetchImpl: async () => sse(events) }).complete({
      messages: [], tools: [], ...(raw ? { raw: true, prompt: "fixture" } : {}), onDelta: () => {},
    });
  }
  const write = chunk({ tool_calls: [{ index: 0, id: "w", function: { name: "write", arguments: "{}" } }] });
  const finish = { choices: [{ delta: {}, finish_reason: "tool_calls" }] };

  it("uses the endpoint's policy for unsealed native actions", async () => {
    const response = complete([write]);
    if (openRouter) await expect(response).rejects.toMatchObject({ kind: "network" });
    else expect((await response).toolCalls).toHaveLength(1);
  });

  it("uses the endpoint's policy for torn events and changes after finish", async () => {
    for (const events of [[write, "{bad", finish, "[DONE]"], [write, finish, chunk({ content: "after" }), "[DONE]"]]) {
      const response = complete(events);
      if (openRouter) await expect(response).rejects.toMatchObject({ kind: "network" });
      else expect((await response).toolCalls).toHaveLength(1);
    }
  });

  it("handles split reasoning on the text-completions route", async () => {
    const choice = { choices: [{ text: "answer", reasoning: "separate", finish_reason: "stop" }] };
    const streaming = await complete([choice, "[DONE]"], true);
    const json = await new HttpTransport({ endpoint, model: "fixture", fetchImpl: async () => Response.json(choice) })
      .complete({ messages: [], tools: [], raw: true, prompt: "fixture" });
    for (const result of [streaming, json]) {
      expect(result.content).toBe("answer");
      expect(result.reasoningContent).toBe(openRouter ? "separate" : undefined);
    }
  });
});
