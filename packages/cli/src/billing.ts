/** Opt-in-by-endpoint account balance, using the session's existing Infron key. */
import { isInfronEndpoint } from "@motifcode/core";

export interface BalanceSnapshot {
  credits: number;
  checkedAt: number;
}

export type BalanceState =
  | { kind: "unsupported" }
  | { kind: "signed-out" }
  | { kind: "idle" }
  | { kind: "loading"; previous?: BalanceSnapshot }
  | ({ kind: "ready" } & BalanceSnapshot)
  | { kind: "error"; message: string; previous?: BalanceSnapshot };

export interface InfronBillingOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  onChange?: () => void;
  timeoutMs?: number;
  ttlMs?: number;
  retryDelayMs?: number;
}

const BALANCE_URL = "https://api.onerouter.pro/v1/balance";
const MAX_RESPONSE_BYTES = 16 * 1024;
class BillingFailure extends Error {}

/** Never store or display server error bodies, account names, or credentials. */
export class InfronBilling {
  private current: BalanceState = { kind: "unsupported" };
  private snapshot: BalanceSnapshot | undefined;
  private endpoint = "";
  private apiKey: string | undefined;
  private generation = 0;
  private lastAttempt = -Infinity;
  private closed = false;
  private inFlight: { generation: number; controller: AbortController; promise: Promise<void> } | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: InfronBillingOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.retryDelayMs = opts.retryDelayMs ?? 5_000;
  }

  get state(): BalanceState { return this.current; }

  configure(endpoint: string, apiKey?: string): void {
    if (this.closed || (endpoint === this.endpoint && apiKey === this.apiKey)) return;
    this.generation++;
    this.inFlight?.controller.abort();
    this.inFlight = undefined;
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.snapshot = undefined;
    this.lastAttempt = -Infinity;
    this.update(!isInfronEndpoint(endpoint) ? { kind: "unsupported" }
      : !apiKey?.trim() ? { kind: "signed-out" } : { kind: "idle" });
  }

  /** Coalesced and non-throwing. Forced refresh still has a short request cooldown. */
  refresh(force = false): Promise<void> {
    if (this.closed || !isInfronEndpoint(this.endpoint) || !this.apiKey?.trim()) return Promise.resolve();
    if (this.inFlight) return this.inFlight.promise;
    const now = this.now();
    if (now - this.lastAttempt < this.retryDelayMs || (!force && this.snapshot && now - this.snapshot.checkedAt < this.ttlMs)) return Promise.resolve();
    const generation = this.generation;
    const controller = new AbortController();
    const apiKey = this.apiKey;
    this.lastAttempt = now;
    // Defer work so callbacks cannot start a second request before it is registered.
    const promise = Promise.resolve().then(async () => {
      if (generation !== this.generation || this.closed) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new BillingFailure(timedOut ? "Balance request timed out." : "Balance request was cancelled."));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try {
        timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
        timeout.unref?.();
        const credits = await Promise.race([this.request(apiKey, controller.signal), aborted]);
        if (generation !== this.generation || this.closed) return;
        this.snapshot = { credits, checkedAt: this.now() };
        this.update({ kind: "ready", ...this.snapshot });
      } catch (error) {
        if (generation !== this.generation || this.closed) return;
        const message = timedOut ? "Balance request timed out."
          : error instanceof BillingFailure ? error.message : "Could not reach the balance service.";
        this.update({ kind: "error", message, ...(this.snapshot ? { previous: this.snapshot } : {}) });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        if (this.inFlight?.generation === generation) this.inFlight = undefined;
      }
    });
    this.inFlight = { generation, controller, promise };
    this.update({ kind: "loading", ...(this.snapshot ? { previous: this.snapshot } : {}) });
    return promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.inFlight?.controller.abort();
    this.inFlight = undefined;
    this.apiKey = undefined;
    this.endpoint = "";
    this.snapshot = undefined;
    this.update({ kind: "unsupported" });
  }

  private update(state: BalanceState): void {
    this.current = state;
    // A renderer failure cannot break a task or leave a request unhandled.
    try { this.opts.onChange?.(); } catch { /* Presentation is owned by the caller. */ }
  }

  private async request(apiKey: string, signal: AbortSignal): Promise<number> {
    const response = await this.fetchImpl(BALANCE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new BillingFailure("Balance request was cancelled.");
    }
    if (response.redirected || !response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new BillingFailure(response.redirected ? "Balance service redirected unexpectedly."
        : `Balance service returned HTTP ${response.status}.`);
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > MAX_RESPONSE_BYTES || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new BillingFailure("Balance service returned an invalid response.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const cancel = (): void => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (signal.aborted) throw new BillingFailure("Balance request was cancelled.");
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          cancel();
          throw new BillingFailure("Balance service returned an invalid response.");
        }
        chunks.push(chunk.value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    let parsed: unknown;
    try {
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch { throw new BillingFailure("Balance service returned an invalid response."); }
    const credits = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["credit_balance"] : undefined;
    if (typeof credits !== "number" || !Number.isFinite(credits)) throw new BillingFailure("Balance service returned an invalid response.");
    return credits;
  }
}
