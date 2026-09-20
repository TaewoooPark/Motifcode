/**
 * The interactive session, driven through a fake terminal.
 *
 * Keys go in as the bytes a terminal would send; what comes out is the
 * requests the model saw and the lines the screen wrote. No pseudo-terminal
 * is needed: the screen takes its writer and columns from options, and the
 * controller takes its input stream, so the whole path from keystroke to
 * request runs in-process.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, BUILTIN_AGENTS } from "@motifcode/agents";
import { TransportError, type CompletionRequest, type CompletionResponse, type Transport } from "@motifcode/core";
import { DEFAULT_HOOKS } from "@motifcode/hooks";
import { doneBody, toolCallBody } from "@motifcode/replay";
import { BUILTIN_SKILLS, SkillRegistry } from "@motifcode/skills";
import { CORE_TOOLS, toolPrefix } from "@motifcode/tools";
import { Screen } from "@motifcode/tui";
import { Chat } from "../src/chat.js";

const ESC = "\x1b";

class FakeTTY extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
}

/**
 * A transport whose responses can be held back, so a task can be caught
 * mid-flight — interrupted, or queued behind.
 */
class GateTransport implements Transport {
  readonly endpoint = "fake://endpoint";
  readonly model = "fake";
  readonly seen: CompletionRequest[] = [];
  private release: (() => void) | null = null;
  gated = false;

  constructor(private readonly bodies: string[]) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(req);
    if (this.gated) {
      this.gated = false;
      await new Promise<void>((res, rej) => {
        this.release = res;
        req.signal?.addEventListener("abort", () => rej(new TransportError("aborted", { kind: "aborted" })));
      });
    }
    const body = this.bodies.shift();
    if (body === undefined) throw new Error("no scripted body left");
    return { content: body, rawText: body, ms: 1, usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 80 } };
  }

  open(): void {
    this.release?.();
    this.release = null;
  }
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function session(transport: Transport, extra: Partial<ConstructorParameters<typeof Chat>[0]> = {}) {
  const out: string[] = [];
  const stdin = new FakeTTY();
  const skills = new SkillRegistry();
  skills.registerAll(BUILTIN_SKILLS);
  const agents = new AgentRegistry();
  agents.registerAll(BUILTIN_AGENTS);
  const cwd = mkdtempSync(join(tmpdir(), "motif-chat-"));
  let now = 1_000_000;
  const chat = new Chat({
    screen: new Screen({ write: (s) => out.push(s), columns: () => 100, interactive: true }),
    stdin: stdin as unknown as NodeJS.ReadStream,
    settings: { model: "motif/motif-3", endpoint: "https://llm.onerouter.pro", channel: "toolcall", maxTurns: 20, cwd },
    channelPolicy: "fixed",
    skills,
    agents,
    hooks: DEFAULT_HOOKS,
    tools: toolPrefix(CORE_TOOLS.length - 1),
    journalDir: join(cwd, ".motif", "sessions"),
    version: "test",
    makeTransport: () => transport,
    hero: false,
    now: () => now,
    ...extra,
  });
  const finished = chat.run();
  const type = (s: string): void => {
    stdin.write(s);
  };
  const screen = (): string => strip(out.join(""));
  return { chat, type, screen, finished, tick: (ms: number) => (now += ms), cwd };
}

// In a conversation the first `done` is final: the person is the confirmation.
const done = (s: string) => [doneBody(s)];
/** A turn that is words, not work: ends the task on its own. */
const reply = (s: string) => [`</think>${s}`];

