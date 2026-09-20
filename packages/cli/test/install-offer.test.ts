/**
 * When the session offers to install the command: only from npx, and only
 * when nothing called `motif` is already on the PATH.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandOnPath, installCommand, ranFromNpx } from "../src/install.js";

describe("the install offer", () => {
  it("recognises npm's npx cache as where it was run from", () => {
    expect(ranFromNpx("/Users/me/.npm/_npx/e2bdd53f2fda978e/node_modules/.bin/motif")).toBe(true);
    expect(ranFromNpx("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\motifcode\\dist\\motif.js")).toBe(true);
    expect(ranFromNpx("/Users/me/.nvm/versions/node/v24.13.0/bin/motif")).toBe(false);
    expect(ranFromNpx("/repo/packages/cli/dist/motif.js")).toBe(false);
    expect(ranFromNpx(undefined)).toBe(false);
  });

  it("finds a command on the PATH, ignoring the npx cache's own bin directory", () => {
    const root = mkdtempSync(join(tmpdir(), "motif-path-"));
    const real = join(root, "bin");
    const npx = join(root, "_npx", "abc", "node_modules", ".bin");
    mkdirSync(real, { recursive: true });
    mkdirSync(npx, { recursive: true });
    writeFileSync(join(npx, "motif"), "#!/bin/sh\n");
    chmodSync(join(npx, "motif"), 0o755);
    expect(commandOnPath("motif", [npx, real].join(delimiter))).toBe(false);
    writeFileSync(join(real, "motif"), "#!/bin/sh\n");
    chmodSync(join(real, "motif"), 0o755);
    expect(commandOnPath("motif", [npx, real].join(delimiter))).toBe(true);
    expect(commandOnPath("motif", "")).toBe(false);
  });

  it("installs exactly the version that is running", () => {
    expect(installCommand("0.2.1")).toBe("npm install -g motifcode@0.2.1");
  });
});
