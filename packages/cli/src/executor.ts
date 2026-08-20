/**
 * Tool execution.
 *
 * The eight frozen tools, made real, behind two boundaries the model cannot
 * argue with: every call has already passed its registered schema, and every
 * call is checked against the agent's execution policy before anything runs.
 *
 * `bash` is stateless: a fresh subshell per call, no directory or environment
 * carried between them. That is the shape SWE-bench Verified 76.2 was scored
 * in, and it is cache-friendly and easy to reason about.
 *
 * `term` is stateful: one long-lived shell that keeps its working directory,
 * its environment and any program running inside it. It is a pipe, not a
 * pseudo-terminal, and the tool description says so — a full-screen program
 * will not render, and advertising otherwise sends the model into an
 * interaction that cannot work.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Executor, ToolResult, ToolInvocation } from "@motifcode/core";
import { runHooks, runShell, wasBlocked, type HookConfig, type HookEvent } from "@motifcode/hooks";
import type { SkillRegistry } from "@motifcode/skills";
import { approve, fullPolicy, type ExecutionPolicy } from "./policy.js";
import { detectSandbox, makeScratch } from "./sandbox.js";

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
  /**
   * What this agent may do.
   *
   * Defaults to full access for the root session, which owns the working
   * directory it was pointed at. Subagents get a narrower one.
   */
  policy?: ExecutionPolicy;
  /** Runs a subagent; supplied by the CLI so this module stays loop-agnostic. */
  runAgent?: (agent: string, prompt: string) => Promise<SubagentOutcome>;
  /** Called for MCP proxy calls. Absent means no servers are connected. */
  callMcp?: (server: string, method: string, args: unknown) => Promise<string>;
  onHook?: (event: HookEvent, label: string, ok: boolean) => void;
  timeoutMs?: number;
}

/**
 * Read an argument the validator has already checked.
 *
 * No coercion. `String(v)` used to turn a number into a plausible command and
 * `Number(v)` used to turn `"abc"` into a NaN timeout, both of which produced a
 * call the model never made. Every invocation reaching this module carries the
 * `validated` marker, so a missing or wrong-typed value here is a harness bug
 * rather than model output.
 */
function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/* ------------------------------------------------------------------ */

/** Control keys in tmux notation, as Terminus 2 specifies them. */
const CONTROL_KEY = /^C-([a-z])$/;

/**
 * Split keystrokes into literal text and control keys.
 *
 * A blanket `replace(/C-([a-z])/g, ...)` rewrote the notation anywhere it
 * appeared, so `echo "press C-c to quit"` sent an actual interrupt instead of
 * printing the sentence. Control notation is only a control key when it stands
 * alone as a token.
 */
export function encodeKeystrokes(input: string): string {
  if (input === "") return "";
  return input
    .split(/(\s+)/)
    .map((token) => {
      const m = CONTROL_KEY.exec(token);
      if (!m) return token;
      return String.fromCharCode(m[1]!.toLowerCase().charCodeAt(0) - 96);
    })
    .join("");
}

export interface TerminalSend {
  output: string;
  alive: boolean;
  exitCode?: number;
}

/**
 * A shell that stays alive between calls.
 *
 * Not a PTY: without a pseudo-terminal, full-screen programs will not render.
 * A REPL, a debugger and a long-running build all work, and `vim` does not.
 *
 * Output is read through a monotonic cursor rather than by clearing a buffer.
 * The old code emptied the buffer before each send, so anything that arrived
 * late — the tail of the previous command, a background job's line — was
 * either lost or attributed to the wrong call.
 */
export class PersistentShell {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private cursor = 0;
  private exitCode: number | undefined;
  private exited = false;
  private ready: Promise<void> | null = null;
  private spawns = 0;

  constructor(private readonly cwd: string) {}

