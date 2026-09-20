import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describePlugins, loadPlugins } from "../src/plugins.js";

function plugin(root: string, name: string, opts: { skill?: boolean; agent?: boolean; badManifest?: boolean } = {}): void {
  const dir = join(root, ".motif", "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), opts.badManifest ? JSON.stringify({ description: "no name" }) : JSON.stringify({ name, description: `${name} plugin`, version: "1.0.0" }));
  if (opts.skill) {
    mkdirSync(join(dir, "skills", "deploy"), { recursive: true });
    writeFileSync(join(dir, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: ship it\n---\nRun the deploy.\n");
  }
  if (opts.agent) {
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "auditor.md"), "---\nname: auditor\ndescription: audits\ntools: 3\nreadOnly: true\n---\nAudit.\n");
  }
}

describe("plugins", () => {
  it("loads skills and agents from user and project plugins, project last", () => {
    const home = mkdtempSync(join(tmpdir(), "motif-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "motif-cwd-"));
    plugin(home, "mine", { skill: true });
    plugin(cwd, "theirs", { agent: true });
    const loaded = loadPlugins({ cwd, home });
    expect(loaded.plugins.map((p) => [p.name, p.source])).toEqual([["mine", "user"], ["theirs", "project"]]);
    expect(loaded.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(loaded.agents.map((a) => a.name)).toEqual(["auditor"]);
    expect(loaded.problems).toEqual([]);
    const text = describePlugins(loaded).join("\n");
    expect(text).toContain("mine");
    expect(text).toContain("1 skill(s): deploy");
    expect(text).toContain("1 agent(s): auditor");
  });

  it("reports a plugin without a name rather than dying", () => {
    const home = mkdtempSync(join(tmpdir(), "motif-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "motif-cwd-"));
    plugin(cwd, "broken", { badManifest: true });
    const loaded = loadPlugins({ cwd, home });
    expect(loaded.plugins).toEqual([]);
    expect(loaded.problems[0]).toContain("needs a name");
  });

  it("says so when there are none", () => {
    const loaded = loadPlugins({ cwd: mkdtempSync(join(tmpdir(), "a-")), home: mkdtempSync(join(tmpdir(), "b-")) });
    expect(describePlugins(loaded)[0]).toContain("no plugins");
  });
});
