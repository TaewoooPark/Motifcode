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
  { type: "usage", contextTokens: 4700, kvBytes: 287_000_000, tokensPerSecond: 27.4 },
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
  { type: "repair", reason: "tool failure", attempt: 1, max: 2 },
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

  it("collapses reasoning by default and expands on request", () => {
    // This model opens a thinking block on every generation, so expanded-by-
    // default would bury the session under reasoning.
    const state = fold(SESSION.slice(0, 5));
    const collapsed = renderTranscript(state, OPTS).join("\n");
    const expanded = renderTranscript(state, { ...OPTS, expandThinking: true }).join("\n");
    expect(collapsed).toContain("[tab]");
    expect(collapsed.split("\n").length).toBeLessThan(expanded.split("\n").length + 1);
    expect(expanded).toContain("forward/reverse");
  });

  it("gives the repair turn its own visible cell", () => {
    // Without this the loop reads as flailing; with it, a designed recovery is
    // visibly running — which matters more when the model has been pruned.
    const out = renderTranscript(fold(SESSION), OPTS).join("\n");
    expect(out).toContain("↻ repair");
    expect(out).toContain("attempt 1/2");
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
    expect(out).toContain("more lines");
    expect(out.split("\n").length).toBeLessThan(20);
  });
});

describe("live tail", () => {
  it("shows only the newest reasoning line", () => {
    const state = fold([
      { type: "reasoning_delta", text: "first line\nsecond line\nthird line" },
    ]);
    const tail = renderTail(state, OPTS);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toContain("third line");
    expect(tail[0]).not.toContain("first line");
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

  it("keeps a Korean reasoning preview inside the terminal", () => {
    const state = fold([
      { type: "reasoning_delta", text: "역방향 스윕에서 배경 제거가 동작하지 않는 문제를 자세히 살펴보는 중입니다" },
      { type: "reasoning_end", chars: 40, ms: 1000 },
    ]);
    for (const line of renderTranscript(state, { width: 60 })) {
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
    expect(renderPending(started, OPTS).join("\n")).toContain("bash");

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
