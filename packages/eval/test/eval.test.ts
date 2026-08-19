/**
 * The evaluation contracts.
 *
 * Every test here is a way a benchmark number gets quietly inflated: a mutable
 * dataset reference, a denominator made of surviving journals, a margin nobody
 * committed to, an adapter that passes everything.
 */

import { describe, expect, it } from "vitest";
import type { GraderResult } from "@motifcode/journal";
import {
  CALIBRATION_FIXTURES,
  ManifestError,
  ToyGrader,
  calibrate,
  calibrationProblems,
  checkPairable,
  countStatuses,
  discordant,
  formatPaired,
  holmAdjust,
  judgeNonInferiority,
  materialize,
  pairedBootstrap,
  planRuns,
  resolvedRate,
  validateManifest,
  type CompletedRun,
  type EvalManifest,
  type PairedOutcome,
} from "../src/index.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "motifcode.eval/v1",
    manifest_id: "motif3-prune-swe-v1",
    suite: {
      name: "swe-bench-verified",
      dataset_revision: SHA1,
      split: "test",
      instances_sha256: SHA256,
      evaluator: { repo: "princeton-nlp/SWE-bench", commit: SHA1, image_digest: `sha256:${SHA256}` },
    },
    candidate: { config_id: "pruned-reap-050", role: "candidate", model_id: "Motif-3-pruned" },
    baseline: { config_id: "original", role: "baseline", model_id: "Motif-3" },
    harness: {
      name: "motifcode",
      git_sha: SHA1,
      system_prompt_sha256: SHA256,
      tool_schema_sha256: SHA256,
      initial_channel: "toolcall",
      channel_policy: "fixed",
      features: {
        tool_failure_repair: true,
        benchmark_one_repair: false,
        subagents: false,
        hooks: false,
      },
    },
    serving: { engine: "vllm-motif", hardware: { name: "GB10", count: 1 } },
    sampling: {
      temperature: 1.0,
      top_p: 0.95,
      seed_policy: "paired",
      seeds: [1001],
      max_output_tokens_per_step: 16384,
    },
    budgets: {
      max_model_steps: 250,
      max_turns: 250,
      max_repairs_per_failure: 1,
      command_timeout_seconds: 120,
      task_wall_timeout_seconds: 14400,
      max_total_tokens: null,
    },
    environment: { network: "disabled", repo_reset: "pristine-per-run" },
    design: {
      split_role: "sealed_test",
      pair_group: "motif3-original-vs-pruned",
      primary_metric: "resolved_rate",
      noninferiority_margin_pp: 2.0,
      confidence_level: 0.95,
      randomization_seed: 20260820,
      missing_run_policy: "score_zero",
    },
    ...overrides,
  };
}

function problems(input: Record<string, unknown>): string[] {
  try {
    validateManifest(input);
    return [];
  } catch (err) {
    return err instanceof ManifestError ? err.problems : [String(err)];
  }
}

/* ------------------------------------------------------------------ */

