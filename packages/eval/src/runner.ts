/**
 * Driving the agent over the rows the manifest planned.
 *
 * The runner's whole job is to keep two things apart that everything else
 * wants to merge: where the agent works, and where the grade comes from. The
 * agent gets a disposable checkout it may do anything to. The grader gets its
 * own, from the same commit, that the agent has never had a path to. What
 * crosses between them is a patch and nothing else.
 *
 * The agent is spawned as a process rather than called in-process, for two
 * reasons that both cost something to give up. A benchmark should measure the
 * thing users run, and `motif` the binary is that thing — an in-process loop
 * with hand-assembled options measures a configuration nobody has. And an agent
 * that segfaults, wedges, or leaks a subprocess takes down a child rather than
 * the campaign, which matters when a row is one of several hundred.
 *
 * Every abnormal ending is a status, not an exception. `agent_crash`,
 * `agent_timeout` and `model_transport_failure` are distinct because they have
 * distinct causes and distinct fixes, and a run that collapses them into
 * "failed" cannot tell you the server fell over. All of them still score zero
 * and stay in the denominator; see `results.ts` for why that is the only honest
 * choice.
 */

import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionEndReason } from "@motifcode/core";
import type { GraderResult, JournalLine } from "@motifcode/journal";
import type { GradeRequest, GraderAdapter } from "./grader.js";
import type { EvalManifest } from "./manifest.js";
import { NETWORK_RULE, actionsFromLog, networkViolations, type AgentAction } from "./network.js";
import type { CompletedRun, PlannedRun } from "./results.js";

const exec = promisify(execFile);

export interface Instance {
  id: string;
  /** A clone the agent may write to. Never the grader's. */
  repo: string;
  baseCommit: string;
  /** What the agent is asked to do. The only task description it ever sees. */
  prompt: string;
  /**
   * Run in the agent's fresh checkout before it starts.
   *
   * For anything the exercise needs in order to *run* but does not ship — a
   * linked `node_modules`, a virtualenv. The agent has to be able to run the
   * tests while it works; an agent that cannot check itself is being asked to
   * write correct code blind, which measures something other than what the
   * benchmark claims to.
   */
  setupCommand?: string[];
  /**
   * What the agent's directory is called. Default `checkout`.
   *
   * Not cosmetic for every suite: the polyglot C++ exercises take their CMake
   * target from the directory's name, and one called `checkout` fails the
   * official build before a line of the agent's code is compiled.
   */
  workdirName?: string;
}

/** A row's grade: the primary verdict, a secondary rule set, and what a feedback round would say. */
export interface RowGrade {
  official: GraderResult;
  strict?: GraderResult;
  /** The message a feedback round sends when the official grade failed. */
  feedback?: string;
  /** Anything worth keeping beside the patch: what was carried, dropped, restored. */
  detail?: unknown;
}

/** A grader that can also report a second rule set and a feedback message for the row. */
export interface RowGrader extends GraderAdapter {
  gradeRow?(request: GradeRequest): Promise<RowGrade>;
}

export interface RunnerOptions {
  manifest: EvalManifest;
  instances: readonly Instance[];
  grader: RowGrader;
  /** The `motif` entry point: `["node", "/path/to/motif.js"]` or `["motif"]`. */
  agentCommand: string[];
  endpoint: string;
  model: string;
  /**
   * Credential for the endpoint, handed to each agent through its environment.
   *
   * Explicit rather than inherited: the campaign process may have read it from
   * a `.env` file, in which case it is not in the environment to inherit. The
   * agent reads it and withholds it from the commands it runs.
   */
  apiKey?: string;
  /** Where agent checkouts and journals go. Removed per row unless kept. */
  workRoot: string;
  keepArtifacts?: boolean;
  /**
   * Rows in flight at once. Default 1.
   *
   * Rows are already isolated from each other — a private git worktree, a
   * private work directory, a private journal — so running several is a
   * scheduling decision rather than a correctness one. It is a decision worth
   * making: a single decode stream on one accelerator leaves most of the
   * memory bandwidth idle, and the same weights are read for every sequence in
   * a batch, so aggregate throughput rises nearly linearly until the server's
   * own sequence cap is reached.
   *
   * Do not set this above what the serving side admits concurrently. Past that
   * point requests queue, per-row wall time grows, and rows start hitting
   * `task_wall_timeout_seconds` — which scores them zero and quietly turns a
   * scheduling mistake into a quality result.
   */
  concurrency?: number;
  /**
   * Track H2: when the official grade fails, resume the agent's session once
   * with the failed tests' output, then grade again. Aider's second try, for
   * an agent: the same session and directory, and still no test files.
   */
  feedbackRound?: boolean;
  /**
   * Where the runner keeps each row's evidence itself — the patch it graded,
   * both grades, the feedback message, the journals — whatever an adapter
   * does. An experiment once lost the patches of 33 rows to an adapter that
   * was edited while they ran.
   */
  artifactsRoot?: string;
  onRow?: (row: CompletedRun) => void;
}

