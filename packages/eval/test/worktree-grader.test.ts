/**
 * The grader, against a real repository with a real failing test.
 *
 * Nothing here is mocked. A grader is the one component where a convincing
 * stand-in is worse than none: the whole point is that it runs code the agent
 * cannot influence, and a test double runs whatever it was told to.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calibrate, calibrationProblems } from "../src/grader.js";
import { WorktreeGrader } from "../src/worktree-grader.js";

let repo: string;
let baseCommit: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

/**
 * A repository in the shape every instance of this kind has: a bug, and a test
 * that fails because of it.
 */
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "motif-grader-repo-"));
  git(["init", "-q", "-b", "main"]);
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(
    join(repo, "tests", "test_calc.py"),
    "import sys\nsys.path.insert(0, '.')\nfrom calc import add\n\n" +
      "def check():\n    assert add(2, 3) == 5, 'add is wrong'\n\ncheck()\nprint('ok')\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "bug: add subtracts"]);
  baseCommit = git(["rev-parse", "HEAD"]).trim();
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function grader(): WorktreeGrader {
  return new WorktreeGrader({
    repo,
    testCommand: ["python3", "tests/test_calc.py"],
    testPaths: ["tests/test_calc.py"],
  });
}

/**
 * A patch the way an agent's actually arrives: from `git diff` over edits made
 * in a checkout, not hand-written with hunk offsets that have to be right.
 */
function patchFor(edits: Record<string, string>): string {
  const tree = mkdtempSync(join(tmpdir(), "motif-grader-edit-"));
  try {
    git(["worktree", "add", "--detach", "-q", "-f", tree, baseCommit]);
    for (const [file, content] of Object.entries(edits)) {
      writeFileSync(join(tree, file), content);
    }
    return git(["diff"], tree);
  } finally {
    git(["worktree", "remove", "--force", tree]);
    rmSync(tree, { recursive: true, force: true });
  }
}

const ADD_FIXED = "def add(a, b):\n    return a + b\n";
const ADD_STILL_WRONG = "def add(a, b):\n    return a * b\n";
const TEST_VACUOUS =
  "import sys\nsys.path.insert(0, '.')\nfrom calc import add\n\n" +
  "def check():\n    assert True\n\ncheck()\nprint('ok')\n";
const TEST_WITH_A_NOTE =
  "import sys\nsys.path.insert(0, '.')\nfrom calc import add\n\n" +
  "def check():\n    assert add(2, 3) == 5, 'add is wrong'\n\ncheck()\nprint('ok')\n" +
  "# a note the agent added\n";

describe("worktree grader", () => {
  it("passes a patch that actually fixes the bug", async () => {
    const r = await grader().grade({
      instanceId: "calc-1",
      patch: patchFor({ "calc.py": ADD_FIXED }),
      baseCommit,
      timeoutSeconds: 60,
    });
    expect(r.status).toBe("passed");
    expect(r.score).toBe(1);
  });

  it("fails a patch that changes the wrong thing", async () => {
    const r = await grader().grade({
      instanceId: "calc-1",
      patch: patchFor({ "calc.py": ADD_STILL_WRONG }),
      baseCommit,
      timeoutSeconds: 60,
    });
    expect(r.status).toBe("failed");
  });

  it("gains nothing from rewriting the test it is graded on", async () => {
    // The failure mode the separation exists for. This patch makes the visible
    // test vacuous and leaves the bug in place.
    const r = await grader().grade({
      instanceId: "calc-1",
      patch: patchFor({ "tests/test_calc.py": TEST_VACUOUS }),
      baseCommit,
      timeoutSeconds: 60,
    });
    expect(r.status).toBe("failed");
  });

  it("still passes a real fix that also touches the tests", async () => {
    // Restoring rather than rejecting matters here: a grader that refuses any
    // patch touching tests also refuses the legitimate case.
    const r = await grader().grade({
      instanceId: "calc-1",
      patch: patchFor({ "calc.py": ADD_FIXED, "tests/test_calc.py": TEST_WITH_A_NOTE }),
      baseCommit,
      timeoutSeconds: 60,
    });
    expect(r.status).toBe("passed");
  });

  it("reports an unknown base commit as infrastructure, not as a failure", async () => {
    // Scoring this as a failed row would penalise the candidate for the
    // grader's own misconfiguration, and the number would look plausible.
    const r = await grader().grade({
      instanceId: "calc-1",
      patch: patchFor({ "calc.py": ADD_FIXED }),
      baseCommit: "0".repeat(40),
      timeoutSeconds: 60,
    });
    expect(r.status).toBe("infra_error");
    expect(r.score).toBe(0);
  });

  it("counts a test run that never finishes as a failure", async () => {
    // An agent can write an infinite loop. Calling that a grader error would
    // take the row out of the denominator, which is the direction that
    // flatters the candidate.
    const spinner = new WorktreeGrader({
      repo,
      testCommand: ["python3", "-c", "while True: pass"],
      testPaths: [],
    });
    const r = await spinner.grade({
      instanceId: "calc-1",
      patch: patchFor({ "calc.py": ADD_FIXED }),
      baseCommit,
      timeoutSeconds: 2,
    });
    expect(r.status).toBe("failed");
  });

  it("leaves no worktree behind", async () => {
    const patch = patchFor({ "calc.py": ADD_FIXED });
    await grader().grade({ instanceId: "calc-1", patch, baseCommit, timeoutSeconds: 60 });
    const listed = git(["worktree", "list"]).trim().split("\n");
    expect(listed).toHaveLength(1);
  });

  it("passes the calibration fixtures every adapter must pass", async () => {
    const outcomes = await calibrate(grader(), {
      baseCommit,
      instanceId: "calc-1",
      timeoutSeconds: 60,
    });
    expect(calibrationProblems(outcomes)).toEqual([]);
  });
});
