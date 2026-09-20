/**
 * Slash commands against a fake context.
 *
 * Every command is a function of its arguments and the context, so the table
 * is checked here without a screen, a loop or a terminal.
 */

import { describe, expect, it } from "vitest";
import { COMMANDS, findCommand, parseSlash, runSlash, type ChatSettings, type CommandContext } from "../src/commands.js";

function fakeContext(overrides: Partial<CommandContext> = {}) {
  const settings: ChatSettings = {
    model: "motif/motif-3",
    endpoint: "https://llm.onerouter.pro",
    channel: "toolcall",
    maxTurns: 100,
    cwd: "/repo",
  };
  const calls: string[] = [];
  const ctx: CommandContext = {
    settings,
    status: () => ["status line"],
    doctor: async () => ["✓ endpoint ok"],
    skills: () => ["explore"],
    agents: () => ["explorer"],
    sessions: () => ["no sessions"],
    resume: async (file) => {
      calls.push(`resume ${file}`);
      return ["continuing"];
    },
    newConversation: (reason) => calls.push(`new: ${reason}`),
    setCwd: (path) => {
      calls.push(`cwd ${path}`);
      return ["ok"];
    },
    toggleThinking: () => {
      calls.push("thinking");
      return true;
    },
    quit: () => calls.push("quit"),
    ...overrides,
  };
  return { ctx, settings, calls };
}

describe("parsing", () => {
  it("splits the name from the arguments", () => {
    expect(parseSlash("/model motif/x")).toEqual({ name: "model", args: "motif/x" });
    expect(parseSlash("  /help  ")).toEqual({ name: "help", args: "" });
    expect(parseSlash("not a command")).toBeNull();
    expect(parseSlash("/")).toBeNull();
  });

  it("resolves aliases", () => {
    expect(findCommand("exit")?.name).toBe("quit");
    expect(findCommand("clear")?.name).toBe("new");
    expect(findCommand("MODEL")?.name).toBe("model");
    expect(findCommand("nope")).toBeUndefined();
  });
});

describe("commands", () => {
  it("lists every command and the keys in /help", async () => {
    const { ctx } = fakeContext();
    const out = await runSlash("/help", ctx);
    for (const c of COMMANDS) expect(out.lines.join("\n")).toContain(`/${c.name}`);
    expect(out.lines.join("\n")).toContain("esc");
  });

  it("shows and sets the model, endpoint, budgets and seed", async () => {
    const { ctx, settings } = fakeContext();
    expect((await runSlash("/model", ctx)).lines).toEqual(["motif/motif-3"]);
    await runSlash("/model other/model", ctx);
    expect(settings.model).toBe("other/model");

    await runSlash("/endpoint http://x/v1", ctx);
    expect(settings.endpoint).toBe("http://x");
    expect((await runSlash("/endpoint nope", ctx)).error).toBe(true);

    await runSlash("/max-turns 7", ctx);
    expect(settings.maxTurns).toBe(7);
    expect((await runSlash("/max-turns 0", ctx)).error).toBe(true);
    expect(settings.maxTurns).toBe(7);

    await runSlash("/max-tokens 4096", ctx);
    expect(settings.maxOutputTokens).toBe(4096);
    await runSlash("/max-tokens off", ctx);
    expect(settings.maxOutputTokens).toBeUndefined();

    await runSlash("/seed 42", ctx);
    expect(settings.seed).toBe(42);
    await runSlash("/seed off", ctx);
    expect(settings.seed).toBeUndefined();
  });

  it("restarts the conversation when the channel changes, and warns about the experiment", async () => {
    // The transcript is written in the old channel's format; the formats are
    // not interchangeable, so the loop's own rule applies here too.
    const { ctx, settings, calls } = fakeContext();
    const out = await runSlash("/channel raw", ctx);
    expect(settings.channel).toBe("raw");
    expect(calls).toEqual(["new: channel changed to raw"]);
    expect(out.lines.join(" ")).toContain("experimental");
    expect((await runSlash("/channel raw", ctx)).lines).toEqual(["already on raw"]);
    expect((await runSlash("/channel banana", ctx)).error).toBe(true);
  });

  it("routes the housekeeping commands to the context", async () => {
    const { ctx, calls } = fakeContext();
    expect((await runSlash("/status", ctx)).lines).toEqual(["status line"]);
    expect((await runSlash("/doctor", ctx)).lines).toEqual(["✓ endpoint ok"]);
    expect((await runSlash("/skills", ctx)).lines).toEqual(["explore"]);
    expect((await runSlash("/agents", ctx)).lines).toEqual(["explorer"]);
    expect((await runSlash("/sessions", ctx)).lines).toEqual(["no sessions"]);
    await runSlash("/resume a.jsonl", ctx);
    await runSlash("/cwd ../other", ctx);
    await runSlash("/thinking", ctx);
    await runSlash("/new", ctx);
    await runSlash("/exit", ctx);
    expect(calls).toEqual(["resume a.jsonl", "cwd ../other", "thinking", "new: new conversation", "quit"]);
  });

  it("reports an unknown command and a missing argument as errors", async () => {
    const { ctx } = fakeContext();
    const unknown = await runSlash("/frobnicate", ctx);
    expect(unknown.error).toBe(true);
    expect(unknown.lines[0]).toContain("/help");
    expect((await runSlash("/resume", ctx)).error).toBe(true);
  });

  it("turns a throwing command into an error line rather than a crash", async () => {
    const { ctx } = fakeContext({
      resume: async () => {
        throw new Error("no such file");
      },
    });
    const out = await runSlash("/resume x", ctx);
    expect(out.error).toBe(true);
    expect(out.lines).toEqual(["no such file"]);
  });
});
