import { afterEach, describe, expect, it, vi } from "vitest";
import { InfronBilling, type BalanceState, type InfronBillingOptions } from "../src/billing.js";

const ENDPOINT = "https://llm.onerouter.pro";
const BALANCE_URL = "https://api.onerouter.pro/v1/balance";
const KEY = "fixture-private-api-key";
const clients: InfronBilling[] = [];
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
function client(options: InfronBillingOptions = {}) {
  const billing = new InfronBilling(options);
  clients.push(billing);
  billing.configure(ENDPOINT, KEY);
  return billing;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  for (const billing of clients) billing.close();
  clients.length = 0;
  vi.useRealTimers();
});

describe("Infron account balance", () => {
  it.each([0, -12.5, 3951.9459])("keeps the numeric balance %s and discards account metadata", async (credits) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ credit_balance: credits, account_name: "private account" }));
    const billing = client({ fetchImpl, now: () => 123_000 });
    await billing.refresh();
    expect(billing.state).toEqual({ kind: "ready", credits, checkedAt: 123_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual([BALANCE_URL, {
      method: "GET", headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
      redirect: "error", signal: expect.any(AbortSignal),
    }]);
    expect(JSON.stringify(billing.state)).not.toContain("private account");
    expect(JSON.stringify(billing.state)).not.toContain(KEY);
  });

  it.each([
    "https://evil.example", "https://llm.onerouter.pro.evil.example", "http://llm.onerouter.pro",
    "https://llm.onerouter.pro/proxy", "https://user:password@llm.onerouter.pro", "https://llm.onerouter.pro?token=private",
  ])("never sends a key for an unsupported endpoint: %s", async (endpoint) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const billing = client({ fetchImpl });
    billing.configure(endpoint, KEY);
    await billing.refresh(true);
    expect(billing.state).toEqual({ kind: "unsupported" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not request account data without a key", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const billing = client({ fetchImpl });
    billing.configure(ENDPOINT);
    await billing.refresh(true);
    expect(billing.state).toEqual({ kind: "signed-out" });
    billing.configure(ENDPOINT, "   ");
    await billing.refresh();
    expect(billing.state).toEqual({ kind: "signed-out" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("coalesces concurrent requests and reuses a successful balance for sixty seconds", async () => {
    let now = 100_000;
    const pending = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(json({ credit_balance: 20 }));
    const billing = client({ fetchImpl, now: () => now });
    const first = billing.refresh();
    expect(billing.refresh()).toBe(first);
    expect(billing.refresh(true)).toBe(first);
    expect(billing.state).toEqual({ kind: "loading" });
    pending.resolve(json({ credit_balance: 10 }));
    await first;
    now += 59_999;
    await billing.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now++;
    await billing.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(billing.state).toEqual({ kind: "ready", credits: 20, checkedAt: now });
  });

  it("forces a fresh request after its five-second cooldown, then retains the previous balance on failure", async () => {
    let now = 100_000;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ credit_balance: 10 }))
      .mockRejectedValueOnce(new Error(`network failure for ${KEY}`))
      .mockResolvedValueOnce(json({ credit_balance: 8 }));
    const billing = client({ fetchImpl, now: () => now });
    await billing.refresh();
    now += 4_999;
    await billing.refresh(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now++;
    const forced = billing.refresh(true);
    expect(billing.state).toEqual({ kind: "loading", previous: { credits: 10, checkedAt: 100_000 } });
    await forced;
    expect(billing.state).toEqual({
      kind: "error", message: "Could not reach the balance service.", previous: { credits: 10, checkedAt: 100_000 },
    });
    expect(JSON.stringify(billing.state)).not.toContain(KEY);
    await billing.refresh(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now += 5_000;
    await billing.refresh(true);
    expect(billing.state).toEqual({ kind: "ready", credits: 8, checkedAt: now });
  });

  it("reports a safe HTTP status without exposing the service response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ error: KEY, account_name: "private person" }, { status: 401 }));
    const billing = client({ fetchImpl });
    await expect(billing.refresh()).resolves.toBeUndefined();
    expect(billing.state).toEqual({ kind: "error", message: "Balance service returned HTTP 401." });
  });

  it.each([
    "not JSON", "null", "[]", "{}", '{"credit_balance":"15"}', '{"credit_balance":null}', '{"credit_balance":1e400}',
  ])("rejects malformed balances without echoing response content: %s", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const billing = client({ fetchImpl });
    await billing.refresh();
    expect(billing.state).toEqual({ kind: "error", message: "Balance service returned an invalid response." });
  });

  it.each([false, true])("bounds streamed response bytes even when the declared length is missing (%s)", async (declared) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)); },
      cancel,
    });
    const response = new Response(stream, declared ? { headers: { "content-length": "16385" } } : {});
    const billing = client({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    await billing.refresh();
    expect(billing.state).toEqual({ kind: "error", message: "Balance service returned an invalid response." });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects and never follows the supplied destination", async () => {
    const response = new Response(null, { status: 302, headers: { location: "https://evil.example" } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const billing = client({ fetchImpl });
    await billing.refresh();
    expect(billing.state).toEqual({ kind: "error", message: "Balance service returned HTTP 302." });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe("error");
  });

  it("times out even when the fetch implementation ignores abort", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const billing = client({ fetchImpl });
    const request = billing.refresh();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(request).resolves.toBeUndefined();
    expect(billing.state).toEqual({ kind: "error", message: "Balance request timed out." });
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("times out a stalled response body and cancels its stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const billing = client({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    const request = billing.refresh();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(request).resolves.toBeUndefined();
    expect(billing.state).toEqual({ kind: "error", message: "Balance request timed out." });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("clears the previous account immediately and ignores a late response after logout", async () => {
    let now = 100_000;
    const pending = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ credit_balance: 99 }))
      .mockImplementationOnce(() => pending.promise);
    const billing = client({ fetchImpl, now: () => now });
    await billing.refresh();
    now += 5_000;
    const previousRequest = billing.refresh(true);
    await Promise.resolve();
    billing.configure(ENDPOINT);
    expect(billing.state).toEqual({ kind: "signed-out" });
    expect(fetchImpl.mock.calls[1]![1]?.signal?.aborted).toBe(true);
    pending.resolve(json({ credit_balance: 88 }));
    await previousRequest;
    expect(billing.state).toEqual({ kind: "signed-out" });
    await billing.refresh(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("isolates generations when the key changes while a request is in flight", async () => {
    const oldResponse = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce(json({ credit_balance: 5 }));
    const billing = client({ fetchImpl, now: () => 100_000 });
    const oldRequest = billing.refresh();
    await Promise.resolve();
    billing.configure(ENDPOINT, "fixture-new-account-key");
    expect(billing.state).toEqual({ kind: "idle" });
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await billing.refresh();
    expect(billing.state).toEqual({ kind: "ready", credits: 5, checkedAt: 100_000 });
    oldResponse.resolve(json({ credit_balance: 999 }));
    await oldRequest;
    expect(billing.state).toEqual({ kind: "ready", credits: 5, checkedAt: 100_000 });
    expect(fetchImpl.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: "Bearer fixture-new-account-key" });
  });

  it("aborts on close, ignores late results, and does not issue more requests", async () => {
    const pending = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => pending.promise);
    const billing = client({ fetchImpl });
    const request = billing.refresh();
    await Promise.resolve();
    billing.close();
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    pending.resolve(json({ credit_balance: 100 }));
    await request;
    billing.configure(ENDPOINT, KEY);
    await billing.refresh(true);
    expect(billing.state).toEqual({ kind: "unsupported" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("notifies every visible transition and tolerates a throwing renderer", async () => {
    const states: BalanceState["kind"][] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ credit_balance: 0 }));
    const billing = new InfronBilling({ fetchImpl, onChange: () => { states.push(billing.state.kind); throw new Error("renderer failed"); } });
    clients.push(billing);
    billing.configure(ENDPOINT, KEY);
    await expect(billing.refresh()).resolves.toBeUndefined();
    billing.configure(ENDPOINT);
    expect(states).toEqual(["idle", "loading", "ready", "signed-out"]);
  });
});
