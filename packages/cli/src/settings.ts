/**
 * Settings on disk, the way Claude Code keeps them.
 *
 * Two files, one shape. `~/.motif/settings.json` is the person's: what they
 * chose with `/model`, `/theme` and the rest, remembered across sessions.
 * `<repo>/.motif/settings.json` is the project's, and it already carries the
 * hooks. The project file outranks the user file — a repository knows better
 * than a person's defaults which channel and budgets its tasks want — but it
 * is read only once the repository is trusted, for the same reason the hooks
 * are: a cloned repository must not be able to point the harness, and the
 * credential it sends, at an endpoint of its choosing.
 *
 * Above both sit the environment and the command line, which is where a
 * one-off override belongs. Nothing here touches the credential; that stays
 * in `.env`, which is a different kind of file with a different threat model.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChannelId } from "@motifcode/protocol";

export interface StoredSettings {
  model?: string;
  endpoint?: string;
  channel?: ChannelId;
  maxTurns?: number;
  maxOutputTokens?: number;
  seed?: number;
  theme?: string;
  /** Show the model's reasoning in the transcript. */
  thinking?: boolean;
  /** Fraction of the context window at which the transcript is compacted. */
  compactAt?: number;
  /** Whether the session asks before a tool that changes the world runs. */
  permissions?: "ask" | "auto";
}

export type SettingsSource = "project" | "user" | "default";

export interface LoadedSettings {
  values: StoredSettings;
  sources: Partial<Record<keyof StoredSettings, SettingsSource>>;
  userPath: string;
  projectPath: string;
  /** False when the project file exists but the repository is not trusted. */
  projectApplied: boolean;
}

const KEYS: readonly (keyof StoredSettings)[] = [
  "model",
  "endpoint",
  "channel",
  "maxTurns",
  "maxOutputTokens",
  "seed",
  "theme",
  "thinking",
  "compactAt",
  "permissions",
];

export function userSettingsPath(home = homedir()): string {
  return join(home, ".motif", "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".motif", "settings.json");
}

/**
 * Read one file's recognised keys, ignoring what is not a setting.
 *
 * Unknown keys are left alone rather than rejected: the project file also
 * holds `hooks`, and a future key must not make an older build refuse the
 * file. A value of the wrong type is skipped and reported, not applied.
 */
export function parseSettings(text: string): { values: StoredSettings; problems: string[] } {
  const values: StoredSettings = {};
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { values, problems: [`not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { values, problems: ["not a JSON object"] };
  const obj = raw as Record<string, unknown>;
  const str = (k: "model" | "endpoint" | "theme"): void => {
    if (obj[k] === undefined) return;
    if (typeof obj[k] === "string" && obj[k] !== "") values[k] = obj[k] as string;
    else problems.push(`${k} must be a non-empty string`);
  };
  str("model");
  str("endpoint");
  str("theme");
  if (obj["channel"] !== undefined) {
    if (obj["channel"] === "toolcall" || obj["channel"] === "object" || obj["channel"] === "raw") values.channel = obj["channel"];
    else problems.push("channel must be toolcall, object or raw");
  }
  const int = (k: "maxTurns" | "maxOutputTokens" | "seed", min: number): void => {
    if (obj[k] === undefined) return;
    const v = obj[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= min) values[k] = v;
    else problems.push(`${k} must be an integer >= ${min}`);
  };
  int("maxTurns", 1);
  int("maxOutputTokens", 1);
  int("seed", 0);
  if (obj["thinking"] !== undefined) {
    if (typeof obj["thinking"] === "boolean") values.thinking = obj["thinking"];
    else problems.push("thinking must be true or false");
  }
  if (obj["compactAt"] !== undefined) {
    const v = obj["compactAt"];
    if (typeof v === "number" && v > 0 && v <= 1) values.compactAt = v;
    else problems.push("compactAt must be a fraction between 0 and 1");
  }
  if (obj["permissions"] !== undefined) {
    if (obj["permissions"] === "ask" || obj["permissions"] === "auto") values.permissions = obj["permissions"];
    else problems.push("permissions must be ask or auto");
  }
  return { values, problems };
}

export interface LoadOptions {
  cwd: string;
  home?: string;
  /** Whether the project file's contents may be applied; given the file's text. */
  projectTrusted?: (content: string) => boolean;
  /** Where to report a file that could not be read as settings. */
  warn?: (message: string) => void;
}

export function loadSettings(opts: LoadOptions): LoadedSettings {
  const userPath = userSettingsPath(opts.home);
  const projectPath = projectSettingsPath(opts.cwd);
  const values: StoredSettings = {};
  const sources: LoadedSettings["sources"] = {};
  let projectApplied = false;

  const apply = (path: string, source: SettingsSource, gate?: (content: string) => boolean): boolean => {
    if (!existsSync(path)) return false;
    const content = readFileSync(path, "utf8");
    if (gate && !gate(content)) return false;
    const { values: found, problems } = parseSettings(content);
    for (const p of problems) opts.warn?.(`${path}: ${p}`);
    for (const k of KEYS) {
      if (found[k] !== undefined) {
        (values as Record<string, unknown>)[k] = found[k];
        sources[k] = source;
      }
    }
    return true;
  };

  apply(userPath, "user");
  projectApplied = apply(projectPath, "project", opts.projectTrusted ?? (() => false));
  return { values, sources, userPath, projectPath, projectApplied };
}

/**
 * Remember one choice in the person's file.
 *
 * Merged into whatever is there, and written whole; `undefined` removes the
 * key. The project file is never written by the harness — it is the
 * repository's, and belongs in its history.
 */
export function saveUserSetting<K extends keyof StoredSettings>(
  key: K,
  value: StoredSettings[K] | undefined,
  home = homedir(),
): string {
  const path = userSettingsPath(home);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {
      // A file that does not parse is replaced: leaving it means every later
      // save fails the same way, and the person never learns why.
    }
  }
  if (value === undefined) delete current[key];
  else current[key] = value;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n", "utf8");
  return path;
}
