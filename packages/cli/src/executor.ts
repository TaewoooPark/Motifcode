/**
 * Tool execution.
 *
 * The eight frozen tools, made real. Two of them are worth explaining.
 *
 * `bash` is stateless: a fresh subshell per call, no directory or environment
 * carried between them. That is the shape SWE-bench Verified 76.2 was scored
 * in, and it is cache-friendly and easy to reason about.
 *
 * `term` is stateful: one long-lived shell that keeps its working directory,
 * its environment and any program running inside it. Terminal-Bench 74.9 was
 * scored that way, and it is the difference between being able to drive a
 * debugger or a REPL and not.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Executor, ToolResult, ToolInvocation } from "@motifcode/core";
import { runHooks, runShell, wasBlocked, type HookConfig } from "@motifcode/hooks";
import type { SkillRegistry } from "@motifcode/skills";

/**
 * What a delegated run reports back.
 *
 * Structured rather than a bare string because a child that hit its turn limit,
 * lost the server or was aborted has *also* produced text, and folding that into
 * a plain summary makes an abandoned subtask read to the parent as a finished
 * one. `ok` is true only when the child actually called `done`.
 */
export interface SubagentOutcome {
  ok: boolean;
  /** The child's `AgentResult.endReason`. */
  reason: string;
  summary?: string;
  runId: string;
}

export interface ExecutorOptions {
  cwd: string;
  hooks?: HookConfig;
  skills?: SkillRegistry;
  /** Runs a subagent; supplied by the CLI so this module stays loop-agnostic. */
  runAgent?: (agent: string, prompt: string) => Promise<SubagentOutcome>;
  /** Called for MCP proxy calls. Absent means no servers are connected. */
  callMcp?: (server: string, method: string, args: unknown) => Promise<string>;
  onHook?: (label: string, ok: boolean) => void;
  timeoutMs?: number;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/* ------------------------------------------------------------------ */

/**
 * A shell that stays alive between calls.
 *
 * Not a PTY: without a pseudo-terminal, full-screen programs will not render.
 * Saying so plainly is better than pretending — a REPL, a debugger and a
 * long-running build all work, and `vim` does not.
 */
export class PersistentShell {
  private proc: ChildProcess | null = null;
  private buffer = "";

  constructor(private readonly cwd: string) {}

