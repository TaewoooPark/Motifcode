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

  it("refuses an empty summary, and drops a tool call the model made anyway", async () => {
    const empty = new ScriptedTransport(["</think>"]);
    await expect(
      summarizeTranscript({ transport: empty, messages: [{ role: "user", content: "t" }], tools: [] }),
    ).rejects.toThrow(/no summary/);
    const withCall = new ScriptedTransport([`</think>Summary here<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>`]);
    expect(await summarizeTranscript({ transport: withCall, messages: [{ role: "user", content: "t" }], tools: [] })).toBe("Summary here");
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
});
