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
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  prompt?: string;
  model?: string;
}

/** A stand-in model server that records what it was asked and replies from a script. */
class MockServer {
  private server!: Server;
  readonly bodies: ChatBody[] = [];
  readonly urls: string[] = [];
  readonly headers: Record<string, string | string[] | undefined>[] = [];
  port = 0;

  constructor(private readonly script: (turn: number, body: ChatBody) => string) {}

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        this.urls.push(req.url ?? "");
        this.headers.push(req.headers);
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

function runCli(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
  // The key is stripped from the inherited environment, and HOME points at an
  // empty directory, so neither a developer's own MOTIF_API_KEY nor their
  // ~/.motif/.env can make the unauthenticated cases pass by accident.
  const { MOTIF_API_KEY: _dropped, ...inherited } = process.env;
  void _dropped;
  const home = mkdtempSync(join(tmpdir(), "motif-home-"));
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [join(REPO, "node_modules/tsx/dist/cli.mjs"), MAIN, ...argv],
      { cwd, env: { ...inherited, HOME: home, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] },
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

  it("prints only the reply with --print, for pipes", async () => {
    // A reply with no tool call ends the task; nothing but the reply is
    // written to stdout, so `motif -p` composes with other tools.
    server = new MockServer(() => "</think>The answer is 42.");
    await server.start();
    const r = await runCli(["what is the answer?", "--print", "--endpoint", server.endpoint], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("The answer is 42.\n");
    expect(server.bodies).toHaveLength(1);
    expect(String(server.bodies[0]!.messages[0]!.content)).toContain("A reply with no tool call ends your turn");
  }, 30_000);

  it("prints help and exits 2 for an empty task", async () => {
    // Without a terminal there is no prompt to open, so an empty command is
    // a usage error, as it always was.
    server = new MockServer(() => toolCall("done", { summary: "s" }));
    await server.start();
    const r = await runCli(["   ", "--endpoint", server.endpoint, "--no-hero"], dir);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("motif \"<task>\"");
    expect(server.bodies).toHaveLength(0);
  }, 30_000);

  it("refuses --interactive without a terminal, in one line", async () => {
    server = new MockServer(() => toolCall("done", { summary: "s" }));
    await server.start();
    const r = await runCli(["t", "--interactive", "--endpoint", server.endpoint, "--no-hero"], dir);
    expect(r.code).toBe(2);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain("terminal");
    expect(server.bodies).toHaveLength(0);
  }, 30_000);
});

describe("the credential", () => {
  let dir: string;
  let server: MockServer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "motif-key-"));
  });

  afterEach(async () => {
    await server?.stop();
  });

  const finish = (turn: number) =>
    turn === 1 ? toolCall("done", { summary: "s" }) : toolCall("done", { summary: "s", confirm: true });

  it("goes out as a bearer token when set in the environment", async () => {
    server = new MockServer(finish);
    await server.start();
    const r = await runCli(["t", "--endpoint", server.endpoint, "--no-hero"], dir, { MOTIF_API_KEY: "sk-from-env" });
    expect(r.code).toBe(0);
    expect(server.headers[0]!["authorization"]).toBe("Bearer sk-from-env");
  }, 30_000);

  it("is read from a .env file in the invocation directory", async () => {
    server = new MockServer(finish);
    await server.start();
    writeFileSync(join(dir, ".env"), "MOTIF_API_KEY=sk-from-dotenv\n", "utf8");
    const r = await runCli(["t", "--endpoint", server.endpoint, "--no-hero"], dir);
    expect(r.code).toBe(0);
    expect(server.headers[0]!["authorization"]).toBe("Bearer sk-from-dotenv");
  }, 30_000);

  it("is read from --env-file, which outranks the directory's .env", async () => {
    server = new MockServer(finish);
    await server.start();
    writeFileSync(join(dir, ".env"), "MOTIF_API_KEY=sk-from-dotenv\n", "utf8");
    const file = join(dir, "other.env");
    writeFileSync(file, "MOTIF_API_KEY=sk-from-flag\n", "utf8");
    const r = await runCli(["t", "--endpoint", server.endpoint, "--no-hero", "--env-file", file], dir);
    expect(r.code).toBe(0);
    expect(server.headers[0]!["authorization"]).toBe("Bearer sk-from-flag");
  }, 30_000);

  it("is absent from the header when nothing configures it", async () => {
    server = new MockServer(finish);
    await server.start();
    await runCli(["t", "--endpoint", server.endpoint, "--no-hero"], dir);
    expect(server.headers[0]!["authorization"]).toBeUndefined();
  }, 30_000);

  it("never reaches the commands the agent runs", async () => {
    // A model that runs `env` to look around would otherwise put the key into
    // a tool result, and tool results are journalled and sent back as context.
    server = new MockServer((turn) =>
      turn === 1
        ? toolCall("bash", { command: 'echo "K=${MOTIF_API_KEY:-unset}"' })
        : turn === 2
          ? toolCall("done", { summary: "s" })
          : toolCall("done", { summary: "s", confirm: true }),
    );
    await server.start();
    const r = await runCli(["t", "--endpoint", server.endpoint, "--no-hero"], dir, { MOTIF_API_KEY: "sk-hidden" });
    expect(r.code).toBe(0);
    // The header carried it; the tool result did not.
    expect(server.headers[0]!["authorization"]).toBe("Bearer sk-hidden");
    const toolResult = server.bodies[1]!.messages.find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("K=unset");
    expect(JSON.stringify(server.bodies)).not.toContain("sk-hidden");
    const sessions = join(dir, ".motif", "sessions");
    const journal = readFileSync(join(sessions, readdirSync(sessions)[0]!), "utf8");
    expect(journal).not.toContain("sk-hidden");
  }, 30_000);

  it("writes the call back into history with its result", async () => {
    // The server extracts nothing here — the mock returns text — but the
    // history the CLI sends on turn two must still pair the call with the
    // tool result, or a server-side template renders an answer to nothing.
    server = new MockServer((turn) =>
      turn === 1
        ? toolCall("bash", { command: "echo hi" })
        : turn === 2
          ? toolCall("done", { summary: "s" })
          : toolCall("done", { summary: "s", confirm: true }),
    );
    await server.start();
    await runCli(["t", "--endpoint", server.endpoint, "--no-hero"], dir);
    const second = server.bodies[1]!.messages;
    const assistant = second.find((m) => m.role === "assistant") as { tool_calls?: { id: string; function: { name: string } }[] };
    expect(assistant.tool_calls?.[0]?.function.name).toBe("bash");
    const tool = second.find((m) => m.role === "tool") as { tool_call_id?: string; content?: string };
    expect(tool.tool_call_id).toBe(assistant.tool_calls![0]!.id);
    expect(tool.content).toBe("hi");
  }, 30_000);
});

