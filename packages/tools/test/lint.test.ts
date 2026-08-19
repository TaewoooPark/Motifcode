import { describe, expect, it } from "vitest";
import { CORE_TOOLS, CORE_TOOL_NAMES, toolPrefix, selectTools } from "../src/schemas.js";
import { lintTools, LIMITS } from "../src/lint.js";
import type { Tool } from "@motifcode/protocol";

describe("core tool set", () => {
  it("passes its own linter", () => {
    expect(lintTools(CORE_TOOLS)).toEqual([]);
  });

  it("stays within the budget the repair oracle needs", () => {
    expect(CORE_TOOLS.length).toBeLessThanOrEqual(LIMITS.maxTools);
  });

  it("leads with the tools every agent needs, so subsets are prefixes", () => {
    expect(CORE_TOOL_NAMES.slice(0, 3)).toEqual(["done", "bash", "read"]);
  });

  it("toolPrefix returns a real prefix", () => {
    expect(toolPrefix(3).map((t) => ("function" in t ? t.function.name : ""))).toEqual([
      "done",
      "bash",
      "read",
    ]);
  });

  it("selectTools preserves canonical order regardless of argument order", () => {
    const a = selectTools(["bash", "done"]);
    const b = selectTools(["done", "bash"]);
    expect(a).toEqual(b);
  });
});

describe("linter", () => {
  const bad = (fn: object): Tool[] => [{ type: "function", function: fn } as Tool];

  it("rejects an open schema", () => {
    const f = lintTools(
      bad({ name: "x", description: "d", parameters: { type: "object", properties: { a: { type: "string", description: "d" } } } }),
    );
    expect(f.map((x) => x.rule)).toContain("closed-schema");
  });

  it("rejects a parameterless tool", () => {
    const f = lintTools(
      bad({ name: "x", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false } }),
    );
    expect(f.map((x) => x.rule)).toContain("empty-params");
  });

  it("rejects nested objects", () => {
    const f = lintTools(
      bad({
        name: "x",
        description: "d",
        parameters: {
          type: "object",
          properties: { a: { type: "object", description: "d" } },
          additionalProperties: false,
        },
      }),
    );
    expect(f.map((x) => x.rule)).toContain("no-nested-objects");
  });

  it("rejects names that are substrings of each other", () => {
    const tools = [
      { type: "function", function: { name: "run", description: "d", parameters: { type: "object", properties: { a: { type: "string", description: "d" } }, additionalProperties: false } } },
      { type: "function", function: { name: "run_code", description: "d", parameters: { type: "object", properties: { a: { type: "string", description: "d" } }, additionalProperties: false } } },
    ] as Tool[];
    expect(lintTools(tools).map((x) => x.rule)).toContain("substring-name");
  });
});
