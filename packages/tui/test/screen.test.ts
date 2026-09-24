/**
 * Footer paints that reach the terminal.
 *
 * The render snapshots cannot see this: a skipped paint is the absence of a
 * write, and a torn erase is two writes that should have been one update.
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Screen } from "../src/screen.js";
import { BULLET } from "../src/render.js";
import { style, term } from "../src/theme.js";

function screen(write: (s: string) => void): Screen {
  return new Screen({
    write,
    columns: () => 80,
    rows: () => 24,
    interactive: true,
    now: () => 1_000,
  });
}

describe("unchanged footer redraws", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes nothing for a reasoning-only stream when the footer is unchanged", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setComposer({ draft: { text: "", cursor: 0 } });
    s.setActivity("Thinking…");
    out.length = 0;

    s.apply({ type: "stream", reasoning: "hidden" });
    s.apply({ type: "stream", reasoning: " still hidden" });
    vi.advanceTimersByTime(50);

    expect(out).toEqual([]);
  });

  it.each(["resize event", "paint before resize event"])("rebuilds on height changes via %s", (trigger) => {
    vi.useFakeTimers();
    let rows = 24;
    const out: string[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const s = new Screen({ write: (chunk) => out.push(chunk), columns: () => 80, rows: () => rows, interactive: true });
    const draft = { text: "draft", cursor: 5 };
    try {
      s.attachInput(stdin as unknown as NodeJS.ReadStream, () => {});
      s.setComposer({ draft });
      s.setHint("resize hint");
      s.append({ kind: "assistant", text: Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n") });

      for (const height of [12, 24]) {
        out.length = 0;
        rows = height;
        if (trigger === "resize event") process.stdout.emit("resize");
        else s.setComposer({ draft });
        vi.advanceTimersByTime(40);

        const painted = out.join("");
        expect(painted).toContain(term.clearScreen + term.home);
        expect(painted).toContain("line 44");
        expect(painted).not.toContain("line 0\n");
        expect(painted).toContain("draft");
        expect(painted).toContain("╰");
        expect(painted).toContain("resize hint");
        expect(painted).toContain(term.showCursor);
        expect(painted.startsWith(term.beginSync)).toBe(true);
        expect(painted.endsWith(term.endSync)).toBe(true);

        out.length = 0;
        process.stdout.emit("resize");
        s.apply({ type: "stream", reasoning: "hidden" });
        vi.advanceTimersByTime(40);
        expect(out).toEqual([]);
      }
    } finally {
      s.finish();
      stdin.destroy();
    }
  });

  it("does not repaint when setActivity is repeated, but the one-second tick does", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setActivity("Thinking…");
    out.length = 0;

    s.setActivity("Thinking…");
    expect(out).toEqual([]);

    vi.advanceTimersByTime(1000);
    const painted = out.join("");
    expect(painted.startsWith(term.beginSync)).toBe(true);
    expect(painted.endsWith(term.endSync)).toBe(true);
    expect(painted).toContain("Thinking…");
  });

  it("brackets an actual footer change in one synchronized update", () => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setComposer({ draft: { text: "", cursor: 0 } });
    out.length = 0;

    s.setHint("esc to interrupt");
    const painted = out.join("");
    expect(painted.startsWith(term.beginSync)).toBe(true);
    expect(painted.endsWith(term.endSync)).toBe(true);
    expect(painted.indexOf(term.beginSync)).toBeLessThan(painted.indexOf("esc to interrupt"));
    expect(painted.indexOf("esc to interrupt")).toBeLessThan(painted.lastIndexOf(term.endSync));
  });

  it("still paints a streamed reply, inside the same bracket", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setComposer({ draft: { text: "", cursor: 0 } });
    out.length = 0;

    s.apply({ type: "stream", content: "visible reply" });
    vi.advanceTimersByTime(40);

    const painted = out.join("");
    expect(painted).toContain("visible reply");
    expect(painted.startsWith(term.beginSync)).toBe(true);
    expect(painted.endsWith(term.endSync)).toBe(true);
  });

  it.each([
    ["toggleThinking", (s: Screen) => s.toggleThinking()],
    ["setCwd", (s: Screen) => s.setCwd("/tmp/elsewhere")],
    ["toggleVerbose", (s: Screen) => s.toggleVerbose()],
  ] as const)("%s clears the footer inside the synchronized update", (_name, change) => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setComposer({ draft: { text: "", cursor: 0 } });
    s.append({ kind: "user", text: "hello" });
    out.length = 0;

    change(s);
    const painted = out.join("");
    expect(painted.startsWith(term.beginSync)).toBe(true);
    expect(painted.endsWith(term.endSync)).toBe(true);
    expect(painted.indexOf(term.clearLine)).toBeGreaterThan(term.beginSync.length);
    expect(painted.indexOf(term.clearLine)).toBeLessThan(painted.lastIndexOf(term.endSync));
  });
});

describe("working indicator", () => {
  let WorkingScreen: typeof Screen;
  const screen = (write: (s: string) => void): Screen => new WorkingScreen({
    write, columns: () => 80, rows: () => 24, interactive: true, now: () => 1_000,
  });
  beforeEach(async () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("TERM", "xterm-256color");
    vi.resetModules();
    WorkingScreen = (await import("../src/screen.js")).Screen;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("keeps one slow pulse after streamed prose replaces the activity label", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setComposer({ draft: { text: "draft", cursor: 3 } });
    s.setWorking(true);
    s.setActivity("Thinking…");
    s.apply({ type: "stream", content: "Now writing the game." });
    vi.advanceTimersByTime(40);
    s.setActivity(null);
    out.length = 0;
    s.setWorking(true);
    expect(out).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(960);
    const hidden = out.join("");
    expect(hidden).toContain(term.clearLine + "  Now writing the game.");
    expect(hidden).not.toContain(BULLET);
    expect(hidden).not.toContain("Working…");
    expect(hidden).not.toContain("draft");
    expect(hidden).not.toContain("\n");
    expect(hidden).toContain(term.column(7) + term.showCursor);
    expect(hidden.startsWith(term.beginSync)).toBe(true);
    expect(hidden.endsWith(term.endSync)).toBe(true);

    out.length = 0;
    vi.advanceTimersByTime(1000);
    expect(out.join("")).toContain(style.accent + BULLET + style.reset + " Now writing the game.");

    vi.advanceTimersByTime(1000);
    out.length = 0;
    s.setWorking(false);
    expect(out.join("")).toContain(style.accent + BULLET + style.reset + " Now writing the game.");
    expect(vi.getTimerCount()).toBe(0);
    s.finish();
  });

  it("uses the activity row for work, then stops and resumes with its task state", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setWorking(true);
    out.length = 0;
    s.setActivity("Calling write…");
    expect(out.join("")).toContain("Calling write…");
    expect(out.join("")).not.toContain("Working…");
    s.setActivity(null);
    s.setWorking(false);
    out.length = 0;
    vi.advanceTimersByTime(5000);
    expect(out).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    s.setWorking(true);
    expect(out.join("")).toContain("Working…");
    expect(out.join("")).toContain(BULLET);
    expect(vi.getTimerCount()).toBe(1);
    s.finish();
  });

  it("does not animate or re-emit completed transcript while hidden reasoning continues", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.append({ kind: "assistant", text: "Completed step" });
    s.setWorking(true);
    out.length = 0;
    s.apply({ type: "stream", reasoning: "hidden" });
    vi.advanceTimersByTime(40);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(960);
    expect(out.join("")).toContain("Working…");
    expect(out.join("")).not.toContain(BULLET);
    expect(out.join("")).not.toContain("Completed step");
    expect(out.join("")).not.toContain("hidden");
    expect(out.join("")).not.toContain("\n");
    s.finish();
  });

  it("pulses the latest running tool rather than a completed tool behind it", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setWorking(true);
    s.apply({ type: "tool_start", call: { id: "a", name: "bash", arguments: { command: "still-running" }, repaired: false, validated: true } });
    s.apply({ type: "tool_start", call: { id: "b", name: "bash", arguments: { command: "finished" }, repaired: false, validated: true } });
    s.apply({ type: "tool_end", id: "b", ok: true, output: "done", ms: 1 });
    out.length = 0;
    vi.advanceTimersByTime(1000);
    expect(out.join("")).toContain("still-running");
    expect(out.join("")).not.toContain(BULLET);
    expect(out.join("")).not.toContain("finished");
    expect(out.join("")).not.toContain("Working…");
    expect(out.join("")).not.toContain("\n");
    s.finish();
  });

  it("keeps a visible indicator for tall live replies without adding scrollback on ticks", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setComposer({ draft: { text: "", cursor: 0 } });
    s.setWorking(true);
    s.apply({ type: "stream", content: Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n") });
    vi.advanceTimersByTime(40);
    expect(out.join("")).toContain("Working…");
    out.length = 0;
    vi.advanceTimersByTime(3000);
    const ticks = out.join("");
    expect(ticks.match(/Working…/g)).toHaveLength(3);
    expect(ticks).not.toContain("line 0");
    expect(ticks).not.toContain("line 44");
    expect(ticks).not.toContain("\n");
    expect(ticks).not.toContain(term.clearScreen);
    s.finish();
  });

  it("rebuilds at a changed terminal height before using pulse row positions", () => {
    vi.useFakeTimers();
    let rows = 24;
    const out: string[] = [];
    const s = new WorkingScreen({ write: (chunk) => out.push(chunk), columns: () => 80, rows: () => rows, interactive: true });
    s.setComposer({ draft: { text: "draft", cursor: 5 } });
    s.setWorking(true);
    out.length = 0;
    rows = 12;
    vi.advanceTimersByTime(1000);
    expect(out.join("")).toContain(term.clearScreen + term.home);
    expect(out.join("")).toContain("draft");
    out.length = 0;
    vi.advanceTimersByTime(1000);
    expect(out.join("")).not.toContain("\n");
    s.finish();
  });

  it("clears both the pulse and a pending stream flush on finish", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setWorking(true);
    s.apply({ type: "stream", content: "pending" });
    expect(vi.getTimerCount()).toBe(2);
    s.finish();
    expect(vi.getTimerCount()).toBe(0);
    out.length = 0;
    vi.advanceTimersByTime(5000);
    expect(out).toEqual([]);
  });

  it("adds no output or ticker to piped runs", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = new WorkingScreen({ write: (chunk) => out.push(chunk), interactive: false });
    s.setWorking(true);
    s.setActivity("Thinking…");
    vi.advanceTimersByTime(5000);
    expect(out).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    s.finish();
  });

  it("uses a static, uncoloured indicator with NO_COLOR", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NO_COLOR", "1");
    vi.resetModules();
    const { Screen: PlainScreen } = await import("../src/screen.js");
    const out: string[] = [];
    const s = new PlainScreen({ write: (chunk) => out.push(chunk), interactive: true, columns: () => 80 });
    s.setWorking(true);
    expect(out.join("")).toContain(`${BULLET} Working…`);
    expect(out.join("")).not.toMatch(/\x1b\[[\d;]*m/);
    out.length = 0;
    vi.advanceTimersByTime(5000);
    expect(out).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    s.setActivity("Thinking…");
    out.length = 0;
    vi.advanceTimersByTime(1000);
    expect(out.join("")).toContain(`${BULLET} Thinking…`);
    expect(out.join("")).not.toMatch(/\x1b\[[\d;]*m/);
    s.finish();
  });
});
