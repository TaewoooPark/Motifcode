/**
 * Killing a shell command and everything it started.
 *
 * `spawn(cmd, { shell: true })` gives you a shell, not the program you asked
 * for. Killing that shell leaves its children running, and on Linux those
 * children hold the inherited stdio pipes open, so `close` never fires and the
 * caller waits forever. On macOS the same code happens to work, which is how
 * this survived local testing and only failed in CI — on the platform the
 * harness actually deploys to.
 *
 * The fix is to put the command in its own process group and signal the group.
 * Both the timeout path and the ordinary bash tool need it, so it lives here.
 */

import { spawn, type SpawnOptions } from "node:child_process";

export interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  ms: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Characters of combined stdout+stderr to keep. */
  outputCap?: number;
}

/** SIGKILL the whole group; the leader alone is not enough. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or the platform refused a group signal — fall back to the
    // leader so we at least do not leave the obvious process behind.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* nothing left to kill */
    }
  }
}

export function runShell(command: string, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const cap = opts.outputCap ?? 200_000;

  return new Promise((resolve) => {
    const spawnOpts: SpawnOptions = {
      shell: true,
      // Its own process group, so one signal reaches every descendant.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
    if (opts.env !== undefined) spawnOpts.env = opts.env;

    const child = spawn(command, spawnOpts);

    let out = "";
    const collect = (chunk: Buffer) => {
      const room = cap - out.length;
      if (room <= 0) return;
      out += chunk.toString().slice(0, room);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: out, timedOut, ms: Date.now() - started });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      // Resolve on a short grace period rather than waiting for `close`: a
      // grandchild may still hold the pipes, which is the whole failure this
      // module exists to avoid.
      setTimeout(() => finish(null), 200);
    }, opts.timeoutMs);

    // `exit` fires when the process ends; `close` waits for stdio, which can
    // outlive it. Prefer `close` when it comes, but never depend on it.
    child.on("close", (code) => finish(code));
    child.on("exit", (code) => setTimeout(() => finish(code), 50));
    child.on("error", (err) => {
      out += String(err);
      finish(null);
    });
  });
}
