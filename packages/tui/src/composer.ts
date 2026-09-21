/**
 * The composer: a line editor for the prompt at the bottom of the screen.
 *
 * Pure state and pure rendering, in the same spirit as the cells: the editor
 * holds text and a cursor and knows nothing about the terminal, and
 * `renderComposer` turns it into rows with a cursor position for the writer
 * to place. That is what makes it testable — Codex's and Claude Code's
 * composers are both structured this way, and both learned it the hard way
 * from editors that were tangled with their output.
 *
 * The cursor is an index into code points, never into UTF-16 units. A Hangul
 * syllable or an emoji is one character to the person typing it, and an editor
 * that lets the cursor land between two halves of one produces a string that
 * is not text.
 */

import { displayWidth } from "./width.js";

export interface ComposerSnapshot {
  text: string;
  /** Code-point index. */
  cursor: number;
}

/** A paste longer than this is kept aside and shown as a placeholder. */
export const PASTE_COLLAPSE_LINES = 8;
export const PASTE_COLLAPSE_CHARS = 800;

export class Composer {
  private chars: string[] = [];
  private pos = 0;
  /** Pasted blocks held behind their placeholders until the draft is sent. */
  private readonly pastes = new Map<number, string>();
  private pasteSequence = 0;
  private readonly history: string[] = [];
  /** Index into history while browsing, or null when editing a fresh line. */
  private browsing: number | null = null;
  /** The unsent text set aside while browsing history, restored on the way back. */
  private draft: string[] = [];

  get text(): string {
    return this.chars.join("");
  }

  get cursor(): number {
    return this.pos;
  }

  get empty(): boolean {
    return this.chars.length === 0;
  }

  snapshot(): ComposerSnapshot {
    return { text: this.text, cursor: this.pos };
  }

  /** Earlier entries, oldest first, from a previous session. */
  seedHistory(entries: readonly string[]): void {
    for (const e of entries) {
      if (e !== "" && this.history[this.history.length - 1] !== e) this.history.push(e);
    }
  }

  get historyEntries(): readonly string[] {
    return this.history;
  }

  insert(text: string): void {
    const incoming = [...text];
    this.chars.splice(this.pos, 0, ...incoming);
    this.pos += incoming.length;
    this.browsing = null;
  }

  /**
   * Insert a paste, collapsing a long one to `[paste #n: 42 lines]`.
   *
   * Claude Code's behaviour, and for the same reason: a pasted stack trace
   * or file turns the composer into a wall the person cannot see their own
   * words in. The text goes to the model whole when the draft is sent.
   */
  paste(text: string): void {
    const lines = text.split("\n").length;
    if (lines <= PASTE_COLLAPSE_LINES && text.length <= PASTE_COLLAPSE_CHARS) {
      this.insert(text);
      return;
    }
    const id = ++this.pasteSequence;
    this.pastes.set(id, text);
    this.insert(`[paste #${id}: ${lines} lines] `);
  }

