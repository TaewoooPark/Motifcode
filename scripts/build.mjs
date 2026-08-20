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

/**
 * The benchmark suite tool ships alongside `motif` rather than as a second
 * project. It has to spawn the same binary it was built with — a suite runner
 * measuring a `motif` from somewhere else on the PATH is measuring something
 * nobody can identify afterwards.
 */
const ENTRIES = [
  { entry: "packages/cli/src/main.ts", out: "motif.js" },
  { entry: "packages/eval/src/suite-cli.ts", out: "motif-suite.js" },
];

let bytes = 0;
for (const { entry, out } of ENTRIES) {
  const outfile = join(OUT_DIR, out);
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    outfile,
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
  const bundled = readFileSync(outfile, "utf8").replace(/^#!.*\n/, "");
  writeFileSync(outfile, `#!/usr/bin/env node\n${bundled}`, "utf8");
  chmodSync(outfile, 0o755);
  const size = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  bytes += size;
  process.stdout.write(`built ${outfile} (${(size / 1024).toFixed(0)} KB)\n`);
}

writeFileSync(
  join(OUT_DIR, "build-info.json"),
  JSON.stringify({ version: pkg.version, bytes, node: process.version }, null, 2) + "\n",
  "utf8",
);
