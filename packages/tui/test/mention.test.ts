import { describe, expect, it } from "vitest";
import { formatMention, mentionAt, mentionsIn } from "../src/mention.js";

describe("mentions", () => {
  it("finds the @token under the cursor, and only when @ starts a word", () => {
    expect(mentionAt("look at @src/ma", 15)).toEqual({ start: 8, end: 15, query: "src/ma" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionAt("mail me@example.com", 19)).toBeNull();
    expect(mentionAt("plain text", 5)).toBeNull();
  });

  it("stops the query at the cursor but the token at the next space", () => {
    const m = mentionAt("see @a.txt now", 6);
    expect(m).toEqual({ start: 4, end: 10, query: "a" });
  });

  it("works in code points, so Hangul before the token does not shift it", () => {
    expect(mentionAt("한글 @파일", 5)).toEqual({ start: 3, end: 6, query: "파" });
  });

  it("lists every mention in a message", () => {
    expect(mentionsIn("fix @src/a.ts and @skill:commit, not me@x.y")).toEqual(["src/a.ts", "skill:commit,"]);
    expect(mentionsIn("nothing here")).toEqual([]);
  });

  it("keeps a quoted path with spaces as one mention", () => {
    expect(mentionsIn('Read @"meeting notes.txt" and summarize')).toEqual(["meeting notes.txt"]);
    expect(mentionsIn('@"a b/c d.md" @x.ts')).toEqual(["a b/c d.md", "x.ts"]);
    // An unclosed or glued quote is an ordinary token, as before.
    expect(mentionsIn('@"oops and more')).toEqual(['"oops']);
    expect(mentionsIn('@"a b"c')).toEqual(['"a']);
  });

  it("quotes a chosen path only when it contains whitespace or a double quote", () => {
    expect(formatMention("meeting notes.txt")).toBe('"meeting notes.txt"');
    expect(formatMention("src/a.ts")).toBe("src/a.ts");
    expect(formatMention('"notes"')).toBe('"\\"notes\\""');
    expect(formatMention('quarter "final".txt')).toBe('"quarter \\"final\\".txt"');
  });

  it("reads back exactly the path that was formatted, literal quotes included", () => {
    const paths = ["notes", '"notes"', 'quarter "final".txt', "meeting notes.txt", "dir name\\x.txt", 'end\\"', "a\\b c"];
    for (const p of paths) expect(mentionsIn(`Read @${formatMention(p)} now`)).toEqual([p]);
    // `"notes"` and `notes` stay distinct mentions.
    expect(mentionsIn(`@${formatMention('"notes"')} @${formatMention("notes")}`)).toEqual(['"notes"', "notes"]);
    // A typed backslash that is not an escape stays in the path.
    expect(mentionsIn('@"C:\\my dir\\a.txt"')).toEqual(["C:\\my dir\\a.txt"]);
  });
});
