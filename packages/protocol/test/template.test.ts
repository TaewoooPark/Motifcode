/**
 * Byte-fidelity of the TypeScript chat-template renderer.
 *
 * The goldens come from rendering Motif-3's real `chat_template.jinja` through
 * Jinja with transformers' settings — see `toolkit/fixtures/gen_template_golden.py`.
 * A diff of one character here is a prompt-cache miss on every request in
 * production, so these assertions are exact, not fuzzy.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPrompt, sharedPrefixLength, assertRenderableToolCall } from "../src/template.js";
import type { Message, Tool } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = resolve(here, "../../../corpus/template-golden/cases.json");

interface GoldenCase {
  input: {
    messages: Message[];
    tools?: Tool[];
    add_generation_prompt?: boolean;
    enable_thinking?: boolean;
  };
  expected: string;
}

const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Record<string, GoldenCase>;

describe("chat template — byte fidelity vs the real Jinja", () => {
  for (const [name, c] of Object.entries(golden)) {
    it(name, () => {
      const actual = renderPrompt({
        messages: c.input.messages,
        tools: c.input.tools,
        addGenerationPrompt: c.input.add_generation_prompt ?? false,
        enableThinking: c.input.enable_thinking,
      });
      if (actual !== c.expected) {
        const i = sharedPrefixLength(actual, c.expected);
        throw new Error(
          `diverges at char ${i}\n` +
            `  expected: ${JSON.stringify(c.expected.slice(i, i + 60))}\n` +
            `  actual:   ${JSON.stringify(actual.slice(i, i + 60))}`,
        );
      }
      expect(actual).toBe(c.expected);
    });
  }
});

/* ------------------------------------------------------------------ */

const tool = (name: string, props: Record<string, { type: string }>): Tool => ({
  type: "function",
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false },
  },
});

const BASH = tool("bash", { command: { type: "string" } });
const READ = tool("read", { path: { type: "string" } });
const SKILL = tool("skill", { name: { type: "string" } });

const CONV: Message[] = [
  { role: "system", content: "You are motif-code." },
  { role: "user", content: "go" },
];

describe("prefix stability — the reason the tool list is frozen", () => {
  const render = (tools: Tool[]) =>
    renderPrompt({ messages: CONV, tools, addGenerationPrompt: true });

  const base = render([BASH, READ]);

  it("appending a tool keeps a long shared prefix", () => {
    const ratio = sharedPrefixLength(base, render([BASH, READ, SKILL])) / base.length;
    expect(ratio).toBeGreaterThan(0.6);
  });

  it("reordering the same tools destroys the prefix", () => {
    // This is the finding that makes canonical ordering a hard rule rather than
    // a nicety: a tool array built from a Set or an object literal whose key
    // order varies gives a cold cache every process start.
    const ratio = sharedPrefixLength(base, render([READ, BASH])) / base.length;
    expect(ratio).toBeLessThan(0.35);
  });

  it("a canonical-order prefix subset beats an out-of-order subset", () => {
    const full = render([BASH, READ, SKILL]);
    const prefixSubset = sharedPrefixLength(full, render([BASH, READ]));
    const gappySubset = sharedPrefixLength(full, render([BASH, SKILL]));
    expect(prefixSubset).toBeGreaterThan(gappySubset);
  });
});

describe("reasoning continuity", () => {
  const withReasoning: Message[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "", reasoning_content: "AAA" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "", reasoning_content: "BBB" },
    { role: "user", content: "q3" },
  ];

  it("keeps intermediate reasoning when tools are registered", () => {
    const out = renderPrompt({ messages: withReasoning, tools: [BASH], addGenerationPrompt: true });
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
  });

  it("drops intermediate reasoning when no tools are registered", () => {
    // Hence ALWAYS_REGISTER_TOOLS: with an empty tool array the model's own
    // interleaved thinking disappears from its history, which is off the
    // distribution it was trained on.
    const out = renderPrompt({ messages: withReasoning, addGenerationPrompt: true });
    expect(out).not.toContain("AAA");
    expect(out).toContain("BBB");
  });
});

describe("empty-arguments guard", () => {
  it("refuses a tool call the template would render as invalid JSON", () => {
    // The shipped template's `~ null ~` branch produces `"arguments": ,`.
    // Reproducing it faithfully is correct; emitting it is not.
    expect(() => assertRenderableToolCall("noop", {})).toThrow(/empty arguments/);
    expect(() => assertRenderableToolCall("bash", { command: "ls" })).not.toThrow();
  });

  it("still renders the broken form byte-faithfully when asked to", () => {
    const out = renderPrompt({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "", tool_calls: [{ id: "z", function: { name: "noop", arguments: {} } }] },
        { role: "tool", tool_call_id: "z", content: "ok" },
        { role: "user", content: "q2" },
      ],
      tools: [BASH],
      addGenerationPrompt: true,
    });
    expect(out).toContain('{"name": "noop", "arguments": , "id": "z"}');
  });
});
