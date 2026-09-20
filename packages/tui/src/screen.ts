/**
 * The screen.
 *
 * All terminal side effects live here; everything above it is pure. The whole
 * display is two regions: committed lines that were printed once and belong to
 * scrollback, and a small repainted footer holding the live tail, the composer
 * and the hint line.
 *
 * No virtual DOM, and no React. The transcript is append-only by construction,
 * so there is nothing to reconcile — printing what is newly stable and
 * repainting a few footer lines is the entire algorithm.
 *
 * Two rules keep the repaint honest, and both were learned from a corrupted
 * screen. Every footer line is at most one terminal row wide: the footer is
 * cleared by counting rows upward, and a line the terminal wrapped on its own
 * is a row the count does not know about, so a long command left its first
 * half behind on every repaint. And a resize is not a repaint: the terminal
 * reflows the rows already on screen, so the count has to be redone at the
 * new width before anything is cleared.
 *
 * The terminal's cursor is left inside the composer after each paint, so the
 * terminal's own input method composes where the text will land — Hangul
 * included — and is moved back below the footer before the next clear.
 */

import { appendCell, initialState, reduce, type Cell, type ViewState } from "./cells.js";
import type { ComposerRender } from "./composer.js";
import { heroLines, pickHero, welcomeLines, type HeroContext, type WelcomeContext } from "./hero.js";
import { BRACKETED_PASTE, KeyDecoder, type Key } from "./keys.js";
import {
  BULLET,
  renderPendingStyled,
  renderSettledStyled,
  renderTail,
  type RenderOptions,
  type StyledLine,
  type Tone,
} from "./render.js";
import { compactReadings, readings, statusLine } from "./statusline.js";
import { CommitTracker } from "./stream.js";
import { NO_COLOR, paint, severityColor, style, term } from "./theme.js";
import { displayWidth, truncateToWidth, wrapToWidth } from "./width.js";
import type { LoopEvent } from "@motifcode/core";

export interface ScreenOptions {
  write?: (s: string) => void;
  columns?: () => number;
  /** Show the model's reasoning in the transcript. Off by default. */
  showThinking?: boolean;
  /** Prefer the shaded small hero over the plain one. */
  shadedHero?: boolean;
  /**
   * Repaint a live footer. Off when stdout is not a terminal, because cursor
   * movement written into a pipe or a log file is noise, not a display.
   */
  interactive?: boolean;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** What the footer shows for the prompt: the editor's rows and, under them, a menu. */
export interface ComposerView {
  render: ComposerRender;
  /** Rows under the input — the slash-command menu — with the selected index. */
  menu?: { rows: string[]; selected: number };
}

export type KeyHandler = (key: Key) => void;

/** One painted footer row, and its plain width for the resize arithmetic. */
interface Row {
  text: string;
  width: number;
}

const SPINNER = ["✻", "✼", "✽", "✾"];

/** The keys, for the panel `?` opens. */
const SHORTCUTS = [
  "enter send · \\ + enter newline · esc interrupt or clear · ctrl-c twice quit · ctrl-d quit",
  "↑ ↓ history · tab show or hide reasoning on an empty prompt · / commands · ? hide this",
];

export class Screen {
  private state: ViewState = initialState();
  private readonly commits = new CommitTracker();
  /** The rows of the last painted footer, top to bottom. */
  private footer: Row[] = [];
  /** Where the cursor was left: the footer row index and column, or null when below the footer. */
  private cursorAt: { row: number; col: number } | null = null;
  /** The width the footer was painted at, to notice a resize. */
  private paintedWidth = 0;
  private composer: ComposerView | null = null;
  private hint = "";
  private label = "";
  private activity: { text: string; since: number } | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private tick = 0;
  private shortcutsOpen = false;
  private readonly write: (s: string) => void;
  private readonly columns: () => number;
  private showThinking: boolean;
  private readonly shadedHero: boolean;
  private readonly interactive: boolean;
  private readonly now: () => number;
  private detachInput: (() => void) | null = null;

  constructor(opts: ScreenOptions = {}) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.columns = opts.columns ?? (() => process.stdout.columns || 80);
    this.showThinking = opts.showThinking ?? false;
    this.shadedHero = opts.shadedHero ?? false;
    this.interactive = opts.interactive ?? Boolean(process.stdout.isTTY);
    this.now = opts.now ?? (() => Date.now());
  }

  get view(): ViewState {
    return this.state;
  }

  get width(): number {
    return this.columns();
  }

  get thinkingShown(): boolean {
    return this.showThinking;
  }

  get shortcutsShown(): boolean {
    return this.shortcutsOpen;
  }

