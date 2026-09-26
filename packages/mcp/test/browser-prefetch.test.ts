import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCatalog } from "../src/discovery.js";
import { McpSession, type McpSessionOptions } from "../src/session.js";
import type { McpConfig } from "../src/config.js";
import type { McpTool } from "../src/manager.js";

const sessions: McpSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.close())); vi.restoreAllMocks(); });
const methods = ["browser_navigate", "browser_fill_form", "browser_click", "browser_evaluate", "browser_run_code", "browser_snapshot"];
const query = "Playwright MCP로 http://127.0.0.1:4321/duplicates 에 접속해서 별빛 실험실의 수령인은 김하늘, 이메일은 star@example.test, 수량은 2로 입력하세요. 예약하기 버튼을 누르세요. browser_evaluate 또는 browser_run_code로 우회하지 마세요.";
const config: McpConfig = { servers: [{ id: "web-a", enabled: true, transport: "stdio", command: "unused", profile: "playwright" }] };
function tools(server = "web-a"): McpTool[] {
  return methods.map((name) => ({ server, name, description: name, inputSchema: name === "browser_fill_form"
    ? { type: "object", properties: { fields: { type: "array", items: { type: "object", properties: { type: { enum: ["textbox", "checkbox", "combobox"] }, value: { type: "string" } }, required: ["type", "value"], additionalProperties: false } } }, required: ["fields"], additionalProperties: false }
    : { type: "object", properties: { value: { type: "string" } }, additionalProperties: false }, requiresUserInteraction: false, schemaHash: name }));
}
function fixture(settings = config, catalog = tools(), options: McpSessionOptions = {}) {
  const session = new McpSession(settings, options); sessions.push(session);
  vi.spyOn(session.manager, "catalog").mockResolvedValue(catalog);
  const invoke = vi.spyOn(session.manager, "invoke");
  return { session, invoke, prepare: async (task = query) => JSON.parse((await session.prepare(task)).split("\n").at(-1)!) };
}

