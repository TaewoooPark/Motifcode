/**
 * Golden corpus for the tool-call repair ladder.
 *
 * Ported from `tests/tool_parsers/test_motif_tool_parser.py` in the Motif vLLM
 * fork. These are not synthetic: the fork's own comments mark several of them
 * as "observed live on the 20260708 snapshots". They are the closest thing to
 * a ground-truth sample of how this model breaks, and every one of them must
 * pass before a change to the ladder can land.
 */

import { describe, expect, it } from "vitest";
import {
  looksLikeLeakedToolCall,
  parseToolCalls,
  repairBlock,
  repairContext,
} from "../src/toolcall.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "search",
      parameters: {
        type: "object",
        properties: { queries: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch",
      parameters: {
        type: "object",
        properties: { urls: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "note",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
];

const ctx = repairContext(TOOLS);

interface Case {
  id: string;
  block: string;
  expected: { name: string; arguments: Record<string, unknown> };
}

const CASES: Case[] = [
  {
    id: "missing-close-bracket",
    block: '{"name": "search", "arguments": {"queries": ["a", "b"}}',
    expected: { name: "search", arguments: { queries: ["a", "b"] } },
  },
  {
    id: "missing-open-bracket",
    block: '{"name": "search", "arguments": {"queries": "q one", "q two"}}',
    expected: { name: "search", arguments: { queries: ["q one", "q two"] } },
  },
  {
    id: "missing-open-bracket-with-trailing-close",
    block: '{"name": "search", "arguments": {"queries": "a", "b"]}}',
    expected: { name: "search", arguments: { queries: ["a", "b"] } },
  },
  {
    id: "duplicated-close-bracket",
    block: '{"name": "search", "arguments": {"queries": ["a"]]}}',
    expected: { name: "search", arguments: { queries: ["a"] } },
  },
  {
    id: "unescaped-inner-quotes",
    block: '{"name": "search", "arguments": {"queries": ["the "best" one"]}}',
    expected: { name: "search", arguments: { queries: ['the "best" one'] } },
  },
  {
    id: "invalid-json-escape",
    // Shell expansion inside a command argument: `\$` is not a JSON escape.
    block: String.raw`{"name": "run_code", "arguments": {"cmd": "grep -c \$HOME f"}}`,
    expected: { name: "run_code", arguments: { cmd: "grep -c $HOME f" } },
  },
  {
    id: "mixed-invalid-escape-and-escaped-backslash",
    // Regex-heavy command mixing an invalid escape (\s) with a valid escaped
    // backslash (\\[). Dropping lone backslashes must consume left to right so
    // the valid pair survives.
    block:
      String.raw`{"name": "run_code", "arguments": {"cmd": "m=re.search(r'\"x\"\s*:\s*(\\[.*?\\])', h)"}}`,
    expected: {
      name: "run_code",
      arguments: { cmd: String.raw`m=re.search(r'"x"s*:s*(\[.*?\])', h)` },
    },
  },
  {
    id: "extra-trailing-braces",
    block: '{"name": "fetch", "arguments": {"urls": ["http://x"]}}}}',
    expected: { name: "fetch", arguments: { urls: ["http://x"] } },
  },
  {
    id: "flat-arguments-wrapper",
    block: '{"name": "fetch", "urls": ["http://x"]}',
    expected: { name: "fetch", arguments: { urls: ["http://x"] } },
  },
  {
    id: "raw-control-char-in-string",
    block: '{"name": "note", "arguments": {"text": "line1\nline2"}}',
    expected: { name: "note", arguments: { text: "line1\nline2" } },
  },
  {
    id: "json-lookalike-content-in-string",
    // The local close-on-structural rule mis-closes at `"@type":`, so only the
    // backtracking search plus the schema oracle recovers this one.
    block: '{"name": "run_code", "arguments": {"cmd": "echo "@type":"x", done"}}',
    expected: { name: "run_code", arguments: { cmd: 'echo "@type":"x", done' } },
  },
];

describe("repair ladder", () => {
  for (const c of CASES) {
    it(c.id, () => {
      const obj = repairBlock(c.block, ctx);
      expect(obj, `unrecoverable: ${c.block}`).not.toBeNull();
      expect(obj!["name"]).toBe(c.expected.name);
      expect(obj!["arguments"]).toEqual(c.expected.arguments);
    });
  }

  it("leaves already-valid JSON untouched", () => {
    const block = '{"name": "run_code", "arguments": {"cmd": "ls"}}';
    expect(repairBlock(block, ctx)).toEqual({ name: "run_code", arguments: { cmd: "ls" } });
  });

  it("returns null for genuinely unrecoverable input", () => {
    expect(repairBlock("this is not json at all <<<", ctx)).toBeNull();
  });

  it("uses the schema oracle to reject invented argument keys", () => {
    // `@type` is not declared by any tool, so a candidate reading that invents
    // it must lose to the reading that keeps it as string content.
    const obj = repairBlock('{"name": "run_code", "arguments": {"cmd": "echo "@type":"x""}}', ctx);
    expect(obj).not.toBeNull();
    expect(Object.keys(obj!["arguments"] as object)).toEqual(["cmd"]);
  });
});

describe("parseToolCalls", () => {
  it("separates prose from calls", () => {
    const text = 'Let me look.\n<tool_call>{"name": "run_code", "arguments": {"cmd": "ls"}}</tool_call>';
    const r = parseToolCalls(text, ctx);
    expect(r.content.trim()).toBe("Let me look.");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.repaired).toBe(false);
  });

  it("repairs one malformed block among several", () => {
    const text =
      '<tool_call>{"name": "run_code", "arguments": {"cmd": "ls"}}</tool_call>' +
      String.raw`<tool_call>{"name": "run_code", "arguments": {"cmd": "grep \$X f"}}</tool_call>`;
    const r = parseToolCalls(text, ctx);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]!.repaired).toBe(false);
    expect(r.calls[1]!.repaired).toBe(true);
    expect(r.calls[1]!.arguments["cmd"]).toBe("grep $X f");
  });

  it("recovers a trailing block whose closer never arrived", () => {
    const text = '<tool_call>{"name": "run_code", "arguments": {"cmd": "ls"}}';
    const r = parseToolCalls(text, ctx);
    expect(r.calls).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it("flags a leaked tool call rather than calling it a final answer", () => {
    // The exact failure the vendor's parser comments describe: an unrecoverable
    // block leaves tool syntax in `content`, and a naive harness stops here.
    const text = '<tool_call>{"name": ??? garbage</tool_call>';
    const r = parseToolCalls(text, ctx);
    expect(r.calls).toHaveLength(0);
    expect(looksLikeLeakedToolCall(r)).toBe(true);
  });

  it("does not flag ordinary prose", () => {
    const r = parseToolCalls("All done, the tests pass.", ctx);
    expect(looksLikeLeakedToolCall(r)).toBe(false);
  });
});
