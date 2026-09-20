/**
 * Agent definitions from Markdown.
 *
 * The same shape Claude Code reads from `.claude/agents/*.md`: a frontmatter
 * block naming the agent, and a body that becomes its instructions. Two keys
 * are this harness's own. `tools` is a count, or the names of a prefix of the
 * canonical list — never an arbitrary set, because the tool list is a prefix
 * or the prompt cache is gone. `readOnly` is enforced by the executor's
 * policy, not by the instructions; see `policy.ts` in the CLI.
 */

import type { AgentDef } from "./index.js";

/** The canonical order, repeated here so this package needs nothing from `tools`. */
const CANONICAL = ["done", "bash", "read", "write", "apply_patch", "term", "skill", "task", "mcp"];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function readMeta(block: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value.replace(/^["']|["']$/g, "");
  }
  return meta;
}

/**
 * `tools: 3`, or `tools: done bash read` — a prefix, in either spelling.
 *
 * Names are accepted only when they are a prefix of the canonical order. A
 * definition asking for `bash` and `task` without `read` is asking for a set,
 * and a set is what the prompt cache cannot have.
 */
export function parseToolCount(value: string, name: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n < 1 || n > CANONICAL.length) throw new Error(`agent "${name}": tools must be between 1 and ${CANONICAL.length}`);
    return n;
  }
  const names = trimmed.split(/[,\s]+/).filter(Boolean);
  if (names.length === 0) throw new Error(`agent "${name}": tools is empty`);
  for (let i = 0; i < names.length; i++) {
    if (names[i] !== CANONICAL[i]) {
      throw new Error(
        `agent "${name}": tools must be a prefix of ${CANONICAL.join(" ")} — got ${names.join(" ")}. ` +
          "The list is a prefix so the prompt prefix stays shared with the parent session.",
      );
    }
  }
  return names.length;
}

export function parseAgent(text: string, source: AgentDef["source"] = "project"): AgentDef {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("agent is missing its --- frontmatter --- block");
  const meta = readMeta(m[1] ?? "");
  const name = meta["name"];
  if (!name) throw new Error("agent frontmatter needs a name");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`agent "${name}": names are lower-case letters, digits and dashes`);
  if (!meta["description"]) throw new Error(`agent "${name}" needs a description`);
  const instructions = text.slice(m[0].length).trim();
  if (instructions === "") throw new Error(`agent "${name}" has no instructions after the frontmatter`);

  const toolCount = meta["tools"] !== undefined ? parseToolCount(meta["tools"], name) : 3;
  const readOnlyRaw = meta["readOnly"] ?? meta["read-only"] ?? meta["readonly"];
  const readOnly = readOnlyRaw !== undefined ? /^(true|yes|1)$/i.test(readOnlyRaw) : false;
  const maxTurnsRaw = meta["maxTurns"] ?? meta["max-turns"];
  const maxTurns = maxTurnsRaw !== undefined ? Number(maxTurnsRaw) : undefined;
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) {
    throw new Error(`agent "${name}": maxTurns must be a positive integer`);
  }
  return {
    name,
    description: meta["description"],
    toolCount,
    ...(readOnly ? { readOnly: true } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    instructions,
    source,
  };
}