describe("opt-in browser form prefetch", () => {
  it("reproduces forbidden-name ranking and supplies three original form schemas without dispatch", async () => {
    const old = new ToolCatalog(tools()).search(query);
    expect(old.cards.map((card) => card.method)).toEqual(expect.arrayContaining(["browser_evaluate", "browser_run_code"]));
    expect(old.cards.filter((card) => ["browser_navigate", "browser_fill_form", "browser_click"].includes(card.method))).toHaveLength(1);
    const { prepare, invoke } = fixture();
    const data = await prepare();
    expect(data.selected.cards.map((card: { method: string }) => card.method)).toEqual(["browser_navigate", "browser_fill_form", "browser_click"]);
    expect(data.selected.cards[1].inputSchema).toEqual(tools()[1]!.inputSchema);
    expect(data.selected.cards.every((card: { server: string }) => card.server === "web-a")).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("also recognizes an explicit English form request", async () => {
    const { prepare } = fixture();
    const data = await prepare("In the browser at https://example.test, fill the form with name Jane and email jane@example.test. Do not use browser_evaluate or browser_run_code.");
    expect(data.selected.cards.map((card: { method: string }) => card.method)).toEqual(["browser_navigate", "browser_fill_form", "browser_click"]);
  });

  it.each([
    "양식의 이름과 이메일을 입력하세요. browser_evaluate browser_run_code",
    "브라우저 양식 문서를 읽어 주세요. browser_evaluate browser_run_code",
    "http://example.test 양식은 입력하지 마세요. browser_evaluate browser_run_code",
    "브라우저에서 browser_evaluate와 browser_run_code 차이를 설명해 주세요.",
  ])("keeps ordinary ranking outside explicit browser-form request scope: %s", async (task) => {
    const { prepare } = fixture();
    expect((await prepare(task)).selected).toEqual(new ToolCatalog(tools(), { maxCards: 8, maxOutputBytes: 16_000 }).search(task, { limit: 3 }));
  });

  it("requires the profile and leaves catalog/search comparison modes unchanged", async () => {
    const unprofiled = { servers: config.servers.map(({ profile: _profile, ...server }) => server) };
    expect((await fixture(unprofiled).prepare()).selected.cards.map((card: { method: string }) => card.method)).toContain("browser_evaluate");
    expect((await fixture(config, tools(), { exposure: "search" }).prepare()).selected).toBeUndefined();
    expect((await fixture(config, tools(), { exposure: "catalog" }).prepare()).selected.cards.map((card: { method: string }) => card.method)).toEqual(methods);
  });

  it("does not invent or backfill unavailable tools, including allowed-list omissions", async () => {
    const limited = tools().filter((tool) => tool.name !== "browser_fill_form");
    const settings: McpConfig = { servers: [{ ...config.servers[0]!, deniedTools: ["browser_fill_form"] }] };
    const data = await fixture(settings, limited).prepare();
    expect(data.selected.cards.map((card: { method: string }) => card.method)).toEqual(["browser_navigate", "browser_click"]);
    expect((await fixture(config, []).prepare()).selected.cards).toEqual([]);
    const noPreferredTools = tools().filter((tool) => ["browser_evaluate", "browser_run_code"].includes(tool.name));
    expect((await fixture(config, noPreferredTools).prepare()).selected).toEqual(new ToolCatalog(noPreferredTools, { maxCards: 8, maxOutputBytes: 16_000 }).search(query, { limit: 3 }));
  });

  it("does not pick an ambiguous profile server and accepts one explicitly quoted ID", async () => {
    const settings: McpConfig = { servers: [config.servers[0]!, { ...config.servers[0]!, id: "web-b" }] };
    const catalog = [...tools(), ...tools("web-b")];
    const { prepare } = fixture(settings, catalog);
    expect((await prepare()).selected).toEqual(new ToolCatalog(catalog, { maxCards: 8, maxOutputBytes: 16_000 }).search(query, { limit: 3 }));
    const chosen = await prepare('"web-b" 서버로 ' + query);
    expect(chosen.selected.cards.map((card: { server: string; method: string }) => [card.server, card.method])).toEqual(["browser_navigate", "browser_fill_form", "browser_click"].map((method) => ["web-b", method]));
    const both = '"web-a"와 "web-b" ' + query;
    expect((await prepare(both)).selected).toEqual(new ToolCatalog(catalog, { maxCards: 8, maxOutputBytes: 16_000 }).search(both, { limit: 3 }));
  });

  it("ignores a disabled profile and respects the three-card UTF-8 schema budget", async () => {
    const settings: McpConfig = { servers: [{ ...config.servers[0]!, enabled: false }, { id: "other", enabled: true, transport: "stdio", command: "unused" }] };
    expect((await fixture(settings, tools("other")).prepare()).selected.cards.map((card: { method: string }) => card.method)).toContain("browser_evaluate");
    const catalog = tools();
    catalog[1]!.inputSchema = { type: "object", description: "🙂".repeat(5000) };
    const selected = (await fixture(config, catalog).prepare()).selected;
    expect(selected.cards.map((card: { method: string }) => card.method)).toEqual(["browser_navigate", "browser_click"]);
    expect(selected.omitted).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(16_000);
    expect((await fixture().prepare(query + "x".repeat(16_384))).selected.abstained).toBe(true);
  });

  it("catalog selection skips unknown references, deduplicates and applies its configured card cap", () => {
    const catalog = new ToolCatalog(tools(), { maxCards: 2, maxOutputBytes: 1024 });
    const selected = catalog.select([{ server: "missing", method: "browser_navigate" }, { server: "web-a", method: "browser_navigate" }, { server: "web-a", method: "browser_navigate" }, { server: "web-a", method: "browser_click" }, { server: "web-a", method: "browser_run_code" }], 8);
    expect(selected.cards.map((card) => card.method)).toEqual(["browser_navigate", "browser_click"]);
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(1024);
  });
});
