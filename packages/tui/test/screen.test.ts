/**
 * Footer paints that reach the terminal.
 *
 * The render snapshots cannot see this: a skipped paint is the absence of a
 * write, and a torn erase is two writes that should have been one update.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Screen } from "../src/screen.js";
import { term } from "../src/theme.js";

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
