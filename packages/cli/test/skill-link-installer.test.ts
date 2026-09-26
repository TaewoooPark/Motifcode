import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSkillSource, installSkillCandidates, loadInstalledSkills, updateInstalledSkill } from "../src/skill-installer.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const roots: string[] = [];
const remote = "https://github.com/example/skill-fixture.git";
function temp(): string { const root = mkdtempSync(join(tmpdir(), "motif-skill-link-test-")); roots.push(root); return root; }
function file(root: string, path: string, text: string): void { const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, text); }
function fixture(): { source: string; commit: string; git: (...args: string[]) => string } {
  const source = temp();
  file(source, "skills/demo/SKILL.md", "---\nname: linked\ndescription: Use the sibling references and scripts.\n---\nRead references/guide.md and run scripts/check.js.\n");
  file(source, "skills/demo/references/guide.md", "Complete reference");
  file(source, "skills/demo/scripts/check.js", "console.log('fixture');\n");
  file(source, "skills/demo/assets/template.csv", "a,b\n1,2\n");
  file(source, "skills/other/SKILL.md", "---\nname: other\ndescription: Separate skill.\n---\nOther instructions.\n");
  const git = (...args: string[]) => actual.execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet", "--initial-branch=main"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  // Use real Git discovery/fetch/checkout; replace only the test HTTPS transport with this local repository.
  vi.mocked(execFileSync).mockImplementation(((command: string, args: readonly string[], options: ExecFileSyncOptions) => {
    const mapped = [...args];
    if (mapped.includes(remote)) {
      mapped[mapped.indexOf(remote)] = source;
      const verb = mapped.findIndex(arg => arg === "fetch" || arg === "ls-remote");
      mapped.splice(verb, 0, "-c", "protocol.file.allow=always");
    } else if (mapped.some(arg => arg.startsWith("https://"))) throw new Error("Unexpected network source in fixture");
    return actual.execFileSync(command, mapped, options);
  }) as typeof execFileSync);
  return { source, commit, git };
}
function install(url: string, home: string, options = {}) {
  const inspection = inspectSkillSource(url, { home, ...options });
  try { return installSkillCandidates(inspection, { home, ...options }); } finally { inspection.cleanup(); }
}
afterEach(() => {
  vi.mocked(execFileSync).mockImplementation(actual.execFileSync); vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub skill links", () => {
  it.each([
    "https://github.com/example/skill-fixture/tree/main/skills/demo/",
    "https://github.com/example/skill-fixture/blob/main/skills/demo/SKILL.md?plain=1&utm_source=share#L1-L7",
    "https://raw.githubusercontent.com/example/skill-fixture/main/skills/demo/SKILL.md",
    "https://raw.githubusercontent.com/example/skill-fixture/refs/heads/main/skills/demo/SKILL.md?raw=true",
  ])("installs the entire containing folder from %s and records canonical provenance", url => {
    const { commit } = fixture(); const home = temp(); const [receipt] = install(url, home);
    expect(receipt!.origin).toMatchObject({ kind: "git", source: remote, ref: "refs/heads/main", commit, subpath: "skills/demo" });
    const loaded = loadInstalledSkills({ home, cwd: temp() }); expect(loaded.problems).toEqual([]); expect(loaded.skills.map(skill => skill.name)).toEqual(["linked"]);
    const root = loaded.skills[0]!.baseDir!;
    expect(readFileSync(join(root, "references/guide.md"), "utf8")).toBe("Complete reference");
    expect(readFileSync(join(root, "scripts/check.js"), "utf8")).toContain("fixture");
    expect(readFileSync(join(root, "assets/template.csv"), "utf8")).toBe("a,b\n1,2\n");
    expect(existsSync(join(root, "../other/SKILL.md"))).toBe(false);
  });
  it("resolves a branch containing slashes without treating part of its name as a folder", () => {
    const { git } = fixture(); git("branch", "feature/skill-links");
    const [receipt] = install("https://github.com/example/skill-fixture/blob/feature/skill-links/skills/demo/SKILL.md", temp());
    expect(receipt!.origin).toMatchObject({ ref: "refs/heads/feature/skill-links", subpath: "skills/demo" });
  });
  it("supports encoded slash refs, tags and full commit links", () => {
    const { git, commit } = fixture(); git("tag", "releases/v1");
    const [tag] = install("https://github.com/example/skill-fixture/tree/releases%2Fv1/skills/demo", temp());
    expect(tag!.origin.ref).toBe("refs/tags/releases/v1");
    vi.clearAllMocks(); const [pinned] = install(`https://github.com/example/skill-fixture/blob/${commit}/skills/demo/SKILL.md`, temp());
    expect(pinned!.origin.ref).toBe(commit); expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => Array.isArray(args) && args.includes("ls-remote"))).toBe(false);
  });
  it("requires explicit selection when a URL has several possible ref boundaries", () => {
    const { git } = fixture(); git("tag", "main/skills"); const url = "https://github.com/example/skill-fixture/tree/main/skills/demo";
    expect(() => inspectSkillSource(url)).toThrow(/multiple branch\/tag boundaries/);
    const [row] = install(url, temp(), { ref: "refs/heads/main", path: "./skills/demo/" }); expect(row!.origin.ref).toBe("refs/heads/main");
  });
  it("does not let an explicit short ref silently choose between a branch and tag", () => {
    const { git } = fixture(); git("tag", "main"); const url = "https://github.com/example/skill-fixture/tree/main/skills/demo";
    expect(() => inspectSkillSource(url)).toThrow(/multiple branch\/tag boundaries/);
    expect(() => inspectSkillSource(url, { ref: "main" })).toThrow(/both a branch and tag/);
    expect(install(url, temp(), { ref: "refs/heads/main" })[0]!.origin.ref).toBe("refs/heads/main");
    expect(install(url, temp(), { ref: "refs/tags/main" })[0]!.origin.ref).toBe("refs/tags/main");
  });
  it("rejects conflicting ref/path overrides instead of quietly installing a different skill", () => {
    fixture(); const url = "https://github.com/example/skill-fixture/blob/main/skills/demo/SKILL.md";
    expect(() => inspectSkillSource(url, { ref: "other" })).toThrow(/--ref conflicts/);
    expect(() => inspectSkillSource(url, { path: "skills/other" })).toThrow(/--path conflicts/);
    expect(() => inspectSkillSource(url, { path: "skills/demo/../other" })).toThrow(/inside the repository/);
    const [row] = install(url, temp(), { ref: "main", path: "skills/demo" }); expect(row!.origin).toMatchObject({ ref: "refs/heads/main", subpath: "skills/demo" });
    const [fullLink] = install("https://raw.githubusercontent.com/example/skill-fixture/refs/heads/main/skills/demo/SKILL.md", temp(), { ref: "main" }); expect(fullLink!.origin.ref).toBe("refs/heads/main");
  });
  it("handles a repository-root skill and a tracking-only repository URL", () => {
    const { source, git } = fixture();
    file(source, "SKILL.md", "---\nname: root-skill\ndescription: A repository root skill.\n---\nRead references/root.md.\n"); file(source, "references/root.md", "Root resource");
    git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "root skill");
    const home = temp(); const [root] = install("https://github.com/example/skill-fixture/blob/main/SKILL.md", home, { path: "." });
    expect(root!.origin.subpath).toBeUndefined(); expect(readFileSync(join(home, ".motif", root!.snapshot, "references/root.md"), "utf8")).toBe("Root resource");
    const [repository] = install("https://github.com/example/skill-fixture/?utm_medium=link#readme", temp()); expect(repository!.originalName).toBe("root-skill"); expect(repository!.origin.source).toBe(remote);
  });
  it("updates the normalized source without needing the original browser link", () => {
    const { source, git } = fixture(); const home = temp(); const [first] = install("https://raw.githubusercontent.com/example/skill-fixture/main/skills/demo/SKILL.md", home);
    file(source, "skills/demo/references/guide.md", "Updated reference"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "update");
    const [updated] = updateInstalledSkill(first!.id, { home }); expect(updated!.id).toBe(first!.id); expect(updated!.origin.commit).not.toBe(first!.origin.commit);
    expect(readFileSync(join(home, ".motif", updated!.snapshot, "references/guide.md"), "utf8")).toBe("Updated reference");
  });
  it.each(["portable", "claude", "codex"] as const)("retains an enclosing %s plugin's shared resources while registering only the linked skill", flavor => {
    const { source, git } = fixture(); const home = temp();
    const manifest = flavor === "portable" ? "plugin.json" : `.${flavor}-plugin/plugin.json`;
    file(source, `plugins/bundle/${manifest}`, JSON.stringify({ name: "bundle", ...(flavor === "portable" ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" } : {}) }));
    file(source, "plugins/bundle/skills/linked/SKILL.md", "---\nname: linked\ndescription: Read the shared package guide.\n---\nRead ${CLAUDE_PLUGIN_ROOT}/shared/guide.md.\n");
    file(source, "plugins/bundle/skills/sibling/SKILL.md", "---\nname: sibling\ndescription: Do not register this sibling.\n---\nOther instructions.\n");
    file(source, "plugins/bundle/shared/guide.md", "Shared package resource"); file(source, "plugins/bundle/hooks/hooks.json", '{"hooks":{}}');
    git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "plugin fixture");
    const url = "https://github.com/example/skill-fixture/blob/main/plugins/bundle/skills/linked/SKILL.md";
    const [receipt] = install(url, home); expect(receipt!.name).toBe("bundle:linked"); expect(receipt!.origin.subpath).toBe("plugins/bundle/skills/linked"); expect(receipt!.relativeFile).toBe("skills/linked/SKILL.md");
    const loaded = loadInstalledSkills({ home, cwd: temp() }); expect(loaded.skills.map(skill => skill.name)).toEqual(["bundle:linked"]);
    expect(readFileSync(join(loaded.skills[0]!.packageRoot!, "shared/guide.md"), "utf8")).toBe("Shared package resource");
    expect(receipt!.diagnostics.some(diagnostic => diagnostic.code === "package_dependencies")).toBe(true);
    expect(existsSync(join(loaded.skills[0]!.packageRoot!, "plugins"))).toBe(false);
    const [updated] = updateInstalledSkill(receipt!.id, { home }); expect(updated!.id).toBe(receipt!.id); expect(updated!.name).toBe("bundle:linked"); expect(updated!.relativeFile).toBe("skills/linked/SKILL.md");
    expect(loadInstalledSkills({ home, cwd: temp() }).skills.map(skill => skill.name)).toEqual(["bundle:linked"]);
  });
  it("uses the nearest package boundary and keeps directly selected local folders unchanged", () => {
    const { source, git } = fixture(); file(source, "plugin.json", '{"name":"outer"}');
    file(source, "plugins/inner/plugin.json", '{"name":"inner"}');
    file(source, "plugins/inner/skills/demo/SKILL.md", "---\nname: inner-skill\ndescription: Nested package.\n---\nDo the task.\n");
    git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "nested plugin fixture");
    const home = temp(); const [nested] = install("https://github.com/example/skill-fixture/tree/main/plugins/inner", home);
    expect(nested!.name).toBe("inner:inner-skill"); expect(readFileSync(join(home, ".motif", nested!.snapshot, "plugin.json"), "utf8")).toContain('"inner"');
    const [skillLink] = install("https://github.com/example/skill-fixture/tree/main/plugins/inner/skills/demo", temp()); expect(skillLink!.name).toBe("inner:inner-skill");
    const [local] = install(join(source, "plugins/inner/skills/demo"), temp()); expect(local!.name).toBe("inner-skill"); expect(local!.relativeFile).toBe("SKILL.md");
  });
  it("provides actionable guidance for unresolved and abbreviated commit refs", () => {
    const { commit } = fixture();
    expect(() => inspectSkillSource("https://github.com/example/skill-fixture/tree/missing/skills/demo")).toThrow(/matching --ref/);
    expect(() => inspectSkillSource(`https://github.com/example/skill-fixture/tree/${commit.slice(0, 8)}/skills/demo`)).toThrow(/full 40-character SHA/);
  });
  it.each([
    "https://github.com/example/skill-fixture/blob/main/README.md",
    "https://raw.githubusercontent.com/example/skill-fixture/main/README.md",
    "https://github.com/example/skill-fixture/issues/1",
    "https://github.com/example/skill-fixture/tree/main/skills/demo?ref=other",
    "https://github.com/example/skill-fixture/tree/main/skills/%2e%2e/demo",
    "https://github.com/example/skill-fixture/tree/main/skills/%00demo",
    "https://github.com/example%2Fskill-fixture/tree/main/skills/demo",
    "https://github.com?utm_source=/example/skill-fixture/tree/main/skills/demo",
    "https://github.com#readme/example/skill-fixture/tree/main/skills/demo",
    "https://github.com:8443/example/skill-fixture/tree/main/skills/demo",
    "https://token@github.com/example/skill-fixture/tree/main/skills/demo",
    "https://example.invalid/example/skill-fixture/blob/main/skills/demo/SKILL.md",
  ])("rejects unsupported, ambiguous or unsafe links before Git for %s", url => {
    fixture(); expect(() => inspectSkillSource(url)).toThrow(); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
});
