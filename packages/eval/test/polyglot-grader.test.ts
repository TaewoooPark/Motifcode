/**
 * The v2 grader: what it takes from an agent's directory, what it puts back,
 * and how the two rule sets are graded.
 *
 * A language of plain `sh` stands in for the six real ones, so this runs
 * wherever a POSIX shell does. Its runner sources every `*_test.sh` in the
 * directory — the way `pytest`, `jest ./*` and `go test ./...` pick up every
 * test there — and it switches tests on the way JavaScript does: `xtest` under
 * the official rules, `xit` as well under the strict ones. The six real tracks
 * are exercised against the benchmark checkout by `motif-suite verify`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanTestOutput, feedbackMessage, PolyglotGrader } from "../src/polyglot-grader.js";
import { LANGUAGES, buildPolyglotSuite, type PolyglotInstance, type Track } from "../src/polyglot.js";

const SHELL = {
  name: "shell",
  isTest: (p: string) => p.endsWith("_test.sh"),
  isSource: (p: string) => p.endsWith(".sh") && !p.endsWith("_test.sh"),
  command: [
    "sh",
    "-c",
    'set -e; xtest() { :; }; xit() { :; }; it() { test "$@"; }; . ./calc.sh; for t in *_test.sh; do . "./$t"; done; echo "all passed"',
  ],
  enable: (_p: string, text: string, rules: "official" | "strict") =>
    rules === "official" ? text.replace(/\bxtest /g, "test ") : text.replace(/\bxtest /g, "test ").replace(/\bxit /g, "it "),
  reveal: (_p: string, text: string) => text.replace(/\bxtest /g, "test ").replace(/\bxit /g, "it "),
  ignore: ["build/"],
};

let root: string;
const made: string[] = [];

function put(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

beforeAll(() => {
  LANGUAGES["shell"] = SHELL;
  root = mkdtempSync(join(tmpdir(), "motif-grader-bench-"));
  const ex = "shell/exercises/practice/calc";
  put(`${ex}/.docs/instructions.md`, "# Calc\n");
  put(`${ex}/.meta/config.json`, JSON.stringify({ files: { solution: ["calc.sh"], test: ["calc_test.sh"] } }));
  put(`${ex}/calc.sh`, "add() { echo $(($1 - $2)); }\n");
  // The xit check fails for any correct `add`: only the strict rules run it.
  put(`${ex}/calc_test.sh`, 'test "$(add 2 3)" = 5\nxtest "$(add 1 1)" = 2\nxit "$(add 0 0)" = 1\n');
  put(`${ex}/build.conf`, "flags=\n");
  const ok = "shell/exercises/practice/ledger";
  put(`${ok}/.docs/instructions.md`, "# Ledger: refactor\n");
  put(`${ok}/.meta/config.json`, JSON.stringify({ files: { solution: ["calc.sh"], test: ["ledger_test.sh"] } }));
  put(`${ok}/calc.sh`, "add() { echo $(($1 + $2)); }\n");
  put(`${ok}/ledger_test.sh`, 'test "$(add 2 3)" = 5\n');
});

afterAll(() => {
  delete LANGUAGES["shell"];
  for (const d of [root, ...made]) rmSync(d, { recursive: true, force: true });
});

function suite(track: Track): { calc: PolyglotInstance; ledger: PolyglotInstance } {
  const out = mkdtempSync(join(tmpdir(), "motif-grader-suite-"));
  made.push(out);
  const built = buildPolyglotSuite({ root, languages: ["shell"], repoRoot: out, track });
  return { calc: built.find((i) => i.exercise === "calc")!, ledger: built.find((i) => i.exercise === "ledger")! };
}

/** What an agent leaves behind, as the runner would extract it. */
function patchOf(instance: PolyglotInstance, files: Record<string, string | null>): string {
  const tree = mkdtempSync(join(tmpdir(), "motif-grader-agent-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", "-q", "-f", tree, instance.baseCommit], { cwd: instance.repo });
    for (const [name, content] of Object.entries(files)) {
      if (content === null) rmSync(join(tree, name), { force: true });
      else {
        mkdirSync(dirname(join(tree, name)), { recursive: true });
        writeFileSync(join(tree, name), content);
      }
    }
    execFileSync("git", ["add", "-A"], { cwd: tree });
    return execFileSync("git", ["diff", "--cached", "--binary"], { cwd: tree, encoding: "utf8" });
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: instance.repo });
    rmSync(tree, { recursive: true, force: true });
  }
}

const request = (instance: PolyglotInstance, patch: string, timeoutSeconds = 30) => ({
  instanceId: instance.id,
  patch,
  baseCommit: instance.baseCommit,
  timeoutSeconds,
});

const FIX = "add() { echo $(($1 + $2)); }\n";

