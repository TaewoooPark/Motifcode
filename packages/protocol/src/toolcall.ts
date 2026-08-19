/**
 * Lenient parsing and repair for Motif-3 tool calls.
 *
 * Motif emits Hermes-style `<tool_call>{json}</tool_call>` blocks and,
 * per its own vendor's parser, "frequently produces malformed JSON inside the
 * tags". The stock Hermes parser drops the entire turn when a block fails,
 * which surfaces as an HTTP 200 with `tool_calls: []` and the raw text leaked
 * into `content` — indistinguishable, to a naive harness, from a final answer.
 * The agent loop then stops, silently, mid-task.
 *
 * The vLLM fork ships a repair ladder server-side. This module is the client's
 * second line of defence: the same ladder, plus detection of the leak case so
 * the loop re-prompts instead of terminating.
 *
 * Ported from `vllm/tool_parsers/motif_tool_parser.py`. The rung names (R-quote,
 * R-backtrack, R-array, R-bracket) are kept so the two stay comparable.
 */

import type { Tool } from "./types.js";
import { unwrapTool } from "./types.js";

export const TOOL_CALL_BLOCK_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** True when the block needed repair to parse. */
  repaired: boolean;
}

export interface ParseResult {
  /** Text with all `<tool_call>` blocks removed. */
  content: string;
  calls: ParsedToolCall[];
  /** Blocks that could not be recovered by any rung. */
  unrecoverable: string[];
  /**
   * A `<tool_call>` opener with no closer. On the streaming path this is
   * usually a length-capped response; the caller should retry rather than
   * treat the turn as final.
   */
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* rungs                                                               */
/* ------------------------------------------------------------------ */

const ESCAPE_OR_LONE_BACKSLASH = /(\\["\\/bfnrtu])|\\/g;

/**
 * Drop backslashes that do not form a valid JSON escape.
 *
 * This is the rung that matters most for a coding agent. The invalid escapes
 * Motif produces are shell (`\$`, `\&`) and regex (`\s`, `\[`) — exactly the
 * characters this workload types all day. The alternation consumes escapes left
 * to right so the trailing backslash of a valid `\\` pair is never re-read as
 * the start of the next escape.
 */
export function normalizeInvalidEscapes(text: string): string {
  return text.replace(ESCAPE_OR_LONE_BACKSLASH, (_m, valid?: string) => valid ?? "");
}

const STRUCTURAL = new Set([",", "]", "}", ":"]);

/**
 * R-quote: escape unescaped quotes inside string values.
 *
 * A `"` inside a string closes it only when the next non-whitespace character
 * is JSON-structural or end of input; otherwise it is content.
 */
export function escapeQuotesInStrings(block: string): string {
  let out = "";
  let inStr = false;
  let i = 0;
  const n = block.length;
  while (i < n) {
    const ch = block[i]!;
    if (!inStr) {
      out += ch;
      if (ch === '"') inStr = true;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      out += ch + block[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && /\s/.test(block[j]!)) j++;
      const closes = j >= n || STRUCTURAL.has(block[j]!);
      if (closes) {
        out += '"';
        inStr = false;
      } else {
        out += '\\"';
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * R-array: `"key": "a", "b"` -> `"key": ["a", "b"`.
 *
 * Scoped to keys the registered schemas declare as arrays of strings. The vLLM
 * port hardcodes `queries|urls`; deriving the set from our own tools is
 * strictly better, and blindly wrapping any string value would let the bracket
 * balancer "fix" unrelated breakage into confidently wrong JSON.
 */
export function openStringArray(block: string, arrayKeys: ReadonlySet<string>): string {
  if (arrayKeys.size === 0) return block;
  const alt = [...arrayKeys].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`"(${alt})"(\\s*:\\s*)"`, "g");
  return block.replace(re, (_m, key: string, sep: string) => `"${key}"${sep}["`);
}

/**
 * R-bracket: repair bracket structure with a stack.
 *
 * Counting openers and closers and appending the difference at the end is not
 * enough. The common Motif failure is an inner bracket that never closes while
 * the outer ones do — `{"queries": ["a", "b"}}` — and appending `]` after the
 * final `}` produces `["a","b"}}]`, which is still broken. Closing the inner
 * bracket *at the point the mismatch is discovered* is what actually recovers
 * these, and it drops stray extra closers at the same time.
 */
export function balanceBrackets(block: string): string {
  const CLOSER: Record<string, string> = { "{": "}", "[": "]" };
  const stack: string[] = [];
  let out = "";
  let inStr = false;

  for (let i = 0; i < block.length; i++) {
    const ch = block[i]!;
    if (inStr) {
      out += ch;
      if (ch === "\\" && i + 1 < block.length) {
        out += block[i + 1];
        i++;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      // Close any inner brackets the model forgot, then match — or drop the
      // closer entirely if nothing is open for it.
      let matched = false;
      while (stack.length > 0) {
        const open = stack[stack.length - 1]!;
        if (CLOSER[open] === ch) {
          stack.pop();
          out += ch;
          matched = true;
          break;
        }
        stack.pop();
        out += CLOSER[open];
      }
      if (!matched) {
        // Unbalanced extra closer: drop it.
      }
      continue;
    }
    out += ch;
  }
  if (inStr) out += '"';
  while (stack.length > 0) out += CLOSER[stack.pop()!];
  return out;
}

const CONTROL_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

/**
 * R-control: escape raw control characters that appear inside string values.
 *
 * A literal newline inside a JSON string is invalid, and Motif emits them when
 * a tool argument carries a heredoc or a multi-line patch.
 */
export function escapeControlChars(block: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]!;
    if (inStr) {
      if (ch === "\\" && i + 1 < block.length) {
        out += ch + block[i + 1];
        i++;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        out += ch;
        continue;
      }
      const esc = CONTROL_ESCAPES[ch];
      if (esc !== undefined) out += esc;
      else if (ch < " ") out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
      else out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** Wrap flat calls: `{"name": .., "x": ..}` -> `{"name", "arguments"}`. */
export function coerceArgumentsWrapper(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj && typeof obj === "object" && "name" in obj && !("arguments" in obj)) {
    const { name, ...rest } = obj;
    return { name, arguments: rest };
  }
  return obj;
}

/**
 * Strict parse — no repairs at all.
 *
 * This is what decides whether a block counts as "repaired" in the breakage
 * budget. Folding idiom fixes into the first attempt would make every rung look
 * like a clean parse and quietly zero out the very metric the channel
 * downgrade depends on.
 */
function strictLoad(block: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(block) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* not valid JSON */
  }
  return null;
}

function tryLoad(block: string): Record<string, unknown> | null {
  const attempts = [block, normalizeInvalidEscapes(block), block.replace(/\}\s*$/, "")];
  for (const a of attempts) {
    const v = strictLoad(a);
    if (v !== null) return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* schema oracle + backtracking                                        */
/* ------------------------------------------------------------------ */

interface ToolSpec {
  props: Set<string> | null; // null = open schema
}

export function buildToolSpecs(tools: Tool[] | undefined): Map<string, ToolSpec> {
  const specs = new Map<string, ToolSpec>();
  for (const t of tools ?? []) {
    const fn = unwrapTool(t);
    const params = fn.parameters;
    const closed = params?.additionalProperties === false;
    specs.set(fn.name, {
      props: closed && params?.properties ? new Set(Object.keys(params.properties)) : null,
    });
  }
  return specs;
}

export function arrayKeysFrom(tools: Tool[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const t of tools ?? []) {
    const props = unwrapTool(t).parameters?.properties ?? {};
    for (const [k, schema] of Object.entries(props)) {
      if (schema?.type === "array" && schema.items?.type === "string") keys.add(k);
    }
  }
  return keys;
}

/**
 * Acceptance predicate for repaired candidates.
 *
 * A candidate is trusted only when its tool name is registered and, for closed
 * schemas, its argument keys are a subset of the declared properties. A wrong
 * close-quote interpretation that happens to parse tends to invent keys out of
 * string content, and no registered schema declares those.
 *
 * This is why the schema linter matters: the tighter the schemas, the stronger
 * this oracle, and the more malformed output survives as a correct call.
 */
function makeOracle(specs: Map<string, ToolSpec>): (obj: Record<string, unknown>) => boolean {
  if (specs.size === 0) return () => true;
  return (obj) => {
    const name = obj["name"];
    if (typeof name !== "string") return false;
    const spec = specs.get(name);
    if (!spec) return false;
    if (spec.props === null) return true;
    const args = obj["arguments"];
    if (args === null || args === undefined) return true;
    if (typeof args !== "object" || Array.isArray(args)) return false;
    return Object.keys(args as Record<string, unknown>).every((k) => spec.props!.has(k));
  };
}

/**
 * R-backtrack: enumerate close-vs-content readings of ambiguous quotes.
 *
 * `escapeQuotesInStrings` decides locally, and that rule is fooled by string
 * content that looks like JSON — a `cmd` containing `{"@type":"x"}` has a
 * mid-content quote followed by `:`. Treat each such quote as a choice point
 * and search, exploring the "close" reading first so the first candidate equals
 * the plain rung's output. The budget bounds the 2^choices worst case.
 */
function* quoteRepairCandidates(block: string, budget = 64): Generator<string> {
  interface Frame {
    i: number;
    inStr: boolean;
    out: string;
  }
  const stack: Frame[] = [{ i: 0, inStr: false, out: "" }];
  let yielded = 0;
  while (stack.length > 0 && yielded < budget) {
    const { i, inStr, out } = stack.pop()!;
    let idx = i;
    let str = inStr;
    let acc = out;
    let branched = false;
    while (idx < block.length) {
      const ch = block[idx]!;
      if (!str) {
        acc += ch;
        if (ch === '"') str = true;
        idx++;
        continue;
      }
      if (ch === "\\" && idx + 1 < block.length) {
        acc += ch + block[idx + 1];
        idx += 2;
        continue;
      }
      if (ch === '"') {
        let j = idx + 1;
        while (j < block.length && /\s/.test(block[j]!)) j++;
        const structural = j >= block.length || STRUCTURAL.has(block[j]!);
        if (structural) {
          // Ambiguous: could close the string, or be content that happens to be
          // followed by a structural character. Push the "content" reading for
          // later and continue with "close" now.
          stack.push({ i: idx + 1, inStr: true, out: acc + '\\"' });
          acc += '"';
          str = false;
          idx++;
          branched = true;
          continue;
        }
        acc += '\\"';
        idx++;
        continue;
      }
      acc += ch;
      idx++;
    }
    void branched;
    yielded++;
    yield acc;
  }
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

export interface RepairContext {
  specs: Map<string, ToolSpec>;
  arrayKeys: Set<string>;
}

export function repairContext(tools: Tool[] | undefined): RepairContext {
  return { specs: buildToolSpecs(tools), arrayKeys: arrayKeysFrom(tools) };
}

/** Return the block as a parsed object, or null if no rung recovers it. */
export function repairBlock(block: string, ctx: RepairContext): Record<string, unknown> | null {
  const esc = normalizeInvalidEscapes;
  const ctl = escapeControlChars;
  const arr = (b: string) => openStringArray(b, ctx.arrayKeys);
  const q = escapeQuotesInStrings;
  const bal = balanceBrackets;

  // Cheapest and least destructive first. Each rung is a superset of the
  // repairs of the ones before it, so the first success is also the most
  // conservative reading available.
  const ladder: ((b: string) => string)[] = [
    (b) => b,
    ctl,
    esc,
    (b) => ctl(esc(b)),
    (b) => bal(ctl(esc(b))),
    (b) => arr(ctl(esc(b))),
    (b) => bal(arr(ctl(esc(b)))),
    (b) => q(ctl(esc(b))),
    (b) => bal(q(ctl(esc(b)))),
    (b) => bal(arr(q(ctl(esc(b))))),
    bal,
  ];
  for (const rung of ladder) {
    const obj = tryLoad(rung(block));
    if (obj !== null) return coerceArgumentsWrapper(obj);
  }

  const accept = makeOracle(ctx.specs);
  const seen = new Set<string>();
  for (const cand of quoteRepairCandidates(normalizeInvalidEscapes(block))) {
    for (const variant of [cand, balanceBrackets(cand)]) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      const obj = tryLoad(variant);
      if (obj === null) continue;
      const coerced = coerceArgumentsWrapper(obj);
      if (accept(coerced)) return coerced;
    }
  }
  return null;
}

function asArguments(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

/**
 * Parse a complete (non-streaming) model response.
 *
 * Everything outside `<tool_call>` blocks is returned as content. Unrecoverable
 * blocks are reported rather than silently swallowed — that report is what
 * drives the breakage budget and the channel downgrade.
 */
export function parseToolCalls(text: string, ctx: RepairContext): ParseResult {
  const calls: ParsedToolCall[] = [];
  const unrecoverable: string[] = [];
  let content = "";
  let cursor = 0;

  TOOL_CALL_BLOCK_RE.lastIndex = 0;
  for (let m = TOOL_CALL_BLOCK_RE.exec(text); m !== null; m = TOOL_CALL_BLOCK_RE.exec(text)) {
    content += text.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const raw = (m[1] ?? "").trim();
    const strict = strictLoad(raw);
    const obj = strict !== null ? coerceArgumentsWrapper(strict) : repairBlock(raw, ctx);
    if (obj === null) {
      unrecoverable.push(raw);
      continue;
    }
    const name = typeof obj["name"] === "string" ? (obj["name"] as string) : "";
    if (name === "") {
      unrecoverable.push(raw);
      continue;
    }
    calls.push({ name, arguments: asArguments(obj["arguments"]), repaired: strict === null });
  }
  content += text.slice(cursor);

  // A trailing opener with no closer: recoverable here, but not on the
  // streaming path, which is one reason the tool path runs non-streaming.
  let truncated = false;
  const lastOpen = content.lastIndexOf("<tool_call>");
  if (lastOpen !== -1) {
    truncated = true;
    const raw = content.slice(lastOpen + "<tool_call>".length).trim();
    const obj = repairBlock(raw, ctx);
    content = content.slice(0, lastOpen);
    if (obj !== null && typeof obj["name"] === "string") {
      calls.push({
        name: obj["name"] as string,
        arguments: asArguments(obj["arguments"]),
        repaired: true,
      });
      truncated = false;
    } else {
      unrecoverable.push(raw);
    }
  }

  return { content, calls, unrecoverable, truncated };
}

/**
 * Did this turn leak tool-call syntax into what looks like a final answer?
 *
 * This is the failure the vendor's own parser comments describe, and the reason
 * `done` is a tool rather than a bare text reply: if a turn produced no calls
 * but its text still smells of tool syntax, it is not an answer. Re-prompt.
 */
export function looksLikeLeakedToolCall(result: ParseResult): boolean {
  if (result.calls.length > 0) return false;
  if (result.unrecoverable.length > 0) return true;
  return /<tool_call>|<\/tool_call>/.test(result.content);
}
