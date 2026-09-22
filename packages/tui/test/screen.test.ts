/**
 * Footer paints that reach the terminal.
 *
 * Scrollback copies are writes, not render snapshots: a redraw that moves with
 * LF, a tail taller than the screen, or a composer row wider than the terminal.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Screen } from "../src/screen.js";
import { boundaryWidth, displayWidth } from "../src/width.js";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function visible(chunk: string): string {
  return chunk.replace(ANSI, "").replace(/\r/g, "");
}

function terminalBoundaryWidth(text: string): number {
  let column = 0;
  for (const ch of text) {
    if (ch === "\t") column += 8 - (column % 8);
    else column += boundaryWidth(ch);
  }
  return column;
}

function screen(write: (s: string) => void, opts: { columns?: number; rows?: number } = {}): Screen {
  return new Screen({
    write,
    columns: () => opts.columns ?? 80,
    rows: () => opts.rows ?? 24,
    interactive: true,
    now: () => 1_000,
  });
}

describe("footer scrollback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("redraws an existing footer without LF", () => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk));
    s.setComposer({ draft: { text: "", cursor: 0 } });
    out.length = 0;

    s.setHint("esc to interrupt");
    const painted = out.join("");
    expect(painted).toContain("esc to interrupt");
    expect(painted).not.toContain("\n");
  });

  it("clips a tail taller than the viewport and commits it only when the turn settles", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk), { columns: 20, rows: 8 });
    s.setComposer({ draft: { text: "", cursor: 0 } });
    out.length = 0;

    const lines = Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, "0")}`);
    s.apply({ type: "stream", content: lines.join("\n") });
    vi.advanceTimersByTime(40);

    const live = out.join("");
    expect(live).toContain("L29");
    expect(live).not.toContain("L00");

    out.length = 0;
    s.apply({ type: "content_delta", text: lines.join("\n") });
    const settled = out.join("");
    expect(settled).toContain("L00");
    expect(settled).toContain("L29");
  });

  it("replaces footer rows a settled line just consumed", () => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk), { columns: 40, rows: 8 });
    s.setComposer({ draft: { text: "", cursor: 0 } });
    out.length = 0;

    s.append({ kind: "user", text: "hello" });
    // `> hello` and the blank under it take two physical rows out of the
    // reservation. A same-height footer must allocate those two back. Trusting
    // the old count emits only the transcript newlines.
    expect(out).toContain("\n\n");
  });

  it("counts a wrapped settled line as more than one reserved row", () => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk), { columns: 10, rows: 12 });
    s.setComposer({ draft: { text: "", cursor: 0 } });
    out.length = 0;

    s.append({ kind: "user", text: "abcdefghij" });
    // `> abcdefghij` wraps to two rows at 10 columns, plus the blank line.
    // Subtracting the two writes instead of the three physical rows leaves a
    // growth of two newlines.
    expect(out).toContain("\n\n\n");
  });

  it("reserves rows for settled text when Ambiguous characters are wide", () => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk), { columns: 10, rows: 12 });
    s.setComposer({ draft: { text: "", cursor: 0 } });
    out.length = 0;

    s.append({ kind: "user", text: "········" });

    const transcript = out.filter((chunk) => chunk.includes("·")).map(visible);
    expect(transcript.join("").replace(/\n/g, "")).toBe("> ········");
    // The text takes two rows when Ambiguous is wide, and the blank after the
    // user cell takes a third, so a same-height footer allocates three back.
    expect(out).toContain("\n\n\n");
  });

  it("keeps a padded status hint within the boundary width", () => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk), { columns: 60, rows: 24 });
    s.setLabel("motif");
    s.apply({
      type: "usage",
      contextTokens: 12000,
      kvBytes: 1024,
      requestMs: 1000,
      promptTokens: 12000,
      cachedTokens: 8000,
    });
    out.length = 0;
    s.setComposer({ draft: { text: "", cursor: 0 } });

    const painted = out.join("");
    expect(painted).toContain("ctx");
    expect(painted).not.toContain("\u00b7");
    for (const chunk of out) {
      const text = visible(chunk);
      if (text === "") continue;
      expect(boundaryWidth(text)).toBeLessThanOrEqual(60);
    }
  });

  it.each([1, 7, 80])("keeps every composer row within %i columns", (columns) => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk), { columns, rows: 24 });
    s.setComposer({ draft: { text: "hello", cursor: 5 } });

    for (const chunk of out) {
      const text = visible(chunk);
      if (text === "") continue;
      expect(displayWidth(text)).toBeLessThanOrEqual(columns);
      expect(text).not.toMatch(/[\u2500-\u257F]/);
    }
  });

  it("expands pasted tabs before writing composer rows", () => {
    const out: string[] = [];
    const s = screen((chunk) => out.push(chunk), { columns: 10, rows: 24 });
    s.setComposer({ draft: { text: "\t12345", cursor: 6 } });

    for (const chunk of out) {
      const text = visible(chunk);
      if (text === "" || text.includes("\n")) continue;
      expect(terminalBoundaryWidth(text)).toBeLessThanOrEqual(10);
    }
    const painted = visible(out.join(""));
    expect(painted.replace(/\D/g, "")).toBe("12345");
    expect(painted).not.toContain("\t");
  });
});
