/**
 * Making untrusted text safe to print.
 *
 * Everything the model writes and everything a command prints goes to the
 * user's terminal, and a terminal is a machine that executes what it reads. A
 * repository can put an OSC 52 sequence in a README, a test can print one in a
 * failure message, and the model can emit one because it read either. Printed
 * unfiltered, that sequence writes to the user's clipboard. Others retitle the
 * window, move the cursor over lines that are already there, enable mouse
 * reporting, or clear the screen and take the scrollback with it.
 *
 * Carriage return deserves its own mention. `\r` moves the cursor to the start
 * of the line, so `SAFE OUTPUT\rrm -rf /` displays as `rm -rf /` — the text a
 * user sees is not the text that was written, which is the whole game.
 *
 * The rule is allowlist, not blocklist: printable characters, tab and newline
 * pass; everything else is shown as a visible escape. The point of showing
 * rather than deleting is that a file genuinely containing control bytes still
 * reads as containing them.
 *
 * This is display only. The journal keeps the original bytes, because a
 * recording that has been through a sanitiser is no longer a recording.
 */

const CARET = "^";

/** Printable, plus the two whitespace characters a transcript legitimately uses. */
function isSafe(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return true; // tab, newline
  if (code < 0x20) return false; // C0 controls, including ESC and CR
  if (code === 0x7f) return false; // DEL
  if (code >= 0x80 && code <= 0x9f) return false; // C1 controls
  return true;
}

/** `ESC` -> `^[`, `\r` -> `^M`, and so on. Visible, and inert. */
function show(code: number): string {
  if (code === 0x7f) return `${CARET}?`;
  if (code < 0x20) return CARET + String.fromCharCode(code + 0x40);
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * Strip control sequences from text that did not come from this harness.
 *
 * Applied at the render boundary, after which the harness may add its own
 * styling — so our colours work and the repository's do not.
 */
export function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += isSafe(code) ? ch : show(code);
  }
  return out;
}

/** Sanitise and split into lines, which is what the renderer wants. */
export function sanitizeLines(text: string): string[] {
  return sanitize(text).split("\n");
}

/**
 * Sequences worth naming, so a test can assert on them rather than on "no ESC".
 *
 * Each is something a terminal will act on: write the clipboard, retitle the
 * window, move the cursor, enable mouse reporting, clear the screen.
 */
export const DANGEROUS_SEQUENCES: readonly { name: string; text: string }[] = Object.freeze([
  { name: "OSC 52 clipboard write", text: "]52;c;bWFsaWNpb3Vz" },
  { name: "window title", text: "]0;pwned" },
  { name: "cursor move", text: "[10;10H" },
  { name: "clear screen", text: "[2J" },
  { name: "alternate screen", text: "[?1049h" },
  { name: "mouse reporting", text: "[?1003h" },
  { name: "carriage-return overwrite", text: "SAFE OUTPUT\rrm -rf /" },
  { name: "backspace overwrite", text: "safeevil" },
]);
