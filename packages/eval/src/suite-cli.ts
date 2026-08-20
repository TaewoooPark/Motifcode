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
 * `verify` runs each exercise's own reference solution against its own tests.
 * An exercise that fails there fails for every configuration, and a suite full
 * of them reports a model that cannot code when what it has is a machine
 * missing a toolchain. Running it first turns that into a list of instances to
 * exclude, named, before any number is produced.
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

  if (command === "run") {
    return campaign(flags, instances, nodePath);
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
