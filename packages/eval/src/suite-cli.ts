#!/usr/bin/env node
/**
 * `motif-suite` — build the polyglot harness benchmark, check the machine can
 * run it, and run it.
 *
 *     motif-suite build   --benchmark <checkout> --out <dir> [--languages ...] [--track H|V]
 *     motif-suite verify  --benchmark <checkout> --out <dir> [--languages ...]
 *     motif-suite run     --manifest <json> --benchmark <checkout> --out <dir> \
 *                         --agent <command> [--endpoint <url>] [--model <id>] \
 *                         [--replicate N] [--artifacts <dir>] [--concurrency N]
 *     motif-suite inspect <log>...
 *
 * The endpoint, the model and the API key resolve the way `motif` resolves
 * them — flags, then `MOTIF_*` in the environment, then `.env` — so a campaign
 * and the sessions it spawns talk to the same server with the same credential.
 *
 * `verify` asks two questions of every exercise and keeps the answers apart.
 * Graded untouched, does the stub fail? It must — tests that run and report a
 * failure — except where the exercise is a refactoring whose stub already
 * passes; Aider keeps those six and so does this, so they are listed, not
 * dropped. Does the exercise's own reference solution pass, under both rule
 * sets? For six Rust exercises it only builds with the crates its
 * `Cargo-example.toml` declares, so that file is used for the reference alone.
 *
 * `run` takes the track, the feedback round and the rule sets from the
 * manifest's `protocol`, refuses a suite whose fingerprint is not the
 * manifest's, reports over the planned denominator rather than over the rows
 * that happened to finish, and writes results as it goes.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEndpointConfig, withholdSecrets } from "@motifcode/core";
import { validateManifest } from "./manifest.js";
import { NETWORK_RULE, actionsFromLog, networkViolations } from "./network.js";
import { PolyglotGrader, feedbackMessage } from "./polyglot-grader.js";
import {
  buildPolyglotSuite,
  instanceSummary,
  instancesSha256,
  referenceSolution,
  type PolyglotInstance,
  type Track,
} from "./polyglot.js";
import {
  countStatuses,
  formatCounts,
  materialize,
  passed,
  passedStrict,
  passedWithFeedback,
  planRuns,
  resolvedRate,
} from "./results.js";
import { runAll, type RowGrader } from "./runner.js";
import { formatPaired, judgeNonInferiority, pairedBootstrap, type PairedOutcome } from "./stats.js";

interface Flags {
  [key: string]: string | boolean;
}

function parse(argv: string[]): { command: string; flags: Flags; rest: string[] } {
  const flags: Flags = {};
  const rest: string[] = [];
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else if (!command) {
      command = a;
    } else {
      rest.push(a);
    }
  }
  return { command, flags, rest };
}

function str(flags: Flags, key: string, fallback = ""): string {
  const v = flags[key];
  return typeof v === "string" ? v : fallback;
}

function track(value: string): Track {
  if (value !== "H" && value !== "V") throw new Error(`--track must be H or V, not ${value}`);
  return value;
}

/**
 * The reference solution's patch, produced the way an agent's would be.
 *
 * Routed through the same `git diff` the runner uses, so `verify` exercises
 * the extraction and application path rather than only the tests.
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
    // and `git diff` without `git add` does not show a new file at all.
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

/** The row grader: both rule sets, and the feedback message for a failed row. */
function rowGrader(instances: readonly PolyglotInstance[], nodePath: string): RowGrader {
  const byId = new Map(instances.map((i) => [i.id, i]));
  const graderFor = (id: string): PolyglotGrader => {
    const instance = byId.get(id);
    if (!instance) throw new Error(`no instance ${id}`);
    return new PolyglotGrader(instance, nodePath ? { nodePath } : {});
  };
  return {
    name: "polyglot-v2",
    version: "2",
    grade: (request) => graderFor(request.instanceId).grade(request),
    gradeRow: async (request) => {
      const instance = byId.get(request.instanceId)!;
      const grades = await graderFor(request.instanceId).gradeAll(request);
      return {
        official: grades.official.result,
        strict: grades.strict.result,
        ...(grades.official.result.status === "failed" ? { feedback: feedbackMessage(grades.official, instance) } : {}),
        detail: {
          shared: grades.shared,
          official: { carried: grades.official.carried, dropped: grades.official.dropped, restored: grades.official.restored, deleted: grades.official.deleted, output: grades.official.output },
          ...(grades.shared ? {} : { strict: { output: grades.strict.output } }),
        },
      };
    },
  };
}

