/**
 * The skill registry.
 */

import type { Skill } from "./parse.js";

/**
 * Characters over a fixed ratio.
 *
 * An estimate, labelled as one everywhere it surfaces. 3.6 is the ratio the
 * context ledger uses, so the two at least agree with each other.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): void {
    // Later registrations win, so a project skill can shadow a built-in of the
    // same name — the same precedence users expect from every other harness.
    this.skills.set(skill.name, skill);
  }

  registerAll(skills: readonly Skill[]): void {
    for (const s of skills) this.register(s);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The line that lives in the system prompt.
   *
   * Deliberately terse: it is paid for on every single request, forever, as
   * part of the cached prefix.
   */
  index(): string {
    const rows = this.list().map((s) => `  ${s.name} — ${s.description}`);
    if (rows.length === 0) return "";
    return ["# Skills", "", "Load one with the `skill` tool when it applies:", ...rows].join("\n");
  }

  /**
   * The body, wrapped so the model can tell instructions from conversation.
   *
   * The declared budget is checked here rather than treated as documentation.
   * A skill that blows through it is refused with its actual size, not
   * silently truncated: a half-injected instruction sheet is worse than none,
   * because the model follows the half it can see and has no way to know the
   * rest was cut.
   *
   * The estimate is characters over a fixed ratio, and says so. Only the
   * tokenizer knows the real number, and calling an estimate a token count is
   * how a budget stops meaning anything.
   */
  render(name: string): string {
    const skill = this.get(name);
    if (!skill) {
      const known = this.list()
        .map((s) => s.name)
        .join(", ");
      return `No skill named "${name}". Available: ${known || "(none)"}.`;
    }
    const body = skill.body.trim();
    if (skill.budget !== undefined) {
      const estimated = estimateTokens(body);
      if (estimated > skill.budget) {
        return (
          `The "${skill.name}" skill is about ${estimated} tokens (estimated from ${body.length} ` +
          `characters), over its declared budget of ${skill.budget}. It was not injected. ` +
          `Either raise the budget in its frontmatter or split the skill.`
        );
      }
    }
    return [`<skill name="${skill.name}">`, body, "</skill>"].join("\n");
  }
}

