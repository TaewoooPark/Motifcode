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
  /** How it was recovered — see `RepairInfo`. Absent means it parsed as written. */
  repair?: RepairInfo;
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

/** One rewritten byte range, so a repair can be audited instead of trusted. */
export interface EscapeEdit {
  at: number;
  from: string;
  to: string;
}

export interface EscapeRepair {
  text: string;
  /**
   * A backslash whose intent could not be read off the text. Such a block is
   * never executed: guessing here changes what the command does.
   */
  ambiguous: boolean;
  edits: EscapeEdit[];
}

const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Make invalid JSON escapes parseable **without changing what they mean**.
 *
 * This is the rung that matters most for a coding agent, because the invalid
 * escapes Motif produces are shell (`\$`, `\&`) and regex (`\s`, `\[`) — the
 * characters this workload types all day.
 *
 * The obvious repair is to delete the offending backslash, and it is wrong. A
 * model that wrote `\$HOME` was suppressing shell expansion; delete the
 * backslash and the recovered command expands the variable instead. `\s+`
 * becomes `s+`, a different regex that still matches things. Parse success goes
 * up and the harness quietly runs a command nobody asked for.
 *
 * So an invalid escape is doubled rather than dropped: `\$` becomes `\\$`,
 * which decodes to a literal backslash followed by `$` — exactly the bytes the
 * model emitted. Valid escapes are left alone, and a backslash whose reading is
 * genuinely undecidable (outside a string, or trailing with nothing after it)
 * marks the block ambiguous instead of being repaired into something plausible.
 */
export function repairInvalidEscapes(block: string): EscapeRepair {
  let out = "";
  let inStr = false;
  let ambiguous = false;
  const edits: EscapeEdit[] = [];

  for (let i = 0; i < block.length; i++) {
    const ch = block[i]!;
    if (!inStr) {
      // JSON has no backslash outside a string. Something is wrong in a way
      // this rung cannot name, so do not pretend to fix it.
      if (ch === "\\") ambiguous = true;
      out += ch;
      if (ch === '"') inStr = true;
      continue;
    }
    if (ch !== "\\") {
      out += ch;
      if (ch === '"') inStr = false;
      continue;
    }
    const next = block[i + 1];
    if (next === undefined) {
      // A string that ends mid-escape. The next character was lost, so no
      // reading of it is better than another.
      ambiguous = true;
      out += ch;
      continue;
    }
    if (SIMPLE_ESCAPES.has(next)) {
      out += ch + next;
      i++;
      continue;
    }
    if (next === "u" && HEX4.test(block.slice(i + 2, i + 6))) {
      out += block.slice(i, i + 6);
      i += 5;
      continue;
    }
    // Invalid escape: keep the backslash as content.
    edits.push({ at: i, from: ch + next, to: "\\\\" + next });
    out += "\\\\" + next;
    i++;
  }
  return { text: out, ambiguous, edits };
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
export interface BracketRepair {
  text: string;
  /**
   * True when a closer was invented or a stray one dropped — the payload was
   * not structurally complete as written. Callers that execute the result need
   * this: a command string cut off mid-word balances just as cleanly as a whole
   * one, and the difference is the part of the command that is missing.
   */
  invented: boolean;
}

export function balanceBrackets(block: string): string {
  return balanceBracketsDetailed(block).text;
}

export function balanceBracketsDetailed(block: string): BracketRepair {
  const CLOSER: Record<string, string> = { "{": "}", "[": "]" };
  const stack: string[] = [];
  let out = "";
  let inStr = false;
  let invented = false;

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
        invented = true;
      }
      if (!matched) {
        // Unbalanced extra closer: drop it.
        invented = true;
      }
      continue;
    }
    out += ch;
  }
  if (inStr) {
    out += '"';
    invented = true;
  }
  while (stack.length > 0) {
    out += CLOSER[stack.pop()!];
    invented = true;
  }
  return { text: out, invented };
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
  return strictLoad(block);
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

/**
 * How a block was recovered, and therefore how far it can be trusted.
 *
 * Parse success and execution safety are different questions. A bracket
 * balancer will happily close a command string that was cut off mid-word, and
 * the result is valid JSON holding half a command. The loop needs to be able to
 * tell that apart from a block that parsed as written, so the provenance
 * travels with the value.
 */
export interface RepairInfo {
  kind: "none" | "envelope" | "escape" | "quote" | "bracket" | "truncation" | "detag";
  /** A reading was guessed where more than one was possible. */
  lossy: boolean;
  /** The payload was structurally whole; nothing was invented to close it. */
  complete: boolean;
}

