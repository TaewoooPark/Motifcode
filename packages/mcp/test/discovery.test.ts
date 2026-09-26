import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { HOST_CONTROL_CARDS, HOST_SERVER_ID, ToolCatalog, type CatalogTool } from "../src/discovery.js";

const schema = { type: "object", properties: { id: { type: "string", pattern: "^CASE-[0-9]+$" }, active: { type: ["boolean", "null"] } }, required: ["id"], additionalProperties: false };
const tools: CatalogTool[] = [
  { server: "lab", name: "lookup_case", description: "Get case status and review decision", inputSchema: schema },
  { server: "archive", name: "archive_export", description: "Export old data CASE-007 CASE-007 CASE-007 007 007", inputSchema: { type: "object", properties: {} } },
  { server: "weather", name: "get_weather", description: "Current weather forecast for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { server: "git", name: "search_issues", description: "Search repository issues", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
];

describe("ToolCatalog", () => {
  it("ranks capability matches over numeric IDs and abstains for identifiers alone", () => {
    const catalog = new ToolCatalog(tools);
    expect(catalog.search("CASE-007 상태 조회").cards[0]?.method).toBe("lookup_case");
    expect(catalog.search("CASE-007").abstained).toBe(true);
    expect(catalog.search("007 123 2026").cards).toEqual([]);
    expect(catalog.search("quantum entanglement pancakes").abstained).toBe(true);
    expect(catalog.search("get issue status").cards[0]?.method).not.toBe("get_weather");
    expect(catalog.search("search repository issue").cards[0]?.method).toBe("search_issues");
  });

  it("supports Korean capability aliases and configurable exact tool aliases", () => {
    const catalog = new ToolCatalog(tools, { aliases: { "lab/lookup_case": ["심사결과", "검토 승인 조회"] } });
    expect(catalog.search("서울 날씨 알려줘").cards[0]?.method).toBe("get_weather");
    expect(catalog.search("이슈 검색해줘").cards[0]?.method).toBe("search_issues");
    expect(catalog.search("심사결과 알려줘").cards[0]?.method).toBe("lookup_case");
    expect(catalog.search("lab/lookup_case").cards[0]?.server).toBe("lab");
  });

  it("returns original schemas without losing nested or falsy constraints", () => {
    const catalog = new ToolCatalog(tools);
    const result = catalog.describe("lab", "lookup_case");
    expect(result.cards[0]?.inputSchema).toEqual(schema);
    expect(JSON.parse(catalog.prefetch("lab/lookup_case")!).cards[0].inputSchema).toEqual(schema);
    expect(catalog.describe("lab", "missing").ok).toBe(false);
  });

  it("prioritizes tools explicitly named in prose over overlapping descriptions and payload fields", () => {
    const names = ["create_entities", "create_relations", "open_nodes", "add_observations"];
    const catalog = new ToolCatalog(names.map((name) => ({ server: "memory", name,
      description: name === "add_observations" ? "entities relations name observations owner path approved retries project repository" : name,
      inputSchema: { type: "object", properties: {} },
    })));
    const result = catalog.search("create_entities로 entities observations owner path approved retries를 저장하고 create_relations로 relations를 추가한 다음 open_nodes로 조회하세요.");
    expect(result.cards.map((card) => card.method).sort()).toEqual(["create_entities", "create_relations", "open_nodes"]);
  });

  it("matches explicit identifiers as whole names, including numeric or regex punctuation names", () => {
    const catalog = new ToolCatalog(["v2", "read.v2", "reader_v2"].map((name) => ({ server: "lab", name, inputSchema: { type: "object" } })));
    expect(catalog.search("v2").cards[0]?.method).toBe("v2");
    expect(catalog.search("lab/read.v2로 처리").cards[0]?.method).toBe("read.v2");
    expect(catalog.search("reader_v2로 처리").cards[0]?.method).toBe("reader_v2");
  });

  it("limits top-k, breaks ties deterministically and filters the authorized server catalog", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ server: `server${String(i).padStart(2, "0")}`, name: "search", description: "Search text", inputSchema: { type: "object" } }));
    const catalog = new ToolCatalog([...many].reverse(), { maxCards: 3 });
    expect(catalog.search("search", { limit: 100 }).cards).toHaveLength(3);
    expect(catalog.search("search").cards.map((t) => t.server)).toEqual(["server00", "server01", "server02"]);
    expect(catalog.search("search", { server: "server19" }).cards.map((t) => t.server)).toEqual(["server19"]);
    catalog.replace([many[10]!]);
    expect(catalog.search("search").cards.map((t) => t.server)).toEqual(["server10"]);
  });

  it("reserves the host namespace and does not expose oversized cards as valid schemas", () => {
    const oversized: CatalogTool = { server: "huge", name: "search", inputSchema: { type: "object", description: "🙂".repeat(2000) } };
    const catalog = new ToolCatalog([{ ...tools[0]!, server: HOST_SERVER_ID }, oversized], { maxOutputBytes: 1024 });
    expect(catalog.describe(HOST_SERVER_ID, "lookup_case").ok).toBe(false);
    expect(catalog.search("search").abstained).toBe(true);
    expect(catalog.describe("huge", "search").ok).toBe(false);
    for (const result of [catalog.search("search"), catalog.describe("huge", "search")]) expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
  });

  it("bounds UTF-8 output with nested schemas and exposes full control schemas plus valid object examples", () => {
    const catalog = new ToolCatalog(Array.from({ length: 12 }, (_, i) => ({ server: `s${i}`, name: "search", description: "한🙂".repeat(50), inputSchema: { type: "object", properties: { nested: { type: "object", properties: { raw: { const: "한🙂\\\"\u0000".repeat(8) } } } } } })), { maxCards: 8, maxOutputBytes: 1024 });
    expect(Buffer.byteLength(JSON.stringify(catalog.search("search")))).toBeLessThanOrEqual(1024);
    expect(HOST_CONTROL_CARDS.map((card) => card.method)).toEqual(["search", "describe", "read_result", "find_result"]);
    for (const card of HOST_CONTROL_CARDS) {
      const call = JSON.parse(JSON.stringify(card.example));
      expect(Object.keys(call)).toEqual(["server", "method", "args"]);
      expect(call.server).toBe(HOST_SERVER_ID);
      expect(typeof call.args).toBe("object");
      const inputSchema = card.inputSchema as Record<string, unknown>;
      expect(inputSchema.additionalProperties).toBe(false);
      for (const name of inputSchema.required as string[]) expect(call.args).toHaveProperty(name);
      const validate = new Ajv({ strict: false }).compile(inputSchema);
      expect(validate(call.args)).toBe(true);
      if (card.method === "read_result") {
        expect(validate({ handle: "mcp_result_example", startLine: 1, startChar: 0 })).toBe(false);
        expect(validate({ handle: "mcp_result_example", lineCount: 2, charCount: 3 })).toBe(false);
        expect(validate({ handle: "mcp_result_example", startLine: 1, lineCount: 2 })).toBe(true);
        expect(validate({ handle: "mcp_result_example", startChar: 0, charCount: 20 })).toBe(true);
      }
    }
  });
});
