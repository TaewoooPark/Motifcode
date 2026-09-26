/**
 * Screen rendering, held to snapshots.
 *
 * A TUI checked only by eye breaks quietly on every refactor, so the render
 * path is pure and its output is committed. Codex keeps 125 of these; this is
 * the same bargain at a smaller scale.
 *
 * The session below is not decorative. It walks the failure modes this harness
 * exists to handle — a repaired tool call, an unrecoverable parse, a channel
 * downgrade, a repair turn — so the snapshot is also a readable record of what
 * those look like to a user.
 */

import { describe, expect, it } from "vitest";
import type { LoopEvent } from "@motifcode/core";
import {
  initialState,
  pushUser,
  reduce,
  renderTail,
  renderCell,
  renderCellStyled,
  sanitize,
  wrapToWidth,
  renderTranscript,
  statusLine,
  readings,
  fmtBytes,
  pickHero,
  heroLines,
  HERO_WIDTH,
  StreamSplitter,
  CommitTracker,
  displayWidth,
  truncateToWidth,
  truncateEndToWidth,
  settledCount,
  renderSettled,
  renderPending,
  type Cell,
  type ViewState,
} from "../src/index.js";

function fold(events: LoopEvent[], seed?: ViewState): ViewState {
  let s = seed ?? initialState();
  for (const e of events) s = reduce(s, e);
  return s;
}

const SESSION: LoopEvent[] = [
  {
    type: "session_start",
    model: "Motif-3-Coder-A13B",
    endpoint: "http://zgx-1c3b:8080",
    channel: "toolcall",
    tools: ["done", "bash", "read", "apply_patch", "term", "skill", "task", "mcp"],
    toolsHash: "9f3c1a20",
  },
  { type: "turn_start", turn: 1 },
  { type: "prefix", sharedChars: 0, totalChars: 4200 },
  { type: "reasoning_delta", text: "forward/reverse를 나눠 피팅해야 하는데 지금은 합쳐서 돌고 있다" },
  { type: "reasoning_end", chars: 42, ms: 12400 },
  { type: "usage", contextTokens: 4700, kvBytes: 287_000_000, promptTokens: 4700, completionTokens: 274, requestMs: 10_000 },
  {
    type: "tool_start",
    call: { id: "c1", name: "bash", arguments: { command: "rg -n 'ohe_subtract' hallbar/backend/" }, repaired: false, validated: true },
  },
  {
    type: "tool_end",
    id: "c1",
    ok: true,
    output: "hallbar/backend/ohe_subtraction.py:41  def ohe_subtract(rxy, field, ...)",
    ms: 84,
  },
  { type: "turn_start", turn: 2 },
  { type: "prefix", sharedChars: 4100, totalChars: 4400 },
  {
    type: "tool_start",
    // Repaired: the model wrote a shell variable inside a JSON string.
    call: { id: "c2", name: "apply_patch", arguments: { patch: "--- a/ohe_subtraction.py\n+++ b/ohe_subtraction.py" }, repaired: true, validated: true },
  },
  { type: "tool_end", id: "c2", ok: false, output: "test_ohe.py: 2 failed", ms: 1900 },
  { type: "hook", event: "PostToolUse", label: "fmt", ok: true },
  { type: "repair", kind: "tool_failure", reason: "tool failure", attempt: 1, max: 2 },
  { type: "turn_start", turn: 3 },
  { type: "parse_failure", kind: "unrecoverable", sample: '{"name": "bash", "arguments": {"command": "grep -c \\$HOME' },
  { type: "parse_failure", kind: "leaked", sample: "<tool_call>{ ??? " },
  { type: "channel_downgrade", from: "toolcall", to: "object", reason: "2 consecutive parse failures" },
  { type: "queue", agent: "reviewer", state: "queued" },
  { type: "session_end", reason: "done", summary: "OHE 배경 제거를 sweep 방향별로 분리했습니다." },
];

const OPTS = { width: 72 };

