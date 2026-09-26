import { describe, expect, it } from "vitest";
import { extractFocusTerms } from "../src/focus.js";

describe("literal task focus terms", () => {
  it("finds original technical terms in a Korean request without paraphrasing", () => {
    const query = "MCP 문서에서 allowed_tools 설정과 Streamable HTTP 및 SSE의 지원 조건을 확인해줘.";
    const terms = extractFocusTerms(query);
    expect(terms).toContain("allowed_tools");
    expect(terms).toContain("Streamable HTTP");
    expect(terms).toContain("SSE");
    expect(terms.every((term) => query.includes(term))).toBe(true);
    expect(terms).not.toContain("성공");
  });

  it("preserves case, paths, IDs and quoted Korean phrases exactly", () => {
    const query = "`/Users/태우/My Repo/Config.JSON`의 `Repo-ID_07` 및 “사용자 승인”과 'Exact  Phrase'를 찾아줘.";
    const terms = extractFocusTerms(query);
    expect(terms.slice(0, 2)).toEqual(["/Users/태우/My Repo/Config.JSON", "Repo-ID_07"]);
    expect(terms).toContain("사용자 승인");
    expect(terms).toContain("Exact  Phrase");
    expect(terms.every((term) => query.includes(term))).toBe(true);
  });

  it("does not use a long quoted task as the whole search query", () => {
    const longTask = `${"문서의 상세 내용을 확인해줘. ".repeat(10)} allowed_tools와 Streamable HTTP 및 SSE를 비교해줘.`;
    const terms = extractFocusTerms(`"${longTask}"`);
    expect(terms).not.toContain(longTask);
    expect(terms).toEqual(expect.arrayContaining(["allowed_tools", "Streamable HTTP", "SSE"]));
    expect(terms.every((term) => term.length >= 2 && term.length <= 80)).toBe(true);
  });

  it("keeps useful adjacent phrases and individual acronyms inside a quoted query", () => {
    const terms = extractFocusTerms('"Responses API remote MCP allowed_tools Streamable HTTP SSE"');
    expect(terms).toEqual(expect.arrayContaining(["allowed_tools", "Streamable HTTP", "SSE"]));
    expect(terms).toHaveLength(6);
    expect(terms).not.toContain("Streamable HTTP SSE");
    expect(terms).not.toContain("HTTP SSE");
  });

  it("orders by syntax priority and specificity, deduplicates exactly, and caps at six", () => {
    const query = "`id` `Longer_ID` Longer_ID lower_id ABC DEF GHI JKL MNO 'quoted value'";
    const terms = extractFocusTerms(query);
    expect(terms.slice(0, 4)).toEqual(["Longer_ID", "id", "quoted value", "lower_id"]);
    expect(terms).toHaveLength(6);
    expect(new Set(terms).size).toBe(terms.length);
    expect(extractFocusTerms(query)).toEqual(terms);
  });

  it("bounds input and skips overlong identifiers without manufacturing a shortened ID", () => {
    const tooLong = `ID_${"x".repeat(100)}`;
    const query = `${tooLong} ${"a".repeat(32_768)} LATE_IDENTIFIER`;
    const terms = extractFocusTerms(query);
    expect(terms).not.toContain("LATE_IDENTIFIER");
    expect(terms.some((term) => term.startsWith("ID_"))).toBe(false);
  });

  it("handles empty, unmatched quotation, repeated separators and ordinary prose without guessed terms", () => {
    expect(extractFocusTerms("")).toEqual([]);
    expect(extractFocusTerms("모든 단계가 성공했는지 확인해줘")).toEqual([]);
    expect(extractFocusTerms("all phases succeeded")).toEqual([]);
    expect(extractFocusTerms("'".repeat(32_768))).toEqual([]);
    expect(extractFocusTerms("`unterminated_identifier")).toEqual(["unterminated_identifier"]);
  });
});
