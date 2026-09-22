/**
 * The line editor and its rendering.
 *
 * Code points, not UTF-16 units, and columns, not characters: the cases that
 * matter are the ones where those differ.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, renderComposer } from "../src/composer.js";

describe("editing", () => {
  it("inserts at the cursor and moves by code point", () => {
    const c = new Composer();
    c.insert("héllo");
    c.left();
    c.left();
    c.insert("X");
    expect(c.text).toBe("hélXlo");
    expect(c.cursor).toBe(4);
  });

  it("never splits an emoji or a Hangul syllable", () => {
    const c = new Composer();
    c.insert("a🙂b한");
    c.end();
    c.backspace();
    expect(c.text).toBe("a🙂b");
    c.left();
    c.left();
    expect(c.cursor).toBe(1);
    c.deleteForward();
    expect(c.text).toBe("ab");
  });

  it("moves and deletes by word", () => {
    const c = new Composer();
    c.insert("fix the parser now");
    c.wordLeft();
    expect(c.cursor).toBe("fix the parser ".length);
    c.deleteWordBack();
    expect(c.text).toBe("fix the now");
    c.home();
    c.wordRight();
    expect(c.cursor).toBe(3);
  });

  it("kills to either end of the current line only", () => {
    const c = new Composer();
    c.insert("first\nsecond line");
    c.left();
    c.left();
    c.left();
    c.left();
    c.killToEnd();
    expect(c.text).toBe("first\nsecond ");
    c.killToStart();
    expect(c.text).toBe("first\n");
  });

  it("moves between lines of a draft and into history at the edges", () => {
    const c = new Composer();
    c.insert("one");
    c.submit();
    c.insert("two");
    c.submit();
    c.insert("ab\ncd");
    // On the last line: down goes nowhere, up moves a line.
    expect(c.down()).toBe(false);
    expect(c.up()).toBe(true);
    expect(c.cursor).toBe(2);
    // On the first line: up browses history, keeping the draft.
    expect(c.up()).toBe(true);
    expect(c.text).toBe("two");
    expect(c.up()).toBe(true);
    expect(c.text).toBe("one");
    expect(c.up()).toBe(false);
    expect(c.down()).toBe(true);
    expect(c.down()).toBe(true);
    expect(c.text).toBe("ab\ncd");
  });

  it("collapses a long paste to a placeholder and sends the whole thing", () => {
    const c = new Composer();
    const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    c.insert("look: ");
    c.paste(big);
    expect(c.text).toBe("look: [paste #1: 30 lines] ");
    c.insert("ok");
    const sent = c.submit();
    expect(sent.startsWith("look: line 0\nline 1")).toBe(true);
    expect(sent.endsWith("line 29 ok")).toBe(true);
    // A short paste is just text.
    c.paste("two\nlines");
    expect(c.text).toBe("two\nlines");
  });

  it("trims trailing whitespace on submit and skips repeats in history", () => {
    const c = new Composer();
    c.insert("task  \n");
    expect(c.submit()).toBe("task");
    c.insert("task");
    c.submit();
    c.insert("");
    expect(c.submit()).toBe("");
    expect(c.up()).toBe(true);
    expect(c.text).toBe("task");
    expect(c.up()).toBe(false);
  });
});

describe("rendering", () => {
  it("shows the placeholder with the cursor after the prompt", () => {
    const r = renderComposer({ text: "", cursor: 0 }, { width: 40, placeholder: "type here" });
    expect(r.rows).toEqual([{ prefix: "❯ ", body: "type here" }]);
    expect(r.placeholder).toBe(true);
    expect(r).toMatchObject({ cursorRow: 0, cursorCol: 2 });
  });

  it("wraps by columns and follows the cursor onto the next row", () => {
    const text = "abcdefghij"; // 10 columns, room is 8
    const r = renderComposer({ text, cursor: 10 }, { width: 10 });
    expect(r.rows.map((x) => x.body)).toEqual(["abcdefgh", "ij"]);
    expect(r.rows[1]!.prefix).toBe("  ");
    expect(r).toMatchObject({ cursorRow: 1, cursorCol: 4 });
    const mid = renderComposer({ text, cursor: 8 }, { width: 10 });
    expect(mid).toMatchObject({ cursorRow: 1, cursorCol: 2 });
  });

  it("wraps a wide character whole", () => {
    // "한" is two columns; with 3 columns of room, "ab한" cannot fit on one row.
    const r = renderComposer({ text: "ab한c", cursor: 3 }, { width: 5 });
    expect(r.rows.map((x) => x.body)).toEqual(["ab", "한c"]);
    expect(r).toMatchObject({ cursorRow: 1, cursorCol: 4 });
  });

  it("puts the cursor on a fresh row after a trailing newline", () => {
    const r = renderComposer({ text: "a\n", cursor: 2 }, { width: 20 });
    expect(r.rows.map((x) => x.body)).toEqual(["a", ""]);
    expect(r).toMatchObject({ cursorRow: 1, cursorCol: 2 });
  });

  it("starts a new row when the cursor sits at the end of a full one", () => {
    const r = renderComposer({ text: "abcdefgh", cursor: 8 }, { width: 10 });
    expect(r.rows.map((x) => x.body)).toEqual(["abcdefgh", ""]);
    expect(r).toMatchObject({ cursorRow: 1, cursorCol: 2 });
  });
});

describe("narrow composer rendering", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fits a long placeholder after a clipped prompt", () => {
    const rendered = renderComposer({ text: "", cursor: 0 }, { width: 3, prompt: "API key > ", placeholder: "type here" });
    expect(rendered.rows).toEqual([{ prefix: "AP", body: "…" }]);
    expect(rendered).toMatchObject({ cursorRow: 0, cursorCol: 2 });
  });

  it("projects a wide glyph in a one-column viewport without changing the draft", () => {
    const c = new Composer();
    c.insert("한a");
    c.left();
    const rendered = renderComposer(c.snapshot(), { width: 1 });
    expect(rendered.rows).toEqual([{ prefix: "", body: "?" }, { prefix: "", body: "a" }]);
    expect(rendered).toMatchObject({ cursorRow: 1, cursorCol: 0 });
    expect(c.submit()).toBe("한a");
  });

  it("locates the caret after an ambiguous glyph under either terminal policy", () => {
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", "1");
    expect(renderComposer({ text: "Ωa", cursor: 1 }, { width: 4, prompt: "> " }))
      .toMatchObject({ rows: [{ prefix: "> ", body: "Ωa" }], cursorRow: 0, cursorCol: 3 });
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", "2");
    expect(renderComposer({ text: "Ωa", cursor: 1 }, { width: 4, prompt: "> " }))
      .toMatchObject({ rows: [{ prefix: "> ", body: "Ω" }, { prefix: "  ", body: "a" }], cursorRow: 1, cursorCol: 2 });
  });

  it("wraps a rocket emoji and keeps its editing cursor on the physical row", () => {
    const rendered = renderComposer({ text: "ab🚀x", cursor: 2 }, { width: 5, prompt: "> " });
    expect(rendered.rows).toEqual([{ prefix: "> ", body: "ab" }, { prefix: "  ", body: "🚀x" }]);
    expect(rendered).toMatchObject({ cursorRow: 1, cursorCol: 2 });
    expect(renderComposer({ text: "🚀", cursor: 1 }, { width: 1 }))
      .toMatchObject({ rows: [{ prefix: "", body: "?" }, { prefix: "", body: "" }], cursorRow: 1, cursorCol: 0 });
  });
});

describe("pasted prompt history", () => {
  const block = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n");

  it("recalls the expanded paste after its placeholder map is cleared", () => {
    const c = new Composer();
    c.paste(block);
    expect(c.submit()).toBe(block);
    expect(c.up()).toBe(true);
    expect(c.submit()).toBe(block);
    expect(c.historyEntries).toEqual([block]);
  });

  it("round-trips normal text and multiple pasted blocks", () => {
    const c = new Composer();
    c.insert("first: ");
    c.paste(block);
    c.insert("second: ");
    c.paste(block.toUpperCase());
    c.insert("done");
    const expected = `first: ${block} second: ${block.toUpperCase()} done`;
    expect(c.submit()).toBe(expected);
    c.up();
    expect(c.submit()).toBe(expected);
  });

  it("deduplicates identical content despite different placeholder identifiers", () => {
    const c = new Composer();
    c.paste(block);
    c.submit();
    c.paste(block);
    c.submit();
    expect(c.historyEntries).toEqual([block]);
  });

  it("preserves an unsent pasted draft when returning from history", () => {
    const c = new Composer();
    c.paste(block);
    c.submit();
    c.insert("draft: ");
    c.paste(block.toUpperCase());
    const shown = c.text;
    expect(c.up()).toBe(true);
    expect(c.text).toBe(block);
    expect(c.down()).toBe(true);
    expect(c.text).toBe(shown);
    expect(c.submit()).toBe(`draft: ${block.toUpperCase()}`);
  });
});
