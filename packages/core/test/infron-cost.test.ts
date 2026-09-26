import { describe, expect, it } from "vitest";
import { HttpTransport, isInfronEndpoint, runLoop, type LoopEvent } from "../src/index.js";

const endpoint = "https://llm.onerouter.pro";
const req = { messages: [{ role: "user" as const, content: "hello" }], tools: [] };
const answer = { choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] };
const credits = (amount: number) => ({ provider: "infron", unit: "credits", amount });

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

function sse(chunks: (object | string)[], chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    // Split inside JSON and SSE lines, as real network reads do.
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

function transport(response: () => Response, base = endpoint): HttpTransport {
  return new HttpTransport({ endpoint: base, model: "m", fetchImpl: async () => response() });
}

const contentChunk = { choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] };

describe("Infron endpoint recognition", () => {
  it("accepts only the official HTTPS origin and supported base paths", () => {
    for (const value of [endpoint, `${endpoint}/`, `${endpoint}/v1`, `${endpoint}/v1/`, " HTTPS://LLM.ONEROUTER.PRO/v1 "]) {
      expect(isInfronEndpoint(value), value).toBe(true);
    }
    for (const value of [
      "http://llm.onerouter.pro", "https://llm.onerouter.pro.evil.test", "https://evil.test/llm.onerouter.pro",
      "https://user:pass@llm.onerouter.pro", "https://@llm.onerouter.pro", `${endpoint}:8443`, `${endpoint}:443`,
      `${endpoint}/v1/chat/completions`, `${endpoint}/V1`, `${endpoint}//`, `${endpoint}/v1/..`, `${endpoint}/%76%31`,
      `${endpoint}?`, `${endpoint}#`, `${endpoint}/v1?key=secret`, `${endpoint}/v1#secret`, "http://localhost:8000",
    ]) expect(isInfronEndpoint(value), value).toBe(false);
  });

  it("opts into accounting only for Infron, with existing stream options intact", async () => {
    for (const base of [`${endpoint}/v1/`, "http://localhost:8000", "https://api.openai.com/v1", `${endpoint}/proxy`]) {
      for (const streaming of [false, true]) {
        let body: Record<string, unknown> = {};
        const t = new HttpTransport({ endpoint: base, model: "m", fetchImpl: async (_url, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json({ ...answer, cost: 3 });
        } });
        const response = await t.complete({ ...req, ...(streaming ? { onDelta: () => {} } : {}) });
        expect(body["usage"]).toEqual(isInfronEndpoint(base) ? { include: true } : undefined);
        expect(body["stream_options"]).toEqual(streaming ? { include_usage: true } : undefined);
        expect(response.usage?.reportedCost).toEqual(isInfronEndpoint(base) ? credits(3) : undefined);
      }
    }
  });
});

describe("provider-reported request costs", () => {
  it("keeps the nonstream total and only documented, finite, nonnegative cost components", async () => {
    const response = await transport(() => json({
      ...answer, cost: 0.000051,
      usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 8 } },
      cost_details: {
        audio_cost: 0, cache_prompt_cost: 0.00000805, cache_write_cost: -1, generation_cost: "0.1",
        image_cost: null, input_prompt_cost: 0.0000028, output_prompt_cost: 0.00004, tools_cost: {}, video_cost: [],
        secret: "must not persist", unexpected_charge: 99,
      },
    })).complete(req);
    expect(response.usage).toEqual({ promptTokens: 20, completionTokens: 4, cachedTokens: 8,
      reportedCost: { ...credits(0.000051), details: { audio_cost: 0, cache_prompt_cost: 0.00000805, input_prompt_cost: 0.0000028, output_prompt_cost: 0.00004 } },
    });
  });

  it.each([false, true])("preserves valid zero and never turns missing or malformed costs into zero (stream=%s)", async (streaming) => {
    for (const cost of ["0", "0.125", undefined, "null", '"0.125"', "-1", "1e999", "{}", "[]"]) {
      const raw = cost === undefined ? "{}" : `{"cost":${cost}}`;
      const body = JSON.stringify(answer).slice(0, -1) + (cost === undefined ? "" : `,"cost":${cost}`) + "}";
      const response = await transport(() => streaming
        ? sse([contentChunk, raw, "[DONE]"])
        : new Response(body, { headers: { "content-type": "application/json" } }),
      ).complete({ ...req, ...(streaming ? { onDelta: () => {} } : {}) });
      const valid = cost === "0" || cost === "0.125";
      expect(response.content).toBe("Hello");
      expect(response.usage?.reportedCost, String(cost)).toEqual(valid ? credits(Number(cost)) : undefined);
    }
  });

  it("collects the final accounting-only SSE chunk after finish_reason and emits its total once", async () => {
    const events: LoopEvent[] = [];
    const cost = { choices: [], cost: 0.25, cost_details: { input_prompt_cost: 0.1, output_prompt_cost: 0.15, private_data: "omit" } };
    const t = transport(() => sse([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      { ...cost, usage: { prompt_tokens: 20, completion_tokens: 4 } },
      cost, // Repeated request totals are not separate charges.
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 8 } } },
      "[DONE]", { choices: [], cost: 999 },
    ], 4096)); // Include bytes after [DONE] in the same network read.
    const result = await runLoop({ transport: t, tools: [], system: () => "sys", userTask: "hi",
      executor: { run: async () => ({ ok: true, output: "" }) }, emit: (event) => events.push(event), stream: true, replyEnds: true,
    });
    expect(result.reason).toBe("done");
    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ promptTokens: 20, completionTokens: 4, cachedTokens: 8,
      reportedCost: { ...credits(0.25), details: { input_prompt_cost: 0.1, output_prompt_cost: 0.15 } },
    });
    expect(events.filter((event) => event.type === "stream").map((event) => event.content)).toEqual(["Hel", "lo"]);
  });

  it("does not interpret another provider's streaming cost or nested usage.cost as Infron credits", async () => {
    const other = await transport(() => sse([contentChunk, { choices: [], cost: 4 }, "[DONE]"]), "https://other.test/v1")
      .complete({ ...req, onDelta: () => {} });
    expect(other.usage).not.toHaveProperty("reportedCost");
    const nested = await transport(() => json({ ...answer, usage: { cost: 4 }, cost_details: { input_prompt_cost: 4 } })).complete(req);
    expect(nested.usage).not.toHaveProperty("reportedCost");
  });

  it("omits malformed details while preserving the request total", async () => {
    for (const details of [null, "secret", [], { output_prompt_cost: "secret" }]) {
      const response = await transport(() => json({ ...answer, cost: 0, cost_details: details })).complete(req);
      expect(response.usage?.reportedCost).toEqual(credits(0));
    }
  });
});
