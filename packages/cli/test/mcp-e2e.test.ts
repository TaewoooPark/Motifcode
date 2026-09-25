/** The real CLI, HTTP model boundary, and a real stdio MCP process in one test. */
import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { configHash } from "../../mcp/src/config.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAIN = join(REPO, "packages/cli/src/main.ts");
const FIXTURE = join(REPO, "packages/mcp/test/fixtures/client-legacy.mjs");
const CANONICAL = ["done", "bash", "read", "write", "apply_patch", "term", "skill", "task", "mcp"];
const dirs: string[] = [];
const models: MockModel[] = [];
interface WireMessage { role: string; content?: string | null; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }
interface Body { messages: WireMessage[]; tools: { function: { name: string; parameters: Record<string, unknown> } }[] }
interface Reply { message: Partial<WireMessage>; finish_reason?: string }
interface Event { event: string; pid: number; name?: string; args?: unknown }

class MockModel {
  readonly bodies: Body[] = [];
  readonly authorization: (string | undefined)[] = [];
  private server!: Server;
  endpoint = "";
  constructor(private script: (turn: number) => Reply) { models.push(this); }
  async start() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body);
        this.authorization.push(request.headers.authorization);
        const reply = this.script(this.bodies.length);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", ...reply.message }, finish_reason: reply.finish_reason ?? "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local TCP port.");
    this.endpoint = `http://127.0.0.1:${address.port}`;
  }
  async close() { this.server?.closeAllConnections(); if (this.server) await new Promise<void>((done) => this.server.close(() => done())); }
}
function call(name: string, args: unknown, id: string, reasoning = "test reasoning preserved"): Reply {
  return { message: { content: null, reasoning_content: reasoning, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" };
}
const mcp = (method: string, args: unknown, id: string) => call("mcp", { server: "lab", method, args }, id);
const reply = (text: string): Reply => ({ message: { content: text, reasoning_content: "The observed result is sufficient to answer." } });

function setup(allowedTools = ["echo", "business"]) {
  const dir = mkdtempSync(join(tmpdir(), "motif-mcp-e2e-")); dirs.push(dir);
  const log = join(dir, "events.ndjson"); const envAudit = join(dir, "env-audit.json"); const wrapper = join(dir, "server.mjs");
  // Record only booleans for fake secrets. Never record the host environment.
  writeFileSync(wrapper, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(envAudit)}, JSON.stringify({ motif: Boolean(process.env.MOTIF_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY), explicit: process.env.MCP_TEST_VALUE === 'allowed' }));\nawait import(${JSON.stringify(pathToFileURL(FIXTURE).href)});\n`);
  const configPath = join(dir, "mcp.json");
  const configText = JSON.stringify({ version: 1, servers: { lab: { enabled: true, transport: "stdio", protocol: "legacy", command: process.execPath, args: [wrapper, log], env: { MCP_TEST_VALUE: "allowed" }, allowedTools, startupTimeoutMs: 3000, toolTimeoutMs: 2000, catalogTtlMs: 60000 } } });
  writeFileSync(configPath, configText);
  return { dir, log, envAudit, configPath, hash: configHash(configText), events: (): Event[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event) : [] };
}

async function run(f: ReturnType<typeof setup>, model: MockModel, options: { print?: boolean; trust?: boolean; bundle?: string } = {}) {
  const argv = ["echo 한글 and inspect the business result", "--endpoint", model.endpoint, "--no-hero", "--max-turns", "8", "--mcp-config", f.configPath, ...(options.trust === false ? [] : ["--trust-mcp", f.hash]), ...(options.print === false ? [] : ["--print"])];
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((done, reject) => {
    const child = spawn(process.execPath, [...(options.bundle ? [options.bundle] : [join(REPO, "node_modules/tsx/dist/cli.mjs"), MAIN]), ...argv], {
      cwd: f.dir, env: { PATH: process.env.PATH, HOME: f.dir, TMPDIR: tmpdir(), NO_COLOR: "1", MOTIF_API_KEY: "synthetic-model-key", OPENAI_API_KEY: "synthetic-other-key" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, timedOut }); });
  });
}
function observations(body: Body): Record<string, unknown>[] {
  return body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content!) as Record<string, unknown>);
}
function assertClosed(f: ReturnType<typeof setup>) {
  const boot = f.events().find((event) => event.event === "boot");
  expect(boot).toBeDefined();
  expect(() => process.kill(boot!.pid, 0)).toThrow();
}

afterEach(async () => {
  await Promise.all(models.splice(0).map((model) => model.close()));
  for (const dir of dirs.splice(0)) {
    const log = join(dir, "events.ndjson");
    if (existsSync(log)) for (const line of readFileSync(log, "utf8").trim().split("\n")) {
      const event = JSON.parse(line) as Event;
      if (event.event === "boot") try { process.kill(event.pid, "SIGTERM"); } catch { /* already closed */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP through the actual CLI process", () => {
  it("recovers MCP arguments in prose through a new model turn and one validated dispatch", async () => {
    const f = setup(); const text = '한글 "quotes"\nC:\\temp ${literal} `backtick`';
    const printed = `먼저 호출합니다.\n\n\`\`\`json\n${JSON.stringify({ server: "lab", method: "echo", args: { text } })}\n\`\`\``;
    const model = new MockModel((turn) => turn === 1 ? reply(printed) : turn === 2 ? mcp("echo", { text }, "recovered-call") : reply("정식 호출 완료")); await model.start();
    const result = await run(f, model);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "정식 호출 완료\n", timedOut: false });
    expect(model.bodies).toHaveLength(3);
    expect(model.bodies[1]!.messages.find((message) => message.role === "assistant")).toMatchObject({ content: printed, reasoning_content: "The observed result is sufficient to answer." });
    expect(model.bodies[1]!.messages.at(-1)?.content).toContain("mcp");
    expect(f.events().filter((event) => event.event === "call")).toMatchObject([{ name: "echo", args: { text } }]);
    expect(observations(model.bodies[2]!)[0]).toMatchObject({ ok: true, execution: "completed" });
    for (const body of model.bodies) expect(body.tools).toEqual(model.bodies[0]!.tools);
    assertClosed(f);
  }, 25_000);

  it("does not execute a quoted example and caps repeated ambiguous replies", async () => {
    const f = setup(); const printed = `예시입니다.\n\`\`\`\n${JSON.stringify({ server: "lab", method: "echo", args: { text: "example" } })}\n\`\`\``;
    const model = new MockModel(() => reply(printed)); await model.start();
    const result = await run(f, model);
    expect(result, result.stderr).toMatchObject({ code: 1, timedOut: false });
    expect(model.bodies).toHaveLength(2);
    expect(result.stderr).toContain("no_action_limit");
    expect(f.events().filter((event) => event.event === "call")).toEqual([]);
    assertClosed(f);
  }, 25_000);

  it("keeps remote interaction approval in force on a recovered call", async () => {
    const f = setup(["gated"]);
    const model = new MockModel((turn) => turn === 1 ? reply(JSON.stringify({ server: "lab", method: "gated", args: {} }))
      : turn === 2 ? mcp("gated", {}, "needs-approval") : reply("사용자 승인이 필요합니다")); await model.start();
    const result = await run(f, model);
    expect(result.code).toBe(0);
    expect(model.bodies).toHaveLength(3);
    expect(observations(model.bodies[2]!)[0]).toMatchObject({ ok: false, execution: "not_started", error: { code: "interaction_required" } });
    expect(f.events().filter((event) => event.event === "call")).toEqual([]);
    assertClosed(f);
  }, 25_000);

  it("does not replay an unknown execution when the model retries after format recovery", async () => {
    const f = setup(["lose_ack"]);
    const model = new MockModel((turn) => turn === 1 || turn === 3 ? mcp("lose_ack", {}, `lost-${turn}`)
      : turn === 2 ? reply(JSON.stringify({ server: "lab", method: "lose_ack", args: {} })) : reply("이전 실행 여부를 확인할 수 없습니다")); await model.start();
    const result = await run(f, model);
    expect(result.code).toBe(0);
    expect(model.bodies).toHaveLength(4);
    expect(observations(model.bodies[1]!)[0]).toMatchObject({ ok: false, execution: "unknown" });
    expect(observations(model.bodies[3]!)[1]).toMatchObject({ ok: false, execution: "not_started", error: { code: "previous_execution_unknown" } });
    expect(f.events().filter((event) => event.event === "call")).toHaveLength(1);
    assertClosed(f);
  }, 25_000);

  it("keeps completed observations when clarifying a later example without replaying it", async () => {
    const f = setup(); const args = { text: "already done" };
    const model = new MockModel((turn) => turn === 1 ? mcp("echo", args, "original")
      : turn === 2 ? reply(JSON.stringify({ server: "lab", method: "echo", args })) : reply("이전 호출 예시이며 이미 완료됐습니다")); await model.start();
    const result = await run(f, model);
    expect(result.code).toBe(0);
    expect(model.bodies).toHaveLength(3);
    expect(observations(model.bodies[2]!)[0]).toMatchObject({ ok: true, execution: "completed" });
    expect(model.bodies[2]!.messages.at(-1)?.content).toContain("Do not repeat completed writes");
    expect(f.events().filter((event) => event.event === "call")).toHaveLength(1);
    assertClosed(f);
  }, 25_000);

  it("round-trips object arguments and reasoning with a stable nine-tool prefix, then closes its server", async () => {
    const f = setup(); const text = '한글 "quotes"\nC:\\temp\\x ${literal} `backtick`';
    const model = new MockModel((turn) => turn === 1 ? mcp("echo", { text }, "call-exact") : reply("MCP 응답 확인 완료")); await model.start();
    const result = await run(f, model);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "MCP 응답 확인 완료\n", timedOut: false });
    expect(model.bodies).toHaveLength(2);
    const [first, second] = model.bodies as [Body, Body];
    expect(first.tools.map((tool) => tool.function.name)).toEqual(CANONICAL);
    expect(second.tools).toEqual(first.tools);
    expect(first.tools.at(-1)?.function.parameters.properties).toMatchObject({ args: { type: "object" } });
    expect(first.messages[0]?.role).toBe("system");
    expect(second.messages.filter((message) => message.role === "system")).toEqual([first.messages[0]]);
    expect(first.messages.slice(1).some((message) => message.content?.includes("MCP runtime context"))).toBe(true);
    const assistant = second.messages.find((message) => message.role === "assistant")!;
    expect(assistant.reasoning_content).toBe("test reasoning preserved");
    expect(JSON.parse(assistant.tool_calls![0]!.function.arguments)).toEqual({ server: "lab", method: "echo", args: { text } });
    expect(observations(second)[0]).toMatchObject({ ok: true, execution: "completed", result: { structuredContent: { received: { text }, modelKeyInherited: false } } });
    expect(f.events().filter((event) => event.event === "call")).toMatchObject([{ name: "echo", args: { text } }]);
    expect(JSON.parse(readFileSync(f.envAudit, "utf8"))).toEqual({ motif: false, openai: false, explicit: true });
    expect(model.authorization).toEqual(["Bearer synthetic-model-key", "Bearer synthetic-model-key"]);
    expect(JSON.stringify(model.bodies) + result.stdout + result.stderr).not.toMatch(/synthetic-model-key|synthetic-other-key/);
    assertClosed(f);
  }, 25_000);

  it("preserves isError, rejects invalid original-schema arguments before dispatch, and recovers in one-shot mode", async () => {
    const f = setup();
    const model = new MockModel((turn) => {
      if (turn === 1) return mcp("business", {}, "call-business");
      if (turn === 2) return mcp("echo", { text: 42 }, "call-invalid");
      if (turn === 3) return mcp("echo", { text: "fixed" }, "call-fixed");
      return call("done", { summary: "검증 완료", ...(turn > 4 ? { confirm: true } : {}) }, `done-${turn}`);
    }); await model.start();
    const result = await run(f, model, { print: false });
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
    expect(observations(model.bodies[1]!)[0]).toMatchObject({ ok: false, execution: "completed", result: { isError: true, structuredContent: { code: "MOVED", replacement_id: "CASE-042" } } });
    expect(observations(model.bodies[2]!)[1]).toMatchObject({ ok: false, execution: "not_started", error: { code: "invalid_arguments" } });
    expect(f.events().filter((event) => event.event === "call")).toMatchObject([{ name: "business", args: {} }, { name: "echo", args: { text: "fixed" } }]);
    for (const body of model.bodies) {
      expect(body.tools).toEqual(model.bodies[0]!.tools);
      expect(body.messages.filter((message) => message.role === "system")).toEqual([model.bodies[0]!.messages[0]]);
    }
    assertClosed(f);
  }, 25_000);

  it("does not start an untrusted explicit configuration", async () => {
    const f = setup(); const model = new MockModel(() => reply("서버 승인 필요")); await model.start();
    const result = await run(f, model, { trust: false });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("--trust-mcp");
    expect(model.bodies[0]!.tools.map((tool) => tool.function.name)).toEqual(CANONICAL.slice(0, 8));
    expect(f.events()).toEqual([]);
    expect(existsSync(f.envAudit)).toBe(false);
  }, 25_000);

  it("does not dispatch a complete-looking call from a length-truncated model turn", async () => {
    const f = setup(); const model = new MockModel((turn) => turn === 1 ? { ...mcp("echo", { text: "must-not-run" }, "cut-off"), finish_reason: "length" } : reply("잘린 호출은 실행하지 않았습니다")); await model.start();
    const result = await run(f, model);
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false });
    expect(f.events().filter((event) => event.event === "call")).toEqual([]);
    assertClosed(f);
  }, 25_000);

  it("runs the self-contained built artifact outside the workspace with a real MCP server", async () => {
    await promisify(execFile)(process.execPath, [join(REPO, "scripts/build.mjs")], { cwd: REPO, timeout: 30_000 });
    const f = setup(); const bundle = join(f.dir, "motif.mjs");
    copyFileSync(join(REPO, "packages/cli/dist/motif.js"), bundle);
    const model = new MockModel((turn) => turn === 1 ? mcp("echo", { text: "bundled" }, "bundle-call") : reply("bundle MCP works")); await model.start();
    const result = await run(f, model, { bundle });
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "bundle MCP works\n", timedOut: false });
    expect(observations(model.bodies[1]!)[0]).toMatchObject({ ok: true, result: { structuredContent: { received: { text: "bundled" } } } });
    expect(f.events().filter((event) => event.event === "call")).toHaveLength(1);
    assertClosed(f);
  }, 45_000);
});
