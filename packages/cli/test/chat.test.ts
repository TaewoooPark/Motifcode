/**
 * The interactive session, driven through a fake terminal.
 *
 * Keys go in as the bytes a terminal would send; what comes out is the
 * requests the model saw and the lines the screen wrote. No pseudo-terminal
 * is needed: the screen takes its writer and columns from options, and the
 * controller takes its input stream, so the whole path from keystroke to
 * request runs in-process.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, BUILTIN_AGENTS } from "@motifcode/agents";
import { TransportError, type CompletionRequest, type CompletionResponse, type Transport } from "@motifcode/core";
import { DEFAULT_HOOKS } from "@motifcode/hooks";
import type { JournalLine } from "@motifcode/journal";
import { doneBody, toolCallBody } from "@motifcode/replay";
import { BUILTIN_SKILLS, SkillRegistry, parseSkill } from "@motifcode/skills";
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
    screen: new Screen({ write: (s) => out.push(s), columns: () => 100, interactive: true, cwd }),
    stdin: stdin as unknown as NodeJS.ReadStream,
    settings: { model: "motif/motif-3", endpoint: "https://llm.onerouter.pro", channel: "toolcall", maxTurns: 20, cwd, theme: "motif", compactAt: 0.75, permissions: "auto" },
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

  it.each(["typed", "initial", "mention", "slash"] as const)("attaches MCP setup guidance once through %s input", async entry => {
    const skills = new SkillRegistry(); skills.registerAll(BUILTIN_SKILLS);
    skills.register(parseSkill("---\nname: mcp-setup\ndescription: local setup\nbudget: 30\n---\nTUI-SETUP-OVERRIDE", "project"));
    const task = "https://example.test/mcp MCP 추가해주세요";
    const t = new GateTransport(reply("Instructions received."));
    const s = session(t, { skills, ...(entry === "initial" ? { initialTask: task } : {}) }); open.push(s);
    if (entry !== "initial") s.type(`${entry === "mention" ? "@skill:mcp-setup " : entry === "slash" ? "/mcp-setup " : ""}${task}\r`);
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    const user = String(t.seen[0]!.messages[1]!.content);
    expect(user).toContain(task);
    expect(user.match(/<skill name="mcp-setup">/g)).toHaveLength(1);
    expect(user).toContain("TUI-SETUP-OVERRIDE");
    expect(t.seen[0]!.messages[0]!.content).not.toContain("TUI-SETUP-OVERRIDE");
    expect(t.seen[0]!.tools).toEqual(toolPrefix(CORE_TOOLS.length - 1));
  });

  it.each(["typed", "initial", "mention", "slash", "codex"] as const)("routes linked skill installation once through %s TUI input", async entry => {
    const skills = new SkillRegistry(); skills.registerAll(BUILTIN_SKILLS);
    skills.register(parseSkill("---\nname: skill-setup\ndescription: project setup policy\nbudget: 30\n---\nTUI-SKILL-INSTALL-POLICY", "project"));
    const task = "https://github.com/anthropics/skills/tree/main/skills/mcp-builder 이 MCP 스킬을 이 프로젝트에 설치해줘. 결과를 알려줘.";
    const t = new GateTransport(reply("Instructions received."));
    const s = session(t, { skills, ...(entry === "initial" ? { initialTask: task } : {}) }); open.push(s);
    if (entry !== "initial") s.type(`${entry === "mention" ? "@skill:skill-setup " : entry === "slash" ? "/skill-setup " : entry === "codex" ? "$skill-setup " : ""}${task}\r`);
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    const user = String(t.seen[0]!.messages[1]!.content);
    expect(user).toContain(task);
    expect(user.match(/<skill name="skill-setup">/g)).toHaveLength(1);
    expect(user).toContain("TUI-SKILL-INSTALL-POLICY");
    expect(user).not.toContain('<skill name="mcp-setup">');
    expect(t.seen[0]!.messages[0]!.content).not.toContain("TUI-SKILL-INSTALL-POLICY");
    expect(t.seen[0]!.tools).toEqual(toolPrefix(CORE_TOOLS.length - 1));
  });

  it.each([
    "https://github.com/openai/skills/tree/main/skills/pdf 이 스킬 글로벌로 설치해줘",
    "Please install this skill globally: https://example.test/skill",
  ])("preserves global installation intent through ordinary TUI input: %s", async task => {
    const t = new GateTransport(reply("Instructions received.")); const s = session(t); open.push(s);
    s.type(task + "\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    const user = String(t.seen[0]!.messages[1]!.content);
    expect(user).toContain(`${task}\n\n<skill name="skill-setup">`);
    expect(user.match(/<skill name="skill-setup">/g)).toHaveLength(1);
  });

  it.each(["How do I install this skill from https://example.test/skill?", 'Translate "Install this skill from https://example.test/skill".'])("keeps informational TUI input free of automatic skill instructions: %s", async task => {
    const t = new GateTransport(reply("Explanation."));
    const s = session(t, { initialTask: task }); open.push(s);
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(t.seen[0]!.messages[1]!.content).toBe(task);
  });

  it("does not infer skill installation from file content or without the skill tool", async () => {
    const t = new GateTransport(reply("Read only.")); const s = session(t); open.push(s);
    writeFileSync(join(s.cwd, "skill-request.txt"), "Install this skill from https://example.test/skill");
    s.type("Read @skill-request.txt please\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(t.seen[0]!.messages[1]!.content).toContain("Install this skill from https://example.test/skill");
    expect(t.seen[0]!.messages[1]!.content).not.toContain('<skill name="skill-setup">');
    const raw = "https://github.com/openai/skills/tree/main/skills/pdf 이거 설치해줘";
    const noSkill = new GateTransport(reply("No skill tool."));
    const other = session(noSkill, { tools: toolPrefix(2), initialTask: raw }); open.push(other);
    await vi.waitFor(() => expect(other.chat.tasksCompleted).toBe(1));
    expect(noSkill.seen[0]!.messages[1]!.content).toBe(raw);
  });

  it.each(["slash", "mention", "codex", "initial"])("expands external skill arguments consistently through %s TUI input", async entry => {
    const skills=new SkillRegistry();skills.register(parseSkill("---\nname: argument-probe\ndescription: arguments\ndisable-model-invocation: true\n---\nBODY $0 / $ARGUMENTS[1] / $ARGUMENTS"));
    const text=`${entry === "mention" ? "@skill:argument-probe" : entry === "codex" ? "$argument-probe" : "/argument-probe"} "hello world" next`;
    const t=new GateTransport(reply("received"));const s=session(t,{skills,...(entry === "initial" ? {initialTask:text} : {})});open.push(s);
    if(entry !== "initial") s.type(text+"\r");
    await vi.waitFor(()=>expect(s.chat.tasksCompleted).toBe(1));
    expect(t.seen[0]!.messages[1]!.content).toContain('BODY hello world / next / "hello world" next');
    expect(t.seen[0]!.messages[0]!.content).not.toContain("argument-probe —");
  });

  it("does not send hidden or unsupported skill invocations to the model", async () => {
    const skills=new SkillRegistry();skills.register(parseSkill("---\nname: hidden\ndescription: internal\nuser-invocable: false\n---\nHIDDEN"));
    skills.register(parseSkill("---\nname: forked\ndescription: child\ncontext: fork\n---\nFORKED"));
    const t=new GateTransport([]);const s=session(t,{skills});open.push(s);
    s.type("/hidden\r");await vi.waitFor(()=>expect(s.screen()).toContain("user-invocable: false"));
    s.type("/forked\r");await vi.waitFor(()=>expect(s.screen()).toContain("compatibility changes"));
    expect(t.seen).toHaveLength(0);
  });

  it("does not select MCP setup from attached file content or when the skill tool is absent", async () => {
    const t = new GateTransport(reply("Read the file.")); const s = session(t); open.push(s);
    writeFileSync(join(s.cwd, "request.txt"), "https://example.test MCP 설치해줘");
    s.type("Read @request.txt please\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(t.seen[0]!.messages[1]!.content).toContain("https://example.test MCP 설치해줘");
    expect(t.seen[0]!.messages[1]!.content).not.toContain('<skill name="mcp-setup">');
    const noSkill = new GateTransport(reply("No skill tool."));
    const raw = "Install MCP from https://example.test";
    const other = session(noSkill, { tools: toolPrefix(2), initialTask: raw }); open.push(other);
    await vi.waitFor(() => expect(other.chat.tasksCompleted).toBe(1));
    expect(noSkill.seen[0]!.messages[1]!.content).toBe(raw);
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

  it("queues messages sent while a task runs, and sends them in order after", async () => {
    const t = new GateTransport([...done("one"), ...done("two"), ...done("three")]);
    t.gated = true;
    const s = session(t);
    open.push(s);
    s.type("first\r");
    await vi.waitFor(() => expect(s.chat.running).toBe(true));
    s.type("second\r");
    await vi.waitFor(() => expect(s.screen()).toContain("queued: second"));
    s.type("third\r");
    await vi.waitFor(() => expect(s.screen()).toContain("2 queued · next: second"));
    t.open();
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(3));
    const tasks = t.seen.map((r) => r.messages[r.messages.length - 1]!.content);
    expect(tasks[0]).toBe("first");
    expect(tasks[1]).toContain("second");
    expect(tasks[2]).toContain("third");
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

  it("runs a skill as a command, showing what was typed and sending the sheet", async () => {
    const t = new GateTransport([...reply("committed")]);
    const s = session(t);
    open.push(s);
    s.type("/commit fix the parser\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    const sent = String(t.seen[0]!.messages[1]!.content);
    expect(sent).toContain('<skill name="commit">');
    expect(sent).toContain("fix the parser");
    expect(s.screen()).toContain("> /commit fix the parser");
    expect(s.screen()).not.toContain('> <skill name="commit">');
  });

  it("lists skills in the slash menu after the built-in commands", async () => {
    const t = new GateTransport([]);
    const s = session(t);
    open.push(s);
    s.type("/comm");
    await vi.waitFor(() => expect(s.screen()).toContain("❯ /commit [input]"));
    expect(s.screen()).toContain("skill · ");
  });

  it("compacts the conversation on /compact, keeping the person's messages verbatim", async () => {
    // The summary request is one more completion; the reply is the handoff.
    const t = new GateTransport([...reply("first answer"), "</think>HANDOFF: the parser was fixed"]);
    const s = session(t);
    open.push(s);
    s.type("fix the parser\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    s.type("/compact\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Context compacted"));
    const roles = s.chat.transcript.map((m) => m.role);
    expect(roles).toEqual(["user", "user"]);
    expect(s.chat.transcript[0]!.content).toBe("fix the parser");
    expect(String(s.chat.transcript[1]!.content)).toContain("HANDOFF: the parser was fixed");
    // The summary request carried the whole transcript plus the prompt.
    const summaryRequest = t.seen[1]!;
    expect(String(summaryRequest.messages[summaryRequest.messages.length - 1]!.content)).toContain("CONTEXT CHECKPOINT COMPACTION");
  });

  it("refuses to compact while a task runs, since the task would hand back the old transcript", async () => {
    const t = new GateTransport([...reply("later")]);
    t.gated = true;
    const s = session(t);
    open.push(s);
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.running).toBe(true));
    s.type("/compact\r");
    await vi.waitFor(() => expect(s.screen()).toContain("/compact changes the conversation"));
    expect(t.seen).toHaveLength(1);
    t.open();
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
  });

  it("compacts on its own once a request crosses the threshold", async () => {
    // The fake endpoint reports 100 prompt tokens; a threshold below that
    // makes every task cross it, so the compaction runs right after.
    // Every request reports 100 prompt tokens, so every task crosses the
    // threshold and is followed by a compaction; the second one has no
    // scripted summary and must surface as a warning, not as a rejection.
    const t = new GateTransport([...reply("done with one"), "</think>SUMMARY ONE", ...reply("done with two")]);
    const s = session(t, { settings: { model: "m", endpoint: "https://x", channel: "toolcall", maxTurns: 20, cwd: mkdtempSync(join(tmpdir(), "motif-chat-")), theme: "motif", compactAt: 0.0001, permissions: "auto" } });
    open.push(s);
    s.type("one\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Context compacted"));
    s.type("two\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    const second = t.seen[2]!.messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "user", "user"]);
    expect(second[1]!.content).toBe("one");
    expect(String(second[2]!.content)).toContain("SUMMARY ONE");
    expect(second[3]!.content).toBe("two");
    await vi.waitFor(() => expect(s.screen()).toContain("compaction failed: no scripted body left; the transcript was left as it was"));
    await s.chat.whenIdle();
  });

  it("switches the theme and says so", async () => {
    const t = new GateTransport([]);
    const s = session(t);
    open.push(s);
    s.type("/theme claude\r");
    await vi.waitFor(() => expect(s.screen()).toContain("theme set to claude"));
    s.type("/theme neon\r");
    await vi.waitFor(() => expect(s.screen()).toContain("no theme named neon"));
  });

  it("opens a file picker on @, completes with tab, and attaches the file on send", async () => {
    const t = new GateTransport([...reply("read it")]);
    const s = session(t);
    open.push(s);
    writeFileSync(join(s.cwd, "alpha.txt"), "ALPHA CONTENT\n");
    execFileSync("git", ["init", "-q"], { cwd: s.cwd });
    s.type("look at @alp");
    await vi.waitFor(() => expect(s.screen()).toContain("❯ @alpha.txt"));
    s.type("\t");
    await vi.waitFor(() => expect(s.screen()).toContain("> look at @alpha.txt"));
    s.type("please\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    const sent = String(t.seen[0]!.messages[1]!.content);
    expect(sent.startsWith("look at @alpha.txt please")).toBe(true);
    expect(sent).toContain('<file path="alpha.txt">\nALPHA CONTENT');
    expect(s.screen()).toContain("attached @alpha.txt");
    // The transcript shows what was typed, not the attachment.
    expect(s.screen()).not.toContain("> look at @alpha.txt please\n\n<file");
  });

  it("offers skills in the picker as @skill:name", async () => {
    const t = new GateTransport([]);
    const s = session(t);
    open.push(s);
    s.type("@skill:com");
    await vi.waitFor(() => expect(s.screen()).toContain("❯ @skill:commit"));
  });

  it("runs !commands here and tells the model what they printed", async () => {
    const t = new GateTransport([...reply("noted")]);
    const s = session(t);
    open.push(s);
    s.type("!echo hello-from-shell\r");
    // The result line, not the head line: the head is painted before the
    // command has run.
    await vi.waitFor(() => expect(s.screen()).toContain("⎿  hello-from-shell"));
    expect(s.screen()).toContain("⏺ Bash(echo hello-from-shell)");
    expect(t.seen).toHaveLength(0);
    s.type("what did that print?\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    const roles = t.seen[0]!.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "user"]);
    expect(String(t.seen[0]!.messages[1]!.content)).toContain("$ echo hello-from-shell");
    expect(String(t.seen[0]!.messages[1]!.content)).toContain("hello-from-shell");
  });

  it("appends #notes to the project notes, which the next task reads", async () => {
    const t = new GateTransport([...reply("ok")]);
    const s = session(t);
    open.push(s);
    s.type("#always run pnpm test before committing\r");
    await vi.waitFor(() => expect(s.screen()).toContain("noted in"));
    expect(readFileSync(join(s.cwd, ".motif", "NOTES.md"), "utf8")).toBe("- always run pnpm test before committing\n");
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(String(t.seen[0]!.messages[0]!.content)).toContain("always run pnpm test before committing");
  });

  it("lists sessions on /resume, picks one by number, and continues it", async () => {
    const t = new GateTransport([...reply("one done"), ...reply("two done")]);
    const s = session(t);
    open.push(s);
    s.type("first task\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    s.type("/new\r");
    await vi.waitFor(() => expect(s.chat.transcript).toHaveLength(0));
    s.type("/resume\r");
    await vi.waitFor(() => expect(s.screen()).toContain("/resume <n> continues"));
    expect(s.screen()).toContain(" 1  ");
    expect(s.screen()).toContain("first task");
    s.type("/resume 1\r");
    await vi.waitFor(() => expect(s.screen()).toContain("continuing from"));
    expect(s.chat.transcript.map((m) => m.role)).toEqual(["user", "assistant"]);
    s.type("second task\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    expect(t.seen[1]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    s.type("/resume 9\r");
    await vi.waitFor(() => expect(s.screen()).toContain("no session 9"));
  });

  it.each([
    ["slash", false], ["slash", true], ["continue", false], ["continue", true],
  ] as const)("refuses %s of an uncertain write with mutating=%s before changing history", async (entry, mutating) => {
    const t = new GateTransport([...reply("original reply"), ...reply("unexpected continuation")]);
    const original = session(t);
    open.push(original);
    original.type("original task\r");
    await vi.waitFor(() => expect(original.chat.tasksCompleted).toBe(1));
    const previous = structuredClone(original.chat.transcript);
    const folder = join(original.cwd, ".motif", "sessions");
    const file = join(folder, readdirSync(folder)[0]!);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JournalLine);
    for (const line of lines) {
      if ("t" in line || line.record.t !== "checkpoint") continue;
      line.record.state.inFlightTool = { name: "write", id: "root-c1", argumentsHash: "fixture", mutating };
      line.record.state.currentChannel = "object";
      line.record.state.messages = [{ role: "system", content: "old system" }, { role: "user", content: "UNSAFE_HISTORY" }];
    }
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const target = entry === "slash" ? original : session(t, { continueFrom: file, initialTask: "must not run" });
    if (target !== original) open.push(target);
    else target.type(`/resume ${file}\r`);
    await vi.waitFor(() => expect(target.screen()).toContain("Inspect the working tree"));
    expect(target.screen()).toContain("start a new run");
    expect(target.chat.transcript).toEqual(entry === "slash" ? previous : []);
    expect(target.screen()).not.toContain("channel set to object");
    expect(t.seen).toHaveLength(1);
  });

  it.each([
    ["slash", "read"], ["slash", "complete"], ["continue", "read"], ["continue", "complete"],
  ] as const)("still loads %s conversations with %s checkpoints", async (entry, state) => {
    const t = new GateTransport([...reply("recorded reply")]);
    const original = session(t);
    open.push(original);
    original.type("recorded task\r");
    await vi.waitFor(() => expect(original.chat.tasksCompleted).toBe(1));
    const folder = join(original.cwd, ".motif", "sessions");
    const file = join(folder, readdirSync(folder)[0]!);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JournalLine);
    for (const line of lines) {
      if ("t" in line) line.header.model.id = "previous/model";
      else if (line.record.t === "checkpoint" && state === "read") {
        line.record.state.inFlightTool = { name: "read", id: "root-c1", argumentsHash: "fixture", mutating: false };
      }
    }
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const target = session(t, entry === "continue" ? { continueFrom: file } : {});
    open.push(target);
    if (entry === "slash") target.type(`/resume ${file}\r`);
    await vi.waitFor(() => expect(target.screen()).toContain("continuing from"));
    expect(target.chat.transcript).toEqual(original.chat.transcript);
    expect(target.screen()).toContain("recorded against previous/model");
    expect(target.screen()).toContain("that session had finished");
    expect(t.seen).toHaveLength(1);
  });

  it("shows tool output in full on ctrl-o and clips it again", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\\n");
    const t = new GateTransport([toolCallBody("bash", { command: `printf '${long}'` }), ...reply("ok")]);
    const s = session(t);
    open.push(s);
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.screen()).toContain("… +24 lines");
    expect(s.chat.transcript.length).toBeGreaterThan(0);
    s.type("\x0f");
    await vi.waitFor(() => expect(s.screen()).toContain("line 29"));
  });

  it("asks before a command runs, and a yes runs it", async () => {
    const t = new GateTransport([toolCallBody("bash", { command: "echo allowed-output" }), ...reply("done")]);
    const s = session(t, { settings: { model: "m", endpoint: "https://x", channel: "toolcall", maxTurns: 20, cwd: mkdtempSync(join(tmpdir(), "motif-chat-")), theme: "motif", compactAt: 0.75, permissions: "ask" } });
    open.push(s);
    s.type("go\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Run this command?"));
    expect(s.screen()).toContain("echo allowed-output");
    expect(s.screen()).toContain("❯ 1. Yes");
    expect(s.screen()).toContain("  2. Yes, and don't ask again for bash this session");
    // Letters meant for a draft cannot answer; only the answers can.
    s.type("hello");
    s.type("1");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.screen()).toContain("⎿  allowed-output");
  });

  it("tells the model when a call is declined, and stops asking after an a", async () => {
    const t = new GateTransport([
      toolCallBody("bash", { command: "echo first" }),
      toolCallBody("bash", { command: "echo second" }),
      toolCallBody("bash", { command: "echo third" }),
      ...reply("done"),
    ]);
    const s = session(t, { settings: { model: "m", endpoint: "https://x", channel: "toolcall", maxTurns: 20, cwd: mkdtempSync(join(tmpdir(), "motif-chat-")), theme: "motif", compactAt: 0.75, permissions: "ask" } });
    open.push(s);
    s.type("go\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Run this command?"));
    // Down twice lands on 3, No; Enter takes it.
    s.type(`${ESC}[B${ESC}[B\r`);
    await vi.waitFor(() => expect(s.screen()).toContain("echo second"));
    // The model heard about the refusal in the tool result.
    const declined = t.seen[1]!.messages.find((m) => m.role === "tool");
    expect(String(declined?.content)).toContain("declined");
    s.type("2");
    // The third call ran without a question — a question would wait forever here.
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.screen()).toContain("⎿  third");
  });

  it("holds queued messages back when the task is interrupted, and ↑ brings them back", async () => {
    const t = new GateTransport([...done("never"), ...reply("later")]);
    t.gated = true;
    const s = session(t);
    open.push(s);
    s.type("long one\r");
    await vi.waitFor(() => expect(s.chat.running).toBe(true));
    s.type("then this\r");
    await vi.waitFor(() => expect(s.screen()).toContain("queued: then this"));
    s.type(ESC);
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.screen()).toContain("1 queued message not sent");
    // Nothing was sent on the heels of the interruption.
    expect(t.seen).toHaveLength(1);
    s.type(`${ESC}[A`);
    await vi.waitFor(() => expect(s.screen()).toContain("> then this"));
  });

  it("toggles permissions with shift-tab and says so", async () => {
    const t = new GateTransport([]);
    const s = session(t);
    open.push(s);
    s.type(`${ESC}[Z`);
    await vi.waitFor(() => expect(s.screen()).toContain("asking before tools"));
    s.type(`${ESC}[Z`);
    await vi.waitFor(() => expect(s.screen()).toContain("running every tool call"));
    expect(s.screen()).toContain("auto-approve on");
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

  describe("signing in", () => {
    const verifyKey = async (k: string) =>
      k === "sk-good" ? { ok: true as const } : { ok: false as const, reason: "the endpoint rejected this key (401)" };
    const freshEnvPath = (): string => join(mkdtempSync(join(tmpdir(), "motif-home-")), ".motif", ".env");

    it("asks for the key before the first prompt, masks it, checks it and saves it", async () => {
      const t = new GateTransport([...done("ok")]);
      const envPath = freshEnvPath();
      let seenKey: string | undefined;
      const s = session(t, {
        requireKey: true,
        envPath,
        verifyKey,
        makeTransport: (_settings, apiKey) => {
          seenKey = apiKey;
          return t;
        },
      });
      open.push(s);
      await vi.waitFor(() => expect(s.screen()).toContain("Paste your Infron API key to get started"));
      s.type("sk-bad");
      await vi.waitFor(() => expect(s.screen()).toContain("key › ••••••"));
      expect(s.screen()).not.toContain("sk-bad");
      s.type("\r");
      await vi.waitFor(() => expect(s.screen()).toContain("rejected this key"));
      expect(existsSync(envPath)).toBe(false);
      s.type("sk-good\r");
      await vi.waitFor(() => expect(s.screen()).toContain("signed in"));
      expect(readFileSync(envPath, "utf8")).toBe("MOTIF_API_KEY=sk-good\n");
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
      expect(s.screen()).not.toContain("sk-good");
      s.type("hello\r");
      await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
      expect(seenKey).toBe("sk-good");
      // The key was never a draft: browsing back finds the task, not the key.
      s.type("\x1b[A");
      await vi.waitFor(() => expect(s.screen()).toContain("> hello"));
    });

    it("can be skipped, and the first task asks again", async () => {
      const t = new GateTransport([...done("ok")]);
      const envPath = freshEnvPath();
      const s = session(t, { requireKey: true, envPath, verifyKey });
      open.push(s);
      await vi.waitFor(() => expect(s.screen()).toContain("to get started"));
      s.type(ESC);
      await vi.waitFor(() => expect(s.screen()).toContain("no key entered"));
      s.type("do it\r");
      await vi.waitFor(() => expect(s.screen()).toContain("An API key is needed before the task can run"));
      s.type("sk-good\r");
      await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
      expect(existsSync(envPath)).toBe(true);
    });

    it("/logout forgets the key and /login takes a new one, keeping the rest of the file", async () => {
      const t = new GateTransport([]);
      const envPath = freshEnvPath();
      mkdirSync(dirname(envPath), { recursive: true });
      writeFileSync(envPath, "MOTIF_ENDPOINT=https://llm.onerouter.pro\nMOTIF_API_KEY=sk-old\n");
      const s = session(t, { requireKey: true, apiKey: "sk-old", apiKeySource: `${envPath} (MOTIF_API_KEY)`, envPath, verifyKey });
      open.push(s);
      s.type("/logout\r");
      await vi.waitFor(() => expect(s.screen()).toContain("the key was removed from"));
      expect(readFileSync(envPath, "utf8")).toBe("MOTIF_ENDPOINT=https://llm.onerouter.pro\n");
      s.type("/login\r");
      await vi.waitFor(() => expect(s.screen()).toContain("Paste your Infron API key"));
      s.type("sk-good\r");
      await vi.waitFor(() => expect(s.screen()).toContain("signed in"));
      expect(readFileSync(envPath, "utf8")).toBe("MOTIF_ENDPOINT=https://llm.onerouter.pro\nMOTIF_API_KEY=sk-good\n");
    });
  });

  describe("the install offer", () => {
    it("offers to install the command, runs npm on yes, and carries on", async () => {
      const t = new GateTransport([...done("ok")]);
      const ran: string[] = [];
      const s = session(t, {
        offerInstall: true,
        version: "0.2.1",
        installGlobal: async (command) => {
          ran.push(command);
          return { code: 0, output: "added 1 package in 700ms", timedOut: false, aborted: false, ms: 700 };
        },
      });
      open.push(s);
      await vi.waitFor(() => expect(s.screen()).toContain("Install the motif command?"));
      expect(s.screen()).toContain("❯ 1. Yes, install it now");
      s.type("1");
      await vi.waitFor(() => expect(s.screen()).toContain("installed: from now on `motif`"));
      expect(ran).toEqual(["npm install -g motifcode@0.2.1"]);
      expect(s.screen()).toContain("added 1 package");
      s.type("hello\r");
      await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    });

    it("takes no for an answer, and esc too", async () => {
      const t = new GateTransport([...done("ok")]);
      const ran: string[] = [];
      const s = session(t, {
        offerInstall: true,
        installGlobal: async (command) => {
          ran.push(command);
          return { code: 0, output: "", timedOut: false, aborted: false, ms: 1 };
        },
      });
      open.push(s);
      await vi.waitFor(() => expect(s.screen()).toContain("Install the motif command?"));
      s.type("\x1b[B");
      await vi.waitFor(() => expect(s.screen()).toContain("❯ 2. Not now"));
      s.type("\r");
      s.type("hello\r");
      await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
      expect(ran).toEqual([]);
    });

    it("says what to do when the install fails", async () => {
      const t = new GateTransport([]);
      const s = session(t, {
        offerInstall: true,
        installGlobal: async () => ({ code: 243, output: "npm error EACCES: permission denied", timedOut: false, aborted: false, ms: 5 }),
      });
      open.push(s);
      await vi.waitFor(() => expect(s.screen()).toContain("Install the motif command?"));
      s.type("\r");
      await vi.waitFor(() => expect(s.screen()).toContain("the install did not finish"));
      expect(s.screen()).toContain("with sudo if npm's global folder is not yours");
    });
  });
});
