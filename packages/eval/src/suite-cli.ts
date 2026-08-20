#!/usr/bin/env node
/**
 * `motif-suite` — build a benchmark suite and check the machine can run it.
 *
 * Two subcommands, and the second is the one that matters.
 *
 *     motif-suite build   --benchmark <checkout> --out <dir> [--languages ...]
 *     motif-suite verify  --benchmark <checkout> --out <dir> [--languages ...]
 *
 * `verify` runs each exercise's own reference solution against its own tests.
 * An exercise that fails there fails for every configuration, and a suite full
 * of them reports a model that cannot code when what it has is a machine
 * missing a toolchain. Running it first turns that into a list of instances to
 * exclude, named, before any number is produced.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPolyglotSuite,
  instanceSummary,
  polyglotGrader,
  referenceSolution,
  type PolyglotInstance,
} from "./polyglot.js";

interface Flags {
  [key: string]: string | boolean;
}

function parse(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {};
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else if (!command) {
      command = a;
    }
  }
  return { command, flags };
}

function str(flags: Flags, key: string, fallback = ""): string {
  const v = flags[key];
  return typeof v === "string" ? v : fallback;
}

/**
 * The reference solution's patch, produced the way an agent's would be.
 *
 * Deliberately routed through the same `git diff` the runner uses, so `verify`
 * exercises the extraction and application path rather than only the tests.
 */
function referencePatch(instance: PolyglotInstance, files: Record<string, string>): string {
  const tree = mkdtempSync(join(tmpdir(), "motif-ref-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", "-q", "-f", tree, instance.baseCommit], {
      cwd: instance.repo,
    });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(tree, name), content, "utf8");
    }
    return execFileSync("git", ["diff"], { cwd: tree, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: instance.repo });
    rmSync(tree, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { command, flags } = parse(process.argv.slice(2));
  const benchmark = str(flags, "benchmark");
  const out = str(flags, "out");
  if (!command || !benchmark || !out) {
    process.stderr.write(
      "usage: motif-suite <build|verify> --benchmark <polyglot checkout> --out <dir>\n" +
        "       [--languages python,javascript] [--limit N] [--node-path <node_modules>]\n",
    );
    return 2;
  }

  const languages = str(flags, "languages", "python").split(",").filter(Boolean);
  const limitRaw = str(flags, "limit");
  const nodePath = str(flags, "node-path");
  const instances = buildPolyglotSuite({
    root: benchmark,
    languages,
    repoRoot: out,
    ...(limitRaw ? { limit: Number(limitRaw) } : {}),
    ...(nodePath ? { nodePath } : {}),
  });
  process.stderr.write(`built ${instanceSummary(instances)} -> ${out}\n`);

  if (command === "build") {
    process.stdout.write(
      JSON.stringify(
        instances.map((i) => ({
          id: i.id,
          repo: i.repo,
          baseCommit: i.baseCommit,
          language: i.language,
          exercise: i.exercise,
          testFile: i.testFile,
          solutionFiles: i.solutionFiles,
          ...(i.setupCommand ? { setupCommand: i.setupCommand } : {}),
        })),
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (command !== "verify") {
    process.stderr.write(`unknown command ${command}\n`);
    return 2;
  }

  const unusable: string[] = [];
  let checked = 0;
  for (const instance of instances) {
    const files = referenceSolution(benchmark, instance);
    if (!files) {
      unusable.push(`${instance.id}: no reference solution in .meta`);
      continue;
    }
    const grader = polyglotGrader(instance, nodePath ? { nodePath } : {});
    const result = await grader.grade({
      instanceId: instance.id,
      patch: referencePatch(instance, files),
      baseCommit: instance.baseCommit,
      timeoutSeconds: 120,
    });
    checked++;
    if (result.status !== "passed") {
      unusable.push(
        `${instance.id}: reference solution ${result.status}` +
          (result.stderrArtifact ? ` — ${result.stderrArtifact.trim().split("\n").slice(-1)[0]}` : ""),
      );
    }
    process.stderr.write(result.status === "passed" ? "." : "x");
  }
  process.stderr.write("\n");

  process.stdout.write(JSON.stringify({ checked, usable: checked - unusable.length, unusable }, null, 2) + "\n");
  if (unusable.length > 0) {
    process.stderr.write(
      `${unusable.length} instance(s) cannot pass on this machine. Exclude them by name, or fix ` +
        "the toolchain — leaving them in reports a model failing at tasks nothing could run.\n",
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