  /** The draft with every paste placeholder replaced by its text. */
  expanded(text = this.text): string {
    return text.replace(/\[paste #(\d+): \d+ lines\]/g, (m, id: string) => this.pastes.get(Number(id)) ?? m);
  }

  backspace(): void {
    if (this.pos === 0) return;
    this.chars.splice(this.pos - 1, 1);
    this.pos -= 1;
  }

  deleteForward(): void {
    if (this.pos >= this.chars.length) return;
    this.chars.splice(this.pos, 1);
  }

  left(): void {
    if (this.pos > 0) this.pos -= 1;
  }

  right(): void {
    if (this.pos < this.chars.length) this.pos += 1;
  }

  /** Start of the current line, not of the whole text. */
  home(): void {
    this.pos = this.lineStart(this.pos);
  }

  /** End of the current line. */
  end(): void {
    this.pos = this.lineEnd(this.pos);
  }

  wordLeft(): void {
    let p = this.pos;
    while (p > 0 && isSpace(this.chars[p - 1]!)) p--;
    while (p > 0 && !isSpace(this.chars[p - 1]!)) p--;
    this.pos = p;
  }

  wordRight(): void {
    let p = this.pos;
    while (p < this.chars.length && isSpace(this.chars[p]!)) p++;
    while (p < this.chars.length && !isSpace(this.chars[p]!)) p++;
    this.pos = p;
  }

  deleteWordBack(): void {
    const from = this.pos;
    this.wordLeft();
    this.chars.splice(this.pos, from - this.pos);
  }

  /** Delete from the cursor to the end of the line, like Ctrl-K. */
  killToEnd(): void {
    const end = this.lineEnd(this.pos);
    this.chars.splice(this.pos, end - this.pos);
  }

  /** Delete from the start of the line to the cursor, like Ctrl-U. */
  killToStart(): void {
    const start = this.lineStart(this.pos);
    this.chars.splice(start, this.pos - start);
    this.pos = start;
  }

  clear(): void {
    this.chars = [];
    this.pos = 0;
    this.browsing = null;
  }

  /**
   * Up: a line up inside a multi-line draft; otherwise the previous history
   * entry. Returns false when there was nowhere to go.
   */
  up(): boolean {
    const start = this.lineStart(this.pos);
    if (start > 0) {
      const column = this.pos - start;
      const prevStart = this.lineStart(start - 1);
      this.pos = Math.min(prevStart + column, start - 1);
      return true;
    }
    return this.historyBack();
  }

  down(): boolean {
    const end = this.lineEnd(this.pos);
    if (end < this.chars.length) {
      const column = this.pos - this.lineStart(this.pos);
      const nextStart = end + 1;
      this.pos = Math.min(nextStart + column, this.lineEnd(nextStart));
      return true;
    }
    return this.historyForward();
  }

  /**
   * Take the text, remember it, and start again.
   *
   * Trailing whitespace goes; a message that ends in a newline is not a
   * different message. Empty submissions are not remembered, and neither is
   * an exact repeat of the last one.
   */
  submit(): string {
    const shown = this.text.replace(/\s+$/, "");
    const text = this.expanded(shown);
    // History outlives the paste map, so retain content rather than display placeholders.
    if (text !== "" && this.history[this.history.length - 1] !== text) this.history.push(text);
    this.clear();
    this.pastes.clear();
    return text;
  }

  private historyBack(): boolean {
    if (this.history.length === 0) return false;
    if (this.browsing === null) {
      this.draft = [...this.chars];
      this.browsing = this.history.length - 1;
    } else if (this.browsing > 0) {
      this.browsing -= 1;
    } else {
      return false;
    }
    this.chars = [...this.history[this.browsing]!];
    this.pos = this.chars.length;
    return true;
  }

  private historyForward(): boolean {
    if (this.browsing === null) return false;
    if (this.browsing < this.history.length - 1) {
      this.browsing += 1;
      this.chars = [...this.history[this.browsing]!];
    } else {
      this.browsing = null;
      this.chars = [...this.draft];
    }
    this.pos = this.chars.length;
    return true;
  }

  private lineStart(from: number): number {
    let p = from;
    while (p > 0 && this.chars[p - 1] !== "\n") p--;
    return p;
  }

  private lineEnd(from: number): number {
    let p = from;
    while (p < this.chars.length && this.chars[p] !== "\n") p++;
    return p;
  }
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/* ------------------------------------------------------------------ */

export interface ComposerRow {
  /** The prompt on the first row, blanks of the same width after that. */
  prefix: string;
  body: string;
}

export interface ComposerRender {
  rows: ComposerRow[];
  /** Row and column of the cursor, in the terminal's terms. */
  cursorRow: number;
  cursorCol: number;
  /** True when the body is the placeholder rather than typed text. */
  placeholder: boolean;
}

export interface ComposerRenderOptions {
  width: number;
  prompt?: string;
  placeholder?: string;
}

const DEFAULT_PROMPT = "❯ ";

/**
 * Wrap the draft to the terminal width and locate the cursor.
 *
 * Wrapped by display width, not by string length, and never inside a wide
 * character: a Hangul syllable that does not fit on the row moves whole to the
 * next one. The cursor may sit one past the last character, which on a row
 * that is exactly full means the start of the following row — the same place
 * the next typed character would land.
 */
export function renderComposer(state: ComposerSnapshot, opts: ComposerRenderOptions): ComposerRender {
  const prompt = opts.prompt ?? DEFAULT_PROMPT;
  const prefixWidth = displayWidth(prompt);
  const room = Math.max(1, opts.width - prefixWidth);
  const continuation = " ".repeat(prefixWidth);

  if (state.text === "") {
    return {
      rows: [{ prefix: prompt, body: opts.placeholder ?? "" }],
      cursorRow: 0,
      cursorCol: prefixWidth,
      placeholder: true,
    };
  }

  const rows: ComposerRow[] = [];
  let cursorRow = 0;
  let cursorCol = prefixWidth;
  let index = 0; // code-point index of the character about to be placed
  let body = "";
  let used = 0;

  const flush = (): void => {
    rows.push({ prefix: rows.length === 0 ? prompt : continuation, body });
    body = "";
    used = 0;
  };

  for (const ch of state.text) {
    if (index === state.cursor) {
      cursorRow = rows.length;
      cursorCol = prefixWidth + used;
    }
    if (ch === "\n") {
      flush();
      index += 1;
      continue;
    }
    const w = displayWidth(ch);
    if (used + w > room && used > 0) flush();
    if (index === state.cursor && used === 0) {
      // The cursor character itself wrapped; follow it.
      cursorRow = rows.length;
      cursorCol = prefixWidth;
    }
    body += ch;
    used += w;
    index += 1;
  }
  // The cursor after the last character.
  if (state.cursor >= index) {
    if (used >= room) {
      flush();
      cursorRow = rows.length;
      cursorCol = prefixWidth;
    } else {
      cursorRow = rows.length;
      cursorCol = prefixWidth + used;
    }
  }
  flush();
  return { rows, cursorRow, cursorCol, placeholder: false };
}
