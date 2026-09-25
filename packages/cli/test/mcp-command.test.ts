import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMcpCommand } from "../src/mcp-command.js";

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "motif-mcp-command-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function capture(cwd: string) { const output: string[] = []; const errors: string[] = []; return { options: { cwd, home: cwd, env: {}, stdout: (text: string) => { output.push(text); }, stderr: (text: string) => { errors.push(text); } }, output, errors }; }

describe("MCP CLI offline commands", () => {
  it("defaults import to dry-run and writes only disabled config when explicitly requested", async () => {
    const cwd = fixture(); const source = join(cwd, "claude.json"); const target = join(cwd, "mcp.json"); const io = capture(cwd);
    writeFileSync(source, JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } } }));
    expect(await runMcpCommand(["import", "claude", source], {}, io.options)).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(io.output.join("")).toContain('"mode": "dry-run"');
    expect(await runMcpCommand(["import"], { from: "claude", file: source, write: target }, io.options)).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8")).servers[0].enabled).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(await runMcpCommand(["import", "claude", source], { write: target }, io.options)).toBe(1);
  });
  it("list and doctor never execute a configured process and never output secrets", async () => {
    const cwd = fixture(); const source = join(cwd, "mcp.json"); const sentinel = join(cwd, "executed"); const io = capture(cwd);
    writeFileSync(source, JSON.stringify({ servers: { probe: { transport: "stdio", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)},'yes')`], env: { TOKEN: "private-config-value" } } } }));
    expect(await runMcpCommand(["list"], { "mcp-config": source }, io.options)).toBe(0);
    expect(await runMcpCommand(["doctor"], { "mcp-config": source }, io.options)).toBe(0);
    expect(await runMcpCommand(["doctor"], { "mcp-config": source, connect: true }, io.options)).toBe(1);
    expect(existsSync(sentinel)).toBe(false);
    expect(io.output.join("")).not.toContain("private-config-value");
    expect(io.output.join("")).toContain("untrusted_config");
  });
  it("does not attempt a connection for disabled entries", async () => {
    const cwd = fixture(); const source = join(cwd, "mcp.json"); const io = capture(cwd);
    const text = JSON.stringify({ servers: { invalid: { transport: "stdio", command: "this-command-must-not-exist", enabled: false } } });
    writeFileSync(source, text);
    const { configHash } = await import("../../mcp/src/config.js");
    expect(await runMcpCommand(["doctor"], { "mcp-config": source, "trust-mcp": configHash(text), connect: true }, io.options)).toBe(0);
    expect(JSON.parse(io.output.join("")).connections).toEqual([{ server: "invalid", enabled: false, transport: "stdio", state: "disabled", toolCount: 0 }]);
  });
  it("does not write partially supported imports or disclose inline values", async () => {
    const cwd = fixture(); const source = join(cwd, "claude.json"); const target = join(cwd, "mcp.json"); const io = capture(cwd);
    writeFileSync(source, JSON.stringify({ mcpServers: { a: { command: "node", env: { TOKEN: "sensitive" } }, b: { command: "node", alwaysAllow: ["write"] } } }));
    expect(await runMcpCommand(["import", "claude", source], { write: target }, io.options)).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(io.output.join("") + io.errors.join("")).not.toContain("sensitive");
  });
});
