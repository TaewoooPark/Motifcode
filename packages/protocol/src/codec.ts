/**
 * Channels as codecs, not as parsers.
 *
 * A channel used to be a prompt fragment plus a `parse()`. That made the name
 * a lie in the only place it mattered: the loop chose a channel, told the model
 * to answer in that channel's format, and then sent the same
 * `/v1/chat/completions` request with native `messages` and `tools` whatever
 * the channel was. The `object` and `raw` channels never reached
 * `/v1/completions`; the locally rendered prompt was computed, used for a
 * cache-hit statistic, and thrown away.
 *
 * The consequence ran deeper than a wasted branch. Whatever the model wrote —
 * a JSON object, an XML block — was parsed into actions and then written back
 * into history as native `assistant.tool_calls` plus `role: "tool"` results.
 * From turn two onward the model was reading a transcript in a format it had
 * been told not to use, which is off-distribution in exactly the way the object
 * and raw channels exist to avoid.
 *
 * So a codec owns the whole round trip: the system fragment that describes the
 * format, the request that carries it, the parse, and — the part that was
 * missing — how the model's own words and the terminal's replies are written
 * down for the next turn.
 *
 * | channel  | endpoint                | assistant turn            | observation        |
 * |----------|-------------------------|---------------------------|--------------------|
 * | toolcall | `/v1/chat/completions`  | native content/tool_calls | `role: "tool"`     |
 * | object   | `/v1/completions`       | the model's JSON verbatim | user turn          |
 * | raw      | `/v1/completions`       | the model's XML verbatim  | user turn          |
 *
 * Tools are registered in the request on every channel, including the two that
 * never make a native call. That is not redundant: the chat template drops the
 * reasoning of intermediate assistant turns when `tools` is empty, and this
 * model's generation prompt always opens `<think>`.
 */

import { getChannel, type Action, type ChannelId, type ChannelParse } from "./channel.js";
import { renderPrompt } from "./template.js";
import { SAMPLING_DEFAULTS, TURN_END } from "./tokens.js";
import type { RepairContext } from "./toolcall.js";
import type { Message, Tool } from "./types.js";
import type { CompletionRequest, CompletionResponse } from "./wire.js";

/** What a codec needs from the session: the transcript, and how it renders. */
export interface SessionView {
  readonly messages: readonly Message[];
  /**
   * The prompt as the frozen template renders it.
   *
   * On the raw endpoint this is the request body, byte for byte — the same
   * string the prefix statistic is computed from, so the two cannot disagree.
   */
  render(): string;
}

/**
 * A call the loop is about to run, or has refused, with the id its result
 * will carry.
 *
 * Needed by the native channel and ignored by the body channels. On the
 * native channel the transcript is the OpenAI shape, and a server that runs a
 * tool-call parser lifts the calls out of the body — so the body alone no
 * longer says what the model did. Writing the assistant turn back without its
 * `tool_calls` produced, from turn two, a history in which every tool result
 * answered a call that was not there: the template rendered an empty
 * assistant turn followed by a `<tool_response>`. The model never saw its own
 * actions.
 */
export interface SerializedCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A tool call and its result, for the codec to write down. */
export interface Observation {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  ok: boolean;
}

export interface RequestOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  signal?: AbortSignal;
}

export interface ChannelCodec {
  readonly id: ChannelId;
  /** Format instructions appended to the system prompt. Cached-prefix pure. */
  systemFragment(tools: Tool[]): string;
  buildRequest(session: SessionView, tools: Tool[], opts: RequestOptions): CompletionRequest;
  parse(response: CompletionResponse, ctx: RepairContext): ChannelParse;
  /**
   * How the model's turn is written into history.
   *
   * `body` is the model's text exactly as it arrived. Codecs that do not use
   * native function calling keep it verbatim: a parser-normalised
   * reconstruction is not what the model wrote, and the difference is visible
   * to the model on the next turn.
   *
   * `calls` are the actions of this turn with the ids their results will
   * carry. The native channel writes them as `tool_calls`; the body channels
   * already have them in `body` and ignore the argument.
   */
  serializeAssistant(
    body: string,
    reasoning: string | undefined,
    parsed: ChannelParse,
    calls?: readonly SerializedCall[],
  ): Message[];
  /** How a tool result is written into history. */
  serializeObservation(obs: Observation): Message[];
  /** How a harness-authored prompt (repair, confirmation challenge) is written. */
  serializeHarnessTurn(text: string): Message[];
}

/* ------------------------------------------------------------------ */

function sampling(opts: RequestOptions): Pick<CompletionRequest, "temperature" | "topP" | "seed"> {
  return {
    temperature: opts.temperature ?? SAMPLING_DEFAULTS.temperature,
    topP: opts.topP ?? SAMPLING_DEFAULTS.top_p,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  };
}

