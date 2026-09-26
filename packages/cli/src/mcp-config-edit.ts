import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { configHash, defaultMcpConfigPath, parseMcpConfig, type McpConfig, type McpServerConfig } from "../../mcp/src/config.js";

export interface McpConfigEditOptions { cwd?: string; home?: string; path?: string; trustHash?: string }
export interface McpConfigEditResult { path: string; sha256: string; config: McpConfig }
export class McpConfigEditError extends Error {
  constructor(readonly code: string, message: string, readonly sha256?: string) { super(message); this.name = "McpConfigEditError"; }
}
const LIMIT = 2 * 1024 * 1024;
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
function snapshot(path: string): { text: string; stat: Stats } | undefined {
  let stat: Stats;
  try { stat = lstatSync(path); } catch (error) { if (missing(error)) return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new McpConfigEditError("unsafe_config", "The selected configuration must be a regular file, not a symbolic link.");
  if (stat.size > LIMIT) throw new McpConfigEditError("config_too_large", "The selected configuration exceeds the 2 MiB edit limit.");
  return { text: readFileSync(path, "utf8"), stat };
}
function same(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>): boolean {
  return before === undefined ? after === undefined : after !== undefined && before.stat.dev === after.stat.dev && before.stat.ino === after.stat.ino && before.text === after.text;
}

type Entry = Record<string, unknown>;
/**
 * Write the edit into the document as authored: keep its servers shape (array
 * or object) and version, copy untouched entries verbatim, and apply only the
 * fields that actually changed. Parsing adds defaults and resolves relative
 * cwd values; those normalizations must not be written back.
 */
function authoredDocument(text: string | undefined, before: McpServerConfig[], after: McpServerConfig[]): unknown {
  if (text === undefined) return { version: 1, servers: after };
  const document = JSON.parse(text) as { version?: unknown; servers: Entry[] | Record<string, Entry> };
  const objectForm = !Array.isArray(document.servers);
  const raw = new Map<string, Entry>(objectForm
    ? Object.entries(document.servers as Record<string, Entry>)
    : (document.servers as Entry[]).map((entry) => [String(entry.id), entry]));
  const original = new Map(before.map((server) => [server.id, server as unknown as Entry]));
  const entries = after.map((server): [string, Entry] => {
    const next = server as unknown as Entry;
    const authored = raw.get(server.id); const previous = original.get(server.id);
    if (!authored || !previous) {
      const { id: _id, ...rest } = next;
      return [server.id, objectForm ? rest : next];
    }
    if (isDeepStrictEqual(previous, next)) return [server.id, authored];
    const edited: Entry = structuredClone(authored);
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (key === "id" || isDeepStrictEqual(previous[key], next[key])) continue;
      if (next[key] === undefined) delete edited[key]; else edited[key] = structuredClone(next[key]);
    }
    return [server.id, edited];
  });
  const servers = objectForm ? Object.fromEntries(entries) : entries.map(([, entry]) => entry);
  return { ...(document.version !== undefined ? { version: document.version } : {}), servers };
}