interface AgentOutcome {
  status: "completed" | "agent_timeout" | "safety_cap" | "agent_crash" | "model_transport_failure";
  endReason?: SessionEndReason;
  wallMs: number;
  journalPath?: string;
}

/** A second, resumed round of the same session. */
interface Round {
  prompt: string;
  continueFrom: string;
}

/** When nothing else bounds a row: an infrastructure guard, not a budget. */
const DEFAULT_SAFETY_CAP_SECONDS = 6 * 60 * 60;

/**
 * Why the run ended, read from the record the agent itself wrote.
 *
 * A non-zero exit says the process failed; it does not say why, and the
 * difference between "the model server refused every request" and "the agent
 * hit a bug" is the difference between a broken campaign and a real result.
 * The loop already distinguishes them — `session_end` carries the reason — so
 * this reads that rather than inferring from the exit code.
 */
function endReasonOf(path: string): SessionEndReason | undefined {
  if (!existsSync(path)) return undefined;
  let reason: SessionEndReason | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: JournalLine;
    try {
      parsed = JSON.parse(line) as JournalLine;
    } catch {
      // A truncated tail is what a killed process leaves behind. That is
      // evidence about how the row ended, not a reason to stop reading.
      continue;
    }
    if ("record" in parsed && parsed.record.t === "event" && parsed.record.event.type === "session_end") {
      reason = parsed.record.event.reason;
    }
  }
  return reason;
}

async function runAgent(
  opts: RunnerOptions,
  instance: Instance,
  checkout: string,
  journalPath: string,
  seed: number,
  round?: Round,
): Promise<AgentOutcome> {
  const { budgets, sampling, harness } = opts.manifest;
  const argv = [
    ...opts.agentCommand.slice(1),
    round ? round.prompt : instance.prompt,
    ...(round ? ["--continue-from", round.continueFrom] : []),
    "--cwd", checkout,
    "--journal", journalPath,
    "--endpoint", opts.endpoint,
    "--model", opts.model,
    "--channel", harness.initial_channel,
    "--channel-policy", harness.channel_policy,
    "--max-turns", String(budgets.max_turns),
    "--max-output-tokens", String(sampling.max_output_tokens_per_step),
    "--seed", String(seed),
    "--no-hero",
  ];

  const started = Date.now();
  return new Promise<AgentOutcome>((resolve) => {
    const child = spawn(opts.agentCommand[0]!, argv, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...(opts.apiKey !== undefined ? { MOTIF_API_KEY: opts.apiKey } : {}),
      },
    });
    let timedOut = false;
    // A wall-clock budget when the manifest sets one. Without one the row runs
    // until the agent stops, as Aider's benchmark does, and only a safety cap
    // for a wedged process remains — recorded as its own status, because it
    // says something about the infrastructure and nothing about the task.
    const wall = budgets.task_wall_timeout_seconds;
    const capped = typeof wall !== "number";
    const limitS = typeof wall === "number" ? wall : (budgets.safety_cap_seconds ?? DEFAULT_SAFETY_CAP_SECONDS);
    const timer = setTimeout(() => {
      timedOut = true;
      // The group. An agent that started a build or a server leaves it running
      // if only the agent is signalled, and the next row then inherits a
      // machine with a process holding its port.
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, limitS * 1000);

    const settle = (code: number | null): void => {
      clearTimeout(timer);
      const wallMs = Date.now() - started;
      const endReason = endReasonOf(journalPath);
      // The timeout is checked first: a process the runner killed cannot have
      // written a meaningful exit code, and reading one as a crash would
      // attribute the runner's own budget to the agent.
      //
      // The exit code is the weaker witness. `motif` exits non-zero whenever
      // its loop ended on anything but `done`, so hitting the turn limit the
      // manifest itself set exits 1 — and reading that as a crash reports a
      // budget decision as a harness failure, which is the same mistake the
      // timeout branch above exists to avoid. The journal says why the loop
      // ended; believe it when it is there, and fall back to the exit code
      // only when the agent died without writing an ending at all.
      let status: AgentOutcome["status"];
      if (timedOut) status = capped ? "safety_cap" : "agent_timeout";
      else if (endReason === "transport_error") status = "model_transport_failure";
      else if (endReason === undefined) status = "agent_crash";
      else status = "completed";
      resolve({ status, ...(endReason ? { endReason } : {}), wallMs, journalPath });
    };
    child.on("error", () => settle(null));
    child.on("close", settle);
  });
}