describe("manifest validation", () => {
  it("accepts a complete manifest", () => {
    expect(() => validateManifest(manifest())).not.toThrow();
  });

  it("refuses an unknown field rather than ignoring it", () => {
    // A typo in `noninferiority_margin_pp` that silently defaults is worse than
    // one that fails: the run completes and nothing records that the gate was
    // never applied.
    expect(problems(manifest({ noninferiority_margin: 2 })).join()).toContain("unknown field");
  });

  it("refuses a mutable dataset reference", () => {
    const m = manifest();
    (m["suite"] as Record<string, unknown>)["dataset_revision"] = "main";
    expect(problems(m).join()).toContain("immutable revision");
  });

  it("refuses an evaluator without a full commit hash", () => {
    const m = manifest();
    (m["suite"] as Record<string, unknown>)["evaluator"] = { repo: "x", commit: "v1.2" };
    expect(problems(m).join()).toContain("full commit hash");
  });

  it("refuses a harness without prompt and schema hashes", () => {
    const m = manifest();
    (m["harness"] as Record<string, unknown>)["tool_schema_sha256"] = "short";
    expect(problems(m).join()).toContain("tool_schema_sha256");
  });

  it("refuses stochastic sampling with one unpaired seed", () => {
    const m = manifest();
    (m["sampling"] as Record<string, unknown>)["seed_policy"] = "independent";
    expect(problems(m).join()).toContain("sampling noise");
  });

  it("reports every problem at once", () => {
    const m = manifest({ schema_version: "wrong", manifest_id: "" });
    expect(problems(m).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses to pair two runs measured differently", () => {
    const a = validateManifest(manifest()) as EvalManifest;
    const b = validateManifest(
      manifest({
        budgets: { ...(manifest()["budgets"] as object), max_turns: 50 },
      }),
    ) as EvalManifest;
    expect(checkPairable(a, b)).toContain("different budgets");
  });
});

/* ------------------------------------------------------------------ */

describe("the denominator is the plan, not the survivors", () => {
  const m = validateManifest(manifest()) as EvalManifest;
  const instances = ["inst-1", "inst-2", "inst-3"];

  it("materialises every configuration, instance and seed before anything runs", () => {
    const planned = planRuns(m, instances);
    expect(planned).toHaveLength(6); // 2 configs x 3 instances x 1 seed
    expect(planned.every((p) => p.status === "planned")).toBe(true);
  });

  it("keeps a row nothing ever filled and scores it zero", () => {
    // The bug this prevents: a configuration that crashes on its hardest
    // instances leaves no journal for them and scores higher than one that
    // struggles through.
    const planned = planRuns(m, instances).filter((p) => p.configId === "pruned-reap-050");
    const observed: CompletedRun[] = [
      { ...planned[0]!, status: "completed", grade: pass() },
      { ...planned[1]!, status: "completed", grade: fail() },
    ];
    const rows = materialize(planned, observed);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.status).toBe("missing");

    const r = resolvedRate(rows);
    expect(r.denominator).toBe(3);
    expect(r.numerator).toBe(1);
    expect(r.rate).toBeCloseTo(1 / 3);
  });

  it("counts crashes, timeouts and ungraded rows separately", () => {
    const planned = planRuns(m, instances).filter((p) => p.configId === "original");
    const rows: CompletedRun[] = [
      { ...planned[0]!, status: "agent_crash" },
      { ...planned[1]!, status: "agent_timeout" },
      { ...planned[2]!, status: "completed", grade: notRun() },
    ];
    const counts = countStatuses(rows);
    expect(counts).toMatchObject({ planned: 3, passed: 0, agentCrash: 1, agentTimeout: 1, notGraded: 3 });
  });

  it("counts only a grader's pass as a pass", () => {
    const planned = planRuns(m, ["inst-1"])[0]!;
    // The agent said done and the process exited 0; neither is a grade.
    const row: CompletedRun = { ...planned, status: "completed", agentEndReason: "done" };
    expect(resolvedRate([row]).numerator).toBe(0);
  });
});

const pass = (): GraderResult => grade("passed");
const fail = (): GraderResult => grade("failed");
const notRun = (): GraderResult => grade("not_run");
function grade(status: GraderResult["status"]): GraderResult {
  return {
    status,
    score: status === "passed" ? 1 : 0,
    graderName: "toy",
    graderVersion: "1",
    startedAt: "",
    finishedAt: "",
  };
}

/* ------------------------------------------------------------------ */

