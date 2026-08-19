/**
 * What each channel actually puts on the wire.
 *
 * The bug this file exists to prevent: choosing a channel used to change the
 * parser and nothing else. The loop told the model to answer in XML and then
 * posted native `messages` and `tools` to `/v1/chat/completions`, parsed the
 * XML it got back, and wrote the result into history as `assistant.tool_calls`
 * plus `role: "tool"` — so from turn two the model was reading a transcript in
 * the format it had been told not to use.
 *
 * Everything here asserts on request bodies and on the second turn's history,
 * because those are the only places the difference is visible.
 */

import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import type { ChannelId, CompletionResponse } from "@motifcode/protocol";
import { ScriptedTransport } from "@motifcode/replay";
import { runLoop, type Executor, type LoopEvent } from "../src/index.js";

const okExecutor: Executor = { run: async () => ({ ok: true, output: "total 0\ndrwxr-xr-x  x" }) };
const sink = (_e: LoopEvent) => {};
const TASK = "list the directory";

function base(channel: ChannelId) {
  return {
    tools: [...CORE_TOOLS],
    system: (ch: ChannelId) => `You are motifcode (${ch}).`,
    userTask: TASK,
    executor: okExecutor,
    emit: sink,
    channel,
  };
}

/**
 * A response body.
 *
 * The `</think>` prefix is not decoration: `add_generation_prompt` ends the
 * prompt with an *open* `<think>`, so every response starts inside the
 * reasoning block and the first marker the model emits is the closing tag.
 */
const body = (text: string): CompletionResponse => {
  const full = `</think>${text}`;
  return { content: full, rawText: full, ms: 1 };
};

/* ------------------------------------------------------------------ */

describe("toolcall channel", () => {
  const call = (o: unknown) => `</think><tool_call>${JSON.stringify(o)}</tool_call>`;

  it("posts native messages and tools to the chat endpoint", async () => {
    const t = new ScriptedTransport([
      body(call({ name: "bash", arguments: { command: "ls" } })),
      body(call({ name: "done", arguments: { summary: "s" } })),
      body(call({ name: "done", arguments: { summary: "s", confirm: true } })),
    ]);
    await runLoop({ ...base("toolcall"), transport: t });
    expect(t.seen[0]!.raw).toBeUndefined();
    expect(t.seen[0]!.prompt).toBeUndefined();
    expect(t.seen[0]!.tools).toHaveLength(CORE_TOOLS.length);
  });

  it("writes observations as role:tool with a matching id", async () => {
    const t = new ScriptedTransport([
      body(call({ name: "bash", arguments: { command: "ls" } })),
      body(call({ name: "done", arguments: { summary: "s" } })),
      body(call({ name: "done", arguments: { summary: "s", confirm: true } })),
    ]);
    await runLoop({ ...base("toolcall"), transport: t });
    const second = t.seen[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(second[3]!.content).toContain("total 0");
  });
});

/* ------------------------------------------------------------------ */

describe("object channel", () => {
  const obj = (o: unknown) => JSON.stringify(o);

  it("posts a locally rendered prompt to the completions endpoint", async () => {
    const t = new ScriptedTransport([
      body(obj({ analysis: "a", commands: [{ keystrokes: "ls\n", duration: 0.5 }] })),
      body(obj({ task_complete: true, summary: "s" })),
      body(obj({ task_complete: true, summary: "s", confirm: true })),
    ]);
    await runLoop({ ...base("object"), transport: t });
    const first = t.seen[0]!;
    expect(first.raw).toBe(true);
    expect(typeof first.prompt).toBe("string");
    // The rendered prompt is the request body, so the task is in it verbatim.
    expect(first.prompt).toContain(TASK);
    expect(first.stop).toBeDefined();
    // Tools are still registered: with an empty array the template drops the
    // reasoning of every intermediate assistant turn.
    expect(first.tools).toHaveLength(CORE_TOOLS.length);
  });

  it("keeps the model's JSON verbatim and answers as a user turn", async () => {
    const body1 = obj({ analysis: "looking", commands: [{ keystrokes: "ls\n", duration: 0.5 }] });
    const t = new ScriptedTransport([
      body(body1),
      body(obj({ task_complete: true, summary: "s" })),
      body(obj({ task_complete: true, summary: "s", confirm: true })),
    ]);
    await runLoop({ ...base("object"), transport: t });
    const second = t.seen[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    // Verbatim, key order included — the parsed actions are a reading of this
    // text, not a replacement for it.
    expect(second[2]!.content).toBe(body1);
    expect(second[2]!.tool_calls).toBeUndefined();
    expect(String(second[3]!.content)).toContain("total 0");
  });

  it("never produces a role:tool message", async () => {
    const t = new ScriptedTransport([
      body(obj({ commands: [{ keystrokes: "ls\n", duration: 0.5 }] })),
      body(obj({ task_complete: true, summary: "s" })),
      body(obj({ task_complete: true, summary: "s", confirm: true })),
    ]);
    await runLoop({ ...base("object"), transport: t });
    for (const req of t.seen) {
      expect(req.messages.some((m) => m.role === "tool")).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("raw channel", () => {
  const xml = (inner: string) => `<response>${inner}</response>`;

  it("posts a locally rendered prompt and keeps the XML verbatim", async () => {
    // Backslashes, angle brackets and ampersands on purpose: this channel
    // exists to avoid escaping, so escaping them here would defeat it.
    const command = String.raw`rg '\s+<a> & "b"' .`;
    const turn1 = xml(`<commands><keystrokes duration="0.1">${command}</keystrokes></commands>`);
    const t = new ScriptedTransport([
      body(turn1),
      body(xml("<task_complete>true</task_complete><summary>s</summary>")),
      body(xml("<task_complete>true</task_complete><summary>s</summary><confirm>true</confirm>")),
    ]);
    await runLoop({ ...base("raw"), transport: t });

    expect(t.seen[0]!.raw).toBe(true);
    const second = t.seen[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second[2]!.content).toBe(turn1);
    expect(String(second[2]!.content)).toContain(command);
    expect(String(second[3]!.content)).toContain("<terminal>");
  });

  it("renders the prompt the same bytes it sends", async () => {
    const t = new ScriptedTransport([
      body(xml("<task_complete>true</task_complete><summary>s</summary>")),
      body(xml("<task_complete>true</task_complete><summary>s</summary><confirm>true</confirm>")),
    ]);
    await runLoop({ ...base("raw"), transport: t });
    // Turn two's prompt is turn one's prompt plus the new turns: append-only,
    // which is what the prefix statistic assumes.
    expect(t.seen[1]!.prompt!.startsWith(t.seen[0]!.prompt!.slice(0, 200))).toBe(true);
  });
});