/**
 * The agent's work, as a patch.
 *
 * `git add -A` first so that a file the agent created is in the diff. Without
 * it, an agent that solves the task by adding a module scores zero and the
 * transcript shows it working perfectly — a failure mode that looks like the
 * model being bad at the task.
 *
 * Against the base commit, not HEAD: an agent that commits its work moves HEAD,
 * and a diff against it would leave out everything committed.
 */
async function extractPatch(checkout: string, baseCommit: string): Promise<string> {
  await exec("git", ["add", "-A"], { cwd: checkout });
  const { stdout } = await exec("git", ["diff", "--cached", "--binary", baseCommit], {
    cwd: checkout,
    maxBuffer: 64 * 1024 * 1024,
  });
  // Unstaged again: a feedback round resumes in this directory, and an agent
  // that runs `git status` should see its work as it left it.
  await exec("git", ["reset", "-q"], { cwd: checkout }).catch(() => undefined);
  return stdout;
}

async function gradeRow(grader: RowGrader, request: GradeRequest): Promise<RowGrade> {
  if (grader.gradeRow) return grader.gradeRow(request);
  return { official: await grader.grade(request) };
}

/** An infrastructure error scores zero; it is kept as a status, not dropped. */
const scored = (grade: GraderResult | undefined): GraderResult | undefined =>
  grade && grade.status === "infra_error" ? { ...grade, score: 0 } : grade;

/**
 * Everything the agent did in a session, from its journal and, for an
 * adapter-driven harness, the harness's own log beside it (`<journal>.agent.log`).
 */
function actionsOf(journalPath: string): AgentAction[] {
  const out: AgentAction[] = [];
  for (const path of [journalPath, `${journalPath}.agent.log`]) {
    if (!existsSync(path)) continue;
    try {
      out.push(...actionsFromLog(readFileSync(path, "utf8")));
    } catch {
      // Unreadable evidence is not evidence of a violation.
    }
  }
  return out;
}

function keep(dir: string | undefined, name: string, from: string): void {
  if (!dir || !existsSync(from)) return;
  try {
    copyFileSync(from, join(dir, name));
  } catch {
    // Evidence is best-effort; the row's result does not depend on it.
  }
}