  private get renderOptions(): RenderOptions {
    return {
      width: this.columns(),
      showThinking: this.showThinking,
      // Only advertise the key when something is listening for it.
      showShortcuts: this.detachInput !== null,
    };
  }

  splash(ctx: HeroContext & Partial<WelcomeContext>): void {
    const width = this.columns();
    const variant = pickHero(width, this.shadedHero);
    for (const line of heroLines(variant)) this.write(paint(line, style.accent) + "\n");
    if (variant !== "none") this.write("\n");
    if (ctx.version !== undefined && ctx.cwd !== undefined) {
      for (const line of welcomeLines({ version: ctx.version, model: ctx.model, cwd: ctx.cwd }, width)) {
        this.write(paint(line, style.faint) + "\n");
      }
    } else {
      this.write(paint(`${ctx.model}  ·  ${ctx.endpoint}  ·  ch ${ctx.channel}`, style.faint) + "\n");
    }
    this.write("\n");
  }

  /** Fold an event and repaint. */
  apply(event: LoopEvent): void {
    this.state = reduce(this.state, event);
    this.paint();
  }

  /** Add a cell the loop did not produce — a user turn, a command's output. */
  append(cell: Cell): void {
    this.state = appendCell(this.state, cell);
    this.paint();
  }

  /** Show, replace or remove the prompt at the bottom of the footer. */
  setComposer(view: ComposerView | null): void {
    this.composer = view;
    this.paint();
  }

  /** The left side of the line under the prompt; empty means `? for shortcuts`. */
  setHint(text: string): void {
    if (this.hint === text) return;
    this.hint = text;
    this.paint();
  }

  /** The fixed part of the right side of the line under the prompt — the model id. */
  setLabel(text: string): void {
    if (this.label === text) return;
    this.label = text;
    this.paint();
  }

  /**
   * What the model is doing right now, shown above the prompt with a spinner
   * and the seconds elapsed. Null when it is waiting for the person.
   */
  setActivity(text: string | null): void {
    if (text === null) {
      this.activity = null;
      if (this.ticker) {
        clearInterval(this.ticker);
        this.ticker = null;
      }
    } else {
      if (this.activity?.text !== text) this.activity = { text, since: this.now() };
      if (!this.ticker && this.interactive) {
        this.ticker = setInterval(() => {
          this.tick += 1;
          this.paint();
        }, 1000);
        // A ticker must not hold the process open once the loop is done.
        this.ticker.unref?.();
      }
    }
    this.paint();
  }

  toggleShortcuts(): void {
    this.shortcutsOpen = !this.shortcutsOpen;
    this.paint();
  }

