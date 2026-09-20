/**
 * How the model's turn is written back.
 *
 * The bug: on the native channel the assistant turn went into history without
 * its `tool_calls`. Against a server that extracts calls — which is every
 * correctly configured Motif endpoint — the body is empty, so from turn two
 * the model read an empty assistant turn followed by a tool response to a
 * call that was not there.
 */

import { describe, expect, it } from "vitest";
import { getCodec } from "../src/codec.js";
import { repairContext } from "../src/toolcall.js";
import { renderPrompt } from "../src/template.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    },
  },
];
const ctx = repairContext(TOOLS);
const toolcall = getCodec("toolcall");

describe("native channel history", () => {
  it("writes the calls as tool_calls with the ids their results carry", () => {
    const parsed = toolcall.parse(
      { content: "", rawText: "", ms: 1, toolCalls: [{ id: "srv", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      ctx,
    );
    const [msg] = toolcall.serializeAssistant("", "thinking", parsed, [{ id: "root-c1", name: "bash", arguments: { command: "ls" } }]);
    expect(msg).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "thinking",
      tool_calls: [{ id: "root-c1", type: "function", function: { name: "bash", arguments: { command: "ls" } } }],
    });
    const [obs] = toolcall.serializeObservation({ callId: "root-c1", name: "bash", arguments: { command: "ls" }, output: "a.txt", ok: true });
    expect(obs).toEqual({ role: "tool", tool_call_id: "root-c1", content: "a.txt" });
  });

  it("keeps the prose and drops the raw block when the call came as text", () => {
    // Otherwise the template renders the call from `tool_calls` and the model
    // also sees the raw `<tool_call>` text: each action twice.
    const body = 'Listing now.\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const parsed = toolcall.parse({ content: body, rawText: body, ms: 1 }, ctx);
    const [msg] = toolcall.serializeAssistant(body, undefined, parsed, [{ id: "c1", name: "bash", arguments: { command: "ls" } }]);
    expect(msg!.content).toBe("Listing now.");
    expect(msg!.tool_calls).toHaveLength(1);
  });

  it("keeps the whole body when the turn produced no call", () => {
    // A leaked, broken block is exactly what the model needs to see next.
    const body = "<tool_call>{broken";
    const parsed = toolcall.parse({ content: body, rawText: body, ms: 1 }, ctx);
    const [msg] = toolcall.serializeAssistant(body, undefined, parsed);
    expect(msg!.content).toBe(body);
    expect(msg!.tool_calls).toBeUndefined();
  });

  it("renders as a call followed by its response, in the template", () => {
    const parsed = toolcall.parse(
      { content: "", rawText: "", ms: 1, toolCalls: [{ type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      ctx,
    );
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "list" },
      ...toolcall.serializeAssistant("", undefined, parsed, [{ id: "root-c1", name: "bash", arguments: { command: "ls" } }]),
      ...toolcall.serializeObservation({ callId: "root-c1", name: "bash", arguments: { command: "ls" }, output: "a.txt", ok: true }),
    ];
    const text = renderPrompt({ messages, tools: TOOLS, addGenerationPrompt: true });
    const call = text.indexOf('<tool_call>{"name": "bash"');
    const response = text.indexOf('<tool_response>{"tool_call_id": "root-c1"');
    expect(call).toBeGreaterThan(-1);
    expect(response).toBeGreaterThan(call);
  });
});

describe("body channels", () => {
  it("keep the model's text verbatim whatever calls were parsed", () => {
    const object = getCodec("object");
    const body = '{"analysis":"a","plan":"p","commands":[{"keystrokes":"ls\\n","duration":0.1}],"task_complete":false}';
    const parsed = object.parse({ content: body, rawText: body, ms: 1 }, ctx);
    const [msg] = object.serializeAssistant(body, undefined, parsed, [{ id: "c1", name: "term", arguments: {} }]);
    expect(msg).toEqual({ role: "assistant", content: body });
  });
});
