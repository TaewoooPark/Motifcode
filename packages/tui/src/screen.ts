/**
 * The screen.
 *
 * All terminal side effects live here; everything above it is pure. The whole
 * display is two regions: committed lines that were printed once and belong to
 * scrollback, and a small repainted footer holding the live tail and the status
 * line.
 *
 * No virtual DOM, and no React. The transcript is append-only by construction,
 * so there is nothing to reconcile — printing what is newly stable and
 * repainting a few footer lines is the entire algorithm.
 */

import { initialState, reduce, type ViewState } from "./cells.js";
import { heroLines, heroSubtitle, pickHero, type HeroContext } from "./hero.js";
import { renderPending, renderSettled, renderTail, type RenderOptions } from "./render.js";
import { readings, statusLine } from "./statusline.js";
import { CommitTracker } from "./stream.js";
import { NO_COLOR, paint, severityColor, style, term } from "./theme.js";
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

export class Screen {
  private state: ViewState = initialState();
  private readonly commits = new CommitTracker();
  private footerHeight = 0;
  private readonly write: (s: string) => void;
  private readonly columns: () => number;
  private expandThinking: boolean;
  private readonly shadedHero: boolean;
  private readonly interactive: boolean;

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

  private get renderOptions(): RenderOptions {
    return { width: this.columns(), expandThinking: this.expandThinking };
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
    const lines = [...renderPending(this.state, opts), ...renderTail(this.state, opts), this.paintStatus()];
    for (const line of lines) this.write(line + "\n");
    this.footerHeight = lines.length;
  }

  private clearFooter(): void {
    if (!this.interactive || this.footerHeight === 0) return;
    this.write(term.up(this.footerHeight));
    for (let i = 0; i < this.footerHeight; i++) {
      this.write(term.clearLine + term.lineStart);
      if (i < this.footerHeight - 1) this.write("\n");
    }
    this.write(term.up(this.footerHeight - 1));
    this.footerHeight = 0;
  }

  private paintStatus(): string {
    if (NO_COLOR) return statusLine(this.state.instruments);
    return readings(this.state.instruments)
      .map((r) => {
        const body = r.label ? `${paint(r.label, style.dim)} ${r.value}` : r.value;
        return paint(body, severityColor(r.severity));
      })
      .join(paint("  ·  ", style.dim));
  }

  /** Release the footer so the shell prompt lands cleanly. */
  finish(): void {
    this.clearFooter();
    // Flush anything still pending — a session that ended mid-tool should still
    // show what that tool did.
    const rest = renderPending(this.state, this.renderOptions);
    const all = renderSettled(this.state, this.renderOptions).concat(rest);
    for (const line of this.commits.take(all)) this.write(line + "\n");
    if (this.interactive) this.write(term.showCursor);
  }
}
