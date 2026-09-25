import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "@motifcode/skills";
import { inspectClientSkills, inspectSkillSource, installSkillCandidates, listInstalledSkills, listSkillMarketplace, loadInstalledSkills, removeInstalledSkill, updateInstalledSkill } from "../src/skill-installer.js";
import { runSkillsArgv } from "../src/skills-command.js";

const roots: string[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), "motif-skill-install-test-")); roots.push(root); return root; }
function file(root: string, path: string, content: string): string { const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, content); return target; }
function skill(root: string, path: string, name = "hello", body = "Say hello."): string { return file(root, `${path}/SKILL.md`, `---\nname: ${name}\ndescription: >\n  A sample skill\n  with resources\n---\n${body}\n`); }
function plugin(root: string, name = "bundle", flavor = "claude"): void { file(root, `${flavor === "portable" ? "" : `.${flavor}-plugin/`}plugin.json`, JSON.stringify({ ...(flavor === "portable" ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" } : {}), name, version: "1.0.0" })); }
function install(source: string, home: string, opts = {}) { const inspected = inspectSkillSource(source, { home, ...opts }); try { return installSkillCandidates(inspected, { home, ...opts }); } finally { inspected.cleanup(); } }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("managed skill packages", () => {
  it("preserves resources and metadata, loads from the snapshot, and removes only Motif files", () => {
    const source = temp(); const home = temp(); skill(source, "demo"); file(source, "demo/references/data.txt", "resource"); file(source, "demo/assets/template.csv", "a,b\n1,2");
    const [receipt] = install(join(source, "demo"), home); expect(receipt!.originalName).toBe("hello");
    const loaded = loadInstalledSkills({ home, cwd: temp() }); expect(loaded.problems).toEqual([]); expect(loaded.skills[0]!.description).toBe("A sample skill with resources");
    expect(readFileSync(join(loaded.skills[0]!.baseDir!, "references/data.txt"), "utf8")).toBe("resource");
    removeInstalledSkill(receipt!.id, { home }); expect(listInstalledSkills({ home })).toEqual([]); expect(existsSync(join(source, "demo/SKILL.md"))).toBe(true);
  });
  it("keeps shared plugin references and registers only the selected skill", () => {
    const source = temp(); const home = temp(); plugin(source); skill(source, "skills/hello", "hello", "Read ${CLAUDE_PLUGIN_ROOT}/shared/data.txt"); skill(source, "skills/other", "other"); file(source, "shared/data.txt", "shared"); file(source, "hooks/hooks.json", '{"hooks":{}}');
    const [receipt] = install(source, home, { skills: ["bundle:hello"] });
    const loaded = loadInstalledSkills({ home, cwd: temp() }); expect(loaded.skills.map(s => s.name)).toEqual(["bundle:hello"]);
    const reg = new SkillRegistry(); reg.registerAll(loaded.skills); const result = reg.load("bundle:hello", { invocation: "user" }); expect(result.ok).toBe(true); expect(result.output).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(readFileSync(join(loaded.skills[0]!.packageRoot!, "shared/data.txt"), "utf8")).toBe("shared"); expect(receipt!.diagnostics.some(d => d.code === "package_dependencies")).toBe(true);
  });
  it("does not write on dry-run and refuses unrelated name collisions", () => {
    const a = temp(); const b = temp(); const home = temp(); skill(a, "demo"); skill(b, "demo");
    install(join(a, "demo"), home, { dryRun: true }); expect(existsSync(join(home, ".motif"))).toBe(false);
    install(join(a, "demo"), home); expect(() => install(join(b, "demo"), home)).toThrow(/another source/);
    install(join(b, "demo"), home, { namespace: "second" }); expect(listInstalledSkills({ home }).map(r => r.name)).toEqual(["hello", "second:hello"]);
  });
  it("rejects same-scope handwritten collisions without changing either copy", () => {
    const source = temp(); const home = temp(); skill(source, "demo"); skill(home, ".motif/skills/hello");
    expect(() => install(join(source, "demo"), home)).toThrow(/handwritten skill/); expect(listInstalledSkills({ home })).toEqual([]);
    expect(install(join(source, "demo"), home, { namespace: "external" })[0]!.name).toBe("external:hello");
  });
  it("reports across-scope handwritten precedence without changing the existing override order", () => {
    const source = temp(); const home = temp(); const cwd = temp(); skill(source, "demo"); skill(home, ".motif/skills/hello");
    const [receipt] = install(join(source, "demo"), home, { cwd, scope: "project" }); expect(receipt!.diagnostics.some(d => d.code === "skill_shadowed" && d.message.includes("user"))).toBe(true);
  });
  it("frames binary file content so different trees never alias through separator bytes", () => {
    const a = temp(); const b = temp(); const home = temp(); skill(a, "demo"); skill(b, "demo"); file(a, "demo/a", `X\0b\0${420}\0Y`); file(b, "demo/a", "X"); file(b, "demo/b", "Y");
    const [first] = install(join(a, "demo"), home, { namespace: "first" }); const [second] = install(join(b, "demo"), home, { namespace: "second" });
    expect(first!.digest).not.toBe(second!.digest); expect(readFileSync(join(home, ".motif", second!.snapshot, "b"), "utf8")).toBe("Y");
  });
  it("keeps same-named source siblings distinct and updates only the chosen entry", () => {
    const source = temp(); const home = temp(); skill(source, "one"); skill(source, "two"); file(source, "one/which", "one"); file(source, "two/which", "two");
    const inspection = inspectSkillSource(source); const first = inspection.candidates[0]!; const second = inspection.candidates[1]!;
    const [row] = installSkillCandidates(inspection, { home, skills: [first.selectionId] });
    expect(() => installSkillCandidates(inspection, { home, skills: [second.selectionId] })).toThrow(/another source/);
    const [updated] = updateInstalledSkill(row!.id, { home }); expect(updated!.sourceRelativeFile).toBe(first.sourceRelativeFile); expect(readFileSync(join(home, ".motif", updated!.snapshot, "which"), "utf8")).toBe("one");
  });
  it("requires a choice for multiple skills and keeps shared snapshots until last remove", () => {
    const source = temp(); const home = temp(); plugin(source); skill(source, "skills/a", "a"); skill(source, "skills/b", "b");
    expect(() => install(source, home)).toThrow(/several skills/); const rows = install(source, home, { all: true }); expect(rows[0]!.snapshot).toBe(rows[1]!.snapshot);
    const snapshot = join(home, ".motif", rows[0]!.snapshot); removeInstalledSkill(rows[0]!.id, { home }); expect(existsSync(snapshot)).toBe(true); removeInstalledSkill(rows[1]!.id, { home }); expect(existsSync(snapshot)).toBe(false);
  });
  it("uses fixed portable skills even when a compatibility overlay tries to redirect them", () => {
    const source = temp(); plugin(source, "portable", "portable"); file(source, ".codex-plugin/plugin.json", '{"name":"legacy","skills":"./extras"}'); skill(source, "skills/a", "a"); skill(source, "extras/b", "b");
    const inspected = inspectSkillSource(source); expect(inspected.candidates.map(c => c.id)).toEqual(["portable:a"]); inspected.cleanup();
  });
  it("rejects a package symlink escape and leaves previous state untouched", () => {
    const source = temp(); const outside = temp(); const home = temp(); skill(source, "demo"); file(outside, "data.txt", "private"); symlinkSync(join(outside, "data.txt"), join(source, "demo/escape.txt"));
    expect(() => install(join(source, "demo"), home)).toThrow(/outside its root/); expect(listInstalledSkills({ home })).toEqual([]);
  });
  it("refuses a tampered destination store symlink", () => {
    const source = temp(); const home = temp(); const outside = temp(); skill(source, "demo"); mkdirSync(join(home, ".motif")); symlinkSync(outside, join(home, ".motif/skill-packages"));
    expect(() => install(join(source, "demo"), home)).toThrow(/store cannot be a symlink/); expect(existsSync(join(home, ".motif/skills-installed.json"))).toBe(false);
  });
  it("excludes credential/generated files and protects local snapshot edits from update/remove", () => {
    const source = temp(); const home = temp(); skill(source, "demo"); file(source, "demo/.env", "TOKEN=private"); file(source, "demo/node_modules/file", "generated");
    const [row] = install(join(source, "demo"), home); const snapshot = join(home, ".motif", row!.snapshot); expect(existsSync(join(snapshot, ".env"))).toBe(false); expect(row!.diagnostics.some(d => d.code === "excluded_files")).toBe(true);
    file(snapshot, "notes.txt", "local edit"); expect(() => updateInstalledSkill(row!.id, { home })).toThrow(/local changes/); expect(() => removeInstalledSkill(row!.id, { home })).toThrow(/local changes/);
  });
  it("updates an unmodified local snapshot preserving installed ID and namespace", () => {
    const source = temp(); const home = temp(); skill(source, "demo"); const [old] = install(join(source, "demo"), home, { namespace: "mine" }); file(source, "demo/references/new.txt", "new");
    const [updated] = updateInstalledSkill(old!.id, { home }); expect(updated!.id).toBe(old!.id); expect(updated!.name).toBe("mine:hello"); expect(updated!.digest).not.toBe(old!.digest);
    expect(existsSync(join(home, ".motif", old!.snapshot))).toBe(false); removeInstalledSkill(updated!.id, { home }); expect(readdirSync(join(home, ".motif/skill-packages"))).toEqual([]);
  });
  it("keeps an original colon name unchanged on update and protects newly added hidden files", () => {
    const source = temp(); const home = temp(); skill(source, "demo", "inner:hello"); const [old] = install(join(source, "demo"), home); const [updated] = updateInstalledSkill(old!.id, { home }); expect(updated!.name).toBe("inner:hello");
    file(join(home, ".motif", updated!.snapshot), ".env", "new local state"); expect(() => removeInstalledSkill(updated!.id, { home })).toThrow(/local changes/);
  });
  it("checks receipt paths before removal", () => {
    const source = temp(); const home = temp(); skill(source, "demo"); const [row] = install(join(source, "demo"), home); const index = join(home, ".motif/skills-installed.json"); const value = JSON.parse(readFileSync(index, "utf8")); value.skills[0].snapshot = "../../source"; writeFileSync(index, JSON.stringify(value));
    expect(() => removeInstalledSkill(row!.id, { home })).toThrow(/snapshot path is invalid/); expect(existsSync(join(source, "demo/SKILL.md"))).toBe(true);
  });
  it("supports an explicit Git ref without changing the source checkout", () => {
    const source = temp(); const home = temp(); skill(source, "demo"); const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--quiet"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"); const commit = git("rev-parse", "HEAD"); file(source, "demo/untracked.txt", "not in commit");
    const [row] = install(source, home, { ref: commit, path: "demo" }); expect(row!.origin.commit).toBe(commit); expect(existsSync(join(home, ".motif", row!.snapshot, "untracked.txt"))).toBe(false); expect(existsSync(join(source, "demo/untracked.txt"))).toBe(true);
  });
});

describe("marketplace and installed-client discovery", () => {
  it.each(["claude", "codex"] as const)("resolves %s catalog paths from repository root", client => {
    const source = temp(); const home = temp(); const catalog = client === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json";
    file(source, catalog, JSON.stringify({ name: "market", plugins: [{ name: "bundle", source: client === "claude" ? "./plugins/bundle" : { source: "local", path: "./plugins/bundle" } }] })); plugin(join(source, "plugins/bundle"), "bundle", client); skill(source, "plugins/bundle/skills/hello");
    expect(listSkillMarketplace(source).entries.map(e => e.name)).toEqual(["bundle"]); const [row] = install(source, home, { plugin: "bundle" }); expect(row!.name).toBe("bundle:hello"); expect(row!.origin.marketplace).toBe("market");
    expect(updateInstalledSkill(row!.id, { home })[0]!.name).toBe("bundle:hello");
  });
  it("rejects escape, unavailable and command sources without running them", () => {
    const source = temp(); const home = temp(); const marker = join(home, "ran"); file(source, ".claude-plugin/marketplace.json", JSON.stringify({ name: "market", plugins: [{ name: "escape", source: "../outside" }, { name: "blocked", source: "./x", policy: { installation: "NOT_AVAILABLE" } }, { name: "command", source: { source: "command", command: `touch ${marker}` } }] }));
    expect(() => inspectSkillSource(source, { plugin: "escape" })).toThrow(/relative/); expect(() => inspectSkillSource(source, { plugin: "blocked" })).toThrow(/unavailable/); expect(() => inspectSkillSource(source, { plugin: "command" })).toThrow(/not supported/); expect(existsSync(marker)).toBe(false);
  });
  it("limits a Claude marketplace-root entry to the entry's selected skills", () => {
    const source = temp(); file(source, ".claude-plugin/marketplace.json", JSON.stringify({ name: "market", plugins: [{ name: "chosen", source: ".", skills: ["./skills/a"] }] })); skill(source, "skills/a", "a"); skill(source, "skills/b", "b");
    const result = inspectSkillSource(source, { plugin: "chosen" }); expect(result.candidates.map(c => c.id)).toEqual(["chosen:a"]); result.cleanup();
    const home = temp(); file(source, "shared/data", "shared"); const [row] = install(source, home, { plugin: "chosen" }); const [updated] = updateInstalledSkill(row!.id, { home }); expect(updated!.relativeFile).toBe("skills/a/SKILL.md"); expect(readFileSync(join(home, ".motif", updated!.snapshot, "shared/data"), "utf8")).toBe("shared");
  });
  it("follows an explicitly discovered direct skill-folder symlink without following escaping resource links", () => {
    const home = temp(); const source = temp(); const cwd = temp(); skill(source, "demo"); mkdirSync(join(home, ".agents/skills"), { recursive: true }); symlinkSync(join(source, "demo"), join(home, ".agents/skills/demo"));
    const result = inspectClientSkills("codex", { home, cwd, inventory: { installed: [] } }); expect(result.candidates.map(c => c.id)).toEqual(["hello"]);
    const [row] = installSkillCandidates(result, { home }); expect(row!.name).toBe("hello");
  });
  it("imports only enabled Claude plugins in the requested project", () => {
    const home = temp(); const cwd = temp(); const enabled = temp(); const disabled = temp(); plugin(enabled, "enabled"); plugin(disabled, "disabled"); skill(enabled, "skills/hello"); skill(disabled, "skills/hello");
    const inventory = [{ enabled: true, scope: "project", projectPath: cwd, installPath: enabled }, { enabled: false, scope: "user", installPath: disabled }, { enabled: true, scope: "project", projectPath: "/different", installPath: disabled }];
    const result = inspectClientSkills("claude", { home, cwd, inventory }); expect(result.candidates.map(c => c.id)).toEqual(["enabled:hello"]);
  });
  it("uses exact Codex remote cache version instead of scanning stale versions", () => {
    const home = temp(); const cwd = temp(); const root = join(home, ".codex/plugins/cache/market/bundle/1.2.3"); plugin(root, "bundle", "codex"); skill(root, "skills/hello"); const stale = join(home, ".codex/plugins/cache/market/bundle/9.9.9"); plugin(stale, "stale", "codex"); skill(stale, "skills/stale", "stale");
    const result = inspectClientSkills("codex", { home, cwd, inventory: { installed: [{ enabled: true, installed: true, name: "bundle", marketplaceName: "market", version: "1.2.3", source: { source: "remote" } }] } }); expect(result.candidates.map(c => c.id)).toEqual(["bundle:hello"]);
    const [receipt] = installSkillCandidates(result, { home }); const updatedRoot = join(home, ".codex/plugins/cache/market/bundle/2.0.0"); plugin(updatedRoot, "bundle", "codex"); skill(updatedRoot, "skills/hello"); file(updatedRoot, "shared/data", "2.0.0");
    const [updated] = updateInstalledSkill(receipt!.id, { home, cwd, inventory: { installed: [{ enabled: true, installed: true, name: "bundle", marketplaceName: "market", version: "2.0.0", source: { source: "remote" } }] } }); expect(updated!.origin.source).toContain("2.0.0"); expect(readFileSync(join(home, ".motif", updated!.snapshot, "shared/data"), "utf8")).toBe("2.0.0");
  });
  it("provides unique selectable IDs for duplicate direct client skill names", () => {
    const home = temp(); const cwd = temp(); skill(home, ".agents/skills/hello"); skill(home, ".codex/skills/hello");
    const options = { home, cwd, inventory: { installed: [] } }; const result = inspectClientSkills("codex", options); expect(result.candidates).toHaveLength(2); expect(new Set(result.candidates.map(c => c.selectionId)).size).toBe(2);
    const selection = result.candidates[0]!.selectionId; const renamed = inspectClientSkills("codex", { ...options, namespace: "chosen" }); expect(renamed.candidates[0]!.selectionId).toBe(selection);
    expect(installSkillCandidates(renamed, { ...options, skills: [selection] })[0]!.name).toBe("chosen:hello");
  });
  it("owns command parsing and rejects unknown/inapplicable options", async () => {
    const home = temp(); let stderr = ""; let stdout = ""; const options = { home, cwd: temp(), stdout: (s: string) => stdout += s, stderr: (s: string) => stderr += s };
    expect(await runSkillsArgv(["unknown"], {}, options)).toBe(2); expect(stderr).toContain("Unknown skills subcommand");
    expect(await runSkillsArgv(["list", "--ref", "main"], {}, options)).toBe(2); expect(await runSkillsArgv(["installed", "--json"], {}, options)).toBe(0); expect(stdout).toContain("[]");
  });
});
