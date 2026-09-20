/**
 * Talking to the model server.
 *
 * Two shapes, and the channel picks between them:
 *
 *   `chat`  — `/v1/chat/completions`. The server applies the chat template and
 *             runs the fork's tool and reasoning parsers. The default, because
 *             the fork's repair ladder is better placed than ours: it sees the
 *             raw token stream.
 *
 *   `raw`   — `/v1/completions`. The harness owns templating. Used by the
 *             `object` and `raw` channels, whose transcripts are not native
 *             tool calls and would be mistranslated by a server that assumed
 *             they were.
 *
 * The tool path runs **non-streaming** on purpose. A `<tool_call>` whose closer
 * never arrives — a length-capped response — can be reasoned about when you
 * have the whole body and cannot be mid-stream, because the repairs are not
 * append-only and streaming a fragment early would contradict the repaired
 * result. Streaming is for the reasoning display, not for actions.
 *
 * Failure is a first-class shape here rather than an exception that escapes.
 * A hosted endpoint rate-limits, a gateway times out, a local engine falls
 * over — and the difference between "connection refused", "429 slow down" and
 * "400 bad request" is the difference between waiting, waiting longer, and
 * stopping.
 */

import {
  pyJson,
  toolCallParts,
  type CompletionRequest,
  type CompletionResponse,
  type Message,
  type ToolCall,
} from "@motifcode/protocol";
import { normalizeEndpoint } from "./config.js";

export type { CompletionRequest, CompletionResponse };

export interface Transport {
  readonly endpoint: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export interface HttpTransportOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Abandon a request that has produced nothing for this long. */
  requestTimeoutMs?: number;
}

/* ------------------------------------------------------------------ */

/**
 * Why a request failed, in the only terms the loop can act on.
 *
 * The old error had a `status` and inferred everything else, which meant a
 * `TypeError: fetch failed` — the shape a refused connection actually takes in
 * Node — never became a `TransportError` at all. It escaped as a plain
 * exception, skipped the retry path entirely, and ended the session. The most
 * common failure on the target hardware was the one failure the retry logic
 * could not see.
 */
export type TransportErrorKind =
  /** Socket-level: refused, reset, DNS, no route. Retryable. */
  | "network"
  /** No response within the request deadline. Retryable. */
  | "timeout"
  /** The server answered with a non-2xx status. Retryable for 5xx and 429. */
  | "http"
  /** A 2xx whose body was not a completion. Not retryable without a change. */
  | "protocol"
  /** The caller's signal fired. Never retried. */
  | "aborted";

export class TransportError extends Error {
  /**
   * Recognise a transport error without `instanceof`.
   *
   * Two copies of this module — a workspace package resolved twice, a bundled
   * build alongside a source one — give two distinct classes, and `instanceof`
   * quietly answers false for the other one's errors. The failure that produces
   * is the worst kind: a retryable server death reported as a protocol bug and
   * the session ended.
   */
  static is(err: unknown): err is TransportError {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as { name?: string }).name === "TransportError" &&
      typeof (err as { kind?: unknown }).kind === "string"
    );
  }

  readonly kind: TransportErrorKind;
  readonly status?: number;
  readonly body?: string;
  readonly retryable: boolean;
  /**
   * How long the server asked us to wait before trying again.
   *
   * Set from `Retry-After` on a 429, and defaulted when the header is absent,
   * because a rate limit retried on the ordinary sub-second backoff is a rate
   * limit hit three more times. The loop waits at least this long.
   */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: {
      kind: TransportErrorKind;
      status?: number;
      body?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "TransportError";
    this.kind = opts.kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.body !== undefined) this.body = opts.body;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable ?? defaultRetryable(opts.kind, opts.status);
  }
}

function defaultRetryable(kind: TransportErrorKind, status?: number): boolean {
  switch (kind) {
    case "network":
    case "timeout":
      return true;
    case "http":
      // 5xx is the engine or the gateway falling over. 429 is the endpoint
      // asking for time, and it says how much. Any other 4xx is the request
      // being wrong — a rejected key, an unknown field — and resending it
      // unchanged will be wrong again.
      return status !== undefined && (status >= 500 || status === 429);
    case "protocol":
    case "aborted":
      return false;
  }
}