export async function runRow(
  opts: RunnerOptions,
  planned: PlannedRun,
  instance: Instance,
): Promise<CompletedRun> {
  const rowName = `${planned.configId}--${planned.instanceId}--${planned.seed}--${planned.replicate}`;
  const rowDir = join(opts.workRoot, rowName);
  const checkout = join(rowDir, instance.workdirName ?? "checkout");
  const journalPath = join(rowDir, "session.jsonl");
  mkdirSync(rowDir, { recursive: true });
  const evidence = opts.artifactsRoot ? join(opts.artifactsRoot, rowName.replace(/\//g, "--")) : undefined;
  if (evidence) mkdirSync(evidence, { recursive: true });

  try {
    // Serialized: `git worktree add` and `remove` both rewrite `.git/worktrees`
    // in the instance repository, and two rows for the same instance — a second
    // seed, a replicate — would be editing it at the same time. The call takes
    // well under a second, so a single lock costs nothing measurable and
    // removes a race that would surface as a grader_infra_error on one row in
    // some runs and not others.
    await withWorktreeLock(() =>
      exec("git", ["worktree", "add", "--detach", "-f", checkout, instance.baseCommit], {
        cwd: instance.repo,
      }),
    );
  } catch (err) {
    // The agent never started, so this is not a result about the agent.
    return { ...planned, status: "grader_infra_error", runId: undefined, agentEndReason: String(err).slice(0, 400) };
  }

  try {
    if (instance.setupCommand) {
      try {
        await exec(instance.setupCommand[0]!, instance.setupCommand.slice(1), { cwd: checkout });
      } catch (err) {
        // The agent never got a working environment, so anything it did next
        // is not evidence about the agent.
        return {
          ...planned,
          status: "grader_infra_error",
          agentEndReason: `checkout setup failed: ${String(err).slice(0, 300)}`,
        };
      }
    }
    const outcome = await runAgent(opts, instance, checkout, journalPath, planned.seed);
    const patch = await extractPatch(checkout, instance.baseCommit).catch(() => "");
    const request = (p: string): GradeRequest => ({
      instanceId: instance.id,
      patch: p,
      baseCommit: instance.baseCommit,
      timeoutSeconds: opts.manifest.budgets.command_timeout_seconds,
    });
    // A row where the agent never finished is still graded — an agent that
    // times out having already written the fix has solved the instance, and
    // discarding its work would score the clock rather than the model.
    const graded = await gradeRow(opts.grader, request(patch));
    if (evidence) {
      writeFileSync(join(evidence, "patch.diff"), patch);
      writeFileSync(join(evidence, "grade.json"), JSON.stringify(graded, null, 2) + "\n");
      keep(evidence, "session.jsonl", journalPath);
      keep(evidence, "agent.log", `${journalPath}.agent.log`);
    }

    let feedback: CompletedRun["feedback"];
    const actions = actionsOf(journalPath);
    if (opts.feedbackRound && graded.official.status === "failed" && graded.feedback !== undefined) {
      const second = join(rowDir, "session-h2.jsonl");
      const outcome2 = await runAgent(opts, instance, checkout, second, planned.seed, {
        prompt: graded.feedback,
        continueFrom: journalPath,
      });
      const patch2 = await extractPatch(checkout, instance.baseCommit).catch(() => "");
      const graded2 = await gradeRow(opts.grader, request(patch2));
      actions.push(...actionsOf(second));
      feedback = {
        status: outcome2.status === "completed" ? "completed" : outcome2.status,
        ...(outcome2.endReason !== undefined ? { agentEndReason: outcome2.endReason } : {}),
        ...(scored(graded2.official) ? { grade: scored(graded2.official)! } : {}),
        ...(scored(graded2.strict) ? { gradeStrict: scored(graded2.strict)! } : {}),
        wallMs: outcome2.wallMs,
      };
      if (evidence) {
        writeFileSync(join(evidence, "feedback.txt"), graded.feedback);
        writeFileSync(join(evidence, "patch-h2.diff"), patch2);
        writeFileSync(join(evidence, "grade-h2.json"), JSON.stringify(graded2, null, 2) + "\n");
        keep(evidence, "session-h2.jsonl", second);
        keep(evidence, "agent-h2.log", `${second}.agent.log`);
      }
    }

    const violations = networkViolations(actions);
    const row: CompletedRun = {
      ...planned,
      status: outcome.status === "completed" ? "completed" : outcome.status,
      ...(outcome.endReason !== undefined ? { agentEndReason: outcome.endReason } : {}),
      grade: scored(graded.official)!,
      ...(scored(graded.strict) ? { gradeStrict: scored(graded.strict)! } : {}),
      wallMs: outcome.wallMs,
      ...(feedback ? { feedback } : {}),
      network: { rule: NETWORK_RULE, violations },
      ...(violations.length > 0 ? { invalid: `network rule ${NETWORK_RULE}: ${violations[0]!.reason}` } : {}),
      ...(evidence ? { artifacts: evidence } : {}),
    };
    if (evidence) writeFileSync(join(evidence, "row.json"), JSON.stringify(row, null, 2) + "\n");
    return row;
  } finally {
    // Kept means kept: the journal says what the agent decided, the checkout
    // says what it actually left behind, and a failure is usually only
    // legible with both. Removing the worktree here while keeping its parent
    // directory produced a row you could read the reasoning of and not the
    // code it was reasoning about.
    if (!opts.keepArtifacts) {
      await withWorktreeLock(() =>
        exec("git", ["worktree", "remove", "--force", checkout], { cwd: instance.repo }),
      ).catch(() => undefined);
      rmSync(rowDir, { recursive: true, force: true });
    }
  }
}

/**
 * One worktree bookkeeping operation at a time, process-wide.
 *
 * Not per repository: the map that would key it is one more thing to get wrong,
 * and these calls are short enough that a global queue is invisible next to a
 * row that spends minutes in the model.
 */
let worktreeQueue: Promise<unknown> = Promise.resolve();
function withWorktreeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = worktreeQueue.then(fn, fn);
  // Keep the chain alive whether or not this link rejected; the caller still
  // sees the rejection through `run`.
  worktreeQueue = run.catch(() => undefined);
  return run;
}

/**
 * Every planned row, in order, with results streamed as they land.
 *
 * Sequential on purpose. The agent under test drives one model server, and two
 * rows in flight share its queue — which turns a per-row wall-clock budget into
 * a measurement of how many rows happened to be running at the time.
 */
export async function runAll(
  opts: RunnerOptions,
  planned: readonly PlannedRun[],
): Promise<CompletedRun[]> {
  const byId = new Map(opts.instances.map((i) => [i.id, i]));
  // Indexed rather than appended: workers finish out of order, and the result
  // order is part of what makes two campaigns comparable.
  const out: CompletedRun[] = new Array(planned.length);
  mkdirSync(opts.workRoot, { recursive: true });

  const width = Math.max(1, Math.floor(opts.concurrency ?? 1));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= planned.length) return;
      const row = planned[i]!;
      const instance = byId.get(row.instanceId);
      if (!instance) {
        // The manifest promised a row for an instance the suite does not have.
        // It stays in the plan and scores zero rather than vanishing.
        const missing: CompletedRun = { ...row, status: "missing" };
        out[i] = missing;
        opts.onRow?.(missing);
        continue;
      }
      const done = await runRow(opts, row, instance);
      out[i] = done;
      opts.onRow?.(done);
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, planned.length) }, worker));
  return out;
}