  private ensure(): ChildProcess {
    if (this.proc && !this.proc.killed) return this.proc;
    const proc = spawn(process.env["SHELL"] ?? "/bin/bash", ["-i"], {
      cwd: this.cwd,
      env: { ...process.env, PS1: "", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const capture = (c: Buffer) => {
      this.buffer += c.toString();
      if (this.buffer.length > 200_000) this.buffer = this.buffer.slice(-100_000);
    };
    proc.stdout?.on("data", capture);
    proc.stderr?.on("data", capture);
    this.proc = proc;
    return proc;
  }

  /** Send keystrokes verbatim, wait, and return whatever appeared. */
  async send(keystrokes: string, durationS: number): Promise<string> {
    const proc = this.ensure();
    this.buffer = "";
    if (keystrokes !== "") {
      // tmux-style control keys, as Terminus 2 specifies them.
      const resolved = keystrokes.replace(/C-([a-z])/g, (_m, ch: string) =>
        String.fromCharCode(ch.toLowerCase().charCodeAt(0) - 96),
      );
      proc.stdin?.write(resolved);
    }
    const wait = Math.min(Math.max(durationS, 0), 60) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return this.buffer;
  }

  close(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

/* ------------------------------------------------------------------ */

async function runBash(command: string, cwd: string, timeoutMs: number): Promise<ToolResult> {
  // Same process-group handling as hooks: a command that spawns children and
  // then times out would otherwise hang the loop on Linux, which is where this
  // actually runs.
  const r = await runShell(command, { cwd, timeoutMs });
  if (r.timedOut) {
    return { ok: false, output: `${r.output.trim()}\n(killed after ${Math.round(r.ms / 1000)}s)`.trim() };
  }
  return { ok: r.code === 0, output: r.output.trim() || `(exit ${r.code})` };
}

function readSlice(path: string, cwd: string, offset?: number, limit?: number): ToolResult {
  try {
    const text = readFileSync(resolve(cwd, path), "utf8");
    const lines = text.split("\n");
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit !== undefined ? start + limit : lines.length;
    const slice = lines.slice(start, end);
    const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    const more = end < lines.length ? `\n… ${lines.length - end} more lines` : "";
    return { ok: true, output: numbered + more };
  } catch (err) {
    return { ok: false, output: String(err) };
  }
}

/** Files a unified diff touches, for the hook environment. */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = /^\+\+\+ [ab]\/(.+)$/.exec(line) ?? /^\+\+\+ (.+)$/.exec(line);
    if (m?.[1] && m[1] !== "/dev/null") paths.add(m[1].trim());
  }
  return [...paths];
}

/* ------------------------------------------------------------------ */

export class ToolExecutor implements Executor {
  private readonly shell: PersistentShell;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ExecutorOptions) {
    this.shell = new PersistentShell(opts.cwd);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async run(call: ToolInvocation): Promise<ToolResult> {
    const { cwd, hooks } = this.opts;
    const args = call.arguments;

    if (hooks) {
      const pre = await runHooks(hooks, { event: "PreToolUse", tool: call.name, cwd });
      for (const h of pre) this.opts.onHook?.(h.label, h.ok);
      if (wasBlocked(pre)) {
        return { ok: false, output: `blocked by a PreToolUse hook: ${pre[pre.length - 1]?.output ?? ""}` };
      }
    }

    const result = await this.dispatch(call.name, args);

    if (hooks) {
      const paths = call.name === "apply_patch" ? patchPaths(str(args, "patch")) : [];
      const post = await runHooks(hooks, { event: "PostToolUse", tool: call.name, paths, cwd });
      for (const h of post) this.opts.onHook?.(h.label, h.ok);
      // Hook output is appended, not merged: a failing formatter is information
      // the model should see without it looking like the tool itself failed.
      const failed = post.filter((h) => !h.ok);
      if (failed.length > 0) {
        return {
          ok: result.ok,
          output: `${result.output}\n\n[hooks] ${failed.map((h) => `${h.label}: ${h.output}`).join("; ")}`,
        };
      }
    }
    return result;
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const cwd = this.opts.cwd;
    switch (name) {
      case "bash":
        return runBash(str(args, "command"), cwd, (num(args, "timeout_s") ?? 120) * 1000);

      case "term": {
        const out = await this.shell.send(str(args, "keystrokes"), num(args, "duration_s") ?? 1);
        return { ok: true, output: out || "(no output yet — send empty keystrokes to wait longer)" };
      }

      case "read":
        return readSlice(str(args, "path"), cwd, num(args, "offset"), num(args, "limit"));

      case "apply_patch":
        // `git apply` rather than a bespoke patcher: it already understands
        // context, renames and binary files, and its errors are ones people
        // know how to read.
        return runBash(
          `git apply --whitespace=nowarn - <<'MOTIF_PATCH_EOF'\n${str(args, "patch")}\nMOTIF_PATCH_EOF`,
          cwd,
          this.timeoutMs,
        );

      case "skill": {
        const reg = this.opts.skills;
        if (!reg) return { ok: false, output: "no skills are loaded" };
        return { ok: true, output: reg.render(str(args, "name")) };
      }

      case "task": {
        const run = this.opts.runAgent;
        if (!run) return { ok: false, output: "subagents are not available in this session" };
        const prompt = str(args, "prompt");
        if (prompt.trim() === "") {
          // Rejected before anything is spawned: a child with no task burns a
          // model run to produce a summary of nothing.
          return { ok: false, output: "task needs a non-empty `prompt`; nothing was delegated" };
        }
        try {
          const out = await run(str(args, "agent"), prompt);
          const head = `[${out.runId}] `;
          if (!out.ok) {
            return { ok: false, output: `${head}subagent did not finish (${out.reason})${out.summary ? `: ${out.summary}` : ""}` };
          }
          return { ok: true, output: `${head}${out.summary ?? "(no summary)"}` };
        } catch (err) {
          return { ok: false, output: String(err) };
        }
      }

      case "mcp": {
        const call = this.opts.callMcp;
        if (!call) return { ok: false, output: "no MCP servers are connected" };
        let parsed: unknown = {};
        const raw = str(args, "args");
        if (raw) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            return { ok: false, output: `args must be a JSON object string; got: ${raw.slice(0, 200)}` };
          }
        }
        try {
          return { ok: true, output: await call(str(args, "server"), str(args, "method"), parsed) };
        } catch (err) {
          return { ok: false, output: String(err) };
        }
      }

      case "done":
        // Handled by the loop, which owns the two-step confirmation.
        return { ok: true, output: "" };

      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  }

  close(): void {
    this.shell.close();
  }
}
