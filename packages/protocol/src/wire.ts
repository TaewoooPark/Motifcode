/**
 * What goes over the wire, and what comes back.
 *
 * These live in `protocol` rather than next to the HTTP client because the
 * action channels decide them. A channel is not a parser with a prompt
 * fragment attached: it picks the endpoint, the body shape, the stop sequences
 * and the way a transcript is written down. Putting the request type here lets
 * a channel own all of that, and lets `core` keep only the part that actually
 * talks to a socket.
 */

import type { Message, Tool, ToolCall } from "./types.js";

export interface CompletionRequest {
  messages: Message[];
  tools: Tool[];
  /**
   * Render the prompt here and post it to `/v1/completions` instead of letting
   * the server apply the chat template. The object and raw channels need this:
   * their transcripts are not native tool calls, and a server templating them
   * as if they were would produce a prompt neither channel describes.
   */
  raw?: boolean;
  /** Prompt text, required when `raw` is set. */
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Deterministic sampling, when the server supports it. Recorded either way. */
  seed?: number;
  stop?: string[];
  signal?: AbortSignal;
  /**
   * Called with each piece of the response as it arrives.
   *
   * Display only. The response is still assembled whole before anything is
   * parsed — a `<tool_call>` cut off by a token cap can only be reasoned
   * about with the whole body in hand — so a transport that streams shows
   * the text early and returns the same `CompletionResponse` it would have
   * without streaming. A transport that cannot stream may ignore this.
   */
  onDelta?: (delta: StreamDelta) => void;
}

/** One piece of a streamed response. */
export interface StreamDelta {
  reasoning?: string;
  content?: string;
  /** The name of a tool call being assembled, when the server sends calls structured. */
  tool?: string;
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
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    /** Prompt tokens the server says it served from its prefix cache, when it says. */
    cachedTokens?: number;
  };
  /** Wall-clock for the request, used for the tok/s readout. */
  ms: number;
}
