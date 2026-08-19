/**
 * Typed history cells.
 *
 * The transcript is a list of typed cells, never a text buffer. Codex's TUI
 * settled on this and the reason holds here: a buffer cannot be folded,
 * re-rendered at a new width, or snapshot-tested, and all three are wanted.
 *
 * Cells are produced by folding the loop's event stream, so the renderer never
 * reaches into the loop and a recorded session replays into an identical
 * screen.
 */

import type { LoopEvent, ParseFailureKind } from "@motifcode/core";

export type Cell =
  | { kind: "session"; model: string; endpoint: string; channel: string; tools: string[]; toolsHash: string }
  | { kind: "user"; text: string }
  /** Collapsed by default — this model thinks on every single turn. */
  | { kind: "think"; text: string; ms: number; collapsed: boolean }
  | { kind: "plan"; analysis?: string; plan?: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      repaired: boolean;
      output?: string;
      ok?: boolean;
      ms?: number;
      hooks: { label: string; ok: boolean }[];
    }
  | { kind: "repair"; reason: string; attempt: number; max: number }
  | { kind: "breakage"; kindOf: ParseFailureKind; sample: string }
  | { kind: "downgrade"; from: string; to: string; reason: string }
  | { kind: "queue"; agent: string; state: "queued" | "running" | "done" }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "loop"; signature: string; repeats: number }
  | { kind: "end"; reason: string; summary?: string };

export interface Instruments {
  channel: string;
  parseFailures: number;
  parseAttempts: number;
  repairs: number;
  prefixShared: number;
  prefixTotal: number;
  contextTokens: number;
  /** True once the server reported the count; false while it is a char estimate. */
  contextTokensMeasured: boolean;
  maxTokens: number;
  kvBytes: number;
  /**
   * Completion tokens divided by whole-request wall time.
   *
   * This is request-effective throughput, not decode throughput: it includes
   * prefill, queueing and time to first token, which on a long context is most
   * of it. The status line says `req tok/s` for that reason. A real decode rate
   * needs streaming, which the action path deliberately does not use.
   */
  requestTokensPerSecond: number;
  turn: number;
}

export interface ViewState {
  cells: Cell[];
  instruments: Instruments;
  /** Reasoning still arriving; lives in the mutable tail, never in scrollback. */
  pendingThink: string;
}

export function initialState(): ViewState {
  return {
    cells: [],
    instruments: {
      channel: "toolcall",
      parseFailures: 0,
      parseAttempts: 0,
      repairs: 0,
      prefixShared: 0,
      prefixTotal: 0,
      contextTokens: 0,
      maxTokens: 262_144,
      kvBytes: 0,
      contextTokensMeasured: false,
      requestTokensPerSecond: 0,
      turn: 0,
    },
    pendingThink: "",
  };
}

/** Fold one event into the view. Pure — the whole point. */
export function reduce(state: ViewState, event: LoopEvent): ViewState {
  const cells = state.cells;
  const inst = { ...state.instruments };
  let pendingThink = state.pendingThink;

  switch (event.type) {
    case "session_start":
      inst.channel = event.channel;
      cells.push({
        kind: "session",
        model: event.model,
        endpoint: event.endpoint,
        channel: event.channel,
        tools: event.tools,
        toolsHash: event.toolsHash,
      });
      break;

    case "turn_start":
      inst.turn = event.turn;
      inst.parseAttempts += 1;
      break;

    case "reasoning_delta":
      pendingThink += event.text;
      break;

    case "reasoning_end":
      cells.push({ kind: "think", text: pendingThink, ms: event.ms, collapsed: true });
      pendingThink = "";
      break;

    case "plan":
      cells.push({ kind: "plan", analysis: event.analysis, plan: event.plan });
      break;

    case "content_delta":
      cells.push({ kind: "assistant", text: event.text });
      break;

    case "tool_start":
      cells.push({
        kind: "tool",
        id: event.call.id,
        name: event.call.name,
        args: event.call.arguments,
        repaired: event.call.repaired,
        hooks: [],
      });
      if (event.call.repaired) inst.repairs += 1;
      break;

    case "tool_end": {
      const cell = [...cells].reverse().find((c): c is Extract<Cell, { kind: "tool" }> => c.kind === "tool" && c.id === event.id);
      if (cell) {
        cell.output = event.output;
        cell.ok = event.ok;
        cell.ms = event.ms;
      }
      break;
    }

    case "hook": {
      const cell = [...cells].reverse().find((c): c is Extract<Cell, { kind: "tool" }> => c.kind === "tool");
      if (cell) cell.hooks.push({ label: event.label, ok: event.ok });
      break;
    }

    case "repair":
      cells.push({ kind: "repair", reason: event.reason, attempt: event.attempt, max: event.max });
      break;

    case "parse_failure":
      inst.parseFailures += 1;
      cells.push({ kind: "breakage", kindOf: event.kind, sample: event.sample });
      break;

    case "channel_downgrade":
      inst.channel = event.to;
      cells.push({ kind: "downgrade", from: event.from, to: event.to, reason: event.reason });
      break;

    case "queue":
      cells.push({ kind: "queue", agent: event.agent, state: event.state });
      break;

    case "prefix":
      inst.prefixShared = event.sharedChars;
      inst.prefixTotal = event.totalChars;
      break;

    case "usage": {
      // Prefer the server's own count; the character estimate is a placeholder
      // for the first turn and is labelled as one.
      if (event.promptTokens !== undefined) {
        inst.contextTokens = event.promptTokens;
        inst.contextTokensMeasured = true;
      } else if (!inst.contextTokensMeasured) {
        inst.contextTokens = event.contextTokens;
      }
      inst.kvBytes = event.kvBytes;
      const out = event.completionTokens ?? 0;
      if (out > 0 && event.requestMs > 0) {
        inst.requestTokensPerSecond = (out / event.requestMs) * 1000;
      }
      break;
    }

    case "loop_detected":
      cells.push({ kind: "loop", signature: event.signature, repeats: event.repeats });
      break;

    case "notice":
      cells.push({ kind: "notice", level: event.level, text: event.text });
      break;

    case "session_end":
      cells.push({ kind: "end", reason: event.reason, summary: event.summary });
      break;

    default:
      break;
  }

  return { cells, instruments: inst, pendingThink };
}

export function pushUser(state: ViewState, text: string): ViewState {
  state.cells.push({ kind: "user", text });
  return state;
}
