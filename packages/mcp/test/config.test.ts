import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configHash, defaultMcpConfigPath, loadMcpConfig, parseMcpConfig, resolveServerConfig } from "../src/config.js";

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "motif-mcp-config-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const document = (server: Record<string, unknown>) => JSON.stringify({ version: 1, servers: { docs: { transport: "stdio", command: "node", ...server } } });

describe("MCP configuration authorization", () => {
  it("loads the user file but never automatically loads a project declaration", () => {
    const home = fixture(); const cwd = fixture();
    mkdirSync(join(cwd, ".motif")); writeFileSync(defaultMcpConfigPath(cwd), document({ command: "untrusted-command" }));
    expect(loadMcpConfig({ home, cwd }).servers).toEqual([]);
    mkdirSync(join(home, ".motif")); writeFileSync(defaultMcpConfigPath(home), document({}));
    const config = loadMcpConfig({ home, cwd });
    expect(config.servers[0]?.command).toBe("node");
    expect(config.servers[0]?.enabled).toBe(true);
  });
  it("binds explicit-file authorization to the exact bytes and replaces global configuration", () => {
    const home = fixture(); const cwd = fixture(); const file = join(cwd, "project.json"); const text = document({});
    writeFileSync(file, text);
    expect(loadMcpConfig({ home, path: file }).servers[0]?.enabled).toBe(false);
    expect(loadMcpConfig({ home, path: file, trustHash: configHash(text) }).servers[0]?.enabled).toBe(true);
    writeFileSync(file, document({ command: "changed-command" }));
    expect(loadMcpConfig({ home, path: file, trustHash: configHash(text) }).servers[0]?.enabled).toBe(false);
  });
  it("fails closed on unknown policy fields, duplicate ids, and malformed entries", () => {
    expect(parseMcpConfig(document({ allowEverything: true })).servers).toEqual([]);
    expect(parseMcpConfig(JSON.stringify({ servers: [{ id: "docs", transport: "stdio", command: "x" }, { id: "docs", transport: "stdio", command: "y" }] })).servers).toEqual([]);
    expect(parseMcpConfig(JSON.stringify({ servers: { good: { transport: "stdio", command: "node" }, bad: null } })).servers).toEqual([]);
  });
  it("does not echo values from JSON or native configuration errors", () => {
    expect(JSON.stringify(parseMcpConfig('{"API_KEY":"very-secret"'))).not.toContain("very-secret");
    expect(JSON.stringify(parseMcpConfig(document({ transport: "http", command: undefined, url: "https://user:very-secret@example.test/mcp" })))).not.toContain("very-secret");
  });
});

describe("MCP connection configuration", () => {
  it("does not inherit model/provider keys or process execution injection variables", () => {
    const server = parseMcpConfig(document({ envVars: ["EXPLICIT_TOKEN"], env: { TOKEN: { env: "SERVER_TOKEN" }, MODE: "readonly" } })).servers[0]!;
    const env = { PATH: "/usr/bin", HOME: "/tmp", MOTIF_API_KEY: "model-secret", OPENAI_API_KEY: "provider-secret", NODE_OPTIONS: "--require evil.js", EXPLICIT_TOKEN: "deliberate", SERVER_TOKEN: "server-secret" };
    const result = resolveServerConfig(server, env);
    expect({ ...result.env }).toEqual({ PATH: "/usr/bin", HOME: "/tmp", EXPLICIT_TOKEN: "deliberate", TOKEN: "server-secret", MODE: "readonly" });
    expect(env.MOTIF_API_KEY).toBe("model-secret");
  });
  it("preserves argv boundaries, resolves environment references without shell execution", () => {
    const server = parseMcpConfig(document({ args: ["two words", "${ROOT}/한글", "$(touch sentinel)", "${OPTION:-fallback}"], cwd: "./workspace" }), "/tmp/config/mcp.json").servers[0]!;
    const result = resolveServerConfig(server, { ROOT: "/tmp" });
    expect(result.args).toEqual(["two words", "/tmp/한글", "$(touch sentinel)", "fallback"]);
    expect(result.cwd).toBe("/tmp/config/workspace");
  });
  it("fails with variable names only on missing credentials and rejects header injection", () => {
    const server = parseMcpConfig(document({ command: undefined, transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${SERVER_TOKEN}" } })).servers[0]!;
    expect(() => resolveServerConfig(server, {})).toThrow("Missing environment variable SERVER_TOKEN");
    expect(() => resolveServerConfig(server, { SERVER_TOKEN: "secret\r\nHost:evil" })).toThrow("Invalid characters");
    expect(resolveServerConfig(server, { SERVER_TOKEN: "secret" }).headers.authorization).toBe("Bearer secret");
  });
  it("rejects transport-owned headers, plain credentials, and mismatched transport fields", () => {
    for (const headers of [{ Host: "evil" }, { Authorization: "secret" }, { authorization: "${A}", Authorization: "${B}" }, { "Mcp-Session-Id": "${SESSION}" }, { "Proxy-Authorization": "${TOKEN}" }, { "Content-Length": "7" }, { Cookie: "${COOKIE}" }, { "Invalid Header": "${VALUE}" }]) {
      expect(parseMcpConfig(document({ command: undefined, transport: "http", url: "https://example.test/mcp", headers })).servers).toEqual([]);
    }
    expect(parseMcpConfig(document({ url: "https://example.test/mcp" })).servers).toEqual([]);
  });
  it("supports explicit custom credential headers and known public version headers", () => {
    const parsed = parseMcpConfig(document({ command: undefined, transport: "http", url: "https://example.test/mcp", headers: { CONTEXT7_API_KEY: { env: "CONTEXT7_TOKEN" }, "X-GitHub-Api-Version": "2022-11-28" } }));
    expect(parsed.diagnostics).toEqual([]);
    expect(resolveServerConfig(parsed.servers[0]!, { CONTEXT7_TOKEN: "secret" }).headers).toEqual({ context7_api_key: "secret", "x-github-api-version": "2022-11-28" });
  });
});
