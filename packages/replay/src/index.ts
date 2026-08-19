/**
 * Record, replay, and deliberately break the model.
 *
 * The whole harness has to be exercised without Motif-3 on hand, and the
 * behaviours worth exercising are the ones that only show up when the model
 * misbehaves. So rather than waiting for a GPU to observe malformed JSON, we
 * inject it: every failure the vendor documents becomes a fault the loop is
 * tested against, deterministically, in milliseconds.
 *
 * Once there is a real endpoint, `RecordingTransport` captures live sessions
 * into the same format, and those recordings join the fixtures.
 */

import type { CompletionRequest, CompletionResponse, Transport } from "@motifcode/core";

export interface Exchange {
  request: {
    messageCount: number;
    lastRole?: string;
    toolNames: string[];
    raw?: boolean;
  };
  response: CompletionResponse;
}

/* ------------------------------------------------------------------ */

/** Returns canned bodies in order. The simplest thing that exercises the loop. */
export class ScriptedTransport implements Transport {
  readonly endpoint = "scripted://";
  readonly model = "motif-3-scripted";
  private index = 0;
  readonly seen: CompletionRequest[] = [];

  constructor(
    private readonly bodies: (string | CompletionResponse | Error)[],
    private readonly loopLast = false,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(req);
    const i = this.loopLast ? Math.min(this.index, this.bodies.length - 1) : this.index;
    this.index++;
    const body = this.bodies[i];
    if (body === undefined) throw new Error(`ScriptedTransport exhausted after ${i} calls`);
    if (body instanceof Error) throw body;
    if (typeof body === "string") {
      return { content: body, rawText: body, ms: 1, usage: { completionTokens: body.length } };
    }
    return body;
  }
}

/* ------------------------------------------------------------------ */

export type FaultKind =
  /** Invalid JSON escapes, as produced by shell and regex arguments. */
  | "bad_escape"
  /** An opening `<tool_call>` whose closer never arrives — a length cap. */
  | "truncate"
  /** Structurally broken JSON that no rung can recover. */
  | "corrupt"
  /** Reasoning left unclosed, so the answer never separates from the thinking. */
  | "unclosed_think"
  /** An empty body — the server returned nothing useful. */
  | "empty";

export interface FaultPlan {
  /** Turn numbers, 1-based, at which to inject. */
  at: number[];
  kind: FaultKind;
}

/**
 * Wraps a transport and damages its output on chosen turns.
 *
 * Each fault mirrors something real: `bad_escape` is the failure the vendor's
 * parser comments call out by name, `truncate` is the length-capped block that
 * only the non-streaming path can recover, and `empty` is the shape a dropped
 * turn takes when the stock parser gives up.
 */
export class FaultTransport implements Transport {
  readonly endpoint: string;
  readonly model: string;
  private turn = 0;

  constructor(
    private readonly inner: Transport,
    private readonly plans: FaultPlan[],
  ) {
    this.endpoint = inner.endpoint;
    this.model = inner.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.turn++;
    const res = await this.inner.complete(req);
    const plan = this.plans.find((p) => p.at.includes(this.turn));
    if (!plan) return res;
    const damaged = damage(res.rawText, plan.kind);
    return { ...res, content: damaged, rawText: damaged, reasoningContent: undefined };
  }
}

export function damage(text: string, kind: FaultKind): string {
  switch (kind) {
    case "bad_escape":
      // `\$` and `\s` are not JSON escapes; this is exactly what the model does
      // when a command carries a shell variable or a regex.
      return text.replace(/"command":\s*"([^"]*)"/, (_m, cmd: string) => `"command": "${cmd} \\$HOME \\s+"`);
    case "truncate": {
      const i = text.indexOf("<tool_call>");
      if (i === -1) return text.slice(0, Math.max(1, Math.floor(text.length / 2)));
      return text.slice(0, i + Math.floor((text.length - i) * 0.6));
    }
    case "corrupt":
      return text.replace("<tool_call>", "<tool_call>{{{ ??? ");
    case "unclosed_think":
      return `thinking about it${text.replace("</think>", "")}`;
    case "empty":
      return "";
    default:
      return text;
  }
}

/* ------------------------------------------------------------------ */

/** Wraps a live transport and captures every exchange. */
export class RecordingTransport implements Transport {
  readonly endpoint: string;
  readonly model: string;
  readonly exchanges: Exchange[] = [];

  constructor(private readonly inner: Transport) {
    this.endpoint = inner.endpoint;
    this.model = inner.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.inner.complete(req);
    this.exchanges.push({
      request: {
        messageCount: req.messages.length,
        lastRole: req.messages[req.messages.length - 1]?.role,
        toolNames: req.tools.map((t) => ("function" in t && t.function ? t.function.name : "")),
        raw: req.raw,
      },
      response,
    });
    return response;
  }

  toJSONL(): string {
    return this.exchanges.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
}

/** Replays a recording. Diverging turn counts are an error, not a warning. */
export class ReplayTransport implements Transport {
  readonly endpoint: string;
  readonly model: string;
  private index = 0;

  constructor(
    private readonly exchanges: Exchange[],
    opts: { endpoint?: string; model?: string } = {},
  ) {
    this.endpoint = opts.endpoint ?? "replay://";
    this.model = opts.model ?? "motif-3-replay";
  }

  static fromJSONL(text: string): ReplayTransport {
    const exchanges = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Exchange);
    return new ReplayTransport(exchanges);
  }

  async complete(): Promise<CompletionResponse> {
    const e = this.exchanges[this.index++];
    if (!e) {
      throw new Error(
        `replay exhausted after ${this.index - 1} turns — the loop asked for more than the recording holds`,
      );
    }
    return e.response;
  }
}

/* ------------------------------------------------------------------ */

/** Build a well-formed native tool-call body, for scripting happy paths. */
export function toolCallBody(
  name: string,
  args: Record<string, unknown>,
  opts: { reasoning?: string; prose?: string } = {},
): string {
  const head = opts.reasoning ? `${opts.reasoning}</think>` : "</think>";
  const prose = opts.prose ? `${opts.prose}\n` : "";
  return `${head}${prose}<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}

export function doneBody(summary: string, opts: { confirm?: boolean } = {}): string {
  return toolCallBody("done", opts.confirm ? { summary, confirm: true } : { summary });
}
