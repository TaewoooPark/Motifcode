/**
 * The manifest: everything about a benchmark run that must be decided in
 * advance, written down, and unable to move afterwards.
 *
 * A benchmark number without one of these is not a result, it is an anecdote.
 * The manifest pins the dataset revision, the evaluator commit, the checkpoint
 * hash, the harness git SHA, the system prompt and tool schema hashes, the
 * sampling settings and seeds, the budgets, and — the part that decides whether
 * the arithmetic is honest — the acceptance rule and the non-inferiority
 * margin.
 *
 * Two rules do most of the work.
 *
 * Unknown fields are rejected rather than ignored. A typo in `noninferiority_margin_pp`
 * that silently defaults is worse than one that fails: the run completes, the
 * number looks fine, and nothing anywhere records that the gate was never
 * applied.
 *
 * Mutable references are rejected. `main`, `latest` and a bare tag all name
 * something that can change after the run, which makes the result
 * unreproducible in a way no amount of care afterwards can fix.
 */

export type RunStatus =
  | "planned"
  | "running"
  | "completed"
  | "agent_timeout"
  | "safety_cap"
  | "agent_crash"
  | "model_transport_failure"
  | "grader_failed"
  | "grader_infra_error"
  | "missing";

export interface SuiteSpec {
  name: string;
  dataset_revision: string;
  split: string;
  instances_sha256: string;
  evaluator: { repo: string; commit: string; image_digest?: string };
}

export interface CandidateSpec {
  config_id: string;
  role: "candidate" | "baseline";
  model_id: string;
  checkpoint_sha256?: string;
  tokenizer_sha256?: string;
  config_sha256?: string;
  keep_list_sha256?: string;
  profile_manifest_sha256?: string;
  pruning_manifest_sha256?: string;
}

export interface HarnessSpec {
  name: string;
  git_sha: string;
  system_prompt_sha256: string;
  tool_schema_sha256: string;
  initial_channel: "toolcall" | "object" | "raw";
  channel_policy: "fixed" | "adaptive";
  features: {
    tool_failure_repair: boolean;
    benchmark_one_repair: boolean;
    subagents: boolean;
    hooks: boolean;
  };
}

export interface ServingSpec {
  engine: string;
  git_sha?: string;
  image_digest?: string;
  flags_sha256?: string;
  dtype?: string;
  quantization?: string;
  hardware: { name: string; count: number };
}

export interface SamplingSpec {
  temperature: number;
  top_p: number;
  seed_policy: "paired" | "independent";
  seeds: number[];
  max_output_tokens_per_step: number;
}

export interface BudgetSpec {
  max_model_steps: number;
  max_turns: number;
  max_repairs_per_failure: number;
  /** The grader's limit on one test run. Aider's is 180 s. */
  command_timeout_seconds: number;
  /**
   * A wall-clock budget per task, or `null` for none — Aider's benchmark has
   * none. On a slow shared endpoint a wall-clock limit measures serving speed
   * and scores it as the harness.
   */
  task_wall_timeout_seconds: number | null;
  /**
   * With no wall-clock budget, the limit past which a row is taken to be a
   * wedged process and killed as `safety_cap`: infrastructure, not a result.
   */
  safety_cap_seconds?: number;
  max_total_tokens: number | null;
}

/**
 * How a harness benchmark's rows are run, pinned with the rest.
 *
 * `polyglot-harness-v2`: the polyglot tasks and Aider's grading, with the
 * protocol for an agent — track H hides the graded tests, track V shows them;
 * a feedback round (H2) resumes a failed row once with the test output; the
 * grades are read under the official rules first and the strict ones beside
 * them; agents' network use is judged by a fixed, versioned rule.
 */
export interface ProtocolSpec {
  name: "polyglot-harness-v2";
  track: "H" | "V";
  feedback_round: boolean;
  grading_rules: ("official" | "strict")[];
  network_rule: string;
  replicates: number;
}

export interface EnvironmentSpec {
  agent_image_digest?: string;
  network: "disabled" | "allowlist" | "enabled";
  repo_reset: string;
}

export interface DesignSpec {
  split_role: "dev" | "sealed_test";
  pair_group: string;
  primary_metric: string;
  /**
   * The non-inferiority margin, in percentage points.
   *
   * Required, and never defaulted. A margin is a product decision about how
   * much quality may be traded for size, and inventing one in code turns a
   * judgement call into an implementation detail. Without it the tools report
   * the raw difference and its interval and decline to say "quality retained".
   */
  noninferiority_margin_pp: number | null;
  confidence_level: number;
  randomization_seed: number;
  missing_run_policy: "score_zero" | "exclude";
}

