import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type EnvValue = string | { env: string };
/** Public OAuth client settings only. Tokens and client secrets never belong here. */
export interface McpOAuthConfig {
  clientId?: string;
  clientMetadataUrl?: string;
  scope?: string;
  callbackPort?: number;
}
export interface McpServerConfig {
  id: string;
  enabled: boolean;
  transport: "stdio" | "http" | "sse";
  protocol?: "legacy" | "modern" | "auto";
  /** Explicitly opted-in server behavior; never inferred from its name or URL. */
  profile?: "playwright";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, EnvValue>;
  envVars?: string[];
  headers?: Record<string, EnvValue>;
  oauth?: McpOAuthConfig;
  /** Explicit host credential delegation, restricted to its verified service. */
  credentialProvider?: "github-cli";
  allowedTools?: string[];
  deniedTools?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  catalogTtlMs?: number;
}
export interface McpConfig { servers: McpServerConfig[] }
export interface ConfigDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  server?: string;
  field?: string;
}
export interface McpConfigResult extends McpConfig {
  diagnostics: ConfigDiagnostic[];
  sources: { path: string; sha256: string; trusted: boolean }[];
}
export type ResolvedMcpServerConfig = Omit<McpServerConfig, "env" | "headers"> & {
  env: Record<string, string>;
  headers: Record<string, string>;
};

/** These are inherited for process startup, never the caller's complete environment. */
export const BASE_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] as const;
/** Explicit custom headers are supported, excluding transport-owned or ambient credentials. */
const BLOCKED_HEADERS = new Set(["host", "cookie", "set-cookie", "content-length", "transfer-encoding", "connection", "keep-alive", "te", "trailer", "upgrade", "expect"]);
export const PUBLIC_HTTP_HEADERS = new Set(["accept", "accept-language", "content-type", "user-agent", "x-github-api-version"]);
export function isSupportedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !BLOCKED_HEADERS.has(lower)
    && !lower.startsWith("mcp-") && !lower.startsWith("proxy-") && !lower.startsWith("sec-");
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_FIELDS = new Set(["id", "enabled", "transport", "protocol", "profile", "command", "args", "cwd", "url", "env", "envVars", "headers", "oauth", "credentialProvider", "allowedTools", "deniedTools", "startupTimeoutMs", "toolTimeoutMs", "catalogTtlMs"]);
export const GITHUB_MCP_ENDPOINT = "https://api.githubcopilot.com/mcp/";
/** Exact matching prevents credential delegation to lookalikes or redirects. */
export function validateCredentialProvider(server: { credentialProvider?: unknown; transport?: unknown; url?: unknown; oauth?: unknown; headers?: unknown }): void {
  if (server.credentialProvider === undefined) return;
  if (server.credentialProvider !== "github-cli" || server.transport !== "http" || server.url !== GITHUB_MCP_ENDPOINT) throw new Error("The GitHub CLI credential provider requires the official GitHub HTTP MCP endpoint.");
  if (server.oauth !== undefined || isRecord(server.headers) && Object.keys(server.headers).some(name => name.toLowerCase() === "authorization")) throw new Error("Choose the GitHub CLI credential provider, OAuth, or an Authorization header, not more than one.");
}
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const configHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const defaultMcpConfigPath = (home = homedir()): string => join(home, ".motif", "mcp.json");

function isEnvValue(value: unknown): value is EnvValue {
  return typeof value === "string" || (isRecord(value) && Object.keys(value).length === 1 && typeof value.env === "string" && ENV_NAME.test(value.env));
}
export function hasEnvReference(value: EnvValue): boolean {
  return typeof value !== "string" || /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/.test(value);
}