describe("transcript", () => {
  it("renders a full session", () => {
    const state = pushUser(initialState(), "hallbar 백엔드에서 OHE 배경 제거가 역방향 스윕에서 안 먹어");
    const out = renderTranscript(fold(SESSION, state), OPTS);
    expect(out.join("\n")).toMatchSnapshot();
  });

  it("hides reasoning by default and shows it in full on request", () => {
    // This model opens a thinking block on every generation. Shown by default
    // it would bury the conversation; shown on request it is the debugging
    // view, and then nothing of it is cut.
    const state = fold(SESSION.slice(0, 5));
    const hidden = renderTranscript(state, OPTS).join("\n");
    const shown = renderTranscript(state, { ...OPTS, showThinking: true }).join("\n");
    expect(hidden).not.toContain("forward/reverse");
    expect(hidden).not.toContain("Thought");
    expect(shown).toContain("✻ Thought for 12.4s");
    expect(shown).toContain("forward/reverse");
  });

  it("echoes the user's line after a prompt mark and the model's behind a bullet", () => {
    const state = pushUser(initialState(), "안녕?");
    const out = renderTranscript(fold([{ type: "content_delta", text: "안녕하세요!\n무엇을 도와드릴까요?" }], state), OPTS);
    expect(out[0]).toBe("> 안녕?");
    expect(out).toContain("⏺ 안녕하세요!");
    expect(out).toContain("  무엇을 도와드릴까요?");
  });

  it("renders the little Markdown a terminal can show", () => {
    const text = "# Plan\nDo these:\n- first\n- second\n```py\nprint(1)\n```\ndone";
    const state = fold([{ type: "content_delta", text }]);
    const out = renderTranscript(state, OPTS);
    expect(out[0]).toBe("⏺ Plan");
    expect(out).toContain("  • first");
    expect(out).toContain("  ```py");
    expect(out).toContain("  print(1)");
    expect(out).toContain("  done");
  });

  it("shows a patch as a diff, whatever it did", () => {
    const patch = "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n";
    const state = fold([
      { type: "tool_start", call: { id: "p", name: "apply_patch", arguments: { patch }, repaired: false, validated: true } },
      { type: "tool_end", id: "p", ok: true, output: "applied", ms: 3 },
    ]);
    const out = renderTranscript(state, { ...OPTS, outputLines: Infinity });
    expect(out[0]).toBe("⏺ Patch(--- a/x.py…)");
    expect(out).toContain("     -old");
    expect(out).toContain("     +new");
    expect(out).toContain("  ⎿  applied");
  });

  it("shows paths under the working directory relative to it", () => {
    const state = fold([
      { type: "tool_start", call: { id: "w", name: "write", arguments: { content: "x", path: "/work/repo/src/a.ts" }, repaired: false, validated: true } },
      { type: "tool_end", id: "w", ok: true, output: "created /work/repo/src/a.ts (1 lines, 1 bytes)", ms: 1 },
      { type: "tool_start", call: { id: "b", name: "bash", arguments: { command: "cd /work/repo && ls /work/repo/src" }, repaired: false, validated: true } },
      { type: "tool_end", id: "b", ok: true, output: "a.ts", ms: 1 },
    ]);
    const out = renderTranscript(state, { ...OPTS, cwd: "/work/repo" });
    expect(out).toContain("⏺ Write(src/a.ts)");
    expect(out).toContain("⏺ Bash(ls src)");
  });

  it("shows a tool as its title, its argument, and what came back under a corner", () => {
    const state = fold([
      { type: "tool_start", call: { id: "x", name: "bash", arguments: { command: "ls -la" }, repaired: false, validated: true } },
      { type: "tool_end", id: "x", ok: true, output: "total 8\na.txt", ms: 5 },
    ]);
    const out = renderTranscript(state, OPTS);
    expect(out[0]).toBe("⏺ Bash(ls -la)");
    expect(out[1]).toBe("  ⎿  total 8");
    expect(out[2]).toBe("     a.txt");
  });

  it("summarises a read as a line count and a failure as an error", () => {
    // The model read it; the person does not need it dumped again.
    const read = fold([
      { type: "tool_start", call: { id: "r", name: "read", arguments: { path: "calc.py" }, repaired: false, validated: true } },
      { type: "tool_end", id: "r", ok: true, output: "1\tdef add():\n2\t    pass\n", ms: 1 },
    ]);
    expect(renderTranscript(read, OPTS).join("\n")).toContain("⎿  Read 2 lines");
    const failed = fold([
      { type: "tool_start", call: { id: "f", name: "bash", arguments: { command: "python x" }, repaired: false, validated: true } },
      { type: "tool_end", id: "f", ok: false, output: "/bin/sh: python: command not found", ms: 1 },
    ]);
    expect(renderTranscript(failed, OPTS).join("\n")).toContain("⎿  Error: /bin/sh: python: command not found");
  });

  it("gives the repair turn its own visible line", () => {
    // Without this the loop reads as flailing; with it, a designed recovery is
    // visibly running — which matters more when the model has been pruned.
    const out = renderTranscript(fold(SESSION), OPTS).join("\n");
    expect(out).toContain("↻ repair 1/2");
  });

  it("ends a done session with its summary and any other ending with why", () => {
    const done = renderTranscript(fold([{ type: "session_end", reason: "done", summary: "all green" }]), OPTS);
    expect(done[0]).toBe("⏺ all green");
    const aborted = renderTranscript(fold([{ type: "session_end", reason: "aborted" }]), OPTS);
    expect(aborted[0]).toBe("  ⎿  Interrupted");
  });

  it("marks a repaired tool call", () => {
    const out = renderTranscript(fold(SESSION), OPTS).join("\n");
    expect(out).toContain("repaired");
  });

  it("shows the channel downgrade and why", () => {
    const out = renderTranscript(fold(SESSION), OPTS).join("\n");
    expect(out).toContain("toolcall → object");
    expect(out).toContain("2 consecutive parse failures");
  });

  it("clips long tool output rather than flooding the screen", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const state = fold([
      { type: "tool_start", call: { id: "x", name: "bash", arguments: { command: "ls" }, repaired: false, validated: true } },
      { type: "tool_end", id: "x", ok: true, output: long, ms: 5 },
    ]);
    const out = renderTranscript(state, OPTS).join("\n");
    expect(out).toMatch(/\+\d+ lines/);
    expect(out.split("\n").length).toBeLessThan(20);
  });
});

