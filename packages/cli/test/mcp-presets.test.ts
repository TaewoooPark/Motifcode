import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configHash, parseMcpConfig } from "../../mcp/src/config.js";
import { runMcpArgv } from "../src/mcp-command.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => { throw new Error("Preset registration must not spawn a process"); }),
}));
const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "motif-mcp-presets-cli-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function capture(cwd: string) {
  const output: string[] = []; const errors: string[] = [];
  return { options: { cwd, home: cwd, env: { TEST_TOKEN: "private-test-value" }, stdout: (text: string) => { output.push(text); }, stderr: (text: string) => { errors.push(text); } }, output, errors };
}

describe("MCP preset commands", () => {
  it("lists prerequisites offline and registers disabled or explicitly enabled entries without starting them", async () => {
    const cwd = fixture(); const io = capture(cwd); const fetch = vi.fn(() => { throw new Error("Preset registration must not connect"); });
    vi.stubGlobal("fetch", fetch);
    expect(await runMcpArgv(["presets", "filesystem"], {}, io.options)).toBe(0);
    expect(JSON.parse(io.output.pop()!).preset.prerequisites.join(" ")).toContain("--root");
    expect(existsSync(join(cwd, ".motif"))).toBe(false);
    expect(await runMcpArgv(["install", "playwright"], {}, io.options)).toBe(0);
    const disabled = JSON.parse(io.output.pop()!);
    expect(disabled).toMatchObject({ mode: "saved-offline", connected: false, server: { id: "playwright", enabled: false } });
    expect(disabled.nextSteps[1].argv).toEqual(["motif", "mcp", "enable", "playwright"]);
    expect(disabled.note).toContain("Restart");
    expect(await runMcpArgv(["install", "context7", "--enable", "--token-env", "TEST_TOKEN"], {}, io.options)).toBe(0);
    const path = join(cwd, ".motif", "mcp.json"); const text = readFileSync(path, "utf8"); const config = JSON.parse(text);
    expect(config.servers).toEqual([expect.objectContaining({ id: "playwright", enabled: false, profile: "playwright" }), expect.objectContaining({ id: "context7", enabled: true, headers: { Authorization: "Bearer ${TEST_TOKEN}" } })]);
    expect(text + io.output.join("") + io.errors.join("")).not.toContain("private-test-value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(spawn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("retains exact-file trust, preserves existing servers, and refuses duplicate replacement", async () => {
    const cwd = fixture(); const io = capture(cwd); const path = join(cwd, "explicit.json");
    expect(await runMcpArgv(["install", "openai-docs", "--mcp-config", path], {}, io.options)).toBe(0);
    const original = readFileSync(path, "utf8"); const hash = configHash(original);
    expect(await runMcpArgv(["install", "context7", "--mcp-config", path], {}, io.options)).toBe(1);
    expect(JSON.parse(io.output.pop()!).error).toMatchObject({ code: "untrusted_config", sha256: hash });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(await runMcpArgv(["install", "context7", "--mcp-config", path, "--trust-mcp", hash], {}, io.options)).toBe(0);
    const updated = readFileSync(path, "utf8"); const report = JSON.parse(io.output.pop()!);
    expect(parseMcpConfig(updated).servers[0]).toEqual(parseMcpConfig(original).servers[0]);
    expect(report.sha256).toBe(configHash(updated));
    expect(report.sha256).not.toBe(hash);
    expect(report.nextSteps[1].argv).toEqual(["motif", "mcp", "enable", "context7", "--mcp-config", path, "--trust-mcp", report.sha256]);
    expect(report.nextSteps[2].argv).toContain("<SHA256 printed by enable>");
    expect(await runMcpArgv(["install", "context7", "--enable", "--mcp-config", path, "--trust-mcp", report.sha256], {}, io.options)).toBe(1);
    expect(JSON.parse(io.output.pop()!).error.code).toBe("duplicate_server");
    expect(readFileSync(path, "utf8")).toBe(updated);
  });

  it("rejects invalid registration and command options before creating configuration files", async () => {
    const cwd = fixture(); const io = capture(cwd);
    const invalid = [
      ["install", "unknown"], ["install", "filesystem"], ["install", "filesystem", "--root", "missing"],
      ["install", "context7", "--root", cwd], ["install", "playwright", "--token-env", "TOKEN"],
      ["install", "gmail"], ["install", "gmail", "--token-env", "inline-token-value"],
      ["install", "context7", "--enable=true"], ["install", "context7", "--enable", "--enable"],
      ["install", "context7", "--connect"], ["install", "context7", "extra"], ["presets", "--enable"],
    ];
    for (const argv of invalid) expect(await runMcpArgv(argv, {}, io.options), argv.join(" ")).not.toBe(0);
    expect(existsSync(join(cwd, ".motif"))).toBe(false);
    expect(io.output.join("") + io.errors.join("")).not.toContain("inline-token-value");
  });
});
