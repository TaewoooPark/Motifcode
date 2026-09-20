import { describe, expect, it } from "vitest";
import { mentionAt, mentionsIn } from "../src/mention.js";

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
});
