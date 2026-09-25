import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, SkillRegistry, estimateTokens, parseSkill } from "../src/index.js";

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

  it("discovers MCP setup in one short bilingual line and loads its complete body on demand", () => {
    const skill = reg.get("mcp-setup")!;
    const index = reg.index();
    const row = index.split("\n").find(line => line.trim().startsWith("mcp-setup —"))!;
    expect(skill.source).toBe("builtin");
    expect(row.length).toBeLessThan(140);
    expect(row).toContain("GitHub URL");
    expect(row).toContain("연결/등록");
    expect(index).not.toContain("motif mcp doctor --connect");
    expect(estimateTokens(skill.body.trim())).toBeLessThanOrEqual(skill.budget!);
    expect(skill.budget).toBeLessThanOrEqual(900);
    expect(reg.render("mcp-setup")).toBe(`<skill name="mcp-setup">\n${skill.body.trim()}\n</skill>`);
  });

  it("lets user and project MCP setup instructions override the built-in without changing its source", () => {
    const r = new SkillRegistry(); r.registerAll(BUILTIN_SKILLS);
    const original = r.get("mcp-setup")!;
    const count = r.list().length;
    r.register(parseSkill("---\nname: mcp-setup\ndescription: user setup\n---\nuser installation policy", "user"));
    expect(r.get("mcp-setup")!.source).toBe("user");
    expect(r.render("mcp-setup")).toContain("user installation policy");
    r.register(parseSkill("---\nname: mcp-setup\ndescription: project setup\n---\nproject installation policy", "project"));
    expect(r.get("mcp-setup")!.source).toBe("project");
    expect(r.render("mcp-setup")).toContain("project installation policy");
    expect(r.list()).toHaveLength(count);
    expect(BUILTIN_SKILLS.find(skill => skill.name === "mcp-setup")).toBe(original);
    expect(original.source).toBe("builtin");
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
