/**
 * Talking to the model server.
 *
 * Two shapes, deliberately:
 *
 *   `chat`  — `/v1/chat/completions`. The server applies the chat template and
 *             runs the fork's tool and reasoning parsers. This is the default,
 *             because the fork's repair ladder is better placed than ours: it
 *             sees the raw token stream.
 *
 *   `raw`   — `/v1/completions`. The harness owns templating. Needed by the
 *             `object` and `raw` channels, and by anything that wants exact
 *             control of the prompt prefix.
 *
 * The tool path runs **non-streaming** on purpose. A `<tool_call>` whose closer
 * never arrives — a length-capped response — is recoverable when you have the
 * whole body and is not recoverable mid-stream, because the repairs are not
 * append-only and streaming a fragment early would contradict the repaired
 * result. Streaming is for the reasoning display, not for actions.
 */

import {
  SAMPLING_DEFAULTS,
  pyJson,
  toolCallParts,
  type Message,
  type Tool,
  type ToolCall,
} from "@motifcode/protocol";

export interface CompletionRequest {
  messages: Message[];
  tools: Tool[];
  /** Renders the prompt ourselves and hits `/v1/completions`. */
  raw?: boolean;
  /** Prompt text, required when `raw` is set. */
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  signal?: AbortSignal;
}

export interface CompletionResponse {
  /** Assistant text with reasoning already separated, when the server did it. */
  content: string;
  reasoningContent?: string;
  /**
   * Tool calls the server already extracted.
   *
   * This is the normal case for any server running a tool-call parser —
   * including a correctly configured Motif fork, where `--tool-call-parser
   * motif` lifts the calls out and leaves only the surrounding prose in
   * `content`. Ignoring this field means the harness sees an empty turn and
   * reports a failure that never happened, on its own target.
   *
   * When present these are authoritative: they have already been through the
   * server's repair ladder, which sees the raw token stream and ours does not.
   */
  toolCalls?: ToolCall[];
  /** Raw body, kept so the client-side repair ladder can re-examine it. */
  rawText: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Wall-clock for the request, used for the tok/s readout. */
  ms: number;
}

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
}

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

export class HttpTransport implements Transport {
  readonly endpoint: string;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpTransportOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const started = Date.now();
    const url = req.raw
      ? `${this.endpoint}/v1/completions`
      : `${this.endpoint}/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.model,
      // Motif's own evaluations run here. Near-greedy settings, which most
      // coding harnesses default to, are not this model's published regime.
      temperature: req.temperature ?? SAMPLING_DEFAULTS.temperature,
      top_p: req.topP ?? SAMPLING_DEFAULTS.top_p,
      stream: false,
    };
    if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;
    if (req.stop) body["stop"] = req.stop;

    if (req.raw) {
      if (req.prompt === undefined) throw new Error("raw completion requires a prompt");
      body["prompt"] = req.prompt;
    } else {
      body["messages"] = toWireMessages(req.messages);
      // Registered even on channels that never call them: the chat template
      // drops intermediate reasoning when this array is empty.
      body["tools"] = req.tools;
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Include the body in the message. A bare "400 Bad Request" tells nobody
      // anything, and the server almost always says exactly which field it
      // rejected.
      const detail = text.trim().slice(0, 400);
      throw new TransportError(
        detail ? `${res.status} ${res.statusText} — ${detail}` : `${res.status} ${res.statusText}`,
        res.status,
        text,
      );
    }
    const json = (await res.json()) as { choices?: ChatChoice[]; usage?: Record<string, number> };
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? choice?.text ?? "";
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? undefined;
    const toolCalls = normaliseToolCalls(choice?.message?.tool_calls);
    return {
      content,
      ...(reasoning !== undefined && reasoning !== null ? { reasoningContent: reasoning } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      rawText: content,
      finishReason: choice?.finish_reason,
      usage: {
        promptTokens: json.usage?.["prompt_tokens"],
        completionTokens: json.usage?.["completion_tokens"],
      },
      ms: Date.now() - started,
    };
  }
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "TransportError";
  }

  /**
   * A local single-GPU server dying mid-session is an expected event, not an
   * edge case: vLLM on GB10 has open reports of fatal EngineCore errors. The
   * loop treats these as resumable rather than terminal.
   */
  get isServerDeath(): boolean {
    if (this.status === undefined) return true; // connection refused / reset
    return this.status >= 500;
  }
}