/** Recognise the shapes Node uses for a socket that never connected. */
function isNetworkFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (e.name === "TypeError") return true;
  const code = e.code ?? (e.cause as { code?: string } | undefined)?.code;
  if (typeof code === "string") {
    return /^(ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR)/.test(code);
  }
  return /fetch failed|socket hang up|network/i.test(e.message ?? "");
}

/** Longest a `Retry-After` is honoured for; past this, something else is wrong. */
const MAX_RETRY_AFTER_MS = 120_000;
/** What a 429 without a `Retry-After` is worth waiting. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/**
 * `Retry-After`, in milliseconds.
 *
 * Either a delay in seconds or an HTTP date; both are in the standard and both
 * are seen in practice. A value that does not parse is treated as absent
 * rather than as zero — zero would mean "retry immediately", which is the one
 * reading a rate limit never intends.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (header === null || header === undefined) return undefined;
  const text = header.trim();
  if (text === "") return undefined;
  if (/^\d+$/.test(text)) return Math.min(MAX_RETRY_AFTER_MS, Number(text) * 1000);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
}

function isAbort(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    ((err as { name?: string }).name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR")
  );
}

/* ------------------------------------------------------------------ */

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

interface ChatChoice {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: WireToolCall[] | null;
  };
  text?: string;
  finish_reason?: string;
}

/**
 * Convert history to the OpenAI wire shape.
 *
 * `tool_calls[].function.arguments` is a **string** on the wire, and servers
 * enforce it — Ollama rejects an object outright, and vLLM's schema expects the
 * same. Sending an object fails the request on the turn *after* the first tool
 * call, which is late enough to look like a model problem rather than ours.
 *
 * Encoding here rather than in the session also buys byte control. The Motif
 * template inserts a string argument verbatim, so what we serialise is exactly
 * what lands in the prompt — no dependence on the server's JSON separators.
 * `pyJson` is used so this path and our own template renderer agree byte for
 * byte.
 */
function toWireMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.tool_calls || m.tool_calls.length === 0) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc, i) => {
        const { name, args } = toolCallParts(tc);
        return {
          id: tc.id ?? `call_${i}`,
          type: "function" as const,
          function: {
            name,
            arguments: typeof args === "string" ? args : pyJson(args ?? {}),
          },
        };
      }),
    };
  });
}

