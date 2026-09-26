import { describe, expect, it } from "vitest";
import { ResultStore, isResultError, serializeResultView, type ResultView } from "../src/results.js";

const object = (value: ResultView): Record<string, any> => value as Record<string, any>;
const size = (value: ResultView): number => Buffer.byteLength(serializeResultView(value), "utf8");
const large = () => ({ content: [{ type: "text", text: "compile completed\n".repeat(300) }], structuredContent: { decision: { approved: false, failedTests: 0, blocker: null }, tail: "error: 회귀-918" }, isError: false });

describe("ResultStore", () => {
  it("preserves exact small JSON including false, zero, null, empty arrays and strings", () => {
    const store = new ResultStore();
    for (const value of [false, 0, null, "", [], { content: [], isError: false, structuredContent: { zero: 0, missing: null, no: false, empty: "" } }]) {
      expect(store.present("root", value)).toEqual(value);
      expect(serializeResultView(store.present("root", value))).toBe(JSON.stringify(value));
    }
    expect(store.size).toBe(0);
  });

  it("retains large originals, projects exact fields, and never silently represents a summary as full", () => {
    const store = new ResultStore({ maxOutputBytes: 1024 });
    const shown = object(store.present("root", large()));
    expect(shown.kind).toBe("mcp_result");
    expect(shown.isError).toBe(false);
    expect(shown.coverage.complete).toBe(false);
    expect(shown.coverage.wholeResult).toBe(false);
    expect(size(shown)).toBeLessThanOrEqual(1024);
    const read = object(store.read("root", { handle: shown.handle, pointer: "/structuredContent/decision" }));
    expect(read.value).toEqual({ approved: false, failedTests: 0, blocker: null });
    expect(read.coverage).toMatchObject({ complete: true, wholeResult: false, pointer: "/structuredContent/decision" });
    for (const [name, expected] of [["approved", false], ["failedTests", 0], ["blocker", null]]) {
      expect(object(store.read("root", { handle: shown.handle, pointer: `/structuredContent/decision/${name}` })).value).toBe(expected);
    }
  });

  it("withholds nested _meta and binary payloads on every read and marks sanitized coverage", () => {
    const store = new ResultStore();
    const raw = { _meta: { token: "PRIVATE_META" }, content: [{ type: "image", mimeType: "image/png", data: "IMAGE_BASE64" }, { type: "audio", mimeType: "audio/wav", data: "AUDIO_BASE64" }, { type: "resource", resource: { uri: "file:x", blob: "BLOB_BASE64", _meta: { private: true } } }], structuredContent: { _meta: { hidden: 5 }, good: false }, isError: true };
    const shown = object(store.present("root", raw));
    expect(shown.value.structuredContent).toEqual({ good: false });
    expect(shown.coverage).toMatchObject({ complete: true, wholeResult: false, withheld: { metadataFields: 3, binaryBlocks: 3 } });
    expect(shown.isError).toBe(true);
    const text = JSON.stringify(shown);
    for (const secret of ["PRIVATE_META", "IMAGE_BASE64", "AUDIO_BASE64", "BLOB_BASE64"]) expect(text).not.toContain(secret);
    expect(object(store.read("root", { handle: shown.handle, pointer: "/content/0/data" })).code).toBe("pointer_not_found");
    expect(object(store.read("root", { handle: shown.handle, pointer: "/_meta" })).code).toBe("pointer_not_found");
    expect(object(store.find("root", { handle: shown.handle, query: "BASE64" })).count).toBe(0);
    expect(store.storedBytes).toBe(Buffer.byteLength(JSON.stringify(raw)));
  });

  it("supports escaped JSON Pointers and denies prototype traversal and invalid array indices", () => {
    const store = new ResultStore({ maxOutputBytes: 1024 });
    const raw = JSON.parse('{"a/b":{"~key":0},"__proto__":{"own":false},"list":[null],"pad":"' + "x".repeat(2000) + '"}');
    const handle = object(store.present("s", raw)).handle;
    expect(object(store.read("s", { handle, pointer: "/a~1b/~0key" })).value).toBe(0);
    expect(object(store.read("s", { handle, pointer: "/__proto__/own" })).value).toBe(false);
    expect(object(store.read("s", { handle, pointer: "/list/0" })).value).toBe(null);
    for (const pointer of ["/constructor", "/list/01", "/list/-", "/a~2b"]) expect(isResultError(store.read("s", { handle, pointer }))).toBe(true);
  });

  it("retrieves exact task literals from large results without claiming complete coverage", () => {
    const store = new ResultStore({ maxOutputBytes: 4096 });
    const text = "unrelated prelude\n".repeat(3000) + "Streamable HTTP or HTTP/SSE. allowed_tools limits exposure.\n";
    const shown = object(store.present("root", { content: [{ type: "text", text }], decision: { approved: false, errors: 0, note: null } }, ["Streamable HTTP", "allowed_tools", "nonexistent"]));
    expect(size(shown)).toBeLessThanOrEqual(4096);
    expect(shown.focus.map((entry: any) => entry.query)).toEqual(["Streamable HTTP", "allowed_tools"]);
    expect(shown.focus[0].matches[0].excerpt).toContain("Streamable HTTP or HTTP/SSE.");
    expect(shown.focus[0].coverage).toMatchObject({ complete: false, wholeResult: false, predicateComplete: true });
    expect(shown.coverage.wholeResult).toBe(false);
    expect(shown.nextCall).toBeUndefined();
    expect(object(store.read("root", { handle: shown.handle, pointer: "/decision" })).value).toEqual({ approved: false, errors: 0, note: null });
    expect(object(store.read("child", { handle: shown.handle })).code).toBe("scope_denied");
    const small = { content: [{ type: "text", text: "allowed_tools" }] };
    expect(store.present("root", small, ["allowed_tools"])).toEqual(small);
  });

  it("pages full lines and reports the exact covered range and continuation", () => {
    const store = new ResultStore({ maxOutputBytes: 1024 });
    const text = Array.from({ length: 100 }, (_, index) => `line ${index + 1}: 한🙂\\\"`).join("\n");
    const handle = object(store.present("s", { text })).handle;
    const first = object(store.read("s", { handle, pointer: "/text", startLine: 1, lineCount: 100 }));
    expect(size(first)).toBeLessThanOrEqual(1024);
    expect(first.coverage.complete).toBe(false);
    expect(first.value).toBe(text.split("\n").slice(0, first.coverage.endLine).join("\n"));
    expect(first.coverage.nextLine).toBe(first.coverage.endLine + 1);
    const second = object(store.read("s", { handle, pointer: "/text", startLine: first.coverage.nextLine, lineCount: 2 }));
    expect(second.value).toBe(text.split("\n").slice(first.coverage.endLine, first.coverage.endLine + 2).join("\n"));
    expect(second.coverage.wholeResult).toBe(false);
  });

  it("uses explicit character ranges for enormous single lines and measures serialized UTF-8 bytes", () => {
    const store = new ResultStore({ maxOutputBytes: 1024 });
    const text = "한🙂\u0000\\\"".repeat(1000);
    const handle = object(store.present("s", { text })).handle;
    expect(object(store.read("s", { handle, pointer: "/text" })).code).toBe("line_too_large");
    const part = object(store.read("s", { handle, pointer: "/text", startChar: 0, charCount: 100000 }));
    expect(size(part)).toBeLessThanOrEqual(1024);
    expect(part.value).toBe(text.slice(0, part.coverage.endChar));
    expect(part.coverage.complete).toBe(false);
    expect(part.coverage.nextChar).toBe(part.coverage.endChar);
    expect(part.value).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(object(store.read("s", { handle, pointer: "/text", startLine: 1, startChar: 0 })).code).toBe("invalid_range");
  });

  it("never bypasses the budget via huge nested arrays, keys, or scalar pointers", () => {
    const store = new ResultStore({ maxOutputBytes: 1024 });
    const raw = { array: Array.from({ length: 1000 }, (_, i) => ({ i, value: "🙂".repeat(15) })), ["key".repeat(1500)]: true, text: "x".repeat(3000) };
    const shown = object(store.present("s", raw));
    for (const view of [shown, store.read("s", { handle: shown.handle }), store.read("s", { handle: shown.handle, pointer: "/array" }), store.read("s", { handle: shown.handle, pointer: "/text", startChar: 0, charCount: 10000 })]) expect(size(view)).toBeLessThanOrEqual(1024);
    expect(object(store.read("s", { handle: shown.handle, pointer: "/array" })).shape.length).toBe(1000);
    expect(object(store.read("s", { handle: shown.handle, pointer: "/array/999/i" })).value).toBe(999);
  });

  it("searches the whole stored visible subtree with a literal, case-sensitive non-overlapping predicate", () => {
    const store = new ResultStore({ maxOutputBytes: 1024 });
    const handle = object(store.present("s", { logs: "ok\n".repeat(1000) + "error\nERROR\nerror error", nested: ["aaaa", "error"], number: 1 })).handle;
    const found = object(store.find("s", { handle, query: "error", limit: 1 }));
    expect(found.count).toBe(4);
    expect(found.scannedStrings).toBe(3);
    expect(found.matchedStartLines).toBe(3);
    expect(found.predicate).toMatchObject({ type: "literal_substring", query: "error", caseSensitive: true, overlapping: false, values: "strings_only" });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ pointer: "/logs", line: 1001, column: 1 });
    expect(found.nextOffset).toBe(1);
    expect(found.coverage).toMatchObject({ complete: false, wholeResult: false, predicateComplete: true });
    const next = object(store.find("s", { handle, query: "error", offset: 1, limit: 10 }));
    expect(next.count).toBe(4);
    expect(next.matches).toHaveLength(3);
    expect(next.nextOffset).toBeUndefined();
    expect(object(store.find("s", { handle, pointer: "/nested/0", query: "aa" })).count).toBe(2);
    expect(object(store.find("s", { handle, query: "fail" })).count).toBe(0);
    expect(found.guidance).toContain("does not prove semantic success");
    expect(size(found)).toBeLessThanOrEqual(1024);
  });

  it("keeps find metadata within the budget even with escaped queries and very long match paths", () => {
    const store = new ResultStore({ maxOutputBytes: 1024 });
    const handle = object(store.present("s", { ["k".repeat(2000)]: "error", pad: "x".repeat(2000) })).handle;
    const found = object(store.find("s", { handle, query: "error" }));
    expect(found.count).toBe(1);
    expect(found.matchLocationsOmitted).toBe(true);
    expect(found.nextOffset).toBeUndefined();
    expect(size(found)).toBeLessThanOrEqual(1024);
    for (const query of ["\u0000".repeat(200), "한".repeat(1000), ""]) {
      const result = store.find("s", { handle, query });
      expect(isResultError(result)).toBe(true);
      expect(size(result)).toBeLessThanOrEqual(1024);
    }
  });

  it("isolates scopes, expires handles and bounds memory using LRU eviction", () => {
    let now = 100;
    const store = new ResultStore({ maxOutputBytes: 1024, maxEntries: 2, maxBytes: 10000, ttlMs: 10, now: () => now });
    const a = object(store.present("a", "a".repeat(2000))).handle;
    const b = object(store.present("b", "b".repeat(2000))).handle;
    expect(object(store.read("other", { handle: a })).code).toBe("scope_denied");
    store.read("a", { handle: a, startChar: 0, charCount: 1 });
    const c = object(store.present("c", "c".repeat(2000))).handle;
    expect(object(store.read("b", { handle: b })).code).toBe("not_found");
    expect(store.size).toBe(2);
    expect(store.storedBytes).toBeLessThanOrEqual(10000);
    now = 111;
    expect(object(store.find("a", { handle: a, query: "a" })).code).toBe("expired");
    store.clearScope("c");
    expect(object(store.read("c", { handle: c })).code).toBe("not_found");
    expect(store.storedBytes).toBe(0);
  });

  it("reports oversized originals and non-JSON values without pretending to retain a handle", () => {
    const store = new ResultStore({ maxResultBytes: 100 });
    expect(object(store.present("s", "x".repeat(200))).code).toBe("result_too_large");
    expect(object(store.present("s", undefined)).code).toBe("invalid_result");
    expect(object(store.present("s", 1n)).code).toBe("invalid_result");
    expect(store.size).toBe(0);
    expect(() => new ResultStore({ maxOutputBytes: 10 })).toThrow();
  });

  it("points oversized compound browser results at the actual snapshot rather than host guidance", () => {
    const store = new ResultStore({ maxOutputBytes: 15_800 });
    const text = '- textbox "수령인" [ref=e6]\n' + "observation\n".repeat(1400);
    const result = store.present("browser", { action: { content: [] }, observation: {
      server: "playwright", method: "browser_snapshot", args: {}, outcome: {
        ok: true, execution: "completed", result: { content: [{ type: "text", text }] },
      },
    }, guidance: "Use exact references from the snapshot, not this guidance string." });
    const shown = object(result);
    expect(shown.nextCall.args.pointer).toBe("/observation/outcome/result/content/0/text");
    const page = object(store.read("browser", shown.nextCall.args));
    expect(page.value).toContain('[ref=e6]');
    expect(page.coverage.complete).toBe(false);
    expect(size(shown)).toBeLessThanOrEqual(15_800);
  });
});