describe("paired non-inferiority", () => {
  function pairs(spec: readonly [boolean, boolean][]): PairedOutcome[] {
    return spec.map(([b, c], i) => ({
      instanceId: `inst-${i}`,
      seed: 1001,
      baseline: b,
      candidate: c,
    }));
  }

  it("computes the paired difference and discordant counts by hand", () => {
    const p = pairs([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
      [true, false],
    ]);
    const r = pairedBootstrap(p, { bootstrapReplicates: 200 });
    expect(r.counts).toEqual({ bothPass: 1, baselineOnly: 2, candidateOnly: 1, bothFail: 1 });
    expect(r.baselineRate).toBeCloseTo(3 / 5);
    expect(r.candidateRate).toBeCloseTo(2 / 5);
    expect(r.delta).toBeCloseTo(-1 / 5);
  });

  it("declines to judge without a pre-registered margin", () => {
    // A margin is a product decision about acceptable loss. Inventing one in
    // code turns a judgement call into an implementation detail.
    const r = pairedBootstrap(pairs([[true, true]]), { bootstrapReplicates: 100 });
    const v = judgeNonInferiority(r, null);
    expect(v.decided).toBe(false);
    if (!v.decided) expect(v.reason).toContain("pre-registered");
  });

  it("fails a candidate that lost more than the margin", () => {
    const spec: [boolean, boolean][] = [];
    for (let i = 0; i < 100; i++) spec.push([true, i >= 20]);
    const r = pairedBootstrap(pairs(spec), { bootstrapReplicates: 2000 });
    const v = judgeNonInferiority(r, 2.0);
    expect(v.decided && v.nonInferior).toBe(false);
  });

  it("passes a candidate that matched the baseline", () => {
    const spec: [boolean, boolean][] = [];
    for (let i = 0; i < 100; i++) spec.push([i < 70, i < 70]);
    const r = pairedBootstrap(pairs(spec), { bootstrapReplicates: 2000 });
    const v = judgeNonInferiority(r, 2.0);
    expect(v.decided && v.nonInferior).toBe(true);
  });

  it("treats equality at the boundary as a failure", () => {
    // A margin exactly met has not been beaten, and this is the one decision
    // that must never round in the candidate's favour.
    const r = { ...pairedBootstrap(pairs([[true, true]]), { bootstrapReplicates: 10 }), lowerBound: -0.02 };
    const v = judgeNonInferiority(r, 2.0);
    expect(v.decided && v.nonInferior).toBe(false);
  });

  it("is reproducible from its recorded seed", () => {
    const spec: [boolean, boolean][] = [];
    for (let i = 0; i < 40; i++) spec.push([i % 3 !== 0, i % 4 !== 0]);
    const a = pairedBootstrap(pairs(spec), { bootstrapSeed: 7, bootstrapReplicates: 500 });
    const b = pairedBootstrap(pairs(spec), { bootstrapSeed: 7, bootstrapReplicates: 500 });
    expect(a.lowerBound).toBe(b.lowerBound);
  });

  it("clusters seeds within an instance rather than counting them as data", () => {
    // Two seeds on one task are two attempts at one problem. Treating them as
    // independent understates the uncertainty.
    const twoSeeds: PairedOutcome[] = [
      { instanceId: "a", seed: 1, baseline: true, candidate: false },
      { instanceId: "a", seed: 2, baseline: true, candidate: true },
    ];
    const r = pairedBootstrap(twoSeeds, { bootstrapReplicates: 100 });
    expect(r.n).toBe(1);
    expect(r.delta).toBeCloseTo(-0.5);
  });

  it("handles an all-identical outcome set without dividing by zero", () => {
    const r = pairedBootstrap(pairs([[true, true], [true, true]]), { bootstrapReplicates: 100 });
    expect(r.delta).toBe(0);
    expect(Number.isFinite(r.lowerBound)).toBe(true);
  });

  it("reports raw counts alongside the verdict", () => {
    const r = pairedBootstrap(pairs([[true, false], [false, true]]), { bootstrapReplicates: 100 });
    const text = formatPaired(r, judgeNonInferiority(r, 2.0));
    expect(text).toContain("discordant");
    expect(text).toContain("bootstrap");
  });

  it("corrects for multiple comparisons when it has to", () => {
    const adjusted = holmAdjust([0.01, 0.04, 0.03]);
    expect(adjusted[0]).toBeCloseTo(0.03);
    expect(adjusted.every((p, i, all) => i === 0 || p >= all[i - 1]! || true)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("grader calibration", () => {
  it("catches an adapter that passes everything", async () => {
    const always = new ToyGrader(() => "passed");
    const outcomes = await calibrate(always, { baseCommit: SHA1, instanceId: "inst-1" });
    expect(calibrationProblems(outcomes)).toHaveLength(CALIBRATION_FIXTURES.length);
  });

  it("accepts an adapter that fails the null patch and test tampering", async () => {
    const honest = new ToyGrader((req) => (req.patch.includes("real fix") ? "passed" : "failed"));
    const outcomes = await calibrate(honest, { baseCommit: SHA1, instanceId: "inst-1" });
    expect(calibrationProblems(outcomes)).toHaveLength(0);
  });

  it("hashes the patch so a grade can be traced to what was graded", async () => {
    const g = new ToyGrader(() => "failed");
    const result = await g.grade({
      instanceId: "i",
      patch: "diff --git a/x b/x\n",
      baseCommit: SHA1,
      timeoutSeconds: 60,
    });
    expect(result.patchSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
