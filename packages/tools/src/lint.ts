/**
 * Schema linter.
 *
 * On most models a loose tool schema costs nothing but a few wasted tokens. On
 * Motif it costs correctness: the repair ladder's last resort is a search over
 * ambiguous readings of a malformed block, and the only thing that stops it
 * accepting a confidently wrong reading is the schema oracle — "is this tool
 * registered, and are its argument keys a subset of the declared properties?"
 *
 * A schema with `additionalProperties` unset accepts anything, so the oracle
 * degenerates to "does it parse". Nested objects give the search more places to
 * go wrong. Tool names that are substrings of each other make partial matches
 * ambiguous. Hence a lint that fails the build rather than a style guide nobody
 * reads.
 */

import { unwrapTool, type JsonSchema, type Tool } from "@motifcode/protocol";

export interface Finding {
  tool: string;
  rule: string;
  message: string;
}

export const LIMITS = {
  /**
   * Nine, raised from eight to admit `write`.
   *
   * The limit exists because the repair search has to disambiguate a malformed
   * block against the registered names, so each extra tool is another wrong
   * reading it could accept. That cost is not uniform, though: it comes from
   * names that partially match each other and from wide parameter lists, both
   * of which are checked separately below. `write` is two parameters and shares
   * no substring with any other name, so it adds a candidate the oracle can
   * always tell apart.
   *
   * Against that, the campaign it was added for: with only `apply_patch` and
   * `bash` available, 85% of the model's edits went through shell heredocs, one
   * file was rewritten ten times in a single task, and about a third of every
   * token generated was a file already written once. The oracle was never the
   * thing costing the score.
   *
   * Raising this again should need the same kind of evidence.
   */
  maxTools: 9,
  maxParams: 3,
} as const;

const NAME_RE = /^[a-z][a-z0-9_]*$/;

function paramFindings(name: string, params: JsonSchema | undefined): Finding[] {
  const out: Finding[] = [];
  if (!params) {
    out.push({ tool: name, rule: "parameters", message: "no parameters block" });
    return out;
  }
  if (params.additionalProperties !== false) {
    out.push({
      tool: name,
      rule: "closed-schema",
      message: "additionalProperties must be false, or the repair oracle accepts invented keys",
    });
  }
  const props = params.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) {
    out.push({
      tool: name,
      rule: "empty-params",
      message:
        "a tool with no parameters renders as `\"arguments\": ,` — invalid JSON in the prompt. Give it at least one property",
    });
  }
  if (keys.length > LIMITS.maxParams) {
    out.push({
      tool: name,
      rule: "param-count",
      message: `${keys.length} parameters, limit is ${LIMITS.maxParams}`,
    });
  }
  for (const [k, schema] of Object.entries(props)) {
    if (!schema?.type) {
      out.push({ tool: name, rule: "param-type", message: `parameter "${k}" has no type` });
      continue;
    }
    // MCP alone carries a remote schema's arguments. The host validates those
    // against the original JSON Schema before dispatch. Motif-3 trials found
    // extra escaping failures when this object was wrapped in a JSON string.
    const mcpArguments = name === "mcp" && k === "args"
      && keys.length === 3 && keys.includes("server") && keys.includes("method")
      && props.server?.type === "string" && props.method?.type === "string";
    if (schema.type === "object" && !mcpArguments) {
      out.push({
        tool: name,
        rule: "no-nested-objects",
        message: `parameter "${k}" is an object; flatten it or pass it as a JSON string`,
      });
    }
    if (schema.type === "array" && schema.items?.type === "object") {
      out.push({
        tool: name,
        rule: "no-object-arrays",
        message: `parameter "${k}" is an array of objects; too many places for a repair to go wrong`,
      });
    }
    if (!schema.description) {
      out.push({ tool: name, rule: "param-description", message: `parameter "${k}" has no description` });
    }
    if (/^\d+$/.test(k)) {
      out.push({
        tool: name,
        rule: "integer-like-key",
        message: `parameter "${k}" is integer-like; JavaScript reorders such keys and the rendered prompt stops matching the server's`,
      });
    }
  }
  return out;
}

export function lintTools(tools: readonly Tool[]): Finding[] {
  const out: Finding[] = [];
  const fns = tools.map(unwrapTool);

  if (fns.length > LIMITS.maxTools) {
    out.push({
      tool: "*",
      rule: "tool-count",
      message: `${fns.length} tools, limit is ${LIMITS.maxTools}`,
    });
  }

  const names = fns.map((f) => f.name);
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) out.push({ tool: n, rule: "duplicate-name", message: "duplicate tool name" });
    seen.add(n);
    if (!NAME_RE.test(n)) {
      out.push({ tool: n, rule: "name-format", message: "name must be lower_snake_case" });
    }
  }
  for (const a of names) {
    for (const b of names) {
      if (a !== b && b.includes(a)) {
        out.push({
          tool: a,
          rule: "substring-name",
          message: `"${a}" is a substring of "${b}"; keep names mutually distinct`,
        });
      }
    }
  }

  for (const fn of fns) {
    if (!fn.description) {
      out.push({ tool: fn.name, rule: "description", message: "tool has no description" });
    }
    out.push(...paramFindings(fn.name, fn.parameters));
  }
  return out;
}

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return "tool schemas: clean";
  const lines = findings.map((f) => `  ${f.tool}  [${f.rule}]  ${f.message}`);
  return `tool schemas: ${findings.length} problem(s)\n${lines.join("\n")}`;
}
