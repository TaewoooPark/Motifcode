/**
 * A read-only filesystem for agents that are supposed to have one.
 *
 * The explorer and reviewer need to *search* — one `rg -n` is worth five file
 * reads, and taking `bash` away from them to make them safe would make them
 * close to useless. But a tool that runs programs can write, and "please do not
 * modify anything" in a system prompt is a request rather than a boundary.
 *
 * So the boundary goes where the process is created. Where the OS offers a
 * read-only view of the filesystem, the command runs inside it and writes fail
 * with EPERM regardless of what the command is — which is the property a
 * blocklist of `rm`, `sed -i`, `tee`, `>` and `python -c` can never have,
 * because that list is never finished.
 *
 * One directory stays writable, outside the workspace, and `TMPDIR` points at
 * it. Denying every write breaks ordinary tools that stage output in a temp
 * file, and the fix for that must not be "allow /tmp" — a benchmark workspace
 * often *is* under /tmp, and a rule that happens to cover the thing being
 * protected protects nothing.
 *
 * Where no sandbox is available the capability is withdrawn rather than
 * assumed. Degrading closed costs an explorer its search on an unsupported
 * host; degrading open costs a repository, silently, on the day a model tries
 * something unexpected.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxKind = "bubblewrap" | "sandbox-exec" | "none";

export interface WrapOptions {
  /** Where the command runs. Read-only. */
  cwd: string;
  /** The one writable directory, outside the workspace. */
  scratch: string;
}

export interface Sandbox {
  kind: SandboxKind;
  /** Human-readable reason when `kind` is "none". */
  reason?: string;
  /**
   * Wrap a shell command so it cannot write outside `scratch`.
   *
   * Returns argv. Null when this sandbox cannot provide the guarantee, which
   * the caller must treat as "do not run the command".
   */
  wrap(command: string, opts: WrapOptions): string[] | null;
}

function has(binary: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${binary}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const NONE = (reason: string): Sandbox => ({ kind: "none", reason, wrap: () => null });

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * bubblewrap: the whole filesystem read-only, one writable bind.
 *
 * `--die-with-parent` matters as much as the read-only bind: without it a
 * backgrounded process outlives the sandbox and keeps running unsupervised.
 */
function bubblewrap(): Sandbox {
  return {
    kind: "bubblewrap",
    wrap: (command, { cwd, scratch }) => [
      "bwrap",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--bind", canonical(scratch), canonical(scratch),
      "--setenv", "TMPDIR", canonical(scratch),
      "--unshare-net",
      "--die-with-parent",
      "--chdir", cwd,
      "/bin/sh", "-c", command,
    ],
  };
}

/**
 * macOS `sandbox-exec`: deprecated, present everywhere, and sufficient here.
 *
 * Local development only. Benchmark runs belong in a container, and a
 * deprecated interface is not something to base a published measurement on.
 */
function sandboxExec(): Sandbox {
  return {
    kind: "sandbox-exec",
    wrap: (command, { cwd, scratch }) => {
      const dir = canonical(scratch);
      const profile = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        `(allow file-write* (subpath ${str(dir)}))`,
        // Writing to the standard streams and /dev/null is not filesystem
        // modification in any sense the caller cares about, and denying it
        // breaks almost every command.
        '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
        "(deny network*)",
      ].join(" ");
      return [
        "sandbox-exec",
        "-p",
        profile,
        "/bin/sh",
        "-c",
        `export TMPDIR=${shellQuote(dir)}; cd ${shellQuote(cwd)} && ${command}`,
      ];
    },
  };
}

/** Scheme-style string literal, for the sandbox profile. */
function str(s: string): string {
  return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

let cached: Sandbox | undefined;

/** The best read-only sandbox this host offers. Probed once. */
export function detectSandbox(): Sandbox {
  if (cached) return cached;
  if (platform() === "linux") {
    cached = has("bwrap")
      ? bubblewrap()
      : NONE("bubblewrap is not installed; `apt install bubblewrap` gives read-only agents a real boundary");
  } else if (platform() === "darwin") {
    cached = has("sandbox-exec")
      ? sandboxExec()
      : NONE("sandbox-exec is unavailable on this macOS build");
  } else {
    cached = NONE(`no read-only sandbox is implemented for ${platform()}`);
  }
  return cached;
}

/** Exposed for tests, which need to exercise both the present and absent cases. */
export function setSandbox(sandbox: Sandbox | undefined): void {
  cached = sandbox;
}

/** A writable directory outside any workspace, created once per executor. */
export function makeScratch(): string {
  return mkdtempSync(join(tmpdir(), "motif-scratch-"));
}
