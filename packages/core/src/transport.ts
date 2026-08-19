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

import { SAMPLING_DEFAULTS, type Message, type Tool } from "@motifcode/protocol";

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

interface ChatChoice {
  message?: { content?: string | null; reasoning_content?: string | null };
  text?: string;
  finish_reason?: string;
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
      body["messages"] = req.messages;
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
      throw new TransportError(`${res.status} ${res.statusText}`, res.status, text);
    }
    const json = (await res.json()) as { choices?: ChatChoice[]; usage?: Record<string, number> };
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? choice?.text ?? "";
    return {
      content,
      reasoningContent: choice?.message?.reasoning_content ?? undefined,
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
