import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadMcpConfig, resolveServerConfig, type ConfigDiagnostic, type EnvValue, type McpServerConfig, importMcpConfig, type ImportClient, createMcpPresetConfig, getMcpPreset, listMcpPresets, McpPresetError, McpAuthBroker, McpManager } from "@motifcode/mcp";
import { editMcpConfig, updateMcpConfig, McpConfigEditError, summarizeMcpServer } from "./mcp-config-edit.js";
import { connectMcpServers, localMcpAuthTarget } from "./mcp-connect.js";
import { openExternalUrl } from "./browser-open.js";

export interface McpCommandOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  openBrowser?: (url: URL) => Promise<void>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export const MCP_HELP = `Usage:
  motif mcp presets [ID]
  motif mcp install ID [--root PATH] [--token-env NAME] [--enable]
  motif mcp list [--mcp-config PATH] [--trust-mcp SHA256]
  motif mcp get NAME
  motif mcp add NAME [--env NAME=VALUE] [--env-ref NAME[=SOURCE]] [--profile playwright] -- COMMAND [ARGS...]
  motif mcp add NAME --transport http|sse [--header NAME=VALUE] [--header-env NAME=SOURCE] URL
  motif mcp remove|enable|disable NAME
  motif mcp connect NAME [--login] [--no-browser]
  motif mcp login NAME [--client-id ID] [--callback-port PORT] [--scope SCOPES] [--no-browser]
  motif mcp logout|auth-status NAME
  motif mcp doctor [--connect] [--mcp-config PATH] [--trust-mcp SHA256]
  motif mcp import codex|claude PATH [--project EXACT_PROJECT_KEY] [--write NEW_PATH]
  motif mcp import --from codex|claude --file PATH [--write NEW_PATH]

list and doctor are offline by default. doctor --connect starts enabled trusted servers
and lists their tools, then closes connections; it never calls business tools.
list also includes available built-in presets. Use /mcp inside a chat to register,
enable, sign in and connect a preset without restarting that chat.
The default is ~/.motif/mcp.json. Project configs are never discovered automatically.
An explicit --mcp-config is disabled until its displayed SHA256 is passed to --trust-mcp.
Editing an existing explicit file also requires its current hash; new files may be created.
Each edit prints the new hash, which is required before using an explicit file to connect.
presets shows built-in recipes and prerequisites. install only registers a recipe,
disabled by default; --enable opts into later startup. It never downloads packages,
starts a process, connects, logs in, or reads tokens. --token-env takes a variable name.
filesystem requires an explicit --root directory; gmail requires --token-env.
add defaults to stdio and enabled:true, but never starts a server. All command arguments
after -- are preserved literally. Use --protocol legacy|modern|auto when needed.
--env, --env-ref, --header and --header-env may repeat. Prefer references over secrets
in shell history; private headers require references (e.g. 'Authorization=Bearer \${TOKEN}').
get withholds stored values. Edits use a private atomic file and a cooperative lock.
Restart an existing chat to load these edits; its live connections are managed separately.
Import is a dry run unless --write names a new file; existing files are never overwritten.
Imported entries remain disabled. Review them and set enabled:true before use.
Inline credentials are not copied; use environment references instead.
connect starts one trusted enabled server and lists tools. --login opens browser OAuth
if required; login always starts authorization, including upgrading anonymous access.
Complete account approval in your browser. Ctrl-C cancels. No business tool is replayed.
In an interactive terminal the authorization URL is also printed; --no-browser prints
it without launching a browser (for SSH or headless machines).
OAuth credentials are stored in private files under ~/.motif/auth, never in mcp.json.
The github preset delegates to GitHub CLI: login reuses its saved account or offers
browser sign-in. Subsequent processes read gh's durable credentials automatically.
Motif stores only a delegation grant; logout stops Motif access without logging gh out.
--client-metadata-url supports a hosted client document; --timeout sets login milliseconds.
logout removes Motif's local credentials; it does not revoke the provider's account grant.
`;