class ToolCallCodec implements ChannelCodec {
  readonly id = "toolcall" as const;

  systemFragment(tools: Tool[]): string {
    return getChannel("toolcall").promptFragment(tools);
  }

  buildRequest(session: SessionView, tools: Tool[], opts: RequestOptions): CompletionRequest {
    return {
      messages: [...session.messages],
      tools,
      ...sampling(opts),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
  }

  parse(response: CompletionResponse, ctx: RepairContext): ChannelParse {
    return getChannel("toolcall").parse(response.content, ctx, response.toolCalls);
  }

  serializeAssistant(
    body: string,
    reasoning: string | undefined,
    parsed: ChannelParse,
    calls?: readonly SerializedCall[],
  ): Message[] {
    const hasCalls = calls !== undefined && calls.length > 0;
    // With calls, the content is the prose around them: the calls themselves
    // are rendered by the template from `tool_calls`, and leaving the raw
    // `<tool_call>` text in the content as well would show the model each
    // action twice. Without calls the turn produced nothing usable, and the
    // body — broken syntax included — is exactly what the model needs to see.
    const msg: Message = { role: "assistant", content: hasCalls ? parsed.content : parsed.content || body };
    if (reasoning) msg.reasoning_content = reasoning;
    if (hasCalls) {
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    return [msg];
  }

  serializeObservation(obs: Observation): Message[] {
    return [{ role: "tool", tool_call_id: obs.callId, content: obs.output }];
  }

  serializeHarnessTurn(text: string): Message[] {
    return [{ role: "user", content: text }];
  }
}

/* ------------------------------------------------------------------ */

/**
 * Shared by the two body-parsing channels.
 *
 * Both drive `/v1/completions` with a prompt this package rendered, both keep
 * the model's body verbatim in history, and both report terminal output as a
 * user turn — because in Terminus, which is where these formats come from, the
 * terminal *is* the user. Only the format instructions and the observation
 * wrapper differ.
 */
abstract class BodyCodec implements ChannelCodec {
  abstract readonly id: ChannelId;
  protected abstract observationText(obs: Observation): string;

  systemFragment(tools: Tool[]): string {
    return getChannel(this.id).promptFragment(tools);
  }

  buildRequest(session: SessionView, tools: Tool[], opts: RequestOptions): CompletionRequest {
    const prompt = session.render();
    return {
      messages: [...session.messages],
      // Registered even though this channel never makes a native call: with an
      // empty tools array the template silently drops the reasoning of every
      // intermediate assistant turn.
      tools,
      raw: true,
      prompt,
      // The template ends a turn with this token, and on the completions
      // endpoint nothing else will stop the model from writing the next one.
      stop: [TURN_END],
      ...sampling(opts),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
  }

  parse(response: CompletionResponse, ctx: RepairContext): ChannelParse {
    return getChannel(this.id).parse(response.content, ctx, response.toolCalls);
  }

  serializeAssistant(body: string, reasoning: string | undefined): Message[] {
    // Verbatim. The parsed actions are a reading of this text, not a
    // replacement for it, and the next prompt has to show the model what it
    // actually wrote.
    const msg: Message = { role: "assistant", content: body };
    if (reasoning) msg.reasoning_content = reasoning;
    return [msg];
  }

  serializeObservation(obs: Observation): Message[] {
    return [{ role: "user", content: this.observationText(obs) }];
  }

  serializeHarnessTurn(text: string): Message[] {
    return [{ role: "user", content: text }];
  }
}

class ObjectCodec extends BodyCodec {
  readonly id = "object" as const;

  protected observationText(obs: Observation): string {
    // A fenced block rather than JSON: terminal output is not JSON-safe, and
    // wrapping it in a string would re-introduce the escaping this channel
    // exists to avoid.
    return ["Terminal output:", "", "```", obs.output, "```"].join("\n");
  }
}

class RawCodec extends BodyCodec {
  readonly id = "raw" as const;

  protected observationText(obs: Observation): string {
    return `<terminal>\n${obs.output}\n</terminal>`;
  }
}

const CODECS: Record<ChannelId, ChannelCodec> = {
  toolcall: new ToolCallCodec(),
  object: new ObjectCodec(),
  raw: new RawCodec(),
};

export function getCodec(id: ChannelId): ChannelCodec {
  return CODECS[id];
}

/**
 * Render a transcript the way a channel would send it.
 *
 * Exposed for the replay comparison and for goldens: two runs that agree here
 * agree on the exact bytes the model reads.
 */
export function renderFor(
  id: ChannelId,
  messages: readonly Message[],
  tools: Tool[],
): string {
  void id;
  return renderPrompt({ messages: [...messages], tools, addGenerationPrompt: true });
}

export type { Action, ChannelParse };