/** Parse without resolving secrets, invoking commands, or accessing network services. */
export function parseMcpConfig(text: string, sourcePath = defaultMcpConfigPath()): McpConfig & { diagnostics: ConfigDiagnostic[] } {
  const diagnostics: ConfigDiagnostic[] = [];
  const error = (code: string, message: string, server?: string, field?: string) => diagnostics.push({ severity: "error", code, message, server, field });
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { servers: [], diagnostics: [{ severity: "error", code: "invalid_json", message: "MCP configuration must be valid JSON." }] }; }
  if (!isRecord(data) || (!Array.isArray(data.servers) && !isRecord(data.servers))) {
    return { servers: [], diagnostics: [{ severity: "error", code: "invalid_config", message: "Expected an object with a servers array or object." }] };
  }
  if (data.version !== undefined && data.version !== 1) error("unsupported_version", "Only configuration version 1 is supported.");
  for (const key of Object.keys(data)) if (!["version", "servers"].includes(key)) error("unknown_field", "Unsupported top-level configuration field.", undefined, key);
  const entries: [string | undefined, unknown][] = Array.isArray(data.servers)
    ? data.servers.map((entry) => [undefined, entry])
    : Object.entries(data.servers);
  const servers: McpServerConfig[] = [];
  const ids = new Set<string>();
  for (const [key, entry] of entries) {
    const start = diagnostics.length;
    if (!isRecord(entry)) { error("invalid_server", "Server entries must be objects.", key); continue; }
    const id = key ?? entry.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) || id === "__motif_host__") {
      error("invalid_id", "Server id must be 1–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit."); continue;
    }
    if (ids.has(id)) { error("duplicate_id", "Duplicate server identity.", id); continue; }
    ids.add(id);
    if (key && entry.id !== undefined && entry.id !== key) error("id_mismatch", "Object key and server id must agree.", id, "id");
    for (const field of Object.keys(entry)) if (!SERVER_FIELDS.has(field)) error("unknown_field", "Unsupported server configuration field.", id, field);
    if (!["stdio", "http", "sse"].includes(String(entry.transport))) error("unsupported_transport", "Transport must be stdio, http, or sse.", id, "transport");
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") error("invalid_field", "enabled must be a boolean.", id, "enabled");
    if (entry.protocol !== undefined && !["legacy", "modern", "auto"].includes(String(entry.protocol))) error("invalid_field", "protocol must be legacy, modern, or auto.", id, "protocol");
    if (entry.profile !== undefined && entry.profile !== "playwright") error("invalid_field", "profile must be playwright when explicitly enabled.", id, "profile");
    try { validateCredentialProvider(entry); } catch { error("invalid_credential_provider", "The GitHub CLI credential provider requires the exact official GitHub HTTP MCP endpoint and cannot be combined with OAuth or an Authorization header.", id, "credentialProvider"); }
    if (entry.oauth !== undefined) {
      if (!isRecord(entry.oauth)) error("invalid_oauth", "oauth must be an object containing public client settings.", id, "oauth");
      else {
        for (const field of Object.keys(entry.oauth)) if (!["clientId", "clientMetadataUrl", "scope", "callbackPort"].includes(field)) error("unknown_field", "Unsupported OAuth field; store credentials through motif mcp login.", id, `oauth.${field}`);
        for (const field of ["clientId", "clientMetadataUrl", "scope"] as const) {
          const value = entry.oauth[field];
          if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value) || hasEnvReference(value))) error("invalid_oauth", "OAuth client settings must be bounded nonempty public strings without environment expressions or control characters.", id, `oauth.${field}`);
        }
        if (typeof entry.oauth.clientMetadataUrl === "string") {
          try { const url = new URL(entry.oauth.clientMetadataUrl); validateUrl(url.href); if (url.protocol !== "https:" || url.hash) throw new Error(); }
          catch { error("invalid_oauth", "clientMetadataUrl must be an HTTPS URL without credentials, fragments or credential query parameters.", id, "oauth.clientMetadataUrl"); }
        }
        const port = entry.oauth.callbackPort;
        if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) error("invalid_oauth", "callbackPort must be an integer from 1 to 65535.", id, "oauth.callbackPort");
      }
      if (entry.transport === "stdio") error("transport_field", "OAuth settings require an HTTP transport.", id, "oauth");
      if (isRecord(entry.headers) && Object.keys(entry.headers).some(name => name.toLowerCase() === "authorization")) error("authentication_conflict", "Choose OAuth or an explicit Authorization header, not both.", id, "oauth");
    }
    for (const field of ["args", "envVars", "allowedTools", "deniedTools"] as const) {
      const value = entry[field];
      if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string" && !item.includes("\0")))) error("invalid_field", "Expected a string array without NUL characters.", id, field);
    }
    if (Array.isArray(entry.envVars) && entry.envVars.some((name) => typeof name !== "string" || !ENV_NAME.test(name))) error("invalid_env", "Environment references must be variable names.", id, "envVars");
    for (const field of ["command", "cwd", "url"] as const) {
      if (entry[field] !== undefined && (typeof entry[field] !== "string" || entry[field].includes("\0"))) error("invalid_field", "Expected a string without NUL characters.", id, field);
    }
    if (entry.transport === "stdio") {
      if (typeof entry.command !== "string" || entry.command.trim() === "") error("missing_command", "stdio requires a command.", id, "command");
      if (entry.url !== undefined || entry.headers !== undefined) error("transport_field", "stdio does not accept URL or HTTP headers.", id);
    } else if (entry.transport === "http" || entry.transport === "sse") {
      if (typeof entry.url !== "string" || entry.url === "") error("missing_url", "HTTP transports require a URL.", id, "url");
      else if (!hasEnvReference(entry.url)) {
        try { validateUrl(entry.url); } catch { error("invalid_url", "URL must use HTTP(S), without embedded credentials or credential query parameters.", id, "url"); }
      }
      for (const field of ["command", "args", "cwd", "env", "envVars"]) if (entry[field] !== undefined) error("transport_field", "HTTP transports do not accept stdio process settings.", id, field);
    }
    for (const field of ["startupTimeoutMs", "toolTimeoutMs", "catalogTtlMs"] as const) {
      const value = entry[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < (field === "catalogTtlMs" ? 0 : 1) || value > 86_400_000)) error("invalid_timeout", "Expected bounded milliseconds (maximum one day).", id, field);
    }
    for (const field of ["env", "headers"] as const) {
      const map = entry[field];
      if (map === undefined) continue;
      if (!isRecord(map)) { error("invalid_field", "Expected a string/reference map.", id, field); continue; }
      const seen = new Set<string>();
      for (const [name, value] of Object.entries(map)) {
        if (!isEnvValue(value)) { error("invalid_reference", "Expected a string or {env: VARIABLE_NAME}.", id, `${field}.${name}`); continue; }
        if (field === "env" && !ENV_NAME.test(name)) error("invalid_env", "Invalid environment variable name.", id, `${field}.${name}`);
        if (field === "headers") {
          const lower = name.toLowerCase();
          if (!isSupportedHeaderName(name)) error("unsupported_header", "Header name is invalid or reserved for transport/ambient credentials.", id, `${field}.${name}`);
          if (seen.has(lower)) error("duplicate_header", "Header names are case-insensitive; duplicates are not allowed.", id, `${field}.${name}`);
          seen.add(lower);
          if (!PUBLIC_HTTP_HEADERS.has(lower) && !hasEnvReference(value)) error("plaintext_credential", "Private/custom headers must reference environment variables.", id, `${field}.${name}`);
        }
      }
    }
    if (diagnostics.length !== start) continue;
    const server = { ...entry, id, enabled: entry.enabled !== false, protocol: entry.protocol ?? "legacy" } as unknown as McpServerConfig;
    if (server.cwd && !isAbsolute(server.cwd) && !hasEnvReference(server.cwd)) server.cwd = resolve(dirname(sourcePath), server.cwd);
    servers.push(server);
  }
  // A malformed document cannot partially authorize otherwise valid processes.
  return { servers: diagnostics.some((d) => d.severity === "error") ? [] : servers, diagnostics };
}

