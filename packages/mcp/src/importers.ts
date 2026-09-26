import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { hasEnvReference, isSupportedHeaderName, PUBLIC_HTTP_HEADERS, isRecord, parseMcpConfig, type ConfigDiagnostic, type EnvValue, type McpConfig, type McpServerConfig } from "./config.js";

export type ImportClient = "codex" | "claude";
export interface ImportedServer {
  id: string;
  sourceKey: string;
  status: "imported" | "needs_configuration" | "unsupported" | "disabled";
  config?: McpServerConfig;
  diagnostics: ConfigDiagnostic[];
}
export interface McpImportResult {
  client: ImportClient;
  sourcePath: string;
  scope: string;
  servers: ImportedServer[];
  diagnostics: ConfigDiagnostic[];
  /** Every imported server is disabled; importing is never approval to run it. */
  config: McpConfig & { version: 1 };
}
export interface ImportOptions { sourcePath: string; project?: string }
const CODEX_FIELDS = new Set(["command", "args", "cwd", "url", "env", "env_vars", "http_headers", "env_http_headers", "bearer_token_env_var", "enabled", "enabled_tools", "disabled_tools", "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec"]);
const CLAUDE_FIELDS = new Set(["type", "command", "args", "cwd", "url", "env", "headers", "disabled"]);
const SECRET_ARG = /^--?(?:api[-_]?key|token|access[-_]?token|password|secret|authorization)(?:=|$)/i;

