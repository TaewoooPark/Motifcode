/** Independent review regressions: each assertion states the intended safety contract. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@motifcode/agents";
import { DEFAULT_HOOKS } from "@motifcode/hooks";
import { SkillRegistry } from "@motifcode/skills";
import { CORE_TOOLS } from "@motifcode/tools";
import { Screen } from "@motifcode/tui";
import type { CompletionRequest, Transport } from "@motifcode/core";
import { Chat } from "../../cli/src/chat.js";
import { McpManager } from "../src/manager.js";
import { McpSession } from "../src/session.js";
import { ResultStore } from "../src/results.js";
import { importClaudeConfig } from "../src/importers.js";
import { configHash } from "../src/config.js";

const managers: McpManager[] = [];
const sessions: McpSession[] = [];
const directories: string[] = [];
const chats: { input: PassThrough; finished: Promise<number> }[] = [];
afterEach(async () => {
  for (const chat of chats.splice(0)) {
    chat.input.write("\x1b\x1b\x04");
    await chat.finished;
  }
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeTTY extends PassThrough {
  isTTY = true;
  setRawMode(): this { return this; }
}
function interactiveFixture(permissions: "ask" | "auto", script: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "motif-audit-permissions-")); directories.push(dir);
  const log = join(dir, "events.jsonl");
  const session = new McpSession({ servers: [{ id: "lab", enabled: true, transport: "stdio", protocol: "legacy", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/client-legacy.mjs", import.meta.url)), log], startupTimeoutMs: 3000, toolTimeoutMs: 2000 }] });
  sessions.push(session);
  const seen: CompletionRequest[] = [];
  const transport: Transport = { endpoint: "fake://model", model: "fixture", complete: async (request) => {
    seen.push(request);
    const body = script.shift();
    if (body === undefined) throw new Error("No fixture model response remains.");
    return { content: body, rawText: body, ms: 1 };
  } };
  const input = new FakeTTY(); const output: string[] = [];
  const chat = new Chat({
    screen: new Screen({ write: (text) => output.push(text), columns: () => 100, interactive: true, cwd: dir }),
    stdin: input as unknown as NodeJS.ReadStream,
    settings: { model: "fixture", endpoint: "fake://model", channel: "toolcall", maxTurns: 10, cwd: dir, theme: "motif", compactAt: 0.75, permissions },
    channelPolicy: "fixed", skills: new SkillRegistry(), agents: new AgentRegistry(), hooks: DEFAULT_HOOKS,
    tools: [...CORE_TOOLS], mcp: session, journalDir: join(dir, "journals"), version: "audit", hero: false, makeTransport: () => transport,
  });
  const finished = chat.run(); chats.push({ input, finished });
  return { chat, seen, type: (text: string) => input.write(text), screen: () => output.join(""), calls: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; name?: string }).filter((event) => event.event === "call") };
}
const mcpBody = (method: string, args: unknown) => `</think><tool_call>${JSON.stringify({ name: "mcp", arguments: { server: "lab", method, args } })}</tool_call>`;

describe("independent MCP review regressions", () => {
  it("does not replay an unresolved write when delegation creates a new execution scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motif-audit-replay-")); directories.push(dir);
    const log = join(dir, "events.jsonl");
    const manager = new McpManager({ servers: [{ id: "lab", enabled: true, transport: "stdio", protocol: "legacy", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/client-legacy.mjs", import.meta.url)), log], startupTimeoutMs: 3000, toolTimeoutMs: 2000 }] });
    managers.push(manager);
    const first = await manager.invoke("lab", "lose_ack", {}, { scopeId: "root" });
    expect(first).toMatchObject({ ok: false, execution: "unknown" });
    const retry = await manager.invoke("lab", "lose_ack", {}, { scopeId: "root/child-2" });
    expect(retry).toMatchObject({ ok: false, execution: "not_started", error: { code: "previous_execution_unknown" } });
    const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; name?: string });
    expect(events.filter((event) => event.event === "call" && event.name === "lose_ack")).toHaveLength(1);
  });

  it("keeps invalid host-control diagnostics within the same model output budget", async () => {
    const session = new McpSession({ servers: [] }); sessions.push(session);
    const extra = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`unexpected_${index}_${"x".repeat(100)}`, 1]));
    const result = await session.invoke("__motif_host__", "read_result", { handle: "unknown", ...extra }, { scopeId: "root" });
    expect(result.ok).toBe(false);
    expect(result.bounded).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(16_000);
    expect(JSON.parse(result.output)).toMatchObject({ execution: "not_started", error: { code: "invalid_arguments" } });
  });

  it("bounds original-schema validation paths before returning business-call diagnostics", async () => {
    const script = `
      import { Server } from '@modelcontextprotocol/sdk/server/index.js';
      import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
      import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
      const server = new Server({ name:'audit-schema', version:'1' }, { capabilities:{tools:{}} });
      server.setRequestHandler(ListToolsRequestSchema, () => ({tools:[{name:'numbers',inputSchema:{type:'object',additionalProperties:{type:'number'}}}]}));
      server.setRequestHandler(CallToolRequestSchema, () => ({content:[{type:'text',text:'unexpected dispatch'}]}));
      await server.connect(new StdioServerTransport());
    `;
    const session = new McpSession({ servers: [{ id: "lab", enabled: true, transport: "stdio", command: process.execPath, args: ["--input-type=module", "--eval", script], cwd: fileURLToPath(new URL("..", import.meta.url)), startupTimeoutMs: 3000, toolTimeoutMs: 2000 }] });
    sessions.push(session);
    const result = await session.invoke("lab", "numbers", { ["x".repeat(20_000)]: "invalid" }, { scopeId: "root" });
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, execution: "not_started", error: { code: "invalid_arguments" } });
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(16_000);
  });

  it("does not copy inline fallback credentials just because they occur inside an environment expression", () => {
    const imported = importClaudeConfig(JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${TOKEN:-private-fallback-value}" } } } }), { sourcePath: "/tmp/claude.json" });
    expect(JSON.stringify(imported)).not.toContain("private-fallback-value");
  });

  it("makes progress or reports an error when a character page would split an emoji", () => {
    const store = new ResultStore({ maxOutputBytes: 1024 });
    const presented = store.present("root", { structuredContent: { text: "🙂" + "x".repeat(2000) } }) as Record<string, unknown>;
    const page = store.read("root", { handle: presented.handle as string, pointer: "/structuredContent/text", startChar: 0, charCount: 1 }) as Record<string, unknown>;
    if (page.ok === false) return;
    const coverage = page.coverage as { startChar: number; endChar: number; nextChar?: number };
    expect(coverage.endChar).toBeGreaterThan(coverage.startChar);
    if (coverage.nextChar !== undefined) expect(coverage.nextChar).toBeGreaterThan(coverage.startChar);
  });

  it("requires fresh human confirmation for every gated call even in auto mode", async () => {
    const fixture = interactiveFixture("auto", [mcpBody("gated", {}), mcpBody("gated", {}), "</think>Stopped after the refusal."]);
    fixture.type("test gated tool\r");
    await vi.waitFor(() => expect(fixture.screen()).toContain("server requires human confirmation"), { timeout: 4000 });
    expect(fixture.calls()).toHaveLength(0);
    fixture.type("2");
    await vi.waitFor(() => expect(fixture.seen).toHaveLength(2));
    expect(fixture.calls()).toHaveLength(1);
    // Let the second returned model call reach its forced confirmation screen.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fixture.chat.running).toBe(true);
    fixture.type("3");
    await vi.waitFor(() => expect(fixture.chat.tasksCompleted).toBe(1));
    expect(fixture.calls()).toHaveLength(1);
    expect(JSON.stringify(fixture.seen[2]?.messages)).toContain("interaction_required");
  }, 10_000);

  it("limits remembered approval to the exact server/method pair", async () => {
    const fixture = interactiveFixture("ask", [mcpBody("echo", { text: "first" }), mcpBody("echo", { text: "second" }), mcpBody("business", {}), "</think>Stopped before business."]);
    fixture.type("echo twice then business\r");
    await vi.waitFor(() => expect(fixture.screen()).toContain("Call lab/echo?"), { timeout: 4000 });
    fixture.type("2");
    await vi.waitFor(() => expect(fixture.screen()).toContain("Call lab/business?"));
    expect(fixture.calls().map((event) => event.name)).toEqual(["echo", "echo"]);
    fixture.type("3");
    await vi.waitFor(() => expect(fixture.chat.tasksCompleted).toBe(1));
    expect(fixture.calls().map((event) => event.name)).toEqual(["echo", "echo"]);
  }, 10_000);

  it("cleans up the stdio server when a print-mode CLI receives SIGTERM during a call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motif-audit-signal-")); directories.push(dir);
    const log = join(dir, "events.jsonl"); const configPath = join(dir, "mcp.json");
    const config = JSON.stringify({ servers: [{ id: "lab", enabled: true, transport: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/client-legacy.mjs", import.meta.url)), log], startupTimeoutMs: 3000, toolTimeoutMs: 20_000 }] });
    writeFileSync(configPath, config);
    const model = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: "Wait once.", tool_calls: [{ id: "wait", type: "function", function: { name: "mcp", arguments: JSON.stringify({ server: "lab", method: "wait", args: {} }) } }] }, finish_reason: "tool_calls" }] }));
      });
    });
    await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP port.");
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    // Load TypeScript into this exact process: a tsx CLI wrapper would make
    // signaling the child ambiguous and would not test the product lifecycle.
    const child = spawn(process.execPath, ["--import", join(repo, "node_modules/tsx/dist/loader.mjs"), join(repo, "packages/cli/src/main.ts"), "wait", "--print", "--max-turns", "2", "--endpoint", `http://127.0.0.1:${address.port}`, "--mcp-config", configPath, "--trust-mcp", configHash(config)], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, NO_COLOR: "1" }, stdio: ["ignore", "ignore", "ignore"] });
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    let pid: number | undefined;
    try {
      await vi.waitFor(() => {
        const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; name?: string; pid: number });
        pid = events[0]?.pid;
        expect(events.some((event) => event.event === "call" && event.name === "wait")).toBe(true);
      }, { timeout: 4000 });
      child.kill("SIGTERM");
      await closed;
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 1500 });
    } finally {
      child.kill("SIGKILL");
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* closed as intended */ }
      model.closeAllConnections();
      await new Promise<void>((done) => model.close(() => done()));
    }
  }, 10_000);

  it.each([ ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129] ] as const)("cleans up a starting stdio server when doctor --connect receives %s", async (signal, exitCode) => {
    const dir = mkdtempSync(join(tmpdir(), "motif-audit-doctor-signal-")); directories.push(dir);
    const log = join(dir, "boot.json"); const configPath = join(dir, "mcp.json");
    // Deliberately accept neither initialization nor termination at the protocol
    // level: cancellation must interrupt startup and clean up the owned process.
    const startup = `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000);`;
    const config = JSON.stringify({ servers: [{ id: "starting", enabled: true, transport: "stdio", command: process.execPath,
      args: ["--eval", startup], startupTimeoutMs: 20_000 }] });
    writeFileSync(configPath, config);
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const child = spawn(process.execPath, ["--import", join(repo, "node_modules/tsx/dist/loader.mjs"), join(repo, "packages/cli/src/main.ts"), "mcp", "doctor", "--connect", "--mcp-config", configPath, "--trust-mcp", configHash(config)], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, NO_COLOR: "1" }, stdio: ["ignore", "ignore", "ignore"] });
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    let pid: number | undefined;
    try {
      await vi.waitFor(() => {
        pid = (JSON.parse(readFileSync(log, "utf8")) as { pid: number }).pid;
        expect(pid).toBeGreaterThan(0);
      }, { timeout: 4000 });
      child.kill(signal);
      await vi.waitFor(() => expect(child.exitCode).toBe(exitCode), { timeout: 4000 });
      await closed;
      expect(child.signalCode).toBeNull();
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 1000 });
    } finally {
      child.kill("SIGKILL");
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* closed as intended */ }
    }
  }, 10_000);
});
