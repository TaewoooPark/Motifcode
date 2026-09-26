import { describe, expect, it } from "vitest";
import { importClaudeConfig, importCodexConfig, importedServerId } from "../src/importers.js";
import { resolveServerConfig } from "../src/config.js";

const options = { sourcePath: "/tmp/source/config.json" };
describe("Codex MCP import", () => {
  it("preserves process argv, environment references, tool restrictions and timeout units", () => {
    const result = importCodexConfig(`
[mcp_servers.files]
command = "npx"
args = ["-y", "@example/server@1.0.0", "two words"]
cwd = "workspace"
env_vars = ["SERVER_TOKEN"]
enabled_tools = ["read_file"]
disabled_tools = ["write_file"]
startup_timeout_sec = 12
tool_timeout_sec = 30
`, options);
    expect(result.config.servers[0]).toMatchObject({ id: "files", enabled: false, transport: "stdio", cwd: "/tmp/source/workspace", envVars: ["SERVER_TOKEN"], allowedTools: ["read_file"], deniedTools: ["write_file"], startupTimeoutMs: 12000, toolTimeoutMs: 30000 });
    expect(result.config.servers[0]?.args?.[2]).toBe("two words");
  });
  it("translates HTTP bearer and header references without resolving credentials", () => {
    const result = importCodexConfig(`
[mcp_servers.docs]
url = "https://example.test/mcp"
bearer_token_env_var = "DOCS_TOKEN"
[mcp_servers.docs.env_http_headers]
"X-API-Key" = "DOCS_API_KEY"
`, options);
    const server = result.config.servers[0]!;
    expect(server.headers).toEqual({ authorization: "Bearer ${DOCS_TOKEN}", "x-api-key": { env: "DOCS_API_KEY" } });
    expect(resolveServerConfig(server, { DOCS_TOKEN: "secret", DOCS_API_KEY: "other" }).headers.authorization).toBe("Bearer secret");
  });
  it("excludes unsupported semantics instead of silently weakening the source", () => {
    const result = importCodexConfig('[mcp_servers.a]\ncommand="node"\nremote="ssh-host"\n', options);
    expect(result.servers[0]?.status).toBe("unsupported");
    expect(result.config.servers).toEqual([]);
    expect(result.diagnostics.some((entry) => entry.field === "remote")).toBe(true);
  });
});

describe("Claude MCP import", () => {
  it("imports only the selected scope and never copies credentials from env or auth headers", () => {
    const source = JSON.stringify({ mcpServers: { one: { command: "node", env: { TOKEN: "inline-env-secret" } } }, projects: { "/work": { mcpServers: { two: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer inline-header-secret" } } } } }, oauth: { token: "account-secret" } });
    const user = importClaudeConfig(source, options);
    expect(user.config.servers[0]?.id).toBe("one");
    expect(user.config.servers[0]?.env).toEqual({ TOKEN: { env: "TOKEN" } });
    const project = importClaudeConfig(source, { ...options, project: "/work" });
    expect(project.config.servers[0]?.id).toBe("two");
    expect(project.config.servers[0]?.headers?.authorization).toEqual({ env: "MCP_TWO_AUTHORIZATION" });
    expect(JSON.stringify([user, project])).not.toMatch(/inline-env-secret|inline-header-secret|account-secret/);
  });
  it("supports explicit legacy SSE and HTTP alias while rejecting ambiguous URL-only entries", () => {
    const result = importClaudeConfig(JSON.stringify({ mcpServers: { a: { type: "sse", url: "https://example.test/sse" }, b: { type: "streamable-http", url: "https://example.test/mcp" }, c: { url: "https://example.test/unknown" }, d: { type: "ws", url: "wss://example.test" } } }), options);
    expect(result.config.servers.map((server) => server.transport)).toEqual(["sse", "http"]);
    expect(result.servers.slice(2).map((server) => server.status)).toEqual(["unsupported", "unsupported"]);
  });
  it("supports custom env-backed headers without copying inline custom credentials", () => {
    const result = importClaudeConfig(JSON.stringify({ mcpServers: { ctx: { type: "http", url: "https://example.test/mcp", headers: { CONTEXT7_API_KEY: "${CONTEXT7_TOKEN}", "X-GitHub-Api-Version": "2022-11-28", "X-Custom-Token": "inline-secret" } } } }), options);
    expect(result.config.servers[0]?.headers).toEqual({ context7_api_key: "${CONTEXT7_TOKEN}", "x-github-api-version": "2022-11-28", "x-custom-token": { env: "MCP_CTX_X_CUSTOM_TOKEN" } });
    expect(JSON.stringify(result)).not.toContain("inline-secret");
  });
  it("removes inline fallback values from imported templates without resolving their references", () => {
    const result = importClaudeConfig(JSON.stringify({ mcpServers: {
      process: { command: "node", args: ["${ENTRY:-private-arg-fallback}"], env: { TOKEN: "${TOKEN:-private-env-fallback}" } },
      remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${TOKEN:-private-header-fallback}" } },
    } }), options);
    expect(JSON.stringify(result)).not.toMatch(/private-(?:arg|env|header)-fallback/);
    expect(result.config.servers[0]?.env?.TOKEN).toBe("${TOKEN}");
    expect(result.config.servers[0]?.args).toEqual(["${ENTRY}"]);
    expect(result.config.servers[1]?.headers?.authorization).toBe("Bearer ${TOKEN}");
    expect(result.servers.every((server) => server.status === "needs_configuration")).toBe(true);
    expect(() => resolveServerConfig(result.config.servers[1]!, {})).toThrow("Missing environment variable TOKEN");
  });
  it("reports every unhandled field, including approval policies and helper commands", () => {
    const result = importClaudeConfig(JSON.stringify({ mcpServers: { server: { command: "node", alwaysAllow: ["write"], headersHelper: "print-secret" } } }), options);
    expect(result.servers[0]?.diagnostics.map((entry) => entry.field)).toEqual(expect.arrayContaining(["alwaysAllow", "headersHelper"]));
    expect(JSON.stringify(result)).not.toContain("print-secret");
    expect(result.config.servers).toEqual([]);
  });
  it("does not copy likely argv credentials or arbitrary shell scripts", () => {
    for (const server of [{ command: "node", args: ["--token=argv-secret"] }, { command: "bash", args: ["-c", "echo shell-secret"] }]) {
      const result = importClaudeConfig(JSON.stringify({ mcpServers: { server } }), options);
      expect(result.config.servers).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(/argv-secret|shell-secret/);
    }
  });
  it("keeps disabled entries disabled and gives normalization a collision-resistant identity", () => {
    const result = importClaudeConfig(JSON.stringify({ mcpServers: { server: { command: "node", disabled: true } } }), options);
    expect(result.servers[0]?.status).toBe("disabled");
    expect(result.config.servers[0]?.enabled).toBe(false);
    expect(importedServerId("my server")).not.toBe(importedServerId("my-server"));
    expect(importedServerId("내 서버")).toBe(importedServerId("내 서버"));
  });
});
