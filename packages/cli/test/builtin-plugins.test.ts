import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillRegistry } from "@motifcode/skills";
import { configHash, type McpConfig } from "../../mcp/src/config.js";
import { createMcpPresetConfig } from "../../mcp/src/presets.js";
import { connectBuiltinPlugin } from "../src/builtin-plugin-connections.js";
import { loadBuiltinPlugins, loadPlugins } from "../src/plugins.js";
import { runPluginsArgv } from "../src/plugins-command.js";

vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(() => { throw new Error("Unexpected server startup"); }),
}));
const dirs: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "motif-bundled-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function capture(home = fixture(), cwd = fixture()) {
  const output: string[] = []; const errors: string[] = [];
  return { home, cwd, output, errors, options: { home, cwd, stdout: (text: string) => { output.push(text); }, stderr: (text: string) => { errors.push(text); } } };
}
function writeConfig(home: string, servers: unknown[]) {
  const path = join(home, ".motif", "mcp.json"); mkdirSync(join(home, ".motif"), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, servers }, null, 2) + "\n"); return path;
}

describe("bundled plugins", () => {
  it("lists MCP workflow skills for the model only while their server is enabled", () => {
    const skills = new SkillRegistry(); skills.registerAll(loadBuiltinPlugins().skills);
    let enabled: string[] = [];
    skills.setMcpServers(() => enabled);
    const indexed = () => skills.listFor("model").map(skill => skill.name);
    expect(indexed()).toEqual(["mcp-builder"]);
    expect(skills.listFor("user").map(skill => skill.name)).toContain("library-docs");
    enabled = ["context7"];
    expect(indexed()).toEqual(["frontend-quality", "library-docs", "mcp-builder", "react-composition"]);
    enabled = ["context7", "playwright", "github"];
    expect(indexed()).toEqual(["browser-testing", "frontend-quality", "github-workflow", "library-docs", "mcp-builder", "react-composition"]);
    expect(skills.index()).toContain("browser-testing");
  });

  it("ships five offline plugins with readable skills and no startup side effects", async () => {
    const io = capture(); const fetch = vi.fn(() => { throw new Error("Unexpected network access"); }); vi.stubGlobal("fetch", fetch);
    const loaded = loadBuiltinPlugins();
    expect(loaded.plugins.map(plugin => plugin.name)).toEqual(["browser-web-testing", "frontend-quality", "github-workflow", "library-docs", "mcp-builder"]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.skills.length).toBeGreaterThanOrEqual(5);
    expect(loaded.skills.every(skill => skill.source === "builtin" && skill.filePath && existsSync(skill.filePath))).toBe(true);
    expect(await runPluginsArgv(["list", "--json"], {}, io.options)).toBe(0);
    expect(JSON.parse(io.output.pop()!).plugins).toHaveLength(5);
    expect(await runPluginsArgv(["inspect", "library-docs", "--json"], {}, io.options)).toBe(0);
    expect(JSON.parse(io.output.pop()!).plan.candidates[0]).toMatchObject({ id: "context7", status: "available", operation: "register" });
    expect(existsSync(join(io.home, ".motif"))).toBe(false); expect(existsSync(join(io.cwd, ".motif"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });

  it("lets user and project skills override bundled skills without altering the distribution", () => {
    const io = capture();
    for (const [root, body] of [[io.home, "user version"], [io.cwd, "project version"]]) {
      const path = join(root!, ".motif", "plugins", "custom"); mkdirSync(join(path, "skills", "library-docs"), { recursive: true });
      writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: "custom", description: "custom" }));
      writeFileSync(join(path, "skills", "library-docs", "SKILL.md"), `---\nname: library-docs\ndescription: ${body}\n---\n${body}\n`);
    }
    const registry = new SkillRegistry(); registry.registerAll(loadPlugins(io).skills);
    expect(registry.list().find(skill => skill.name === "library-docs")).toMatchObject({ description: "project version", source: "project" });
    expect(loadBuiltinPlugins().skills.find(skill => skill.name === "library-docs")?.source).toBe("builtin");
  });

  it("does not mutate on dry-run or missing approval and registers through the normal activator", async () => {
    const io = capture(); const activate = vi.fn(async (_config: McpConfig) => ({ ready: true }));
    expect(await runPluginsArgv(["connect", "library-docs", "--dry-run", "--json"], {}, { ...io.options, connectionOptions: { activate } })).toBe(0);
    expect(existsSync(join(io.home, ".motif"))).toBe(false);
    expect(await runPluginsArgv(["connect", "library-docs", "--json"], {}, { ...io.options, connectionOptions: { activate } })).toBe(1);
    expect(JSON.parse(io.output.pop()!).error.code).toBe("approval_required"); expect(existsSync(join(io.home, ".motif"))).toBe(false);
    expect(await runPluginsArgv(["connect", "library-docs", "--yes", "--json"], {}, { ...io.options, connectionOptions: { activate } })).toBe(0);
    expect(activate).toHaveBeenCalledOnce(); expect(activate.mock.calls[0]![0]).toMatchObject({ servers: [{ id: "context7", enabled: true }] });
    expect(JSON.parse(readFileSync(join(io.home, ".motif", "mcp.json"), "utf8")).servers).toHaveLength(1);
    expect(JSON.parse(io.output.pop()!).activation.ready).toBe(true);
  });

  it("preserves unrelated servers and existing auth/restrictions without resolving credentials", async () => {
    const io = capture(); const context = { ...createMcpPresetConfig("context7", { enabled: true }), headers: { Authorization: "Bearer ${CONTEXT_KEY}" }, deniedTools: ["forbidden"] };
    const other = { id: "custom", enabled: false, transport: "http", url: "https://example.com/mcp" };
    const path = writeConfig(io.home, [other, context]); const before = readFileSync(path, "utf8");
    const activate = vi.fn(async (_config: McpConfig) => ({ ready: true }));
    const result = await connectBuiltinPlugin("library-docs", { ...io.options, yes: true, activate });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(before));
    expect(activate.mock.calls[0]![0]).toMatchObject({ servers: [context] });
    expect(JSON.stringify(result.plan)).not.toContain("CONTEXT_KEY");
  });

  it("preserves disabled and conflicting configurations without activation", async () => {
    for (const server of [createMcpPresetConfig("context7"), { ...createMcpPresetConfig("context7", { enabled: true }), url: "https://example.com/custom" }]) {
      const io = capture(); const path = writeConfig(io.home, [server]); const before = readFileSync(path, "utf8"); const activate = vi.fn();
      await expect(connectBuiltinPlugin("library-docs", { ...io.options, yes: true, activate })).rejects.toMatchObject({ code: "unavailable_server" });
      expect(readFileSync(path, "utf8")).toBe(before); expect(activate).not.toHaveBeenCalled();
    }
  });

  it("aborts when configuration changes while awaiting approval", async () => {
    const io = capture(); const activate = vi.fn();
    await expect(connectBuiltinPlugin("library-docs", { ...io.options, activate, confirm: async () => {
      writeConfig(io.home, [{ id: "added-during-review", enabled: false, transport: "http", url: "https://example.com/mcp" }]); return true;
    } })).rejects.toMatchObject({ code: "plan_changed" });
    expect(activate).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(io.home, ".motif", "mcp.json"), "utf8")).servers).toHaveLength(1);
  });

  it("keeps project registrations scoped and prints the hash for trusted startup", async () => {
    const io = capture(); const activate = vi.fn(async () => ({ ready: false, errors: ["authentication_required"] }));
    expect(await runPluginsArgv(["connect", "library-docs", "--scope", "project", "--yes", "--json"], {}, { ...io.options, connectionOptions: { activate } })).toBe(1);
    const result = JSON.parse(io.output.pop()!); const text = readFileSync(join(io.cwd, ".motif", "mcp.json"), "utf8");
    expect(result.configHash).toBe(configHash(text)); expect(result.plan.scope).toBe("project"); expect(result.activation.ready).toBe(false);
    expect(existsSync(join(io.home, ".motif"))).toBe(false);
  });

  it("lists bundled plugins in installed output and skips connection for skill-only bundles", async () => {
    const io = capture(); const activate = vi.fn();
    expect(await runPluginsArgv(["installed", "--scope", "project", "--json"], {}, io.options)).toBe(0);
    expect(JSON.parse(io.output.pop()!)).toMatchObject({ plugins: expect.arrayContaining([expect.objectContaining({ name: "mcp-builder", source: "builtin" })]), managedSkills: [] });
    expect(await runPluginsArgv(["connect", "mcp-builder", "--json"], {}, { ...io.options, connectionOptions: { activate } })).toBe(0);
    expect(JSON.parse(io.output.pop()!).plan.diagnostics[0].code).toBe("skills_only");
    expect(activate).not.toHaveBeenCalled(); expect(existsSync(join(io.home, ".motif"))).toBe(false);
  });
});
