/**
 * Compaction: what is kept, what is asked, and what replaces the rest.
 */

import { describe, expect, it } from "vitest";
import { ScriptedTransport, doneBody, toolCallBody } from "@motifcode/replay";
import { CORE_TOOLS } from "@motifcode/tools";
import {
  SUMMARIZATION_PROMPT,
  SUMMARY_PREFIX,
  buildCompactedHistory,
  keepUserTurns,
  runLoop,
  summarizeTranscript,
  type Executor,
} from "../src/index.js";

const okExecutor: Executor = { run: async () => ({ ok: true, output: "ok" }) };

describe("what is kept", () => {
  it("keeps the person's turns verbatim, newest first when over budget", () => {
    const turns = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
    expect(keepUserTurns(turns, 1000)).toEqual(turns);
    expect(keepUserTurns(turns, 65)).toEqual([turns[1], turns[2]]);
    // One turn is always kept, however large.
    expect(keepUserTurns(["x".repeat(500)], 10)).toEqual(["x".repeat(500)]);
  });

  it("puts the summary last, behind its prefix", () => {
    const history = buildCompactedHistory(["fix it", "now the tests"], "  HANDOFF  ");
    expect(history.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(history[2]!.content).toBe(`${SUMMARY_PREFIX}HANDOFF`);
  });
});

describe("the summary request", () => {
  it("sends the transcript plus the prompt and returns the reply as text", async () => {
    const t = new ScriptedTransport(["</think>TASK STATE: done"]);
    const summary = await summarizeTranscript({
      transport: t,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "task" },
      ],
      tools: [...CORE_TOOLS],
    });
    expect(summary).toBe("TASK STATE: done");
    const req = t.seen[0]!;
    expect(req.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(req.messages[2]!.content).toBe(SUMMARIZATION_PROMPT);
    expect(req.tools).toHaveLength(CORE_TOOLS.length);
  });

  it("passes the person's focus on to the summary prompt", async () => {
    const t = new ScriptedTransport(["</think>ok"]);
    await summarizeTranscript({ transport: t, messages: [{ role: "user", content: "t" }], tools: [], focus: "the failing test" });
    const last = t.seen[0]!.messages[t.seen[0]!.messages.length - 1]!;
    expect(String(last.content)).toContain("concentrate on: the failing test");
  });

  it("refuses an empty summary", async () => {
    const empty = new ScriptedTransport(["</think>"]);
    await expect(
      summarizeTranscript({ transport: empty, messages: [{ role: "user", content: "t" }], tools: [] }),
    ).rejects.toThrow(/no summary/);
  });

  it.each([
    'Let me check first.<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
    'Let me check first.<tool_call>{"name":"bash","arguments":',
    'Let me check first.<tool_call>',
    'Let me check first.<tool_call>not JSON</tool_call>',
    '```json\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>\n```',
    '`<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>`',
    'The parser recognizes `<tool_call>`. Now inspect.<tool_call>{"name":"bash","arguments":',
  ])("refuses an inline call without stripping it into a summary: %s", async (body) => {
    const inline = new ScriptedTransport([`</think>${body}`]);
    await expect(
      summarizeTranscript({ transport: inline, messages: [{ role: "user", content: "t" }], tools: [] }),
    ).rejects.toThrow(/called a tool/);
  });

  it("refuses a parsed call even when the server provides nonempty summary text", async () => {
    const parsed = new ScriptedTransport([{
      content: "Let me check the state first.",
      rawText: "Let me check the state first.",
      reasoningContent: "",
      toolCalls: [{ function: { name: "bash", arguments: { command: "git status" } } }],
      ms: 1,
    }]);
    await expect(
      summarizeTranscript({ transport: parsed, messages: [{ role: "user", content: "t" }], tools: [] }),
    ).rejects.toThrow(/called a tool/);
  });

  it.each([
    'FILES AND CODE: the parser recognizes `<tool_call>`. NEXT STEPS: test it.',
    'FILES AND CODE: the parser recognizes ``<tool_call>``. NEXT STEPS: test it.',
    'FILES AND CODE: the opener is "<tool_call>". NEXT STEPS: test it.',
    "FILES AND CODE: the opener is '<tool_call>'. NEXT STEPS: test it.",
    'FILES AND CODE:\n```ts\nbody.includes("<tool_call>")\n```\nNEXT STEPS: test it.',
  ])("preserves a handoff that quotes a marker instead of calling a tool: %s", async (summary) => {
    for (const separated of [false, true]) {
      const body = separated ? summary : `</think>${summary}`;
      const t = new ScriptedTransport([{
        content: body, rawText: body, ms: 1,
        ...(separated ? { reasoningContent: "", toolCalls: [] } : {}),
      }]);
      expect(await summarizeTranscript({ transport: t, messages: [{ role: "user", content: "fix the parser" }], tools: [] })).toBe(summary);
    }
  });

  it("does not treat a marker in reasoning as a tool call", async () => {
    const t = new ScriptedTransport(["Do not emit <tool_call> here.</think>HANDOFF SUMMARY"]);
    expect(await summarizeTranscript({ transport: t, messages: [{ role: "user", content: "t" }], tools: [] })).toBe("HANDOFF SUMMARY");
  });
});