export interface RepairOutcome {
  value: Record<string, unknown> | null;
  info: RepairInfo;
}

const CLEAN: RepairInfo = { kind: "none", lossy: false, complete: true };

interface Rung {
  kind: RepairInfo["kind"];
  lossy: boolean;
  apply: (b: string) => { text: string; complete: boolean };
}

/**
 * Recover a block, reporting what it took.
 *
 * Cheapest and least destructive first: each rung is a superset of the repairs
 * before it, so the first success is also the most conservative reading
 * available.
 */
export function repairBlockDetailed(block: string, ctx: RepairContext): RepairOutcome {
  const ctl = escapeControlChars;
  const arr = (b: string) => openStringArray(b, ctx.arrayKeys);
  const q = escapeQuotesInStrings;

  // Ambiguity is fatal at this rung rather than repaired: a backslash outside a
  // string, or one trailing at the end of the block, has no reading that is
  // better than another, and picking one silently changes the command.
  const esc = repairInvalidEscapes(block);
  const escaped = esc.text;

  const whole = (text: string) => ({ text, complete: true });
  const ladder: Rung[] = [
    { kind: "none", lossy: false, apply: whole },
    { kind: "escape", lossy: false, apply: (b) => whole(ctl(b)) },
    { kind: "escape", lossy: false, apply: () => whole(escaped) },
    { kind: "escape", lossy: false, apply: () => whole(ctl(escaped)) },
    {
      kind: "bracket",
      lossy: false,
      apply: () => {
        const r = balanceBracketsDetailed(ctl(escaped));
        return { text: r.text, complete: !r.invented };
      },
    },
    { kind: "bracket", lossy: true, apply: () => whole(arr(ctl(escaped))) },
    {
      kind: "bracket",
      lossy: true,
      apply: () => {
        const r = balanceBracketsDetailed(arr(ctl(escaped)));
        return { text: r.text, complete: !r.invented };
      },
    },
    { kind: "quote", lossy: true, apply: () => whole(q(ctl(escaped))) },
    {
      kind: "quote",
      lossy: true,
      apply: () => {
        const r = balanceBracketsDetailed(q(ctl(escaped)));
        return { text: r.text, complete: !r.invented };
      },
    },
    {
      kind: "quote",
      lossy: true,
      apply: () => {
        const r = balanceBracketsDetailed(arr(q(ctl(escaped))));
        return { text: r.text, complete: !r.invented };
      },
    },
  ];

  for (const rung of ladder) {
    if (esc.ambiguous && rung.kind !== "none") break;
    const { text, complete } = rung.apply(block);
    const obj = tryLoad(text);
    if (obj === null) continue;
    const coerced = coerceArgumentsWrapper(obj);
    const envelope = coerced !== obj;
    return {
      value: coerced,
      info: {
        kind: rung.kind === "none" && envelope ? "envelope" : rung.kind,
        lossy: rung.lossy,
        complete,
      },
    };
  }

  if (esc.ambiguous) {
    return { value: null, info: { kind: "escape", lossy: true, complete: false } };
  }

  const accept = makeOracle(ctx.specs);
  const seen = new Set<string>();
  for (const cand of quoteRepairCandidates(escaped)) {
    const balanced = balanceBracketsDetailed(cand);
    for (const variant of [
      { text: cand, complete: true },
      { text: balanced.text, complete: !balanced.invented },
    ]) {
      if (seen.has(variant.text)) continue;
      seen.add(variant.text);
      const obj = tryLoad(variant.text);
      if (obj === null) continue;
      const coerced = coerceArgumentsWrapper(obj);
      if (!accept(coerced)) continue;
      return {
        value: coerced,
        info: { kind: "quote", lossy: true, complete: variant.complete },
      };
    }
  }
  return { value: null, info: { kind: "none", lossy: false, complete: false } };
}

