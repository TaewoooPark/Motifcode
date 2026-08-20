#!/usr/bin/env node
/**
 * `motif-suite` — build a benchmark suite and check the machine can run it.
 *
 * Two subcommands, and the second is the one that matters.
 *
 *     motif-suite build   --benchmark <checkout> --out <dir> [--languages ...]
 *     motif-suite verify  --benchmark <checkout> --out <dir> [--languages ...]
 *     motif-suite run     --manifest <json> --benchmark <checkout> --out <dir> \
 *                         --agent <path to motif.js> --endpoint <url> --model <id>
 *
 * `verify` asks two different questions and keeps their answers apart.
 *
 * Can the tests run here at all? Checked by grading the untouched stub, which
 * must come back `failed` — tests that execute and report a failure. If that
 * errors instead, the machine cannot run the instance and no configuration
 * will ever pass it.
 *
 * Does the exercise's own reference solution pass? A stronger check, and the
 * one that confirms the instance is solvable as shipped.
 *
 * They fail for different reasons and merging them was wrong. Six Rust
 * exercises ship a `.meta/example.rs` importing crates their own `Cargo.toml`
 * does not declare — the reference cannot build, but the stub and the tests are
 * perfectly consistent and a model that solves it without those crates passes.
 * Dropping those instances would discard good work on the strength of a defect
 * in the benchmark's own reference material.
 *
 * `run` materialises the manifest's rows before starting, drives the agent
 * through each one, and reports over the planned denominator rather than over
 * the rows that happened to finish. It writes results as it goes: a campaign
 * of several hundred rows that reports only at the end reports nothing when it
 * is interrupted in row three hundred.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateManifest } from "./manifest.js";
import { countStatuses, formatCounts, materialize, passed, planRuns, resolvedRate } from "./results.js";
import { runAll } from "./runner.js";
import { formatPaired, judgeNonInferiority, pairedBootstrap, type PairedOutcome } from "./stats.js";
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
      mkdirSync(dirname(join(tree, name)), { recursive: true });
      writeFileSync(join(tree, name), content, "utf8");
    }
    // Staged first. Several reference solutions add files the stub does not
    // have — Java's `bowling` ships `Frame.java` beside `BowlingGame.java` —
    // and `git diff` without `git add` does not show a new file at all. The
    // reference then applies as a partial solution and fails to compile,
    // which reads as a broken exercise rather than a broken check.
    execFileSync("git", ["add", "-A"], { cwd: tree });
    return execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: tree,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: instance.repo });
    rmSync(tree, { recursive: true, force: true });
  }
}

/**
 * A patch that applies cleanly and changes nothing the tests read.
 *
 * `verify` needs to run the tests against the untouched stub, and the grader
 * short-circuits an empty patch to `failed` without running anything — correct
 * during a campaign, useless here. Appending a line to the instructions is a
 * real change to a file no test looks at.
 */
function noopPatch(instance: PolyglotInstance): string {
  const tree = mkdtempSync(join(tmpdir(), "motif-stub-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", "-q", "-f", tree, instance.baseCommit], {
      cwd: instance.repo,
    });
    const path = join(tree, "INSTRUCTIONS.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\n<!-- stub check -->\n", "utf8");
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
          testFiles: i.testFiles,
          solutionFiles: i.solutionFiles,
          ...(i.setupCommand ? { setupCommand: i.setupCommand } : {}),
        })),
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (command === "run") {
    return campaign(flags, instances, nodePath);
  }

  if (command !== "verify") {
    process.stderr.write(`unknown command ${command}\n`);
    return 2;
  }

  const timeout = Number(str(flags, "timeout", "300"));
  const unrunnable: string[] = [];
  const alreadyPassing: string[] = [];
  const referenceBroken: string[] = [];
  const confirmed: string[] = [];

  for (const instance of instances) {
    const grader = polyglotGrader(instance, nodePath ? { nodePath } : {});
    const detail = (text: string | undefined): string =>
      text
        ? " — " +
          text
            .trim()
            .split("\n")
            .filter((l) => /error|Error|cannot|not found|No such/.test(l))
            .slice(0, 2)
            .join(" / ")
            .slice(0, 300)
        : "";

    // The stub, with a patch that touches nothing the tests read. An empty
    // patch would short-circuit in the grader, which is right for a campaign
    // and useless here.
    const stub = await grader.grade({
      instanceId: instance.id,
      patch: noopPatch(instance),
      baseCommit: instance.baseCommit,
      timeoutSeconds: timeout,
    });
    if (stub.status === "passed") {
      // The tests already pass with no work done. Exercism's refactoring
      // exercises are like this — `ledger`, `tree-building` — and the task is
      // to clean working code up, which "do the tests pass" cannot grade. Left
      // in, it is a free point for every configuration alike, which inflates
      // every absolute rate and tells you nothing about any of them.
      alreadyPassing.push(`${instance.id}: tests pass with the stub untouched`);
      process.stderr.write("0");
      continue;
    }
    if (stub.status !== "failed") {
      unrunnable.push(`${instance.id}: stub graded ${stub.status}${detail(stub.stderrArtifact)}`);
      process.stderr.write("E");
      continue;
    }

    const files = referenceSolution(benchmark, instance);
    if (!files) {
      referenceBroken.push(`${instance.id}: no reference solution in .meta`);
      process.stderr.write("?");
      continue;
    }
    const reference = await grader.grade({
      instanceId: instance.id,
      patch: referencePatch(instance, files),
      baseCommit: instance.baseCommit,
      timeoutSeconds: timeout,
    });
    if (reference.status === "passed") {
      confirmed.push(instance.id);
      process.stderr.write(".");
    } else {
      referenceBroken.push(
        `${instance.id}: reference ${reference.status}${detail(reference.stderrArtifact)}`,
      );
      process.stderr.write("x");
    }
  }
  process.stderr.write("\n");

  process.stdout.write(
    JSON.stringify(
      {
        checked: instances.length,
        confirmed: confirmed.length,
        referenceBrokenButRunnable: referenceBroken.length,
        alreadyPassing: alreadyPassing.length,
        unrunnable: unrunnable.length,
        confirmedIds: confirmed,
        referenceBroken,
        alreadyPassingDetail: alreadyPassing,
        unrunnableDetail: unrunnable,
      },
      null,
      2,
    ) + "\n",
  );
  if (unrunnable.length > 0) {
    process.stderr.write(
      `\n${unrunnable.length} instance(s) cannot run here at all — exclude them by name or fix ` +
        "the toolchain. Leaving them in reports a model failing at tasks nothing could run.\n",
    );
  }
  if (alreadyPassing.length > 0) {
    process.stderr.write(
      `${alreadyPassing.length} instance(s) already pass untouched and cannot discriminate ` +
        "between configurations. Exclude them: they raise every rate by the same amount.\n",
    );
  }
  if (referenceBroken.length > 0) {
    process.stderr.write(
      `${referenceBroken.length} instance(s) run but their shipped reference does not pass. ` +
        "The tests still work; what is unconfirmed is that the exercise is solvable as shipped. " +
        "Keeping them is defensible, excluding them is defensible, doing it silently is not.\n",
    );
  }
  return 0;
}

