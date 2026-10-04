/**
 * Bracketed paste arrives with the line endings the terminal sent.
 * xterm.js turns a clipboard break into CR before the paste markers, and a
 * CR written into a row moves the cursor to the start of that row. After
 * normalization the three lines stay visible and the cursor sits on the last.
 */

import xterm from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/composer.js";
import { KeyDecoder } from "../src/keys.js";
import { Screen } from "../src/screen.js";

const { Terminal } = xterm;
type TerminalInstance = InstanceType<typeof Terminal>;

const ESC = "\x1b";
const LINES = ["첫째 줄 한글🙂", "둘째 줄 café 漢字", "셋째 줄 cursor"];

function visible(terminal: TerminalInstance): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, index) =>
    buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? "");
}

/** Paint one bracketed paste the way the chat loop does: decode, paste, draw. */
async function paintPaste(eol: string): Promise<{ text: string; cursorX: number; cursorLine: string }> {
  const cols = 80;
  const rows = 24;
  const chunks: string[] = [];
  const terminal = new Terminal({ cols, rows, convertEol: true, allowProposedApi: true });
  const screen = new Screen({
    write: (text) => chunks.push(text),
    columns: () => cols,
    rows: () => rows,
    interactive: true,
  });
  const flush = (): Promise<void> => new Promise((resolve) => terminal.write(chunks.splice(0).join(""), resolve));
  try {
    const pasted = LINES.join(eol);
    const keys = new KeyDecoder().feed(`${ESC}[200~${pasted}${ESC}[201~`);
    expect(keys).toEqual([{ type: "paste", text: pasted }]);
    const key = keys[0]!;
    if (key.type !== "paste") throw new Error("expected a paste");
    const composer = new Composer();
    composer.paste(key.text);
    screen.setComposer({ draft: composer.snapshot() });
    await flush();
    const buffer = terminal.buffer.active;
    return {
      text: visible(terminal).join("\n"),
      cursorX: buffer.cursorX,
      cursorLine: buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "",
    };
  } finally {
    screen.finish();
    terminal.dispose();
  }
}

describe("bracketed paste on screen", () => {
  it("keeps CR, CRLF, and LF pastes on separate rows with the cursor on the last line", async () => {
    const painted = [];
    for (const eol of ["\n", "\r\n", "\r"]) painted.push(await paintPaste(eol));
    for (const view of painted) {
      for (const line of LINES) expect(view.text).toContain(line);
      expect(view.text).not.toContain("^M");
      expect(view.cursorLine).toContain(LINES[2]);
    }
    expect(painted[1]).toEqual(painted[0]);
    expect(painted[2]).toEqual(painted[0]);
  });

  it("lets a short CR paste be edited and submitted without a raw carriage return", () => {
    const composer = new Composer();
    composer.paste(LINES.join("\r"));
    composer.backspace();
    const expected = `${LINES[0]}\n${LINES[1]}\n${LINES[2]!.slice(0, -1)}`;
    expect(composer.text).toBe(expected);
    expect(composer.text).not.toContain("\r");
    expect(composer.submit()).toBe(expected);
  });
});
