/** Model-facing discovery is separate from the authoritative MCP schemas. */
export const HOST_SERVER_ID = "__motif_host__";

export interface CatalogTool {
  server: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  aliases?: readonly string[];
}

export interface CatalogOptions {
  /** Extra capability phrases keyed by `server/tool`; identifiers are never translated. */
  aliases?: Record<string, readonly string[]>;
  maxCards?: number;
  maxOutputBytes?: number;
  minScore?: number;
}

export interface ToolCard {
  server: string;
  method: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  schemaOmitted?: true;
}

export interface DiscoveryResult {
  kind: "mcp_discovery";
  ok: boolean;
  cards: ToolCard[];
  abstained: boolean;
  reason?: string;
  omitted?: number;
}

const utf8Size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const normalize = (value: string): string => value.normalize("NFKC").toLocaleLowerCase("en-US");
const stopWords = new Set(["a", "an", "and", "are", "at", "be", "by", "can", "do", "for", "from", "i", "in", "is", "it", "me", "of", "on", "or", "please", "the", "this", "to", "tool", "tools", "use", "with"]);
const singulars: Record<string, string> = {
  issues: "issue", files: "file", documents: "document", repositories: "repository", entities: "entity",
  relations: "relation", notes: "note", pages: "page", messages: "message", elements: "element",
  navigation: "navigate", navigating: "navigate", filling: "fill", clicking: "click", reading: "read", writing: "write",
};
const genericTerms = new Set(["get", "list", "read", "create", "search", "find", "retrieve", "lookup"]);
const koreanAliases: Record<string, readonly string[]> = {
  "검색": ["search", "find"], "찾아": ["search", "find"], "조회": ["lookup", "get", "retrieve"],
  "이슈": ["issue"], "파일": ["file"], "문서": ["document", "docs"], "저장소": ["repository", "repo"],
  "날씨": ["weather"], "시간": ["time", "clock"], "데이터베이스": ["database", "sql"],
  "페이지": ["page"], "이메일": ["email", "mail"], "일정": ["calendar", "schedule"],
  "생성": ["create"], "삭제": ["delete", "remove"], "목록": ["list"], "상태": ["status"],
  "접속": ["navigate"], "이동": ["navigate"], "브라우저": ["browser"], "양식": ["form", "fill"],
  "입력": ["fill", "type"], "클릭": ["click"], "눌러": ["click"], "누르": ["click"],
  "스냅샷": ["snapshot"], "화면": ["snapshot"], "읽어": ["read"], "작성": ["write"],
};

function tokens(value: string): string[] {
  const separated = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return [...new Set((normalize(separated).match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => !stopWords.has(term)).map((term) => singulars[term] ?? term))];
}

function schemaTerms(schema: Record<string, unknown>): Set<string> {
  const names: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || names.length >= 128 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 16)) visit(item, depth + 1);
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.properties && typeof object.properties === "object" && !Array.isArray(object.properties)) {
      names.push(...Object.keys(object.properties).slice(0, 128 - names.length));
    }
    for (const key of ["properties", "items", "anyOf", "oneOf", "allOf", "$defs"]) visit(object[key], depth + 1);
    if (depth > 0 && !object.properties) for (const child of Object.values(object).slice(0, 32)) visit(child, depth + 1);
  };
  visit(schema, 0);
  return new Set(tokens(names.join(" ")));
}

function boundedInt(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.min(maximum, Math.floor(value)));
}

interface IndexedTool {
  tool: CatalogTool;
  name: Set<string>;
  server: Set<string>;
  description: Set<string>;
  fields: Set<string>;
  aliases: string[];
}

export class ToolCatalog {
  private entries: IndexedTool[] = [];
  private readonly maxCards: number;
  private readonly budget: number;
  private readonly minScore: number;

  constructor(tools: readonly CatalogTool[] = [], private readonly options: CatalogOptions = {}) {
    this.maxCards = boundedInt(options.maxCards, 3, 8);
    this.budget = options.maxOutputBytes ?? 12_288;
    this.minScore = options.minScore ?? 2.5;
    if (!Number.isInteger(this.budget) || this.budget < 1024 || !Number.isFinite(this.minScore) || this.minScore <= 0) throw new RangeError("Invalid discovery output budget or score threshold.");
    this.replace(tools);
  }

