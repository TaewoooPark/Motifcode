import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inspectClientSkills, inspectSkillSource, installSkillCandidates, updateInstalledSkill, type SkillInstallOptions } from "../src/skill-installer.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const roots: string[] = [];
const remotes = new Map<string, string>();
const sourceUrl = "https://example.invalid/skills.git";
const catalogUrl = "https://example.invalid/catalog.git";
function temp(): string { const root = mkdtempSync(join(tmpdir(), "motif-skill-boundary-test-")); roots.push(root); return root; }
function file(root: string, path: string, text: string): void { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); }
function skill(root: string, path: string, name: string): void { file(root, join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Skill source boundary fixture.\n---\nRead references/data.txt.\n`); file(root, join(path, "references/data.txt"), name); }
function repository(url: string, populate: (root: string) => void): { source: string; commit: string } {
  const source = temp(); populate(source);
  const git = (...args: string[]) => actual.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  remotes.set(url, source); return { source, commit: git("rev-parse", "HEAD") };
}
function install(input: string, options: SkillInstallOptions) {
  const inspected = inspectSkillSource(input, options);
  try { return installSkillCandidates(inspected, options); } finally { inspected.cleanup(); }
}
beforeEach(() => {
  // Exercise real Git fetch/checkout; only transport is redirected to isolated fixtures.
  vi.mocked(execFileSync).mockImplementation(((command: string, args: readonly string[], options: ExecFileSyncOptions) => {
    const mapped = [...args]; const remote = mapped.find(arg => remotes.has(arg));
    if (remote) {
      mapped[mapped.indexOf(remote)] = remotes.get(remote)!;
      mapped.splice(mapped.findIndex(arg => arg === "fetch" || arg === "ls-remote"), 0, "-c", "protocol.file.allow=always");
    } else if (mapped.some(arg => arg.startsWith("https://"))) throw new Error("Unexpected network source in fixture");
    return actual.execFileSync(command, mapped, options);
  }) as typeof execFileSync);
});
afterEach(() => {
  vi.mocked(execFileSync).mockImplementation(actual.execFileSync); vi.clearAllMocks(); remotes.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Git skill folder boundaries", () => {
  it("rejects a tracked external directory link while retaining valid sibling skills", () => {
    const outside = temp(); skill(outside, "", "outside"); const home = temp();
    repository(sourceUrl, root => { skill(root, "skills/valid", "valid"); symlinkSync(outside, join(root, "skills/escape")); });
    const inspected = inspectSkillSource(sourceUrl, { home });
    try {
      expect(inspected.candidates.map(candidate => candidate.id)).toEqual(["valid"]);
      expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_skill", source: "skills/escape/SKILL.md", message: expect.stringContaining("escapes") }));
      const [receipt] = installSkillCandidates(inspected, { home, all: true });
      expect(readFileSync(join(home, ".motif", receipt!.snapshot, "references/data.txt"), "utf8")).toBe("valid");
    } finally { inspected.cleanup(); }
  });

  it("rejects directory links to a prefix sibling outside the selected Git subtree", () => {
    repository(sourceUrl, root => {
      skill(root, "selected/skills/valid", "valid"); skill(root, "selected-sibling/outside", "outside");
      symlinkSync("../../selected-sibling/outside", join(root, "selected/skills/escape"));
    });
    const inspected = inspectSkillSource(sourceUrl, { path: "selected" });
    try {
      expect(inspected.candidates.map(candidate => candidate.id)).toEqual(["valid"]);
      expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_skill", source: "skills/escape/SKILL.md" }));
    } finally { inspected.cleanup(); }
  });

  it("installs and updates an internal directory alias with sibling resources", () => {
    repository(sourceUrl, root => {
      skill(root, "selected/bundled/demo", "internal"); mkdirSync(join(root, "selected/skills"));
      symlinkSync("../bundled/demo", join(root, "selected/skills/alias"));
    });
    const home = temp(); const [receipt] = install(sourceUrl, { home, path: "selected" });
    expect(receipt!.origin).toMatchObject({ kind: "git", source: sourceUrl, subpath: "selected" });
    expect(receipt!.sourceRelativeFile).toBe("skills/alias/SKILL.md");
    expect(readFileSync(join(home, ".motif", receipt!.snapshot, "references/data.txt"), "utf8")).toBe("internal");
    expect(updateInstalledSkill(receipt!.id, { home })[0]!.id).toBe(receipt!.id);
  });

  it.each(["local", "client"] as const)("preserves explicitly selected %s directory links", source => {
    const outside = temp(); skill(outside, "", "explicit"); const home = temp(); const cwd = temp();
    const library = source === "client" ? join(home, ".agents/skills") : join(cwd, "skills");
    mkdirSync(library, { recursive: true }); symlinkSync(outside, join(library, "linked"));
    const inspected = source === "client" ? inspectClientSkills("codex", { home, cwd, inventory: [] }) : inspectSkillSource(library, { home, cwd });
    try {
      const [receipt] = installSkillCandidates(inspected, { home, cwd });
      expect(readFileSync(join(home, ".motif", receipt!.snapshot, "references/data.txt"), "utf8")).toBe("explicit");
    } finally { inspected.cleanup(); }
  });
});

describe("marketplace remote source boundaries", () => {
  it.each(["github", "url", "git-subdir"])("rejects absolute and relative host paths in a %s source", source => {
    const parent = temp(); const home = temp(); const cwd = join(parent, "work"); mkdirSync(cwd);
    const outside = join(parent, "outside"); skill(outside, "", "private-local");
    const field = source === "github" ? "repo" : "url";
    repository(catalogUrl, root => file(root, ".claude-plugin/marketplace.json", JSON.stringify({ name: "catalog", plugins: [
      { name: "absolute", source: { source, [field]: outside, ...(source === "git-subdir" ? { path: "." } : {}) } },
      { name: "relative", source: { source, [field]: "../outside", ...(source === "git-subdir" ? { path: "." } : {}) } },
    ] })));
    for (const plugin of ["absolute", "relative"]) {
      expect(() => {
        const inspected = inspectSkillSource(catalogUrl, { home, cwd, plugin });
        inspected.cleanup();
      }).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^invalid_(source|path)$/) }));
    }
    expect(existsSync(join(home, ".motif"))).toBe(false);
  });

  it.each(["github", "url", "git-subdir"])("uses the declared %s remote even when an identically named local path exists", source => {
    const home = temp(); const cwd = temp(); const input = source === "github" ? "example/child" : "https://example.invalid/child.git";
    const childUrl = source === "github" ? "https://github.com/example/child.git" : input;
    const subpath = source === "git-subdir" ? "plugins/child" : "";
    skill(resolve(cwd, input), subpath, "wrong-local");
    const child = repository(childUrl, root => skill(root, subpath, "remote"));
    repository(catalogUrl, root => file(root, ".claude-plugin/marketplace.json", JSON.stringify({ name: "catalog", plugins: [{
      name: "chosen", source: { source, [source === "github" ? "repo" : "url"]: input, ...(subpath ? { path: subpath } : {}) },
    }] })));
    const [receipt] = install(catalogUrl, { home, cwd, plugin: "chosen" });
    expect(receipt!.name).toBe("chosen:remote");
    expect(receipt!.origin).toMatchObject({ kind: "git", source: childUrl, commit: child.commit, catalog: { source: catalogUrl, entry: "chosen" } });
    expect(readFileSync(join(home, ".motif", receipt!.snapshot, "references/data.txt"), "utf8")).toBe("remote");
    expect(updateInstalledSkill(receipt!.id, { home, cwd })[0]!.digest).toBe(receipt!.digest);
  });
});
