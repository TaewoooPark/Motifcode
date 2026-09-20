/**
 * The key check and the shapes a pasted key arrives in.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { normaliseKeyInput, readSecret, verifyApiKey } from "../src/login.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("verifying a key", () => {
  it("accepts a key the endpoint accepts", async () => {
    const r = await verifyApiKey({ endpoint: "https://llm.onerouter.pro/v1", model: "motif/motif-3", apiKey: "sk-x", fetchImpl: fakeFetch(200, { choices: [] }) });
    expect(r).toEqual({ ok: true });
  });

  it("asks for one token from the configured model, with the key as a bearer and the /v1 not doubled", async () => {
    let seen: { url: string; method: string | undefined; auth: string | undefined; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, method: init.method, auth: (init.headers as Record<string, string>)["authorization"], body: JSON.parse(String(init.body)) };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await verifyApiKey({ endpoint: "https://llm.onerouter.pro/v1/", model: "motif/motif-3", apiKey: "sk-abc", fetchImpl });
    expect(seen).toEqual({
      url: "https://llm.onerouter.pro/v1/chat/completions",
      method: "POST",
      auth: "Bearer sk-abc",
      body: { model: "motif/motif-3", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false },
    });
  });

  it("reports a rejected key with the server's own message, minus its request id", async () => {
    const r = await verifyApiKey({
      endpoint: "https://llm.onerouter.pro",
      model: "m",
      apiKey: "sk-bad",
      fetchImpl: fakeFetch(401, { error: { message: "The token status is not available (request id: 2026abc)", type: "infron_ai_error" } }),
    });
    expect(r).toEqual({ ok: false, reason: "the endpoint rejected this key (401: The token status is not available)" });
  });

  it("tells a server that is down, or a model that is not there, apart from a key that is wrong", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await verifyApiKey({ endpoint: "http://localhost:1", model: "m", apiKey: "sk-x", fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("could not be reached");
    const r2 = await verifyApiKey({ endpoint: "http://localhost:1", model: "m", apiKey: "sk-x", fetchImpl: fakeFetch(404, { error: { message: "model m not found" } }) });
    expect(r2).toEqual({ ok: false, reason: "http://localhost:1 answered 404 for m: model m not found — the key may be fine; check the model id" });
  });
});

describe("what was pasted", () => {
  it("strips the packaging a key comes wrapped in", () => {
    expect(normaliseKeyInput("  sk-abc123 \n")).toBe("sk-abc123");
    expect(normaliseKeyInput("MOTIF_API_KEY=sk-abc123")).toBe("sk-abc123");
    expect(normaliseKeyInput('export MOTIF_API_KEY="sk-abc123"')).toBe("sk-abc123");
    expect(normaliseKeyInput("'sk-abc123'")).toBe("sk-abc123");
    expect(normaliseKeyInput("")).toBe("");
  });
});

describe("reading the key", () => {
  it("takes one line from a pipe when there is no terminal", async () => {
    const stdin = new PassThrough();
    const out: string[] = [];
    const p = readSecret("key › ", {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WriteStream,
    });
    stdin.end("sk-piped\nignored\n");
    expect(await p).toBe("sk-piped");
    // Nothing is echoed into a pipe, not even the prompt.
    expect(out).toEqual([]);
  });
});
