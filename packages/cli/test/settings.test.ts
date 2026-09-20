/**
 * Settings on disk: two files, one precedence, one gate.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, parseSettings, saveUserSetting } from "../src/settings.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "motif-settings-"));
}

describe("parsing", () => {
  it("takes the recognised keys and reports the wrong-typed ones", () => {
    const { values, problems } = parseSettings(
      JSON.stringify({ model: "m", channel: "raw", maxTurns: 7, theme: "claude", thinking: true, compactAt: 0.6, hooks: {}, maxOutputTokens: "lots", seed: -1 }),
    );
    expect(values).toEqual({ model: "m", channel: "raw", maxTurns: 7, theme: "claude", thinking: true, compactAt: 0.6 });
    expect(problems).toHaveLength(2);
  });

  it("reports a file that is not JSON rather than throwing", () => {
    expect(parseSettings("{not json").problems[0]).toContain("not JSON");
    expect(parseSettings("[]").problems[0]).toContain("object");
  });
});

describe("loading", () => {
  it("layers the project file over the user file, but only when trusted", () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(join(home, ".motif"));
    mkdirSync(join(cwd, ".motif"));
    writeFileSync(join(home, ".motif", "settings.json"), JSON.stringify({ model: "user-model", theme: "mono" }));
    writeFileSync(join(cwd, ".motif", "settings.json"), JSON.stringify({ model: "project-model", maxTurns: 5, hooks: {} }));

    const untrusted = loadSettings({ cwd, home, projectTrusted: () => false });
    expect(untrusted.values).toEqual({ model: "user-model", theme: "mono" });
    expect(untrusted.projectApplied).toBe(false);

    const trusted = loadSettings({ cwd, home, projectTrusted: () => true });
    expect(trusted.values).toEqual({ model: "project-model", theme: "mono", maxTurns: 5 });
    expect(trusted.sources).toEqual({ model: "project", theme: "user", maxTurns: "project" });
    expect(trusted.projectApplied).toBe(true);
  });

  it("copes with neither file existing", () => {
    const loaded = loadSettings({ cwd: tmp(), home: tmp() });
    expect(loaded.values).toEqual({});
    expect(loaded.projectApplied).toBe(false);
  });
});

describe("saving", () => {
  it("merges one key into the user file and can remove it", () => {
    const home = tmp();
    const path = saveUserSetting("model", "x", home);
    saveUserSetting("theme", "claude", home);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "x", theme: "claude" });
    saveUserSetting("model", undefined, home);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "claude" });
  });

  it("replaces a file that no longer parses rather than failing forever", () => {
    const home = tmp();
    mkdirSync(join(home, ".motif"));
    writeFileSync(join(home, ".motif", "settings.json"), "{broken");
    const path = saveUserSetting("theme", "mono", home);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "mono" });
  });
});
