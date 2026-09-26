import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configHash, parseMcpConfig, type McpServerConfig } from "../../mcp/src/config.js";
import { createMcpPresetConfig, getMcpPreset } from "../../mcp/src/presets.js";
import { updateMcpConfig } from "./mcp-config-edit.js";
import { loadBuiltinPlugins, type PluginInfo } from "./plugins.js";
import { SkillInstallError } from "./skill-installer.js";
import type { ConnectInstalledSkillOptions, PluginConnectionPlan, PluginConnectionResult } from "./plugin-connections.js";

const fail = (code: string, message: string): never => { throw new SkillInstallError(code, message); };

export function builtinPlugin(name: string): PluginInfo | undefined {
  return loadBuiltinPlugins().plugins.find(plugin => plugin.name === name);
}

function readConfig(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return fail("unsafe_config", "MCP configuration must be a regular file under 2 MiB.");
  return readFileSync(path, "utf8");
}

/** Only reuse the same endpoint/executable; custom IDs are never silently replaced. */
function sameEndpoint(existing: McpServerConfig, preset: McpServerConfig): boolean {
  return existing.transport === preset.transport && existing.url === preset.url && existing.command === preset.command &&
    JSON.stringify(existing.args ?? []) === JSON.stringify(preset.args ?? []) && existing.cwd === preset.cwd && existing.profile === preset.profile;
}

export function inspectBuiltinPluginConnections(name: string, options: ConnectInstalledSkillOptions = {}): PluginConnectionPlan {
  const plugin = builtinPlugin(name);
  if (!plugin) return fail("not_builtin", "No bundled plugin has this name.");
  const scope = options.scope ?? "user";
  const configPath = join(resolve(scope === "project" ? options.cwd ?? process.cwd() : options.home ?? homedir()), ".motif", "mcp.json");
  const text = readConfig(configPath);
  const parsed = parseMcpConfig(text ?? '{"version":1,"servers":[]}', configPath);
  if (parsed.diagnostics.some(row => row.severity === "error")) return fail("invalid_config", "Repair the existing MCP configuration before connecting a bundled plugin.");
  const manifestPath = join(plugin.path, "plugin.json");
  const digest = configHash(readFileSync(manifestPath, "utf8"));
  return {
    name, scope, packageRoot: plugin.path, runtimeRoot: plugin.path, digest, receiptIds: [], configPath,
    ...(text === undefined ? {} : { configHash: configHash(text) }), provenancePath: "", files: [{ path: manifestPath, sha256: digest }],
    diagnostics: plugin.mcpPresets.length ? [] : [{ severity: "info", code: "skills_only", message: "This bundled plugin's skills are already available; no MCP connection is required." }],
    candidates: plugin.mcpPresets.map(id => {
      const preset = getMcpPreset(id);
      if (!preset) return { sourceKey: id, sourceFile: manifestPath, id, status: "unsupported", environment: [], diagnostics: [{ severity: "error", code: "unknown_preset", message: "The bundled MCP preset is unavailable." }] };
      const server = createMcpPresetConfig(id, { enabled: true, cwd: options.cwd });
      const existing = parsed.servers.find(row => row.id === id);
      if (existing && !sameEndpoint(existing, server)) return { sourceKey: id, sourceFile: manifestPath, id, status: "unsupported", environment: [], diagnostics: [{ severity: "error", code: "existing_server_conflict", message: "An existing server with this ID uses a different endpoint or command. It was preserved; review it with motif mcp get and connect it explicitly." }] };
      if (existing && !existing.enabled) return { sourceKey: id, sourceFile: manifestPath, id, status: "unsupported", environment: [], diagnostics: [{ severity: "warning", code: "disabled_server", message: "This server is already registered but disabled. Review it and run motif mcp enable with the appropriate configuration scope before connecting; its disabled setting was preserved." }] };
      // Never include existing argument/header values in an inspection report.
      return { sourceKey: id, sourceFile: manifestPath, id, status: "available", config: server, environment: [], operation: existing ? "reuse" : "register",
        diagnostics: [{ severity: "info", code: "prerequisites", message: [...preset.prerequisites, preset.authentication].join(" ") },
          ...(existing ? [{ severity: "info" as const, code: "reuse_existing", message: "Existing authentication, restrictions and transport options are preserved." }] : [])] };
    }),
  };
}

/** Explicit approval, snapshot recheck and the normal MCP activator; no startup work. */
export async function connectBuiltinPlugin(name: string, options: ConnectInstalledSkillOptions = {}): Promise<PluginConnectionResult> {
  const plan = inspectBuiltinPluginConnections(name, options);
  if (options.all && options.servers?.length) return fail("ambiguous_selection", "Choose --all or --server, not both.");
  const selected = options.servers?.length ? [...new Set(options.servers)].map(id => {
    const candidate = plan.candidates.find(row => row.id === id);
    if (!candidate || candidate.status !== "available") return fail("unavailable_server", "The selected bundled server is unavailable. Inspect the plugin first.");
    return candidate;
  }) : plan.candidates.filter(row => row.status === "available");
  const result = (status: PluginConnectionResult["status"]): PluginConnectionResult => ({ status, plan, selected: selected.map(row => row.id) });
  if (options.dryRun) return result("dry-run");
  if (!plan.candidates.length) return result("registered");
  if (!selected.length || (!options.servers?.length && selected.length !== plan.candidates.length)) return fail("unavailable_server", "A bundled server conflicts with an existing configuration. No servers were changed.");
  if (options.signal?.aborted) return result("cancelled");
  if (!options.yes && !options.confirm) return fail("approval_required", "Inspect this plugin first, then use --yes to approve registration and startup. Browser sign-in additionally requires --login.");
  if (!options.yes && !await options.confirm!({ ...plan, candidates: selected })) return result("cancelled");
  if (options.signal?.aborted) return result("cancelled");
  if (JSON.stringify(inspectBuiltinPluginConnections(name, options)) !== JSON.stringify(plan)) return fail("plan_changed", "The bundled plugin or configuration changed after review; inspect it again.");
  const saved = selected.some(candidate => candidate.operation === "register") ? updateMcpConfig({ cwd: options.cwd, home: options.home, path: plan.configPath, trustHash: plan.configHash }, current => {
    const latest = readConfig(plan.configPath);
    if ((latest === undefined ? undefined : configHash(latest)) !== plan.configHash) return fail("plan_changed", "MCP configuration changed after review; nothing was overwritten.");
    for (const candidate of selected) {
      const existing = current.servers.find(row => row.id === candidate.id);
      if (!existing) current.servers.push(candidate.config!);
    }
    return current;
  }) : (() => {
    const latest = readConfig(plan.configPath);
    if (latest === undefined || configHash(latest) !== plan.configHash) return fail("plan_changed", "MCP configuration changed after review; nothing was started.");
    return { path: plan.configPath, sha256: plan.configHash, config: parseMcpConfig(latest, plan.configPath) };
  })();
  const output = { ...result("registered"), configPath: saved.path, configHash: saved.sha256 };
  if (!options.activate) return output;
  try {
    const activation = await options.activate({ servers: saved.config.servers.filter(server => selected.some(candidate => candidate.id === server.id)) }, {
      cwd: resolve(options.cwd ?? process.cwd()), home: resolve(options.home ?? homedir()), scope: options.scope ?? "user", configPath: saved.path, login: options.login === true, signal: options.signal,
    });
    return { ...output, status: "activation_reported", activation };
  } catch {
    return { ...output, status: "activation_failed", activation: { ready: false, error: { code: "connection_failed", message: "Configuration was saved, but the connection check failed. Resolve prerequisites and retry." } } };
  }
}
