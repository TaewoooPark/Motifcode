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
 * half behind on every repaint. And a narrowing is not a repaint. Terminals
 * reflow what is on screen when they are narrowed, each in its own way and
 * with the cursor wherever they choose to leave it — measured on tmux, which
 * splits every over-wide row and parks the cursor at the top — so nothing
 * written before the resize can be found again by counting. Instead the
 * visible screen is erased and rebuilt: the tail of the transcript at the
 * new width, then the footer. This is what Claude Code's renderer does when
 * the terminal changes under it, and it has the cost it has there: Terminal
 * and iTerm keep the erased screen in scrollback, so each narrowing leaves a
 * copy behind. A widening costs nothing — no row that fitted before can wrap
 * now — so it is an ordinary repaint, unless the height also changes. A
 * height change can clip rows below the composer cursor and needs a rebuild.
 *
 * The terminal's cursor is left inside the composer after each paint, so the
 * terminal's own input method composes where the text will land — Hangul
 * included — and is moved back below the footer before the next clear.
 */

import { appendCell, initialState, reduce, type Cell, type ViewState } from "./cells.js";
import { renderComposer, type ComposerSnapshot } from "./composer.js";
import { heroLines, pickHero, welcomeLines, type HeroContext, type WelcomeContext } from "./hero.js";
import { BRACKETED_PASTE, KeyDecoder, type Key } from "./keys.js";
import { renderMenu, type MenuItem } from "./menu.js";
import { renderPanel, type PanelView } from "./panel.js";
import {
  BULLET,
  renderCellStyled,
  renderPendingStyled,
  renderSettledStyled,
  renderTailStyled,
  settledCount,
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
  /** Show tool output in full rather than clipped. Off by default. */
  verbose?: boolean;
  /** The working directory, so paths under it are shown relative to it. */
  cwd?: string;
  /** Prefer the shaded small hero over the plain one. */
  shadedHero?: boolean;
  /**
   * Repaint a live footer. Off when stdout is not a terminal, because cursor
   * movement written into a pipe or a log file is noise, not a display.
   */
  interactive?: boolean;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Terminal height, for rebuilding the screen after a resize. */
  rows?: () => number;
}

/**
 * What the footer shows for the prompt: the draft, and under it a menu.
 *
 * The draft and the menu items, not their rows: rows depend on the width,
 * and the width is the screen's to know. A composer rendered by the
 * controller at one width and painted by the screen at another was how a
 * resize left a 120-column row on a 70-column screen.
 */
export interface ComposerView {
  draft: ComposerSnapshot;
  /** Recognized slash-command token, in code points of the draft. */
  commandRange?: { start: number; end: number };
  placeholder?: string;
  /**
   * A question in place of the input: what is about to run, and the
   * answers, one per line, the selected one marked with `❯`. While it
   * shows, the draft is kept but not painted.
   */
  confirm?: { title: string; lines: string[]; choices: string[] };
  /**
   * A secret being typed — an API key. The title and lines sit above the
   * input, the draft is painted as one `•` per character, and no menu opens.
   */
  secret?: { title: string; lines: string[]; prompt: string };
  /** The menu under the input: the matching items, which is selected, and their prefix (`/` or `@`). */
  menu?: { items: MenuItem[]; selected: number; prefix?: string };
  /** Settings and session readings, temporarily replacing the draft. */
  panel?: PanelView;
}

export type KeyHandler = (key: Key) => void;

/** One painted footer row, and its plain width for the resize arithmetic. */
interface Row {
  text: string;
  width: number;
  /** A mutable leading bullet can pulse without recolouring its body. */
  bulletTail?: string;
}

const SPINNER = ["✻", "✼", "✽", "✾"];

/** The keys, for the panel `?` opens. */
const SHORTCUTS = [
  "enter send · \\ + enter newline · esc interrupt or clear · ctrl-c twice quit · ctrl-d quit",
  "↑ ↓ history · tab show or hide reasoning · ctrl-o full tool output · ctrl-l redraw · shift-tab permissions",
  "@ attach a file · ! run a shell line · # add a project note · / commands · ? hide this",
];