export interface LoadMcpConfigOptions {
  cwd?: string;
  home?: string;
  /** Explicit configuration replaces the user configuration; it never inherits credentials. */
  path?: string;
  trustHash?: string;
  env?: NodeJS.ProcessEnv;
}
export function loadMcpConfig(options: LoadMcpConfigOptions = {}): McpConfigResult {
  const path = options.path ? resolve(options.cwd ?? process.cwd(), options.path) : defaultMcpConfigPath(options.home);
  if (!existsSync(path)) return { servers: [], diagnostics: options.path ? [{ severity: "error", code: "missing_config", message: "The explicitly selected MCP configuration does not exist." }] : [], sources: [] };
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { servers: [], diagnostics: [{ severity: "error", code: "unreadable_config", message: "Could not read the selected MCP configuration." }], sources: [] }; }
  const sha256 = configHash(text);
  const trusted = !options.path || options.trustHash === sha256;
  const parsed = parseMcpConfig(text, path);
  if (!trusted) parsed.diagnostics.push({ severity: "warning", code: "untrusted_config", message: `Explicit MCP configuration is disabled until reviewed and authorized with --trust-mcp ${sha256}.` });
  return { servers: trusted ? parsed.servers : parsed.servers.map((server) => ({ ...server, enabled: false })), diagnostics: parsed.diagnostics, sources: [{ path, sha256, trusted }] };
}

