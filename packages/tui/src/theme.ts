/**
 * Colour.
 *
 * Severity drives colour, never decoration: a reading is faint because it is
 * fine, amber because it wants attention, red because something is wrong. The
 * accent is Motif's brand blue, sampled from the logo.
 */

const ESC = "[";

export const NO_COLOR = process.env["NO_COLOR"] !== undefined || process.env["TERM"] === "dumb";

export const style = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  /** #607AD5, sampled from the Motif mark. */
  accent: `${ESC}38;2;96;122;213m`,
  ok: `${ESC}38;2;80;170;120m`,
  warn: `${ESC}38;2;200;150;60m`,
  bad: `${ESC}38;2;200;90;80m`,
  faint: `${ESC}38;5;245m`,
} as const;

export function paint(text: string, code: string): string {
  if (NO_COLOR) return text;
  return `${code}${text}${style.reset}`;
}

export function severityColor(sev: "ok" | "warn" | "bad"): string {
  return sev === "ok" ? style.faint : sev === "warn" ? style.warn : style.bad;
}

/** Cursor and line control, kept in one place so the writer stays readable. */
export const term = {
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  clearLine: `${ESC}2K`,
  lineStart: "\r",
  up: (n: number) => (n > 0 ? `${ESC}${n}A` : ""),
} as const;