describe("channels are honest about what has been measured", () => {
  let dir: string;
  let server: MockServer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "motif-chan-"));
  });

  afterEach(async () => {
    await server?.stop();
  });

  it("refuses an unmeasured channel without the experimental flag", async () => {
    server = new MockServer(() => toolCall("done", { summary: "s" }));
    await server.start();
    for (const chan of ["object", "raw"]) {
      const r = await runCli(["t", "--channel", chan, "--endpoint", server.endpoint, "--no-hero"], dir);
      expect(r.code, chan).toBe(2);
      expect(r.stderr).toContain("never been measured");
    }
    expect(server.bodies).toHaveLength(0);
  }, 30_000);

  it("refuses adaptive policy without the experimental flag", async () => {
    server = new MockServer(() => toolCall("done", { summary: "s" }));
    await server.start();
    const r = await runCli(
      ["t", "--channel-policy", "adaptive", "--endpoint", server.endpoint, "--no-hero"],
      dir,
    );
    expect(r.code).toBe(2);
    expect(server.bodies).toHaveLength(0);
  }, 30_000);

  it("drives the completions endpoint once object is opted into", async () => {
    server = new MockServer((turn) =>
      turn === 1
        ? '</think>{"task_complete": true, "summary": "s"}'
        : '</think>{"task_complete": true, "summary": "s", "confirm": true}',
    );
    await server.start();
    const r = await runCli(
      ["t", "--channel", "object", "--experimental-channel", "--endpoint", server.endpoint, "--no-hero"],
      dir,
    );
    expect(r.code).toBe(0);
    expect(server.urls[0]).toBe("/v1/completions");
    expect(server.bodies[0]).toHaveProperty("prompt");
    expect(server.bodies[0]).not.toHaveProperty("messages");
  }, 30_000);
});