/** One synchronous transaction; no server startup, secret expansion, or network access. */
export function updateMcpConfig(options: McpConfigEditOptions, update: (config: McpConfig) => McpConfig): McpConfigEditResult {
  const path = options.path ? resolve(options.cwd ?? process.cwd(), options.path) : defaultMcpConfigPath(options.home);
  const directory = dirname(path);
  const lockPath = path + ".lock";
  let lock: number | undefined;
  let temp: string | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new McpConfigEditError("config_locked", "Another configuration edit holds the lock. Retry after it finishes; investigate stale locks before removing them.");
      throw error;
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid }) + "\n");
    const before = snapshot(path);
    // New files contain only the explicitly requested configuration. Existing
    // project files still require approval of the exact bytes being replaced.
    if (options.path && before && options.trustHash !== configHash(before.text)) {
      const sha256 = configHash(before.text);
      throw new McpConfigEditError("untrusted_config", "Review the exact configuration and pass its SHA256 with --trust-mcp before editing.", sha256);
    }
    const parsed = before ? parseMcpConfig(before.text, path) : { servers: [], diagnostics: [] };
    if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) throw new McpConfigEditError("invalid_config", "The existing MCP configuration is invalid; it was not overwritten. Repair it manually first.");
    const changed = update({ servers: structuredClone(parsed.servers) });
    const text = JSON.stringify(authoredDocument(before?.text, parsed.servers, changed.servers), null, 2) + "\n";
    if (Buffer.byteLength(text) > LIMIT) throw new McpConfigEditError("config_too_large", "The edited configuration exceeds the 2 MiB limit.");
    const checked = parseMcpConfig(text, path);
    if (checked.diagnostics.some((diagnostic) => diagnostic.severity === "error")) throw new McpConfigEditError("invalid_server", "The server configuration is invalid. Check transport fields, URL, profile, protocol and environment/header references; no changes were saved.");
    temp = path + "." + randomUUID() + ".tmp";
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    if (!same(before, snapshot(path))) throw new McpConfigEditError("config_changed", "The configuration changed during this edit; no changes were saved. Review the latest file and retry.");
    renameSync(temp, path); temp = undefined;
    // Persist the rename where directory fsync is supported. Failure here must
    // not report the already-committed edit as if it had not happened.
    let dirFd: number | undefined;
    try { dirFd = openSync(directory, "r"); fsyncSync(dirFd); } catch { /* platform-dependent */ }
    finally { if (dirFd !== undefined) closeSync(dirFd); }
    return { path, sha256: configHash(text), config: { servers: checked.servers } };
  } catch (error) {
    if (error instanceof McpConfigEditError) throw error;
    // Filesystem exception messages may contain user-provided secret values.
    throw new McpConfigEditError("config_write_failed", "Could not safely update the MCP configuration. Check file access and retry.");
  } finally {
    if (temp) try { unlinkSync(temp); } catch { /* own temporary file only */ }
    if (lock !== undefined) {
      try {
        const held = fstatSync(lock); const current = lstatSync(lockPath);
        if (held.dev === current.dev && held.ino === current.ino) unlinkSync(lockPath);
      } catch { /* never remove a replacement lock */ }
      closeSync(lock);
    }
  }
}

export type McpConfigEdit = { kind: "add"; server: McpServerConfig } | { kind: "remove" | "enable" | "disable"; id: string };
export function editMcpConfig(edit: McpConfigEdit, options: McpConfigEditOptions = {}): McpConfigEditResult {
  return updateMcpConfig(options, (config) => {
    const id = edit.kind === "add" ? edit.server.id : edit.id;
    const index = config.servers.findIndex((server) => server.id === id);
    if (edit.kind === "add") {
      if (index >= 0) throw new McpConfigEditError("duplicate_server", "A server with this name already exists; remove it explicitly before replacing it.");
      config.servers.push(structuredClone(edit.server));
    } else {
      if (index < 0) throw new McpConfigEditError("server_not_found", "The requested MCP server is not configured.");
      if (edit.kind === "remove") config.servers.splice(index, 1);
      else config.servers[index]!.enabled = edit.kind === "enable";
    }
    return config;
  });
}

/** Display identifiers and reference names, never stored argument/header/env values. */
export function summarizeMcpServer(server: McpServerConfig): Record<string, unknown> {
  const references = (map: McpServerConfig["env"]) => map === undefined ? undefined : Object.fromEntries(Object.entries(map).map(([name, value]) => [name,
    typeof value === "object" ? { env: value.env } : { value: "[withheld]", env: [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)].map((match) => match[1]) },
  ]));
  return { id: server.id, enabled: server.enabled, transport: server.transport, protocol: server.protocol, profile: server.profile, credentialProvider: server.credentialProvider,
    ...(server.command !== undefined ? { command: "[withheld]", argumentCount: server.args?.length ?? 0 } : {}),
    ...(server.cwd !== undefined ? { cwd: "[withheld]" } : {}), ...(server.url !== undefined ? { url: "[withheld]" } : {}),
    env: references(server.env), envVars: server.envVars, headers: references(server.headers), allowedTools: server.allowedTools, deniedTools: server.deniedTools,
  };
}
