/**
 * Raw terminal bytes to key events.
 *
 * Raw mode hands the program every byte the terminal sends, and a terminal
 * says "up arrow" three different ways depending on its mode, spreads a paste
 * across several reads, and sends a lone ESC that is indistinguishable from
 * the start of a sequence until the next byte does or does not arrive. All of
 * that is resolved here, once, so the composer and the chat controller deal in
 * keys rather than in escape sequences.
 *
 * Bracketed paste matters more than it looks. Without it a pasted task that
 * contains a newline submits on the first line and sends the rest as the next
 * message, and a pasted `/` at the start of a line opens the command menu. With
 * it the terminal wraps the paste in markers and the whole thing arrives as
 * one event, verbatim.
 */

export type Key =
  | { type: "text"; text: string }
  /** A bracketed paste, newlines and all. */
  | { type: "paste"; text: string }
  | { type: "enter" }
  /** A literal newline: Ctrl-J, or Alt-Enter on terminals that send ESC CR. */
  | { type: "newline" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab" }
  | { type: "shift-tab" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "word-left" }
  | { type: "word-right" }
  | { type: "delete-word" }
  /** Ctrl plus a letter, lower case, for the ones without a name above. */
  | { type: "ctrl"; key: string };

const ESC = "\x1b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** The terminal's own sequences for bracketed paste, for the writer to emit. */
export const BRACKETED_PASTE = { enable: `${ESC}[?2004h`, disable: `${ESC}[?2004l` } as const;

function csiKey(params: string, final: string): Key | null {
  // Modifier 3 is Alt, 5 is Ctrl; both move by word on the horizontal arrows.
  const modified = /;[35]$/.test(params) || params === "3" || params === "5";
  switch (final) {
    case "A":
      return { type: "up" };
    case "B":
      return { type: "down" };
    case "C":
      return modified ? { type: "word-right" } : { type: "right" };
    case "D":
      return modified ? { type: "word-left" } : { type: "left" };
    case "H":
      return { type: "home" };
    case "F":
      return { type: "end" };
    case "Z":
      return { type: "shift-tab" };
    case "~":
      switch (params.split(";")[0]) {
        case "1":
        case "7":
          return { type: "home" };
        case "4":
        case "8":
          return { type: "end" };
        case "3":
          return { type: "delete" };
        default:
          return null;
      }
    default:
      return null;
  }
}

function controlKey(code: number): Key {
  switch (code) {
    case 0x01:
      return { type: "home" }; // Ctrl-A
    case 0x05:
      return { type: "end" }; // Ctrl-E
    case 0x02:
      return { type: "left" }; // Ctrl-B
    case 0x06:
      return { type: "right" }; // Ctrl-F
    case 0x10:
      return { type: "up" }; // Ctrl-P
    case 0x0e:
      return { type: "down" }; // Ctrl-N
    case 0x08:
      return { type: "backspace" }; // Ctrl-H
    case 0x17:
      return { type: "delete-word" }; // Ctrl-W
    default:
      return { type: "ctrl", key: String.fromCharCode(code + 0x60) };
  }
}

export class KeyDecoder {
  private pasting = false;
  private paste = "";
  /** An escape sequence cut off by the end of a read; completed by the next one. */
  private pending = "";

  feed(chunk: string | Buffer): Key[] {
    const out: Key[] = [];
    let s = this.pending + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    this.pending = "";

    if (this.pasting) {
      const end = s.indexOf(PASTE_END);
      if (end === -1) {
        // Hold back the longest tail that could be the start of a terminator
        // split across reads; everything before it is paste for certain.
        let hold = 0;
        for (let k = Math.min(s.length, PASTE_END.length - 1); k > 0; k--) {
          if (PASTE_END.startsWith(s.slice(s.length - k))) {
            hold = k;
            break;
          }
        }
        this.paste += s.slice(0, s.length - hold);
        this.pending = s.slice(s.length - hold);
        return out;
      }
      this.paste += s.slice(0, end);
      out.push({ type: "paste", text: this.paste });
      this.paste = "";
      this.pasting = false;
      s = s.slice(end + PASTE_END.length);
    }

    let text = "";
    const flushText = (): void => {
      if (text !== "") out.push({ type: "text", text });
      text = "";
    };

    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      const code = s.charCodeAt(i);

      if (ch === ESC) {
        flushText();
        if (s.startsWith(PASTE_START, i)) {
          this.pasting = true;
          const rest = s.slice(i + PASTE_START.length);
          // Re-enter through the paste branch for the remainder.
          const tail = this.feed(rest);
          out.push(...tail);
          return out;
        }
        const next = s[i + 1];
        if (next === undefined) {
          // A lone ESC at the end of a read is the Escape key, unless a
          // sequence continues in the next read — which cannot be known here.
          // Escape it is: a user pressing the key is the common case, and a
          // split arrow sequence merely costs one keypress.
          out.push({ type: "escape" });
          i += 1;
          continue;
        }
        if (next === "[") {
          // CSI: parameters, then a final byte in 0x40–0x7e.
          let j = i + 2;
          while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
          if (j >= s.length) {
            this.pending = s.slice(i);
            return out;
          }
          const key = csiKey(s.slice(i + 2, j), s[j]!);
          if (key) out.push(key);
          i = j + 1;
          continue;
        }
        if (next === "O") {
          // SS3, sent for the arrows in application cursor mode.
          const final = s[i + 2];
          if (final === undefined) {
            this.pending = s.slice(i);
            return out;
          }
          const key = csiKey("", final);
          if (key) out.push(key);
          i += 3;
          continue;
        }
        // Alt-modified keys arrive as ESC followed by the key.
        if (next === "b") out.push({ type: "word-left" });
        else if (next === "f") out.push({ type: "word-right" });
        else if (next === "\x7f" || next === "\b") out.push({ type: "delete-word" });
        else if (next === "\r" || next === "\n") out.push({ type: "newline" });
        else {
          out.push({ type: "escape" });
          i += 1;
          continue;
        }
        i += 2;
        continue;
      }

      if (ch === "\r") {
        flushText();
        out.push({ type: "enter" });
      } else if (ch === "\n") {
        flushText();
        out.push({ type: "newline" });
      } else if (ch === "\t") {
        flushText();
        out.push({ type: "tab" });
      } else if (ch === "\x7f" || ch === "\b") {
        flushText();
        out.push({ type: "backspace" });
      } else if (code < 0x20) {
        flushText();
        out.push(controlKey(code));
      } else {
        text += ch;
      }
      i += 1;
    }
    flushText();
    return out;
  }
}