/** Normalise the several shapes servers use for an extracted tool call. */
function normaliseToolCalls(raw: WireToolCall[] | null | undefined): ToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: ToolCall[] = [];
  for (const tc of raw) {
    const name = tc.function?.name;
    if (!name) continue;
    const args = tc.function?.arguments;
    out.push({
      ...(tc.id !== undefined ? { id: tc.id } : {}),
      type: "function",
      // Arguments arrive as a JSON string from most servers and as an object
      // from a few. Keep whichever came; the parser downstream handles both,
      // and re-encoding an object would change key order for no reason.
      function: { name, ...(args !== undefined ? { arguments: args } : {}) },
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Build the exact JSON body a request becomes. Shared with the recorder. */
export function requestBody(req: CompletionRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    // Motif's own evaluations run here. Near-greedy settings, which most coding
    // harnesses default to, are not this model's published regime.
    temperature: req.temperature ?? 1.0,
    top_p: req.topP ?? 0.95,
    stream: false,
  };
  if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;
  if (req.seed !== undefined) body["seed"] = req.seed;
  if (req.stop) body["stop"] = req.stop;

  if (req.raw) {
    if (req.prompt === undefined) throw new Error("raw completion requires a prompt");
    body["prompt"] = req.prompt;
  } else {
    body["messages"] = toWireMessages(req.messages);
    // Registered even on channels that never call them: the chat template drops
    // intermediate reasoning when this array is empty.
    body["tools"] = req.tools;
  }
  return body;
}

export function requestUrl(req: CompletionRequest, endpoint: string): string {
  return req.raw ? `${endpoint}/v1/completions` : `${endpoint}/v1/chat/completions`;
}

export class HttpTransport implements Transport {
  readonly endpoint: string;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(opts: HttpTransportOptions) {
    this.endpoint = normalizeEndpoint(opts.endpoint);
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30 * 60_000;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now();
    const url = requestUrl(req, this.endpoint);
    const body = requestBody(req, this.model);

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    // The caller's signal and our deadline, combined. A long agentic turn can
    // legitimately take minutes, so the deadline is generous — but unbounded
    // waiting on a wedged engine is how a session stops without ever failing.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.requestTimeoutMs);
    const signals = [req.signal, timeout.signal].filter((s): s is AbortSignal => s !== undefined);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      });
    } catch (err) {
      if (req.signal?.aborted) {
        throw new TransportError("request aborted", { kind: "aborted", cause: err });
      }
      if (timeout.signal.aborted) {
        throw new TransportError(`no response within ${this.requestTimeoutMs}ms`, {
          kind: "timeout",
          cause: err,
        });
      }
      if (isAbort(err)) {
        throw new TransportError("request aborted", { kind: "aborted", cause: err });
      }
      if (isNetworkFailure(err)) {
        // The common case on a local single-GPU server, and the one that used
        // to escape as a bare TypeError.
        throw new TransportError(`cannot reach ${url}: ${describe(err)}`, {
          kind: "network",
          cause: err,
        });
      }
      throw new TransportError(`request to ${url} failed: ${describe(err)}`, {
        kind: "network",
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Include the body. A bare "400 Bad Request" tells nobody anything, and
      // the server almost always says exactly which field it rejected.
      const detail = text.trim().slice(0, 400);
      let message = detail ? `${res.status} ${res.statusText} — ${detail}` : `${res.status} ${res.statusText}`;
      if (res.status === 401 || res.status === 403) {
        // The one failure whose fix is never on the server. Say which side of
        // it the user is on: no key at all, or a key the endpoint refused.
        message += this.apiKey
          ? " (the endpoint rejected the API key that was sent; check MOTIF_API_KEY)"
          : " (no API key was sent; set MOTIF_API_KEY in the environment or in .env)";
      }
      const retryAfterMs =
        res.status === 429
          ? (parseRetryAfter(res.headers.get("retry-after")) ?? DEFAULT_RETRY_AFTER_MS)
          : undefined;
      throw new TransportError(message, {
        kind: "http",
        status: res.status,
        body: text,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    let json: {
      choices?: ChatChoice[];
      usage?: Record<string, unknown> & { prompt_tokens_details?: { cached_tokens?: number } };
    };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      throw new TransportError("server returned a 2xx that was not JSON", {
        kind: "protocol",
        cause: err,
      });
    }
    if (!Array.isArray(json.choices) || json.choices.length === 0) {
      // Reaching into `undefined` here used to produce an empty completion,
      // which the loop reads as a model that said nothing rather than as a
      // server that answered wrongly.
      throw new TransportError("server response has no choices", {
        kind: "protocol",
        body: JSON.stringify(json).slice(0, 400),
      });
    }

    const choice = json.choices[0]!;
    const content = choice.message?.content ?? choice.text ?? "";
    if (typeof content !== "string") {
      throw new TransportError("choice content was not a string", { kind: "protocol" });
    }
    const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning ?? undefined;
    const toolCalls = normaliseToolCalls(choice.message?.tool_calls);
    // The hosted endpoint reports how much of the prompt it served from its
    // prefix cache. That is the first direct measurement this harness has had
    // of the thing its frozen tool order exists to protect, so it is kept.
    const cached = json.usage?.prompt_tokens_details?.cached_tokens;
    return {
      content,
      ...(reasoning !== undefined && reasoning !== null ? { reasoningContent: reasoning } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      rawText: content,
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: numberOr(json.usage?.["prompt_tokens"]),
        completionTokens: numberOr(json.usage?.["completion_tokens"]),
        ...(typeof cached === "number" ? { cachedTokens: cached } : {}),
      },
      ms: Date.now() - started,
    };
  }
}

function numberOr(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

/* ------------------------------------------------------------------ */

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injected for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
}

/**
 * Exponential backoff with full jitter, interruptible by an abort.
 *
 * Jitter matters even for one client: a fixed schedule retried against a server
 * that restarts on a timer will keep landing in the same part of its startup,
 * and each attempt fails for the same reason as the last.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * ceiling);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TransportError("aborted during backoff", { kind: "aborted" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TransportError("aborted during backoff", { kind: "aborted" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Remove Node's own idle timeouts from `fetch`, so this module's deadline is
 * the only one.
 *
 * MEASURED 2026-08-20, Motif-3 served locally at roughly 2 tok/s: an ordinary
 * agent step — one reasoning block and one tool call — takes longer than five
 * minutes, and the session died with
 *
 *     fetch failed (UND_ERR_HEADERS_TIMEOUT)
 *
 * on three consecutive retries, each exactly five minutes apart. Nothing was
 * wrong with the server; it was still generating. Node's HTTP client gives up
 * waiting for response headers after 300 s by default, and the tool path is
 * deliberately non-streaming — see the note at the top of this file — so no
 * headers arrive until the whole completion is done. `requestTimeoutMs` is 30
 * minutes precisely because a long turn is expected, and it never got the
 * chance to apply.
 *
 * That default is a reasonable one for a hosted API answering in seconds. It is
 * the wrong one for a large model on a desk, and a harness that only works
 * against fast endpoints is not a local-first harness.
 *
 * There is no supported API for this: Node bundles undici but does not export
 * it. The global dispatcher is reachable through a well-known symbol, and its
 * constructor takes the options we need. Everything here is feature-detected
 * and failure is silent by design — if a future Node changes the shape, the
 * result is today's behaviour, which is the thing we are already handling.
 *
 * Process-global, so it belongs to whoever owns the process. The CLI calls it
 * at startup; a library embedding `HttpTransport` decides for itself.
 *
 * How close the default cuts it, measured over one polyglot campaign: 348
 * requests completed, median 35.1 s, p99 254.2 s, longest 286.6 s, none above
 * 290 s. Every one of those was a request that finished inside the 300 s
 * window by a margin of seconds, and the two that did not finish inside it
 * ended their rows in `transport_error`. Awaiting the result matters for the
 * same reason: this is a promise now, and firing it without awaiting puts the
 * first request in a race against the swap.
 */
export async function relaxNodeHttpTimeouts(): Promise<boolean> {
  const key = Symbol.for("undici.globalDispatcher.1");
  const holder = globalThis as unknown as Record<symbol, unknown>;
  try {
    if (holder[key] === undefined) {
      // Node exposes `fetch` as a wrapper that loads its bundled undici on the
      // first *call*, not on first access, and it is that module load which
      // installs the global dispatcher. So at startup — before any request has
      // gone out, which is precisely when this function wants to run — the
      // symbol holds nothing. The first version of this function read it,
      // found nothing, returned false and changed the process not at all;
      // silently, because the return value was discarded. The 300 s timeout
      // stayed in force and the failure this function exists to prevent came
      // back and cost two campaign rows. A `data:` URL is a real fetch that
      // opens no socket and resolves no name, so it forces the load for free.
      await fetch("data:text/plain,").catch(() => undefined);
    }
    const current = holder[key] as { constructor?: unknown } | undefined;
    const Ctor = current?.constructor as (new (o: unknown) => unknown) | undefined;
    if (typeof Ctor !== "function") return false;
    // 0 disables the timer in undici. Both matter: headersTimeout covers the
    // wait before the first byte, bodyTimeout the gaps after it.
    holder[key] = new Ctor({ headersTimeout: 0, bodyTimeout: 0 });
    return true;
  } catch {
    return false;
  }
}
