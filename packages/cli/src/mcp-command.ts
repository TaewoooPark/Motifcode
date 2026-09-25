import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadMcpConfig, resolveServerConfig, type ConfigDiagnostic } from "../../mcp/src/config.js";
import { importMcpConfig, type ImportClient } from "../../mcp/src/importers.js";

export interface McpCommandOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export const MCP_HELP = `Usage:
  motif mcp list [--mcp-config PATH] [--trust-mcp SHA256]
  motif mcp doctor [--connect] [--mcp-config PATH] [--trust-mcp SHA256]
  motif mcp import codex|claude PATH [--project EXACT_PROJECT_KEY] [--write NEW_PATH]
  motif mcp import --from codex|claude --file PATH [--write NEW_PATH]

list and doctor are offline by default. doctor --connect starts enabled trusted servers
and lists their tools, then closes connections; it never calls business tools.
The default is ~/.motif/mcp.json. Project configs are never discovered automatically.
An explicit --mcp-config is disabled until its displayed SHA256 is passed to --trust-mcp.
Import is a dry run unless --write names a new file; existing files are never overwritten.
Imported entries remain disabled. Review them and set enabled:true before use.
Inline credentials are not copied; use environment references instead.
`;

/** Standalone dispatcher: does not initialize the model or an MCP connection. */
export async function runMcpCommand(
  rest: string[],
  flags: Record<string, string | boolean>,
  options: McpCommandOptions = {},
): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const cwd = options.cwd ?? process.cwd();
  const value = (key: string): string | undefined => typeof flags[key] === "string" ? flags[key] as string : undefined;
  const emit = (data: unknown) => out(JSON.stringify(data, null, 2) + "\n");
  const usage = (message: string) => { err(message + "\n" + MCP_HELP); return 2; };
  const command = rest[0] ?? "list";
  if (command === "help" || flags.help) { out(MCP_HELP); return 0; }
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
        const { McpManager } = await import("../../mcp/src/manager.js");
        const manager = new McpManager(config, { env: options.env ?? process.env });
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
          for (const status of statuses) if (status.state === "error") diagnostics.push({ severity: "error", code: status.error?.code ?? "connection_error", message: status.error?.message ?? "MCP connection failed.", server: status.server });
        } catch {
          diagnostics.push({ severity: "error", code: "connection_error", message: "MCP connection diagnosis failed; server-controlled details are withheld." });
        } finally {
          try { await manager.close(); }
          finally { for (const { signal, handler } of handlers) process.removeListener(signal, handler); }
        }
      }
    }
    emit({ mode: flags.connect ? "connection-check" : "offline", sources: config.sources, servers: config.servers.map((server) => ({ id: server.id, enabled: server.enabled, transport: server.transport, protocol: server.protocol, allowedTools: server.allowedTools, deniedTools: server.deniedTools })), connections, diagnostics });
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
