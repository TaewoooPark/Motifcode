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

describe("a stream cut short", () => {
  const fetchOf = (make: () => Response) => (async () => make()) as unknown as typeof fetch;
  const ask = (t: HttpTransport) =>
    t.complete({ messages: [{ role: "user", content: "x" }], tools: [], onDelta: () => {} }).catch((e: unknown) => e);

  it("is a retryable network error, not a response of what had arrived", async () => {
    // Measured on the hosted endpoint: two requests ended mid-thought in the
    // same second, with neither a finish_reason nor [DONE].
    const t = new HttpTransport({ endpoint: "http://x", model: "m", fetchImpl: fetchOf(() => sse([chunk({ reasoning: "half a th" })])) });
    const err = await ask(t);
    expect(TransportError.is(err)).toBe(true);
    expect((err as TransportError).kind).toBe("network");
    expect((err as TransportError).retryable).toBe(true);
  });

  it("still accepts a stream that ends on a finish_reason without [DONE], or on [DONE] alone", async () => {
    const finish = new HttpTransport({
      endpoint: "http://x",
      model: "m",
      fetchImpl: fetchOf(() => sse([chunk({ content: "ok" }), { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] }])),
    });
    const r = await finish.complete({ messages: [{ role: "user", content: "x" }], tools: [], onDelta: () => {} });
    expect(r.content).toBe("ok");
    expect(r.finishReason).toBe("stop");
    // [DONE] as the very last bytes, with no newline after it.
    const done = new HttpTransport({
      endpoint: "http://x",
      model: "m",
      fetchImpl: fetchOf(
        () =>
          new Response(`data: ${JSON.stringify(chunk({ content: "ok" }))}\n\ndata: [DONE]`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    });
    expect((await done.complete({ messages: [{ role: "user", content: "x" }], tools: [], onDelta: () => {} })).content).toBe("ok");
  });

  it("is abandoned as a retryable timeout once it has sent nothing for the request deadline", async () => {
    // The request deadline stops at the headers, which a stream sends first.
    let cancelled = false;
    const silent = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ reasoning: "hm" }))}\n\n`));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const t = new HttpTransport({ endpoint: "http://x", model: "m", requestTimeoutMs: 50, fetchImpl: fetchOf(silent) });
    const err = await ask(t);
    expect(TransportError.is(err)).toBe(true);
    expect((err as TransportError).kind).toBe("timeout");
    expect((err as TransportError).retryable).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("is never cut while it keeps producing, however long it takes in all", async () => {
    const slow = () => {
      const encoder = new TextEncoder();
      const lines = [
        ...Array.from({ length: 8 }, () => chunk({ reasoning: "." })),
        chunk({ content: "done thinking" }),
        { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
        "[DONE]",
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            let i = 0;
            const tick = setInterval(() => {
              const e = lines[i++]!;
              controller.enqueue(encoder.encode(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`));
              if (i === lines.length) {
                clearInterval(tick);
                controller.close();
              }
            }, 15);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    // Eleven pieces 15 ms apart: well past the 60 ms deadline in all, never
    // silent for as long as it.
    const t = new HttpTransport({ endpoint: "http://x", model: "m", requestTimeoutMs: 60, fetchImpl: fetchOf(slow) });
    const r = await t.complete({ messages: [{ role: "user", content: "x" }], tools: [], onDelta: () => {} });
    expect(r.content).toBe("done thinking");
    expect(r.reasoningContent).toBe("........");
  });

  it("is sent again by the loop, and the retry's answer is the turn", async () => {
    let calls = 0;
    const t = new HttpTransport({
      endpoint: "http://x",
      model: "m",
      fetchImpl: fetchOf(() =>
        ++calls === 1
          ? sse([chunk({ reasoning: "half a th" })])
          : sse([
              chunk({ reasoning: "answer briefly" }),
              chunk({ content: "fine" }),
              { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
              "[DONE]",
            ]),
      ),
    });
    const events: LoopEvent[] = [];
    const r = await runLoop({
      transport: t,
      tools: [...CORE_TOOLS],
      system: () => "sys",
      userTask: "t",
      executor: { run: async () => ({ ok: true, output: "" }) },
      emit: (e) => events.push(e),
      replyEnds: true,
      random: () => 0,
    });
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "notice" && /ended before the response did; retry 1\//.test(e.text))).toBe(true);
    expect(r.reason).toBe("done");
    expect(r.summary).toBe("fine");
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

  it("streams the wire even when nobody is watching, and emits no stream events then", async () => {
    // A gateway ends a request that has sent nothing back for 600 s; a
    // reasoning step can take longer.
    const requests: CompletionRequest[] = [];
    const transport = {
      endpoint: "fake://",
      model: "m",
      complete: async (req: CompletionRequest) => {
        requests.push(req);
        req.onDelta?.({ content: "hi" });
        return { content: "hi", rawText: "hi", ms: 1 };
      },
    };
    const events: LoopEvent[] = [];
    await runLoop({
      transport,
      tools: [...CORE_TOOLS],
      system: () => "sys",
      userTask: "t",
      executor: { run: async () => ({ ok: true, output: "" }) },
      emit: (e) => events.push(e),
      replyEnds: true,
    });
    expect(requests[0]!.onDelta).toBeTypeOf("function");
    expect(events.some((e) => e.type === "stream")).toBe(false);
  });
});
