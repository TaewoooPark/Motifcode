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
  it.each([1, 45])("blinks a %i-line live reply inside the viewport without moving the editor or scrollback", async (count) => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("TERM", "xterm-256color");
    vi.resetModules();
    const { Screen: ColourScreen } = await import("../src/screen.js");
    const answer = Array.from({ length: count }, (_, i) => `PULSE_${String(i).padStart(2, "0")}`).join("\n");
    const chunks: string[] = [];
    const frames: string[] = [];
    const frame = (): void => { frames.push(chunks.splice(0).join("")); };
    const screen = new ColourScreen({ write: (text) => chunks.push(text), columns: () => 40, rows: () => 8, interactive: true });
    vi.useFakeTimers();
    try {
      screen.setComposer({ draft: { text: "draft", cursor: 3 } });
      screen.append({ kind: "user", text: "SETTLED_USER" });
      screen.setWorking(true);
      screen.apply({ type: "stream", content: answer });
      vi.advanceTimersByTime(40);
      frame();
      vi.advanceTimersByTime(960);
      frame();
      vi.advanceTimersByTime(1000);
      frame();
      screen.apply({ type: "content_delta", text: answer });
      screen.setWorking(false);
      expect(vi.getTimerCount()).toBe(0);
      frame();
    } finally { screen.finish(); vi.useRealTimers(); }

    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 8, scrollback: 2000 });
    try {
      let baseY = 0;
      for (const [i, frame] of frames.slice(0, 3).entries()) {
        await write(terminal, frame);
        const buffer = terminal.buffer.active;
        const visible = lines(terminal).slice(buffer.baseY);
        const indicator = visible.find((line) => line.includes(count === 1 ? "PULSE_00" : "Working…"));
        expect(indicator).toBeDefined();
        expect(indicator![0]).toBe(i === 1 ? " " : "⏺");
        expect(buffer.getLine(buffer.baseY + buffer.cursorY)!.translateToString(true)).toContain("draft");
        expect(buffer.cursorX).toBe(7);
        if (i === 0) baseY = buffer.baseY;
        else {
          expect(buffer.baseY).toBe(baseY);
          expect(frame).not.toContain("\n");
        }
        expect(lines(terminal, buffer.baseY).join("\n")).not.toMatch(/PULSE_|Working…|draft|╭|╰/);
      }
      await write(terminal, frames[3]!);
      const all = lines(terminal).join("\n");
      for (const line of answer.split("\n")) expect(all.split(line), line).toHaveLength(2);
      expect(all).not.toContain("Working…");
    } finally { terminal.dispose(); }
  });

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

  it.each([
    ["reasoning while streaming", true, (s: Screen) => s.toggleThinking()],
    ["reasoning after completion", false, (s: Screen) => s.toggleThinking()],
    ["verbose output", false, (s: Screen) => s.toggleVerbose()],
    ["working directory", false, (s: Screen) => s.setCwd("/tmp/elsewhere")],
  ] as const)("redraws instead of re-emitting settled transcript when toggling %s", async (_name, streaming, toggle) => {
    for (const earlier of [0, 30]) await toggledTranscript(earlier, streaming, toggle, _name.startsWith("reasoning"));
  });

  it("keeps settled messages once when tall reasoning straddles the top of the screen", async () => {
    const reasoning = Array.from({ length: 15 }, (_, i) => `REASONING_LINE_${String(i).padStart(2, "0")}`).join("\n");
    const frames = recording(40, 12, (screen, frame) => {
      screen.setComposer({ draft: { text: "keep", cursor: 2 } });
      screen.append({ kind: "user", text: "CASE_REASONING" });
      screen.apply({ type: "reasoning_delta", text: reasoning });
      screen.apply({ type: "reasoning_end", chars: reasoning.length, ms: 8100 });
      screen.apply({ type: "content_delta", text: "FINAL_ANSWER" });
      frame();
      for (let i = 0; i < 4; i++) {
        screen.toggleThinking();
        frame();
      }
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 12, scrollback: 2000 });
    try {
      for (const [i, frame] of frames.entries()) {
        await write(terminal, frame);
        const buffer = terminal.buffer.active;
        const all = lines(terminal).join("\n");
        const visible = lines(terminal).slice(buffer.baseY).join("\n");
        expect(all.split("CASE_REASONING"), `user after frame ${i}`).toHaveLength(2);
        expect(all.split("FINAL_ANSWER"), `answer after frame ${i}`).toHaveLength(2);
        expect(visible, `answer on screen after frame ${i}`).toContain("FINAL_ANSWER");
        // Odd frames follow an odd number of toggles: the end of the reasoning is on screen.
        expect(visible.includes("REASONING_LINE_14"), `reasoning shown after frame ${i}`).toBe(i % 2 === 1);
        expect(buffer.getLine(buffer.baseY + buffer.cursorY)!.translateToString(true)).toContain("keep");
      }
    } finally { terminal.dispose(); }
  });

  it("leaves the splash above the transcript in place when toggling", async () => {
    const frames = recording(60, 30, (screen, frame) => {
      screen.splash({ model: "SPLASH_MODEL", endpoint: "http://fixture", channel: "chat" });
      screen.setComposer({ draft: { text: "keep", cursor: 2 } });
      screen.append({ kind: "user", text: "CASE_REASONING" });
      screen.apply({ type: "reasoning_delta", text: "THINKING_TEXT" });
      screen.apply({ type: "reasoning_end", chars: 13, ms: 900 });
      screen.apply({ type: "content_delta", text: "FINAL_ANSWER" });
      frame();
      for (let i = 0; i < 3; i++) { screen.toggleThinking(); frame(); }
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 60, rows: 30, scrollback: 2000 });
    try {
      for (const frame of frames) await write(terminal, frame);
      const all = lines(terminal).join("\n");
      expect(all.split("SPLASH_MODEL")).toHaveLength(2);
      expect(all.split("CASE_REASONING")).toHaveLength(2);
      expect(all.split("FINAL_ANSWER")).toHaveLength(2);
      expect(all).toContain("THINKING_TEXT");
    } finally { terminal.dispose(); }
  });

  it("leaves rows from before a widening resize alone and toggles later ones", async () => {
    let cols = 40;
    const chunks: string[] = [];
    const screen = new Screen({ write: (text) => chunks.push(text), columns: () => cols, rows: () => 12, interactive: true });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols, rows: 12, scrollback: 2000 });
    const messages = Array.from({ length: 8 }, (_, i) => `WIDE_${i}_${"x".repeat(50)}`);
    try {
      screen.setComposer({ draft: { text: "keep", cursor: 2 } });
      for (const text of messages) screen.append({ kind: "user", text });
      screen.apply({ type: "reasoning_delta", text: "THINKING_TEXT" });
      screen.apply({ type: "reasoning_end", chars: 13, ms: 900 });
      screen.apply({ type: "content_delta", text: "FINAL_ANSWER" });
      await write(terminal, chunks.splice(0).join(""));
      cols = 80;
      terminal.resize(cols, 12);
      screen.setHint("after widening");
      // Rows laid out at the old width are left alone (their reflow is the
      // terminal's); nothing settled may be erased or repeated. A turn settled
      // after the widening is tracked again, so the toggle applies to it.
      screen.append({ kind: "user", text: "NEW_USER" });
      screen.apply({ type: "reasoning_delta", text: "NEW_THINKING" });
      screen.apply({ type: "reasoning_end", chars: 12, ms: 900 });
      screen.apply({ type: "content_delta", text: "NEW_ANSWER" });
      await write(terminal, chunks.splice(0).join(""));
      for (const shown of [true, false]) {
        screen.toggleThinking();
        await write(terminal, chunks.splice(0).join(""));
        const visible = lines(terminal).slice(terminal.buffer.active.baseY).join("\n");
        expect(visible.includes("NEW_THINKING"), `new turn reasoning shown=${shown}`).toBe(shown);
      }
      const all = lines(terminal).join("\n").replace(/\n/g, "");
      for (const text of [...messages, "FINAL_ANSWER", "NEW_USER", "NEW_ANSWER"]) expect(all.split(text), text).toHaveLength(2);
    } finally { screen.finish(); terminal.dispose(); }
  });

  it("applies a toggle made while the output viewer is open once it closes", async () => {
    const frames = recording(40, 12, (screen, frame) => {
      screen.setComposer({ draft: { text: "keep", cursor: 2 } });
      screen.append({ kind: "user", text: "CASE_REASONING" });
      screen.apply({ type: "reasoning_delta", text: "THINKING_TEXT" });
      screen.apply({ type: "reasoning_end", chars: 13, ms: 900 });
      screen.apply({ type: "content_delta", text: "FINAL_ANSWER" });
      frame();
      screen.toggleOutputView();
      screen.toggleThinking();
      screen.toggleOutputView();
      frame();
      screen.toggleThinking();
      frame();
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 12, scrollback: 2000 });
    try {
      for (const [i, frame] of frames.entries()) {
        await write(terminal, frame);
        const buffer = terminal.buffer.active;
        const all = lines(terminal).join("\n");
        const visible = lines(terminal).slice(buffer.baseY).join("\n");
        expect(all.split("CASE_REASONING"), `frame ${i}`).toHaveLength(2);
        expect(all.split("FINAL_ANSWER"), `frame ${i}`).toHaveLength(2);
        expect(visible.includes("THINKING_TEXT"), `reasoning after frame ${i}`).toBe(i === 1);
      }
    } finally { terminal.dispose(); }
  });

  it.each([
    ["reasoning", (s: Screen) => s.toggleThinking()],
    ["verbose output", (s: Screen) => s.toggleVerbose()],
  ] as const)("keeps a tall answer once when toggling %s with hidden reasoning above it", async (_name, toggle) => {
    const answer = Array.from({ length: 15 }, (_, i) => `ANSWER_LINE_${String(i).padStart(2, "0")}`).join("\n\n");
    const frames = recording(40, 12, (screen, frame) => {
      screen.setComposer({ draft: { text: "keep", cursor: 2 } });
      screen.append({ kind: "user", text: "CASE_REASONING" });
      screen.apply({ type: "reasoning_delta", text: "THINKING_TEXT" });
      screen.apply({ type: "reasoning_end", chars: 13, ms: 900 });
      screen.apply({ type: "content_delta", text: answer });
      frame();
      for (let i = 0; i < 4; i++) { toggle(screen); frame(); }
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 12, scrollback: 2000 });
    try {
      for (const [i, frame] of frames.entries()) {
        await write(terminal, frame);
        const all = lines(terminal).join("\n");
        for (let j = 0; j < 15; j++) {
          const text = `ANSWER_LINE_${String(j).padStart(2, "0")}`;
          expect(all.split(text), `${text} after frame ${i}`).toHaveLength(2);
        }
        expect(all.split("CASE_REASONING")).toHaveLength(2);
      }
    } finally { terminal.dispose(); }
  });

  async function toggledTranscript(earlier: number, streaming: boolean, toggle: (s: Screen) => void, reasoning: boolean): Promise<void> {
    // `earlier` settled messages first, so the case below also runs with part of the transcript in scrollback.
    const history = Array.from({ length: earlier }, (_, i) => `EARLIER_${String(i).padStart(2, "0")}`);
    const frames = recording(40, 12, (screen, frame) => {
      screen.setComposer({ draft: { text: "keep", cursor: 2 } });
      for (const text of history) screen.append({ kind: "user", text });
      screen.append({ kind: "user", text: "CASE_REASONING" });
      screen.append({ kind: "assistant", text: "SETTLED_ANSWER" });
      screen.append({ kind: "user", text: "SECOND_USER" });
      screen.setWorking(true);
      screen.apply({ type: "stream", reasoning: "THINKING_TEXT" });
      if (!streaming) {
        screen.apply({ type: "reasoning_end", chars: 13, ms: 1200 });
        screen.apply({ type: "content_delta", text: "FINAL_ANSWER" });
        screen.setWorking(false);
      }
      vi.advanceTimersByTime(40);
      frame();
      toggle(screen);
      frame();
      toggle(screen);
      frame();
      toggle(screen);
      frame();
      if (streaming) {
        screen.apply({ type: "content_delta", text: "FINAL_ANSWER" });
        screen.setWorking(false);
      }
      screen.append({ kind: "user", text: "AFTER_TOGGLE" });
      frame();
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols: 40, rows: 12, scrollback: 2000 });
    try {
      for (const [i, frame] of frames.entries()) {
        await write(terminal, frame);
        const buffer = terminal.buffer.active;
        const all = lines(terminal).join("\n");
        for (const text of [...history, "CASE_REASONING", "SETTLED_ANSWER", "SECOND_USER"]) {
          expect(all.split(text), `${text} after frame ${i} (${earlier} earlier)`).toHaveLength(2);
        }
        expect(buffer.getLine(buffer.baseY + buffer.cursorY)!.translateToString(true)).toContain("keep");
        // Frames 1 and 3 follow an odd number of toggles: reasoning is shown on screen, then hidden again.
        if (reasoning && i < 4) {
          const visible = lines(terminal).slice(buffer.baseY).join("\n");
          expect(visible.includes("THINKING_TEXT"), `reasoning visible after frame ${i}`).toBe(i % 2 === 1);
        }
      }
      const all = lines(terminal).join("\n");
      expect(all.split("FINAL_ANSWER")).toHaveLength(2);
      expect(all.split("AFTER_TOGGLE")).toHaveLength(2);
    } finally { terminal.dispose(); }
  }

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

  it.each([1, 2, 3, 7, 20, 80])("keeps pasted tabs and their caret within physical rows at %i columns", async (cols) => {
    const frames = recording(cols, 12, (screen, frame) => {
      screen.setComposer({ draft: { text: "a\tb", cursor: 2 } });
      frame();
      screen.setHint("repaint");
      frame();
    });
    const terminal = new Terminal({ convertEol: true, allowProposedApi: true, cols, rows: 12 });
    try {
      for (const frame of frames) {
        expect(frame).not.toContain("\t");
        await write(terminal, frame);
        const buffer = terminal.buffer.active;
        expect(buffer.baseY).toBe(0);
        for (let i = 0; i < buffer.length; i++) expect(buffer.getLine(i)!.isWrapped).toBe(false);
        expect(buffer.getLine(buffer.cursorY)!.getCell(buffer.cursorX)!.getChars()).toBe("b");
      }
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