describe("interactive session", () => {
  const open: { finished: Promise<number>; type: (s: string) => void }[] = [];
  afterEach(async () => {
    for (const s of open) {
      // Interrupt anything running, clear any draft, then quit on the empty prompt.
      s.type(ESC);
      s.type(ESC);
      s.type("\x04");
      await s.finished;
    }
    open.length = 0;
  });

  it("runs a task and continues the conversation with the next one", async () => {
    const t = new GateTransport([...done("first"), ...done("second")]);
    const s = session(t);
    open.push(s);
    s.type("fix the parser\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(t.seen[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(t.seen[0]!.messages[1]!.content).toBe("fix the parser");
    expect(String(t.seen[0]!.messages[0]!.content)).toContain("A reply with no tool call ends your turn");

    s.type("now the tests\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    const roles = t.seen[1]!.messages.map((m) => m.role);
    // system, the first task, its `done`, then the new task — the model sees
    // what it did before.
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(t.seen[1]!.messages[3]!.content).toBe("now the tests");
    expect(s.screen()).toContain("> fix the parser");
    // The `done` summary stands in for the reply; there is no end banner.
    expect(s.screen()).toContain("⏺ first");
    expect(s.screen()).not.toContain("Interrupted");
  });

  it("treats a reply with no tool call as the end of the turn", async () => {
    // A greeting gets a greeting. The benchmark loop would hand this turn
    // back as a lost one and the model would go looking for a task.
    const t = new GateTransport([...reply("안녕하세요! 무엇을 도와드릴까요?")]);
    const s = session(t);
    open.push(s);
    s.type("안녕?\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(t.seen).toHaveLength(1);
    expect(s.screen()).toContain("⏺ 안녕하세요! 무엇을 도와드릴까요?");
    expect(s.chat.transcript.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.chat.transcript[1]!.content).toBe("안녕하세요! 무엇을 도와드릴까요?");
  });

  it("runs the command the menu has selected", async () => {
    const t = new GateTransport([]);
    const s = session(t);
    open.push(s);
    s.type("/sta");
    // The draft shows what was typed; the menu row marks the completion.
    await vi.waitFor(() => expect(s.screen()).toContain("❯ /status"));
    expect(s.screen()).toContain("> /sta");
    s.type("\r");
    await vi.waitFor(() => expect(s.screen()).toContain("──  /status"));
    expect(s.screen()).toContain("model       motif/motif-3");
    expect(t.seen).toHaveLength(0);
  });

  it("applies a setting to the next task", async () => {
    const seenSettings: string[] = [];
    const t = new GateTransport([...done("x")]);
    const s = session(t, {
      makeTransport: (settings) => {
        seenSettings.push(settings.model);
        return t;
      },
    });
    open.push(s);
    s.type("/model other/model\r");
    await vi.waitFor(() => expect(s.screen()).toContain("model set to other/model"));
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(seenSettings).toEqual(["other/model"]);
  });

  it("interrupts a running task on escape and keeps the prompt", async () => {
    const t = new GateTransport([...done("never")]);
    t.gated = true;
    const s = session(t);
    open.push(s);
    s.type("long task\r");
    await vi.waitFor(() => expect(s.chat.running).toBe(true));
    expect(s.screen()).toContain("esc to interrupt");
    s.type(ESC);
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.chat.running).toBe(false);
    expect(s.screen()).toContain("Interrupted");
    // The conversation keeps what happened; the next task follows it.
    expect(s.chat.transcript.map((m) => m.role)).toEqual(["user"]);
  });

  it("queues a message sent while a task runs, and sends it after", async () => {
    const t = new GateTransport([...done("one"), ...done("two")]);
    t.gated = true;
    const s = session(t);
    open.push(s);
    s.type("first\r");
    await vi.waitFor(() => expect(s.chat.running).toBe(true));
    s.type("second\r");
    await vi.waitFor(() => expect(s.screen()).toContain("queued: second"));
    t.open();
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    const tasks = t.seen.map((r) => r.messages[r.messages.length - 1]!.content);
    expect(tasks[0]).toBe("first");
    expect(tasks[1]).toContain("second");
  });

  it("turns a trailing backslash into a line break", async () => {
    const t = new GateTransport([...done("x")]);
    const s = session(t);
    open.push(s);
    s.type("line one\\\r");
    s.type("line two\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(t.seen[0]!.messages[1]!.content).toBe("line one\nline two");
  });

  it("forgets the transcript on /new", async () => {
    const t = new GateTransport([...done("a"), ...done("b")]);
    const s = session(t);
    open.push(s);
    s.type("first\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    s.type("/new\r");
    await vi.waitFor(() => expect(s.chat.transcript).toHaveLength(0));
    s.type("second\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    expect(t.seen[1]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("opens the shortcuts panel on ? and shows the spinner while the model works", async () => {
    const t = new GateTransport([...reply("ok")]);
    t.gated = true;
    const s = session(t);
    open.push(s);
    s.type("?");
    await vi.waitFor(() => expect(s.screen()).toContain("ctrl-c twice quit"));
    s.type("?");
    s.type("do it\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Thinking… (esc to interrupt"));
    t.open();
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
  });

  it("quits on ctrl-c twice, but not once", async () => {
    const t = new GateTransport([]);
    const s = session(t);
    s.type("\x03");
    await vi.waitFor(() => expect(s.screen()).toContain("ctrl-c again to quit"));
    s.tick(5000);
    s.type("\x03");
    // Too late: the window closed, so this only re-arms.
    s.tick(100);
    s.type("\x03");
    expect(await s.finished).toBe(0);
  });

  it("clears the draft on escape before it ever interrupts anything", async () => {
    const t = new GateTransport([...done("x")]);
    const s = session(t);
    open.push(s);
    s.type("half typed");
    await vi.waitFor(() => expect(s.screen()).toContain("half typed"));
    s.type(ESC);
    s.type("real task\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(t.seen[0]!.messages[1]!.content).toBe("real task");
  });

  it("writes one journal per task, each carrying the whole conversation", async () => {
    const t = new GateTransport([...done("a"), ...done("b")]);
    const s = session(t);
    open.push(s);
    s.type("first\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    s.type("second\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = join(s.cwd, ".motif", "sessions");
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const second = readFileSync(join(dir, files[1]!), "utf8");
    expect(second).toContain("first");
    expect(second).toContain("second");
  });
});
