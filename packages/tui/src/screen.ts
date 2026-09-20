/**
 * The screen.
 *
 * All terminal side effects live here; everything above it is pure. The whole
 * display is two regions: committed lines that were printed once and belong to
 * scrollback, and a small repainted footer holding the live tail, the composer
 * and the status line.
 *
 * No virtual DOM, and no React. The transcript is append-only by construction,
 * so there is nothing to reconcile — printing what is newly stable and
 * repainting a few footer lines is the entire algorithm.
 *
 * The composer is part of the footer. It is repainted with everything else,
 * and the only thing that distinguishes it is that the terminal's cursor is
 * left inside it afterwards, so the terminal's own input-method composition
 * lands where the text will. That is the one piece of cursor arithmetic in the
 * program: lift the cursor into the composer after a paint, drop it back below
 * the footer before the next clear.
 */

import { appendCell, initialState, reduce, type Cell, type ViewState } from "./cells.js";
import type { ComposerRender } from "./composer.js";
import { heroLines, heroSubtitle, pickHero, type HeroContext } from "./hero.js";
import { BRACKETED_PASTE, KeyDecoder, type Key } from "./keys.js";
import { renderPending, renderSettled, renderTail, type RenderOptions } from "./render.js";
import { readings, statusLine } from "./statusline.js";
import { CommitTracker } from "./stream.js";
import { NO_COLOR, paint, severityColor, style, term } from "./theme.js";
import { displayWidth, truncateToWidth } from "./width.js";
import type { LoopEvent } from "@motifcode/core";

export interface ScreenOptions {
  write?: (s: string) => void;
  columns?: () => number;
  expandThinking?: boolean;
  /** Prefer the shaded small hero over the plain one. */
  shadedHero?: boolean;
  /**
   * Repaint a live footer. Off when stdout is not a terminal, because cursor
   * movement written into a pipe or a log file is noise, not a display.
   */
  interactive?: boolean;
}

/** What the footer shows for the prompt: the editor's rows and, under them, a menu. */
export interface ComposerView {
  render: ComposerRender;
  /** Rows under the input — the slash-command menu — with the selected index. */
  menu?: { rows: string[]; selected: number };
}

export type KeyHandler = (key: Key) => void;

export class Screen {
  private state: ViewState = initialState();
  private readonly commits = new CommitTracker();
  private footerHeight = 0;
  /** Lines the cursor was moved up into the composer after the last paint. */
  private cursorLift = 0;
  private composer: ComposerView | null = null;
  private hint = "";
  private readonly write: (s: string) => void;
  private readonly columns: () => number;
  private expandThinking: boolean;
  private readonly shadedHero: boolean;
  private readonly interactive: boolean;
  private detachInput: (() => void) | null = null;

