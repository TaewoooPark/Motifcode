/**
 * `@` mentions in the draft.
 *
 * Claude Code's convention: `@` followed by a path attaches that file to the
 * message, and typing it opens a picker. The token is whatever runs from the
 * `@` to the cursor without a space, and it is only a mention when the `@`
 * starts a word — an email address in the middle of a sentence is not asking
 * for a file.
 */

export interface Mention {
  /** Code-point index of the `@`. */
  start: number;
  /** Code-point index just past the token. */
  end: number;
  /** What follows the `@`, up to the cursor. */
  query: string;
}

/** The mention the cursor is inside, or null. */
export function mentionAt(text: string, cursor: number): Mention | null {
  const chars = [...text];
  const at = Math.min(cursor, chars.length);
  let start = at;
  while (start > 0 && !/\s/.test(chars[start - 1]!)) start--;
  if (chars[start] !== "@") return null;
  let end = at;
  while (end < chars.length && !/\s/.test(chars[end]!)) end++;
  return { start, end, query: chars.slice(start + 1, at).join("") };
}

/** Every `@token` in a message, as typed. */
export function mentionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) out.push(m[1]!);
  return out;
}
