/**
 * Enough state to carry on, rather than to start again.
 *
 * `motif resume` used to rebuild the conversation from the recorded *user*
 * turns and hand the last one to a fresh loop. That is not a resume. Gone:
 * every assistant turn, every tool call and its result, the current channel
 * after a downgrade, the breakage budget, the loop guard, the repair count, a
 * pending `done` proposal, and the call-id counter. What came back was a new
 * attempt at the same task, in a repository the earlier attempt had already
 * modified — which is a strictly worse starting position than the original,
 * and was reported as continuity.
 *
 * A checkpoint is written after every model response and around every tool
 * call. The interesting field is `inFlightTool`: an intent recorded before a
 * tool runs and cleared after it finishes. A checkpoint that still holds one
 * means the process died while a command was executing, and nobody — not the
 * harness, not the model — can tell whether the write landed. Re-running
 * `apply_patch` on a patch that already applied is not a recovery.
 */

import type { ChannelId, Message } from "@motifcode/protocol";
import type { BudgetSnapshot, LoopGuardSnapshot } from "./budget.js";

export interface InFlightTool {
  id: string;
  name: string;
  /** Canonical digest of the arguments; the arguments themselves may be large. */
  argumentsHash: string;
  /** True for tools that can change the world. Never re-run automatically. */
  mutating: boolean;
}

export interface RepoState {
  cwd: string;
  head?: string;
  worktreeHash?: string;
}

export interface LoopCheckpoint {
  scopeId: string;
  /** Journal sequence number this checkpoint follows. */
  afterSeq: number;
  messages: Message[];
  turn: number;
  currentChannel: ChannelId;
  initialChannel: ChannelId;
  breakage: BudgetSnapshot;
  loopGuard: LoopGuardSnapshot;
  repairsThisTask: number;
  /** Normalised summary of a `done` awaiting confirmation, or null. */
  pendingDone: string | null;
  /**
   * Next call id for this scope.
   *
   * Per scope, not a module global. A global counter means two sessions in one
   * process interleave their ids, and a resumed session restarts from 1 and
   * collides with ids already in its own transcript.
   */
  nextCallSequence: number;
  transportErrors: number;
  repo: RepoState;
  inFlightTool?: InFlightTool;
}

/**
 * What a resumed run must match to be the same run.
 *
 * Checked fail-closed. Continuing a transcript under a changed tool schema or a
 * changed system prompt produces a history the model was never shown, and the
 * failure mode is silent: the session carries on and every later turn is
 * subtly off-distribution.
 */
export interface ResumeCompatibility {
  toolSchemaHash: string;
  systemPromptHash: string;
  model: string;
  channelPolicy: string;
  protocolVersion: number;
}

export const PROTOCOL_VERSION = 2;

/** Tools whose effects outlive the call, and so must never be replayed blind. */
const MUTATING = new Set(["bash", "apply_patch", "term", "task", "mcp"]);

export function isMutating(toolName: string): boolean {
  return MUTATING.has(toolName);
}

export function compatibilityProblem(
  recorded: ResumeCompatibility,
  current: ResumeCompatibility,
): string | null {
  if (recorded.protocolVersion !== current.protocolVersion) {
    return `journal protocol v${recorded.protocolVersion}, this build writes v${current.protocolVersion}`;
  }
  if (recorded.toolSchemaHash !== current.toolSchemaHash) {
    return (
      "the tool schemas changed since this session was recorded. Resuming would render the " +
      "existing transcript against different tools and lose the prompt prefix"
    );
  }
  if (recorded.systemPromptHash !== current.systemPromptHash) {
    return "the system prompt changed since this session was recorded";
  }
  if (recorded.model !== current.model) {
    return `recorded against model ${recorded.model}, now ${current.model}`;
  }
  if (recorded.channelPolicy !== current.channelPolicy) {
    return `recorded with channel policy ${recorded.channelPolicy}, now ${current.channelPolicy}`;
  }
  return null;
}

/**
 * Why a checkpoint cannot simply be continued.
 *
 * `execution_uncertain` is the one that matters. Benchmarks must fail such a
 * run outright: scoring it either way — assuming the command ran, or assuming
 * it did not — invents a fact about the repository.
 */
export type ResumeBlock =
  | { kind: "execution_uncertain"; tool: string; id: string }
  | { kind: "incompatible"; detail: string }
  | { kind: "already_finished" };

export function resumeBlock(
  checkpoint: LoopCheckpoint,
  compat: string | null,
): ResumeBlock | null {
  if (compat !== null) return { kind: "incompatible", detail: compat };
  const inflight = checkpoint.inFlightTool;
  if (inflight && inflight.mutating) {
    return { kind: "execution_uncertain", tool: inflight.name, id: inflight.id };
  }
  return null;
}