/**
 * One campaign: every planned row, then the report.
 *
 * The instances are filtered to what the manifest names, not the other way
 * round. A suite that quietly contributes extra instances changes the
 * denominator after the fact, which is the same problem as dropping rows with
 * the sign reversed.
 */
async function campaign(
  flags: Flags,
  built: readonly PolyglotInstance[],
  nodePath: string,
): Promise<number> {
  const manifestPath = str(flags, "manifest");
  const agent = str(flags, "agent");
  const endpoint = str(flags, "endpoint", "http://127.0.0.1:8080");
  const model = str(flags, "model");
  const results = str(flags, "results", "results.jsonl");
  const exclude = new Set(str(flags, "exclude").split(",").filter(Boolean));
  if (!manifestPath || !agent || !model) {
    process.stderr.write("run needs --manifest, --agent and --model\n");
    return 2;
  }

  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const usable = built.filter((i) => !exclude.has(i.id));
  if (exclude.size > 0) {
    // Named, in the output, next to the number. An exclusion nobody can see is
    // indistinguishable from a suite that was always that size.
    process.stderr.write(`excluded ${exclude.size}: ${[...exclude].join(", ")}\n`);
  }

  const planned = planRuns(manifest, usable.map((i) => i.id));
  process.stderr.write(
    `${planned.length} planned row(s) = ${usable.length} instance(s) x ` +
      `${manifest.sampling.seeds.length} seed(s) x ` +
      `${manifest.baseline ? 2 : 1} config(s)\n`,
  );

  mkdirSync(dirname(results) || ".", { recursive: true });
  writeFileSync(results, "");

  const workRoot = str(flags, "work-root", join(tmpdir(), "motif-campaign"));
  const observed = await runAll(
    {
      manifest,
      instances: usable,
      grader: {
        name: "polyglot",
        version: "1",
        // Per instance, because the test file and command differ per exercise.
        grade: (request) => {
          const instance = usable.find((i) => i.id === request.instanceId);
          if (!instance) throw new Error(`no instance ${request.instanceId}`);
          return polyglotGrader(instance, nodePath ? { nodePath } : {}).grade(request);
        },
      },
      agentCommand: agent.split(" "),
      endpoint,
      model,
      workRoot,
      onRow: (row) => {
        appendFileSync(results, JSON.stringify(row) + "\n");
        const mark = passed(row) ? "PASS" : row.status === "completed" ? "fail" : row.status;
        process.stderr.write(`  ${row.instanceId} seed ${row.seed}: ${mark}\n`);
      },
    },
    planned,
  );

  const rows = materialize(planned, observed);
  const overall = resolvedRate(rows);
  process.stdout.write(
    `\nresolved ${(overall.rate * 100).toFixed(1)}% ` +
      `(${overall.numerator}/${overall.denominator})\n${formatCounts(overall.counts)}\n`,
  );

  if (manifest.baseline) {
    const pairs: PairedOutcome[] = [];
    for (const instance of usable) {
      for (const seed of manifest.sampling.seeds) {
        const find = (configId: string) =>
          rows.find(
            (r) => r.configId === configId && r.instanceId === instance.id && r.seed === seed,
          );
        const candidate = find(manifest.candidate.config_id);
        const baseline = find(manifest.baseline.config_id);
        // A row that is missing on either side is still a pair, scored false.
        // Dropping it would compare the candidate's easy instances against the
        // baseline's full set.
        pairs.push({
          instanceId: instance.id,
          seed,
          candidate: candidate ? passed(candidate) : false,
          baseline: baseline ? passed(baseline) : false,
        });
      }
    }
    const result = pairedBootstrap(pairs, {
      confidenceLevel: manifest.design.confidence_level,
      bootstrapSeed: manifest.design.randomization_seed,
    });
    const verdict = judgeNonInferiority(result, manifest.design.noninferiority_margin_pp);
    process.stdout.write("\n" + formatPaired(result, verdict) + "\n");
  }

  const counts = countStatuses(rows);
  if (counts.transportFailure > 0) {
    // Not a footnote. Rows the server refused are rows the model never saw,
    // and a rate computed over them describes the server.
    process.stderr.write(
      `\n${counts.transportFailure} row(s) ended on transport failure. The number above ` +
        "includes them as zeroes; decide whether that is a result or a broken campaign.\n",
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
