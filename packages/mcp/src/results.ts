import { randomUUID } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ResultView = JsonValue;
export interface ResultStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxResultBytes?: number;
  maxOutputBytes?: number;
  ttlMs?: number;
  now?: () => number;
}
export interface ReadResultArgs {
  handle: string;
  pointer?: string;
  startLine?: number;
  lineCount?: number;
  startChar?: number;
  charCount?: number;
}
export interface FindResultArgs {
  handle: string;
  pointer?: string;
  query: string;
  offset?: number;
  limit?: number;
}
interface Withheld {
  metadataFields: number;
  binaryBlocks: number;
}
interface StoredResult {
  scope: string;
  raw: string;
  bytes: number;
  expiresAt: number;
}
export interface ResultError {
  kind: "mcp_result_error";
  ok: false;
  code: string;
  message: string;
}

const byteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const isObject = (value: JsonValue): value is { [key: string]: JsonValue } => value !== null && typeof value === "object" && !Array.isArray(value);
export const serializeResultView = (value: ResultView): string => JSON.stringify(value);
export function isResultError(value: unknown): value is ResultError & { [key: string]: JsonValue } {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "mcp_result_error" && "ok" in value && value.ok === false;
}
function error(code: string, message: string): ResultError & { [key: string]: JsonValue } {
  return { kind: "mcp_result_error", ok: false, code, message };
}
function positiveOption(value: number | undefined, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) throw new RangeError(`Result store limits must be integers >= ${minimum}`);
  return value;
}

/** Sanitization is a presentation projection; the bounded store retains the original JSON. */
function project(value: JsonValue, withheld: Withheld): JsonValue {
  if (Array.isArray(value)) return value.map((child) => project(child, withheld));
  if (!isObject(value)) return value;
  const result: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
  const binary = value.type === "image" || value.type === "audio";
  let hidBinary = false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "_meta") { withheld.metadataFields++; continue; }
    // Embedded resources may carry blobs without a top-level image/audio type.
    if ((binary && key === "data") || (key === "blob" && typeof child === "string")) { hidBinary = true; continue; }
    result[key] = project(child, withheld);
  }
  if (hidBinary) withheld.binaryBlocks++;
  return result;
}

function projection(raw: string): { value: JsonValue; withheld: Withheld } {
  const withheld = { metadataFields: 0, binaryBlocks: 0 };
  return { value: project(JSON.parse(raw) as JsonValue, withheld), withheld };
}

function select(value: JsonValue, pointer: string): { value: JsonValue } | undefined {
  if (pointer === "") return { value };
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/u.test(pointer)) return undefined;
  let selected = value;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(selected)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= selected.length) return undefined;
      selected = selected[Number(key)]!;
    } else if (isObject(selected) && Object.hasOwn(selected, key)) selected = selected[key]!;
    else return undefined;
  }
  return { value: selected };
}