/** A stable portable identity; punctuation normalization cannot merge two origins. */
export function importedServerId(key: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(key)) return key;
  const stem = key.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 110) || "server";
  return `${stem}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** Public configuration declarations only. No auth stores, processes, or network access. */
export function importMcpConfig(client: ImportClient, text: string, options: ImportOptions): McpImportResult {
  const result: McpImportResult = { client, sourcePath: options.sourcePath, scope: options.project ?? "user", servers: [], diagnostics: [], config: { version: 1, servers: [] } };
  const fail = (code: string, message: string) => { result.diagnostics.push({ severity: "error", code, message }); return result; };
  let root: unknown;
  try { root = client === "codex" ? parseToml(text) : JSON.parse(text); }
  catch { return fail("invalid_source", `Source must be valid ${client === "codex" ? "TOML" : "JSON"}.`); }
  if (!isRecord(root)) return fail("invalid_source", "Expected a configuration object.");
  if (options.project) {
    if (client !== "claude") return fail("unsupported_scope", "Project selection is supported only for Claude JSON project entries.");
    const projects = root.projects;
    if (!isRecord(projects) || !isRecord(projects[options.project])) return fail("missing_project", "The selected project entry does not exist.");
    root = projects[options.project];
  }
  const entries = (root as Record<string, unknown>)[client === "codex" ? "mcp_servers" : "mcpServers"];
  if (!isRecord(entries)) return fail("missing_servers", `No ${client === "codex" ? "mcp_servers" : "mcpServers"} object was found in the selected scope.`);
  for (const [key, value] of Object.entries(entries)) {
    const id = importedServerId(key);
    const item: ImportedServer = { id, sourceKey: key, status: "imported", diagnostics: [] };
    result.servers.push(item);
    const diagnostic = (code: string, message: string, field?: string, blocking = false) => {
      item.diagnostics.push({ severity: blocking ? "error" : "warning", code, message, server: id, field });
      if (blocking) item.status = "unsupported";
      else if (item.status !== "unsupported") item.status = "needs_configuration";
    };
    // `${TOKEN:-secret}` is still an inline credential. Keep only the reference;
    // missing values then fail closed at connection time. Native configs are not
    // passed through this importer and retain their explicitly authored defaults.
    const withoutDefaults = (input: string, field: string): string => input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g, (_whole, name: string) => {
      diagnostic("inline_default_not_copied", "Inline environment fallback was omitted. Set the referenced variable before enabling this server.", field);
      return `\${${name}}`;
    });
    if (!isRecord(value)) { diagnostic("invalid_server", "Server entry must be an object.", undefined, true); continue; }
    const supported = client === "codex" ? CODEX_FIELDS : CLAUDE_FIELDS;
    for (const field of Object.keys(value)) {
      if (!supported.has(field)) diagnostic("unsupported_field", "Unsupported source field; this server is excluded until its semantics are reviewed.", field, true);
    }
    if (client === "codex" && value.command !== undefined && value.url !== undefined) diagnostic("ambiguous_transport", "Both command and URL are present; select one transport explicitly.", undefined, true);
    let transport = client === "codex" ? (value.command !== undefined ? "stdio" : "http") : (value.type ?? (value.command !== undefined ? "stdio" : undefined));
    if (transport === "streamable-http") transport = "http";
    if (!["stdio", "http", "sse"].includes(String(transport))) diagnostic("unsupported_transport", "Specify stdio, http, or sse; custom transports are not translated.", "type", true);
    const config: McpServerConfig = { id, enabled: false, transport: transport as McpServerConfig["transport"], protocol: "legacy" };
    for (const field of ["command", "url", "cwd"] as const) {
      if (value[field] !== undefined) (config as unknown as Record<string, unknown>)[field] = typeof value[field] === "string" ? withoutDefaults(value[field], field) : value[field];
    }
    if (typeof config.cwd === "string" && !isAbsolute(config.cwd) && !hasEnvReference(config.cwd)) config.cwd = resolve(dirname(options.sourcePath), config.cwd);
    if (value.args !== undefined) config.args = (Array.isArray(value.args) ? value.args.map((arg) => typeof arg === "string" ? withoutDefaults(arg, "args") : arg) : value.args) as string[];
    if (Array.isArray(config.args) && config.args.some((arg) => typeof arg === "string" && SECRET_ARG.test(arg))) diagnostic("credential_in_args", "Credential-like argv options cannot be imported; use environment references in a reviewed native configuration.", "args", true);
    if (typeof config.command === "string" && /^(?:.*[/\\])?(?:sh|bash|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?)$/i.test(config.command)) diagnostic("shell_command", "Shell wrappers require manual review; arbitrary scripts are not imported as executable configuration.", "command", true);

    if (value.env !== undefined) {
      if (!isRecord(value.env)) diagnostic("invalid_env", "env must be a map of string values.", "env", true);
      else {
        config.env = Object.create(null) as Record<string, EnvValue>;
        for (const [name, envValue] of Object.entries(value.env)) {
          if (typeof envValue !== "string") { diagnostic("invalid_env", "Environment values must be strings.", `env.${name}`, true); continue; }
          if (hasEnvReference(envValue)) config.env[name] = withoutDefaults(envValue, `env.${name}`);
          else {
            config.env[name] = { env: name };
            diagnostic("literal_env_not_copied", "Inline environment value was omitted. Set this variable in Motif's launch environment or review a native config value.", `env.${name}`);
          }
        }
      }
    }
    if (client === "codex") {
      if (value.env_vars !== undefined) config.envVars = value.env_vars as string[];
      if (value.enabled_tools !== undefined) config.allowedTools = value.enabled_tools as string[];
      if (value.disabled_tools !== undefined) config.deniedTools = value.disabled_tools as string[];
      if (value.startup_timeout_sec !== undefined && value.startup_timeout_ms !== undefined) diagnostic("conflicting_timeout", "Use only one startup timeout unit.", "startup_timeout_sec", true);
      if (value.startup_timeout_sec !== undefined) config.startupTimeoutMs = typeof value.startup_timeout_sec === "number" ? value.startup_timeout_sec * 1000 : NaN;
      if (value.startup_timeout_ms !== undefined) config.startupTimeoutMs = value.startup_timeout_ms as number;
      if (value.tool_timeout_sec !== undefined) config.toolTimeoutMs = typeof value.tool_timeout_sec === "number" ? value.tool_timeout_sec * 1000 : NaN;
      if (value.enabled !== undefined && typeof value.enabled !== "boolean") diagnostic("invalid_enabled", "enabled must be a boolean.", "enabled", true);
    } else if (value.disabled !== undefined && typeof value.disabled !== "boolean") diagnostic("invalid_enabled", "disabled must be a boolean.", "disabled", true);

    const headerSource = value[client === "codex" ? "http_headers" : "headers"];
    const headers: Record<string, EnvValue> = Object.create(null) as Record<string, EnvValue>;
    const addHeader = (name: string, headerValue: unknown, envReference = false) => {
      const lower = name.toLowerCase();
      if (!isSupportedHeaderName(name)) { diagnostic("unsupported_header", "Header name is invalid or reserved for transport/ambient credentials.", `headers.${name}`, true); return; }
      if (headers[lower] !== undefined) { diagnostic("duplicate_header", "Conflicting case-insensitive header declarations.", `headers.${name}`, true); return; }
      if (typeof headerValue !== "string") { diagnostic("invalid_header", "Header values/references must be strings.", `headers.${name}`, true); return; }
      if (envReference) headers[lower] = { env: headerValue };
      else if (PUBLIC_HTTP_HEADERS.has(lower) || hasEnvReference(headerValue)) headers[lower] = withoutDefaults(headerValue, `headers.${name}`);
      else {
        headers[lower] = { env: `MCP_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${lower.replace(/-/g, "_").toUpperCase()}` };
        diagnostic("credential_not_copied", "Inline credential was omitted. Set the named environment variable to the complete header value.", `headers.${name}`);
      }
    };
    if (headerSource !== undefined) {
      if (!isRecord(headerSource)) diagnostic("invalid_headers", "Headers must be a map.", "headers", true);
      else for (const [name, headerValue] of Object.entries(headerSource)) addHeader(name, headerValue);
    }
    if (client === "codex" && value.env_http_headers !== undefined) {
      if (!isRecord(value.env_http_headers)) diagnostic("invalid_headers", "env_http_headers must be a map.", "env_http_headers", true);
      else for (const [name, ref] of Object.entries(value.env_http_headers)) addHeader(name, ref, true);
    }
    if (client === "codex" && value.bearer_token_env_var !== undefined) {
      if (typeof value.bearer_token_env_var !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.bearer_token_env_var)) diagnostic("invalid_reference", "bearer_token_env_var must be a variable name.", "bearer_token_env_var", true);
      else addHeader("authorization", `Bearer \${${value.bearer_token_env_var}}`);
    }
    if (Object.keys(headers).length > 0) config.headers = headers;
    const parsed = parseMcpConfig(JSON.stringify({ version: 1, servers: [config] }), options.sourcePath);
    for (const entry of parsed.diagnostics) diagnostic(entry.code, entry.message, entry.field, true);
    if (item.status === "unsupported") continue;
    item.config = parsed.servers[0]!;
    result.config.servers.push(item.config);
    if (value.enabled === false || value.disabled === true) item.status = "disabled";
  }
  result.diagnostics.push(...result.servers.flatMap((server) => server.diagnostics));
  result.diagnostics.push({ severity: "info", code: "disabled_by_default", message: "Import never runs servers. Review command, endpoint, environment and tool restrictions before setting enabled:true." });
  return result;
}

export const importCodexConfig = (text: string, options: ImportOptions): McpImportResult => importMcpConfig("codex", text, options);
export const importClaudeConfig = (text: string, options: ImportOptions): McpImportResult => importMcpConfig("claude", text, options);
