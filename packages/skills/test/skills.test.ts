import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, SkillRegistry, parseSkill } from "../src/index.js";

describe("skill parsing", () => {
  it("reads the standard name/description frontmatter", () => {
    const s = parseSkill("---\nname: demo\ndescription: does a thing\n---\nbody here\n");
    expect(s.name).toBe("demo");
    expect(s.description).toBe("does a thing");
    expect(s.body.trim()).toBe("body here");
  });

  it("refuses a skill that tries to declare tools", () => {
    // The whole point of the design: skills inject instructions, never
    // capability. A skill that changed the tool list would invalidate the
    // prompt prefix every time it loaded.
    expect(() =>
      parseSkill("---\nname: bad\ndescription: d\nallowed-tools: bash\n---\nbody"),
    ).toThrow(/never capability/);
  });

  it("requires frontmatter, a name and a description", () => {
    expect(() => parseSkill("no frontmatter")).toThrow(/frontmatter/);
    expect(() => parseSkill("---\ndescription: d\n---\nx")).toThrow(/name/);
    expect(() => parseSkill("---\nname: n\n---\nx")).toThrow(/description/);
  });
});

describe("built-in skills", () => {
  const reg = new SkillRegistry();
  reg.registerAll(BUILTIN_SKILLS);

  it("ships the set a coding harness actually needs", () => {
    const names = reg.list().map((s) => s.name);
    for (const expected of ["explore", "code-review", "test-fix", "debug", "commit", "pr-body", "skill-creator"]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("ships the two that only make sense for this model", () => {
    const names = reg.list().map((s) => s.name);
    // The endpoint is the most common cause of bad output here, and Korean is
    // a first-class output language for this model.
    expect(names).toContain("motif-endpoint");
    expect(names).toContain("korean");
  });

  it("keeps the index one line per skill", () => {
    // The index is paid for on every request as part of the cached prefix.
    const body = reg.index();
    for (const s of reg.list()) {
      const line = body.split("\n").find((l) => l.trim().startsWith(s.name));
      expect(line, s.name).toBeDefined();
      expect(line!.length).toBeLessThan(140);
    }
  });

  it("stays inside its declared budget", () => {
    for (const s of reg.list()) {
      if (!s.budget) continue;
      // ~3.6 characters per token is the harness's working estimate.
      const tokens = Math.round(s.body.length / 3.6);
      expect(tokens, `${s.name}: ${tokens} tokens vs budget ${s.budget}`).toBeLessThanOrEqual(s.budget);
    }
  });

  it("renders a skill wrapped so it reads as instructions", () => {
    const out = reg.render("commit");
    expect(out.startsWith('<skill name="commit">')).toBe(true);
    expect(out.trimEnd().endsWith("</skill>")).toBe(true);
  });

  it("answers usefully for an unknown skill", () => {
    const out = reg.render("nope");
    expect(out).toContain('No skill named "nope"');
    expect(out).toContain("commit");
  });

  it("lets a project skill shadow a built-in", () => {
    const r = new SkillRegistry();
    r.registerAll(BUILTIN_SKILLS);
    r.register(parseSkill("---\nname: commit\ndescription: ours\n---\nlocal rules"));
    expect(r.get("commit")!.body).toContain("local rules");
    expect(r.get("commit")!.source).toBe("project");
  });
});