  /**
   * Listen for keys.
   *
   * With a handler, every decoded key goes to it and nothing is interpreted
   * here. Without one — the one-shot run — the two keys the status line
   * advertises are handled: Tab folds reasoning, and Ctrl-C, which raw mode
   * would otherwise swallow, is forwarded as the interrupt it means.
   *
   * Raw mode is entered here and left in `finish()` and on every fatal signal.
   * A terminal left in raw mode after a crash needs `reset` to type in again,
   * which is a worse outcome than never having offered the shortcut.
   */
  attachInput(stdin: NodeJS.ReadStream = process.stdin, handler?: KeyHandler): void {
    if (!this.interactive || !stdin.isTTY || this.detachInput) return;

    const decoder = new KeyDecoder();
    const onData = (chunk: Buffer): void => {
      for (const key of decoder.feed(chunk)) {
        if (handler) handler(key);
        else if (key.type === "tab") this.toggleThinking();
        else if (key.type === "ctrl" && key.key === "c") process.kill(process.pid, "SIGINT");
      }
    };
    const onResize = (): void => this.paint();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    if (handler) this.write(BRACKETED_PASTE.enable);

    const restore = (): void => {
      stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      if (handler) this.write(BRACKETED_PASTE.disable);
      try {
        stdin.setRawMode(false);
      } catch {
        /* already closed */
      }
      stdin.pause();
    };
    const onFatal = (signal: NodeJS.Signals) => (): void => {
      this.finish();
      process.kill(process.pid, signal);
    };
    const handlers: [NodeJS.Signals, () => void][] = [
      ["SIGINT", onFatal("SIGINT")],
      ["SIGTERM", onFatal("SIGTERM")],
      ["SIGHUP", onFatal("SIGHUP")],
    ];
    for (const [signal, handler] of handlers) process.once(signal, handler);

    this.detachInput = () => {
      restore();
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
  }

  /** True when a key handler is attached, so the UI may advertise shortcuts. */
  get interactiveInput(): boolean {
    return this.detachInput !== null;
  }

  toggleThinking(): void {
    this.showThinking = !this.showThinking;
    // Showing rewrites lines already committed to scrollback, so the stable
    // region has to be rebuilt rather than appended to.
    this.commits.reset();
    this.clearFooter();
    this.paint();
  }

  /* ---------------------------------------------------------------- */
  /* painting                                                          */
  /* ---------------------------------------------------------------- */

  private tone(t: Tone): string | null {
    switch (t) {
      case "dim":
      case "rule":
        return style.faint;
      case "warn":
        return style.warn;
      case "bad":
        return style.bad;
      default:
        return null;
    }
  }

  /** Colour one rendered line by its tone. */
  private colour(l: StyledLine): string {
    if (NO_COLOR) return l.text;
    if (l.tone === "user") {
      // The echo of what was typed: a dim prompt mark, the words as typed.
      return paint(l.text.slice(0, 2), style.faint) + l.text.slice(2);
    }
    if (l.tone === "bullet") {
      return l.text.startsWith(BULLET) ? paint(BULLET, style.accent) + l.text.slice(BULLET.length) : l.text;
    }
    const code = this.tone(l.tone);
    return code ? paint(l.text, code) : l.text;
  }

  private paint(): void {
    this.clearFooter();
    // Only settled cells go to scrollback. A tool cell between `tool_start` and
    // `tool_end` is still growing, and committing it there would print a tool
    // that appears to have produced nothing.
    const settled = renderSettledStyled(this.state, this.renderOptions);
    const fresh = this.commits.take(settled.map((l) => l.text));
    for (const line of settled.slice(settled.length - fresh.length)) this.write(this.colour(line) + "\n");
    this.paintFooter();
  }

  /** Footer rows from text that may be longer than the width: split here, never wrapped by the terminal. */
  private rows(text: string, colourWith?: (s: string) => string): Row[] {
    const width = this.columns();
    return wrapToWidth(text, width).map((t) => ({ text: colourWith ? colourWith(t) : t, width: displayWidth(t) }));
  }

  private paintFooter(): void {
    if (!this.interactive) return;
    const width = this.columns();
    const opts = this.renderOptions;
    const rows: Row[] = [];

    for (const l of renderPendingStyled(this.state, opts)) {
      rows.push(...this.rows(l.text, (t) => this.colour({ ...l, text: t })));
    }
    for (const l of renderTail(this.state, opts)) rows.push(...this.rows(l, (t) => paint(t, style.faint)));

    if (this.activity) {
      const glyph = SPINNER[this.tick % SPINNER.length]!;
      const seconds = Math.max(0, Math.floor((this.now() - this.activity.since) / 1000));
      const text = `${glyph} ${this.activity.text} (esc to interrupt · ${seconds}s)`;
      rows.push(...this.rows(truncateToWidth(text, width), (t) => paint(t, style.faint)));
    }

    let cursor: { row: number; col: number } | null = null;
    if (this.composer) {
      const block = this.composerRows(this.composer, width);
      cursor = { row: rows.length + block.cursorRow, col: block.cursorCol };
      rows.push(...block.rows);
      rows.push(...this.hintRows(width));
      if (this.shortcutsOpen) {
        for (const s of SHORTCUTS) {
          rows.push(...this.rows(`  ${truncateToWidth(s, Math.max(1, width - 2))}`, (t) => paint(t, style.faint)));
        }
      }
    } else {
      rows.push(...this.rows(this.statusOnly(), (t) => t));
    }

    if (this.composer) this.write(term.hideCursor);
    for (const r of rows) this.write(r.text + "\n");
    this.footer = rows;
    this.paintedWidth = width;
    this.cursorAt = cursor;

    if (cursor) {
      // The cursor sits on the empty line below the footer; lift it into the
      // composer so the terminal's input method composes in the right place.
      this.write(term.up(rows.length - cursor.row) + term.column(cursor.col) + term.showCursor);
    }
  }

  /**
   * The composer block: a bordered box around the editor rows, then the menu.
   *
   * Every box row is exactly the terminal width, so the right edge lines up
   * and nothing wraps. Returns where the cursor belongs among the rows.
   */
  private composerRows(view: ComposerView, width: number): { rows: Row[]; cursorRow: number; cursorCol: number } {
    const inner = Math.max(4, width - 4);
    const border = (l: string, r: string): Row => ({
      text: paint(`${l}${"─".repeat(inner + 2)}${r}`, style.faint),
      width: inner + 4,
    });
    const rows: Row[] = [border("╭", "╮")];
    for (const row of view.render.rows) {
      const body = view.render.placeholder ? paint(row.body, style.faint) : row.body;
      const plainWidth = displayWidth(row.prefix) + displayWidth(row.body);
      const pad = " ".repeat(Math.max(0, inner - plainWidth));
      rows.push({
        text: `${paint("│ ", style.faint)}${paint(row.prefix, style.accent)}${body}${pad}${paint(" │", style.faint)}`,
        width: inner + 4,
      });
    }
    // +1 for the top border; +2 for the box's left edge.
    const cursorRow = 1 + view.render.cursorRow;
    const cursorCol = Math.min(2 + view.render.cursorCol, Math.max(0, width - 1));
    rows.push(border("╰", "╯"));
    if (view.menu) {
      view.menu.rows.forEach((row, i) => {
        const t = truncateToWidth(row, width);
        rows.push({
          text: i === view.menu!.selected ? paint(t, style.accent + style.bold) : paint(t, style.faint),
          width: displayWidth(t),
        });
      });
    }
    return { rows, cursorRow, cursorCol };
  }

  /**
   * The line under the prompt: a hint on the left, the session's numbers on
   * the right. The right side goes first when the two do not fit, and the
   * hint is never truncated — "esc cl…" tells nobody what Esc does.
   */
  private hintRows(width: number): Row[] {
    const left = this.hint === "" ? "? for shortcuts" : this.hint;
    const parts = compactReadings(this.state.instruments);
    const rightPlain = [this.label, ...parts.map((r) => `${r.label} ${r.value}`)].filter(Boolean).join(" · ");
    const rightPainted = NO_COLOR
      ? rightPlain
      : [
          this.label ? paint(this.label, style.faint) : "",
          ...parts.map((r) => paint(`${r.label} ${r.value}`, severityColor(r.severity))),
        ]
          .filter(Boolean)
          .join(paint(" · ", style.dim));
    const leftText = `  ${truncateToWidth(left, Math.max(1, width - 2))}`;
    const gap = width - displayWidth(leftText) - displayWidth(rightPlain);
    if (rightPlain === "" || gap < 2) return [{ text: paint(leftText, style.faint), width: displayWidth(leftText) }];
    return [{ text: `${paint(leftText, style.faint)}${" ".repeat(gap)}${rightPainted}`, width }];
  }

  /** The one-shot run's status line: the full instrument panel. */
  private statusOnly(): string {
    if (NO_COLOR) return statusLine(this.state.instruments);
    return readings(this.state.instruments)
      .map((r) => {
        const body = r.label ? `${paint(r.label, style.dim)} ${r.value}` : r.value;
        return paint(body, severityColor(r.severity));
      })
      .join(paint("  ·  ", style.dim));
  }

  /**
   * Erase the footer, wherever the terminal has left it.
   *
   * At the width it was painted at, each footer row is one terminal row and
   * the cursor is a known number of rows above the line below the footer. After
   * a resize the terminal has reflowed those rows: a row wider than the new
   * width now occupies several, and the cursor stays with its text. Both are
   * recomputed from the plain widths kept per row. This assumes a terminal
   * that reflows on resize, which Terminal.app, iTerm2 and most others do.
   */
  private clearFooter(): void {
    if (!this.interactive || this.footer.length === 0) return;
    const width = this.columns();
    const narrowed = width < this.paintedWidth;
    const rowsOf = (w: number): number => (narrowed ? Math.max(1, Math.ceil(w / width)) : 1);
    const total = this.footer.reduce((n, r) => n + rowsOf(r.width), 0);

    if (this.cursorAt) {
      // Back to the line below the footer, where the arithmetic expects it.
      const own = this.footer[this.cursorAt.row]!;
      const within = narrowed ? Math.floor(this.cursorAt.col / width) : 0;
      let below = rowsOf(own.width) - 1 - within;
      for (let i = this.cursorAt.row + 1; i < this.footer.length; i++) below += rowsOf(this.footer[i]!.width);
      this.write(term.down(below + 1) + term.lineStart);
      this.cursorAt = null;
    }
    this.write(term.up(total));
    for (let i = 0; i < total; i++) {
      this.write(term.clearLine + term.lineStart);
      if (i < total - 1) this.write("\n");
    }
    this.write(term.up(total - 1));
    this.footer = [];
  }

  /** Release the footer so the shell prompt lands cleanly. */
  finish(): void {
    this.detachInput?.();
    this.detachInput = null;
    this.setActivity(null);
    this.composer = null;
    this.hint = "";
    this.clearFooter();
    // Flush anything still pending — a session that ended mid-tool should still
    // show what that tool did.
    const rest = renderPendingStyled(this.state, this.renderOptions);
    const all = renderSettledStyled(this.state, this.renderOptions).concat(rest);
    const fresh = this.commits.take(all.map((l) => l.text));
    for (const line of all.slice(all.length - fresh.length)) this.write(this.colour(line) + "\n");
    if (this.interactive) this.write(term.showCursor);
  }
}
