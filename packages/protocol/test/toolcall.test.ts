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
  contentLeaksToolCall,
  looksLikeLeakedToolCall,
  parseToolCalls,
  recoverBareToolCall,
  repairBlock,
  repairContext,
  repairInvalidEscapes,
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
    // The backslash survives into the decoded argument, because deleting it
    // turns "suppress expansion" into "expand $HOME" — a different command
    // that still runs.
    block: String.raw`{"name": "run_code", "arguments": {"cmd": "grep -c \$HOME f"}}`,
    expected: { name: "run_code", arguments: { cmd: String.raw`grep -c \$HOME f` } },
  },
  {
    id: "mixed-invalid-escape-and-escaped-backslash",
    // Regex-heavy command mixing an invalid escape (\s) with a valid escaped
    // backslash (\\[). Both survive: `\s` is a character class the model meant
    // to write, and `s` is not.
    block:
      String.raw`{"name": "run_code", "arguments": {"cmd": "m=re.search(r'\"x\"\s*:\s*(\\[.*?\\])', h)"}}`,
    expected: {
      name: "run_code",
      arguments: { cmd: String.raw`m=re.search(r'"x"\s*:\s*(\[.*?\])', h)` },
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
    expect(r.calls[1]!.arguments["cmd"]).toBe(String.raw`grep \$X f`);
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

describe("escape repair preserves meaning", () => {
  /** Decode a repaired block the way the loop does, and read one argument. */
  function cmd(block: string): string | null {
    const obj = repairBlock(block, ctx);
    if (!obj) return null;
    return (obj["arguments"] as Record<string, unknown>)["cmd"] as string;
  }

  it("keeps the backslash that suppresses shell expansion", () => {
    // `echo \$HOME` prints the literal text. Delete the backslash to make the
    // JSON parse and the recovered command prints the user's home directory
    // instead — a different command that still runs, which is worse than one
    // that fails.
    const out = cmd(String.raw`{"name": "run_code", "arguments": {"cmd": "echo \$HOME"}}`);
    expect(out).toBe(String.raw`echo \$HOME`);
  });

  it("keeps regex character classes", () => {
    expect(cmd(String.raw`{"name": "run_code", "arguments": {"cmd": "rg '\s+\d\w'"}}`)).toBe(
      String.raw`rg '\s+\d\w'`,
    );
  });

  it("keeps Windows-style paths", () => {
    expect(cmd(String.raw`{"name": "run_code", "arguments": {"cmd": "type C:\Users\me\a.txt"}}`)).toBe(
      String.raw`type C:\Users\me\a.txt`,
    );
  });

  it("leaves valid escapes exactly as they were", () => {
    const r = repairInvalidEscapes(String.raw`{"a": "tab\there\nline \"q\" \\ \u00e9"}`);
    expect(r.edits).toEqual([]);
    expect(r.ambiguous).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ a: 'tab\there\nline "q" \\ é' });
  });

  it("treats a lone trailing backslash as undecidable", () => {
    // The character after it was lost, so no reading is better than another.
    const r = repairInvalidEscapes('{"a": "ends with \\');
    expect(r.ambiguous).toBe(true);
  });

  it("treats a backslash outside a string as undecidable", () => {
    expect(repairInvalidEscapes('{"a": \\ 1}').ambiguous).toBe(true);
  });

  it("refuses to recover an ambiguous block at all", () => {
    expect(repairBlock('{"name": "run_code", "arguments": {"cmd": "x"} \\ }', ctx)).toBeNull();
  });

  it("records what it rewrote, so a repair can be audited", () => {
    const r = repairInvalidEscapes(String.raw`{"cmd": "\$HOME"}`);
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]).toMatchObject({ from: String.raw`\$`, to: String.raw`\\$` });
  });

  it("round-trips: repaired text decodes to the bytes the model wrote", () => {
    // Property-ish check over the escapes this workload actually produces.
    for (const literal of [
      String.raw`grep -c \$HOME f`,
      String.raw`sed -i 's/\s\+$//' x`,
      String.raw`awk '{print \$1}'`,
      String.raw`C:\Users\me\a.txt`,
      String.raw`\p{L}+`,
    ]) {
      const block = `{"name": "run_code", "arguments": {"cmd": "${literal}"}}`;
      expect(cmd(block), literal).toBe(literal);
    }
  });

  it("cannot recover a backslash that collides with a valid escape", () => {
    // `C:\tmp\new` is not malformed JSON — `\t` and `\n` are real escapes, so
    // the block parses on the first rung and decodes to a tab and a newline.
    // Nothing downstream can tell that apart from a model that meant them, and
    // inventing a rule here would corrupt every genuine `\n` in a patch. The
    // limit is real and belongs in a test rather than in a comment nobody
    // reads.
    const out = cmd(String.raw`{"name": "run_code", "arguments": {"cmd": "C:\tmp\new"}}`);
    expect(out).toBe("C:\tmp\new");
    expect(out).not.toBe(String.raw`C:\tmp\new`);
  });
});

