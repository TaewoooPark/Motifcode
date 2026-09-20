/**
 * Bytes to keys.
 *
 * The cases are the ones a terminal actually sends: three spellings of the
 * arrows, a paste split across reads, and a lone Escape that must not be
 * mistaken for the start of a sequence.
 */

import { describe, expect, it } from "vitest";
import { KeyDecoder, type Key } from "../src/keys.js";

const ESC = "\x1b";

function decode(...chunks: string[]): Key[] {
  const d = new KeyDecoder();
  return chunks.flatMap((c) => d.feed(c));
}

describe("key decoding", () => {
  it("groups printable characters and splits out the controls", () => {
    expect(decode("ab\rc")).toEqual([{ type: "text", text: "ab" }, { type: "enter" }, { type: "text", text: "c" }]);
    expect(decode("\x7f")).toEqual([{ type: "backspace" }]);
    expect(decode("\t")).toEqual([{ type: "tab" }]);
    expect(decode("\n")).toEqual([{ type: "newline" }]);
  });

  it("keeps Hangul and emoji whole", () => {
    expect(decode("한글 🙂")).toEqual([{ type: "text", text: "한글 🙂" }]);
  });

  it("reads the arrows in both cursor modes", () => {
    expect(decode(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`)).toEqual([
      { type: "up" },
      { type: "down" },
      { type: "right" },
      { type: "left" },
    ]);
    expect(decode(`${ESC}OA${ESC}OD`)).toEqual([{ type: "up" }, { type: "left" }]);
  });

  it("reads home, end, delete and the word motions", () => {
    expect(decode(`${ESC}[H${ESC}[F${ESC}[3~${ESC}[1~${ESC}[4~`)).toEqual([
      { type: "home" },
      { type: "end" },
      { type: "delete" },
      { type: "home" },
      { type: "end" },
    ]);
    expect(decode(`${ESC}[1;5D${ESC}[1;3C${ESC}b${ESC}f`)).toEqual([
      { type: "word-left" },
      { type: "word-right" },
      { type: "word-left" },
      { type: "word-right" },
    ]);
  });

  it("maps the control keys an editor expects", () => {
    expect(decode("\x01\x05\x15\x0b\x17\x03\x04")).toEqual([
      { type: "home" },
      { type: "end" },
      { type: "ctrl", key: "u" },
      { type: "ctrl", key: "k" },
      { type: "delete-word" },
      { type: "ctrl", key: "c" },
      { type: "ctrl", key: "d" },
    ]);
  });

  it("treats a lone escape as the Escape key", () => {
    expect(decode(ESC)).toEqual([{ type: "escape" }]);
    expect(decode(`${ESC}x`)).toEqual([{ type: "escape" }, { type: "text", text: "x" }]);
  });

  it("completes a sequence cut off by the end of a read", () => {
    const d = new KeyDecoder();
    expect(d.feed(`${ESC}[`)).toEqual([]);
    expect(d.feed("A")).toEqual([{ type: "up" }]);
  });

  it("delivers a bracketed paste as one event, newlines included", () => {
    const paste = `${ESC}[200~line one\nline two\n${ESC}[201~`;
    expect(decode(paste)).toEqual([{ type: "paste", text: "line one\nline two\n" }]);
  });

  it("reassembles a paste split across reads, even inside the terminator", () => {
    const d = new KeyDecoder();
    const keys = [
      ...d.feed(`${ESC}[200~first `),
      ...d.feed("second"),
      ...d.feed(` third${ESC}[20`),
      ...d.feed("1~x"),
    ];
    expect(keys).toEqual([{ type: "paste", text: "first second third" }, { type: "text", text: "x" }]);
  });

  it("does not open the menu or submit from pasted text", () => {
    // A pasted `/` or newline is content; only typed keys are commands.
    const keys = decode(`${ESC}[200~/not a command\r${ESC}[201~`);
    expect(keys).toEqual([{ type: "paste", text: "/not a command\r" }]);
  });
});
