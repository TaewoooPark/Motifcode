#!/usr/bin/env node
/**
 * Build the CLI into something that can be installed.
 *
 * `pnpm build` used to print "no build step yet" and exit 0, and `pnpm exec
 * motif` reported `Command "motif" not found`. Every check that passed —
 * typecheck, tests, lint — ran against TypeScript sources through `tsx`, so
 * nothing anywhere established that the thing users would install actually
 * starts.
 *
 * The output is a single bundled ESM file with a shebang. Bundling rather than
 * emitting one directory per workspace package is the difference between an
 * artifact you can `npm install -g` and a graph of nine private packages that
 * no registry will resolve. The workspace layout is a development convenience;
 * it should not be a distribution constraint.
 *
 * Node built-ins stay external — they come with the runtime. Nothing else is
 * external, because a runtime dependency is a thing that can be missing on the
 * machine where this matters.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "packages/cli/dist");
const OUT = join(OUT_DIR, "motif.js");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Workspace aliases, mirroring tsconfig `paths` and the vitest config. */
const WORKSPACE = [
  "protocol",
  "tools",
  "core",
  "replay",
  "tui",
  "skills",
  "agents",
  "hooks",
  "journal",
  "eval",
];

const alias = Object.fromEntries(
  WORKSPACE.map((name) => [`@motifcode/${name}`, join(ROOT, `packages/${name}/src/index.ts`)]),
);

mkdirSync(OUT_DIR, { recursive: true });

const result = await build({
  entryPoints: [join(ROOT, "packages/cli/src/main.ts")],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias,
  define: { "process.env.MOTIF_BUILD_VERSION": JSON.stringify(pkg.version) },
  logLevel: "warning",
  metafile: true,
});

// Exactly one shebang, whatever the entry file happened to carry. esbuild
// preserves the entry's, and a banner on top of it produces a second one on
// line 2 — which is a syntax error, not a comment.
const bundled = readFileSync(OUT, "utf8").replace(/^#!.*\n/, "");
writeFileSync(OUT, `#!/usr/bin/env node\n${bundled}`, "utf8");
chmodSync(OUT, 0o755);

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
writeFileSync(
  join(OUT_DIR, "build-info.json"),
  JSON.stringify({ version: pkg.version, bytes, node: process.version }, null, 2) + "\n",
  "utf8",
);

process.stdout.write(`built ${OUT} (${(bytes / 1024).toFixed(0)} KB)\n`);