  replace(tools: readonly CatalogTool[]): void {
    // Sort once so ties and tool cards do not depend on server connection order.
    const unique = new Map<string, CatalogTool>();
    for (const tool of tools) if (tool.server !== HOST_SERVER_ID) unique.set(`${tool.server}\0${tool.name}`, tool);
    this.entries = [...unique.values()].sort((a, b) => `${a.server}/${a.name}`.localeCompare(`${b.server}/${b.name}`)).map((tool) => ({
      tool,
      name: new Set(tokens(tool.name)),
      server: new Set(tokens(tool.server)),
      description: new Set(tokens((tool.description ?? "").slice(0, 8192))),
      fields: schemaTerms(tool.inputSchema),
      aliases: [...tool.aliases ?? [], ...this.options.aliases?.[`${tool.server}/${tool.name}`] ?? []].map(normalize),
    }));
  }

  search(query: string, options: { limit?: number; server?: string } = {}): DiscoveryResult {
    if (typeof query !== "string" || query.length > 16_384 || !query.trim()) return this.empty("Supply a non-empty query of at most 16384 characters.", false);
    const lower = normalize(query);
    // Issue IDs and run numbers must not beat a capability match merely by appearing in descriptions.
    const withoutIds = lower.replace(/\b[\p{L}]{1,16}[-_]\d[\p{L}\p{N}_-]*\b/gu, " ");
    const terms = tokens(withoutIds).filter((term) => !/\d/u.test(term));
    for (const [alias, expanded] of Object.entries(koreanAliases)) if (lower.includes(alias)) terms.push(...expanded);
    const uniqueTerms = [...new Set(terms)];
    const mentions = (name: string): boolean => {
      const escaped = normalize(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Korean particles may follow an ASCII tool identifier without a space.
      // Match the whole identifier, never a longer tool's prefix.
      return new RegExp(`(^|[^a-z0-9_.-])${escaped}($|[^a-z0-9_.-])`, "u").test(lower);
    };
    const explicitTools = new Set(this.entries.filter(({ tool }) => (!options.server || tool.server === options.server)
      && (mentions(tool.name) || mentions(`${tool.server}/${tool.name}`) || mentions(`${tool.server}.${tool.name}`))).map(({ tool }) => tool));
    if (!uniqueTerms.length && !explicitTools.size) return this.empty("No capability terms found; search by what the tool does rather than an identifier.");
    const scored = this.entries.filter(({ tool }) => !options.server || tool.server === options.server).map((entry) => {
      let score = 0;
      for (const term of uniqueTerms) {
        const weight = genericTerms.has(term) && uniqueTerms.some((other) => !genericTerms.has(other) && /^[a-z]+$/u.test(other)) ? 0.35 : 1;
        if (entry.name.has(term)) score += 7 * weight;
        if (entry.server.has(term)) score += 2.5 * weight;
        if (entry.description.has(term)) score += 2 * weight;
        if (entry.fields.has(term)) score += weight;
        if (entry.aliases.some((alias) => tokens(alias).includes(term))) score += 5 * weight;
      }
      const exactName = normalize(entry.tool.name);
      const exactServer = normalize(entry.tool.server);
      if (lower === exactName || lower.includes(`${exactServer}/${exactName}`) || lower.includes(`${exactServer}.${exactName}`)) score += 25;
      if (lower === exactServer) score += 8;
      if (entry.aliases.some((alias) => alias.length > 1 && lower.includes(alias))) score += 12;
      const explicit = explicitTools.has(entry.tool);
      return { entry, score, explicit };
    }).filter(({ score, explicit }) => explicit || score >= this.minScore).sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || `${a.entry.tool.server}/${a.entry.tool.name}`.localeCompare(`${b.entry.tool.server}/${b.entry.tool.name}`));
    if (!scored.length) return this.empty("No sufficiently relevant tools found. Try a capability name, server/tool name, or a more specific query.");
    const selected = scored.slice(0, boundedInt(options.limit, this.maxCards, this.maxCards));
    const result: DiscoveryResult = { kind: "mcp_discovery", ok: true, cards: [], abstained: false };
    for (const { entry } of selected) {
      const card = this.card(entry.tool);
      if (utf8Size({ ...result, cards: [...result.cards, card], omitted: selected.length }) <= this.budget) result.cards.push(card);
    }
    if (result.cards.length < selected.length) result.omitted = selected.length - result.cards.length;
    if (!result.cards.length) return this.empty("Matching schemas exceed the discovery budget. Describe a specific server/tool.");
    return result;
  }

