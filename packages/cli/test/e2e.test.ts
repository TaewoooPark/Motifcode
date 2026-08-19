/**
 * The CLI, as a process, against an HTTP server.
 *
 * Every other test in this repo imports a function. That leaves one gap large
 * enough to hide a session in: the wiring between `main()` and the wire. A unit
 * test can prove `runLoop` puts the task in the first request and still tell you
 * nothing about whether the command-line path ever hands it one.
 *
 * So this file spawns the real entry point as a child process, points it at a
 * throwaway server, and reads what actually arrived over TCP. The assertions are
 * about request bodies, not about anything the harness reports of itself.
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const MAIN = join(REPO, "packages/cli/src/main.ts");

interface ChatBody {
  messages: { role: string; content?: string; tool_calls?: unknown[] }[];
  tools?: { function?: { name?: string } }[];
  model?: string;
}

/** A stand-in model server that records what it was asked and replies from a script. */
class MockServer {
  private server!: Server;
  readonly bodies: ChatBody[] = [];
  readonly urls: string[] = [];
  port = 0;

  constructor(private readonly script: (turn: number, body: ChatBody) => string) {}

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        this.urls.push(req.url ?? "");
        let body: ChatBody = { messages: [] };
        try {
          body = JSON.parse(raw) as ChatBody;
        } catch {
          /* recorded as empty; the assertions will say so */
        }
        this.bodies.push(body);
        const content = this.script(this.bodies.length, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

function toolCall(name: string, args: Record<string, unknown>): string {
  return `</think><tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(argv: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [join(REPO, "node_modules/tsx/dist/cli.mjs"), MAIN, ...argv],
      { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

/* ------------------------------------------------------------------ */

describe("cli process end to end", () => {
  let dir: string;
  let server: MockServer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "motif-e2e-"));
  });

  afterEach(async () => {
    await server?.stop();
  });

  it("puts the exact task in the first request body", async () => {
    // Unicode, newlines and backslashes on purpose: the CLI, the JSON encoder
    // and the template all get a chance to mangle them between argv and TCP.
    const task = '한글 테스트: fix\tthe "parser"\\n and \\$HOME';
    server = new MockServer((turn) =>
      turn === 1 ? toolCall("done", { summary: "s" }) : toolCall("done", { summary: "s", confirm: true }),
    );
    await server.start();

    const r = await runCli([task, "--endpoint", server.endpoint, "--no-hero"], dir);
    expect(r.code).toBe(0);

    const first = server.bodies[0]!;
    expect(server.urls[0]).toBe("/v1/chat/completions");
    expect(first.messages[0]!.role).toBe("system");
    expect(first.messages[1]).toMatchObject({ role: "user", content: task });
    // A journal entry is not evidence: the point is that the model saw it.
    expect(first.messages).toHaveLength(2);
  }, 30_000);

  it("registers the full canonical tool list on the first request", async () => {
    server = new MockServer((turn) =>
      turn === 1 ? toolCall("done", { summary: "s" }) : toolCall("done", { summary: "s", confirm: true }),
    );
    await server.start();
    await runCli(["do a thing", "--endpoint", server.endpoint, "--no-hero"], dir);

    const names = (server.bodies[0]!.tools ?? []).map((t) => t.function?.name);
    expect(names[0]).toBe("done");
    expect(names).toContain("bash");
  }, 30_000);

  it("hands a subagent the delegated prompt and nothing of the parent's", async () => {
    const parentTask = "PARENT-TASK-MARKER";
    const delegated = "DELEGATED-PROMPT-MARKER";
    server = new MockServer((turn, body) => {
      const isChild = body.messages.some((m) => m.content === delegated);
      if (isChild) {
        // The child finishes immediately; two turns for the confirmation.
        const already = body.messages.filter((m) => m.role === "assistant").length > 0;
        return toolCall("done", already ? { summary: "child done", confirm: true } : { summary: "child done" });
      }
      if (turn === 1) return toolCall("task", { agent: "explorer", prompt: delegated });
      const confirmed = body.messages.filter((m) => m.role === "assistant").length > 1;
      return toolCall("done", confirmed ? { summary: "p", confirm: true } : { summary: "p" });
    });
    await server.start();

    await runCli([parentTask, "--endpoint", server.endpoint, "--no-hero"], dir);

    const childFirst = server.bodies.find(
      (b) => b.messages.length === 2 && b.messages[1]!.content === delegated,
    );
    expect(childFirst, "the child's first request should carry the delegated prompt").toBeDefined();
    expect(childFirst!.messages[0]!.role).toBe("system");
    expect(String(childFirst!.messages[0]!.content)).toContain("explorer");
    // The child sees none of the parent's conversation — that is the whole
    // point of delegating, and the reason its summary has to stand alone.
    for (const m of childFirst!.messages) expect(String(m.content)).not.toContain(parentTask);
  }, 30_000);

  it("writes the task into the journal as well as onto the wire", async () => {
    server = new MockServer((turn) =>
      turn === 1 ? toolCall("done", { summary: "s" }) : toolCall("done", { summary: "s", confirm: true }),
    );
    await server.start();
    await runCli(["journal me", "--endpoint", server.endpoint, "--no-hero"], dir);

    const sessions = join(dir, ".motif", "sessions");
    const files = readdirSync(sessions);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(sessions, files[0]!), "utf8")).toContain("journal me");
  }, 30_000);

  it("rejects bad usage with exit 2 and one line", async () => {
    server = new MockServer(() => toolCall("done", { summary: "s" }));
    await server.start();

    for (const bad of [
      ["t", "--channel", "banana"],
      ["t", "--max-turns", "0"],
      ["t", "--max-turns", "abc"],
      ["t", "--max-turns", "-3"],
    ]) {
      const r = await runCli([...bad, "--endpoint", server.endpoint, "--no-hero"], dir);
      expect(r.code, bad.join(" ")).toBe(2);
      expect(r.stderr.split("\n").filter(Boolean)).toHaveLength(1);
      expect(r.stderr).not.toContain("    at ");
    }
    // Nothing reached the model: bad usage is caught before the first request.
    expect(server.bodies).toHaveLength(0);
  }, 60_000);

  it("prints help and exits 2 for an empty task", async () => {
    server = new MockServer(() => toolCall("done", { summary: "s" }));
    await server.start();
    const r = await runCli(["   ", "--endpoint", server.endpoint, "--no-hero"], dir);
    expect(r.code).toBe(2);
    expect(server.bodies).toHaveLength(0);
  }, 30_000);
});
