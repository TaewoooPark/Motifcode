import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMcpCommand } from "../src/mcp-command.js";

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "motif-mcp-command-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function capture(cwd: string) { const output: string[] = []; const errors: string[] = []; return { options: { cwd, home: cwd, env: {}, stdout: (text: string) => { output.push(text); }, stderr: (text: string) => { errors.push(text); } }, output, errors }; }

describe("MCP CLI commands", () => {
  it("fails a connection check when an enabled stdio server is still starting at the deadline", async () => {
    const cwd = fixture(); const source = join(cwd, "mcp.json"); const io = capture(cwd);
    const script = join(cwd, "slow-server.mjs"); const log = join(cwd, "server.ndjson");
    writeFileSync(script, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.argv[2];
appendFileSync(log, JSON.stringify({ event: 'boot', pid: process.pid }) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify({ event: request.method }) + '\\n');
  if (request.id !== undefined) setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } } }) + '\\n'), 5000);
});`);
    const text = JSON.stringify({ servers: [{ id: "slow", enabled: true, transport: "stdio", command: process.execPath, args: [script, log], startupTimeoutMs: 1000 }] });
    writeFileSync(source, text);
    const { configHash } = await import("../../mcp/src/config.js");
    const code = await runMcpCommand(["doctor"], { "mcp-config": source, "trust-mcp": configHash(text), connect: true }, io.options);
    const report = JSON.parse(io.output.join(""));
    const events = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.some(event => event.event === "initialize")).toBe(true);
    expect(events.some(event => event.event === "tools/call")).toBe(false);
    expect(() => process.kill(events[0].pid, 0)).toThrow();
    expect(report.connections).toEqual([expect.objectContaining({ server: "slow", enabled: true, state: "connecting", toolCount: 0 })]);
    expect(code).toBe(1);
    expect(report.diagnostics).toEqual([expect.objectContaining({ server: "slow", severity: "error", code: "connection_not_ready" })]);
  }, 10000);

  it("accepts a ready server with no tools and preserves connection errors", async () => {
    const cwd = fixture(); const source = join(cwd, "mcp.json"); const script = join(cwd, "empty-server.mjs");
    writeFileSync(script, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  const result = request.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'empty', version: '1' } } : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`);
    const { configHash } = await import("../../mcp/src/config.js");
    const servers = [{ id: "empty", enabled: true, transport: "stdio", command: process.execPath, args: [script], startupTimeoutMs: 3000 }];
    for (const broken of [false, true]) {
      const io = capture(cwd);
      const text = JSON.stringify({ servers: [...servers, ...(broken ? [{ id: "broken", enabled: true, transport: "stdio", command: join(cwd, "missing-executable") }] : [])] });
      writeFileSync(source, text);
      expect(await runMcpCommand(["doctor"], { "mcp-config": source, "trust-mcp": configHash(text), connect: true }, io.options)).toBe(broken ? 1 : 0);
      const report = JSON.parse(io.output.join(""));
      expect(report.connections).toContainEqual(expect.objectContaining({ server: "empty", state: "ready", toolCount: 0 }));
      if (broken) {
        expect(report.connections).toContainEqual(expect.objectContaining({ server: "broken", state: "error" }));
        expect(report.diagnostics).toEqual([expect.objectContaining({ server: "broken", severity: "error", code: "connection_error" })]);
      } else expect(report.diagnostics).toEqual([]);
    }
  });

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
