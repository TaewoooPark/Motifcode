/**
 * Record, replay, and deliberately break the model.
 *
 * The whole harness has to be exercised without Motif-3 on hand, and the
 * behaviours worth exercising are the ones that only show up when the model
 * misbehaves. So rather than waiting for a GPU to observe malformed JSON, we
 * inject it: every failure the vendor documents becomes a fault the loop is
 * tested against, deterministically, in milliseconds.
 *
 * Replay used to be a recording of *answers*. It stored a message count, the
 * last role and the tool names, then returned the next canned response no
 * matter what was asked. So the prompt could change, the task could change, the
 * sampling could change, the endpoint could change, and replay still passed —
 * and a run that consumed fewer exchanges than were recorded passed too. Tool
 * results were not recorded at all, so a "deterministic" replay silently
 * depended on the state of the filesystem.
 *
 * A replay that cannot fail proves nothing. This one compares the full request
 * against the recording, hash first and then field by field to say where they
 * diverged, replays tool results as well as model responses, and refuses to
 * finish with anything unconsumed.
 */

import {
  canonicalJson,
  requestDigest,
  type CompletionRequest,
  type CompletionResponse,
} from "@motifcode/protocol";
import { TransportError, type Executor, type ToolResult, type Transport, type ToolInvocation } from "@motifcode/core";
import { callDigest } from "@motifcode/protocol";

export const REPLAY_VERSION = 2;

export interface ReplayHeaderV2 {
  schemaVersion: 2;
  runId: string;
  harnessGitSha?: string;
  model: string;
  endpoint: string;
  toolSchemaHash: string;
  systemPromptHash: string;
}

/** A request as recorded, minus the parts that are handles rather than content. */
export interface RecordedRequest {
  messages: CompletionRequest["messages"];
  tools: CompletionRequest["tools"];
  raw?: boolean;
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  stop?: string[];
}

export interface RecordedError {
  name: string;
  message: string;
  kind?: string;
  status?: number;
  body?: string;
}

/** Fields whose value differs between two identical runs, and must not be compared. */
const NONDETERMINISTIC = new Set(["ms", "requestMs", "durationMs"]);

/**
 * Strip wall-clock timings out of an event stream.
 *
 * Kept in the recording — how long a turn took is worth having — and removed
 * before comparison, because "the same session" cannot mean "took the same
 * number of milliseconds". Everything else is compared in full: two runs that
 * agree only on the *types* of their events agree on almost nothing.
 */
export function normalizeEvents<T>(events: readonly T[]): T[] {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => !NONDETERMINISTIC.has(k))
          .map(([k, v]) => [k, strip(v)]),
      );
    }
    return value;
  };
  return events.map((e) => strip(e) as T);
}

export interface RecordedExchangeV2 {
  scopeId: string;
  turn: number;
  request: RecordedRequest;
  requestHash: string;
  response:
    | { ok: true; value: CompletionResponse }
    | { ok: false; error: RecordedError };
}

export interface RecordedToolExecutionV2 {
  scopeId: string;
  call: { id: string; name: string; arguments: Record<string, unknown>; repaired: boolean };
  callHash: string;
  result: ToolResult;
}

export interface Recording {
  header: ReplayHeaderV2;
  exchanges: RecordedExchangeV2[];
  toolExecutions: RecordedToolExecutionV2[];
}

/** Thrown when a replayed run asked for something the recording does not hold. */
export class ReplayDivergence extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "ReplayDivergence";
  }
}

function strip(req: CompletionRequest): RecordedRequest {
  // The abort signal is a live handle, not content, and timestamps are not
  // either. Everything else is kept: leaving a field out of the recording is
  // deciding in advance that a change to it does not matter.
  const { signal: _signal, ...rest } = req;
  return rest;
}

/**
 * Where two requests first differ, in a form a person can act on.
 *
 * A hash mismatch alone says "something changed" and sends the reader to a
 * diff of two multi-kilobyte JSON blobs.
 */
