import { describe, expect, it, vi } from "vitest";
import { mcpReplyRecovery } from "../src/recovery.js";

const json = JSON.stringify({ server: "playwright", method: "browser_navigate", args: { url: "https://example.test/Path?x=1&y=2" } });
const known = (server: string, method: string) => server === "playwright" && method === "browser_navigate";
const fenced = (body: string, language = "json") => `\`\`\`${language}\n${body}\n\`\`\``;

describe("MCP prose recovery detector", () => {
  it("recognizes whole-body JSON and complete JSON/bare fences amid prose", () => {
    const feedback = mcpReplyRecovery(json, known);
    expect(feedback).toContain("did not dispatch a tool call");
    expect(mcpReplyRecovery(` \n${json}\t `, known)).toBe(feedback);
    expect(mcpReplyRecovery(`다음 작업입니다.\n${fenced(json)}\n이후 확인합니다.`, known)).toBe(feedback);
    expect(mcpReplyRecovery(fenced(json, ""), known)).toBe(feedback);
    expect(mcpReplyRecovery(fenced(json, "JSON").replaceAll("\n", "\r\n"), known)).toBe(feedback);
    expect(mcpReplyRecovery(`${fenced('{"irrelevant":true}')}\n${fenced(json)}`, known)).toBe(feedback);
  });

  it("returns static feedback with original authorization and previous-execution caveats, never echoed arguments", () => {
    const privateJson = JSON.stringify({ server: "playwright", method: "browser_navigate", args: { value: "SECRET\n`hostile` \"quote\" \\path", nested: { enabled: true } } });
    const feedback = mcpReplyRecovery(privateJson, known)!;
    expect(feedback).toBe(mcpReplyRecovery(json, known));
    expect(feedback).toContain("original user authorized an unfinished action");
    expect(feedback).toContain("Earlier calls may already have run");
    expect(feedback).toContain("Do not repeat completed writes");
    expect(feedback).toContain("execution is unknown");
    expect(feedback).toContain("illustration or explanation");
    expect(feedback).not.toContain("SECRET");
    expect(feedback).not.toContain("https://");
  });

  it("uses exact decoded identity without case folding or aliasing", () => {
    const lookup = vi.fn(() => false);
    const exact = JSON.stringify({ server: "Case_Sensitive", method: "Method-ID", args: {} });
    expect(mcpReplyRecovery(exact, lookup)).toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("Case_Sensitive", "Method-ID");
    expect(mcpReplyRecovery(json, () => false)).toBeUndefined();
  });

  it("requires exactly the invocation fields and an object args before looking up any tool", () => {
    const lookup = vi.fn(() => true);
    for (const value of [
      null, [], { server: "x", method: "y" }, { server: "x", method: "y", args: null },
      { server: "x", method: "y", args: [] }, { server: "x", method: "y", args: "{}" },
      { server: "x", method: "y", args: {}, extra: true }, { server: "", method: "y", args: {} },
      { server: "x", method: 4, args: {} }, { name: "mcp", arguments: { server: "x", method: "y", args: {} } },
    ]) expect(mcpReplyRecovery(JSON.stringify(value), lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not repair malformed JSON or interpret inline prose, other code languages or unfinished fences", () => {
    const lookup = vi.fn(() => true);
    for (const content of [
      json.slice(0, -1), fenced(json.slice(0, -1)), `Example: ${json}`, fenced(json, "javascript"),
      fenced(json, "python"), fenced(json, "json extra"), `\`\`\`json\n${json}`,
      `\`\`\`javascript\n\`\`\`json\n${json}\n\`\`\``,
      "ordinary prose", "", fenced(json.replace('"args":', "args:")),
    ]) expect(mcpReplyRecovery(content, lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("limits content and fence scanning without evaluating out-of-bound candidates", () => {
    const lookup = vi.fn(() => true);
    expect(mcpReplyRecovery(" ".repeat(65_536) + json, lookup)).toBeUndefined();
    const eight = Array.from({ length: 8 }, () => fenced("not JSON")).join("\n");
    expect(mcpReplyRecovery(`${eight}\n${fenced(json)}`, lookup)).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    const seven = Array.from({ length: 7 }, () => fenced("not JSON")).join("\n");
    expect(mcpReplyRecovery(`${seven}\n${fenced(json)}`, lookup)).toBeDefined();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
