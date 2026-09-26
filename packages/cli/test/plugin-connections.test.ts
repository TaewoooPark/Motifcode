import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSkillSource, installSkillCandidates, type SkillScope } from "../src/skill-installer.js";
import { connectInstalledSkill, inspectInstalledSkillConnections, type PluginActivationContext } from "../src/plugin-connections.js";
import { runSkillsArgv } from "../src/skills-command.js";
import { runPluginsArgv } from "../src/plugins-command.js";
import { loadMcpConfig, type McpConfig } from "../../mcp/src/config.js";
import { connectMcpServers } from "../src/mcp-connect.js";

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "motif-plugin-connect-")); roots.push(root); return root; };
function file(root: string, path: string, text: string) { const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, text); return target; }
function fixture(servers: Record<string, unknown>, options: { scope?: SkillScope; apps?: Record<string, unknown>; twoSkills?: boolean; serverCode?: string; hooks?: boolean; directMap?: boolean } = {}) {
  const source = temp(); const home = temp(); const cwd = temp(); const scope = options.scope ?? "user";
  file(source, ".claude-plugin/plugin.json", JSON.stringify({ name: "bundle", version: "1.0.0", mcpServers: "./.mcp.json" }));
  file(source, "skills/hello/SKILL.md", "---\nname: hello\ndescription: fixture\n---\nUse the plugin.");
  if (options.twoSkills) file(source, "skills/other/SKILL.md", "---\nname: other\ndescription: fixture\n---\nOther skill.");
  file(source, ".mcp.json", JSON.stringify(options.directMap ? servers : { mcpServers: servers }));
  file(source, "scripts/bootstrap.sh", "#!/bin/sh\nmkdir -p .venv\n");
  if (options.serverCode) file(source, "server.mjs", options.serverCode);
  if (options.hooks) file(source, "hooks/hooks.json", '{"hooks":{}}');
  if (options.apps) file(source, ".app.json", JSON.stringify({ apps: options.apps }));
  const inspection = inspectSkillSource(source, { home, cwd, scope });
  try { installSkillCandidates(inspection, { home, cwd, scope, all: true }); } finally { inspection.cleanup(); }
  return { source, home, cwd, scope, name: "bundle:hello", root: join(scope === "user" ? home : cwd, ".motif") };
}
const local = { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"], env: { API_TOKEN: "${API_TOKEN}" } };
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe("managed package connection plans", () => {
  it("inspects real installed metadata, deduplicates declarations and retains package/environment provenance without writes", () => {
    const f = fixture({ local }, { twoSkills: true });
    const plan = inspectInstalledSkillConnections("bundle", f);
    expect(plan.receiptIds).toHaveLength(2); expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!.config!.args).toEqual([join(plan.runtimeRoot, "server.js")]);
    expect(plan.candidates[0]!.environment).toEqual(["API_TOKEN"]);
    expect(plan.candidates[0]!.config!.env!.CODEX_PLUGIN_ROOT).toBe(plan.runtimeRoot);
    expect(plan.files.map(row => row.path)).toContain(".mcp.json");
    expect(existsSync(plan.configPath)).toBe(false); expect(existsSync(plan.runtimeRoot)).toBe(false);
  });
  it("keeps usable servers alongside invalid declarations and withholds source credentials", () => {
    const f = fixture({ valid: { command: "node", env: { TOKEN: "source-secret" } }, invalid: { type: "websocket", url: "https://example.invalid" }, http: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer source-secret" } } });
    const plan = inspectInstalledSkillConnections(f.name, f);
    expect(plan.candidates.map(row => row.status)).toEqual(["available", "unsupported", "available"]);
    expect(JSON.stringify(plan)).not.toContain("source-secret");
    expect(plan.candidates[0]!.environment).toEqual(["TOKEN"]);
    expect(plan.candidates[2]!.config!.transport).toBe("http");
  });
  it("leaves unknown app IDs and hooks explicitly unsupported while offering the limited official HF adapter", () => {
    const f = fixture({}, { hooks: true, apps: { unknown: { id: "private-host-app", required: true }, hf: { id: "asdk_app_6939e86417648191b7bda087d872685b", required: true } } });
    const plan = inspectInstalledSkillConnections(f.name, f);
    expect(plan.candidates[0]!.status).toBe("unsupported_host");
    expect(plan.candidates[1]!.config!.url).toBe("https://huggingface.co/mcp");
    expect(plan.candidates[1]!.diagnostics[0]!.code).toBe("limited_mcp_adapter");
    expect(plan.diagnostics.some(row => row.code === "unsupported_hooks")).toBe(true);
  });
  it("rejects edited managed snapshots and escaping symlinks before approval", async () => {
    const f = fixture({ local }); const plan = inspectInstalledSkillConnections(f.name, f);
    file(plan.packageRoot, ".mcp.json", '{"mcpServers":{}}');
    await expect(connectInstalledSkill(f.name, { ...f, yes: true })).rejects.toMatchObject({ code: "modified_snapshot" });
    expect(existsSync(plan.configPath)).toBe(false);
    const g = fixture({ local }); const other = inspectInstalledSkillConnections(g.name, g);
    rmSync(join(other.packageRoot, ".mcp.json")); symlinkSync(file(temp(), "outside.json", "{}"), join(other.packageRoot, ".mcp.json"));
    expect(() => inspectInstalledSkillConnections(g.name, g)).toThrow(/unsupported paths/);
  });
  it("requires explicit selection for multiple available connections", async () => {
    const f = fixture({ a: local, b: { command: "node" } });
    await expect(connectInstalledSkill(f.name, { ...f, yes: true })).rejects.toMatchObject({ code: "selection_required" });
    expect((await connectInstalledSkill(f.name, { ...f, dryRun: true })).plan.candidates).toHaveLength(2);
    await expect(connectInstalledSkill(f.name, { ...f, servers: ["missing"], yes: true })).rejects.toMatchObject({ code: "unavailable_server" });
  });
  it("accepts upstream direct maps, Codex second-based timeouts and non-executing source metadata without weakening unknown-field rejection", () => {
    const f = fixture({ paideia: { command: "python3", args: ["-m", "fixture"], startup_timeout_sec: 120, tool_timeout_sec: 1800, supports_parallel_tool_calls: true }, figma: { type: "http", url: "https://example.invalid/mcp", _meta: { display: "Fixture" } }, vercel: { type: "http", url: "https://example.invalid/mcp", note: "An upstream note" }, unknown: { command: "node", headersHelper: "execute-unreviewed-command" }, badTimeout: { command: "node", startup_timeout_sec: "120" }, badHint: { command: "node", supports_parallel_tool_calls: "yes" } }, { directMap: true });
    const plan = inspectInstalledSkillConnections(f.name, f);
    expect(plan.candidates.map(row => row.status)).toEqual(["available", "available", "available", "unsupported", "unsupported", "unsupported"]);
    expect(plan.candidates[0]!.config).toMatchObject({ startupTimeoutMs: 120000, toolTimeoutMs: 1800000 });
    expect(plan.candidates[0]!.diagnostics.some(row => row.code === "source_parallel_hint")).toBe(true);
    expect(plan.candidates[1]!.diagnostics.some(row => row.code === "source_metadata")).toBe(true);
    expect(plan.candidates[2]!.diagnostics.some(row => row.code === "source_metadata")).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("execute-unreviewed-command");
  });
  it("accepts a source OAuth audience only when it is the exact canonical endpoint", () => {
    const f = fixture({ same: { type: "http", url: "https://example.invalid:443/mcp", oauth_resource: "https://example.invalid/mcp" }, other: { type: "http", url: "https://example.invalid/mcp", oauth_resource: "https://other.invalid/mcp" }, variable: { type: "http", url: "${MCP_URL}", oauth_resource: "${MCP_URL}" } });
    const plan = inspectInstalledSkillConnections(f.name, f);
    expect(plan.candidates.map(row => row.status)).toEqual(["available", "unsupported", "unsupported"]);
    expect(plan.candidates[0]!.diagnostics.some(row => row.code === "source_oauth_resource")).toBe(true);
    expect(plan.candidates[1]!.diagnostics.some(row => row.code === "oauth_resource_mismatch")).toBe(true);
  });
});

describe("approval and activation boundary", () => {
  it("does not create a runtime or change configuration when cancelled, dry-run, or not approved", async () => {
    const f = fixture({ local }); const plan = inspectInstalledSkillConnections(f.name, f); const activate = vi.fn();
    expect((await connectInstalledSkill(f.name, { ...f, confirm: async () => false, activate })).status).toBe("cancelled");
    expect((await connectInstalledSkill(f.name, { ...f, dryRun: true, yes: true, activate })).status).toBe("dry-run");
    await expect(connectInstalledSkill(f.name, { ...f, activate })).rejects.toMatchObject({ code: "approval_required" });
    expect(activate).not.toHaveBeenCalled();
    for (const path of [plan.configPath, plan.provenancePath, plan.runtimeRoot]) expect(existsSync(path)).toBe(false);
  });
  it("rejects changed approval plans without overwriting concurrently added settings", async () => {
    const f = fixture({ local }); const config = join(f.root, "mcp.json");
    await expect(connectInstalledSkill(f.name, { ...f, confirm: async () => { file(f.root, "mcp.json", '{"version":1,"servers":[]}'); return true; } })).rejects.toMatchObject({ code: "plan_changed" });
    expect(readFileSync(config, "utf8")).toBe('{"version":1,"servers":[]}');
    expect(existsSync(join(f.root, "plugin-connections.json"))).toBe(false);
  });
  it.each(["user", "project"] as const)("registers only approved %s scope servers, preserves unrelated config and sends login intent to host controller", async scope => {
    const f = fixture({ a: local, b: { command: "node" } }, { scope });
    const unrelated = { id: "existing", transport: "stdio", command: "echo", enabled: false };
    file(f.root, "mcp.json", JSON.stringify({ version: 1, servers: [unrelated] }));
    const activate = vi.fn(async (_config: McpConfig, _context: PluginActivationContext) => ({ ready: false, connections: [{ state: "authentication_required" }] }));
    const result = await connectInstalledSkill(f.name, { ...f, servers: ["a"], yes: true, login: true, activate });
    const saved = JSON.parse(readFileSync(result.configPath!, "utf8"));
    expect(saved.servers).toHaveLength(2); expect(saved.servers[0]).toMatchObject(unrelated);
    expect(activate.mock.calls[0]![0].servers.map((row: { id: string }) => row.id)).toEqual(result.selected);
    expect(activate.mock.calls[0]![1]).toMatchObject({ scope, login: true });
    expect(result.activation).toMatchObject({ ready: false }); expect(result.status).toBe("activation_reported");
    expect(readFileSync(join(f.source, ".mcp.json"), "utf8")).toContain("CLAUDE_PLUGIN_ROOT");
    if (scope === "project") expect(loadMcpConfig({ cwd: f.cwd, home: f.home }).servers).toEqual([]);
    expect(inspectInstalledSkillConnections(f.name, f).candidates[0]!.operation).toBe("reuse");
  });
  it("runs shell bootstraps from a separate copy, permits generated runtime data, and refuses original file edits", async () => {
    const f = fixture({ bootstrap: { command: "bash", args: ["${CODEX_PLUGIN_ROOT}/scripts/bootstrap.sh"] } });
    const result = await connectInstalledSkill(f.name, { ...f, yes: true, activate: async config => {
      const server = config.servers[0]!;
      expect(server.command).toBe("bash");
      file(server.cwd!, ".venv/generated", "dependency cache"); return { ready: true };
    } });
    expect(existsSync(join(result.plan.packageRoot, ".venv"))).toBe(false);
    expect(existsSync(join(result.plan.runtimeRoot, ".venv/generated"))).toBe(true);
    expect(inspectInstalledSkillConnections(f.name, f).candidates[0]!.operation).toBe("reuse");
    file(result.plan.runtimeRoot, "scripts/bootstrap.sh", "edited");
    await expect(connectInstalledSkill(f.name, { ...f, yes: true })).rejects.toMatchObject({ code: "modified_runtime" });
    expect(readFileSync(join(result.plan.runtimeRoot, "scripts/bootstrap.sh"), "utf8")).toBe("edited");
  });
  it("does not overwrite unrelated or manually edited registrations", async () => {
    const f = fixture({ local }); const plan = inspectInstalledSkillConnections(f.name, f);
    file(f.root, "mcp.json", JSON.stringify({ version: 1, servers: [plan.candidates[0]!.config] }));
    expect(inspectInstalledSkillConnections(f.name, f).candidates[0]!.diagnostics.some(row => row.code === "registration_collision")).toBe(true);
    await expect(connectInstalledSkill(f.name, { ...f, yes: true })).rejects.toMatchObject({ code: "no_connections" });
  });
  it("connects a real copied stdio package, lists tools without business calls, and reconnects with generated state present", async () => {
    const f = fixture({ process: { command: process.execPath, args: ["${PLUGIN_ROOT}/server.mjs"] } }, { serverCode: `
      import { appendFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line); appendFileSync('.events', m.method + '\\n');
        if (m.id === undefined) return;
        const result = m.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'package-fixture', version: '1' } }
          : m.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Fixture', inputSchema: { type: 'object' } }] } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
    ` });
    const activate = (config: McpConfig) => connectMcpServers(config, { home: f.home, env: { PATH: process.env.PATH, HOME: f.home } });
    const result = await connectInstalledSkill(f.name, { ...f, yes: true, activate });
    expect(result.activation).toMatchObject({ ready: true, connections: [{ state: "ready", toolCount: 1 }] });
    expect(readFileSync(join(result.plan.runtimeRoot, ".events"), "utf8")).toContain("tools/list");
    expect(readFileSync(join(result.plan.runtimeRoot, ".events"), "utf8")).not.toContain("tools/call");
    expect(existsSync(join(result.plan.packageRoot, ".events"))).toBe(false);
    expect((await connectInstalledSkill(f.name, { ...f, yes: true, activate })).activation).toMatchObject({ ready: true });
  });
  it("validates public OAuth client settings, rejects source secrets, and avoids credential fallback values", () => {
    const f = fixture({ good: { type: "http", url: "https://example.invalid/mcp", oauth: { clientId: "public-client", callbackPort: 8765 } }, bad: { type: "http", url: "https://example.invalid/mcp", oauth: { clientSecret: "private-secret" } }, env: { command: "node", env: { KEY: "${KEY:-private-fallback}" } } });
    const plan = inspectInstalledSkillConnections(f.name, f);
    expect(plan.candidates[0]!.config!.oauth).toEqual({ clientId: "public-client", callbackPort: 8765 });
    expect(plan.candidates[1]!.config).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain("private-secret"); expect(JSON.stringify(plan)).not.toContain("private-fallback");
    expect(plan.candidates[2]!.environment).toEqual(["KEY"]);
  });
  it("reports saved registrations truthfully when the host check throws, without exposing provider exceptions", async () => {
    const f = fixture({ local });
    const result = await connectInstalledSkill(f.name, { ...f, yes: true, activate: async () => { throw new Error("provider-private-secret"); } });
    expect(result.status).toBe("activation_failed"); expect(existsSync(result.configPath!)).toBe(true);
    expect(result.activation).toMatchObject({ ready: false }); expect(JSON.stringify(result)).not.toContain("provider-private-secret");
  });
});

describe("skills/plugins connection commands", () => {
  it("runs deterministic inspect/add aliases and propagates a non-ready check as failure", async () => {
    const f = fixture({ local }); let out = ""; let err = "";
    const io = { ...f, stdout: (text: string) => { out += text; }, stderr: (text: string) => { err += text; } };
    expect(await runPluginsArgv(["inspect", "bundle", "--json"], {}, io)).toBe(0);
    expect(JSON.parse(out).status).toBe("dry-run"); expect(existsSync(join(f.root, "mcp.json"))).toBe(false);
    out = "";
    expect(await runSkillsArgv(["connect", f.name, "--yes", "--login", "--json"], {}, { ...io, connectionOptions: { activate: async (_config, context) => { expect(context.login).toBe(true); return { ready: false }; } } })).toBe(1);
    expect(JSON.parse(out).activation.ready).toBe(false); expect(err).toBe("");
    expect(await runPluginsArgv(["invented-action", "bundle"], {}, io)).toBe(2);
  });
});
