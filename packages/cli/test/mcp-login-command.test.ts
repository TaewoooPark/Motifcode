import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOAuthFixture } from "../../mcp/test/fixtures/oauth-server.js";
import { configHash } from "../../mcp/src/config.js";
import { runMcpArgv } from "../src/mcp-command.js";
import { connectMcpServers } from "../src/mcp-connect.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const fixture = await createOAuthFixture(); cleanup.push(() => fixture.close());
  const home = mkdtempSync(join(tmpdir(), "motif-login-cli-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".motif"));
  const path = join(home, ".motif/mcp.json");
  writeFileSync(path, JSON.stringify({ version: 1, servers: [{ id: "fixture", transport: "http", url: fixture.mcpUrl, enabled: true }] }));
  const browser = vi.fn(async (url: URL) => { await fixture.approve(url); });
  const run = async (argv: string[], openBrowser = browser) => {
    let stdout = "", stderr = "";
    const code = await runMcpArgv(argv, {}, { cwd: home, home, openBrowser, stdout: value => stdout += value, stderr: value => stderr += value });
    return { code, stdout, stderr, result: stdout ? JSON.parse(stdout) : undefined };
  };
  return { fixture, home, path, browser, run };
}
describe("MCP browser login commands", () => {
  it("shows a person the URL when the browser cannot open, but never prints it into a pipe", async () => {
    const { fixture, home } = await setup();
    const server = { id: "fixture", transport: "http" as const, url: fixture.mcpUrl, enabled: true };
    const progress: string[] = [];
    const result = await connectMcpServers({ servers: [server] }, { home, forceLogin: true, humanInteractive: true,
      openBrowser: async () => { throw new Error("no display"); },
      onProgress: message => { progress.push(message); const url = /(http:\/\/\S+\/authorize\S*)/.exec(message)?.[1]; if (url) void fixture.approve(new URL(url)); } });
    expect(result.ready).toBe(true);
    expect(progress.join("\n")).toContain("/authorize?");
    const piped = await connectMcpServers({ servers: [server] }, { home, forceLogin: true, noBrowser: true, humanInteractive: false, onProgress: message => { progress.push(message); } });
    expect(piped.connections[0]).toMatchObject({ state: "error", error: { code: "interactive_login_required" } });
  });

  it("connect → browser login → fresh doctor → local logout", async () => {
    const { run, browser } = await setup();
    const blocked = await run(["connect", "fixture"]);
    expect(blocked.code).toBe(1); expect(blocked.result.connections[0].error.code).toBe("authentication_required");
    expect(browser).not.toHaveBeenCalled();
    const connected = await run(["connect", "fixture", "--login"]);
    expect(connected.code).toBe(0); expect(connected.result.connections[0].toolCount).toBe(1);
    expect(browser).toHaveBeenCalledOnce();
    expect((await run(["doctor", "--connect"])).code).toBe(0);
    expect(browser).toHaveBeenCalledOnce();
    expect((await run(["auth-status", "fixture"])).result.state).toBe("authenticated");
    expect((await run(["logout", "fixture"])).result.state).toBe("not_authenticated");
    expect((await run(["connect", "fixture"])).code).toBe(1);
    expect(connected.stdout + connected.stderr).not.toMatch(/access_token|refresh_token|code_verifier|authorization_code/);
  });
  it("reports declined consent without retry or fake readiness", async () => {
    const { run, fixture } = await setup();
    const browser = vi.fn(async (url: URL) => { await fixture.approve(url, "deny"); });
    const result = await run(["login", "fixture"], browser);
    expect(result.code).toBe(1); expect(result.result.ready).toBe(false);
    expect(result.result.connections[0].error.code).toBe("authorization_denied");
    expect(browser).toHaveBeenCalledOnce();
    expect((await run(["auth-status", "fixture"])).result.state).toBe("not_authenticated");
  });
  it("times out browser waiting without leaving a usable credential", async () => {
    const { run } = await setup();
    const browser = vi.fn(async (_url: URL) => {});
    const result = await run(["login", "fixture", "--timeout", "100"], browser);
    expect(result.code).toBe(1); expect(result.result.connections[0].error.code).toBe("timeout");
    expect((await run(["auth-status", "fixture"])).result.state).toBe("not_authenticated");
  });
  it("does not launch or read credentials for an untrusted explicit config", async () => {
    const { run, path, browser } = await setup();
    expect((await run(["login", "fixture", "--mcp-config", path])).result.error.code).toBe("untrusted_config");
    expect(browser).not.toHaveBeenCalled();
    expect((await run(["login", "fixture", "--mcp-config", path, "--trust-mcp", configHash(readFileSync(path, "utf8"))])).code).toBe(0);
  });
  it("persists preregistered public client configuration for subsequent sessions", async () => {
    const { run, path } = await setup();
    expect((await run(["login", "fixture", "--client-id", "public-motif-test", "--scope", "facts:read"])).code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).servers[0].oauth).toMatchObject({ clientId: "public-motif-test", scope: "facts:read" });
    expect((await run(["doctor", "--connect"])).code).toBe(0);
  });
  it("preserves a slow stdio startup deadline instead of reporting an OAuth failure", async () => {
    const { run, path, browser } = await setup();
    writeFileSync(path, JSON.stringify({ version: 1, servers: [{ id: "slow", transport: "stdio", enabled: true,
      command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], startupTimeoutMs: 100 }] }));
    const result = await run(["connect", "slow", "--login"]);
    expect(result.code).toBe(1); expect(result.result.connections[0].error.code).toBe("timeout");
    expect(browser).not.toHaveBeenCalled();
  });
  it("inspects and clears local credentials even when unrelated transport env is unavailable", async () => {
    const { run, path, browser } = await setup();
    expect((await run(["login", "fixture"])).code).toBe(0);
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.servers[0].headers = { "X-Tenant": { env: "MOTIF_TEST_UNAVAILABLE_TENANT_42" } };
    writeFileSync(path, JSON.stringify(config));
    expect((await run(["auth-status", "fixture"])).result.state).toBe("authenticated");
    expect((await run(["logout", "fixture"])).result.state).toBe("not_authenticated");
    expect((await run(["auth-status", "fixture"])).result.state).toBe("not_authenticated");
    expect(browser).toHaveBeenCalledOnce();
  });
});
