import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configHash, loadMcpConfig } from "../../mcp/src/config.js";
import { editMcpConfig, summarizeMcpServer, updateMcpConfig } from "../src/mcp-config-edit.js";

const dirs: string[] = [];
function fixture() { const home = mkdtempSync(join(tmpdir(), "motif-mcp-edit-")); dirs.push(home); return { home, path: join(home, ".motif", "mcp.json") }; }
const server = { id: "local", enabled: true, transport: "stdio" as const, command: "node", args: ["server.mjs"], env: { TOKEN: { env: "SOURCE_TOKEN" } } };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("private atomic MCP configuration edits", () => {
  it("creates a private file, preserves settings and supports explicit add/disable/enable/remove", () => {
    const f = fixture(); const added = editMcpConfig({ kind: "add", server }, { home: f.home });
    expect(added.sha256).toBe(configHash(readFileSync(f.path, "utf8")));
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.home, ".motif")).mode & 0o777).toBe(0o700);
    expect(added.config.servers[0]).toMatchObject(server);
    expect(editMcpConfig({ kind: "disable", id: "local" }, { home: f.home }).config.servers[0]?.enabled).toBe(false);
    expect(editMcpConfig({ kind: "enable", id: "local" }, { home: f.home }).config.servers[0]?.enabled).toBe(true);
    expect(editMcpConfig({ kind: "remove", id: "local" }, { home: f.home }).config.servers).toEqual([]);
    expect(readdirSync(join(f.home, ".motif"))).toEqual(["mcp.json"]);
  });

  it("rejects duplicate names, malformed entries and invalid existing documents without overwrite", () => {
    const f = fixture(); editMcpConfig({ kind: "add", server }, { home: f.home });
    const before = readFileSync(f.path, "utf8");
    expect(() => editMcpConfig({ kind: "add", server }, { home: f.home })).toThrow(/already exists/);
    expect(() => editMcpConfig({ kind: "add", server: { ...server, id: "__motif_host__" } }, { home: f.home })).toThrow(/invalid/);
    expect(readFileSync(f.path, "utf8")).toBe(before);
    writeFileSync(f.path, '{"malformed":"synthetic-secret"');
    expect(() => editMcpConfig({ kind: "add", server }, { home: f.home })).toThrow(/not overwritten/);
    expect(readFileSync(f.path, "utf8")).toBe('{"malformed":"synthetic-secret"');
  });

  it("requires the exact current hash for explicit config edits, including each later edit", () => {
    const f = fixture(); const path = join(f.home, "project.json"); const text = '{"servers":[]}'; writeFileSync(path, text);
    expect(() => editMcpConfig({ kind: "add", server }, { path })).toThrow(/SHA256/);
    const saved = editMcpConfig({ kind: "add", server }, { path, trustHash: configHash(text) });
    expect(() => editMcpConfig({ kind: "disable", id: "local" }, { path, trustHash: configHash(text) })).toThrow(/SHA256/);
    expect(editMcpConfig({ kind: "disable", id: "local" }, { path, trustHash: saved.sha256 }).config.servers[0]?.enabled).toBe(false);
    const newPath = join(f.home, "new.json");
    const created = editMcpConfig({ kind: "add", server }, { path: newPath });
    expect(created.config.servers[0]?.enabled).toBe(true);
    expect(loadMcpConfig({ path: newPath }).servers[0]?.enabled).toBe(false);
    expect(loadMcpConfig({ path: newPath, trustHash: created.sha256 }).servers[0]?.enabled).toBe(true);
  });

  it("refuses an occupied cooperative lock and never removes another owner's lock", () => {
    const f = fixture(); mkdirSync(join(f.home, ".motif")); writeFileSync(f.path + ".lock", "other editor");
    expect(() => editMcpConfig({ kind: "add", server }, { home: f.home })).toThrow(/holds the lock/);
    expect(readFileSync(f.path + ".lock", "utf8")).toBe("other editor");
    expect(existsSync(f.path)).toBe(false);
  });

  it("detects non-cooperative writes before commit and cleans up only its own temporary files", () => {
    const f = fixture(); editMcpConfig({ kind: "add", server }, { home: f.home });
    const external = '{"servers":[],"version":1}';
    expect(() => updateMcpConfig({ home: f.home }, (config) => { writeFileSync(f.path, external); config.servers[0]!.enabled = false; return config; })).toThrow(/changed during/);
    expect(readFileSync(f.path, "utf8")).toBe(external);
    expect(readdirSync(join(f.home, ".motif"))).toEqual(["mcp.json"]);
  });

  it("rejects symbolic-link targets and withholds unexpected error text", () => {
    const f = fixture(); mkdirSync(join(f.home, ".motif")); const target = join(f.home, "private.json"); writeFileSync(target, '{"servers":[]}'); symlinkSync(target, f.path);
    expect(() => editMcpConfig({ kind: "add", server }, { home: f.home })).toThrow(/regular file/);
    expect(readFileSync(target, "utf8")).toBe('{"servers":[]}');
    rmSync(f.path);
    expect(() => updateMcpConfig({ home: f.home }, () => { throw new Error("SYNTHETIC_SECRET_DO_NOT_ECHO"); })).toThrow("Could not safely update");
    expect(existsSync(f.path)).toBe(false);
  });

  it("never exposes stored process, URL, header or environment literals in summaries", () => {
    const value = "SYNTHETIC_PRIVATE_VALUE";
    const summary = JSON.stringify(summarizeMcpServer({ ...server, command: value, args: [value], cwd: value, url: "https://example.test/" + value, env: { TOKEN: value, REFERENCED: { env: "SOURCE_TOKEN" }, FALLBACK: '${OTHER_TOKEN:-' + value + '}' }, headers: { Authorization: "Bearer ${AUTH_TOKEN}" } }));
    expect(summary).not.toContain(value);
    expect(summary).toContain("SOURCE_TOKEN"); expect(summary).toContain("AUTH_TOKEN"); expect(summary).toContain("OTHER_TOKEN");
  });
});