  describe(server: string, name: string): DiscoveryResult {
    const found = this.entries.find(({ tool }) => tool.server === server && tool.name === name);
    if (!found) return this.empty("Unknown or unavailable server/tool.", false);
    const card = this.card(found.tool);
    const result: DiscoveryResult = { kind: "mcp_discovery", ok: true, cards: [card], abstained: false };
    if (utf8Size(result) > this.budget) return this.empty("This tool schema exceeds the model-facing budget; use a smaller tool or raise the configured discovery budget.", false);
    return result;
  }

  prefetch(query: string, limit?: number): string | undefined {
    const result = this.search(query, { ...(limit !== undefined ? { limit } : {}) });
    return result.abstained ? undefined : JSON.stringify(result);
  }

  private card(tool: CatalogTool): ToolCard {
    // Do not simplify a schema into an incorrect contract. Oversized cards abstain instead.
    return { server: tool.server, method: tool.name, ...(tool.description ? { description: tool.description.slice(0, 2048) } : {}), inputSchema: tool.inputSchema };
  }

  private empty(reason: string, ok = true): DiscoveryResult {
    return { kind: "mcp_discovery", ok, cards: [], abstained: true, reason };
  }
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });
const handle = { type: "string", minLength: 1 };
const pointer = { type: "string", description: "RFC 6901 JSON Pointer. Empty string selects the root; /structuredContent/decision selects that field." };
const positiveInteger = { type: "integer", minimum: 1 };

/** Full control contracts, with literal valid JSON calls rather than placeholder notation. */
export const HOST_CONTROL_CARDS = [
  {
    server: HOST_SERVER_ID, method: "search", description: "Find relevant allowed MCP tools and their original input schemas. Search capabilities, not numeric IDs.",
    inputSchema: objectSchema({ query: { type: "string", minLength: 1, maxLength: 16384 }, limit: { type: "integer", minimum: 1, maximum: 8 }, server: { type: "string" } }, ["query"]),
    example: { server: HOST_SERVER_ID, method: "search", args: { query: "이슈 상태 조회", limit: 3 } },
  },
  {
    server: HOST_SERVER_ID, method: "describe", description: "Get the exact input schema for one known server/tool before calling it.",
    inputSchema: objectSchema({ server: { type: "string", minLength: 1 }, method: { type: "string", minLength: 1 } }, ["server", "method"]),
    example: { server: HOST_SERVER_ID, method: "describe", args: { server: "lab", method: "lookup_case" } },
  },
  {
    server: HOST_SERVER_ID, method: "read_result", description: "Read an in-memory result handle (never a file). Choose line paging OR character paging, never both. Partial reads support only their stated coverage. Lines are 1-based; characters are 0-based UTF-16 code units.",
    inputSchema: {
      ...objectSchema({ handle, pointer, startLine: positiveInteger, lineCount: { ...positiveInteger, maximum: 1000 }, startChar: { type: "integer", minimum: 0 }, charCount: { ...positiveInteger, maximum: 100000 } }, ["handle"]),
      not: { allOf: [ { anyOf: [{ required: ["startLine"] }, { required: ["lineCount"] }] }, { anyOf: [{ required: ["startChar"] }, { required: ["charCount"] }] } ] },
    },
    example: { server: HOST_SERVER_ID, method: "read_result", args: { handle: "mcp_result_0123456789", pointer: "/structuredContent/decision" } },
  },
  {
    server: HOST_SERVER_ID, method: "find_result", description: "Count exact case-sensitive non-overlapping literal matches in stored string values. Zero matches proves only this predicate, never overall task success. offset pages occurrences, not characters.",
    inputSchema: objectSchema({ handle, pointer, query: { type: "string", minLength: 1 }, offset: { type: "integer", minimum: 0 }, limit: { ...positiveInteger, maximum: 100 } }, ["handle", "query"]),
    example: { server: HOST_SERVER_ID, method: "find_result", args: { handle: "mcp_result_0123456789", pointer: "/structuredContent/buildLogs", query: "error", offset: 0, limit: 10 } },
  },
] as const;
