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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  /** Runs a subagent; supplied by the CLI so this module stays loop-agnostic. The call id lets it report progress against the parent's cell. */
  runAgent?: (agent: string, prompt: string, callId?: string) => Promise<SubagentOutcome>;
  /** Called for MCP proxy calls. Absent means no servers are connected. */
  callMcp?: (server: string, method: string, args: unknown) => Promise<string>;
  onHook?: (event: HookEvent, label: string, ok: boolean) => void;
  timeoutMs?: number;
  /**
   * Asked before a tool that changes the world runs — bash, write, a patch,
   * the terminal, an MCP call. Absent, everything runs. The interactive
   * session supplies one that puts the question to the person; a denial goes
   * back to the model as a result it can act on, not as an error.
   */
  confirm?: (call: ToolInvocation) => Promise<"allow" | "deny">;
}

/** The tools a confirmation gate applies to. Reading and delegating are not among them. */
export const CONFIRMED_TOOLS: ReadonlySet<string> = new Set(["bash", "write", "apply_patch", "term", "mcp"]);

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
/** The string the shell must print before it is considered started. */
export function readinessMarker(pid: number, generation: number): string {
  return `__motif_ready_${pid}_${generation}__`;
}

/**
 * The command that makes the shell print `marker`, written so that the command
 * itself does not contain it.
 *
 * An interactive bash with a prompt echoes what it is sent. If the command and
 * the output read the same, the reader matches the echo, consumes up to there,
 * and hands the real marker line back as the first `term` call's output.
 * Splitting the literal across two adjacent shell strings keeps the two
 * distinguishable — the shell concatenates them, the search does not.
 */
