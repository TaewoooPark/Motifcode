import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Node's mode bits do not create private ACLs on Windows. Create the staging
// file with an explicit user-only DACL before the first byte, then use native
// replacement to preserve an existing destination's ACL and metadata.
const replaceWindowsFile = [
  "$ErrorActionPreference='Stop'",
  "$temp=$env:MOTIF_STAGING_PATH; $target=$env:MOTIF_TARGET_PATH",
  "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl=[Security.AccessControl.FileSecurity]::new()",
  "$acl.SetAccessRuleProtection($true,$false)",
  "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))",
  "$file=[IO.FileStream]::new($temp,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$acl)",
  "try { [Console]::OpenStandardInput().CopyTo($file); $file.Flush($true) } finally { $file.Dispose() }",
  "if ([IO.File]::Exists($target)) { [IO.File]::Replace($temp,$target,[NullString]::Value) } else { [IO.File]::Move($temp,$target) }",
].join("\n");

/**
 * Publish a unique intent before reading. Two live writers cannot both enter:
 * either one already published when the other scanned, or both see a conflict.
 * A crashed writer leaves only an empty PID/UUID marker, never credentials.
 */
export function updatePrivateFile(path: string, update: (current: string | undefined) => string | undefined): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const target = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : resolve(path);
  const claim = claimUpdate(target);
  try {
    const previous = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    const next = update(previous);
    if (next === undefined) return false;
    if (previous === next) {
      if (process.platform !== "win32" && (statSync(target).mode & 0o777) !== 0o600) chmodSync(target, 0o600);
      return false;
    }
    replacePrivateFile(target, next);
    return true;
  } finally {
    rmSync(claim, { force: true });
  }
}

function claimUpdate(target: string): string {
  const directory = dirname(target);
  const prefix = "." + basename(target).toLowerCase() + ".motif-write-";
  const marker = prefix + process.pid + "-" + randomUUID();
  const claim = join(directory, marker);
  const deadline = Date.now() + 2_000;
  for (;;) {
    writeFileSync(claim, "", { flag: "wx", mode: 0o600 });
    let contender: number | undefined;
    try {
      for (const entry of readdirSync(directory)) {
        if (entry === marker || !entry.startsWith(prefix)) continue;
        const match = /^(\d+)-[a-f\d-]{36}$/.exec(entry.slice(prefix.length));
        if (!match) continue;
        const pid = Number(match[1]);
        try { process.kill(pid, 0); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") {
            // Each process and acquisition has its own unique name. Removing
            // an abandoned claim cannot remove a new writer's claim.
            rmSync(join(directory, entry), { force: true });
            continue;
          }
        }
        contender = pid;
        break;
      }
      if (contender === undefined) return claim;
    } catch (err) {
      rmSync(claim, { force: true });
      throw err;
    }
    rmSync(claim, { force: true });
    if (contender === process.pid || Date.now() >= deadline) {
      throw new Error("Another Motif process is updating " + target + ". Try again after it finishes.");
    }
    // Release our intent before waiting, so an overlapping writer can finish.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 + Math.random() * 35);
  }
}

function replacePrivateFile(target: string, contents: string): void {
  const temp = target + "." + randomUUID() + ".tmp";
  try {
    if (process.platform !== "win32") {
      writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
      renameSync(temp, target);
      return;
    }
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const shell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", replaceWindowsFile], {
      input: Buffer.from(contents, "utf8"),
      env: { SystemRoot: systemRoot, MOTIF_STAGING_PATH: temp, MOTIF_TARGET_PATH: target },
      stdio: ["pipe", "ignore", "pipe"], windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Windows could not securely replace " + target + ". Check file permissions and open handles.");
  } finally {
    rmSync(temp, { force: true });
  }
}