export type McpCommandFlags = Record<string, string | boolean | string[]>;
const REPEATED_FLAGS = new Set(["env", "env-ref", "header", "header-env"]);
const BOOLEAN_MCP_FLAGS = new Set(["help", "connect", "dry-run", "enable", "login", "no-browser"]);
const OAUTH_FLAGS = ["client-id", "client-metadata-url", "scope", "callback-port"];
const VALUE_MCP_FLAGS = new Set(["cwd", "mcp-config", "trust-mcp", "from", "file", "project", "write", "transport", "protocol", "profile", "root", "token-env", "timeout", ...OAUTH_FLAGS, ...REPEATED_FLAGS]);

/** Parse before the generic CLI parser can consume child arguments or repeated flags. */
export async function runMcpArgv(argv: string[], initialFlags: Record<string, string | boolean> = {}, options: McpCommandOptions = {}): Promise<number> {
  const rest: string[] = []; const flags: McpCommandFlags = { ...initialFlags };
  const fail = (message: string) => { (options.stderr ?? ((text: string) => process.stderr.write(text)))(message + "\n" + MCP_HELP); return 2; };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    if (arg === "--") { rest.push(...argv.slice(i)); break; }
    const short: Record<string, string> = { "-e": "--env", "-t": "--transport", "-H": "--header", "-h": "--help" };
    arg = short[arg] ?? arg;
    if (!arg.startsWith("-")) { rest.push(arg); continue; }
    if (!arg.startsWith("--")) return fail("Unknown MCP option.");
    const equal = arg.indexOf("="); const key = arg.slice(2, equal < 0 ? undefined : equal);
    if (!BOOLEAN_MCP_FLAGS.has(key) && !VALUE_MCP_FLAGS.has(key)) return fail("Unknown MCP option.");
    if (BOOLEAN_MCP_FLAGS.has(key)) {
      if (equal >= 0 || flags[key] !== undefined) return fail("Boolean MCP options take no values and must not repeat.");
      flags[key] = true; continue;
    }
    const value = equal >= 0 ? arg.slice(equal + 1) : argv[++i];
    if (value === undefined || value === "" || (equal < 0 && value.startsWith("--"))) return fail("An MCP option requires a value.");
    if (REPEATED_FLAGS.has(key)) {
      const previous = flags[key]; flags[key] = [...(Array.isArray(previous) ? previous : typeof previous === "string" ? [previous] : []), value];
    } else {
      if (flags[key] !== undefined) return fail("An MCP option was specified more than once.");
      flags[key] = value;
    }
  }
  return runMcpCommand(rest, flags, options);
}

function allowedFlags(command: string): Set<string> {
  const common = ["help", "cwd", "mcp-config", "trust-mcp"];
  if (command === "presets") return new Set(["help", "cwd"]);
  if (command === "install") return new Set([...common, "root", "token-env", "enable"]);
  if (command === "import") return new Set(["help", "cwd", "from", "file", "project", "write", "dry-run"]);
  if (command === "login") return new Set([...common, "timeout", "no-browser", ...OAUTH_FLAGS]);
  if (command === "connect") return new Set([...common, "login", "timeout", "no-browser"]);
  if (["logout", "auth-status"].includes(command)) return new Set(common);
  return new Set([...common, ...(command === "doctor" ? ["connect"] : []), ...(command === "add" ? ["transport", "profile", "protocol", ...REPEATED_FLAGS] : [])]);
}