export interface EvalManifest {
  schema_version: "motifcode.eval/v1";
  manifest_id: string;
  suite: SuiteSpec;
  candidate: CandidateSpec;
  baseline?: CandidateSpec;
  harness: HarnessSpec;
  serving: ServingSpec;
  sampling: SamplingSpec;
  budgets: BudgetSpec;
  environment: EnvironmentSpec;
  design: DesignSpec;
  protocol?: ProtocolSpec;
}

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`manifest is not usable:\n  - ${problems.join("\n  - ")}`);
    this.name = "ManifestError";
  }
}

const MUTABLE_REF = /^(main|master|latest|HEAD|dev|develop)$/i;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "manifest_id",
  "suite",
  "candidate",
  "baseline",
  "harness",
  "serving",
  "sampling",
  "budgets",
  "environment",
  "design",
  "protocol",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a manifest, collecting every problem rather than the first.
 *
 * Reporting one problem at a time turns fixing a manifest into a sequence of
 * failed runs.
 */
export function validateManifest(input: unknown): EvalManifest {
  const problems: string[] = [];
  if (!isRecord(input)) throw new ManifestError(["manifest must be a mapping"]);

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      problems.push(`unknown field "${key}" — refused rather than ignored, in case it was meant to change something`);
    }
  }
  if (input["schema_version"] !== "motifcode.eval/v1") {
    problems.push(`schema_version must be "motifcode.eval/v1"`);
  }
  if (typeof input["manifest_id"] !== "string" || input["manifest_id"] === "") {
    problems.push("manifest_id is required");
  }

  const suite = input["suite"];
  if (!isRecord(suite)) {
    problems.push("suite is required");
  } else {
    if (typeof suite["dataset_revision"] !== "string" || MUTABLE_REF.test(String(suite["dataset_revision"]))) {
      problems.push("suite.dataset_revision must be an immutable revision, not a branch name");
    }
    if (typeof suite["instances_sha256"] !== "string" || !SHA256.test(String(suite["instances_sha256"]))) {
      problems.push("suite.instances_sha256 must be a sha256 of the ordered instance list");
    }
    const ev = suite["evaluator"];
    if (!isRecord(ev)) {
      problems.push("suite.evaluator is required");
    } else {
      const commit = String(ev["commit"] ?? "");
      if (!SHA1.test(commit) && !SHA256.test(commit)) {
        problems.push("suite.evaluator.commit must be a full commit hash");
      }
      if (ev["image_digest"] !== undefined && !DIGEST.test(String(ev["image_digest"]))) {
        problems.push("suite.evaluator.image_digest must be sha256:<64 hex>");
      }
    }
  }

  const harness = input["harness"];
  if (!isRecord(harness)) {
    problems.push("harness is required");
  } else {
    const commit = String(harness["git_sha"] ?? "");
    if (!SHA1.test(commit) && !SHA256.test(commit)) {
      problems.push("harness.git_sha must be a full commit hash");
    }
    for (const field of ["system_prompt_sha256", "tool_schema_sha256"]) {
      if (!SHA256.test(String(harness[field] ?? ""))) {
        problems.push(`harness.${field} must be a sha256`);
      }
    }
  }

  const sampling = input["sampling"];
  if (!isRecord(sampling)) {
    problems.push("sampling is required");
  } else {
    const temp = Number(sampling["temperature"]);
    const seeds = sampling["seeds"];
    if (!Array.isArray(seeds) || seeds.length === 0) {
      problems.push("sampling.seeds must list at least one seed");
    }
    if (temp > 0 && sampling["seed_policy"] !== "paired" && Array.isArray(seeds) && seeds.length < 2) {
      // Stochastic sampling with one unpaired seed measures the difference
      // between two draws as if it were the difference between two systems.
      problems.push(
        "sampling: temperature > 0 needs either seed_policy: paired or several seeds; " +
          "one unpaired draw cannot separate a system difference from sampling noise",
      );
    }
  }

  const design = input["design"];
  if (!isRecord(design)) {
    problems.push("design is required");
  } else if (
    design["noninferiority_margin_pp"] !== null &&
    typeof design["noninferiority_margin_pp"] !== "number"
  ) {
    problems.push("design.noninferiority_margin_pp must be a number or explicitly null");
  }

  const budgets = input["budgets"];
  if (isRecord(budgets)) {
    const wall = budgets["task_wall_timeout_seconds"];
    if (wall !== null && !(typeof wall === "number" && wall > 0)) {
      problems.push("budgets.task_wall_timeout_seconds must be a positive number of seconds, or null for none");
    }
    const cap = budgets["safety_cap_seconds"];
    if (cap !== undefined && !(typeof cap === "number" && cap > 0)) {
      problems.push("budgets.safety_cap_seconds must be a positive number of seconds");
    }
    if (wall === null && cap === undefined) {
      // Without either, a wedged row holds its slot until someone notices.
      problems.push("budgets: with no task_wall_timeout_seconds, safety_cap_seconds is required");
    }
    const grading = budgets["command_timeout_seconds"];
    if (!(typeof grading === "number" && grading > 0)) {
      problems.push("budgets.command_timeout_seconds must be a positive number of seconds");
    }
  }

  const protocol = input["protocol"];
  if (protocol !== undefined) {
    if (!isRecord(protocol)) {
      problems.push("protocol must be a mapping");
    } else {
      if (protocol["name"] !== "polyglot-harness-v2") problems.push('protocol.name must be "polyglot-harness-v2"');
      if (protocol["track"] !== "H" && protocol["track"] !== "V") problems.push("protocol.track must be H or V");
      if (typeof protocol["feedback_round"] !== "boolean") problems.push("protocol.feedback_round must be true or false");
      const rules = protocol["grading_rules"];
      if (!Array.isArray(rules) || rules[0] !== "official" || !rules.every((r) => r === "official" || r === "strict")) {
        problems.push('protocol.grading_rules must list "official" first, then optionally "strict"');
      }
      if (typeof protocol["network_rule"] !== "string" || protocol["network_rule"] === "") {
        problems.push("protocol.network_rule must name the rule version");
      }
      const reps = protocol["replicates"];
      if (!(typeof reps === "number" && Number.isInteger(reps) && reps >= 1)) {
        problems.push("protocol.replicates must be a whole number >= 1");
      }
      for (const key of Object.keys(protocol)) {
        if (!["name", "track", "feedback_round", "grading_rules", "network_rule", "replicates"].includes(key)) {
          problems.push(`unknown field "protocol.${key}"`);
        }
      }
    }
  }

  // A fixed channel that is allowed to downgrade is not a fixed channel, and
  // the run would silently become two experiments.
  if (isRecord(harness) && harness["channel_policy"] === "fixed" && harness["features"] !== undefined) {
    const features = harness["features"];
    if (isRecord(features) && features["channel_downgrade"] === true) {
      problems.push("harness: channel_policy is fixed but channel_downgrade is enabled");
    }
  }

  if (problems.length > 0) throw new ManifestError(problems);
  return input as unknown as EvalManifest;
}

