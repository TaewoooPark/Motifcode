import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configHash, loadMcpConfig, McpSession, type McpServerConfig } from "@motifcode/mcp";
import { CORE_TOOLS } from "@motifcode/tools";
import { toolSchemaHash } from "@motifcode/protocol";
import { runLoop } from "@motifcode/core";
import { ScriptedTransport, toolCallBody } from "@motifcode/replay";
import { ToolExecutor } from "../src/executor.js";
import { editMcpConfig } from "../src/mcp-config-edit.js";
import { McpCatalogRuntime } from "../src/mcp-catalog-runtime.js";

const directories: string[] = [];
const sessions: McpSession[] = [];
function fixture(servers: McpServerConfig[] = [], project = false) {
  const home = mkdtempSync(join(tmpdir(), "motif-catalog-")); directories.push(home);
  const path = project ? join(home, "project.json") : join(home, ".motif", "mcp.json");
  const options = { home, ...(project ? { path } : {}) };
  for (const server of servers) editMcpConfig({ kind: "add", server }, { ...options,
    ...(project && existsSync(path) ? { trustHash: configHash(readFileSync(path, "utf8")) } : {}) });
  if (project && !existsSync(path)) writeFileSync(path, '{"servers":[]}');
  const trustHash = project ? configHash(readFileSync(path, "utf8")) : undefined;
  const config = loadMcpConfig({ ...options, trustHash });
  const session = new McpSession(config); sessions.push(session);
  const connect = vi.spyOn(session, "connect").mockImplementation(async (id) => ({ ...session.statuses().find(row => row.server === id)!, state: "ready", toolCount: 3 }));
  const runtime = new McpCatalogRuntime(session, config, { ...options, trustHash, env: {} });
  return { home, path, options, config, session, runtime, connect };
}
const signal = () => new AbortController().signal;
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("host catalog registration in the running session", () => {
  it("persists and activates a preset without changing unrelated settings or restarting the session", async () => {
    const original = { id: "local", transport: "stdio" as const, enabled: false, command: "node", args: ["private-server.mjs"] };
    const f = fixture([original]);
    // Preserve independent additions made by another local editor after startup.
    editMcpConfig({ kind: "add", server: { ...original, id: "external" } }, f.options);
    expect(await f.runtime.install("context7", {}, signal())).toMatchObject({ server: "context7", state: "ready" });
    expect(f.session.enabled).toBe(true);
    expect(f.session.statuses().map(row => row.server)).toEqual(["local", "context7"]);
    expect(loadMcpConfig(f.options).servers).toEqual(expect.arrayContaining([expect.objectContaining(original), expect.objectContaining({ id: "external" }), expect.objectContaining({ id: "context7", enabled: true })]));
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it("enables the approved existing entry with its endpoint and tool restrictions intact", async () => {
    const original: McpServerConfig = { id: "context7", enabled: false, transport: "http", url: "https://example.test/private-mcp", allowedTools: ["read_docs"] };
    const f = fixture([original]);
    await f.runtime.install("context7", {}, signal());
    expect(loadMcpConfig(f.options).servers[0]).toMatchObject({ ...original, enabled: true });
    expect(f.session.statuses()[0]).toMatchObject({ enabled: true });
    await expect(f.runtime.install("context7", { tokenEnv: "NEW_TOKEN" }, signal())).rejects.toMatchObject({ code: "config_conflict" });
  });

  it("checks root and token prerequisites before creating a configuration", async () => {
    const f = fixture();
    await expect(f.runtime.install("filesystem", {}, signal())).rejects.toMatchObject({ code: "invalid_option" });
    await expect(f.runtime.install("gmail", {}, signal())).rejects.toMatchObject({ code: "invalid_option" });
    await expect(f.runtime.install("context7", { tokenEnv: "ABSENT_TOKEN" }, signal())).rejects.toMatchObject({ code: "invalid_environment" });
    expect(existsSync(f.path)).toBe(false);
    expect(f.session.statuses()).toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("does not adopt a same-name server externally added or changed since startup", async () => {
    const f = fixture();
    editMcpConfig({ kind: "add", server: { id: "context7", enabled: false, transport: "http", url: "https://unexpected.test/mcp" } }, f.options);
    const before = readFileSync(f.path, "utf8");
    await expect(f.runtime.install("context7", {}, signal())).rejects.toMatchObject({ code: "config_changed" });
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(f.session.statuses()).toEqual([]);
  });

  it("advances trust only for its own project edits and refuses subsequent external changes", async () => {
    const f = fixture([], true);
    await f.runtime.install("context7", {}, signal());
    await f.runtime.install("openai-docs", {}, signal());
    const stored = readFileSync(f.path, "utf8");
    writeFileSync(f.path, stored + "\n");
    await expect(f.runtime.install("playwright", {}, signal())).rejects.toMatchObject({ code: "untrusted_config" });
    expect(readFileSync(f.path, "utf8")).toBe(stored + "\n");
    expect(f.session.statuses()).toHaveLength(2);
  });

  it("never enables an untrusted project server through the catalog", async () => {
    const f = fixture([{ id: "context7", enabled: true, transport: "http", url: "https://mcp.context7.com/mcp" }], true);
    const untrusted = loadMcpConfig({ path: f.path });
    const session = new McpSession(untrusted); sessions.push(session);
    const runtime = new McpCatalogRuntime(session, untrusted, { path: f.path });
    await expect(runtime.install("context7", {}, signal())).rejects.toMatchObject({ code: "untrusted_config" });
    expect(session.enabled).toBe(false);
  });

  it("does not persist cancelled actions or actions on a closed session", async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    await expect(f.runtime.install("context7", {}, abort.signal)).rejects.toMatchObject({ code: "cancelled" });
    await f.session.close();
    await expect(f.runtime.install("context7", {}, signal())).rejects.toMatchObject({ code: "manager_closed" });
    expect(existsSync(f.path)).toBe(false);
  });

  it("keeps registration after a connection failure so login/reconnect can recover without installation", async () => {
    const f = fixture(); f.connect.mockRejectedValue(new Error("offline"));
    await expect(f.runtime.install("context7", {}, signal())).rejects.toThrow("offline");
    expect(f.session.statuses()[0]).toMatchObject({ server: "context7", enabled: true });
    expect(loadMcpConfig(f.options).servers[0]).toMatchObject({ id: "context7", enabled: true });
  });

  it("returns a real authentication-required state for the TUI login flow", async () => {
    const f = fixture();
    const session = new McpSession(f.config, { manager: { home: f.home, fetch: async () => new Response("Unauthorized", { status: 401 }) } });
    sessions.push(session);
    const runtime = new McpCatalogRuntime(session, f.config, f.options);
    expect(await runtime.install("context7", {}, signal())).toMatchObject({ server: "context7", enabled: true, state: "error", error: { code: "authentication_required" } });
    expect(loadMcpConfig(f.options).servers[0]).toMatchObject({ id: "context7", enabled: true });
  });

  it("installs into an empty session then executes through the fixed ninth tool and real SDK protocol", async () => {
    const f = fixture(); const requests: string[] = [];
    const session = new McpSession(f.config, { manager: { home: f.home, fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string; params?: { arguments?: { query?: string } } };
      requests.push(request.method ?? "unknown");
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "docs-fixture", version: "1" } }
        : request.method === "tools/list"
          ? { tools: [{ name: "read_docs", description: "Read documentation", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] }
          : { content: [{ type: "text", text: `SDK response: ${request.params?.arguments?.query}` }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "Content-Type": "application/json" } });
    } } });
    sessions.push(session);
    const runtime = new McpCatalogRuntime(session, f.config, f.options);
    const tools = [...CORE_TOOLS]; const beforeHash = toolSchemaHash(tools);
    expect(tools).toHaveLength(9); expect(session.enabled).toBe(false);
    expect(await runtime.install("context7", {}, signal())).toMatchObject({ state: "ready", toolCount: 1 });
    const executor = new ToolExecutor({ cwd: f.home, confirm: async () => "allow",
      callMcp: (server, method, args, signal) => session.invoke(server, method, args, { scopeId: "root", signal }),
    });
    const transport = new ScriptedTransport([toolCallBody("mcp", { server: "context7", method: "read_docs", args: { query: "usable without restart" } }), "</think>Finished."]);
    try {
      const result = await runLoop({ transport, tools, system: () => "stable canonical prefix", userTask: "Read documentation", context: await session.prepare("Read documentation"), executor,
        emit: () => {}, replyEnds: true, confirmDone: false, maxTurns: 2 });
      expect(result.reason).toBe("done");
      expect(transport.seen[1]?.messages.at(-1)?.content).toContain("SDK response: usable without restart");
      expect(requests.filter(method => method === "initialize")).toHaveLength(1);
      expect(requests.filter(method => method === "tools/call")).toHaveLength(1);
      expect(toolSchemaHash(tools)).toBe(beforeHash);
      expect(loadMcpConfig(f.options).servers[0]).toMatchObject({ id: "context7", enabled: true });
    } finally { executor.close(); }
  });
});