describe("what goes into the graded tree", () => {
  it("takes the solution and new source, drops the agent's tests and everything else, restores the rest", async () => {
    const { calc } = suite("H");
    const patch = patchOf(calc, {
      "calc.sh": FIX,
      "util.sh": "helper() { :; }\n",
      // Picked up by the runner were it kept: it would fail the row.
      "mine_test.sh": "test 1 = 2\n",
      "notes.txt": "scratch\n",
      "build.conf": "flags=-Werror-off\n",
      "build/out.o": "binary\n",
    });
    const grades = await new PolyglotGrader(calc).gradeAll(request(calc, patch));
    expect(grades.official.result.status).toBe("passed");
    expect(grades.official.carried).toEqual(["calc.sh", "util.sh"]);
    expect(grades.official.dropped).toEqual(
      expect.arrayContaining([
        { path: "mine_test.sh", why: "test" },
        { path: "notes.txt", why: "not source" },
      ]),
    );
    expect(grades.official.restored).toEqual(["build.conf"]);
    // The hidden tests were never in the agent's directory; that is not a restoration.
    expect(grades.official.restored).not.toContain("calc_test.sh");
  });

  it("replaces a test the agent wrote under the hidden test's name with the real one", async () => {
    const { calc } = suite("H");
    const patch = patchOf(calc, { "calc_test.sh": "test 1 = 1\n" });
    const grades = await new PolyglotGrader(calc).gradeAll(request(calc, patch));
    expect(grades.official.result.status).toBe("failed");
    expect(grades.official.dropped).toEqual([{ path: "calc_test.sh", why: "test" }]);
  });

  it("grades an empty patch — the stub as shipped — rather than calling it a failure unseen", async () => {
    const { calc, ledger } = suite("H");
    expect((await new PolyglotGrader(calc).gradeAll(request(calc, ""))).official.result.status).toBe("failed");
    // A refactoring exercise's stub already passes; untouched, it counts.
    expect((await new PolyglotGrader(ledger).gradeAll(request(ledger, ""))).official.result.status).toBe("passed");
  });

  it("keeps a deleted solution file deleted", async () => {
    const { calc } = suite("H");
    const grades = await new PolyglotGrader(calc).gradeAll(request(calc, patchOf(calc, { "calc.sh": null })));
    expect(grades.official.deleted).toEqual(["calc.sh"]);
    expect(grades.official.result.status).toBe("failed");
  });

  it("fails a patch that will not apply, and a run past the limit", async () => {
    const { calc } = suite("H");
    expect((await new PolyglotGrader(calc).grade(request(calc, "not a diff\n"))).status).toBe("failed");
    const loop = patchOf(calc, { "calc.sh": "add() { while :; do :; done; }\n" });
    const grades = await new PolyglotGrader(calc).gradeAll(request(calc, loop, 1));
    expect(grades.official.result.status).toBe("failed");
    expect(grades.official.output).toBe("Tests timed out!");
  });

  it("reports a base commit the repository does not have as infrastructure", async () => {
    const { calc } = suite("H");
    const result = await new PolyglotGrader(calc).grade({ ...request(calc, ""), baseCommit: "0".repeat(40) });
    expect(result.status).toBe("infra_error");
  });
});

describe("the two rule sets", () => {
  it("grades official and strict separately when the strict rules switch on more", async () => {
    const { calc } = suite("H");
    const grades = await new PolyglotGrader(calc).gradeAll(request(calc, patchOf(calc, { "calc.sh": FIX })));
    expect(grades.shared).toBe(false);
    expect(grades.official.result.status).toBe("passed");
    expect(grades.strict.result.status).toBe("failed");
  });

  it("runs once and shares the verdict when they would switch on the same tests", async () => {
    const { ledger } = suite("H");
    const grades = await new PolyglotGrader(ledger).gradeAll(request(ledger, ""));
    expect(grades.shared).toBe(true);
    expect(grades.strict.result.status).toBe(grades.official.result.status);
  });
});

describe("track V", () => {
  it("does not count the revealed tests as the agent's changes, and restores the ones it made", async () => {
    const { calc } = suite("V");
    const untouched = await new PolyglotGrader(calc).gradeAll(request(calc, patchOf(calc, { "calc.sh": FIX })));
    expect(untouched.official.restored).toEqual([]);
    // Editing the visible test gains nothing: grading uses the original.
    const edited = await new PolyglotGrader(calc).gradeAll(
      request(calc, patchOf(calc, { "calc.sh": FIX, "calc_test.sh": "test 1 = 1\n" })),
    );
    expect(edited.official.restored).toEqual(["calc_test.sh"]);
    expect(edited.official.result.status).toBe("passed");
    expect(edited.strict.result.status).toBe("failed");
  });
});

describe("the feedback round's message", () => {
  it("is the failed run's output, cleaned, then Aider's test_failures", async () => {
    const { calc } = suite("H");
    const grades = await new PolyglotGrader(calc).gradeAll(request(calc, ""));
    const message = feedbackMessage(grades.official, calc);
    expect(message.endsWith(
      "\n####\n\nSee the testing errors above.\nThe tests are correct, don't try and change them.\nFix the code in calc.sh to resolve the errors.\n",
    )).toBe(true);
    expect(message).not.toContain(tmpdir());
  });

  it("cleans timings and the grading directory out of the output, as Aider does", () => {
    const out = cleanTestOutput("ok in 0.12s\n/tmp/x/calc/a.sh:3: fail\n", "/tmp/x/calc", "calc");
    expect(out).toBe("ok \ncalc/a.sh:3: fail\n");
  });
});