function pointerPart(value: string): string { return value.replace(/~/g, "~0").replace(/\//g, "~1"); }
function typeOf(value: JsonValue): string { return value === null ? "null" : Array.isArray(value) ? "array" : typeof value; }
function integer(value: number | undefined, fallback: number, min: number, max: number): number | undefined {
  const v = value ?? fallback;
  return Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Local-only, scope-bound results. No method calls the remote server again. */
export class ResultStore {
  private readonly entries = new Map<string, StoredResult>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxResultBytes: number;
  private readonly outputBudget: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(options: ResultStoreOptions = {}) {
    this.maxEntries = positiveOption(options.maxEntries, 64);
    this.maxBytes = positiveOption(options.maxBytes, 32 * 1024 * 1024);
    this.maxResultBytes = Math.min(positiveOption(options.maxResultBytes, 8 * 1024 * 1024), this.maxBytes);
    // Smaller budgets cannot express a useful coverage contract plus a handle.
    this.outputBudget = positiveOption(options.maxOutputBytes, 24 * 1024, 1024);
    this.ttl = positiveOption(options.ttlMs, 15 * 60 * 1000);
    this.now = options.now ?? Date.now;
  }

  present(scope: string, result: unknown, focusTerms: readonly string[] = []): ResultView {
    if (!scope) return error("invalid_scope", "A non-empty execution scope is required.");
    let raw: string;
    try {
      const serialized = JSON.stringify(result);
      if (serialized === undefined) return error("invalid_result", "The MCP result is not JSON serializable.");
      raw = serialized;
    } catch { return error("invalid_result", "The MCP result is not JSON serializable."); }
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > this.maxResultBytes) return error("result_too_large", "The original result exceeds the bounded local store. No handle was retained; no complete-result claim is supported.");
    let projected: ReturnType<typeof projection>;
    try { projected = projection(raw); }
    catch { return error("invalid_result", "The result could not be safely projected as JSON."); }
    const { value, withheld } = projected;
    const filtered = withheld.metadataFields > 0 || withheld.binaryBlocks > 0;
    if (!filtered && byteSize(value) <= this.outputBudget) return value;
    this.evictExpired();
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    const handle = `mcp_result_${randomUUID()}`;
    this.entries.set(handle, { scope, raw, bytes, expiresAt: this.now() + this.ttl });
    this.bytes += bytes;
    const coverage = this.coverage("", withheld, false);
    const base: { [key: string]: JsonValue } = {
      kind: "mcp_result", handle, sourceBytes: bytes,
      ...(isObject(value) && typeof value.isError === "boolean" ? { isError: value.isError } : {}),
      coverage,
      guidance: "This handle is an opaque in-memory ID, NOT a file path. Use mcp on __motif_host__ with read_result or find_result. Partial content cannot establish whole-result success. Handles expire within this conversation.",
    };
    const full = { ...base, value, coverage: this.coverage("", withheld, true) };
    if (byteSize(full) <= this.outputBudget) return full;
    const summary = this.summary(base, value);
    if (isResultError(summary) || !isObject(summary)) return summary;
    const focus: JsonValue[] = [];
    for (const query of [...new Set(focusTerms)].slice(0, 6)) {
      if (typeof query !== "string" || query.length < 2 || query.length > 80) continue;
      const found = this.find(scope, { handle, query, limit: 1 });
      if (isResultError(found) || !isObject(found) || typeof found.count !== "number" || found.count === 0) continue;
      const exact = { query, count: found.count, matches: found.matches!, coverage: found.coverage!, predicate: found.predicate! };
      if (byteSize({ ...summary, focus: [...focus, exact] }) <= this.outputBudget) focus.push(exact);
    }
    if (focus.length) {
      // Literal retrieval, never a generated summary: the original task supplies
      // every search term, and the normal exact-search coverage contract remains.
      delete summary.nextCall;
      summary.focus = focus;
    }
    return summary;
  }

  read(scope: string, args: ReadResultArgs): ResultView {
    const loaded = this.load(scope, args.handle);
    if (isResultError(loaded)) return loaded;
    const { value, withheld } = loaded as Loaded;
    const pointer = args.pointer ?? "";
    if (!this.validPointer(pointer)) return error("invalid_pointer", "Use a short RFC 6901 JSON Pointer; empty string selects the root.");
    const selected = select(value, pointer);
    if (!selected) return error("pointer_not_found", "This pointer is absent from the model-visible result. Metadata and binary payloads are intentionally unavailable.");
    const base: { [key: string]: JsonValue } = {
      kind: "mcp_result_read", ok: true, handle: args.handle,
      coverage: this.coverage(pointer, withheld, true),
    };
    const requestedPage = args.startLine !== undefined || args.lineCount !== undefined || args.startChar !== undefined || args.charCount !== undefined;
    if (typeof selected.value !== "string" && requestedPage) return error("invalid_range", "Line and character ranges are only valid for string fields.");
    if (typeof selected.value === "string") return this.readString(base, selected.value, pointer, withheld, args, requestedPage);
    const full = { ...base, value: selected.value };
    if (byteSize(full) <= this.outputBudget) return full;
    return this.summary({ ...base, coverage: this.coverage(pointer, withheld, false), guidance: "This object or array is not fully included. Read a specific child using its JSON Pointer; do not infer omitted values." }, selected.value);
  }

  find(scope: string, args: FindResultArgs): ResultView {
    const loaded = this.load(scope, args.handle);
    if (isResultError(loaded)) return loaded;
    const { value, withheld } = loaded as Loaded;
    const pointer = args.pointer ?? "";
    if (!this.validPointer(pointer)) return error("invalid_pointer", "Use a short RFC 6901 JSON Pointer.");
    if (typeof args.query !== "string" || !args.query || byteSize(args.query) > Math.floor(this.outputBudget / 4)) return error("invalid_query", "Supply a non-empty exact literal query small enough to fit the result budget.");
    const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(args.limit, 20, 1, 100);
    if (offset === undefined || limit === undefined) return error("invalid_range", "offset must be a non-negative integer and limit must be between 1 and 100.");
    const selected = select(value, pointer);
    if (!selected) return error("pointer_not_found", "The pointer is absent from the model-visible result.");
    let count = 0, scannedStrings = 0, scannedLines = 0, matchedLines = 0;
    const candidates: JsonValue[] = [];
    const visit = (item: JsonValue, at: string): void => {
      if (typeof item === "string") {
        scannedStrings++;
        const lines = item.split("\n");
        scannedLines += lines.length;
        const hitLines = new Set<number>();
        let next = 0, lineIndex = 0, lineStart = 0;
        while (next <= item.length) {
          const index = item.indexOf(args.query, next);
          if (index < 0) break;
          while (lineIndex < lines.length - 1 && lineStart + lines[lineIndex]!.length < index) {
            lineStart += lines[lineIndex]!.length + 1; lineIndex++;
          }
          hitLines.add(lineIndex);
          if (count >= offset && candidates.length < limit) {
            const match: { [key: string]: JsonValue } = { pointer: at, line: lineIndex + 1, column: index - lineStart + 1, charOffset: index };
            // Exact local evidence avoids a second model turn just to read the
            // matching sentence. It remains an explicitly partial character slice.
            if (this.outputBudget >= 4096) {
              const start = Math.max(0, index - 200);
              const end = Math.min(item.length, index + args.query.length + 400);
              match.excerpt = item.slice(start, end);
              match.excerptStartChar = start;
              match.excerptEndChar = end;
              match.excerptComplete = start === 0 && end === item.length;
            }
            candidates.push(match);
          }
          count++;
          next = index + args.query.length;
        }
        matchedLines += hitLines.size;
      } else if (Array.isArray(item)) item.forEach((child, index) => visit(child, `${at}/${index}`));
      else if (isObject(item)) for (const [key, child] of Object.entries(item)) visit(child, `${at}/${pointerPart(key)}`);
    };
    visit(selected.value, pointer);
    const result: { [key: string]: JsonValue } = {
      kind: "mcp_result_find", ok: true, handle: args.handle,
      predicate: { type: "literal_substring", query: args.query, caseSensitive: true, overlapping: false, values: "strings_only" },
      coverage: { ...this.coverage(pointer, withheld, false), predicateComplete: true },
      count, scannedStrings, scannedLines, matchedStartLines: matchedLines,
      offset, matches: [],
      guidance: "The count covers this literal predicate over all visible string values under the pointer. It does not prove semantic success or absence of other error words. Match locations use UTF-16 code units.",
    };
    for (const candidate of candidates) {
      const matches = result.matches as JsonValue[];
      if (byteSize({ ...result, matches: [...matches, candidate], nextOffset: count }) > this.outputBudget) break;
      matches.push(candidate);
    }
    const nextOffset = offset + (result.matches as JsonValue[]).length;
    if (nextOffset < count && nextOffset > offset) result.nextOffset = nextOffset;
    if (nextOffset === offset && offset < count) result.matchLocationsOmitted = true;
    if (byteSize(result) > this.outputBudget) return error("view_too_large", "The search coverage cannot fit the output budget; select a shorter parent pointer or use a shorter query.");
    return result;
  }

  clearScope(scope: string): void {
    for (const [handle, entry] of this.entries) if (entry.scope === scope) this.remove(handle);
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  get size(): number { return this.entries.size; }
  get storedBytes(): number { return this.bytes; }

  private load(scope: string, handle: string): Loaded | (ResultError & { [key: string]: JsonValue }) {
    const entry = this.entries.get(handle);
    if (!entry) return error("not_found", "This result handle is unavailable, evicted, or from an earlier session.");
    if (entry.scope !== scope) return error("scope_denied", "This result handle belongs to another execution scope.");
    if (entry.expiresAt <= this.now()) { this.remove(handle); return error("expired", "This stored result has expired."); }
    const projected = projection(entry.raw);
    // LRU updates do not extend the retention TTL.
    this.entries.delete(handle); this.entries.set(handle, entry);
    return projected;
  }

  private coverage(pointer: string, withheld: Withheld, complete: boolean): { [key: string]: JsonValue } {
    return {
      pointer, complete, wholeResult: pointer === "" && complete && !withheld.metadataFields && !withheld.binaryBlocks,
      representation: "model_visible_projection", withheld: { ...withheld },
    };
  }

  private summary(base: { [key: string]: JsonValue }, value: JsonValue): ResultView {
    const shape: { [key: string]: JsonValue } = { type: typeOf(value) };
    if (Array.isArray(value)) shape.length = value.length;
    else if (typeof value === "string") shape.characters = value.length;
    else if (isObject(value)) { shape.keyCount = Object.keys(value).length; shape.keys = []; }
    const result: { [key: string]: JsonValue } = { ...base, shape };
    if (byteSize(result) > this.outputBudget) return error("view_too_large", "The result metadata cannot fit the output budget; use a shorter JSON Pointer.");
    const coverage = base.coverage as { pointer?: string } | undefined;
    const root = coverage?.pointer ?? "";
    const paths: JsonValue[] = [];
    const queue: { value: JsonValue; pointer: string; depth: number }[] = [{ value, pointer: root, depth: 0 }];
    let firstText: string | undefined;
    let longestText = -1;
    let singleLine = false;
    for (let i = 0; i < queue.length && i < 30; i++) {
      const item = queue[i]!;
      if (typeof item.value === "string" && item.value.length > longestText) {
        firstText = item.pointer;
        longestText = item.value.length;
        singleLine = !item.value.includes("\n");
      }
      if (item.depth > 0) {
        const entry: JsonValue = { pointer: item.pointer, type: typeOf(item.value), ...(typeof item.value === "string" ? { characters: item.value.length, lines: item.value.split("\n").length } : {}) };
        if (paths.length < 8 && byteSize({ ...result, paths: [...paths, entry] }) < this.outputBudget - 250) paths.push(entry);
      }
      if (item.depth >= 3) continue;
      const children = Array.isArray(item.value) ? item.value.slice(0, 4).map((v, index) => [String(index), v] as const)
        : isObject(item.value) ? Object.entries(item.value).slice(0, 8) : [];
      for (const [key, child] of children) queue.push({ value: child, pointer: `${item.pointer}/${pointerPart(key)}`, depth: item.depth + 1 });
    }
    if (paths.length) result.paths = paths;
    if (typeof base.handle === "string") {
      const args: { [key: string]: JsonValue } = { handle: base.handle, pointer: firstText ?? root };
      if (firstText !== undefined) {
        if (singleLine) { args.startChar = 0; args.charCount = 2000; }
        else { args.startLine = 1; args.lineCount = 40; }
      }
      const nextCall = { server: "__motif_host__", method: "read_result", args };
      if (byteSize({ ...result, nextCall }) <= this.outputBudget) result.nextCall = nextCall;
    }
    if (isObject(value)) {
      for (const key of Object.keys(value)) {
        const keys = shape.keys as JsonValue[];
        if (byteSize({ ...result, shape: { ...shape, keys: [...keys, key], keysComplete: false } }) > this.outputBudget) break;
        keys.push(key);
      }
      shape.keysComplete = (shape.keys as JsonValue[]).length === Object.keys(value).length;
    }
    return result;
  }

  private readString(base: { [key: string]: JsonValue }, value: string, pointer: string, withheld: Withheld, args: ReadResultArgs, requestedPage: boolean): ResultView {
    if (!requestedPage) {
      const full = { ...base, value };
      if (byteSize(full) <= this.outputBudget) return full;
    }
    if ((args.startChar !== undefined || args.charCount !== undefined) && (args.startLine !== undefined || args.lineCount !== undefined)) return error("invalid_range", "Choose either line paging or character paging, not both.");
    if (args.startChar !== undefined || args.charCount !== undefined) {
      const start = integer(args.startChar, 0, 0, value.length);
      const requested = integer(args.charCount, 2000, 1, 100000);
      if (start === undefined || requested === undefined) return error("invalid_range", "Character range is outside this string or invalid.");
      if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start] ?? "") && /[\uD800-\uDBFF]/u.test(value[start - 1]!)) return error("invalid_range", "startChar splits a surrogate pair; start at the preceding code unit.");
      let low = 0, high = Math.min(requested, value.length - start);
      const page = (length: number): { [key: string]: JsonValue } => ({
        ...base, value: value.slice(start, start + length),
        coverage: { ...this.coverage(pointer, withheld, start === 0 && length === value.length), unit: "utf16_code_units", startChar: start, endChar: start + length, totalCharacters: value.length, ...(start + length < value.length ? { nextChar: start + length } : {}) },
      });
      while (low < high) { const middle = Math.ceil((low + high) / 2); if (byteSize(page(middle)) <= this.outputBudget) low = middle; else high = middle - 1; }
      if (byteSize(page(low)) > this.outputBudget) return error("view_too_large", "Range metadata cannot fit the output budget; select a shorter pointer.");
      // Avoid splitting a surrogate pair at the outgoing boundary.
      if (low > 0 && start + low < value.length && /[\uD800-\uDBFF]/u.test(value[start + low - 1]!)) low--;
      if (low === 0 && start < value.length) return error("invalid_range", "No complete character fits this range; increase charCount to at least 2 or shorten the pointer.");
      return page(low);
    }
    const lines = value.split("\n");
    const start = integer(args.startLine, 1, 1, lines.length);
    const requested = integer(args.lineCount, 100, 1, 1000);
    if (start === undefined || requested === undefined) return error("invalid_range", "Line range is outside this string or invalid.");
    let accepted = 0;
    const page = (length: number): { [key: string]: JsonValue } => ({
      ...base, value: lines.slice(start - 1, start - 1 + length).join("\n"),
      coverage: { ...this.coverage(pointer, withheld, start === 1 && length === lines.length), unit: "lines", startLine: start, endLine: start + length - 1, totalLines: lines.length, linesComplete: true, ...(start - 1 + length < lines.length ? { nextLine: start + length } : {}) },
    });
    while (accepted < requested && start - 1 + accepted < lines.length && byteSize(page(accepted + 1)) <= this.outputBudget) accepted++;
    if (!accepted) return error("line_too_large", "A complete line cannot fit the output budget. Use startChar and charCount to read explicit character ranges instead.");
    return page(accepted);
  }

  private validPointer(pointer: string): boolean { return typeof pointer === "string" && byteSize(pointer) <= this.outputBudget / 4 && (pointer === "" || (pointer.startsWith("/") && !/~(?:[^01]|$)/u.test(pointer))); }
  private evictExpired(): void { for (const [handle, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(handle); }
  private remove(handle: string): void { const entry = this.entries.get(handle); if (entry) this.bytes -= entry.bytes; this.entries.delete(handle); }
}

interface Loaded { value: JsonValue; withheld: Withheld; }