describe("truncation is not the same as a missing tag", () => {
  it("recovers a complete object whose closing tag never arrived", () => {
    const r = parseToolCalls('<tool_call>{"name": "run_code", "arguments": {"cmd": "ls"}}', ctx);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.repair).toMatchObject({ complete: true });
  });

  it("refuses a call whose command string was cut off mid-word", () => {
    // The bracket balancer would close the quote and the braces and hand back
    // `rm -rf /tmp/build-ca`, which is a real command and not the one intended.
    const r = parseToolCalls('<tool_call>{"name": "run_code", "arguments": {"cmd": "rm -rf /tmp/build-ca', ctx);
    expect(r.calls).toHaveLength(0);
    expect(r.truncated).toBe(true);
  });

  it("refuses a call missing only its final brace", () => {
    const r = parseToolCalls('<tool_call>{"name": "run_code", "arguments": {"cmd": "ls"}', ctx);
    expect(r.calls).toHaveLength(0);
  });

  it("marks a bracket-balanced block inside proper tags as incomplete", () => {
    const r = parseToolCalls('<tool_call>{"name": "run_code", "arguments": {"cmd": "ls"}</tool_call>', ctx);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.repair).toMatchObject({ complete: false });
  });
});

describe("a tool call written without its tags", () => {
  // MEASURED on the hosted endpoint: on some turns the model writes the call
  // object straight into the body, no `<tool_call>` wrapper, and the server's
  // parser leaves it in `content` with `tool_calls` empty. That is a dropped
  // call, not an answer, and recovering it is the same job as repairing one
  // inside the tags.
  it("recovers a whole-body object naming a registered tool", () => {
    const call = recoverBareToolCall('{"name": "run_code", "arguments": {"cmd": "ls"}}', ctx);
    expect(call).toMatchObject({ name: "run_code", arguments: { cmd: "ls" }, repaired: true });
    expect(call!.repair).toMatchObject({ kind: "detag" });
  });

  it("recovers through the ladder when the bare object is also malformed", () => {
    const call = recoverBareToolCall('{"name": "search", "arguments": {"queries": ["a", "b"}}', ctx);
    expect(call).toMatchObject({ name: "search", arguments: { queries: ["a", "b"] } });
  });

  it("strips a lone ```json fence around the object", () => {
    const call = recoverBareToolCall('```json\n{"name": "note", "arguments": {"text": "hi"}}\n```', ctx);
    expect(call).toMatchObject({ name: "note", arguments: { text: "hi" } });
  });

  it("does not recover a name that is not a registered tool", () => {
    expect(recoverBareToolCall('{"name": "delete_everything", "arguments": {}}', ctx)).toBeNull();
  });

  it("does not recover a call quoted in the middle of prose", () => {
    // A described call is not a dropped one; running it would be running
    // something the model was only talking about.
    const prose = 'I would call {"name": "run_code", "arguments": {"cmd": "ls"}} but let me check first.';
    expect(recoverBareToolCall(prose, ctx)).toBeNull();
  });

  it("flags an embedded registered-tool object as a leak to re-prompt", () => {
    const prose = 'Here is the plan: {"name": "run_code", "arguments": {"cmd": "ls"}} — proceeding.';
    expect(contentLeaksToolCall(prose, ctx)).toBe(true);
    expect(contentLeaksToolCall("Let me write the file directly:", ctx)).toBe(false);
    expect(contentLeaksToolCall('{"name": "unknown_thing", "arguments": {}}', ctx)).toBe(false);
    expect(contentLeaksToolCall("stray </tool_call> tag", ctx)).toBe(true);
  });
});
