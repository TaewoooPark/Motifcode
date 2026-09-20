/**
 * Whether this run should offer to install the `motif` command.
 *
 * `npx motifcode` fetches the package into npm's cache and runs it there;
 * nothing is left on the PATH, and the first person to try it typed `motif`
 * afterwards and found no such command. So a run that came from the npx
 * cache, on a machine with no `motif` on the PATH, is offered the global
 * install once — npm's own `npm install -g`, of exactly the version that is
 * running — and the session carries on either way.
 */

import { existsSync } from "node:fs";
import { delimiter, join, sep } from "node:path";

/** True when the entry point lives in npm's npx cache (`…/_npx/<hash>/…`). */
export function ranFromNpx(entry: string | undefined): boolean {
  if (!entry) return false;
  return entry.split(/[\\/]/).includes("_npx");
}

/**
 * True when `name` resolves on the PATH outside the npx cache. npx puts its
 * own `node_modules/.bin` on the PATH of the process it runs, which is the
 * one place a hit must not count.
 */
export function commandOnPath(name: string, pathEnv = process.env["PATH"] ?? ""): boolean {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "" || dir.split(sep).includes("_npx") || dir.includes(`${sep}_npx${sep}`) || dir.includes("/_npx/")) continue;
    if (existsSync(join(dir, name)) || existsSync(join(dir, `${name}.cmd`))) return true;
  }
  return false;
}

/** The install that puts `motif` and `motifcode` on the PATH, pinned to this version. */
export function installCommand(version: string): string {
  return `npm install -g motifcode@${version}`;
}