/**
 * Refuse to compare two configurations that were not measured the same way.
 *
 * A paired analysis assumes the pairs differ in exactly the thing under test.
 * Two runs on different suites, different budgets or different seeds differ in
 * several things at once, and the difference between them is not attributable
 * to any of them.
 */
export function checkPairable(a: EvalManifest, b: EvalManifest): string[] {
  const problems: string[] = [];
  if (a.suite.name !== b.suite.name || a.suite.dataset_revision !== b.suite.dataset_revision) {
    problems.push("different suite or dataset revision");
  }
  if (a.suite.instances_sha256 !== b.suite.instances_sha256) {
    problems.push("different instance lists");
  }
  if (a.suite.evaluator.commit !== b.suite.evaluator.commit) {
    problems.push("different evaluator commit");
  }
  if (JSON.stringify(a.budgets) !== JSON.stringify(b.budgets)) {
    problems.push("different budgets");
  }
  if (JSON.stringify(a.protocol ?? null) !== JSON.stringify(b.protocol ?? null)) {
    problems.push("different protocol");
  }
  if (a.sampling.seed_policy !== b.sampling.seed_policy) {
    problems.push("different seed policy");
  }
  if (JSON.stringify(a.sampling.seeds) !== JSON.stringify(b.sampling.seeds)) {
    problems.push("different seeds");
  }
  if (a.design.pair_group !== b.design.pair_group) {
    problems.push("different pair group");
  }
  return problems;
}