export function readinessProbe(marker: string): string {
  const split = marker.length >> 1;
  return `echo "${marker.slice(0, split)}""${marker.slice(split)}"\n`;
}

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
   *
   * The marker is split across two adjacent shell strings so that the command
   * and its output do not contain the same text. An interactive bash with a
   * prompt echoes what it was sent — which is most machines, and was not the
   * one this was written on — and searching for an unsplit marker then finds
   * the echo, consumes up to there, and leaves the real output line sitting in
   * the buffer to be returned as the first call's result.
   */
  private async waitUntilStarted(proc: ChildProcess, generation: number): Promise<void> {
    const marker = readinessMarker(process.pid, generation);
    proc.stdin?.write(readinessProbe(marker));
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

/**
 * Write a file whole, without a shell anywhere in the path.
 *
 * This exists because of what the model did when it did not exist. Given only
 * `apply_patch` and `bash`, it wrote files through heredocs — and said so:
 * "Let me rewrite the file directly using bash to avoid patch issues", "I'll
 * use a Python script to write the file to avoid shell escaping issues". Over
 * one campaign, 85% of its edit attempts went through the shell, and the same
 * file was rewritten up to ten times in a single task; roughly a third of every
 * token it generated was a file it had already written once.
 *
 * A heredoc puts the file's contents through the shell, so every backtick, `$`
 * and quote in the content becomes an escaping problem the model has to solve
 * on top of the actual task. Here the content is an argument. Nothing in it is
 * interpreted.
 *
 * Parent directories are created because the alternative is a `mkdir -p` turn,
 * and a turn costs a model request.
 */
function writeFile(path: string, content: string, cwd: string): ToolResult {
  try {
    const target = resolve(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    const existed = existsSync(target);
    writeFileSync(target, content, "utf8");
    const lines = content === "" ? 0 : content.split("\n").length;
    return {
      ok: true,
      output: `${existed ? "replaced" : "created"} ${path} (${lines} lines, ${Buffer.byteLength(content, "utf8")} bytes)`,
    };
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

/**
 * One line naming the likely cause of a rejected patch.
 *
 * `git apply` reports what it found, not what to do about it, and its wording
 * assumes a human who knows the diff format. Across a campaign of failures the
 * causes fell into three buckets and none of them are guessable from git's own
 * message: a diff with no `+++` header at all, a header naming a path that is
 * not in the tree, and hunks whose context does not match the file — which for
 * a model usually means it diffed against what it believes the file contains
 * rather than reading it first.
 *
 * The hint is appended, never substituted: git's message is the evidence and
 * hiding it would make a wrong hint unfalsifiable.
 */
export function patchHint(patch: string, gitOutput: string): string {
  const hasHeader = /^\+\+\+ /m.test(patch) && /^--- /m.test(patch);
  if (!hasHeader) {
    return "\nhint: no `--- a/path` and `+++ b/path` header pair was found."
      + " A bare `@@` hunk cannot be applied — say which file it belongs to.";
  }
  if (/does not exist in index|No such file or directory|new file/i.test(gitOutput)) {
    return "\nhint: the path in the header is not in the tree."
      + " Check it, and for a file being created use `--- /dev/null`.";
  }
  if (/patch failed|while searching for|does not apply/i.test(gitOutput)) {
    return "\nhint: the context lines do not match the file."
      + " Read the file and diff against what it actually contains.";
  }
  return "";
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
      fullPolicy(opts.cwd, ["done", "bash", "read", "write", "apply_patch", "term", "skill", "task", "mcp"]);
  }

  async run(call: ToolInvocation, signal?: AbortSignal): Promise<ToolResult> {
    const { cwd, hooks } = this.opts;

    // Policy first. A call the agent is not allowed to make should not reach a
    // hook, which might have side effects of its own.
    const decision = approve(this.policy, call);
    if (!decision.allowed) {
      return { ok: false, output: `refused by execution policy: ${decision.reason}` };
    }

    if (this.opts.confirm && CONFIRMED_TOOLS.has(call.name)) {
      const verdict = await this.opts.confirm(call);
      if (verdict === "deny") {
        // Worded for the model: what happened, and what to do about it. Not
        // a failure — nothing broke — so it does not start a repair turn
        // telling the model to read the error and fix it.
        return {
          ok: true,
          output: "The person declined this tool call. Do not retry it as it was; ask what they would prefer, or take a different approach.",
        };
      }
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
      const paths =
        call.name === "apply_patch"
          ? patchPaths(str(call.arguments, "patch"))
          : call.name === "write"
            ? [str(call.arguments, "path")]
            : [];
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

      case "write":
        return writeFile(str(args, "path"), str(args, "content"), cwd);

      case "apply_patch": {
        // argv and stdin, never a shell. The patch is data: a heredoc
        // delimiter, a backtick or a `$(...)` inside it is text here, and a
        // program if it goes through a shell.
        //
        // Three departures from a bare `git apply`, each one measured against
        // a campaign in which this tool failed 11 times out of 12 and the
        // model gave up on it and rewrote whole files through `bash` instead.
        //
        // A trailing newline is added when the model left it off. `git apply`
        // requires the patch to end in one and reports its absence as "corrupt
        // patch at line N", pointing at the last line rather than at the
        // missing byte after it. Five of those eleven patches ended without a
        // newline.
        //
        // `--recount` derives hunk line counts from the hunk body instead of
        // trusting the `@@` header. Getting `@@ -1,5 +1,7 @@` right means
        // counting two interleaved sequences by hand, and the counts were
        // wrong far more often than the diff itself was. Neither of these two
        // is sufficient alone: on the one patch where both applied, the
        // newline alone still failed and `--recount` alone still failed.
        //
        // `LC_ALL=C` because git speaks the host's language otherwise. On the
        // box this was measured on, the model was being handed
        // "error: 패치가 14번 줄에서 망가졌습니다" and asked to repair from it.
        // It also means the tool behaves the same on every machine, which a
        // harness that reports numbers has to.
        const patch = str(args, "patch");
        const r = await runShell("git", {
          argv: ["apply", "--whitespace=nowarn", "--recount", "-"],
          cwd,
          stdin: patch.endsWith("\n") ? patch : `${patch}\n`,
          env: { ...process.env, LC_ALL: "C", LANG: "C" },
          timeoutMs: this.timeoutMs,
          ...(signal ? { signal } : {}),
        });
        if (r.aborted) return { ok: false, output: "(cancelled)" };
        if (r.code === 0) return { ok: true, output: r.output.trim() || "applied" };
        const git = r.output.trim();
        return { ok: false, output: `${git || `(exit ${r.code})`}${patchHint(patch, git)}` };
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
          const out = await run(str(args, "agent"), prompt, call.id);
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