describe("in the loop", () => {
  const base = { tools: [...CORE_TOOLS], system: () => "sys", userTask: "big task", executor: okExecutor, emit: () => {} };
  const withUsage = (body: string, promptTokens: number) => ({
    content: body,
    rawText: body,
    ms: 1,
    usage: { promptTokens, completionTokens: 5 },
  });

  it("compacts before the next request once a request crosses the limit", async () => {
    const t = new ScriptedTransport([
      withUsage(toolCallBody("bash", { command: "ls" }), 5000),
      "</think>HANDOFF SUMMARY",
      withUsage(doneBody("d"), 100),
      withUsage(doneBody("d", { confirm: true }), 100),
    ]);
    const events: string[] = [];
    const r = await runLoop({
      ...base,
      transport: t,
      emit: (e) => events.push(e.type),
      compaction: { limitTokens: 4000, userTurns: ["earlier task"] },
    });
    expect(r.reason).toBe("done");
    expect(events).toContain("compaction");
    // The request after the summary carries the compacted history: the
    // person's turns, then the summary, and no tool result from before.
    const after = t.seen[2]!.messages;
    expect(after.map((m) => m.role)).toEqual(["system", "user", "user", "user"]);
    expect(after[1]!.content).toBe("earlier task");
    expect(after[2]!.content).toBe("big task");
    expect(String(after[3]!.content)).toContain("HANDOFF SUMMARY");
  });

  it("re-appends complete runtime context after compaction instead of the compact update", async () => {
    const t = new ScriptedTransport([
      withUsage(toolCallBody("bash", { command: "ls" }), 5000),
      "</think>HANDOFF SUMMARY",
      withUsage(doneBody("d"), 100),
      withUsage(doneBody("d", { confirm: true }), 100),
    ]);
    await runLoop({ ...base, transport: t, context: "UPDATE ONLY", contextOnRestart: "COMPLETE CONTEXT", compaction: { limitTokens: 4000 } });
    expect(t.seen[0]!.messages.map((m) => m.content)).toContain("UPDATE ONLY");
    const after = t.seen[2]!.messages.map((m) => m.content);
    expect(after).toContain("COMPLETE CONTEXT");
    expect(after).not.toContain("UPDATE ONLY");
  });

  it("carries on with the full transcript when the summary fails", async () => {
    const t = new ScriptedTransport([
      withUsage(toolCallBody("bash", { command: "ls" }), 5000),
      "</think>",
      withUsage(doneBody("d"), 100),
      withUsage(doneBody("d", { confirm: true }), 100),
    ]);
    const notices: string[] = [];
    const r = await runLoop({
      ...base,
      transport: t,
      emit: (e) => {
        if (e.type === "notice") notices.push(e.text);
      },
      compaction: { limitTokens: 4000 },
    });
    expect(r.reason).toBe("done");
    expect(notices.some((n) => n.includes("compaction failed"))).toBe(true);
    // The tool result is still there.
    expect(t.seen[2]!.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("keeps the transcript when the model starts working instead, and compacts on the next turn", async () => {
    const t = new ScriptedTransport([
      withUsage(toolCallBody("bash", { command: "ls" }), 5000),
      {
        content: "Let me check the current state first.",
        rawText: "Let me check the current state first.",
        reasoningContent: "",
        toolCalls: [{ function: { name: "bash", arguments: { command: "git status" } } }],
        ms: 1,
      },
      withUsage(toolCallBody("bash", { command: "pwd" }), 5000),
      "</think>HANDOFF SUMMARY",
      withUsage(doneBody("d"), 100),
      withUsage(doneBody("d", { confirm: true }), 100),
    ]);
    const summaries: string[] = [];
    const notices: string[] = [];
    const executed: string[] = [];
    const r = await runLoop({
      ...base,
      transport: t,
      executor: { run: async (call) => {
        executed.push(String(call.arguments.command));
        return { ok: true, output: "ORIGINAL TOOL RESULT" };
      } },
      emit: (e) => {
        if (e.type === "compaction") summaries.push(e.summary);
        if (e.type === "notice") notices.push(e.text);
      },
      compaction: { limitTokens: 4000 },
    });
    expect(r.reason).toBe("done");
    expect(notices.some((n) => n.includes("called a tool"))).toBe(true);
    expect(summaries).toEqual(["HANDOFF SUMMARY"]);
    expect(executed).toEqual(["ls", "pwd"]);
    // After the refused reply the transcript is whole; after the real summary it is replaced.
    expect(t.seen[2]!.messages).toEqual(t.seen[1]!.messages.slice(0, -1));
    expect(t.seen[2]!.messages.some((m) => m.role === "tool")).toBe(true);
    expect(t.seen[4]!.messages.some((m) => m.role === "tool")).toBe(false);
    expect(String(t.seen[4]!.messages.at(-1)!.content)).toContain("HANDOFF SUMMARY");
  });
});