describe("tool output previews", () => {
  function tool(output: string, name = "mcp", ok = true, args: Record<string, unknown> = { server: "fixture" }): Extract<Cell, { kind: "tool" }> {
    return fold([
      { type: "tool_start", call: { id: "t", name, arguments: args, repaired: false, validated: true } },
      { type: "tool_end", id: "t", ok, output, ms: 1 },
    ]).cells[0] as Extract<Cell, { kind: "tool" }>;
  }

  it("bounds one huge JSON line to three decorated physical rows without changing the original", () => {
    const output = JSON.stringify({ content: "한글🙂".repeat(1200), tail: "ORIGINAL_END" });
    const cell = deepFreeze(tool(output)) as Extract<Cell, { kind: "tool" }>;
    const rows = wrapToWidth(`  ⎿  ${output}`, 40);
    const collapsed = renderCell(cell, { width: 40, showShortcuts: true });
    expect(collapsed).toHaveLength(6); // head, 3 preview rows, notice, blank
    expect(collapsed.slice(1, 4)).toEqual(rows.slice(0, 3));
    expect(collapsed[4]).toContain(`+${rows.length - 3} lines`);
    expect(collapsed[4]).toContain("ctrl-o");
    expect(collapsed.every((row) => displayWidth(row) <= 40)).toBe(true);
    const expanded = renderCell(cell, { width: 40, outputLines: Infinity });
    expect(expanded.slice(1, -1)).toEqual(rows);
    expect(expanded.join("")).toContain("ORIGINAL_END");
    expect(cell.output).toBe(output);
  });

  it("counts error decoration and multiline wrapping before clipping, and preserves error tones", () => {
    const output = "12345678901234567890\nsecond line\nthird line\nlast";
    const cell = tool(output, "bash", false);
    const expected = ["  ⎿  Error: 12345678901234567890", "     second line", "     third line", "     last"]
      .flatMap((row) => wrapToWidth(row, 24));
    const shown = renderCellStyled(cell, { width: 24, showShortcuts: true });
    expect(shown.slice(1, 4)).toEqual(expected.slice(0, 3).map((text) => ({ text, tone: "bad" })));
    expect(shown[4]?.text).toContain(`+${expected.length - 3} lines`);
    expect(shown[4]?.text).toContain("ctrl-o");
    expect(renderCell(cell, { width: 24, outputLines: Infinity }).slice(1, -1)).toEqual(expected);
  });

  it("budgets visible control escapes, tabs and wide glyphs even at one column", () => {
    const output = "\x1b[31m\t한글🙂\rTAIL\n".repeat(8) + "END\r";
    const cell = tool(output, "한글도구", false, { command: "\x1b[2J\t한글" });
    for (const width of [1, 2, 5, 12, 40]) {
      const preview = renderCell(cell, { width, showShortcuts: true });
      expect(preview).toHaveLength(6);
      expect(preview.every((row) => displayWidth(row) <= width), String(width)).toBe(true);
      const full = renderCell(cell, { width, outputLines: Infinity });
      expect(full.every((row) => displayWidth(row) <= width), String(width)).toBe(true);
      expect(full.join("")).not.toMatch(/[\x1b\r\t]/);
      expect(full.join("")).toContain("^[[31m");
      expect(full.join("")).toContain("END^M");
    }
    expect(cell.output).toBe(output);
    expect(sanitize(output)).toContain("^MTAIL");
  });

  it.each(["read", "mcp"])("expands every %s output line beyond the former 1000-line cap", (name) => {
    const output = Array.from({ length: 1205 }, (_, i) => `ROW_${i}`).join("\n");
    const cell = tool(output, name);
    const compact = renderCell(cell, { width: 72, showShortcuts: true });
    expect(compact.join("\n")).not.toContain("ROW_1204");
    expect(compact.join("\n")).toContain("ctrl-o");
    if (name === "read") expect(compact.join("\n")).toContain("Read 1205 lines");
    const full = renderCell(cell, { width: 72, outputLines: Infinity, showShortcuts: true });
    expect(full).toHaveLength(1207);
    expect(full[1]).toBe("  ⎿  ROW_0");
    expect(full.at(-2)).toBe("     ROW_1204");
    expect(full.join("\n")).not.toContain("ctrl-o");
    expect(cell.output).toBe(output);
  });

  it("bounds a wrapped diff separately from its failure, and expands all colored diff rows", () => {
    const patch = "+" + "가".repeat(100) + "\n-removed\n+FINAL_PATCH_LINE";
    const cell = deepFreeze(tool("patch failed", "apply_patch", false, { patch })) as Extract<Cell, { kind: "tool" }>;
    const preview = renderCell(cell, { width: 40, showShortcuts: true });
    expect(preview).toHaveLength(7); // head, 3 diff rows, notice, error, blank
    expect(preview[4]).toContain("ctrl-o");
    expect(preview).toContain("  ⎿  Error: patch failed");
    expect(preview.join("\n")).not.toContain("FINAL_PATCH_LINE");
    const full = renderCellStyled(cell, { width: 40, outputLines: Infinity });
    expect(full.find((row) => row.text.includes("-removed"))?.tone).toBe("bad");
    expect(full.find((row) => row.text.includes("+FINAL_PATCH_LINE"))?.tone).toBe("ok");
    expect(full.slice(1, 4).every((row) => row.tone === "ok")).toBe(true);
    expect(cell.args["patch"]).toBe(patch);
  });

  it("honors a finite preview override and never advertises inactive keyboard shortcuts", () => {
    const cell = tool(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
    const preview = renderCell(cell, { width: 72, outputLines: 6 });
    expect(preview).toHaveLength(9);
    expect(preview[7]).toContain("+4 lines");
    expect(preview.join("\n")).not.toContain("ctrl-o");
    expect(renderCell(tool("one\ntwo", "read"), { width: 72 }).join("\n")).not.toContain("ctrl-o");
    expect(renderCell(tool("one\ntwo"), { width: 72, showShortcuts: true })).toEqual([
      "⏺ MCP(fixture)", "  ⎿  one", "     two", "",
    ]);
  });
});

describe("live tail", () => {
  it("shows only the newest reasoning line, and only when reasoning is shown", () => {
    const state = fold([
      { type: "reasoning_delta", text: "first line\nsecond line\nthird line" },
    ]);
    expect(renderTail(state, OPTS)).toHaveLength(0);
    const tail = renderTail(state, { ...OPTS, showThinking: true });
    expect(tail).toHaveLength(1);
    expect(tail[0]).toContain("third line");
    expect(tail[0]).not.toContain("first line");
  });

  it("shows the reply as it streams, and hands it over to the cell when it lands", () => {
    const streaming = fold([
      { type: "turn_start", turn: 1 },
      { type: "stream", content: "Hello " },
      { type: "stream", content: "there\nsecond" },
    ]);
    expect(renderTail(streaming, OPTS)).toEqual(["⏺ Hello there", "  second"]);
    const landed = fold([{ type: "content_delta", text: "Hello there\nsecond" }], streaming);
    expect(renderTail(landed, OPTS)).toEqual([]);
    expect(renderTranscript(landed, OPTS)).toContain("⏺ Hello there");
  });

  it("keeps streamed reasoning out of the tail when reasoning is hidden", () => {
    const state = fold([{ type: "stream", reasoning: "secret plan" }]);
    expect(renderTail(state, OPTS)).toEqual([]);
    expect(renderTail(state, { ...OPTS, showThinking: true })[0]).toContain("secret plan");
  });

  it("is empty once reasoning closes", () => {
    const state = fold([
      { type: "reasoning_delta", text: "thinking" },
      { type: "reasoning_end", chars: 8, ms: 100 },
    ]);
    expect(renderTail(state, OPTS)).toHaveLength(0);
  });
});

describe("instruments", () => {
  it("shows the server's cached-token count beside the prefix overlap", () => {
    // The percentage is textual overlap computed here; the count is the
    // endpoint's own claim, and appears only once an endpoint has made one.
    const before = fold(SESSION);
    expect(readings(before.instruments).find((r) => r.label === "prefix")!.value).not.toContain("cached");
    const after = reduce(before, {
      type: "usage",
      contextTokens: 4700,
      kvBytes: 1,
      promptTokens: 4700,
      completionTokens: 10,
      cachedTokens: 4000,
      requestMs: 100,
    });
    expect(readings(after.instruments).find((r) => r.label === "prefix")!.value).toContain("cached 4K");
  });

  it("reports the local-only readings", () => {
    const state = fold(SESSION);
    expect(statusLine(state.instruments)).toMatchSnapshot();
  });

  it("flags a poor prefix hit rate", () => {
    // No hosted API reports this. Locally it is both knowable and actionable,
    // because a bad number almost always means the tool list changed.
    const state = fold([{ type: "prefix", sharedChars: 100, totalChars: 4000 }]);
    const prefix = readings(state.instruments).find((r) => r.label === "prefix")!;
    expect(prefix.severity).toBe("bad");
    expect(prefix.value).toContain("✗");
  });

  it("flags a high parse-failure rate", () => {
    let state = initialState();
    for (let i = 0; i < 8; i++) state = reduce(state, { type: "turn_start", turn: i + 1 });
    for (let i = 0; i < 4; i++) {
      state = reduce(state, { type: "parse_failure", kind: "unrecoverable", sample: "" });
    }
    const parse = readings(state.instruments).find((r) => r.label === "parse")!;
    expect(parse.severity).toBe("bad");
  });

  it("formats KV bytes", () => {
    expect(fmtBytes(2_900_000_000)).toBe("2.9GB");
    expect(fmtBytes(287_000_000)).toBe("287MB");
  });
});

describe("hero", () => {
  it("picks by terminal width", () => {
    expect(pickHero(120)).toBe("large");
    expect(pickHero(80)).toBe("small");
    expect(pickHero(80, true)).toBe("shaded");
    expect(pickHero(30)).toBe("none");
  });

  it("never exceeds its declared width", () => {
    // Every glyph is East-Asian narrow, so character length equals column
    // width in any monospace terminal.
    for (const [variant, width] of Object.entries(HERO_WIDTH)) {
      for (const line of heroLines(variant as "large" | "small" | "shaded")) {
        expect(line.length, `${variant}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("renders the large hero", () => {
    expect(heroLines("large").join("\n")).toMatchSnapshot();
  });
});

describe("two-region streaming", () => {
  it("holds the last line back while it may still grow", () => {
    const s = new StreamSplitter();
    s.push("alpha\nbeta\ngam");
    const { stable, tail } = s.split();
    expect(stable).toEqual(["alpha", "beta"]);
    expect(tail).toEqual(["gam"]);
  });

  it("holds an unterminated code fence entirely", () => {
    const s = new StreamSplitter();
    s.push("intro\n```py\nx = 1\ny = 2");
    const { stable, tail } = s.split();
    expect(stable).toEqual(["intro"]);
    expect(tail[0]).toBe("```py");
  });

  it("releases the fence once it closes", () => {
    const s = new StreamSplitter();
    s.push("intro\n```py\nx = 1\n```\nafter\nmore");
    const { stable } = s.split();
    expect(stable).toContain("```py");
    expect(stable).toContain("after");
  });

  it("holds a table from its header until the stream ends", () => {
    // A new row reflows every column, so committing rows as they arrive locks a
    // stale render into scrollback.
    const s = new StreamSplitter();
    s.push("before\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| 33333 | 4 |");
    const { stable, tail } = s.split();
    expect(stable).toEqual(["before"]);
    expect(tail[0]).toBe("| a | b |");
    expect(s.split(true).tail).toHaveLength(0);
  });

  it("commits each stable line exactly once", () => {
    const t = new CommitTracker();
    expect(t.take(["a", "b"])).toEqual(["a", "b"]);
    expect(t.take(["a", "b"])).toEqual([]);
    expect(t.take(["a", "b", "c"])).toEqual(["c"]);
    t.reset();
    expect(t.take(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("display width — Hangul and CJK", () => {
  it("counts wide characters as two columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("한글")).toBe(4);
    expect(displayWidth("한a글")).toBe(5);
  });

  it("truncates Korean without overflowing the budget", () => {
    // `.length` would let this through at 20 characters and print 40 columns.
    const korean = "역방향 스윕에서 배경 제거가 동작하지 않는 문제를 살펴봅니다";
    const cut = truncateToWidth(korean, 20);
    expect(displayWidth(cut)).toBeLessThanOrEqual(20);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("keeps the tail for the live ticker", () => {
    const cut = truncateEndToWidth("앞부분은 잘리고 뒷부분이 남는다", 12);
    expect(displayWidth(cut)).toBeLessThanOrEqual(12);
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("남는다")).toBe(true);
  });

  it("keeps rules inside the terminal even with a wide label", () => {
    const state = fold([
      { type: "tool_start", call: { id: "k", name: "한글도구", arguments: { command: "ls" }, repaired: false, validated: true } },
    ]);
    for (const line of renderTranscript(state, { width: 60 })) {
      expect(displayWidth(line), line).toBeLessThanOrEqual(60);
    }
  });

  it("keeps a Korean reasoning ticker inside the terminal", () => {
    const state = fold([
      { type: "reasoning_delta", text: "역방향 스윕에서 배경 제거가 동작하지 않는 문제를 자세히 살펴보는 중입니다" },
    ]);
    for (const line of renderTail(state, { width: 60, showThinking: true })) {
      expect(displayWidth(line), line).toBeLessThanOrEqual(60);
    }
  });
});

describe("scrollback safety", () => {
  it("holds a tool cell back until it completes", () => {
    // Committing a tool cell between tool_start and tool_end prints a tool that
    // appears to have produced nothing — the two-region rule applied to cells
    // rather than to text. Caught by the first real end-to-end run.
    const started = fold([
      { type: "tool_start", call: { id: "t", name: "bash", arguments: { command: "ls" }, repaired: false, validated: true } },
    ]);
    expect(settledCount(started)).toBe(0);
    expect(renderSettled(started, OPTS)).toHaveLength(0);
    expect(renderPending(started, OPTS).join("\n")).toContain("Bash");
    expect(renderPending(started, OPTS).join("\n")).toContain("Running…");

    const finished = fold([{ type: "tool_end", id: "t", ok: true, output: "a.ts", ms: 4 }], started);
    expect(settledCount(finished)).toBe(1);
    expect(renderSettled(finished, OPTS).join("\n")).toContain("a.ts");
    expect(renderPending(finished, OPTS)).toHaveLength(0);
  });

  it("holds everything after an unsettled cell", () => {
    // Committing later cells around a pending one would reorder the transcript.
    const state = fold([
      { type: "tool_start", call: { id: "t", name: "bash", arguments: { command: "ls" }, repaired: false, validated: true } },
      { type: "notice", level: "info", text: "after" },
    ]);
    expect(settledCount(state)).toBe(0);
    expect(renderSettled(state, OPTS)).toHaveLength(0);
  });

  it("treats every non-tool cell as settled immediately", () => {
    const state = fold([
      { type: "session_start", model: "m", endpoint: "e", channel: "toolcall", tools: [], toolsHash: "h" },
      { type: "notice", level: "info", text: "hi" },
    ]);
    expect(settledCount(state)).toBe(2);
  });
});

describe("the reducer is pure", () => {
  it("does not touch the state it was given", () => {
    // It used to take `state.cells` by reference and push into it, and reach
    // into an existing tool cell to attach its output — so the "previous"
    // state a caller held was silently the current one. Every snapshot test
    // still passed, because they all compared the returned value with itself.
    let state = initialState();
    for (const event of SESSION) state = reduce(state, event);

    const frozen = deepFreeze(structuredClone(state)) as ViewState;
    const next = reduce(frozen, { type: "turn_start", turn: 99 });
    expect(next).not.toBe(frozen);
    expect(frozen.instruments.turn).not.toBe(99);
  });

  it("copies a tool cell rather than mutating it when its output arrives", () => {
    let state = reduce(initialState(), {
      type: "tool_start",
      call: { id: "c1", name: "bash", arguments: { command: "ls" }, repaired: false, validated: true },
    });
    const before = state.cells[0]!;
    state = reduce(state, { type: "tool_end", id: "c1", ok: true, output: "listing", ms: 5 });
    expect(state.cells[0]).not.toBe(before);
    expect(before).not.toHaveProperty("output");
  });

  it("copies a tool cell rather than mutating it when a hook reports", () => {
    let state = reduce(initialState(), {
      type: "tool_start",
      call: { id: "c1", name: "bash", arguments: { command: "ls" }, repaired: false, validated: true },
    });
    const before = state.cells[0] as Extract<Cell, { kind: "tool" }>;
    state = reduce(state, { type: "hook", event: "PostToolUse", label: "fmt", ok: true });
    expect(before.hooks).toHaveLength(0);
    expect((state.cells[0] as Extract<Cell, { kind: "tool" }>).hooks).toHaveLength(1);
  });
});

function deepFreeze(value: unknown): unknown {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
