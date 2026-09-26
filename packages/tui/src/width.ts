/**
 * Display width, not string length.
 *
 * A terminal column is not a code point. Hangul, CJK and most emoji occupy two
 * columns, combining marks occupy none, and `String.length` counts UTF-16 code
 * units — so all three disagree. Truncating or padding by `.length` produces
 * lines that overflow, rules that do not line up, and previews that cut a
 * character in half.
 *
 * This matters here more than in most harnesses. Motif-3's chat teacher was
 * trained on a Korean rubric, Korean is a first-class output language for this
 * agent, and a status line that wraps because a file path was Hangul is a bug
 * the model will get blamed for.
 */

import { eastAsianWidth } from "get-east-asian-width";

const TAB_SPACES = "    ";

/** Display tabs as four spaces, independent of the terminal's tab stops. */
export function expandTabs(s: string): string {
  return s.replace(/\t/g, TAB_SPACES);
}

/** Preserve the existing terminal/emoji widths alongside current Unicode data. */
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compat
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Ext A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compat Ideographs
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK Ext B..
];

function isWide(cp: number): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
    if (cp < lo) break;
  }
  return false;
}

function isZeroWidth(cp: number): boolean {
  // Combining marks, variation selectors, ZWJ.
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d
  );
}

/** Columns this string occupies in a monospace terminal. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\t") { w += TAB_SPACES.length; continue; }
    if (cp < 0x20 || cp === 0x7f) continue; // control characters print nothing
    if (isZeroWidth(cp)) continue;
    // Terminal width preferences cannot be inferred reliably from locale.
    w += isWide(cp) ? 2 : eastAsianWidth(cp, { ambiguousAsWide: process.env["MOTIF_AMBIGUOUS_WIDTH"] === "2" });
  }
  return w;
}

/**
 * Truncate to a column budget, appending an ellipsis when anything was cut.
 * Never splits a code point, and never overshoots the budget.
 */
export function truncateToWidth(s: string, columns: number, ellipsis = "…"): string {
  s = expandTabs(s);
  ellipsis = expandTabs(ellipsis);
  if (columns <= 0) return "";
  if (displayWidth(s) <= columns) return s;
  if (displayWidth(ellipsis) > columns) return truncateToWidth(ellipsis, columns, "");
  const budget = columns - displayWidth(ellipsis);
  if (budget <= 0) return ellipsis;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** Keep the tail rather than the head — for a live ticker of the newest text. */
export function truncateEndToWidth(s: string, columns: number, ellipsis = "…"): string {
  s = expandTabs(s);
  ellipsis = expandTabs(ellipsis);
  if (columns <= 0) return "";
  if (displayWidth(s) <= columns) return s;
  if (displayWidth(ellipsis) > columns) return truncateToWidth(ellipsis, columns, "");
  const budget = columns - displayWidth(ellipsis);
  if (budget <= 0) return ellipsis;
  const chars = [...s];
  let out = "";
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = displayWidth(chars[i]!);
    if (w + cw > budget) break;
    out = chars[i]! + out;
    w += cw;
  }
  return ellipsis + out;
}

/** Pad on the right to a column budget. */
export function padToWidth(s: string, columns: number, fill = " "): string {
  s = expandTabs(s);
  const gap = columns - displayWidth(s);
  return gap > 0 ? s + fill.repeat(gap) : s;
}

/**
 * Split into rows of at most `columns` columns, never inside a character.
 *
 * For the footer, where every printed row has to be exactly one terminal row:
 * the footer is cleared by counting rows upward, and a line the terminal
 * wrapped on its own is two rows the count does not know about — which is how
 * a long command left its first half behind on every repaint.
 */
/**
 * Prose wrapping for panels: break at spaces and keep the line's indentation on
 * continuation rows; hard-wrap only a word wider than the row (a long URL).
 * Flags such as --token-env therefore stay whole.
 */
export function wrapWords(s: string, columns: number): string[] {
  const text = expandTabs(s);
  const indent = /^ */.exec(text)![0];
  const width = Math.max(1, columns - (displayWidth(indent) < columns ? displayWidth(indent) : 0));
  const pad = width === columns ? "" : indent;
  const rows: string[] = [];
  let row = "";
  for (const word of text.slice(indent.length).split(" ")) {
    const candidate = row === "" ? word : `${row} ${word}`;
    if (displayWidth(candidate) <= width) { row = candidate; continue; }
    if (row !== "") rows.push(row);
    if (displayWidth(word) <= width) { row = word; continue; }
    const pieces = wrapToWidth(word, width);
    rows.push(...pieces.slice(0, -1));
    row = pieces[pieces.length - 1] ?? "";
  }
  rows.push(row);
  return rows.map((line) => pad + line);
}

export function wrapToWidth(s: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const ch of expandTabs(s)) {
    // A two-column glyph cannot fit a one-column terminal. Keep the source
    // intact and use an ASCII placeholder only in this displayed projection.
    const shown = displayWidth(ch) > width ? "?" : ch;
    const w = displayWidth(shown);
    if (used + w > width && used > 0) {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += shown;
    used += w;
  }
  rows.push(row);
  return rows;
}