function settingMap(flags: McpCommandFlags, literalFlag: string, referenceFlag: string): Record<string, EnvValue> | undefined {
  const result: Record<string, EnvValue> = Object.create(null) as Record<string, EnvValue>;
  const seen = new Set<string>();
  for (const [flag, reference] of [[literalFlag, false], [referenceFlag, true]] as const) {
    const raw = flags[flag]; const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    for (const item of values) {
      const separator = item.indexOf("=");
      const name = separator < 0 ? item : item.slice(0, separator);
      const value = separator < 0 ? item : item.slice(separator + 1);
      const identity = literalFlag === "header" ? name.toLowerCase() : name;
      if (!name || (!reference && separator < 0) || (reference && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) || seen.has(identity)) throw new McpConfigEditError("invalid_option", "Environment/header options require unique names and valid NAME=VALUE or NAME=SOURCE entries.");
      seen.add(identity); result[name] = reference ? { env: value } : value;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/** Standalone dispatcher: does not initialize the model or an MCP connection. */
export async function runMcpCommand(
  rest: string[],
  flags: McpCommandFlags,
  options: McpCommandOptions = {},
): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const cwd = typeof flags.cwd === "string" ? resolve(options.cwd ?? process.cwd(), flags.cwd) : options.cwd ?? process.cwd();
  const value = (key: string): string | undefined => typeof flags[key] === "string" ? flags[key] as string : undefined;
  const emit = (data: unknown) => out(JSON.stringify(data, null, 2) + "\n");
  const usage = (message: string) => { err(message + "\n" + MCP_HELP); return 2; };
  const command = rest[0] ?? "list";
  const permitted = allowedFlags(command);
  for (const [key, flag] of Object.entries(flags)) {
    if (!permitted.has(key)) return usage("An option is not supported for this MCP command.");
    if (BOOLEAN_MCP_FLAGS.has(key) ? typeof flag !== "boolean" : REPEATED_FLAGS.has(key)
      ? !(typeof flag === "string" || (Array.isArray(flag) && flag.every((item) => typeof item === "string" && item.length > 0)))
      : typeof flag !== "string" || !flag.length) return usage("An MCP option has an invalid or missing value.");
  }
  if (command === "help" || flags.help) { out(MCP_HELP); return 0; }
  if (["connect", "login", "logout", "auth-status"].includes(command)) {
    if (rest.length !== 2) return usage(`${command} requires exactly one server name.`);
    let config = loadMcpConfig({ cwd, home: options.home, path: value("mcp-config"), trustHash: value("trust-mcp") });
    if (config.diagnostics.some(row => row.severity === "error") || config.sources.some(row => !row.trusted)) { emit({ error: { code: "untrusted_config", message: "Review and authorize a valid configuration before connecting or accessing its credentials." } }); return 1; }
    let server = config.servers.find(row => row.id === rest[1]);
    if (!server) return usage("The requested MCP server is not configured.");
    if ((command === "login" || command === "connect") && !server.enabled) { emit({ error: { code: "server_not_allowed", message: "Enable the reviewed server before connecting." } }); return 1; }
    const timeoutMs = value("timeout") === undefined ? undefined : Number(value("timeout"));
    const callbackPort = value("callback-port") === undefined ? undefined : Number(value("callback-port"));
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)) return usage("--timeout must be 1–600000 milliseconds.");
    if (callbackPort !== undefined && (!Number.isSafeInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535)) return usage("--callback-port must be 1–65535.");
    try {
      if (OAUTH_FLAGS.some(key => flags[key] !== undefined)) {
        if (server.credentialProvider) return usage("This server uses GitHub CLI credentials; OAuth client options do not apply.");
        const oauth = { ...server.oauth, ...(value("client-id") ? { clientId: value("client-id") } : {}), ...(value("client-metadata-url") ? { clientMetadataUrl: value("client-metadata-url") } : {}), ...(value("scope") ? { scope: value("scope") } : {}), ...(callbackPort ? { callbackPort } : {}) };
        const edited = updateMcpConfig({ cwd, home: options.home, path: value("mcp-config"), trustHash: value("trust-mcp") }, current => ({ servers: current.servers.map(row => row.id === server!.id ? { ...row, oauth } : row) }));
        config = { ...config, ...edited.config, sources: [{ path: edited.path, sha256: edited.sha256, trusted: true }] };
        server = config.servers.find(row => row.id === rest[1])!;
      }
      const auth = new McpAuthBroker({ home: options.home, fetch: options.fetch, openBrowser: options.openBrowser ?? openExternalUrl });
      if (command === "logout" || command === "auth-status") {
        const target = localMcpAuthTarget(server, options.env ?? process.env);
        emit(command === "logout" ? auth.logout(target) : auth.status(target)); return 0;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.on("SIGINT", cancel); process.on("SIGTERM", cancel); process.on("SIGHUP", cancel);
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      try {
        const result = await connectMcpServers({ servers: [server] }, { home: options.home, env: options.env, auth, fetch: options.fetch, openBrowser: options.openBrowser, signal, forceLogin: command === "login", login: flags.login === true, noBrowser: flags["no-browser"] === true, timeoutMs, onProgress: message => err(message + "\n") });
        emit({ ...result, sources: config.sources });
        return signal.aborted ? 130 : result.ready ? 0 : 1;
      } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); process.removeListener("SIGHUP", cancel); }
    } catch (cause) {
      emit({ error: { code: cause instanceof McpConfigEditError ? cause.code : "authentication_failed", message: "Could not complete the authentication command. Check OAuth configuration and provider access." } }); return 1;
    }
  }
  if (command === "presets") {
    if (rest.length > 2) return usage("presets accepts at most one preset ID.");
    const preset = rest[1] ? getMcpPreset(rest[1]) : undefined;
    if (rest[1] && !preset) { emit({ error: { code: "unknown_preset", message: "Unknown built-in MCP preset. Use motif mcp presets to list available IDs." } }); return 1; }
    emit({ mode: "offline", ...(preset ? { preset } : { presets: listMcpPresets() }), connected: false });
    return 0;
  }
  if (command === "install") {
    if (rest.length !== 2) return usage("install requires exactly one preset ID.");
    try {
      const server = createMcpPresetConfig(rest[1]!, { cwd, root: value("root"), tokenEnv: value("token-env"), enabled: flags.enable === true });
      const edited = editMcpConfig({ kind: "add", server }, { cwd, home: options.home, path: value("mcp-config"), trustHash: value("trust-mcp") });
      const configArgs = value("mcp-config") ? ["--mcp-config", edited.path, "--trust-mcp", edited.sha256] : [];
      const connectArgs = value("mcp-config") && !server.enabled ? ["--mcp-config", edited.path, "--trust-mcp", "<SHA256 printed by enable>"] : configArgs;
      emit({ mode: "saved-offline", operation: "install", preset: server.id, path: edited.path, sha256: edited.sha256, server: summarizeMcpServer(server), connected: false,
        prerequisites: getMcpPreset(server.id)!.prerequisites,
        nextSteps: [
          { description: "Review configuration and resolve prerequisites.", argv: ["motif", "mcp", "doctor", ...configArgs] },
          ...(!server.enabled ? [{ description: "Opt into startup after review; an explicit file receives a new hash.", argv: ["motif", "mcp", "enable", server.id, ...configArgs] }] : []),
          { description: "Start enabled trusted servers and list tools; this may download pinned npm packages.", argv: ["motif", "mcp", "doctor", "--connect", ...connectArgs] },
        ],
        note: "Registered configuration only. No package download, process startup, connection, login, or token resolution occurred. Restart an existing chat to load the change.",
      });
      return 0;
    } catch (cause) {
      if (cause instanceof McpPresetError || cause instanceof McpConfigEditError) emit({ error: { code: cause.code, message: cause.message, ...(cause instanceof McpConfigEditError && cause.sha256 ? { sha256: cause.sha256 } : {}) } });
      else err("Could not safely install the MCP preset. No server was started.\n");
      return 1;
    }
  }
  if (["add", "remove", "enable", "disable"].includes(command)) {
    if (!rest[1]) return usage("Specify a server name.");
    try {
      const editOptions = { cwd, home: options.home, path: value("mcp-config"), trustHash: value("trust-mcp") };
      let edited;
      if (command === "add") {
        const transport = value("transport") ?? "stdio";
        if (!["stdio", "http", "sse"].includes(transport)) return usage("--transport must be stdio, http, or sse.");
        const server: McpServerConfig = { id: rest[1]!, enabled: true, transport: transport as McpServerConfig["transport"] };
        if (value("profile") !== undefined) {
          if (value("profile") !== "playwright") return usage("--profile must be playwright.");
          server.profile = "playwright";
        }
        if (value("protocol") !== undefined) {
          if (!["legacy", "modern", "auto"].includes(value("protocol")!)) return usage("--protocol must be legacy, modern, or auto.");
          server.protocol = value("protocol") as McpServerConfig["protocol"];
        }
        if (transport === "stdio") {
          if (rest[2] !== "--" || !rest[3]) return usage("stdio requires: add NAME [options] -- COMMAND [ARGS...]");
          if (flags.header !== undefined || flags["header-env"] !== undefined) return usage("HTTP headers are unavailable for stdio.");
          server.command = rest[3]; server.args = rest.slice(4);
          const env = settingMap(flags, "env", "env-ref"); if (env) server.env = env;
        } else {
          if (rest.length !== 3 || rest[2] === "--") return usage("HTTP/SSE requires: add NAME --transport http|sse URL");
          if (flags.env !== undefined || flags["env-ref"] !== undefined) return usage("Process environment options are unavailable for HTTP/SSE.");
          server.url = rest[2];
          const headers = settingMap(flags, "header", "header-env"); if (headers) server.headers = headers;
        }
        edited = editMcpConfig({ kind: "add", server }, editOptions);
      } else {
        if (rest.length !== 2) return usage("Expected exactly one server name.");
        edited = editMcpConfig({ kind: command as "remove" | "enable" | "disable", id: rest[1]! }, editOptions);
      }
      const server = edited.config.servers.find((entry) => entry.id === rest[1]);
      emit({ mode: "saved-offline", operation: command, path: edited.path, sha256: edited.sha256, server: server ? summarizeMcpServer(server) : undefined, connected: false });
      return 0;
    } catch (cause) {
      if (cause instanceof McpConfigEditError) emit({ error: { code: cause.code, message: cause.message, ...(cause.sha256 ? { sha256: cause.sha256 } : {}) } });
      else err("Could not safely update the MCP configuration. No server was started.\n");
      return 1;
    }
  }
  if (command === "get") {
    if (rest.length !== 2) return usage("get requires exactly one server name.");
    const config = loadMcpConfig({ cwd, home: options.home, path: value("mcp-config"), trustHash: value("trust-mcp") });
    if (config.diagnostics.some((diagnostic) => diagnostic.severity === "error")) { emit({ sources: config.sources, error: "Invalid or unreadable MCP configuration." }); return 1; }
    const server = config.servers.find((entry) => entry.id === rest[1]);
    if (!server) { err("The requested MCP server is not configured.\n"); return 1; }
    emit({ mode: "offline", sources: config.sources, server: summarizeMcpServer(server), valuesWithheld: true });
    return 0;
  }
  if (["list", "doctor"].includes(command)) {
    if (rest.length > 1) return usage("Unexpected positional argument.");
    if ((flags["mcp-config"] !== undefined && !value("mcp-config")) || (flags["trust-mcp"] !== undefined && !value("trust-mcp"))) return usage("--mcp-config and --trust-mcp require values.");
    if (flags.connect && command !== "doctor") return usage("--connect is available only for doctor.");
    const config = loadMcpConfig({ cwd, home: options.home, path: value("mcp-config"), trustHash: value("trust-mcp") });
    const diagnostics: ConfigDiagnostic[] = [...config.diagnostics];
    if (command === "doctor") {
      for (const server of config.servers) {
        try { resolveServerConfig(server, options.env ?? process.env); }
        catch (cause) {
          // Resolver errors contain names and field locations only, never their values.
          diagnostics.push({ severity: server.enabled ? "error" : "warning", code: "unresolved_configuration", message: cause instanceof Error ? cause.message : "Could not resolve configuration.", server: server.id });
        }
      }
    }
    let connections: unknown;
    let interruptedExitCode: number | undefined;
    if (flags.connect && !diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      if (config.sources.some((source) => !source.trusted)) diagnostics.push({ severity: "error", code: "untrusted_config", message: "Review and authorize the exact configuration hash before connecting." });
      else {
        const manager = new McpManager(config, { env: options.env ?? process.env, auth: new McpAuthBroker({ home: options.home, fetch: options.fetch }), fetch: options.fetch });
        const controller = new AbortController();
        const handlers = ([ ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129] ] as const).map(([signal, code]) => {
          const handler = () => {
            interruptedExitCode ??= code;
            process.exitCode = interruptedExitCode;
            controller.abort();
          };
          process.on(signal, handler);
          return { signal, handler };
        });
        try {
          const catalog = await manager.catalog({ signal: controller.signal });
          const statuses = manager.statuses();
          connections = statuses.map((status) => ({ ...status, toolCount: catalog.filter((tool) => tool.server === status.server).length }));
          for (const status of statuses) {
            if (!status.enabled) continue;
            if (status.state === "error") diagnostics.push({ severity: "error", code: status.error?.code ?? "connection_error", message: status.error?.message ?? "MCP connection failed.", server: status.server });
            // A catalog waiter can time out while the shared startup remains pending.
            // Only ready confirms a successful connection check, even with zero tools.
            else if (status.state !== "ready") diagnostics.push({ severity: "error", code: "connection_not_ready", message: `MCP server was not ready when the connection check ended (state: ${status.state}).`, server: status.server });
          }
        } catch {
          diagnostics.push({ severity: "error", code: "connection_error", message: "MCP connection diagnosis failed; server-controlled details are withheld." });
        } finally {
          try { await manager.close(); }
          finally { for (const { signal, handler } of handlers) process.removeListener(signal, handler); }
        }
      }
    }
    emit({ mode: flags.connect ? "connection-check" : "offline", sources: config.sources, servers: config.servers.map((server) => ({ id: server.id, enabled: server.enabled, transport: server.transport, protocol: server.protocol, profile: server.profile, credentialProvider: server.credentialProvider, allowedTools: server.allowedTools, deniedTools: server.deniedTools })),
      ...(command === "list" ? { availablePresets: listMcpPresets().filter(preset => !config.servers.some(server => server.id === preset.id)) } : {}), connections, diagnostics });
    return interruptedExitCode ?? (diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0);
  }
  if (command !== "import") return usage("Unknown MCP command.");
  const client = value("from") ?? rest[1];
  const source = value("file") ?? rest[value("from") ? 1 : 2];
  if (client !== "codex" && client !== "claude") return usage("Select an import source: codex or claude.");
  if (!source) return usage("Specify the source configuration file.");
  if (rest.length > (value("from") ? (value("file") ? 1 : 2) : (value("file") ? 2 : 3))) return usage("Unexpected import argument.");
  if (flags.write !== undefined && !value("write")) return usage("--write requires a new output path.");
  if (flags["dry-run"] && flags.write) return usage("--dry-run cannot be combined with --write.");
  const sourcePath = resolve(cwd, source);
  let text: string;
  try {
    if (statSync(sourcePath).size > 2 * 1024 * 1024) return usage("Source configuration is larger than the 2 MiB import limit.");
    text = readFileSync(sourcePath, "utf8");
  } catch { err("Could not read the selected import file.\n"); return 1; }
  const result = importMcpConfig(client as ImportClient, text, { sourcePath, project: value("project") });
  let written: string | undefined;
  if (value("write")) {
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      emit({ mode: "dry-run", servers: result.servers.map(({ id, status, diagnostics }) => ({ id, status, diagnostics })), diagnostics: result.diagnostics });
      err("Resolve unsupported entries before writing; no file was created.\n");
      return 1;
    }
    written = resolve(cwd, value("write")!);
    try {
      mkdirSync(dirname(written), { recursive: true, mode: 0o700 });
      writeFileSync(written, JSON.stringify(result.config, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch { err("Could not create the output file; existing files are never overwritten.\n"); return 1; }
  }
  emit({ mode: written ? "written-disabled" : "dry-run", sourcePath, scope: result.scope, written, servers: result.servers.map(({ id, status, config, diagnostics }) => ({ id, status, transport: config?.transport, enabled: false, diagnostics })), diagnostics: result.diagnostics });
  return result.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? 1 : 0;
}