async function main(): Promise<number> {
  const { command, flags, rest } = parse(process.argv.slice(2));
  if (command === "inspect") return inspect(rest);

  const benchmark = str(flags, "benchmark");
  const out = str(flags, "out");
  if (!command || !benchmark || !out) {
    process.stderr.write(
      "usage: motif-suite <build|verify|run> --benchmark <polyglot checkout> --out <dir>\n" +
        "       [--languages python,javascript] [--track H|V] [--limit N] [--node-path <node_modules>]\n" +
        "  run also takes --manifest, --agent, [--model] [--endpoint] [--results] [--exclude] [--concurrency N]\n" +
        "                 [--replicate N] [--artifacts <dir>] [--work-root <dir>] [--keep]\n" +
        "       motif-suite inspect <agent log or journal>...\n",
    );
    return 2;
  }

  const languages = str(flags, "languages", "python").split(",").filter(Boolean);
  const limitRaw = str(flags, "limit");
  const nodePath = str(flags, "node-path");
  const manifestPath = str(flags, "manifest");
  const manifest = command === "run" && manifestPath ? validateManifest(JSON.parse(readFileSync(manifestPath, "utf8"))) : undefined;
  const chosen = track(str(flags, "track", manifest?.protocol?.track ?? "H"));
  if (manifest?.protocol && chosen !== manifest.protocol.track) {
    process.stderr.write(`--track ${chosen} contradicts the manifest's track ${manifest.protocol.track}\n`);
    return 2;
  }
  const instances = buildPolyglotSuite({
    root: benchmark,
    languages,
    repoRoot: out,
    track: chosen,
    ...(limitRaw ? { limit: Number(limitRaw) } : {}),
    ...(nodePath ? { nodePath } : {}),
  });
  process.stderr.write(`built track ${chosen}: ${instanceSummary(instances)} -> ${out}\n`);

  if (command === "build") {
    process.stdout.write(
      JSON.stringify(
        instances.map((i) => ({
          id: i.id,
          repo: i.repo,
          baseCommit: i.baseCommit,
          language: i.language,
          exercise: i.exercise,
          track: i.track,
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

  if (command === "run") return campaign(flags, instances, nodePath);
  if (command !== "verify") {
    process.stderr.write(`unknown command ${command}\n`);
    return 2;
  }

  const timeout = Number(str(flags, "timeout", "180"));
  const stubFails: string[] = [];
  const stubPasses: string[] = [];
  const unrunnable: string[] = [];
  const referenceBroken: string[] = [];
  const confirmed: string[] = [];
  const confirmedStrict: string[] = [];
  const detail = (text: string): string =>
    " — " +
    text
      .trim()
      .split("\n")
      .filter((l) => /error|Error|FAIL|failed|cannot|not found|No such/.test(l))
      .slice(0, 3)
      .join(" / ")
      .slice(0, 400);

  for (const instance of instances) {
    const request = (patch: string) => ({ instanceId: instance.id, patch, baseCommit: instance.baseCommit, timeoutSeconds: timeout });
    // The stub, untouched: an empty patch is graded, not short-circuited.
    const stub = await new PolyglotGrader(instance, nodePath ? { nodePath } : {}).gradeAll(request(""));
    const stubStatus = stub.official.result.status;
    if (stubStatus === "passed") {
      // A refactoring exercise whose stub already passes. Aider keeps it, and
      // counts it passed when the model does not break it.
      stubPasses.push(instance.id);
      process.stderr.write("0");
    } else if (stubStatus === "failed") {
      stubFails.push(instance.id);
    } else {
      unrunnable.push(`${instance.id}: stub graded ${stubStatus}${detail(stub.official.output)}`);
      process.stderr.write("E");
      continue;
    }

    const files = referenceSolution(instance);
    if (!files) {
      referenceBroken.push(`${instance.id}: no reference solution in .meta`);
      process.stderr.write("?");
      continue;
    }
    const reference = await new PolyglotGrader(instance, { ...(nodePath ? { nodePath } : {}), reference: true }).gradeAll(
      request(referencePatch(instance, files)),
    );
    const official = reference.official.result.status === "passed";
    const strict = reference.strict.result.status === "passed";
    if (official) confirmed.push(instance.id);
    if (strict) confirmedStrict.push(instance.id);
    if (official && strict) {
      if (stubStatus === "failed") process.stderr.write(".");
    } else {
      const which = !official ? reference.official : reference.strict;
      referenceBroken.push(`${instance.id}: reference ${which.rules} ${which.result.status}${detail(which.output)}`);
      process.stderr.write("x");
    }
  }
  process.stderr.write("\n");

  process.stdout.write(
    JSON.stringify(
      {
        checked: instances.length,
        stubFails: stubFails.length,
        stubPasses: stubPasses.length,
        referenceConfirmedOfficial: confirmed.length,
        referenceConfirmedStrict: confirmedStrict.length,
        referenceBrokenButRunnable: referenceBroken.length,
        unrunnable: unrunnable.length,
        stubPassesIds: stubPasses,
        confirmedIds: confirmed,
        referenceBroken,
        unrunnableDetail: unrunnable,
      },
      null,
      2,
    ) + "\n",
  );
  if (unrunnable.length > 0) {
    process.stderr.write(
      `\n${unrunnable.length} instance(s) cannot run here at all — fix the toolchain. ` +
        "Leaving them in reports a model failing at tasks nothing could run.\n",
    );
  }
  if (stubPasses.length > 0) {
    process.stderr.write(
      `${stubPasses.length} instance(s) pass untouched. They stay in, as in Aider's benchmark: ` +
        "a harness that breaks one loses it.\n",
    );
  }
  if (referenceBroken.length > 0) {
    process.stderr.write(`${referenceBroken.length} instance(s) run but their reference does not pass here.\n`);
  }
  return 0;
}

/** Judge logs by the network rule: one JSON line per log, violations included. */
function inspect(paths: string[]): number {
  if (paths.length === 0) {
    process.stderr.write("usage: motif-suite inspect <agent log or journal>...\n");
    return 2;
  }
  let dirty = 0;
  for (const path of paths) {
    const actions = actionsFromLog(readFileSync(path, "utf8"));
    const violations = networkViolations(actions);
    if (violations.length > 0) dirty++;
    process.stdout.write(JSON.stringify({ path, rule: NETWORK_RULE, actions: actions.length, violations }) + "\n");
  }
  return dirty > 0 ? 1 : 0;
}

/**
 * One campaign: every planned row, then the report.
 *
 * The instances are filtered to what the manifest names, not the other way
 * round. A suite that quietly contributes extra instances changes the
 * denominator after the fact, which is the same problem as dropping rows with
 * the sign reversed.
 */
async function campaign(flags: Flags, built: readonly PolyglotInstance[], nodePath: string): Promise<number> {
  const manifestPath = str(flags, "manifest");
  const agent = str(flags, "agent");
  if (!manifestPath || !agent) {
    process.stderr.write("run needs --manifest and --agent\n");
    return 2;
  }
  const connection = resolveEndpointConfig({
    flags: {
      ...(str(flags, "endpoint") ? { endpoint: str(flags, "endpoint") } : {}),
      ...(str(flags, "model") ? { model: str(flags, "model") } : {}),
    },
  });
  const { endpoint, model, apiKey } = connection;
  // The agents get the key explicitly; nothing else spawned from here should.
  withholdSecrets(process.env);
  const results = str(flags, "results", "results.jsonl");
  const exclude = new Set(str(flags, "exclude").split(",").filter(Boolean));
  const concurrency = Number(str(flags, "concurrency", "1"));
  const replicate = Number(str(flags, "replicate", "1"));
  const artifacts = str(flags, "artifacts");
  // A row that ends badly takes its checkout and journal with it, which is the
  // right default for a campaign of hundreds and the wrong one the first time a
  // status shows up that nobody expected.
  const keepArtifacts = flags["keep"] === true || str(flags, "keep") === "true";

  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const fingerprint = instancesSha256(built);
  if (manifest.protocol && fingerprint !== manifest.suite.instances_sha256) {
    // A different checkout, a different track, a different build of the same
    // one: the manifest describes a suite this is not.
    process.stderr.write(
      `the built suite's fingerprint ${fingerprint.slice(0, 16)}… is not the manifest's ` +
        `${manifest.suite.instances_sha256.slice(0, 16)}…; refusing to run it under this manifest\n`,
    );
    return 2;
  }
  if (manifest.protocol && (!Number.isInteger(replicate) || replicate < 1 || replicate > manifest.protocol.replicates)) {
    process.stderr.write(`--replicate must be 1..${manifest.protocol.replicates}\n`);
    return 2;
  }
  const usable = built.filter((i) => !exclude.has(i.id));
  if (exclude.size > 0) {
    // Named, in the output, next to the number. An exclusion nobody can see is
    // indistinguishable from a suite that was always that size.
    process.stderr.write(`excluded ${exclude.size}: ${[...exclude].join(", ")}\n`);
  }

  const planned = planRuns(manifest, usable.map((i) => i.id), replicate);
  process.stderr.write(
    `${planned.length} planned row(s) = ${usable.length} instance(s) x ` +
      `${manifest.sampling.seeds.length} seed(s) x ${manifest.baseline ? 2 : 1} config(s), replicate ${replicate}` +
      (manifest.protocol ? `, track ${manifest.protocol.track}${manifest.protocol.feedback_round ? " + feedback round" : ""}` : "") +
      "\n",
  );

  mkdirSync(dirname(results) || ".", { recursive: true });
  writeFileSync(results, "");

  const workRoot = str(flags, "work-root", join(tmpdir(), "motif-campaign"));
  const observed = await runAll(
    {
      manifest,
      instances: usable,
      grader: rowGrader(usable, nodePath),
      agentCommand: agent.split(" "),
      endpoint,
      model,
      ...(apiKey !== undefined ? { apiKey } : {}),
      workRoot,
      concurrency,
      keepArtifacts,
      feedbackRound: manifest.protocol?.feedback_round === true,
      ...(artifacts ? { artifactsRoot: artifacts } : {}),
      onRow: (row) => {
        appendFileSync(results, JSON.stringify(row) + "\n");
        const mark = passed(row)
          ? "PASS"
          : row.invalid !== undefined
            ? `invalid (${row.invalid})`
            : row.feedback && passedWithFeedback(row)
              ? "pass after feedback"
              : row.status === "completed"
                ? "fail"
                : row.status;
        process.stderr.write(`  ${row.instanceId} seed ${row.seed}: ${mark}\n`);
      },
    },
    planned,
  );

  const rows = materialize(planned, observed);
  const overall = resolvedRate(rows);
  const strict = rows.filter(passedStrict).length;
  const second = rows.filter((r) => passedWithFeedback(r)).length;
  process.stdout.write(
    `\npass@1 ${(overall.rate * 100).toFixed(1)}% (${overall.numerator}/${overall.denominator}, official rules)` +
      ` · strict ${strict}/${overall.denominator}` +
      (manifest.protocol?.feedback_round ? ` · pass@2 ${second}/${overall.denominator}` : "") +
      `\n${formatCounts(overall.counts)}\n`,
  );

  if (manifest.baseline) {
    const pairs: PairedOutcome[] = [];
    for (const instance of usable) {
      for (const seed of manifest.sampling.seeds) {
        const find = (configId: string) =>
          rows.find((r) => r.configId === configId && r.instanceId === instance.id && r.seed === seed);
        const candidate = find(manifest.candidate.config_id);
        const baseline = find(manifest.baseline.config_id);
        // A row that is missing on either side is still a pair, scored false.
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
  if (counts.safetyCap > 0) {
    process.stderr.write(`${counts.safetyCap} row(s) hit the safety cap: infrastructure, to be re-run once.\n`);
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
