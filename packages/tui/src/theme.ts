/**
 * Colour.
 *
 * Severity drives colour, never decoration: a reading is faint because it is
 * fine, amber because it wants attention, red because something is wrong. The
 * accent marks what the harness itself says — the prompt, the bullets — and
 * is the one thing a theme is mostly about.
 *
 * Themes are palettes, not layouts. Every theme fills the same slots, so the
 * writer never asks which theme is active; it asks for `style.accent` and gets
 * whatever the palette put there. `applyTheme` swaps the slots in place, which
 * is why `style` is an object and not a frozen constant.
 */

const ESC = "\x1b[";

export const NO_COLOR = process.env["NO_COLOR"] !== undefined || process.env["TERM"] === "dumb";

const rgb = (r: number, g: number, b: number): string => `${ESC}38;2;${r};${g};${b}m`;
const bg = (r: number, g: number, b: number): string => `${ESC}48;2;${r};${g};${b}m`;
const idx = (n: number): string => `${ESC}38;5;${n}m`;

export interface Palette {
  accent: string;
  accentBackground: string;
  ok: string;
  warn: string;
  bad: string;
  faint: string;
}

/** The palettes on offer, by name. */
export const THEMES: Record<string, { description: string; palette: Palette }> = {
  motif: {
    description: "Motif's brand blue, sampled from the logo",
    palette: { accent: rgb(96, 122, 213), accentBackground: bg(96, 122, 213), ok: rgb(80, 170, 120), warn: rgb(200, 150, 60), bad: rgb(200, 90, 80), faint: idx(245) },
  },
  claude: {
    description: "Claude's terracotta accent with GitHub's status colours",
    palette: { accent: rgb(217, 119, 87), accentBackground: bg(217, 119, 87), ok: rgb(63, 185, 80), warn: rgb(210, 153, 34), bad: rgb(248, 81, 73), faint: idx(245) },
  },
  mono: {
    description: "no colour at all — weight and dimness only",
    palette: { accent: `${ESC}1m`, accentBackground: bg(90, 90, 90), ok: idx(250), warn: `${ESC}1m`, bad: `${ESC}1m${ESC}4m`, faint: idx(245) },
  },
  solarized: {
    description: "Solarized's blue, green, yellow and red",
    palette: { accent: rgb(38, 139, 210), accentBackground: bg(38, 139, 210), ok: rgb(133, 153, 0), warn: rgb(181, 137, 0), bad: rgb(220, 50, 47), faint: rgb(147, 161, 161) },
  },
  dracula: {
    description: "Dracula's purple, green, yellow and red",
    palette: { accent: rgb(189, 147, 249), accentBackground: bg(189, 147, 249), ok: rgb(80, 250, 123), warn: rgb(241, 250, 140), bad: rgb(255, 85, 85), faint: rgb(98, 114, 164) },
  },
};

export const DEFAULT_THEME = "motif";

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

/** The active palette, swapped in place by `applyTheme`. */
export const style = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  /** Swapped foreground and background, for the selected menu row. */
  inverse: `${ESC}7m`,
  tabText: rgb(255, 255, 255),
  tabBackground: bg(48, 53, 65),
  ...THEMES[DEFAULT_THEME]!.palette,
};

let active = DEFAULT_THEME;

export function activeTheme(): string {
  return active;
}

/** Switch palettes. Returns false, and changes nothing, for an unknown name. */
export function applyTheme(name: string): boolean {
  const theme = THEMES[name];
  if (!theme) return false;
  Object.assign(style, theme.palette);
  active = name;
  return true;
}

export function paint(text: string, code: string): string {
  if (NO_COLOR) return text;
  return `${code}${text}${style.reset}`;
}

export function severityColor(sev: "ok" | "warn" | "bad"): string {
  return sev === "ok" ? style.faint : sev === "warn" ? style.warn : style.bad;
}

/** Cursor and line control, kept in one place so the writer stays readable. */
export const term = {
  enterAlternate: `${ESC}?1049h`,
  leaveAlternate: `${ESC}?1049l`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  clearLine: `${ESC}2K`,
  /** Erase the visible screen; scrollback is untouched. */
  clearScreen: `${ESC}2J`,
  /** Top-left of the visible screen. */
  home: `${ESC}H`,
  lineStart: "\r",
  /** Reserve a blank row before painting live content; may scroll at the bottom. */
  index: "\x1bD",
  up: (n: number) => (n > 0 ? `${ESC}${n}A` : ""),
  down: (n: number) => (n > 0 ? `${ESC}${n}B` : ""),
  /** Absolute column, 1-based in the terminal; this takes 0-based. */
  column: (col: number) => `${ESC}${col + 1}G`,
  /**
   * Synchronized output (DEC 2026). The erase and the redraw are one update,
   * so a terminal that understands it paints the result and not the blank.
   */
  beginSync: `${ESC}?2026h`,
  endSync: `${ESC}?2026l`,
} as const;
