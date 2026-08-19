/**
 * Grading, from outside the agent's reach.
 *
 * The separation is the whole point. An agent that can see the tests it will be
 * graded on can pass by editing them, and an agent that grades itself is being
 * asked to report on its own performance. Neither is hypothetical: "make the
 * suite green" is a reasonable reading of most tasks, and deleting a failing
 * test is the shortest path to it.
 *
 * So: the agent runs in a disposable environment built from a pristine base,
 * with no evaluator assets mounted. When it stops, its work is extracted as a
 * patch and hashed. A separate trusted environment applies that patch to its
 * own pristine copy and runs the pinned evaluator. The agent never touches the
 * second environment and never learns what is in it.
 *
 * This module holds the contract and the calibration that proves an adapter
 * implements it. The container plumbing is deliberately out of scope — a
 * benchmark harness that cannot state what its grader guarantees has a bigger
 * problem than which runtime it uses.
 */

import { createHash } from "node:crypto";
import type { GraderResult } from "@motifcode/journal";

export interface GradeRequest {
  instanceId: string;
  /** The agent's work, as a patch against the pristine base. */
  patch: string;
  /** Commit the patch applies to. Mismatched bases are a grader error. */
  baseCommit: string;
  timeoutSeconds: number;
}

export interface GraderAdapter {
  readonly name: string;
  readonly version: string;
  readonly imageDigest?: string;
  grade(request: GradeRequest): Promise<GraderResult>;
}

export function patchHash(patch: string): string {
  return createHash("sha256").update(patch, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* calibration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Fixtures every adapter must pass before it grades anything real.
 *
 * An adapter that returns "passed" for everything looks exactly like a working
 * one until the day the numbers matter. These four cases are the cheapest way
 * to tell them apart, and they are run before the campaign rather than after.
 */
export interface CalibrationFixture {
  name: string;
  patch: string;
  expect: GraderResult["status"];
  why: string;
}

export const CALIBRATION_FIXTURES: readonly CalibrationFixture[] = Object.freeze([
  {
    name: "null-patch",
    patch: "",
    expect: "failed",
    why: "an agent that changed nothing has not solved anything; an adapter that passes this passes everything",
  },
  {
    name: "invalid-patch",
    patch: "this is not a diff\n",
    expect: "failed",
    why: "a patch that will not apply is a failed task, not a grader malfunction",
  },
  {
    name: "test-tampering",
    patch: "--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@\n-assert broken()\n+assert True\n",
    expect: "failed",
    why: "the trusted grader runs its own copy of the tests, so editing the visible ones changes nothing",
  },
]);

export interface CalibrationOutcome {
  fixture: string;
  expected: GraderResult["status"];
  actual: GraderResult["status"];
  ok: boolean;
  why: string;
}

export async function calibrate(
  adapter: GraderAdapter,
  opts: { baseCommit: string; instanceId: string; timeoutSeconds?: number },
): Promise<CalibrationOutcome[]> {
  const out: CalibrationOutcome[] = [];
  for (const fixture of CALIBRATION_FIXTURES) {
    const result = await adapter.grade({
      instanceId: opts.instanceId,
      patch: fixture.patch,
      baseCommit: opts.baseCommit,
      timeoutSeconds: opts.timeoutSeconds ?? 600,
    });
    out.push({
      fixture: fixture.name,
      expected: fixture.expect,
      actual: result.status,
      ok: result.status === fixture.expect,
      why: fixture.why,
    });
  }
  return out;
}

export function calibrationProblems(outcomes: readonly CalibrationOutcome[]): string[] {
  return outcomes
    .filter((o) => !o.ok)
    .map((o) => `${o.fixture}: expected ${o.expected}, got ${o.actual} — ${o.why}`);
}

/* ------------------------------------------------------------------ */
/* a grader for tests of the harness itself                           */
/* ------------------------------------------------------------------ */

/**
 * An in-process grader, for exercising the plumbing.
 *
 * Named `Toy` rather than `Mock` because the distinction matters at the call
 * site: this must never appear in a manifest that produces a reported number.
 * It applies no patch and runs nothing.
 */
export class ToyGrader implements GraderAdapter {
  readonly name = "toy";
  readonly version = "1";

  constructor(private readonly decide: (req: GradeRequest) => GraderResult["status"]) {}

  async grade(request: GradeRequest): Promise<GraderResult> {
    const startedAt = new Date().toISOString();
    const status = this.decide(request);
    return {
      status,
      score: status === "passed" ? 1 : 0,
      graderName: this.name,
      graderVersion: this.version,
      startedAt,
      finishedAt: new Date().toISOString(),
      patchSha256: patchHash(request.patch),
    };
  }
}
