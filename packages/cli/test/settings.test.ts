/**
 * Settings on disk: two files, one precedence, one gate.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, parseSettings, saveUserSetting, saveUserSettings } from "../src/settings.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "motif-settings-"));
}

describe("parsing", () => {
  it("takes the recognised keys and reports the wrong-typed ones", () => {
    const { values, problems } = parseSettings(
      JSON.stringify({ model: "m", channel: "raw", maxTurns: 7, theme: "claude", thinking: true, compactAt: 0.6, permissions: "auto", hooks: {}, maxOutputTokens: "lots", seed: -1 }),
    );
    expect(values).toEqual({ model: "m", channel: "raw", maxTurns: 7, theme: "claude", thinking: true, compactAt: 0.6, permissions: "auto" });
    expect(problems).toHaveLength(2);
  });

  it("takes bashTimeout as whole seconds", () => {
    expect(parseSettings(JSON.stringify({ bashTimeout: 900 })).values).toEqual({ bashTimeout: 900 });
    expect(parseSettings(JSON.stringify({ bashTimeout: 0 })).problems[0]).toContain("bashTimeout");
    expect(parseSettings(JSON.stringify({ bashTimeout: 1.5 })).problems[0]).toContain("bashTimeout");
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

  it.runIf(process.platform === "win32")("creates settings private to the current Windows account", () => {
    const home = mkdtempSync(join(tmpdir(), "motif-profile-"));
    const path = saveUserSettings({ theme: "mono", endpoint: "https://openrouter.ai/api" }, home);
    const check = [
      "$a=[IO.File]::GetAccessControl($env:MOTIF_FIXTURE)",
      "$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))",
      "$a.AreAccessRulesProtected -and $r.Count -eq 1 -and $r[0].IdentityReference -eq [Security.Principal.WindowsIdentity]::GetCurrent().User",
    ].join("\n");
    expect(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], {
      env: { ...process.env, MOTIF_FIXTURE: path }, encoding: "utf8", windowsHide: true,
    }).trim()).toBe("True");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "mono", endpoint: "https://openrouter.ai/api" });
  });

  it.skipIf(process.platform === "win32")("updates a linked settings file when saving the provider and model together", () => {
    const home = tmp();
    const target = join(tmp(), "settings.json");
    mkdirSync(join(home, ".motif"));
    const link = join(home, ".motif", "settings.json");
    writeFileSync(target, JSON.stringify({ theme: "mono", extension: "keep" }));
    symlinkSync(target, link);
    saveUserSettings({ endpoint: "https://openrouter.ai/api", model: "motif-technologies/motif-3" }, home);
    expect(realpathSync(link)).toBe(realpathSync(target));
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      theme: "mono", extension: "keep", endpoint: "https://openrouter.ai/api", model: "motif-technologies/motif-3",
    });
  });

  it("replaces a file that no longer parses rather than failing forever", () => {
    const home = tmp();
    mkdirSync(join(home, ".motif"));
    writeFileSync(join(home, ".motif", "settings.json"), "{broken");
    const path = saveUserSetting("theme", "mono", home);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "mono" });
  });
});
