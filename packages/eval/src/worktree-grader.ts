/**
 * A grader built from git worktrees rather than containers.
 *
 * `grader.ts` states what a grader must guarantee and deliberately says nothing
 * about how: the agent works in a disposable environment with no evaluator
 * assets in it, its work leaves as a patch, and a separate pristine copy
 * applies that patch and runs the pinned tests. Containers are the usual way to
 * get that. They are not the only way, and on a machine where Docker needs root
 * they are not an available one.
 *
 * A worktree gives the same three properties. `git worktree add --detach` is a
 * fresh checkout of a pinned commit that shares object storage and costs a
 * checkout rather than an image pull; the agent never has a path to it; and it
 * is removed afterwards, so nothing carries between instances.
 *
 * What a worktree does *not* give is filesystem isolation from the rest of the
 * machine — a test that writes to `$HOME` still writes to `$HOME`. That is what
 * `sandbox.ts` is for, and the grader runs its command under it. The gap that
 * remains is real and worth naming: a container also isolates the installed
 * toolchain, so two runs of this grader on machines with different Python
 * versions are not comparable, and the manifest's `serving.hardware` and
 * `environment` fields are the only place that shows up.
 *
 * The tampering defence is the part that has to be exactly right. An agent that
 * edits the tests it is graded on must gain nothing, so after the patch is
 * applied every test path is restored from the pinned commit. Not "detect and
 * reject" — restore. A grader that rejects a patch touching tests also rejects
 * the legitimate case where a fix needs a new test, and it teaches the next
 * person to write a patch that edits tests in a way the detector misses.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraderResult } from "@motifcode/journal";
import { patchHash, type GradeRequest, type GraderAdapter } from "./grader.js";

export interface WorktreeGraderOptions {
  /** A clone the agent has never had access to. Never the agent's checkout. */
  repo: string;
  /**
   * The command that decides the outcome. Exit zero is a pass.
   *
   * Pinned per instance by the suite, not chosen here: "run the tests" is not
   * a specification, and `pytest` with no arguments grades a different thing on
   * every repository.
   */
  testCommand: string[];
  /**
   * Paths restored from the base commit after the patch applies — the tests the
   * grade is read from. Restoring rather than rejecting; see the header.
   */
  testPaths: string[];
  /** Run before the tests, e.g. installing the package under test. */
  setupCommand?: string[];
  /** Wraps a command so it cannot write outside the worktree. */
  sandbox?: (command: string[], writableDir: string) => string[];
  env?: Record<string, string>;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(
  command: string[],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // The group: a test runner that spawned a server leaves the server
      // running if only the runner is signalled, and the next instance then
      // fails on a port that is mysteriously in use.
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export class WorktreeGrader implements GraderAdapter {
  readonly name = "worktree";
  readonly version = "1";

  constructor(private readonly opts: WorktreeGraderOptions) {}

  async grade(request: GradeRequest): Promise<GraderResult> {
    const startedAt = new Date().toISOString();
    const patchSha256 = patchHash(request.patch);
    const finish = (
      status: GraderResult["status"],
      extra: Partial<GraderResult> = {},
    ): GraderResult => ({
      status,
      score: status === "passed" ? 1 : 0,
      graderName: this.name,
      graderVersion: this.version,
      startedAt,
      finishedAt: new Date().toISOString(),
      patchSha256,
      ...extra,
    });

    // An empty patch is a failed task, decided before any setup. Cheap, and it
    // keeps the null-patch calibration honest rather than dependent on the
    // repository's tests happening to fail at base.
    if (request.patch.trim() === "") {
      return finish("failed", { exitCode: undefined });
    }

    const timeoutMs = Math.max(1, request.timeoutSeconds) * 1000;
    const root = mkdtempSync(join(tmpdir(), "motif-grade-"));
    const tree = join(root, "work");
    const patchFile = join(root, "candidate.patch");

    try {
      const added = await run(
        ["git", "worktree", "add", "--detach", "-f", tree, request.baseCommit],
        this.opts.repo,
        timeoutMs,
      );
      if (added.code !== 0) {
        // The base commit is not in this clone, or the clone is not a
        // repository. Either way the grader is broken, not the agent — and
        // scoring it as a failure would silently penalise the candidate.
        return finish("infra_error", { stderrArtifact: added.stderr.slice(0, 4000) });
      }

      writeFileSync(patchFile, request.patch, "utf8");
      const applied = await run(["git", "apply", "--whitespace=nowarn", patchFile], tree, timeoutMs);
      if (applied.code !== 0) {
        return finish("failed", {
          exitCode: applied.code ?? undefined,
          stderrArtifact: applied.stderr.slice(0, 4000),
        });
      }

      // Restore the graded tests. After this the agent's edits to them, if any,
      // are gone — which is what makes editing them pointless rather than
      // detectable.
      if (this.opts.testPaths.length > 0) {
        const restored = await run(
          ["git", "checkout", request.baseCommit, "--", ...this.opts.testPaths],
          tree,
          timeoutMs,
        );
        if (restored.code !== 0) {
          return finish("infra_error", { stderrArtifact: restored.stderr.slice(0, 4000) });
        }
      }

      const wrap = (command: string[]): string[] =>
        this.opts.sandbox ? this.opts.sandbox(command, tree) : command;

      if (this.opts.setupCommand) {
        const setup = await run(wrap(this.opts.setupCommand), tree, timeoutMs, this.opts.env);
        if (setup.code !== 0 || setup.timedOut) {
          // Setup is the grader's own job. A repository that will not install
          // says nothing about whether the agent fixed the bug.
          return finish("infra_error", {
            exitCode: setup.code ?? undefined,
            stderrArtifact: setup.stderr.slice(0, 4000),
          });
        }
      }

      const tests = await run(wrap(this.opts.testCommand), tree, timeoutMs, this.opts.env);
      if (tests.timedOut) {
        // A test run that never finished is a failure, not an infrastructure
        // problem: an agent can write an infinite loop, and calling that a
        // grader error removes the row from the denominator.
        return finish("failed", { stderrArtifact: "grader timeout" });
      }
      return finish(tests.code === 0 ? "passed" : "failed", {
        exitCode: tests.code ?? undefined,
        stdoutArtifact: tests.stdout.slice(-8000),
        stderrArtifact: tests.stderr.slice(-8000),
      });
    } catch (err) {
      return finish("infra_error", { stderrArtifact: String(err).slice(0, 4000) });
    } finally {
      // `git worktree remove` first so the repository's administrative files
      // do not keep pointing at a directory that no longer exists; the rmSync
      // is the fallback for the case where it does not.
      await run(["git", "worktree", "remove", "--force", tree], this.opts.repo, 60_000).catch(
        () => undefined,
      );
      rmSync(root, { recursive: true, force: true });
    }
  }
}
