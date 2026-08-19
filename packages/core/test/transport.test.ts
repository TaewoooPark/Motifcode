/**
 * Failure, typed.
 *
 * The bug: `HttpTransport` only ever built a `TransportError` for a non-2xx
 * response. A refused connection — which in Node arrives as a `TypeError:
 * fetch failed` — escaped as a plain exception, missed the retry path
 * entirely, and ended the session. On a single local GPU serving a 187 GB
 * checkpoint, that is the *most* common failure, and it was the one failure
 * the retry logic could not see.
 */

import { describe, expect, it, vi } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import { ScriptedTransport, doneBody } from "@motifcode/replay";
import {
  HttpTransport,
  TransportError,
  backoffDelay,
  runLoop,
  sleep,
  type Executor,
  type LoopEvent,
} from "../src/index.js";

const okExecutor: Executor = { run: async () => ({ ok: true, output: "ok" }) };
const sink = (_e: LoopEvent) => {};
const req = { messages: [{ role: "user" as const, content: "x" }], tools: [] };

function transportWith(fetchImpl: unknown): HttpTransport {
  return new HttpTransport({ endpoint: "http://x", model: "m", fetchImpl: fetchImpl as typeof fetch });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("failure kinds", () => {
  it("wraps a refused connection as a retryable network error", async () => {
    // This is what `fetch` throws when nothing is listening.
    const t = transportWith(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    });
    const err = await t.complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe("network");
    expect((err as TransportError).retryable).toBe(true);
    expect((err as TransportError).message).toContain("ECONNREFUSED");
  });

  it("wraps a reset connection the same way", async () => {
    const t = transportWith(async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const err = (await t.complete(req).catch((e: unknown) => e)) as TransportError;
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("marks 5xx retryable and 4xx not", async () => {
    const five = transportWith(async () => new Response("engine died", { status: 500 }));
    const four = transportWith(async () => new Response("bad tool schema", { status: 400 }));
    expect(((await five.complete(req).catch((e: unknown) => e)) as TransportError).retryable).toBe(true);
    expect(((await four.complete(req).catch((e: unknown) => e)) as TransportError).retryable).toBe(false);
  });

  it("does not silently retry a 429", async () => {
    // Retrying without honouring Retry-After is how a rate limit becomes a
    // self-inflicted outage.
    const t = transportWith(async () => new Response("slow down", { status: 429 }));
    expect(((await t.complete(req).catch((e: unknown) => e)) as TransportError).retryable).toBe(false);
  });

  it("treats a 2xx that is not a completion as a protocol error", async () => {
    // Reaching into `undefined` here used to produce an empty completion, which
    // reads as a model that said nothing rather than a server that answered
    // wrongly.
    for (const payload of [{}, { choices: [] }, { choices: null }]) {
      const t = transportWith(async () => jsonResponse(payload));
      const err = (await t.complete(req).catch((e: unknown) => e)) as TransportError;
      expect(err.kind, JSON.stringify(payload)).toBe("protocol");
      expect(err.retryable).toBe(false);
    }
  });

  it("treats a 2xx that is not JSON as a protocol error", async () => {
    const t = transportWith(async () => new Response("<html>502</html>", { status: 200 }));
    expect(((await t.complete(req).catch((e: unknown) => e)) as TransportError).kind).toBe("protocol");
  });

  it("reports an abort as aborted, not as a network failure", async () => {
    const ac = new AbortController();
    ac.abort();
    const t = transportWith(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const err = (await t.complete({ ...req, signal: ac.signal }).catch((e: unknown) => e)) as TransportError;
    expect(err.kind).toBe("aborted");
    expect(err.retryable).toBe(false);
  });

  it("times out rather than waiting on a wedged engine forever", async () => {
    const t = new HttpTransport({
      endpoint: "http://x",
      model: "m",
      requestTimeoutMs: 10,
      fetchImpl: ((_u: string, init: { signal?: AbortSignal }) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as unknown as typeof fetch,
    });
    const err = (await t.complete(req).catch((e: unknown) => e)) as TransportError;
    expect(err.kind).toBe("timeout");
    expect(err.retryable).toBe(true);
  });
});

describe("what goes in the body", () => {
  it("sends the explicit output cap, seed and stop sequences", async () => {
    const seen: Record<string, unknown>[] = [];
    const t = transportWith(async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
    });
    await t.complete({ ...req, maxTokens: 4096, seed: 1001, stop: ["<|endofturn|>"] });
    expect(seen[0]).toMatchObject({ max_tokens: 4096, seed: 1001, stop: ["<|endofturn|>"] });
  });

  it("posts the rendered prompt on the raw path and no messages", async () => {
    const seen: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const t = transportWith(async (u: string, init: { body: string }) => {
      urls.push(u);
      seen.push(JSON.parse(init.body) as Record<string, unknown>);
      return jsonResponse({ choices: [{ text: "hi", finish_reason: "stop" }] });
    });
    await t.complete({ ...req, raw: true, prompt: "PROMPT-BYTES" });
    expect(urls[0]).toBe("http://x/v1/completions");
    expect(seen[0]!["prompt"]).toBe("PROMPT-BYTES");
    expect(seen[0]!["messages"]).toBeUndefined();
  });
});

describe("backoff", () => {
  it("grows and is capped", () => {
    const full = { random: () => 1 };
    expect(backoffDelay(1, full)).toBe(500);
    expect(backoffDelay(2, full)).toBe(1000);
    expect(backoffDelay(3, full)).toBe(2000);
    expect(backoffDelay(20, full)).toBe(30_000);
  });

  it("jitters, so repeated attempts do not land in lockstep", () => {
    expect(backoffDelay(4, { random: () => 0 })).toBe(0);
    expect(backoffDelay(4, { random: () => 0.5 })).toBe(2000);
  });

  it("wakes immediately when the caller aborts", async () => {
    const ac = new AbortController();
    const waiting = sleep(60_000, ac.signal);
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("the loop's retry policy", () => {
  const base = {
    tools: [...CORE_TOOLS],
    system: () => "sys",
    userTask: "t",
    executor: okExecutor,
    emit: sink,
    // Zero jitter keeps the test instant and deterministic.
    random: () => 0,
  };

  it("recovers from a socket failure and finishes the task", async () => {
    const t = new ScriptedTransport([
      new TransportError("cannot reach: ECONNREFUSED", { kind: "network" }),
      new TransportError("cannot reach: ECONNREFUSED", { kind: "network" }),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport: t });
    expect(r.reason).toBe("done");
    expect(r.transportErrors).toBe(2);
  });

  it("gives up on a 4xx immediately rather than resending a wrong request", async () => {
    const t = new ScriptedTransport([
      new TransportError("400 — unknown field", { kind: "http", status: 400 }),
      doneBody("d"),
    ]);
    const r = await runLoop({ ...base, transport: t });
    expect(r.reason).toBe("transport_error");
    // One attempt. Resending an invalid request is invalid again.
    expect(r.transportErrors).toBe(1);
  });

  it("stops after the retry budget", async () => {
    const t = new ScriptedTransport([new TransportError("dead", { kind: "network" })], true);
    const r = await runLoop({ ...base, transport: t, maxServerRetries: 2 });
    expect(r.reason).toBe("transport_error");
    expect(r.transportErrors).toBe(3);
  });

  it("does not append to history while retrying", async () => {
    // A retry that grew the transcript would send a different request each
    // time, so "the session state is intact" would be false exactly when it
    // matters.
    const t = new ScriptedTransport([
      new TransportError("down", { kind: "network" }),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport: t });
    const lengths = t.seen.map((r) => r.messages.length);
    expect(lengths[0]).toBe(lengths[1]);
  });

  it("aborts without retrying", async () => {
    const t = new ScriptedTransport([new TransportError("stopped", { kind: "aborted" })], true);
    const r = await runLoop({ ...base, transport: t });
    expect(r.reason).toBe("aborted");
  });

  it("does not retry a protocol error", async () => {
    const t = new ScriptedTransport([
      new TransportError("no choices", { kind: "protocol" }),
      doneBody("d"),
    ]);
    const r = await runLoop({ ...base, transport: t });
    expect(r.reason).toBe("transport_error");
  });

  it("sleeps between attempts rather than hammering", async () => {
    vi.useFakeTimers();
    try {
      const t = new ScriptedTransport([
        new TransportError("down", { kind: "network" }),
        doneBody("d"),
        doneBody("d", { confirm: true }),
      ]);
      // Full jitter at random()=1 gives the whole 500 ms of attempt one.
      const run = runLoop({ ...base, transport: t, random: () => 1 });
      await vi.advanceTimersByTimeAsync(1000);
      const r = await run;
      expect(r.reason).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});
