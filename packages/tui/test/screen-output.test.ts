import { PassThrough } from "node:stream";
import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { Screen } from "../src/screen.js";

const { Terminal } = xterm;
type TerminalInstance = InstanceType<typeof Terminal>;
class FakeTTY extends PassThrough {
  isTTY = true;
  setRawMode(): this { return this; }
}
const allLines = (terminal: TerminalInstance): string[] => Array.from({ length: terminal.buffer.active.length },
  (_, index) => terminal.buffer.active.getLine(index)!.translateToString(true));
const occurrences = (lines: string[], text: string): number => lines.join("\n").split(text).length - 1;
const output = JSON.stringify({
  first: "BEGIN_JSON", values: Array.from({ length: 12 }, (_, index) => `value-${index}-${"x".repeat(20)}`), last: "FINAL_JSON",
});

function terminalSession(initialCols: number, initialRows: number, toolOutput = output) {
  let cols = initialCols;
  let rows = initialRows;
  const chunks: string[] = [];
  const stdin = new FakeTTY();
  const terminal = new Terminal({ cols, rows, scrollback: 3000, convertEol: true, allowProposedApi: true });
  const screen = new Screen({ write: (text) => chunks.push(text), columns: () => cols, rows: () => rows, interactive: true });
  screen.attachInput(stdin as unknown as NodeJS.ReadStream, (key) => {
    if (screen.handleOutputViewKey(key)) return;
    if (key.type === "ctrl" && key.key === "o") screen.toggleOutputView();
  });
  const flush = (): Promise<void> => new Promise((resolve) => terminal.write(chunks.splice(0).join(""), resolve));
  const key = async (input: string): Promise<void> => { stdin.write(input); await flush(); };
  const toggle = (): Promise<void> => key("\x0f");
  const resize = async (nextCols: number, nextRows: number): Promise<void> => {
    cols = nextCols; rows = nextRows;
    terminal.resize(cols, rows);
    screen.redraw();
    await flush();
  };
  const visible = () => allLines(terminal).slice(terminal.buffer.active.baseY);
  const assertEditor = (): void => {
    const buffer = terminal.buffer.active;
    const caretLine = buffer.getLine(buffer.baseY + buffer.cursorY)!;
    expect(caretLine.translateToString(true)).toContain("stable draft");
    expect(buffer.cursorX).toBe(7);
    expect(caretLine.getCell(buffer.cursorX)!.getChars()).toBe("b");
    expect(occurrences(visible(), "stable draft")).toBe(1);
  };
  screen.setComposer({ draft: { text: "stable draft", cursor: 3 } });
  screen.append({ kind: "user", text: "REQUEST_UNIQUE" });
  screen.append({ kind: "tool", id: "json", name: "bash", args: { command: "fixture-json" }, repaired: false, hooks: [], output: toolOutput, ok: true, ms: 1 });
  return { screen, terminal, flush, key, toggle, resize, visible, assertEditor, close: () => { screen.finish(); terminal.dispose(); } };
}