/**
 * `**bold**` and `` `code` `` inside a line of prose.
 *
 * Only these two: they are what the model writes most, and both survive a
 * terminal that shows them raw. Anything more — links, italics with a lone
 * underscore — is left as written, since a mis-rendered `_` in an identifier
 * is worse than an un-rendered emphasis.
 */
function inlineMarkup(text: string): string {
  if (NO_COLOR) return text;
  return text
    .replace(/`([^`\n]+)`/g, (_m, code: string) => paint(code, style.accent))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, bold: string) => `${style.bold}${bold}${style.reset}`);
}

export class Screen {
  private state: ViewState = initialState();
  private readonly commits = new CommitTracker();
  /** The settled lines for the cells and options they were rendered from; a keystroke changes neither. */
  private settledMemo: { cells: readonly unknown[]; key: string; lines: StyledLine[] } | null = null;
  /** The rows of the last painted footer, top to bottom. */
  private footer: Row[] = [];
  /** Where the cursor was left: the footer row index and column, or null when below the footer. */
  private cursorAt: { row: number; col: number } | null = null;
  /** The width the footer was painted at, to notice a resize. */
  private paintedWidth = 0;
  /** A height change may clip the footer even when its contents are unchanged. */
  private paintedHeight = 0;
  private composer: ComposerView | null = null;
  private hint = "";
  private label = "";
  private activity: { text: string; since: number } | null = null;
  private working = false;
  private ticker: NodeJS.Timeout | null = null;
  private tick = 0;
  private shortcutsOpen = false;
  private readonly write: (s: string) => void;
  private readonly columns: () => number;
  private readonly rowCount: () => number;
  private resizeTimer: NodeJS.Timeout | null = null;
  private streamTimer: NodeJS.Timeout | null = null;
  private showThinking: boolean;
  private verbose = false;
  private cwd: string | undefined;
  private readonly shadedHero: boolean;
  private readonly interactive: boolean;
  private readonly now: () => number;
  private detachInput: (() => void) | null = null;

  constructor(opts: ScreenOptions = {}) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.columns = opts.columns ?? (() => process.stdout.columns || 80);
    this.rowCount = opts.rows ?? (() => process.stdout.rows || 24);
    this.showThinking = opts.showThinking ?? false;
    this.verbose = opts.verbose ?? false;
    this.cwd = opts.cwd;
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
      ...(this.verbose ? { outputLines: 1000 } : {}),
      ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
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
    if (event.type === "stream") {
      // Tokens arrive faster than a footer is worth repainting. The cap only
      // limits the rate; an unchanged footer is not painted at all.
      if (this.streamTimer) return;
      this.streamTimer = setTimeout(() => {
        this.streamTimer = null;
        this.paint();
      }, 40);
      this.streamTimer.unref?.();
      return;
    }
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
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

  /** The terminal's window title, when this is a terminal. */
  setTitle(text: string): void {
    if (!this.interactive) return;
    this.write(`\x1b]0;${text.replace(/[\x00-\x1f\x07]/g, "")}\x07`);
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
    if (this.activity?.text === text || (text === null && this.activity === null)) return;
    this.activity = text === null ? null : { text, since: this.now() };
    this.updateTicker();
    this.paint();
  }

  /** Work can continue after the activity label is replaced by streamed prose. */
  setWorking(working: boolean): void {
    if (this.working === working) return;
    this.working = working;
    this.tick = 0;
    this.updateTicker();
    this.paint();
  }

  private updateTicker(): void {
    const needed = this.interactive && (this.activity !== null || (this.working && !NO_COLOR));
    if (!needed && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    } else if (needed && !this.ticker) {
      this.ticker = setInterval(() => {
        this.tick += 1;
        this.paint(this.working);
      }, 1000);
      // A ticker must not hold the process open once the loop is done.
      this.ticker.unref?.();
    }
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
    // A drag sends a burst of resizes; one repaint at the end is enough.
    // Narrower or a different height means a rebuild; wider is a repaint.
    const onResize = (): void => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        if (this.columns() < this.paintedWidth || this.rowCount() !== this.paintedHeight) this.repaintAll();
        else this.paint();
      }, 40);
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    if (handler) this.write(BRACKETED_PASTE.enable);

    const restore = (): void => {
      stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      if (this.resizeTimer) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = null;
      }
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
    this.paint();
  }

  /* ---------------------------------------------------------------- */
  /* painting                                                          */
  /* ---------------------------------------------------------------- */

  private tone(t: Tone): string | null {
    switch (t) {
      case "dim":
      case "rule":
      case "code":
        return style.faint;
      case "warn":
        return style.warn;
      case "bad":
        return style.bad;
      case "ok":
        return style.ok;
      case "heading":
        return style.bold;
      default:
        return null;
    }
  }

  /** Colour one rendered line by its tone, with inline emphasis in prose. */
  private colour(l: StyledLine): string {
    if (NO_COLOR) return l.text;
    if (l.tone === "user") {
      // The echo of what was typed: a dim prompt mark, the words as typed.
      return paint(l.text.slice(0, 2), style.faint) + l.text.slice(2);
    }
    if (l.tone === "bullet" || l.tone === "plain") {
      const body = inlineMarkup(l.text);
      return l.tone === "bullet" && body.startsWith(BULLET) ? paint(BULLET, style.accent) + body.slice(BULLET.length) : body;
    }
    const code = this.tone(l.tone);
    return code ? paint(l.text, code) : l.text;
  }

  /** Paths under this directory are shown relative to it from now on. */
  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.commits.reset();
    this.paint();
  }

  /** Show tool output whole, or clipped to a few lines. Ctrl-O in the session. */
  toggleVerbose(): void {
    this.verbose = !this.verbose;
    this.commits.reset();
    this.paint();
  }

  get verboseOutput(): boolean {
    return this.verbose;
  }

  /** Erase and rebuild the visible screen. Ctrl-L in the session. */
  redraw(): void {
    this.repaintAll();
  }

  private paint(tickOnly = false): void {
    if (
      this.interactive && this.footer.length > 0 &&
      (this.columns() < this.paintedWidth || this.rowCount() !== this.paintedHeight)
    ) {
      // Resized since the last paint, with or without a resize event: rows
      // may have reflowed or been clipped, so their old positions are stale.
      this.repaintAll();
      return;
    }
    const width = this.columns();
    const next = this.interactive ? this.buildFooter(width) : null;
    const settled = this.settledLines();
    const pending = Math.max(0, settled.length - this.commits.count);
    // Compare before clearing. A hidden reasoning token changes no row, and
    // erasing the footer to draw it back is the flash.
    if (pending === 0 && this.sameFooter(next, width)) return;
    if (tickOnly && pending === 0 && next && this.paintTick(next, width)) return;
    this.withSync(() => {
      this.clearFooter();
      // Only settled cells go to scrollback. A tool cell between `tool_start` and
      // `tool_end` is still growing, and committing it there would print a tool
      // that appears to have produced nothing.
      const fresh = this.commits.take(settled.map((l) => l.text));
      for (const line of settled.slice(settled.length - fresh.length)) this.write(this.colour(line) + "\n");
      if (next) this.writeFooter(next, width);
      else this.paintFooter();
    });
  }

  /** A pulse must not append footer copies to scrollback or disturb the editor. */
  private paintTick(next: { rows: Row[]; cursor: { row: number; col: number } | null }, width: number): boolean {
    if (this.paintedWidth !== width || this.footer.length !== next.rows.length) return false;
    if (this.cursorAt?.row !== next.cursor?.row || this.cursorAt?.col !== next.cursor?.col) return false;
    // A long live reply can extend above the viewport. Never clamp a move to
    // an off-screen row onto the terminal's first visible line.
    const firstVisible = Math.max(0, next.rows.length - this.rowCount() + 1);
    const changed = next.rows.flatMap((row, i) => i >= firstVisible && row.text !== this.footer[i]!.text ? [i] : []);
    if (changed.length > 0) this.withSync(() => {
      const anchor = this.cursorAt?.row ?? next.rows.length;
      let at = anchor;
      this.write(term.hideCursor);
      for (const i of changed) {
        this.write(term.up(at - i) + term.down(i - at) + term.lineStart + term.clearLine + next.rows[i]!.text);
        at = i;
      }
      this.write(term.up(at - anchor) + term.down(anchor - at) + term.column(this.cursorAt?.col ?? 0) + (this.cursorAt || !this.composer ? term.showCursor : term.hideCursor));
    });
    this.footer = next.rows;
    return true;
  }

  /** True when the footer about to be drawn is the one already on screen. */
  private sameFooter(next: { rows: Row[]; cursor: { row: number; col: number } | null } | null, width: number): boolean {
    if (!this.interactive || next === null) return true;
    if (this.paintedWidth !== width || this.footer.length !== next.rows.length) return false;
    if (this.cursorAt?.row !== next.cursor?.row || this.cursorAt?.col !== next.cursor?.col) return false;
    return this.footer.every((row, i) => row.text === next.rows[i]!.text);
  }

  /**
   * One terminal update. Synchronized output is requested only while a footer
   * is actually being replaced; a skipped paint writes neither sequence.
   */
  private withSync(body: () => void): void {
    if (!this.interactive) {
      body();
      return;
    }
    this.write(term.beginSync);
    try {
      body();
    } finally {
      this.write(term.endSync);
    }
  }

  /**
   * The settled transcript, rendered once per change.
   *
   * Every keystroke repaints the footer, and the footer's arithmetic starts
   * from the settled lines; re-rendering a long transcript for each
   * character typed is work whose result is already known.
   */
  private settledLines(): StyledLine[] {
    const opts = this.renderOptions;
    const key = `${opts.width}|${opts.showThinking ? 1 : 0}|${opts.outputLines ?? ""}|${opts.showShortcuts ? 1 : 0}|${opts.cwd ?? ""}`;
    if (this.settledMemo && this.settledMemo.cells === this.state.cells && this.settledMemo.key === key) return this.settledMemo.lines;
    const lines = renderSettledStyled(this.state, opts);
    this.settledMemo = { cells: this.state.cells, key, lines };
    return lines;
  }

  /**
   * Rebuild the visible screen after a resize.
   *
   * Nothing on screen can be trusted to be where it was: the terminal has
   * reflowed it. So the screen is erased — scrollback stays — and refilled
   * with as much of the transcript's tail as fits above the footer, wrapped
   * here at the new width, then the footer itself. Lines already committed
   * stay committed; they are being redrawn, not re-emitted.
   */
  private repaintAll(): void {
    if (!this.interactive) return;
    const width = this.columns();
    const settled = this.settledLines();
    const fresh = this.commits.take(settled.map((l) => l.text));
    const previous = settled.slice(0, settled.length - fresh.length);
    const footer = this.buildFooter(width);
    const physical: string[] = [];
    for (const l of previous) for (const t of wrapToWidth(l.text, width)) physical.push(this.colour({ ...l, text: t }));
    const keep = Math.max(0, this.rowCount() - footer.rows.length - 1);
    this.withSync(() => {
      this.footer = [];
      this.cursorAt = null;
      this.write(term.clearScreen + term.home);
      for (const line of physical.slice(Math.max(0, physical.length - keep))) this.write(line + "\n");
      // Commit newly settled text even when completion raced the resize.
      for (const line of settled.slice(previous.length)) this.write(this.colour(line) + "\n");
      this.writeFooter(footer, width);
    });
  }

  /** Footer rows from text that may be longer than the width: split here, never wrapped by the terminal. */
  private rows(text: string, colourWith?: (s: string) => string): Row[] {
    const width = this.columns();
    return wrapToWidth(text, width).map((t) => ({ text: colourWith ? colourWith(t) : t, width: displayWidth(t) }));
  }

  private paintFooter(): void {
    if (!this.interactive) return;
    const width = this.columns();
    this.writeFooter(this.buildFooter(width), width);
  }

  /** The footer's rows for a width, and where the cursor belongs among them. */
  private buildFooter(width: number): { rows: Row[]; cursor: { row: number; col: number } | null } {
    const opts = { ...this.renderOptions, width };
    const rows: Row[] = [];
    const liveRows = (l: StyledLine, mutable = true): Row[] => wrapToWidth(l.text, width).map((text, i) => ({
      text: this.colour({ ...l, text }),
      width: displayWidth(text),
      ...(mutable && i === 0 && text.startsWith(BULLET) ? { bulletTail: this.colour({ ...l, text: text.slice(BULLET.length) }) } : {}),
    }));

    for (const cell of this.state.cells.slice(settledCount(this.state))) {
      for (const l of renderCellStyled(cell, opts)) rows.push(...liveRows(l, cell.kind === "tool" && cell.ok === undefined));
    }
    for (const l of renderTailStyled(this.state, opts)) rows.push(...liveRows(l));

    if (this.activity) {
      const glyph = this.working ? BULLET : SPINNER[this.tick % SPINNER.length]!;
      const seconds = Math.max(0, Math.floor((this.now() - this.activity.since) / 1000));
      const text = `${glyph} ${this.activity.text} (esc to interrupt · ${seconds}s)`;
      rows.push(...liveRows({ text: truncateToWidth(text, width), tone: "dim" }));
    }

    const beforeComposer = rows.length;
    let cursor: { row: number; col: number } | null = null;
    if (this.composer?.panel && !this.composer.confirm && !this.composer.secret) {
      const block = renderPanel(this.composer.panel, { width, height: Math.max(0, this.rowCount() - 1 - Number(this.working)) });
      if (block.cursor) cursor = { row: rows.length + block.cursor.row, col: block.cursor.col };
      rows.push(...block.rows);
    } else if (this.composer) {
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
    if (this.working) {
      const firstVisible = Math.max(0, rows.length - this.rowCount() + 1);
      let target = rows.findLastIndex((row, i) => i >= firstVisible && row.bulletTail !== undefined);
      // Hidden reasoning, settled prose and a long live reply all need an
      // indicator near the composer when their own bullet is not visible.
      if (target < 0) {
        const fallback = liveRows({ text: truncateToWidth(`${BULLET} Working…`, width), tone: "bullet" });
        rows.splice(beforeComposer, 0, ...fallback);
        if (cursor) cursor.row += fallback.length;
        target = beforeComposer;
      }
      const row = rows[target]!;
      if (row.bulletTail !== undefined) {
        // Explicitly hide the glyph: terminal dim styling is not reliably
        // visible, and ANSI blink depends on the terminal's preferences.
        const dot = !NO_COLOR && this.tick % 2 === 1 ? " ".repeat(displayWidth(BULLET)) : paint(BULLET, style.accent);
        row.text = dot + row.bulletTail;
      }
    }
    // Leave one row below the footer for the parked cursor. Only the newest
    // live rows are visible; omitted rows remain live and are never committed.
    const limit = Math.max(0, this.rowCount() - 1);
    let start = Math.max(0, rows.length - limit);
    // A large draft/menu can itself exceed the viewport. Keep the editing
    // cursor visible instead of showing only the end of the composer.
    if (cursor && cursor.row < start) start = Math.max(0, cursor.row - Math.floor(limit / 2));
    return {
      rows: rows.slice(start, start + limit),
      cursor: cursor && cursor.row >= start && cursor.row < start + limit
        ? { row: cursor.row - start, col: cursor.col } : null,
    };
  }

  private writeFooter(footer: { rows: Row[]; cursor: { row: number; col: number } | null }, width: number): void {
    const { rows, cursor } = footer;
    if (this.composer) this.write(term.hideCursor);
    // Reserve room while it contains only cleared/settled content. Advancing
    // after drawing a live row could scroll that row into permanent history.
    this.write(term.lineStart + term.index.repeat(rows.length) + term.up(rows.length));
    for (const r of rows) this.write(r.text + term.down(1) + term.lineStart);
    this.footer = rows;
    this.paintedWidth = width;
    this.paintedHeight = this.rowCount();
    this.cursorAt = cursor;

    if (cursor) {
      // The cursor sits on the empty line below the footer; lift it into the
      // composer so the terminal's input method composes in the right place.
      this.write(term.up(rows.length - cursor.row) + term.column(cursor.col) + term.showCursor);
    } else if (rows.length === 0) this.write(term.showCursor);
  }

  /**
   * The composer block: a bordered box around the editor rows, then the menu.
   *
   * Every box row is exactly the terminal width, so the right edge lines up
   * and nothing wraps. Returns where the cursor belongs among the rows.
   */
  private composerRows(view: ComposerView, width: number): { rows: Row[]; cursorRow: number; cursorCol: number } {
    const boxed = width >= 8;
    const inner = boxed ? width - 4 : Math.max(1, width);
    // Box drawing is Ambiguous-width in Unicode. ASCII decorations preserve
    // the four-column frame on terminals configured to render it wide.
    const wideBox = displayWidth("─") > 1;
    const side = wideBox ? "|" : "│";
    const left = boxed ? `${side} ` : "";
    const right = boxed ? ` ${side}` : "";
    const edge = boxed ? 2 : 0;
    // The box takes four columns: its edges and a space inside each.
    const draft = view.secret
      ? { text: "•".repeat([...view.draft.text].length), cursor: view.draft.cursor }
      : view.draft;
    const render = renderComposer(draft, {
      width: inner,
      prompt: view.secret ? view.secret.prompt : "> ",
      ...(view.placeholder !== undefined && !view.secret ? { placeholder: view.placeholder } : {}),
      ...(view.commandRange && !view.secret ? { commandRange: view.commandRange } : {}),
    });
    const border = (l: string, r: string): Row => ({
      text: paint(`${wideBox ? "+" : l}${(wideBox ? "-" : "─").repeat(inner + 2)}${wideBox ? "+" : r}`, style.faint),
      width: inner + 4,
    });
    const rows: Row[] = boxed ? [border("╭", "╮")] : [];
    if (view.confirm) {
      const fit = (s: string): string => {
        const t = truncateToWidth(s, inner);
        return `${t}${" ".repeat(Math.max(0, inner - displayWidth(t)))}`;
      };
      const body = [view.confirm.title, ...view.confirm.lines.map((l) => `  ${l}`), "", ...view.confirm.choices];
      const firstChoice = body.length - view.confirm.choices.length;
      for (const [i, l] of body.entries()) {
        const painted =
          i === 0
            ? paint(fit(l), style.bold)
            : i >= firstChoice
              ? l.startsWith("❯")
                ? paint(fit(l), style.accent)
                : paint(fit(l), style.faint)
              : fit(l);
        rows.push({ text: `${paint(left, style.faint)}${painted}${paint(right, style.faint)}`, width });
      }
      if (boxed) rows.push(border("╰", "╯"));
      // The cursor rests on the selected choice; there is nothing to type.
      const selectedLine = view.confirm.choices.findIndex((c) => c.startsWith("❯"));
      return { rows, cursorRow: Number(boxed) + firstChoice + Math.max(0, selectedLine), cursorCol: edge };
    }
    let header = 0;
    if (view.secret) {
      const fit = (s: string): string => {
        const t = truncateToWidth(s, inner);
        return `${t}${" ".repeat(Math.max(0, inner - displayWidth(t)))}`;
      };
      // Wrapped, not truncated: a URL cut short cannot be typed into a browser.
      const body: { text: string; title: boolean }[] = [];
      for (const l of wrapToWidth(view.secret.title, inner)) body.push({ text: l, title: true });
      for (const line of view.secret.lines) for (const l of wrapToWidth(line, inner)) body.push({ text: l, title: false });
      body.push({ text: "", title: false });
      for (const { text, title } of body) {
        const painted = title ? paint(fit(text), style.bold) : paint(fit(text), style.faint);
        rows.push({ text: `${paint(left, style.faint)}${painted}${paint(right, style.faint)}`, width });
      }
      header = body.length;
    }
    for (const row of render.rows) {
      const range = row.commandRange;
      const body = render.placeholder ? paint(row.body, style.faint) : range
        ? row.body.slice(0, range.start) + paint(row.body.slice(range.start, range.end), style.accent) + row.body.slice(range.end)
        : row.body;
      const plainWidth = displayWidth(row.prefix) + displayWidth(row.body);
      const pad = " ".repeat(Math.max(0, inner - plainWidth));
      rows.push({
        text: `${paint(left, style.faint)}${paint(row.prefix, style.accent)}${body}${pad}${paint(right, style.faint)}`,
        width,
      });
    }
    // +1 for the top border, plus any header rows; +2 for the box's left edge.
    const cursorRow = Number(boxed) + header + render.cursorRow;
    const cursorCol = Math.min(edge + render.cursorCol, Math.max(0, width - 1));
    if (boxed) rows.push(border("╰", "╯"));
    if (view.menu && view.menu.items.length > 0 && !view.secret) {
      // Reserve the composer, hint and parked cursor before sizing the menu.
      // Its own window follows the selection even on a short terminal.
      const maxRows = Math.max(0, Math.min(8, this.rowCount() - rows.length - 2));
      const menu = maxRows > 0
        ? renderMenu(view.menu.items, view.menu.selected, { width, maxRows, ...(view.menu.prefix ? { prefix: view.menu.prefix } : {}) })
        : { rows: [], selectedRow: -1 };
      menu.rows.forEach((row, i) => {
        const t = truncateToWidth(row, width);
        rows.push({
          text: i === menu.selectedRow ? paint(t, style.accent + style.bold) : paint(t, style.faint),
          width: displayWidth(t),
        });
      });
    }
    return { rows, cursorRow, cursorCol };
  }

  /**
   * The line under the prompt: a hint on the left, the session's numbers on
   * the right. The right side goes first when the two do not fit, and the
   * hint is clipped only when it cannot fit by itself.
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
    const leftText = truncateToWidth(`  ${left}`, width);
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
   * Erase the footer.
   *
   * Every footer row is one terminal row at the width it was painted at, so
   * the cursor is a known number of rows above the line below the footer and
   * the footer a known number of rows above that. A width change never comes
   * through here; see `repaintAll`.
   */
  private clearFooter(): void {
    if (!this.interactive || this.footer.length === 0) return;
    const total = this.footer.length;
    if (this.cursorAt) {
      // Back to the line below the footer, where the arithmetic expects it.
      this.write(term.down(total - this.cursorAt.row) + term.lineStart);
      this.cursorAt = null;
    }
    this.write(term.up(total));
    for (let i = 0; i < total; i++) {
      this.write(term.clearLine + term.lineStart);
      if (i < total - 1) this.write(term.down(1));
    }
    this.write(term.up(total - 1));
    this.footer = [];
  }

  /** Release the footer so the shell prompt lands cleanly. */
  finish(): void {
    this.detachInput?.();
    this.detachInput = null;
    this.working = false;
    this.activity = null;
    this.updateTicker();
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
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
