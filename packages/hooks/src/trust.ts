/**
 * Deciding whether a repository is allowed to run commands on this machine.
 *
 * The harness used to read `.motif/settings.json` out of the current working
 * directory and run whatever hook commands it found, in a shell, with the full
 * process environment inherited. Cloning a repository and opening it was
 * therefore sufficient to execute arbitrary code as the user and to hand that
 * code every API token, the SSH agent socket and any cloud credentials in the
 * environment. Nothing asked, nothing logged.
 *
 * The fix has two halves, and both matter.
 *
 * **The trust decision cannot live in the repository.** A file inside the thing
 * being trusted cannot authorise itself. Trust records live in the user's
 * config directory and are keyed by canonical path *and* by the SHA-256 of the
 * settings content, so a repository that changes its hooks after approval has
 * to ask again — the interesting attack is a project that is benign when you
 * approve it and is not on the next `git pull`.
 *
 * **Approval is not the same as unrestricted execution.** An approved hook
 * still runs with an allowlisted environment. There is no reason for a
 * formatter to see `AWS_SECRET_ACCESS_KEY`, and no way to know in advance that
 * it will not look.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface TrustRecord {
  /** Canonical, symlink-resolved path. Trust is about a directory on disk. */
  path: string;
  settingsSha256: string;
  approvedAt: string;
  capabilities: string[];
  remoteUrl?: string;
  baseCommit?: string;
}

export interface TrustStore {
  version: 1;
  records: TrustRecord[];
}

export function settingsHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Resolve a path the way the trust check must.
 *
 * Through symlinks, and to an absolute path. A record keyed by the path as
 * typed would be bypassable with `./repo`, `repo/../repo`, or a symlink
 * pointing at an approved directory from an unapproved one.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function trustStorePath(home = homedir()): string {
  return join(home, ".motif", "trust.json");
}

export function loadTrustStore(path = trustStorePath()): TrustStore {
  if (!existsSync(path)) return { version: 1, records: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TrustStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return { version: 1, records: [] };
    return parsed;
  } catch {
    // An unreadable trust store means nothing is trusted. Failing open here
    // would turn a corrupt file into permission to run anything.
    return { version: 1, records: [] };
  }
}

export function saveTrustStore(store: TrustStore, path = trustStorePath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export type TrustDecision =
  | { trusted: true; record: TrustRecord }
  | { trusted: false; reason: "not_approved" | "settings_changed"; detail: string };

export function checkTrust(
  store: TrustStore,
  repoPath: string,
  settingsContent: string,
): TrustDecision {
  const path = canonicalPath(repoPath);
  const hash = settingsHash(settingsContent);
  const record = store.records.find((r) => r.path === path);
  if (!record) {
    return {
      trusted: false,
      reason: "not_approved",
      detail: `${path} has project hooks but has never been approved to run commands on this machine`,
    };
  }
  if (record.settingsSha256 !== hash) {
    return {
      trusted: false,
      reason: "settings_changed",
      detail:
        `${path} was approved with a different .motif/settings.json (approved ${record.settingsSha256.slice(0, 12)}, ` +
        `found ${hash.slice(0, 12)}). Hooks changed since approval and need re-approving`,
    };
  }
  return { trusted: true, record };
}

export function approve(
  store: TrustStore,
  repoPath: string,
  settingsContent: string,
  capabilities: string[] = ["hooks"],
): TrustStore {
  const path = canonicalPath(repoPath);
  const record: TrustRecord = {
    path,
    settingsSha256: settingsHash(settingsContent),
    approvedAt: new Date().toISOString(),
    capabilities,
  };
  return {
    version: 1,
    records: [...store.records.filter((r) => r.path !== path), record],
  };
}

/* ------------------------------------------------------------------ */

/**
 * The environment a hook is allowed to see.
 *
 * An allowlist rather than a denylist. A denylist has to enumerate every
 * secret-shaped variable in advance and is wrong the first time someone
 * invents a new one; an allowlist is wrong in the direction of a hook that
 * needs an extra variable and says so.
 */
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TMPDIR", "HOME", "SHELL", "TERM"];

export function hookEnvironment(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  // Harness-authored variables are always passed; they are ours, not the
  // user's, and a hook needs them to know what just happened.
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith("MOTIF_")) env[k] = v;
  }
  return env;
}

/** Variables a hook must never see, checked by tests rather than assumed. */
export const FORBIDDEN_ENV_PREFIXES = [
  "AWS_",
  "GITHUB_",
  "OPENAI_",
  "ANTHROPIC_",
  "HF_",
  "SSH_AUTH_SOCK",
  "GPG_",
  "NPM_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
];
