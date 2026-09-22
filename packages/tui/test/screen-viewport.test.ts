import xterm from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Screen, type ComposerView } from "../src/screen.js";

const { Terminal } = xterm;
type TerminalInstance = InstanceType<typeof Terminal>;
const write = (terminal: TerminalInstance, text: string): Promise<void> => new Promise((resolve) => terminal.write(text, resolve));
const lines = (terminal: TerminalInstance, end = terminal.buffer.active.length): string[] =>
  Array.from({ length: end }, (_, i) => terminal.buffer.active.getLine(i)!.translateToString(true));

function recording(cols: number, rows: number, run: (screen: Screen, frame: () => void) => void): string[] {
  const chunks: string[] = [];
  const frames: string[] = [];
  const screen = new Screen({ write: (text) => chunks.push(text), columns: () => cols, rows: () => rows, interactive: true });
  vi.useFakeTimers();
  try {
    run(screen, () => { frames.push(chunks.join("")); chunks.length = 0; });
  } finally {
    screen.finish();
    vi.useRealTimers();
  }
  return frames;
}

// An independent terminal policy for these fixtures: ASCII=1, the tested
// Ambiguous glyphs=2, Hangul=2. Do not measure with the renderer under test.
function wideAmbiguous(terminal: TerminalInstance): void {
  const ambiguous = new Set([..."Ωα·…─│╭╮╰╯•"].map((ch) => ch.codePointAt(0)!));
  terminal.unicode.register({
    version: "fixture-wide",
    wcwidth: (cp) => cp < 32 ? 0 : ambiguous.has(cp) || (cp >= 0xac00 && cp <= 0xd7a3) ? 2 : 1,
    charProperties(cp) { return this.wcwidth(cp) << 1; },
  });
  terminal.unicode.activeVersion = "fixture-wide";
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("physical footer viewport", () => {
  it("keeps repeated live frames out of scrollback and commits the answer once", async () => {
    const answer = Array.from({ length: 45 }, (_, i) => `LIVE_${String(i).padStart(2, "0")}`).join("\n");
    const frames = recording(40, 8, (screen, frame) => {
      screen.setComposer({ draft: { text: "", cursor: 0 } });
      screen.append({ kind: "user", text: "SETTLED_USER" });
      frame();
      for (const line of answer.split("\n")) {
        screen.apply({ type: "stream", content: line + "\n" });
        vi.advanceTimersByTime(40);
        frame();
      }
      screen.apply({ type: "content_delta", text: answer });
      frame();
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 8, scrollback: 2000 });
    try {
      for (const frame of frames.slice(0, -1)) {
        await write(terminal, frame);
        const scrollback = lines(terminal, terminal.buffer.active.baseY).join("\n");
        expect(scrollback).not.toMatch(/LIVE_|╭|╰|for shortcuts/);
      }
      expect(lines(terminal).join("\n")).toContain("LIVE_44");
      expect(lines(terminal).join("\n")).not.toContain("LIVE_00");
      await write(terminal, frames.at(-1)!);
      const all = lines(terminal).join("\n");
      for (const line of answer.split("\n")) expect(all.split(line), line).toHaveLength(2);
      expect(all.split("SETTLED_USER")).toHaveLength(2);
    } finally { terminal.dispose(); }
  });

  it.each([["height", 40, 12], ["narrowing", 20, 8]] as const)(
    "commits the entire answer when completion coincides with %s resize",
    async (_kind, nextCols, nextRows) => {
      let cols = 40;
      let rows = 8;
      const chunks: string[] = [];
      const screen = new Screen({ write: (text) => chunks.push(text), columns: () => cols, rows: () => rows, interactive: true });
      const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols, rows, scrollback: 2000 });
      const answer = Array.from({ length: 45 }, (_, i) => `RESIZE_${String(i).padStart(2, "0")}`).join("\n");
      try {
        vi.useFakeTimers();
        screen.setComposer({ draft: { text: "", cursor: 0 } });
        screen.apply({ type: "stream", content: answer });
        vi.advanceTimersByTime(40);
        vi.useRealTimers();
        await write(terminal, chunks.splice(0).join(""));

        cols = nextCols;
        rows = nextRows;
        terminal.resize(cols, rows);
        // Completion arrives before the debounced resize repaint. Its settled
        // prefix has never been displayed and must not be silently committed.
        screen.apply({ type: "content_delta", text: answer });
        await write(terminal, chunks.splice(0).join(""));
        const all = lines(terminal).join("\n");
        for (const line of answer.split("\n")) expect(all.split(line), line).toHaveLength(2);
        expect(terminal.buffer.active.cursorX).toBeLessThan(cols);
        expect(terminal.buffer.active.cursorY).toBeLessThan(rows);
      } finally { screen.finish(); terminal.dispose(); }
    },
  );

  it("uses no LF to repaint a footer even when the terminal starts at the bottom", async () => {
    const frames = recording(40, 8, (screen, frame) => {
      screen.setComposer({ draft: { text: "draft", cursor: 3 } });
      frame();
      screen.setHint("changed hint");
      frame();
    });
    expect(frames.join("")).not.toContain("\n");
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 8 });
    try {
      await write(terminal, "\x1b[8;1H");
      for (const frame of frames) await write(terminal, frame);
      expect(lines(terminal, terminal.buffer.active.baseY).join("\n")).not.toContain("draft");
      expect(lines(terminal).join("\n")).toContain("changed hint");
      expect(terminal.buffer.active.cursorX).toBe(7);
    } finally { terminal.dispose(); }
  });

  it.each([1, 2, 3, 4, 7, 8, 20, 80])("fits composer rows in %i columns with Ambiguous width 2", async (cols) => {
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", "2");
    const frames = recording(cols, 12, (screen, frame) => {
      screen.setComposer({ draft: { text: "", cursor: 0 }, placeholder: "placeholder too long Ω·" });
      frame();
      screen.setComposer({ draft: { text: "Ω·한", cursor: 1 } });
      frame();
      screen.setHint("ambiguous Ω· hint");
      frame();
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols, rows: 12 });
    wideAmbiguous(terminal);
    try {
      for (const frame of frames) {
        await write(terminal, frame);
        expect(terminal.buffer.active.baseY).toBe(0);
        for (let i = 0; i < terminal.buffer.active.length; i++) {
          expect(terminal.buffer.active.getLine(i)!.isWrapped).toBe(false);
        }
        expect(terminal.buffer.active.cursorX).toBeLessThan(cols);
      }
    } finally { terminal.dispose(); }
  });

  it.each(["draft", "confirmation", "secret"])("keeps the cursor in an oversized %s", async (kind) => {
    const long = Array.from({ length: 30 }, (_, i) => `row ${i}`);
    const view: ComposerView = { draft: { text: long.join("\n"), cursor: 2 } };
    if (kind === "confirmation") view.confirm = { title: "Approval", lines: long, choices: ["❯ Yes", "No"] };
    if (kind === "secret") view.secret = { title: "Login", lines: long, prompt: "key: " };
    const frames = recording(40, 6, (screen, frame) => { screen.setComposer(view); frame(); });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 6 });
    try {
      await write(terminal, frames[0]!);
      expect(terminal.buffer.active.baseY).toBe(0);
      const cursorLine = terminal.buffer.active.getLine(terminal.buffer.active.cursorY)!.translateToString(true);
      expect(cursorLine).toContain(kind === "confirmation" ? "Yes" : kind === "secret" ? "•" : "row 0");
    } finally { terminal.dispose(); }
  });
  it("keeps the selected menu item visible in a short viewport", async () => {
    const frames = recording(40, 8, (screen, frame) => {
      screen.setComposer({ draft: { text: "/", cursor: 1 }, menu: {
        items: Array.from({ length: 10 }, (_, i) => ({ name: `option${i}`, description: "command" })), selected: 7,
      } });
      frame();
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 8 });
    try {
      await write(terminal, frames[0]!);
      expect(lines(terminal).join("\n")).toContain("❯ /option7");
      expect(terminal.buffer.active.baseY).toBe(0);
      expect(terminal.buffer.active.getLine(terminal.buffer.active.cursorY)!.translateToString(true)).toContain("> /");
    } finally { terminal.dispose(); }
  });

  it("rebuilds after height changes and narrowing before the next repaint", async () => {
    let cols = 40;
    let rows = 12;
    const chunks: string[] = [];
    const screen = new Screen({ write: (text) => chunks.push(text), columns: () => cols, rows: () => rows, interactive: true });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols, rows });
    const flush = async (): Promise<string> => {
      const text = chunks.splice(0).join("");
      await write(terminal, text);
      return text;
    };
    try {
      screen.setComposer({ draft: { text: "EDIT_HERE", cursor: 4 } });
      await flush();
      for (const [nextCols, nextRows] of [[40, 6], [40, 10], [7, 10], [40, 10]]) {
        cols = nextCols!; rows = nextRows!;
        terminal.resize(cols, rows);
        screen.setHint(`size ${cols}x${rows}`);
        const frame = await flush();
        if (cols === 7 || rows !== 10) expect(frame).toContain("\x1b[2J");
        expect(terminal.buffer.active.cursorX).toBeLessThan(cols);
        expect(terminal.buffer.active.cursorY).toBeLessThan(rows);
        const visible = lines(terminal).slice(terminal.buffer.active.baseY).join("\n");
        expect(visible).toContain(cols === 7 ? "EDIT_" : "EDIT_HERE");
        screen.setHint("repaint");
        expect(await flush()).not.toContain("\n");
      }
    } finally { screen.finish(); terminal.dispose(); }
  });

});