/** Return the block as a parsed object, or null if no rung recovers it. */
export function repairBlock(block: string, ctx: RepairContext): Record<string, unknown> | null {
  return repairBlockDetailed(block, ctx).value;
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
    const outcome: RepairOutcome =
      strict !== null
        ? { value: coerceArgumentsWrapper(strict), info: CLEAN }
        : repairBlockDetailed(raw, ctx);
    if (outcome.value === null) {
      unrecoverable.push(raw);
      continue;
    }
    const name = typeof outcome.value["name"] === "string" ? (outcome.value["name"] as string) : "";
    if (name === "") {
      unrecoverable.push(raw);
      continue;
    }
    calls.push({
      name,
      arguments: asArguments(outcome.value["arguments"]),
      repaired: strict === null,
      repair: outcome.info,
    });
  }
  content += text.slice(cursor);

  // A trailing opener with no closer. Usually a length cap, and the reason the
  // tool path runs non-streaming: with the whole body in hand we can ask
  // whether only the closing *tag* is missing, or whether the JSON itself was
  // cut off. The first is recoverable. The second is a partial command that a
  // bracket balancer will happily turn into a syntactically valid whole one,
  // and running it means running something the model never finished writing.
  let truncated = false;
  const lastOpen = content.lastIndexOf("<tool_call>");
  if (lastOpen !== -1) {
    truncated = true;
    const raw = content.slice(lastOpen + "<tool_call>".length).trim();
    content = content.slice(0, lastOpen);
    const strict = strictLoad(raw);
    if (strict !== null) {
      const obj = coerceArgumentsWrapper(strict);
      const name = typeof obj["name"] === "string" ? (obj["name"] as string) : "";
      if (name !== "") {
        calls.push({
          name,
          arguments: asArguments(obj["arguments"]),
          repaired: true,
          repair: { kind: "truncation", lossy: false, complete: true },
        });
        truncated = false;
      } else {
        unrecoverable.push(raw);
      }
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

/** Strip a single surrounding ```json … ``` (or bare ```) fence, if the whole string is one. */
function stripLoneFence(s: string): string {
  const m = /^```(?:json|tool_call)?\s*([\s\S]*?)\s*```$/.exec(s.trim());
  return m ? (m[1] ?? "").trim() : s.trim();
}

/**
 * Recover a tool call the model emitted as a bare object, with no `<tool_call>`
 * wrapper for the server's parser to find.
 *
 * MEASURED on the hosted endpoint, 2026-09-20: on a minority of turns Motif-3
 * writes the call straight into the body — `{"name": "bash", "arguments":
 * {…}}` — and the server, which lifts calls out of `<tool_call>` tags, leaves
 * it in `content` with `tool_calls` empty. To a stock harness that is an empty
 * turn and the action is lost, which on this model is indistinguishable from a
 * final answer. The payload is not malformed: it is the right call missing its
 * envelope, so recovering it is the same job the ladder does for malformed JSON
 * *inside* the tags — and it is done through the same ladder, so a bare call
 * that is *also* slightly malformed still recovers.
 *
 * Deliberately strict about scope: the whole trimmed body (optionally one code
 * fence) must BE the object, and its `name` must be a registered tool. A call
 * object quoted in the middle of an explanation is not this — that is
 * `contentLeaksToolCall`, which asks the loop to re-prompt rather than run
 * something the model was only describing.
 */
export function recoverBareToolCall(content: string, ctx: RepairContext): ParsedToolCall | null {
  const body = stripLoneFence(content);
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  const strict = strictLoad(body);
  const outcome: RepairOutcome =
    strict !== null ? { value: coerceArgumentsWrapper(strict), info: CLEAN } : repairBlockDetailed(body, ctx);
  if (outcome.value === null) return null;
  const name = typeof outcome.value["name"] === "string" ? (outcome.value["name"] as string) : "";
  // Only a registered name: a lone `{"name": "foo"}` where `foo` is not a tool
  // is likely prose that happens to be JSON, not a dropped call.
  if (name === "" || !ctx.specs.has(name)) return null;
  return {
    name,
    arguments: asArguments(outcome.value["arguments"]),
    repaired: true,
    repair: { kind: "detag", lossy: outcome.info.lossy, complete: outcome.info.complete },
  };
}

/**
 * Does this body carry a tool call the parser did not lift out?
 *
 * Two shapes: a literal `<tool_call>` fragment (the classic leak), or a bare
 * JSON object naming a registered tool sitting among otherwise-prose content —
 * the tagless leak. This is only a signal to *re-prompt*, never a licence to
 * execute: a call the model merely described in prose must not run. A whole-body
 * bare call is handled first, and executed, by `recoverBareToolCall`.
 */
export function contentLeaksToolCall(content: string, ctx: RepairContext): boolean {
  if (/<\/?tool_call>/.test(content)) return true;
  for (const m of content.matchAll(/\{[^{}]*"name"\s*:\s*"([a-z_]+)"[\s\S]*?\}/g)) {
    if (ctx.specs.has(m[1]!)) return true;
  }
  return false;
}
