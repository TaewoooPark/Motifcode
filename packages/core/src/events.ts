/**
 * The event stream.
 *
 * The loop emits; the TUI renders; the recorder writes. Nothing downstream
 * reaches back into the loop, which is what makes a recorded session replayable
 * and the rendering snapshot-testable.
 *
 * Several event types exist only because of this model. `parse_failure` and
 * `channel_downgrade` track a failure mode the vendor documented; `prefix`
 * exposes cache health that a hosted API would never tell you; `repair` marks
 * the recovery loop that a pruned checkpoint depends on.
 */

import type { Action, ChannelId } from "@motifcode/protocol";

export interface ToolInvocation {
  /** Synthesised by the harness — the model never emits ids. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** True when the call only parsed after repair. Feeds the breakage budget. */
  repaired: boolean;
  /**
   * Proof that this call passed the registered schema.
   *
   * A marker rather than a comment: an executor should be able to state that
   * every call it ever sees has been checked, and the only way to say that is
   * to make the unchecked case unrepresentable at the boundary.
   */
  validated: true;
}

export type ParseFailureKind =
  /** No rung recovered the block. */
  | "unrecoverable"
  /** Zero calls, but the text still carries tool syntax — not a final answer. */
  | "leaked"
  /** An opener with no closer, usually a length cap. */
  | "truncated"
  /**
   * Parsed, but refused before execution: schema-invalid arguments, an
   * incomplete payload, or `done` mixed with other actions. Counted separately
   * from parse failures because the fix the model needs is different — the
   * syntax was fine and the meaning was not.
   */
  | "rejected";

export type LoopEvent =
  | {
      type: "session_start";
      model: string;
      endpoint: string;
      channel: ChannelId;
      tools: string[];
      /** Stable hash of the rendered tools block; the prefix lives or dies with it. */
      toolsHash: string;
    }
  | { type: "turn_start"; turn: number }
  | { type: "reasoning_delta"; text: string }
  | { type: "content_delta"; text: string }
  | { type: "reasoning_end"; chars: number; ms: number }
  | { type: "plan"; analysis?: string; plan?: string }
  | { type: "tool_start"; call: ToolInvocation }
  | { type: "tool_end"; id: string; ok: boolean; output: string; ms: number }
  | { type: "hook"; event: string; label: string; ok: boolean }
  | {
      type: "repair";
      /**
       * Which repair this is, because three different things were being called
       * the same name.
       *
       * `parse` and `refusal` are the harness handing back a turn it could not
       * use. `tool_failure` is the product behaviour: a command exited non-zero
       * and the model gets its output. None of them is the one-repair protocol
       * from the pruning literature, which grades a first attempt with an
       * external test suite and shows the model the failing case exactly once —
       * that lives in the evaluation layer and is counted separately, because
       * reporting one as the other would claim a result this loop has not
       * produced.
       */
      kind: "parse" | "refusal" | "tool_failure";
      reason: string;
      attempt: number;
      max: number;
    }
  | { type: "parse_failure"; kind: ParseFailureKind; sample: string }
  | { type: "channel_downgrade"; from: ChannelId; to: ChannelId; reason: string }
  | { type: "queue"; agent: string; state: "queued" | "running" | "done" }
  | { type: "prefix"; sharedChars: number; totalChars: number; invalidatedBy?: string }
  | {
      type: "usage";
      /** Estimated from characters. The server's count is `promptTokens`. */
      contextTokens: number;
      kvBytes: number;
      /** Server-reported, when the server reports it. */
      promptTokens?: number;
      completionTokens?: number;
      /**
       * Whole-request wall time, prefill and queueing included.
       *
       * Deliberately not divided into a tok/s here. `completionTokens / ms` is
       * request-effective throughput, not decode throughput, and the two differ
       * by however long the prefill took — which on a 256K context is most of
       * it. Whoever displays this has to say which one they mean.
       */
      requestMs: number;
    }
  | { type: "loop_detected"; signature: string; repeats: number }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "session_end"; reason: SessionEndReason; summary?: string };

export type SessionEndReason =
  | "done"
  | "turn_limit"
  | "breakage_limit"
  | "loop_detected"
  | "aborted"
  | "transport_error";

export type EventSink = (event: LoopEvent) => void;

/** Convenience for the common `action -> events` mapping. */
export function describeAction(action: Action): string {
  return action.kind === "done" ? "done" : action.name;
}
