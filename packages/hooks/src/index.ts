/**
 * Lifecycle hooks.
 *
 * Shell commands the harness runs at fixed points, outside the model.
 *
 * Hooks matter more here than in most harnesses, and for a concrete reason:
 * every piece of work moved into a hook is one fewer tool call, and every tool
 * call is a chance for this model to emit an argument that does not parse.
 * Running the formatter deterministically after a patch is both faster and
 * strictly more reliable than asking for it.
 *
 * One event has no equivalent elsewhere. `OnParseFail` fires when the model's
 * action syntax could not be recovered, which lets a project collect its own
 * corpus of the failures it actually sees — the same corpus this repo's repair
 * ladder was built from.
 */

import { spawn } from "node:child_process";

export type HookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "PreToolUse"
  | "PostToolUse"
  | "OnParseFail"
  | "OnRepair"
  | "BeforeCompact";

export interface HookDef {
  /** Tool name to match; omit to match every tool. Ignored by non-tool events. */
  matcher?: string;
  command: string;
  /** Milliseconds before the hook is killed. Hooks must not stall the loop. */
  timeoutMs?: number;
  /**
   * A failing `PreToolUse` hook blocks the call. Everything else is advisory,
   * because a broken formatter should not end a session.
   */
  blocking?: boolean;
}

export type HookConfig = Partial<Record<HookEvent, HookDef[]>>;

export interface HookContext {
  event: HookEvent;
  tool?: string;
  /** Paths the tool touched, exported as `MOTIF_PATHS`. */
  paths?: string[];
  /** Free-form payload, exported as `MOTIF_PAYLOAD`. */
  payload?: string;
  cwd?: string;
}

export interface HookOutcome {
  command: string;
  label: string;
  ok: boolean;
  output: string;
  ms: number;
  /** True when a blocking PreToolUse hook vetoed the call. */
  blocked: boolean;
}

const DEFAULT_TIMEOUT = 30_000;
/** Hard ceiling on captured hook output, in characters. */
const OUTPUT_CAP = 8000;

function label(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? command;
  return first.split("/").pop() ?? first;
}

export function selectHooks(config: HookConfig, ctx: HookContext): HookDef[] {
  const defs = config[ctx.event] ?? [];
  return defs.filter((d) => {
    if (!d.matcher) return true;
    if (!ctx.tool) return false;
    // Exact name, or a simple `a|b` alternation. No globbing: a matcher that
    // silently matches more than intended is worse than one that is verbose.
    return d.matcher.split("|").map((s) => s.trim()).includes(ctx.tool);
  });
}

export async function runHook(def: HookDef, ctx: HookContext): Promise<HookOutcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(def.command, {
      shell: true,
      cwd: ctx.cwd ?? process.cwd(),
      env: {
        ...process.env,
        MOTIF_EVENT: ctx.event,
        MOTIF_TOOL: ctx.tool ?? "",
        MOTIF_PATHS: (ctx.paths ?? []).join(" "),
        MOTIF_PAYLOAD: ctx.payload ?? "",
      },
    });

    let out = "";
    const cap = (chunk: Buffer) => {
      // Hook output is advisory; a runaway hook must not eat the context.
      // Slice the chunk rather than testing before appending — a single read
      // can be 64 KB, so checking the length first still lets the whole thing
      // through once.
      const room = OUTPUT_CAP - out.length;
      if (room <= 0) return;
      out += chunk.toString().slice(0, room);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, def.timeoutMs ?? DEFAULT_TIMEOUT);

    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      resolve({
        command: def.command,
        label: label(def.command),
        ok,
        output: out.trim(),
        ms: Date.now() - started,
        blocked: !ok && def.blocking === true && ctx.event === "PreToolUse",
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        command: def.command,
        label: label(def.command),
        ok: false,
        output: String(err),
        ms: Date.now() - started,
        blocked: def.blocking === true && ctx.event === "PreToolUse",
      });
    });
  });
}

/** Run every matching hook in order, stopping if a blocking one vetoes. */
export async function runHooks(config: HookConfig, ctx: HookContext): Promise<HookOutcome[]> {
  const outcomes: HookOutcome[] = [];
  for (const def of selectHooks(config, ctx)) {
    const outcome = await runHook(def, ctx);
    outcomes.push(outcome);
    if (outcome.blocked) break;
  }
  return outcomes;
}

export function wasBlocked(outcomes: readonly HookOutcome[]): boolean {
  return outcomes.some((o) => o.blocked);
}

/**
 * Hooks a project gets for free.
 *
 * Kept to the two that pay for themselves immediately: formatting after a patch
 * is deterministic work the model should never be asked to do, and recording
 * parse failures builds the corpus that tunes the channel choice.
 */
export const DEFAULT_HOOKS: HookConfig = Object.freeze({
  PostToolUse: [{ matcher: "apply_patch", command: "true", timeoutMs: 10_000 }],
  OnParseFail: [{ command: "true", timeoutMs: 5_000 }],
});
