/**
 * The skill registry.
 */

import type { Skill } from "./parse.js";

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

  /** The body, wrapped so the model can tell instructions from conversation. */
  render(name: string): string {
    const skill = this.get(name);
    if (!skill) {
      const known = this.list()
        .map((s) => s.name)
        .join(", ");
      return `No skill named "${name}". Available: ${known || "(none)"}.`;
    }
    return [`<skill name="${skill.name}">`, skill.body.trim(), "</skill>"].join("\n");
  }
}

