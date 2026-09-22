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

/** Ranges from Unicode's East_Asian_Width = W or F. Coarse, and sufficient. */
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
    if (cp < 0x20 || cp === 0x7f) continue; // control characters print nothing
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/**
 * East_Asian_Width = A. Not used by prose truncation: counting these as wide
 * would shorten ordinary text on terminals where they are one column. The
 * footer boundary uses them as a worst case, because a row that wraps there
 * desynchronises the row count.
 */
const AMBIGUOUS_RANGES: [number, number][] = [
  [0x00a1, 0x00a1], [0x00a4, 0x00a4], [0x00a7, 0x00a8], [0x00aa, 0x00aa], [0x00ad, 0x00ae],
  [0x00b0, 0x00b4], [0x00b6, 0x00ba], [0x00bc, 0x00bf], [0x00c6, 0x00c6], [0x00d0, 0x00d0],
  [0x00d7, 0x00d8], [0x00de, 0x00e1], [0x00e6, 0x00e6], [0x00e8, 0x00ea], [0x00ec, 0x00ed],
  [0x00f0, 0x00f0], [0x00f2, 0x00f3], [0x00f7, 0x00fa], [0x00fc, 0x00fc], [0x00fe, 0x00fe],
  [0x0101, 0x0101], [0x0111, 0x0111], [0x0113, 0x0113], [0x011b, 0x011b], [0x0126, 0x0127],
  [0x012b, 0x012b], [0x0131, 0x0133], [0x0138, 0x0138], [0x013f, 0x0142], [0x0144, 0x0144],
  [0x0148, 0x014b], [0x014d, 0x014d], [0x0152, 0x0153], [0x0166, 0x0167], [0x016b, 0x016b],
  [0x01ce, 0x01ce], [0x01d0, 0x01d0], [0x01d2, 0x01d2], [0x01d4, 0x01d4], [0x01d6, 0x01d6],
  [0x01d8, 0x01d8], [0x01da, 0x01da], [0x01dc, 0x01dc], [0x0251, 0x0251], [0x0261, 0x0261],
  [0x02c4, 0x02c4], [0x02c7, 0x02c7], [0x02c9, 0x02cb], [0x02cd, 0x02cd], [0x02d0, 0x02d0],
  [0x02d8, 0x02db], [0x02dd, 0x02dd], [0x02df, 0x02df], [0x0300, 0x036f], [0x0391, 0x03a1],
  [0x03a3, 0x03a9], [0x03b1, 0x03c1], [0x03c3, 0x03c9], [0x0401, 0x0401], [0x0410, 0x044f],
  [0x0451, 0x0451], [0x2010, 0x2010], [0x2013, 0x2016], [0x2018, 0x2019], [0x201c, 0x201d],
  [0x2020, 0x2022], [0x2024, 0x2027], [0x2030, 0x2030], [0x2032, 0x2033], [0x2035, 0x2035],
  [0x203b, 0x203b], [0x203e, 0x203e], [0x2074, 0x2074], [0x207f, 0x207f], [0x2081, 0x2084],
  [0x20ac, 0x20ac], [0x2103, 0x2103], [0x2105, 0x2105], [0x2109, 0x2109], [0x2113, 0x2113],
  [0x2116, 0x2116], [0x2121, 0x2122], [0x2126, 0x2126], [0x212b, 0x212b], [0x2153, 0x2154],
  [0x215b, 0x215e], [0x2160, 0x216b], [0x2170, 0x2179], [0x2189, 0x2189], [0x2190, 0x2199],
  [0x21b8, 0x21b9], [0x21d2, 0x21d2], [0x21d4, 0x21d4], [0x21e7, 0x21e7], [0x2200, 0x2200],
  [0x2202, 0x2203], [0x2207, 0x2208], [0x220b, 0x220b], [0x220f, 0x220f], [0x2211, 0x2211],
  [0x2215, 0x2215], [0x221a, 0x221a], [0x221d, 0x2220], [0x2223, 0x2223], [0x2225, 0x2225],
  [0x2227, 0x222c], [0x222e, 0x222e], [0x2234, 0x2237], [0x223c, 0x223d], [0x2248, 0x2248],
  [0x224c, 0x224c], [0x2252, 0x2252], [0x2260, 0x2261], [0x2264, 0x2267], [0x226a, 0x226b],
  [0x226e, 0x226f], [0x2282, 0x2283], [0x2286, 0x2287], [0x2295, 0x2295], [0x2299, 0x2299],
  [0x22a5, 0x22a5], [0x22bf, 0x22bf], [0x2312, 0x2312], [0x2460, 0x24e9], [0x24eb, 0x254b],
  [0x2550, 0x2573], [0x2580, 0x258f], [0x2592, 0x2595], [0x25a0, 0x25a1], [0x25a3, 0x25a9],
  [0x25b2, 0x25b3], [0x25b6, 0x25b7], [0x25bc, 0x25bd], [0x25c0, 0x25c1], [0x25c6, 0x25c8],
  [0x25cb, 0x25cb], [0x25ce, 0x25d1], [0x25e2, 0x25e5], [0x25ef, 0x25ef], [0x2605, 0x2606],
  [0x2609, 0x2609], [0x260e, 0x260f], [0x261c, 0x261c], [0x261e, 0x261e], [0x2640, 0x2640],
  [0x2642, 0x2642], [0x2660, 0x2661], [0x2663, 0x2665], [0x2667, 0x266a], [0x266c, 0x266d],
  [0x266f, 0x266f], [0x269e, 0x269f], [0x26bf, 0x26bf], [0x26c6, 0x26cd], [0x26cf, 0x26d3],
  [0x26d5, 0x26e1], [0x26e3, 0x26e3], [0x26e8, 0x26e9], [0x26eb, 0x26f1], [0x26f4, 0x26f4],
  [0x26f6, 0x26f9], [0x26fb, 0x26fc], [0x26fe, 0x26ff], [0x273d, 0x273d], [0x2776, 0x277f],
  [0x2b56, 0x2b59], [0x3248, 0x324f], [0xe000, 0xf8ff], [0xfe00, 0xfe0f], [0xfffd, 0xfffd],
  [0x1f100, 0x1f10a], [0x1f110, 0x1f12d], [0x1f130, 0x1f169], [0x1f170, 0x1f18d],
  [0x1f18f, 0x1f190], [0x1f19b, 0x1f1ac], [0xe0100, 0xe01ef], [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
];

function isAmbiguous(cp: number): boolean {
  for (const [lo, hi] of AMBIGUOUS_RANGES) {
    if (cp >= lo && cp <= hi) return true;
    if (cp < lo) break;
  }
  return false;
}

/**
 * Columns if every Ambiguous character is wide. Footer rows are fitted to this
 * so a CJK terminal cannot wrap a row the narrow count thought was one line.
 */
export function boundaryWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) continue;
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) || isAmbiguous(cp) ? 2 : 1;
  }
  return w;
}

