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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionEndReason } from "@motifcode/core";
import type { JournalLine } from "@motifcode/journal";
import type { GraderAdapter } from "./grader.js";
import type { EvalManifest } from "./manifest.js";
import type { CompletedRun, PlannedRun } from "./results.js";

const exec = promisify(execFile);

export interface Instance {
  id: string;
  /** A clone the agent may write to. Never the grader's. */
  repo: string;
  baseCommit: string;
  /** What the agent is asked to do. The only task description it ever sees. */
  prompt: string;
}

export interface RunnerOptions {
  manifest: EvalManifest;
  instances: readonly Instance[];
  grader: GraderAdapter;
  /** The `motif` entry point: `["node", "/path/to/motif.js"]` or `["motif"]`. */
  agentCommand: string[];
  endpoint: string;
  model: string;
  /** Where agent checkouts and journals go. Removed per row unless kept. */
  workRoot: string;
  keepArtifacts?: boolean;
  onRow?: (row: CompletedRun) => void;
}

interface AgentOutcome {
  status: "completed" | "agent_timeout" | "agent_crash" | "model_transport_failure";
  endReason?: SessionEndReason;
  wallMs: number;
  journalPath?: string;
}

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
): Promise<AgentOutcome> {
  const { budgets, sampling, harness } = opts.manifest;
  const argv = [
    ...opts.agentCommand.slice(1),
    instance.prompt,
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
      env: { ...process.env, NO_COLOR: "1" },
    });
    let timedOut = false;
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
    }, budgets.task_wall_timeout_seconds * 1000);

    const settle = (code: number | null): void => {
      clearTimeout(timer);
      const wallMs = Date.now() - started;
      const endReason = endReasonOf(journalPath);
      // The timeout is checked first: a process the runner killed cannot have
      // written a meaningful exit code, and reading one as a crash would
      // attribute the runner's own budget to the agent.
      let status: AgentOutcome["status"];
      if (timedOut) status = "agent_timeout";
      else if (endReason === "transport_error") status = "model_transport_failure";
      else if (code !== 0 || endReason === undefined) status = "agent_crash";
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
 */
async function extractPatch(checkout: string): Promise<string> {
  await exec("git", ["add", "-A"], { cwd: checkout });
  const { stdout } = await exec("git", ["diff", "--cached", "--binary"], {
    cwd: checkout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function runRow(
  opts: RunnerOptions,
  planned: PlannedRun,
  instance: Instance,
): Promise<CompletedRun> {
  const rowDir = join(opts.workRoot, `${planned.configId}--${planned.instanceId}--${planned.seed}--${planned.replicate}`);
  const checkout = join(rowDir, "checkout");
  const journalPath = join(rowDir, "session.jsonl");
  mkdirSync(rowDir, { recursive: true });

  try {
    await exec("git", ["worktree", "add", "--detach", "-f", checkout, instance.baseCommit], {
      cwd: instance.repo,
    });
  } catch (err) {
    // The agent never started, so this is not a result about the agent.
    return { ...planned, status: "grader_infra_error", runId: undefined, agentEndReason: String(err).slice(0, 400) };
  }

  try {
    const outcome = await runAgent(opts, instance, checkout, journalPath, planned.seed);
    const patch = await extractPatch(checkout).catch(() => "");
    const grade = await opts.grader.grade({
      instanceId: instance.id,
      patch,
      baseCommit: instance.baseCommit,
      timeoutSeconds: opts.manifest.budgets.command_timeout_seconds,
    });
    // A row where the agent never finished is still graded — an agent that
    // times out having already written the fix has solved the instance, and
    // discarding its work would score the clock rather than the model.
    return {
      ...planned,
      status: outcome.status === "completed" ? "completed" : outcome.status,
      ...(outcome.endReason !== undefined ? { agentEndReason: outcome.endReason } : {}),
      grade: grade.status === "infra_error" ? { ...grade, score: 0 } : grade,
      wallMs: outcome.wallMs,
    };
  } finally {
    await exec("git", ["worktree", "remove", "--force", checkout], { cwd: instance.repo }).catch(
      () => undefined,
    );
    if (!opts.keepArtifacts) rmSync(rowDir, { recursive: true, force: true });
  }
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
  const out: CompletedRun[] = [];
  mkdirSync(opts.workRoot, { recursive: true });

  for (const row of planned) {
    const instance = byId.get(row.instanceId);
    if (!instance) {
      // The manifest promised a row for an instance the suite does not have.
      // It stays in the plan and scores zero rather than vanishing.
      const missing: CompletedRun = { ...row, status: "missing" };
      out.push(missing);
      opts.onRow?.(missing);
      continue;
    }
    const done = await runRow(opts, row, instance);
    out.push(done);
    opts.onRow?.(done);
  }
  return out;
}
