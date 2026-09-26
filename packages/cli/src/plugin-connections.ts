import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configHash, isRecord, parseMcpConfig, type ConfigDiagnostic, type McpConfig, type McpServerConfig, importMcpConfig, importedServerId } from "@motifcode/mcp";
import { updateMcpConfig } from "./mcp-config-edit.js";
import { listInstalledSkills, SkillInstallError, type SkillReceipt, type SkillScope } from "./skill-installer.js";

export interface PluginConnectionOptions { cwd?: string; home?: string; scope?: SkillScope }
export interface PluginConnectionCandidate {
  sourceKey: string; sourceFile: string; id: string;
  status: "available" | "unsupported_host" | "unsupported";
  config?: McpServerConfig; environment: string[]; diagnostics: ConfigDiagnostic[];
  operation?: "register" | "reuse" | "replace";
}
export interface PluginConnectionPlan {
  name: string; scope: SkillScope; packageRoot: string; runtimeRoot: string; digest: string; receiptIds: string[];
  configPath: string; configHash?: string; provenancePath: string; provenanceHash?: string;
  files: { path: string; sha256: string }[];
  candidates: PluginConnectionCandidate[]; diagnostics: ConfigDiagnostic[];
}
export interface PluginActivationContext { cwd: string; home: string; scope: SkillScope; configPath: string; login: boolean; signal?: AbortSignal }
export interface ConnectInstalledSkillOptions extends PluginConnectionOptions {
  servers?: string[]; all?: boolean; dryRun?: boolean; yes?: boolean; login?: boolean; signal?: AbortSignal;
  confirm?: (plan: PluginConnectionPlan) => Promise<boolean>;
  activate?: (config: McpConfig, context: PluginActivationContext) => Promise<unknown>;
}
export interface PluginConnectionResult {
  status: "dry-run" | "cancelled" | "registered" | "activation_reported" | "activation_failed";
  plan: PluginConnectionPlan; selected: string[]; configPath?: string; configHash?: string; activation?: unknown;
}
interface Provenance {
  id: string; sourceKey: string; sourceFile: string; digest: string; packageRoot: string; runtimeRoot: string;
  receiptIds: string[]; environment: string[]; configHash: string;
}
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const fail = (code: string, message: string): never => { throw new SkillInstallError(code, message); };
const diagnostic = (code: string, message: string, severity: ConfigDiagnostic["severity"] = "warning"): ConfigDiagnostic => ({ code, message, severity });
const within = (root: string, path: string): boolean => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
function settings(options: PluginConnectionOptions) {
  const cwd = resolve(options.cwd ?? process.cwd()); const home = resolve(options.home ?? homedir()); const scope = options.scope ?? "user";
  return { cwd, home, scope, root: join(scope === "project" ? cwd : home, ".motif") };
}
function readRegular(path: string): string | undefined {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (isRecord(error) && error.code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail("unsafe_metadata", "Connection metadata must be a regular file under 2 MiB.");
  return readFileSync(path, "utf8");
}
function parseObject(text: string, label: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text); if (isRecord(value)) return value; } catch { /* no source values in errors */ }
  return fail("invalid_metadata", `${label} must contain a JSON object.`);
}
/** Reproduce the installer's framed digest, including newly added hidden files. */
function verifySnapshot(root: string, receipt: SkillReceipt): string {
  if (receipt.snapshot !== `skill-packages/${receipt.digest}`) fail("invalid_snapshot", "The managed snapshot path is invalid.");
  const path = join(root, receipt.snapshot); const store = join(root, "skill-packages");
  if (lstatSync(store).isSymbolicLink() || lstatSync(path).isSymbolicLink() || !within(realpathSync(root), realpathSync(path))) fail("invalid_snapshot", "The managed snapshot was replaced by a symlink.");
  const files: { path: string; mode: number; size: number; sha256: string }[] = []; let bytes = 0;
  const walk = (at: string, rel: string, depth: number) => {
    const stat = lstatSync(at);
    if (depth > 32 || stat.isSymbolicLink()) fail("modified_snapshot", "The installed snapshot contains unsupported paths; reinstall before connecting.");
    if (stat.isDirectory()) for (const name of readdirSync(at).sort()) walk(join(at, name), rel ? `${rel}/${name}` : name, depth + 1);
    else if (stat.isFile()) {
      if (stat.size > 64 * 1024 * 1024 || (bytes += stat.size) > 256 * 1024 * 1024 || files.length >= 20_000) fail("snapshot_limit", "The installed snapshot exceeds the verification limit.");
      files.push({ path: rel, mode: stat.mode & 0o777, size: stat.size, sha256: hash(readFileSync(at)) });
    } else fail("modified_snapshot", "The installed snapshot contains a special file.");
  };
  walk(path, "", 0);
  if (hash(JSON.stringify(files)) !== receipt.digest) fail("modified_snapshot", "The installed snapshot has local changes. Review and reinstall it before connecting.");
  return path;
}
function installed(name: string, options: PluginConnectionOptions): SkillReceipt[] {
  const rows = listInstalledSkills(options); const exact = rows.filter(row => row.name === name || row.id === name);
  const matches = exact.length ? exact : rows.filter(row => row.namespace === name || row.origin.plugin === name);
  if (!matches.length) fail("not_installed", "No managed skill or plugin namespace with this name is installed in the selected scope.");
  if (new Set(matches.map(row => row.digest)).size !== 1) fail("ambiguous_package", "This namespace refers to multiple package snapshots. Select an installed skill name.");
  return matches;
}
function readProvenance(path: string): Provenance[] {
  const text = readRegular(path); if (!text) return [];
  const value = parseObject(text, "Connection provenance");
  if (value.version !== 1 || !Array.isArray(value.servers) || value.servers.some(row => !isRecord(row) || typeof row.id !== "string" || typeof row.configHash !== "string")) fail("invalid_provenance", "Connection provenance is invalid; no registrations were changed.");
  return value.servers as Provenance[];
}
function checkRuntime(plan: Pick<PluginConnectionPlan, "packageRoot" | "runtimeRoot" | "configPath">): boolean {
  const scopeRoot = dirname(plan.configPath);
  for (const path of [join(scopeRoot, "plugin-runtimes"), dirname(plan.runtimeRoot), plan.runtimeRoot]) {
    if (!existsSync(path)) return false;
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || !within(realpathSync(scopeRoot), realpathSync(path))) fail("unsafe_runtime", "A plugin runtime directory was replaced or redirected. No package files were overwritten.");
  }
  const compare = (source: string, target: string): void => {
    const stat = lstatSync(source);
    if (!existsSync(target) || lstatSync(target).isSymbolicLink()) fail("modified_runtime", "An original package file is missing or redirected in the execution copy. Review it before reconnecting; it was not overwritten.");
    const other = lstatSync(target);
    if (stat.isDirectory()) {
      if (!other.isDirectory()) fail("modified_runtime", "An original package directory was edited in the execution copy.");
      for (const name of readdirSync(source)) compare(join(source, name), join(target, name));
    } else if (!other.isFile() || stat.size !== other.size || (stat.mode & 0o777) !== (other.mode & 0o777) || hash(readFileSync(source)) !== hash(readFileSync(target))) fail("modified_runtime", "An original package file was edited in the execution copy. Review it before reconnecting; it was not overwritten.");
  };
  compare(plan.packageRoot, plan.runtimeRoot);
  return true;
}
function prepareRuntime(plan: PluginConnectionPlan): void {
  if (checkRuntime(plan)) return;
  const parent = dirname(plan.runtimeRoot); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.package-${randomUUID()}`);
  try {
    cpSync(plan.packageRoot, temp, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    if (existsSync(plan.runtimeRoot)) { checkRuntime(plan); return; }
    renameSync(temp, plan.runtimeRoot);
    checkRuntime(plan);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
function envNames(config: McpServerConfig): string[] {
  const names = new Set(config.envVars ?? []);
  const walk = (value: unknown): void => {
    if (typeof value === "string") for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) names.add(match[1]!);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (isRecord(value)) { if (typeof value.env === "string") names.add(value.env); else Object.values(value).forEach(walk); }
  };
  walk(config);
  for (const name of ["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "PLUGIN_ROOT", "CLAUDE_SKILL_DIR"]) names.delete(name);
  return [...names].sort();
}

/** Offline only: never expands ambient credentials, executes package code, or opens a browser. */
export function inspectInstalledSkillConnections(name: string, options: PluginConnectionOptions = {}): PluginConnectionPlan {
  const { root, scope } = settings(options); const receipts = installed(name, options); const receipt = receipts[0]!;
  const packageRoot = verifySnapshot(root, receipt);
  if (!within(packageRoot, resolve(packageRoot, receipt.relativeFile))) fail("invalid_snapshot", "The installed skill path escapes its snapshot.");
  const runtimeRoot = join(root, "plugin-runtimes", receipt.digest, "package");
  const baseDir = dirname(resolve(runtimeRoot, receipt.relativeFile));
  const configPath = join(root, "mcp.json"); const provenancePath = join(root, "plugin-connections.json");
  const configText = readRegular(configPath); const provenanceText = readRegular(provenancePath);
  const plan: PluginConnectionPlan = { name, scope, packageRoot, runtimeRoot, digest: receipt.digest, receiptIds: receipts.map(row => row.id).sort(), configPath,
    ...(configText === undefined ? {} : { configHash: configHash(configText) }), provenancePath,
    ...(provenanceText === undefined ? {} : { provenanceHash: hash(provenanceText) }), files: [], candidates: [], diagnostics: [] };
  const parsed = configText ? parseMcpConfig(configText, configPath) : { servers: [], diagnostics: [] };
  if (parsed.diagnostics.some(row => row.severity === "error")) fail("invalid_config", "The existing MCP configuration is invalid; repair it before connecting.");
  const provenance = readProvenance(provenancePath);
  const sourceIdentity = hash(JSON.stringify({ source: receipt.origin.source, plugin: receipt.origin.plugin, namespace: receipt.namespace })).slice(0, 12);
  const idFor = (key: string): string => `plugin-${sourceIdentity}-${importedServerId(key).slice(0, 75)}-${hash(key).slice(0, 12)}`;
  const read = (path: string): Record<string, unknown> | undefined => {
    if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) fail("invalid_metadata_path", "Plugin metadata paths must remain inside the managed package.");
    const absolute = resolve(packageRoot, path); const text = readRegular(absolute); if (text === undefined) return undefined;
    if (!within(realpathSync(packageRoot), realpathSync(absolute))) fail("invalid_metadata_path", "Plugin metadata escapes its managed package.");
    if (!plan.files.some(row => row.path === path)) plan.files.push({ path, sha256: hash(text) });
    return parseObject(text, "Plugin metadata");
  };
  const manifests = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].flatMap(path => { const value = read(path); return value ? [{ path, value }] : []; });
  const sources = new Map<string, Record<string, unknown>>();
  for (const path of [".mcp.json", "mcp.json"]) { const value = read(path); if (value) sources.set(path, value); }
  const appSources = new Map<string, Record<string, unknown>>(); const defaultApps = read(".app.json"); if (defaultApps) appSources.set(".app.json", defaultApps);
  for (const { path, value } of manifests) {
    if (typeof value.mcpServers === "string") { const source = read(value.mcpServers); if (source) sources.set(value.mcpServers.replace(/^\.\//, ""), source); else plan.diagnostics.push(diagnostic("missing_mcp_file", "A manifest-declared MCP file is missing.")); }
    else if (isRecord(value.mcpServers)) sources.set(path, { mcpServers: value.mcpServers });
    if (typeof value.apps === "string") { const source = read(value.apps); if (source) appSources.set(value.apps.replace(/^\.\//, ""), source); }
    if (value.hooks !== undefined) plan.diagnostics.push(diagnostic("unsupported_hooks", "Plugin hooks are not activated by this connection command."));
  }
  if (existsSync(join(packageRoot, "hooks"))) plan.diagnostics.push(diagnostic("unsupported_hooks", "Package hooks are not activated by this connection command."));
  const rootVariables: Record<string, string> = { CLAUDE_PLUGIN_ROOT: runtimeRoot, CODEX_PLUGIN_ROOT: runtimeRoot, PLUGIN_ROOT: runtimeRoot, CLAUDE_SKILL_DIR: baseDir };
  const expandRoots = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/\$\{(CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT|CLAUDE_SKILL_DIR)\}/g, (_all, key: string) => rootVariables[key]!);
    if (Array.isArray(value)) return value.map(expandRoots);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandRoots(item)]));
    return value;
  };
  const seen = new Map<string, string>();
  for (const [path, source] of sources) {
    // Claude plugins permit both a direct server map and the project-style wrapper.
    if (source.mcpServers !== undefined && !isRecord(source.mcpServers)) { plan.diagnostics.push(diagnostic("unsupported_mcp_file", `${path}: expected a server map or mcpServers object.`, "error")); continue; }
    const entries = isRecord(source.mcpServers) ? source.mcpServers : source;
    for (const [key, raw] of Object.entries(entries)) {
      const signature = hash(JSON.stringify(raw));
      if (seen.get(key) === signature) continue;
      if (seen.has(key)) { plan.candidates.filter(row => row.sourceKey === key).forEach(row => { row.status = "unsupported"; delete row.config; row.diagnostics.push(diagnostic("conflicting_server", "Different plugin files declare the same server name.", "error")); }); continue; }
      seen.set(key, signature);
      const id = idFor(key); const candidate: PluginConnectionCandidate = { sourceKey: key, sourceFile: path, id, status: "unsupported", environment: [], diagnostics: [] };
      plan.candidates.push(candidate);
      if (!isRecord(raw)) { candidate.diagnostics.push(diagnostic("invalid_server", "Server entry must be an object.", "error")); continue; }
      const expanded = expandRoots(raw) as Record<string, unknown>;
      if (receipts.length > 1 && JSON.stringify(raw).includes("${CLAUDE_SKILL_DIR}")) { candidate.diagnostics.push(diagnostic("ambiguous_skill_directory", "This connection depends on one skill directory. Select an installed skill name instead of the plugin namespace.", "error")); continue; }
      const shell = typeof expanded.command === "string" && /^(?:.*[/\\])?(?:sh|bash|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?)$/i.test(expanded.command);
      // The generic importer intentionally blocks shell wrappers. Here they are
      // retained for exact-plan approval, never executed while inspecting.
      const { oauth, oauth_resource, startup_timeout_sec, tool_timeout_sec, supports_parallel_tool_calls, note, _meta, ...transportFields } = expanded;
      if (oauth_resource !== undefined) {
        let sameResource = false;
        try { sameResource = typeof oauth_resource === "string" && typeof expanded.url === "string" && !oauth_resource.includes("${") && !expanded.url.includes("${") && new URL(oauth_resource).href === new URL(expanded.url).href; } catch { /* Unresolved or different resources cannot authorize a token audience. */ }
        if (!sameResource) { candidate.diagnostics.push(diagnostic("oauth_resource_mismatch", "The source OAuth resource must exactly match the configured MCP endpoint. A different or unresolved audience cannot be translated.", "error")); continue; }
        candidate.diagnostics.push(diagnostic("source_oauth_resource", "The source OAuth resource matches the MCP endpoint. Motif keeps its own exact endpoint and issuer binding."));
      }
      if (supports_parallel_tool_calls !== undefined && typeof supports_parallel_tool_calls !== "boolean" || note !== undefined && typeof note !== "string" || _meta !== undefined && !isRecord(_meta)) {
        candidate.diagnostics.push(diagnostic("invalid_source_metadata", "Parallel-call metadata must be boolean, note must be a string, and _meta must be an object.", "error")); continue;
      }
      if (supports_parallel_tool_calls !== undefined) candidate.diagnostics.push(diagnostic("source_parallel_hint", "The source parallel-call hint is retained in the package. Motif's invocation, approval and replay policies remain authoritative."));
      if (note !== undefined || _meta !== undefined) candidate.diagnostics.push(diagnostic("source_metadata", "Source note/_meta metadata is retained in the installed package and is not interpreted as connection or permission settings."));
      const translated = { ...transportFields, ...(shell ? { command: "motif-reviewed-shell-placeholder" } : {}), ...(expanded.url && !expanded.type && !expanded.command ? { type: "http" } : {}) };
      const imported = importMcpConfig("claude", JSON.stringify({ mcpServers: { [key]: translated } }), { sourcePath: join(runtimeRoot, path) }).servers[0]!;
      candidate.diagnostics.push(...imported.diagnostics);
      if (!imported.config) continue;
      const config = { ...imported.config, id, enabled: true, ...(oauth === undefined ? {} : { oauth: oauth as McpServerConfig["oauth"] }),
        ...(startup_timeout_sec === undefined ? {} : { startupTimeoutMs: typeof startup_timeout_sec === "number" ? startup_timeout_sec * 1000 : NaN }),
        ...(tool_timeout_sec === undefined ? {} : { toolTimeoutMs: typeof tool_timeout_sec === "number" ? tool_timeout_sec * 1000 : NaN }) };
      if (shell) { config.command = expanded.command as string; candidate.diagnostics.push(diagnostic("review_shell_command", "Approval permits this package shell command to execute, including its dependency bootstrap.")); }
      if (config.transport === "stdio") {
        config.env = { ...config.env, CLAUDE_PLUGIN_ROOT: runtimeRoot, CODEX_PLUGIN_ROOT: runtimeRoot, PLUGIN_ROOT: runtimeRoot };
        if (isRecord(raw.env)) for (const [envKey, value] of Object.entries(raw.env)) if (typeof value === "string" && /^\$\{(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT|CLAUDE_SKILL_DIR)\}(?:\/[^$]*)?$/.test(value)) config.env[envKey] = expandRoots(value) as string;
        // No caller workspace is silently granted to a package bootstrap.
        config.cwd ??= runtimeRoot;
      }
      if (raw.disabled === true) candidate.diagnostics.push(diagnostic("source_disabled", "This server is disabled in the source. Selecting it explicitly enables this Motif registration."));
      const checked = parseMcpConfig(JSON.stringify({ version: 1, servers: [config] }), join(runtimeRoot, path));
      if (checked.diagnostics.some(row => row.severity === "error")) { candidate.diagnostics.push(...checked.diagnostics); continue; }
      candidate.status = "available"; candidate.config = checked.servers[0]!; candidate.environment = envNames(candidate.config);
    }
  }
  for (const [path, source] of appSources) {
    if (!isRecord(source.apps)) { plan.diagnostics.push(diagnostic("invalid_apps", "App metadata must declare an apps object.", "error")); continue; }
    for (const [key, value] of Object.entries(source.apps)) {
      if (plan.candidates.some(row => row.sourceFile === path && row.sourceKey === key)) continue;
      const candidate: PluginConnectionCandidate = { sourceKey: `app:${key}`, sourceFile: path, id: idFor(`app:${key}`), status: "unsupported_host", environment: [], diagnostics: [] };
      if (isRecord(value) && value.id === "asdk_app_6939e86417648191b7bda087d872685b") {
        candidate.status = "available"; candidate.config = { id: candidate.id, enabled: true, transport: "http", protocol: "legacy", url: "https://huggingface.co/mcp" };
        candidate.diagnostics.push(diagnostic("limited_mcp_adapter", "Official Hugging Face MCP adapter only. This does not activate the Codex app ID, sign in the hf CLI, or guarantee every app capability."));
      } else candidate.diagnostics.push(diagnostic("unsupported_host", "This app ID requires its original host connector runtime. Motif cannot activate it from an app ID alone."));
      plan.candidates.push(candidate);
    }
  }
  for (const candidate of plan.candidates) if (plan.candidates.filter(row => row.id === candidate.id).length > 1) {
    candidate.status = "unsupported"; delete candidate.config;
    candidate.diagnostics.push(diagnostic("conflicting_server", "Multiple connection declarations have this server identity.", "error"));
  }
  for (const candidate of plan.candidates) if (candidate.config) {
    const previous = parsed.servers.find(row => row.id === candidate.id); const recorded = provenance.find(row => row.id === candidate.id);
    if (previous && (!recorded || recorded.configHash !== hash(JSON.stringify(previous)) || recorded.sourceKey !== candidate.sourceKey)) {
      candidate.status = "unsupported"; delete candidate.config;
      candidate.diagnostics.push(diagnostic("registration_collision", "This server ID already belongs to an unrelated or edited configuration; it will not be overwritten.", "error"));
    } else candidate.operation = previous ? (hash(JSON.stringify(previous)) === hash(JSON.stringify(candidate.config)) ? "reuse" : "replace") : "register";
  }
  if (!plan.candidates.length) plan.diagnostics.push(diagnostic("no_connections", "No supported MCP or app connection declarations were found in this installed package."));
  if (plan.candidates.some(row => row.config?.transport === "stdio")) checkRuntime(plan);
  return plan;
}

/** Approval is a boundary: cancellation/dry-run leave both configuration files untouched. */
export async function connectInstalledSkill(name: string, options: ConnectInstalledSkillOptions = {}): Promise<PluginConnectionResult> {
  const config = settings(options); const plan = inspectInstalledSkillConnections(name, options);
  const available = plan.candidates.filter(row => row.config && row.status === "available");
  if (options.all && options.servers?.length) fail("ambiguous_selection", "Choose --all or --server selections, not both.");
  let selected: PluginConnectionCandidate[];
  if (options.servers?.length) {
    selected = [...new Set(options.servers)].map(name => {
      const matches = available.filter(row => row.id === name || row.sourceKey === name);
      if (matches.length !== 1) return fail("unavailable_server", "A selected server is unavailable or ambiguous. Inspect the connection plan first.");
      return matches[0]!;
    });
  } else if (options.all || available.length <= 1) selected = available;
  else if (options.dryRun) selected = [];
  else return fail("selection_required", "This package has several connection candidates. Review --dry-run, then select --server NAME or --all.");
  const result = (status: PluginConnectionResult["status"]): PluginConnectionResult => ({ status, plan, selected: selected.map(row => row.id) });
  if (options.dryRun) return result("dry-run");
  if (!selected.length) fail("no_connections", "No selectable connection is available. Inspect the diagnostics; no configuration was changed.");
  const approvalPlan = { ...plan, candidates: plan.candidates.filter(row => selected.includes(row)) };
  if (options.signal?.aborted) return result("cancelled");
  if (!options.yes && !options.confirm) fail("approval_required", "Review this command with --dry-run, then use --yes to authorize the selected server startup. Noninteractive browser sign-in additionally requires --login.");
  if (!options.yes && !await options.confirm!(approvalPlan)) return result("cancelled");
  if (options.signal?.aborted) return result("cancelled");
  // Awaiting the user must not authorize changed snapshots/configuration.
  const fresh = inspectInstalledSkillConnections(name, options);
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) fail("plan_changed", "The package or MCP configuration changed after inspection. Review a fresh plan; nothing was changed.");
  const selectedConfigs = selected.map(row => row.config!);
  if (selectedConfigs.some(row => row.transport === "stdio")) prepareRuntime(plan);
  const provenance = readProvenance(plan.provenancePath).filter(row => !selected.some(candidate => candidate.id === row.id));
  provenance.push(...selected.map(row => ({ id: row.id, sourceKey: row.sourceKey, sourceFile: row.sourceFile, digest: plan.digest, packageRoot: plan.packageRoot, runtimeRoot: plan.runtimeRoot, receiptIds: plan.receiptIds, environment: row.environment, configHash: hash(JSON.stringify(row.config)) })));
  const temp = `${plan.provenancePath}.${randomUUID()}.tmp`;
  mkdirSync(dirname(temp), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, servers: provenance }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    const saved = updateMcpConfig({ home: config.home, cwd: config.cwd, path: plan.configPath, trustHash: plan.configHash }, current => {
      if ((readRegular(plan.configPath) === undefined ? undefined : configHash(readRegular(plan.configPath)!)) !== plan.configHash || (readRegular(plan.provenancePath) === undefined ? undefined : hash(readRegular(plan.provenancePath)!)) !== plan.provenanceHash) fail("plan_changed", "Connection configuration changed; review again before connecting.");
      return { servers: [...current.servers.filter(row => !selected.some(candidate => candidate.id === row.id)), ...selectedConfigs] };
    });
    try { renameSync(temp, plan.provenancePath); }
    catch { fail("provenance_write_failed", "MCP registrations were saved but provenance could not be saved. No servers were started; repair the connection metadata before retrying."); }
    const output = { ...result("registered"), configPath: saved.path, configHash: saved.sha256 };
    if (options.activate) {
      try {
        const activation = await options.activate({ servers: selectedConfigs }, { cwd: config.cwd, home: config.home, scope: config.scope, configPath: saved.path, login: options.login === true, signal: options.signal });
        return { ...output, status: "activation_reported", activation };
      } catch {
        return { ...output, status: "activation_failed", activation: { ready: false, error: { code: options.signal?.aborted ? "cancelled" : "connection_failed", message: "Registrations were saved, but the connection check did not complete. Inspect the saved configuration and retry connect." } } };
      }
    }
    return output;
  } finally { rmSync(temp, { force: true }); }
}