describe("physical tool output folding", () => {
  it("folds a wrapped single-line JSON result to three body rows and restores the normal screen exactly after Ctrl-O", async () => {
    const s = terminalSession(80, 24);
    try {
      await s.flush();
      const compact = allLines(s.terminal);
      const header = compact.findIndex((line) => line.includes("Bash(fixture-json)"));
      const hidden = compact.findIndex((line) => /… \+\d+ (?:lines|rows)/.test(line));
      expect(header).toBeGreaterThanOrEqual(0);
      expect(hidden - header - 1).toBe(3);
      expect(compact.join("\n")).toContain("BEGIN_JSON");
      expect(compact.join("\n")).not.toContain("FINAL_JSON");
      expect(compact.join("\n")).toContain("ctrl-o");
      const cells = structuredClone(s.screen.view.cells);
      const cursor = { x: s.terminal.buffer.active.cursorX, y: s.terminal.buffer.active.cursorY, base: s.terminal.buffer.active.baseY };
      s.assertEditor();
      for (const closeKey of ["\x0f", "\x1b", "q"]) {
        await s.toggle();
        expect(s.screen.outputViewOpen).toBe(true);
        expect(s.terminal.buffer.active.type).toBe("alternate");
        const expanded = allLines(s.terminal);
        expect(expanded.join("\n")).toContain("FINAL_JSON");
        expect(expanded.join("\n")).not.toMatch(/… \+\d+ (?:lines|rows)/);
        expect(occurrences(expanded, "REQUEST_UNIQUE")).toBe(1);
        expect(occurrences(expanded, "Bash(fixture-json)")).toBe(1);
        await s.key(closeKey);
        expect(s.screen.outputViewOpen).toBe(false);
        expect(s.terminal.buffer.active.type).toBe("normal");
        expect(allLines(s.terminal)).toEqual(compact);
        expect({ x: s.terminal.buffer.active.cursorX, y: s.terminal.buffer.active.cursorY, base: s.terminal.buffer.active.baseY }).toEqual(cursor);
        s.assertEditor();
      }
      expect(s.screen.view.cells).toEqual(cells);
      expect(s.screen.verboseOutput).toBe(false);
    } finally { s.close(); }
  });

  it("makes all full output reachable in a short viewer and restores the draft after a resize", async () => {
    const s = terminalSession(40, 8);
    try {
      await s.flush();
      s.assertEditor();
      expect(allLines(s.terminal).join("\n")).not.toContain("FINAL_JSON");
      await s.toggle();
      expect(s.terminal.buffer.active.type).toBe("alternate");
      await s.key("\x1b[H");
      expect(s.visible().join("\n")).toContain("BEGIN_JSON");
      await s.key("\x1b[F");
      expect(s.visible().join("\n")).toContain("FINAL_JSON");
      await s.resize(80, 24);
      expect(s.terminal.buffer.active.type).toBe("alternate");
      expect(occurrences(s.visible(), "Bash(fixture-json)")).toBeLessThanOrEqual(1);
      await s.toggle();
      expect(s.terminal.buffer.active.type).toBe("normal");
      expect(s.visible().join("\n")).not.toContain("FINAL_JSON");
      s.assertEditor();
      await s.toggle();
      await s.resize(40, 8);
      expect(s.terminal.buffer.active.type).toBe("alternate");
      await s.key("\x1b[F");
      expect(s.visible().join("\n")).toContain("FINAL_JSON");
      await s.key("q");
      expect(s.terminal.buffer.active.type).toBe("normal");
      expect(s.visible().join("\n")).not.toContain("FINAL_JSON");
      s.assertEditor();
      expect(s.screen.view.cells.find((cell) => cell.kind === "tool")?.output).toBe(output);
    } finally { s.close(); }
  });

  it("commits a task result that arrived while the viewer was open once after returning to the prompt", async () => {
    const s = terminalSession(80, 24);
    try {
      await s.flush();
      await s.toggle();
      s.screen.setWorking(true);
      s.screen.apply({ type: "content_delta", text: "RESULT_WHILE_VIEWING" });
      s.screen.setWorking(false);
      await s.flush();
      expect(s.terminal.buffer.active.type).toBe("alternate");
      await s.key("q");
      expect(s.terminal.buffer.active.type).toBe("normal");
      const transcript = allLines(s.terminal);
      expect(occurrences(transcript, "RESULT_WHILE_VIEWING")).toBe(1);
      expect(occurrences(transcript, "REQUEST_UNIQUE")).toBe(1);
      expect(occurrences(transcript, "Bash(fixture-json)")).toBe(1);
      expect(transcript.join("\n")).not.toContain("FINAL_JSON");
      s.assertEditor();
    } finally { s.close(); }
  });

  it.each(["approval", "secret"])("returns from the viewer automatically when a %s prompt needs attention", async (prompt) => {
    const s = terminalSession(80, 24);
    try {
      await s.flush();
      await s.toggle();
      if (prompt === "approval") s.screen.setComposer({
        draft: { text: "stable draft", cursor: 3 },
        confirm: { title: "Approve this command?", lines: ["Run a guarded command"], choices: ["❯ Yes", "No"] },
      });
      else s.screen.setComposer({
        draft: { text: "secret-fixture", cursor: 14 },
        secret: { title: "Enter account credential", lines: [], prompt: "key › " },
      });
      await s.flush();
      expect(s.screen.outputViewOpen).toBe(false);
      expect(s.terminal.buffer.active.type).toBe("normal");
      expect(s.visible().join("\n")).toContain(prompt === "approval" ? "Approve this command?" : "Enter account credential");
      expect(s.visible().join("\n")).not.toContain("secret-fixture");
      s.screen.setComposer({ draft: { text: "stable draft", cursor: 3 } });
      await s.flush();
      s.assertEditor();
    } finally { s.close(); }
  });

  it("leaves the alternate screen and flushes newly completed cells when the session finishes", async () => {
    const s = terminalSession(80, 24);
    try {
      await s.flush();
      await s.toggle();
      s.screen.append({ kind: "assistant", text: "FINISH_UNIQUE" });
      s.screen.finish();
      await s.flush();
      expect(s.screen.outputViewOpen).toBe(false);
      expect(s.terminal.buffer.active.type).toBe("normal");
      const transcript = allLines(s.terminal);
      expect(occurrences(transcript, "FINISH_UNIQUE")).toBe(1);
      expect(occurrences(transcript, "REQUEST_UNIQUE")).toBe(1);
      expect(occurrences(transcript, "Bash(fixture-json)")).toBe(1);
      expect(transcript.join("\n")).not.toContain("stable draft");
      expect(transcript.join("\n")).not.toContain("FINAL_JSON");
    } finally { s.close(); }
  });

  it("commits new results once after widening reduces the physical row count of an earlier tool", async () => {
    const s = terminalSession(20, 24, "x".repeat(45));
    try {
      await s.flush();
      await s.resize(80, 24);
      s.screen.append({ kind: "assistant", text: "AFTER_WIDENING" });
      await s.flush();
      expect(occurrences(allLines(s.terminal), "AFTER_WIDENING")).toBe(1);
      s.screen.setHint("ordinary refresh after the resize");
      await s.flush();
      expect(occurrences(allLines(s.terminal), "AFTER_WIDENING")).toBe(1);
      s.assertEditor();
    } finally { s.close(); }
  });

  it("finishes cleanly after the full-output viewer was narrowed and shortened", async () => {
    const s = terminalSession(80, 24, "RESULT_OK");
    try {
      await s.flush();
      await s.toggle();
      await s.resize(20, 8);
      s.screen.finish();
      await s.flush();
      await new Promise<void>((resolve) => s.terminal.write("SHELL_PROMPT", resolve));
      expect(s.screen.outputViewOpen).toBe(false);
      expect(s.terminal.buffer.active.type).toBe("normal");
      const visible = s.visible().join("\n");
      expect(visible).toContain("SHELL_PROMPT");
      expect(visible).not.toMatch(/stable draft|for shortcuts|[╭╮╰╯│]/);
      expect(allLines(s.terminal).join("\n")).toContain("RESULT_OK");
    } finally { s.close(); }
  });
});