export function firstDifference(expected: RecordedRequest, actual: RecordedRequest): string | null {
  const scalarKeys = ["raw", "prompt", "maxTokens", "temperature", "topP", "seed"] as const;
  for (const key of scalarKeys) {
    const a = expected[key] ?? null;
    const b = actual[key] ?? null;
    if (canonicalJson(a) !== canonicalJson(b)) {
      return `${key}: recorded ${canonicalJson(a)}, got ${canonicalJson(b)}`;
    }
  }
  if (canonicalJson(expected.stop ?? null) !== canonicalJson(actual.stop ?? null)) {
    return `stop: recorded ${canonicalJson(expected.stop ?? null)}, got ${canonicalJson(actual.stop ?? null)}`;
  }
  if (expected.tools.length !== actual.tools.length) {
    return `tools: recorded ${expected.tools.length}, got ${actual.tools.length}`;
  }
  for (let i = 0; i < expected.tools.length; i++) {
    if (canonicalJson(expected.tools[i]) !== canonicalJson(actual.tools[i])) {
      return `tools[${i}]: schema differs`;
    }
  }
  if (expected.messages.length !== actual.messages.length) {
    return `messages: recorded ${expected.messages.length}, got ${actual.messages.length}`;
  }
  for (let i = 0; i < expected.messages.length; i++) {
    const a = canonicalJson(expected.messages[i]);
    const b = canonicalJson(actual.messages[i]);
    if (a !== b) {
      return `messages[${i}] (${expected.messages[i]!.role}): recorded ${a.slice(0, 160)}, got ${b.slice(0, 160)}`;
    }
  }
  return null;
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
 *
 * Structured `toolCalls` are damaged alongside the text. Leaving them intact
 * meant a fault injected into a response from a parser-equipped server changed
 * nothing at all — the loop read the untouched structured calls and the test
 * proved only that the fault had been ignored.
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
    const out: CompletionResponse = {
      ...res,
      content: damaged,
      rawText: damaged,
      reasoningContent: undefined,
    };
    delete out.toolCalls;
    if (plan.kind === "truncate") out.finishReason = "length";
    return out;
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

/** Wraps a live transport and captures every exchange, failures included. */
export class RecordingTransport implements Transport {
  readonly endpoint: string;
  readonly model: string;
  readonly exchanges: RecordedExchangeV2[] = [];
  private turn = 0;

  constructor(
    private readonly inner: Transport,
    private readonly scopeId = "root",
  ) {
    this.endpoint = inner.endpoint;
    this.model = inner.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.turn++;
    const request = strip(req);
    const requestHash = requestDigest(request);
    try {
      const value = await this.inner.complete(req);
      this.exchanges.push({
        scopeId: this.scopeId,
        turn: this.turn,
        request,
        requestHash,
        response: { ok: true, value },
      });
      return value;
    } catch (err) {
      // A failed turn is part of the session. Recording only the successes
      // means a replay never exercises the retry path, which is the path this
      // stack spends the most time in.
      const e = err as { name?: string; message?: string; kind?: string; status?: number; body?: string };
      this.exchanges.push({
        scopeId: this.scopeId,
        turn: this.turn,
        request,
        requestHash,
        response: {
          ok: false,
          error: {
            name: e.name ?? "Error",
            message: e.message ?? String(err),
            ...(e.kind !== undefined ? { kind: e.kind } : {}),
            ...(e.status !== undefined ? { status: e.status } : {}),
            ...(e.body !== undefined ? { body: e.body } : {}),
          },
        },
      });
      throw err;
    }
  }
}

/** Wraps an executor and captures every call and its result. */
export class RecordingExecutor implements Executor {
  readonly executions: RecordedToolExecutionV2[] = [];

  constructor(
    private readonly inner: Executor,
    private readonly scopeId = "root",
  ) {}

  async run(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult> {
    const result = await this.inner.run(call, signal);
    this.executions.push({
      scopeId: this.scopeId,
      call: {
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        repaired: call.repaired,
      },
      callHash: callDigest(call.name, call.arguments),
      result,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */

/** Replays model responses, checking that the request matches the recording. */
export class ReplayTransport implements Transport {
  readonly endpoint: string;
  readonly model: string;
  private index = 0;

  constructor(
    private readonly exchanges: readonly RecordedExchangeV2[],
    opts: { endpoint?: string; model?: string } = {},
  ) {
    this.endpoint = opts.endpoint ?? "replay://";
    this.model = opts.model ?? "motif-3-replay";
  }

  static fromJSONL(text: string): ReplayTransport {
    const exchanges = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as RecordedExchangeV2);
    return new ReplayTransport(exchanges);
  }

  get remaining(): number {
    return this.exchanges.length - this.index;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const e = this.exchanges[this.index++];
    if (!e) {
      throw new ReplayDivergence(
        `replay exhausted after ${this.index - 1} turns — the loop asked for more than the recording holds`,
      );
    }
    const actual = strip(req);
    if (requestDigest(actual) !== e.requestHash) {
      const where = firstDifference(e.request, actual);
      throw new ReplayDivergence(
        `turn ${e.turn}: the request differs from the recording — ${where ?? "hash mismatch with no field-level difference"}`,
        where ?? undefined,
      );
    }
    if (!e.response.ok) {
      // Rebuilt with the real error type rather than an approximation of it.
      // Re-deriving retryability here would be a second copy of the policy,
      // and the copy would be wrong the moment the policy changed.
      const { kind, status, body, message } = e.response.error;
      throw new TransportError(message, {
        kind: (kind ?? "protocol") as TransportError["kind"],
        ...(status !== undefined ? { status } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    }
    return e.response.value;
  }
}

/** Replays tool results, so a replay does not depend on the filesystem. */
export class ReplayExecutor implements Executor {
  private index = 0;

  constructor(private readonly executions: readonly RecordedToolExecutionV2[]) {}

  get remaining(): number {
    return this.executions.length - this.index;
  }

  async run(call: ToolInvocation): Promise<ToolResult> {
    const e = this.executions[this.index++];
    if (!e) {
      throw new ReplayDivergence(
        `replay ran out of recorded tool results at call ${this.index} (${call.name})`,
      );
    }
    if (e.call.name !== call.name) {
      throw new ReplayDivergence(`call ${this.index}: recorded ${e.call.name}, got ${call.name}`);
    }
    const hash = callDigest(call.name, call.arguments);
    if (hash !== e.callHash) {
      throw new ReplayDivergence(
        `call ${this.index} (${call.name}): arguments differ from the recording — ` +
          `recorded ${canonicalJson(e.call.arguments).slice(0, 160)}, got ${canonicalJson(call.arguments).slice(0, 160)}`,
      );
    }
    return e.result;
  }
}

/**
 * Fail if the recording was not fully used.
 *
 * A replay that stops early is a replay that diverged: the run took a different
 * path and simply never asked for the rest. Passing on that basis is how a
 * regression gets recorded as reproduced.
 */
export function assertConsumed(
  transport: ReplayTransport,
  executor?: ReplayExecutor,
): void {
  if (transport.remaining > 0) {
    throw new ReplayDivergence(
      `${transport.remaining} recorded model exchange(s) were never requested — the run ended earlier than the recording`,
    );
  }
  if (executor && executor.remaining > 0) {
    throw new ReplayDivergence(
      `${executor.remaining} recorded tool execution(s) were never requested`,
    );
  }
}

export function toJSONL(exchanges: readonly RecordedExchangeV2[]): string {
  return exchanges.map((e) => JSON.stringify(e)).join("\n") + "\n";
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
