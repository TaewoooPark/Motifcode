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
 * A single local GPU serving a 187 GB checkpoint dies mid-session as a matter
 * of course, and the difference between "connection refused" and "400 bad
 * request" is the difference between waiting and stopping.
 */

import {
  pyJson,
  toolCallParts,
  type CompletionRequest,
  type CompletionResponse,
  type Message,
  type ToolCall,
} from "@motifcode/protocol";

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
  /** The server answered with a non-2xx status. Retryable only for 5xx. */
  | "http"
  /** A 2xx whose body was not a completion. Not retryable without a change. */
  | "protocol"
  /** The caller's signal fired. Never retried. */
  | "aborted";

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly status?: number;
  readonly body?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      kind: TransportErrorKind;
      status?: number;
      body?: string;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "TransportError";
    this.kind = opts.kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.body !== undefined) this.body = opts.body;
    this.retryable = opts.retryable ?? defaultRetryable(opts.kind, opts.status);
  }
}

function defaultRetryable(kind: TransportErrorKind, status?: number): boolean {
  switch (kind) {
    case "network":
    case "timeout":
      return true;
    case "http":
      // 5xx is the engine falling over. 4xx is the request being wrong, and
      // resending it unchanged will be wrong again. 429 needs a Retry-After
      // policy that does not exist yet, so it is not retried silently.
      return status !== undefined && status >= 500;
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
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
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
      throw new TransportError(
        detail ? `${res.status} ${res.statusText} — ${detail}` : `${res.status} ${res.statusText}`,
        { kind: "http", status: res.status, body: text },
      );
    }

    let json: { choices?: ChatChoice[]; usage?: Record<string, number> };
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
    return {
      content,
      ...(reasoning !== undefined && reasoning !== null ? { reasoningContent: reasoning } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      rawText: content,
      finishReason: choice.finish_reason,
      usage: {
        promptTokens: json.usage?.["prompt_tokens"],
        completionTokens: json.usage?.["completion_tokens"],
      },
      ms: Date.now() - started,
    };
  }
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
