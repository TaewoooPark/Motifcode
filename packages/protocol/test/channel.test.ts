/**
 * Action channels.
 *
 * Each channel turns a different response shape into the same `Action[]`. The
 * cases here are the ones where a channel used to produce an action that looked
 * ordinary and meant something else — or threw out of the parser entirely,
 * which the loop had no way to read as a parse failure.
 */

import { describe, expect, it } from "vitest";
import { getChannel } from "../src/channel.js";
import { repairContext } from "../src/toolcall.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "term",
      parameters: {
        type: "object",
        properties: { keystrokes: { type: "string" }, duration_s: { type: "number" } },
        required: ["keystrokes", "duration_s"],
        additionalProperties: false,
      },
    },
  },
];
const ctx = repairContext(TOOLS);

const object = getChannel("object");
const raw = getChannel("raw");
const toolcall = getChannel("toolcall");

describe("object channel", () => {
  it("turns commands into term actions", () => {
    const r = object.parse('{"analysis":"a","commands":[{"keystrokes":"ls\\n","duration":0.5}]}', ctx);
    expect(r.actions).toEqual([
      { kind: "tool", name: "term", arguments: { keystrokes: "ls\n", duration_s: 0.5 }, repaired: false },
    ]);
  });

  for (const bad of ['"go"', "null", '{"0":{"keystrokes":"ls"}}', "42"]) {
    it(`reports commands: ${bad} as a shape error rather than throwing`, () => {
      // Iterating a non-array threw a TypeError out of the parser, which is not
      // something the loop can turn into a repair prompt.
      const r = object.parse(`{"commands":${bad}}`, ctx);
      expect(r.actions).toEqual([]);
      expect(r.invalidArguments?.length).toBeGreaterThan(0);
    });
  }

  it("reports a command entry that is not an object", () => {
    const r = object.parse('{"commands":["ls -la"]}', ctx);
    expect(r.actions).toEqual([]);
    expect(r.invalidArguments?.length).toBe(1);
  });

  it("passes a wrong-typed duration through for the validator to reject", () => {
    // Coercing it here would hide a schema violation behind a plausible number.
    const r = object.parse('{"commands":[{"keystrokes":"ls\\n","duration":"soon"}]}', ctx);
    expect(r.actions[0]).toMatchObject({ arguments: { duration_s: "soon" } });
  });

  it("carries the confirmation flag on completion", () => {
    const proposal = object.parse('{"task_complete":true,"summary":"s"}', ctx);
    expect(proposal.actions[0]).toEqual({ kind: "done", summary: "s" });
    const confirmed = object.parse('{"task_complete":true,"summary":"s","confirm":true}', ctx);
    expect(confirmed.actions[0]).toEqual({ kind: "done", summary: "s", confirm: true });
  });
});

describe("raw channel", () => {
  it("keeps keystroke bodies verbatim", () => {
    const body = String.raw`rg '\s+' && echo "<a> & b"`;
    const r = raw.parse(`<response><commands><keystrokes duration="0.1">${body}</keystrokes></commands></response>`, ctx);
    expect(r.actions[0]).toMatchObject({ arguments: { keystrokes: body } });
  });

  it("carries the confirmation flag on completion", () => {
    const proposal = raw.parse("<response><task_complete>true</task_complete><summary>s</summary></response>", ctx);
    expect(proposal.actions[0]).toEqual({ kind: "done", summary: "s" });
    const confirmed = raw.parse(
      "<response><task_complete>true</task_complete><summary>s</summary><confirm>true</confirm></response>",
      ctx,
    );
    expect(confirmed.actions[0]).toEqual({ kind: "done", summary: "s", confirm: true });
  });
});

describe("server-extracted calls", () => {
  it("reports a call whose arguments did not decode instead of emptying them", () => {
    // "We still know which tool was meant" turns a broken bash call into bash
    // with an empty command, and a broken done into a completion claim.
    for (const channel of [toolcall, object, raw]) {
      const r = channel.parse("", ctx, [
        { id: "s1", type: "function", function: { name: "term", arguments: "{not json" } },
      ]);
      expect(r.actions, channel.id).toEqual([]);
      expect(r.invalidArguments?.length, channel.id).toBe(1);
    }
  });

  it("keeps the good calls in a batch and reports only the broken one", () => {
    const r = toolcall.parse("", ctx, [
      { id: "a", type: "function", function: { name: "term", arguments: '{"keystrokes":"ls\\n","duration_s":1}' } },
      { id: "b", type: "function", function: { name: "term", arguments: "{broken" } },
    ]);
    expect(r.actions).toHaveLength(1);
    expect(r.invalidArguments).toHaveLength(1);
  });

  it("carries the confirmation flag through the server path", () => {
    const r = toolcall.parse("", ctx, [
      { id: "a", type: "function", function: { name: "done", arguments: '{"summary":"s","confirm":true}' } },
    ]);
    expect(r.actions[0]).toEqual({ kind: "done", summary: "s", confirm: true });
  });
});