  private ensure(): ChildProcess {
    if (this.proc !== null && !this.exited) return this.proc;
    const proc = spawn(process.env["SHELL"] ?? "/bin/bash", ["-i"], {
      cwd: this.cwd,
      env: { ...process.env, PS1: "", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.buffer = "";
    this.cursor = 0;
    this.exited = false;
    this.exitCode = undefined;
    const capture = (c: Buffer) => {
      this.buffer += c.toString();
      // Trim from the front, and move the cursor with it, so a long-running
      // session cannot grow without bound and cannot lose its place either.
      if (this.buffer.length > 400_000) {
        const drop = this.buffer.length - 200_000;
        this.buffer = this.buffer.slice(drop);
        this.cursor = Math.max(0, this.cursor - drop);
      }
    };
    proc.stdout?.on("data", capture);
    proc.stderr?.on("data", capture);
    proc.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code ?? undefined;
    });
    proc.on("error", () => {
      this.exited = true;
    });
    this.proc = proc;
    this.ready = this.waitUntilStarted(proc, ++this.spawns);
    return proc;
  }

  /**
   * Block until the shell is actually running.
   *
   * `spawn` returns as soon as the process exists, not when bash has finished
   * reading its startup files. On a loaded machine that gap is longer than the
   * `duration_s` of a quick first command, so the call waits out its whole
   * budget against a shell that had not started, returns nothing, and the
   * model reads the empty string as "the command produced no output" — then
   * acts on it.
   *
   * A sentinel echo is the cheap way to know: the shell cannot print it before
   * it is ready to run commands. Its own line is consumed, so it never appears
   * in the first call's output.
   */
  private async waitUntilStarted(proc: ChildProcess, generation: number): Promise<void> {
    const marker = `__motif_shell_ready_${process.pid}_${generation}__`;
    proc.stdin?.write(`echo ${marker}\n`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (this.exited) return;
      const at = this.buffer.indexOf(marker, this.cursor);
      if (at !== -1) {
        const eol = this.buffer.indexOf("\n", at);
        this.cursor = eol === -1 ? this.buffer.length : eol + 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    // Fall through rather than throw: a shell that never echoes is still worth
    // sending to, and the caller finds out from an empty result either way.
  }

  get alive(): boolean {
    return this.proc !== null && !this.exited;
  }

  /** Send keystrokes verbatim, wait, and return everything that arrived since. */
  async send(
    keystrokes: string,
    durationS: number,
    signal?: AbortSignal,
  ): Promise<TerminalSend> {
    const proc = this.ensure();
    await this.ready;
    if (keystrokes !== "") proc.stdin?.write(encodeKeystrokes(keystrokes));

    const wait = Math.min(Math.max(durationS, 0), 60) * 1000;
    await new Promise<void>((r) => {
      const timer = setTimeout(done, wait);
      const onAbort = () => done();
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        r();
      }
      if (signal?.aborted) done();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });

    const output = this.buffer.slice(this.cursor);
    this.cursor = this.buffer.length;
    return {
      output,
      alive: this.alive,
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
    };
  }

  close(): void {
    const pid = this.proc?.pid;
    if (pid !== undefined) {
      // The group, not the leader: a shell that started a build leaves the
      // build running if only the shell is signalled.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    this.proc = null;
    this.exited = true;
  }
}

/* ------------------------------------------------------------------ */

async function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  policy: ExecutionPolicy,
  scratch: () => string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  // Same process-group handling as hooks: a command that spawns children and
  // then times out would otherwise hang the loop on Linux, which is where this
  // actually runs.
  let argv: string[] | undefined;
  if (!policy.allowWrite) {
    const wrapped = detectSandbox().wrap(command, { cwd, scratch: scratch() });
    if (!wrapped) {
      return {
        ok: false,
        output:
          "this agent is read-only and no read-only sandbox is available on this host, " +
          "so running a program cannot be made safe. Install bubblewrap (Linux), or delegate " +
          "the work to an agent that is allowed to write.",
      };
    }
    argv = wrapped.slice(1);
    command = wrapped[0]!;
  }

  const r = await runShell(command, {
    cwd,
    timeoutMs,
    ...(argv ? { argv } : {}),
    ...(signal ? { signal } : {}),
  });
  if (r.aborted) return { ok: false, output: `${r.output.trim()}\n(cancelled)`.trim() };
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

/** Files a unified diff touches, for the hook payload. */
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
  private readonly policy: ExecutionPolicy;
  private scratch: string | undefined;

  /** The one writable directory a sandboxed command gets, created on demand. */
  private scratchDir(): string {
    this.scratch ??= makeScratch();
    return this.scratch;
  }

  constructor(private readonly opts: ExecutorOptions) {
    this.shell = new PersistentShell(opts.cwd);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.policy =
      opts.policy ??
      fullPolicy(opts.cwd, ["done", "bash", "read", "apply_patch", "term", "skill", "task", "mcp"]);
  }

  async run(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult> {
    const { cwd, hooks } = this.opts;

    // Policy first. A call the agent is not allowed to make should not reach a
    // hook, which might have side effects of its own.
    const decision = approve(this.policy, call);
    if (!decision.allowed) {
      return { ok: false, output: `refused by execution policy: ${decision.reason}` };
    }

    if (hooks) {
      const pre = await runHooks(hooks, {
        event: "PreToolUse",
        tool: call.name,
        cwd,
        payload: { arguments: call.arguments },
        ...(signal ? { signal } : {}),
      });
      for (const h of pre) this.opts.onHook?.("PreToolUse", h.label, h.ok);
      if (wasBlocked(pre)) {
        return { ok: false, output: `blocked by a PreToolUse hook: ${pre[pre.length - 1]?.output ?? ""}` };
      }
    }

    const result = await this.dispatch(call, signal);

    if (hooks) {
      const paths = call.name === "apply_patch" ? patchPaths(str(call.arguments, "patch")) : [];
      const post = await runHooks(hooks, {
        event: "PostToolUse",
        tool: call.name,
        paths,
        cwd,
        payload: { ok: result.ok },
        ...(signal ? { signal } : {}),
      });
      for (const h of post) this.opts.onHook?.("PostToolUse", h.label, h.ok);
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

  private async dispatch(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult> {
    const cwd = this.opts.cwd;
    const args = call.arguments;
    switch (call.name) {
      case "bash":
        return runBash(
          str(args, "command"),
          cwd,
          (num(args, "timeout_s") ?? 120) * 1000,
          this.policy,
          () => this.scratchDir(),
          signal,
        );

      case "term": {
        const r = await this.shell.send(str(args, "keystrokes"), num(args, "duration_s") ?? 1, signal);
        if (!r.alive) {
          // Saying so beats returning empty output that reads as "nothing
          // happened yet" for the rest of the session.
          return {
            ok: false,
            output: `${r.output}\n(the terminal session has exited${r.exitCode !== undefined ? ` with code ${r.exitCode}` : ""}; the next \`term\` call will start a fresh shell)`.trim(),
          };
        }
        return { ok: true, output: r.output || "(no output yet — send empty keystrokes to wait longer)" };
      }

      case "read":
        return readSlice(str(args, "path"), cwd, num(args, "offset"), num(args, "limit"));

      case "apply_patch": {
        // argv and stdin, never a shell. The patch is data: a heredoc
        // delimiter, a backtick or a `$(...)` inside it is text here, and a
        // program if it goes through a shell.
        const r = await runShell("git", {
          argv: ["apply", "--whitespace=nowarn", "-"],
          cwd,
          stdin: str(args, "patch"),
          timeoutMs: this.timeoutMs,
          ...(signal ? { signal } : {}),
        });
        if (r.aborted) return { ok: false, output: "(cancelled)" };
        return { ok: r.code === 0, output: r.output.trim() || (r.code === 0 ? "applied" : `(exit ${r.code})`) };
      }

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
            return {
              ok: false,
              output: `${head}subagent did not finish (${out.reason})${out.summary ? `: ${out.summary}` : ""}`,
            };
          }
          return { ok: true, output: `${head}${out.summary ?? "(no summary)"}` };
        } catch (err) {
          return { ok: false, output: String(err) };
        }
      }

      case "mcp": {
        const callMcp = this.opts.callMcp;
        if (!callMcp) return { ok: false, output: "no MCP servers are connected" };
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
          return { ok: true, output: await callMcp(str(args, "server"), str(args, "method"), parsed) };
        } catch (err) {
          return { ok: false, output: String(err) };
        }
      }

      case "done":
        // Handled by the loop, which owns the two-step confirmation.
        return { ok: true, output: "" };

      default:
        return { ok: false, output: `unknown tool: ${call.name}` };
    }
  }

  close(): void {
    this.shell.close();
  }
}
