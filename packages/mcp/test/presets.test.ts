import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpConfig, resolveServerConfig } from "../src/config.js";
import { createMcpPresetConfig, getMcpPreset, listMcpPresets } from "../src/presets.js";

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "motif-mcp-preset-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("built-in MCP presets", () => {
  it("builds parse-valid disabled recipes without resolving credentials, and returns detached configurations", () => {
    const root = fixture();
    for (const preset of listMcpPresets()) {
      const options = preset.id === "filesystem" ? { root } : preset.options.includes("token-env") ? { tokenEnv: "TEST_TOKEN" } : {};
      const server = createMcpPresetConfig(preset.id, options);
      expect(server.enabled).toBe(false);
      expect(parseMcpConfig(JSON.stringify({ servers: [server] })).diagnostics).toEqual([]);
      if (server.headers) {
        expect(server.headers.Authorization).toBe("Bearer ${TEST_TOKEN}");
        expect(resolveServerConfig(server, { TEST_TOKEN: "private-test-value" }).headers.authorization).toBe("Bearer private-test-value");
      }
      server.enabled = true;
      if (server.args) server.args.push("mutated");
      const rebuilt = createMcpPresetConfig(preset.id, options);
      expect(rebuilt.enabled).toBe(false);
      expect(rebuilt.args ?? []).not.toContain("mutated");
      preset.prerequisites.push("mutated");
      expect(getMcpPreset(preset.id)!.prerequisites).not.toContain("mutated");
    }
  });

  it("scopes filesystem access to an explicit canonical existing directory", () => {
    const cwd = fixture(); const link = join(cwd, "directory-link"); const file = join(cwd, "file.txt");
    symlinkSync(cwd, link); writeFileSync(file, "text");
    expect(createMcpPresetConfig("filesystem", { cwd, root: "directory-link", enabled: true })).toMatchObject({ enabled: true, args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", realpathSync(cwd)] });
    for (const root of [undefined, "", "missing", "file.txt"]) expect(() => createMcpPresetConfig("filesystem", { cwd, root })).toThrow("--root");
  });

  it("registers GitHub without ambient credentials and supports an explicit token reference", () => {
    const server = createMcpPresetConfig("github");
    expect(server).toEqual({ id: "github", enabled: false, transport: "http", url: "https://api.githubcopilot.com/mcp/", credentialProvider: "github-cli" });
    const authenticated = createMcpPresetConfig("github", { tokenEnv: "GITHUB_PERSONAL_ACCESS_TOKEN", enabled: true });
    expect(authenticated.headers).toEqual({ Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" });
    expect(resolveServerConfig(authenticated, { GITHUB_PERSONAL_ACCESS_TOKEN: "private-test-value" }).headers.authorization).toBe("Bearer private-test-value");
    expect(() => resolveServerConfig(authenticated, {})).toThrow();
    expect(parseMcpConfig(JSON.stringify({ servers: [authenticated] })).diagnostics).toEqual([]);
  });

  it("rejects unsupported options and secret values instead of silently ignoring them", () => {
    expect(() => createMcpPresetConfig("unknown")).toThrow("Unknown built-in");
    expect(() => createMcpPresetConfig("gmail")).toThrow("--token-env");
    expect(() => createMcpPresetConfig("context7", { tokenEnv: "key-with-dashes" })).toThrow("variable name");
    expect(() => createMcpPresetConfig("playwright", { tokenEnv: "TOKEN" })).toThrow("not supported");
    expect(() => createMcpPresetConfig("openai-docs", { root: "/tmp" })).toThrow("filesystem");
  });
});
