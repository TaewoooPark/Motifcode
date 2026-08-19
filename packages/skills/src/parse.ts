/**
 * Skill metadata and the `SKILL.md` parser.
 *
 * Split out from the barrel on purpose. `builtin.ts` parses its skills at module
 * evaluation time, so if it imported the parser from `index.ts` — which
 * re-exports `builtin.ts` — the cycle would leave the parser's constants
 * uninitialised at exactly the moment they are needed. Unit tests did not catch
 * that; the first real CLI run did.
 */

export interface SkillMeta {
  name: string;
  description: string;
  /**
   * Rough token budget for the body. The loader refuses to inject a skill that
   * would blow a hole in the context it was called from.
   */
  budget?: number;
  /** Free-form tags used only for the index ordering. */
  tags?: string[];
}

export interface Skill extends SkillMeta {
  body: string;
  source: "builtin" | "project" | "user";
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parse a `SKILL.md`.
 *
 * The frontmatter follows the shape the ecosystem has converged on — `name` and
 * `description` — with one visible omission: there is no `allowed-tools` key.
 * Skills here cannot alter the tool list at all, so a field for it would be a
 * lie.
 */
export function parseSkill(text: string, source: Skill["source"] = "project"): Skill {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("skill is missing its --- frontmatter --- block");
  const body = text.slice(m[0].length);
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value.replace(/^["']|["']$/g, "");
  }
  if (!meta["name"]) throw new Error("skill frontmatter needs a name");
  if (!meta["description"]) throw new Error(`skill "${meta["name"]}" needs a description`);
  if (meta["allowed-tools"] || meta["tools"]) {
    throw new Error(
      `skill "${meta["name"]}" declares tools. Skills inject instructions, never capability: ` +
        `changing the tool list invalidates the prompt prefix. Use a subagent instead.`,
    );
  }
  const budget = meta["budget"] ? Number(meta["budget"]) : undefined;
  return {
    name: meta["name"],
    description: meta["description"],
    ...(budget !== undefined && Number.isFinite(budget) ? { budget } : {}),
    ...(meta["tags"] ? { tags: meta["tags"].split(/[,\s]+/).filter(Boolean) } : {}),
    body,
    source,
  };
}