function validateUrl(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some((key) => /token|key|secret|password|auth/i.test(key))) throw new Error("Invalid MCP URL.");
}
function expand(value: string, env: NodeJS.ProcessEnv, field: string): string {
  return value.replace(/\$\{([^}]*)\}/g, (_whole, expression: string) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/.exec(expression);
    if (!match) throw new Error(`Unsupported environment expression in ${field}.`);
    const name = match[1]!;
    const resolved = env[name] !== undefined && env[name] !== "" ? env[name] : match[2];
    if (resolved === undefined) throw new Error(`Missing environment variable ${name} for ${field}.`);
    return resolved;
  });
}
function resolveValue(value: EnvValue, env: NodeJS.ProcessEnv, field: string): string {
  if (typeof value === "string") return expand(value, env, field);
  const result = env[value.env];
  if (result === undefined || result === "") throw new Error(`Missing environment variable ${value.env} for ${field}.`);
  return result;
}
/** Credentials are resolved only at connection time and must not be logged. */
export function resolveServerConfig(server: McpServerConfig, env: NodeJS.ProcessEnv = process.env): ResolvedMcpServerConfig {
  validateCredentialProvider(server);
  const childEnv: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of BASE_ENV_ALLOWLIST) if (env[name] !== undefined) childEnv[name] = env[name]!;
  for (const name of server.envVars ?? []) childEnv[name] = resolveValue({ env: name }, env, `envVars.${name}`);
  for (const [name, value] of Object.entries(server.env ?? {})) childEnv[name] = resolveValue(value, env, `env.${name}`);
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!isSupportedHeaderName(name)) throw new Error("Unsupported HTTP header name.");
    const resolved = resolveValue(value, env, `headers.${name}`);
    if (/[\r\n\0]/.test(resolved)) throw new Error(`Invalid characters in headers.${name}.`);
    headers[lower] = resolved;
  }
  const command = server.command === undefined ? undefined : expand(server.command, env, "command");
  const args = server.args?.map((value) => expand(value, env, "args"));
  const cwd = server.cwd === undefined ? undefined : expand(server.cwd, env, "cwd");
  const url = server.url === undefined ? undefined : expand(server.url, env, "url");
  if (url) validateUrl(url);
  if ([command, cwd, ...(args ?? [])].some((value) => value?.includes("\0"))) throw new Error("NUL characters are not allowed in process settings.");
  return { ...server, command, args, cwd, url, env: childEnv, headers };
}