/** Replace tabs with spaces at eight-column stops under the boundary width. */
export function expandTabsToBoundary(s: string): string {
  let out = "";
  let column = 0;
  for (const ch of s) {
    if (ch === "\n") {
      out += ch;
      column = 0;
    } else if (ch === "\t") {
      const spaces = 8 - (column % 8);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += ch;
      column += boundaryWidth(ch);
    }
  }
  return out;
}

/** Truncate to a boundary-width budget. Same rules as `truncateToWidth`. */
export function truncateToBoundary(s: string, columns: number, ellipsis = "…"): string {
  if (boundaryWidth(s) <= columns) return s;
  const budget = columns - boundaryWidth(ellipsis);
  if (budget <= 0) {
    let out = "";
    let w = 0;
    for (const ch of s) {
      const cw = boundaryWidth(ch);
      if (w + cw > columns) break;
      out += ch;
      w += cw;
    }
    return out;
  }
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = boundaryWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/**
 * Truncate to a column budget, appending an ellipsis when anything was cut.
 * Never splits a code point, and never overshoots the budget.
 */
export function truncateToWidth(s: string, columns: number, ellipsis = "…"): string {
  if (displayWidth(s) <= columns) return s;
  const budget = columns - displayWidth(ellipsis);
  if (budget <= 0) return ellipsis.slice(0, Math.max(0, columns));
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
  if (displayWidth(s) <= columns) return s;
  const budget = columns - displayWidth(ellipsis);
  if (budget <= 0) return ellipsis.slice(0, Math.max(0, columns));
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
function wrapWith(s: string, columns: number, measure: (text: string) => number): string[] {
  const width = Math.max(1, columns);
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const ch of s) {
    const w = measure(ch);
    if (used + w > width && used > 0) {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += ch;
    used += w;
  }
  rows.push(row);
  return rows;
}

export function wrapToWidth(s: string, columns: number): string[] {
  return wrapWith(s, columns, displayWidth);
}

/** Split into rows that also fit when Ambiguous characters are wide. */
export function wrapToBoundary(s: string, columns: number): string[] {
  return wrapWith(s, columns, boundaryWidth);
}