  constructor(opts: ScreenOptions = {}) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.columns = opts.columns ?? (() => process.stdout.columns || 80);
    this.expandThinking = opts.expandThinking ?? false;
    this.shadedHero = opts.shadedHero ?? false;
    this.interactive = opts.interactive ?? Boolean(process.stdout.isTTY);
  }

  get view(): ViewState {
    return this.state;
  }

  get width(): number {
    return this.columns();
  }

  get thinkingExpanded(): boolean {
    return this.expandThinking;
  }

  private get renderOptions(): RenderOptions {
    return {
      width: this.columns(),
      expandThinking: this.expandThinking,
      // Only advertise the key when something is listening for it.
      showShortcuts: this.detachInput !== null,
    };
  }

  splash(ctx: HeroContext): void {
    const width = this.columns();
    const variant = pickHero(width, this.shadedHero);
    const art = heroLines(variant);
    const lines = [...art, "", ...heroSubtitle(ctx)];
    for (const line of art) this.write(paint(line, style.accent) + "\n");
    for (const line of lines.slice(art.length)) this.write(paint(line, style.faint) + "\n");
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

  /** Text shown at the right end of the status line. */
  setHint(text: string): void {
    if (this.hint === text) return;
    this.hint = text;
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
    this.expandThinking = !this.expandThinking;
    // Expanding rewrites lines already committed to scrollback, so the stable
    // region has to be rebuilt rather than appended to.
    this.commits.reset();
    this.clearFooter();
    this.paint();
  }

  private paint(): void {
    this.clearFooter();
    // Only settled cells go to scrollback. A tool cell between `tool_start` and
    // `tool_end` is still growing, and committing it there would print a tool
    // that appears to have produced nothing.
    const settled = renderSettled(this.state, this.renderOptions);
    for (const line of this.commits.take(settled)) this.write(line + "\n");
    this.paintFooter();
  }

  private paintFooter(): void {
    if (!this.interactive) return;
    const opts = this.renderOptions;
    const lines = [...renderPending(this.state, opts), ...renderTail(this.state, opts)];
    let cursorRow = -1;
    let cursorCol = 0;
    if (this.composer) {
      const block = this.paintComposer(this.composer);
      cursorRow = lines.length + block.cursorRow;
      cursorCol = block.cursorCol;
      lines.push(...block.lines);
    }
    lines.push(...this.paintStatus());

    if (this.composer) this.write(term.hideCursor);
    for (const line of lines) this.write(line + "\n");
    this.footerHeight = lines.length;

    if (cursorRow >= 0) {
      // The cursor sits on the empty line below the footer; lift it into the
      // composer so the terminal's input method composes in the right place.
      this.cursorLift = this.footerHeight - cursorRow;
      this.write(term.up(this.cursorLift) + term.column(cursorCol) + term.showCursor);
    }
  }

  /**
   * The composer block: a rule, the editor rows, then the menu.
   *
   * Returns painted lines plus where the cursor belongs among them.
   */
  private paintComposer(view: ComposerView): { lines: string[]; cursorRow: number; cursorCol: number } {
    const width = this.columns();
    const lines: string[] = [paint("─".repeat(Math.max(0, width)), style.faint)];
    for (const row of view.render.rows) {
      const body = view.render.placeholder ? paint(row.body, style.faint) : row.body;
      lines.push(paint(row.prefix, style.accent) + body);
    }
    // +1 for the rule above the rows.
    const cursorRow = 1 + view.render.cursorRow;
    const cursorCol = Math.min(view.render.cursorCol, Math.max(0, width - 1));
    if (view.menu) {
      view.menu.rows.forEach((row, i) => {
        lines.push(i === view.menu!.selected ? paint(row, style.accent + style.bold) : paint(row, style.faint));
      });
    }
    return { lines, cursorRow, cursorCol };
  }

  /**
   * The status line, and the hint.
   *
   * The hint sits at the right edge when it fits and on its own line when it
   * does not. Never truncated: "esc cl…" tells nobody what Esc does, and the
   * hint is there for the moments — a running task, a queued message, a
   * half-pressed quit — when the user most needs the whole sentence. Neither
   * line ever wraps, because a footer line that wraps breaks the line count
   * and every repaint after that clears the wrong lines.
   */
  private paintStatus(): string[] {
    const width = this.columns();
    const plainLeft = statusLine(this.state.instruments);
    const left = NO_COLOR
      ? plainLeft
      : readings(this.state.instruments)
          .map((r) => {
            const body = r.label ? `${paint(r.label, style.dim)} ${r.value}` : r.value;
            return paint(body, severityColor(r.severity));
          })
          .join(paint("  ·  ", style.dim));
    if (this.hint === "") return [left];
    // Widths from the plain text: the painted string carries escape codes,
    // which occupy no columns but are characters all the same.
    const gap = width - displayWidth(plainLeft) - displayWidth(this.hint);
    if (gap >= 2) return [`${left}${" ".repeat(gap)}${paint(this.hint, style.faint)}`];
    return [left, paint(truncateToWidth(this.hint, Math.max(1, width)), style.faint)];
  }

  private clearFooter(): void {
    if (!this.interactive || this.footerHeight === 0) return;
    if (this.cursorLift > 0) {
      // Back to the line below the footer, where the arithmetic expects it.
      this.write(term.down(this.cursorLift) + term.lineStart);
      this.cursorLift = 0;
    }
    this.write(term.up(this.footerHeight));
    for (let i = 0; i < this.footerHeight; i++) {
      this.write(term.clearLine + term.lineStart);
      if (i < this.footerHeight - 1) this.write("\n");
    }
    this.write(term.up(this.footerHeight - 1));
    this.footerHeight = 0;
  }

  /** Release the footer so the shell prompt lands cleanly. */
  finish(): void {
    this.detachInput?.();
    this.detachInput = null;
    this.composer = null;
    this.hint = "";
    this.clearFooter();
    // Flush anything still pending — a session that ended mid-tool should still
    // show what that tool did.
    const rest = renderPending(this.state, this.renderOptions);
    const all = renderSettled(this.state, this.renderOptions).concat(rest);
    for (const line of this.commits.take(all)) this.write(line + "\n");
    if (this.interactive) this.write(term.showCursor);
  }
}
