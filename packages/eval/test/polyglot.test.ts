/**
 * The polyglot suite as protocol v2 builds it: which files are tests,
 * solutions and sources; how each track switches its tests on under the
 * official and the strict rules; the task text; and what a track H or V
 * directory contains.
 *
 * Every way of getting these wrong is quiet. Miss a test file and track H
 * leaves the answer in the agent's directory; call a test a solution and the
 * grader keeps the agent's copy of it; switch on a test the official rules
 * leave off and the primary number stops meaning what the leaderboard's does.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  LANGUAGES,
  buildPolyglotSuite,
  gradedTests,
  instancesSha256,
  officialAddendum,
  officialTaskText,
  officialTestFailures,
  referenceSolution,
  solutionFiles,
  trackLine,
  type ExerciseConfig,
} from "../src/polyglot.js";

const config = (c: Partial<ExerciseConfig>): ExerciseConfig => ({ solution: [], test: [], editor: [], example: [], ...c });

describe("which files are which", () => {
  it("takes the solution files from the config, as Aider lists them", () => {
    // Every Rust config lists Cargo.toml as a solution file; Aider never lets
    // the model edit it, and neither does grading.
    expect(solutionFiles(config({ solution: ["src/lib.rs", "Cargo.toml"] }), ["src/lib.rs", "Cargo.toml", "tests/a.rs"])).toEqual(["src/lib.rs"]);
    // The header too: header-only C++ exercises declare the type there.
    expect(solutionFiles(config({ solution: ["bob.cpp", "bob.h"] }), ["bob.cpp", "bob.h", "bob_test.cpp", "CMakeLists.txt"])).toEqual(["bob.cpp", "bob.h"]);
    // A listed file the exercise does not ship is not offered.
    expect(solutionFiles(config({ solution: ["gone.py", "here.py"] }), ["here.py"])).toEqual(["here.py"]);
  });

  it("grades what the config lists and what the runner would pick up, not vendored code", () => {
    const py = LANGUAGES["python"]!;
    // paasio's helper is only a test because the config says so.
    expect(gradedTests(py, config({ test: ["paasio_test.py", "test_utils.py"] }), ["paasio.py", "paasio_test.py", "test_utils.py"])).toEqual(["paasio_test.py", "test_utils.py"]);
    const java = LANGUAGES["java"]!;
    // satellite ships a TreeTest.java its config does not list.
    expect(
      gradedTests(java, config({ test: ["src/test/java/SatelliteTest.java"] }), [
        "src/main/java/Satellite.java",
        "src/test/java/SatelliteTest.java",
        "src/test/java/TreeTest.java",
        "build.gradle",
      ]),
    ).toEqual(["src/test/java/SatelliteTest.java", "src/test/java/TreeTest.java"]);
    const cpp = LANGUAGES["cpp"]!;
    expect(gradedTests(cpp, config({ test: ["bob_test.cpp"] }), ["bob.cpp", "bob_test.cpp", "test/catch.hpp", "test/tests-main.cpp"])).toEqual(["bob_test.cpp"]);
    const go = LANGUAGES["go"]!;
    // The case table and the build-tagged bonus are test material too.
    expect(gradedTests(go, config({ test: ["two_bucket_test.go"] }), ["two_bucket.go", "two_bucket_test.go", "cases_test.go", "bonus_test.go", "go.mod"])).toEqual([
      "bonus_test.go",
      "cases_test.go",
      "two_bucket_test.go",
    ]);
  });

  it("keeps an agent's new source and nothing that would change how the tests run", () => {
    const keep = (language: string, paths: string[]) => paths.filter((p) => LANGUAGES[language]!.isSource(p));
    expect(keep("python", ["helper.py", "test_mine.py", "mine_test.py", "conftest.py", "setup.py", "pytest.ini", "__pycache__/x.py"])).toEqual(["helper.py"]);
    expect(keep("javascript", ["util.js", "mine.spec.js", "mine.test.js", "jest.config.js", "__tests__/a.js", "node_modules/x.js"])).toEqual(["util.js"]);
    expect(keep("go", ["helper.go", "mine_test.go", "go.sum"])).toEqual(["helper.go"]);
    expect(keep("rust", ["src/helper.rs", "build.rs", "tests/mine.rs", "examples/a.rs", "Cargo.lock"])).toEqual(["src/helper.rs"]);
    expect(keep("cpp", ["util.h", "util.cpp", "mine_test.cpp", "test/extra.hpp", "build/x.cpp", "CMakeFiles/a.cpp", "CMakeCache.txt"])).toEqual(["util.h", "util.cpp"]);
    expect(keep("java", ["src/main/java/Frame.java", "src/test/java/MineTest.java", "build.gradle"])).toEqual(["src/main/java/Frame.java"]);
  });

  it("maps every reference file to where it belongs, Rust's crate manifest included", () => {
    expect(LANGUAGES["rust"]!.referenceTarget!("example.rs", "poker")).toBe("src/lib.rs");
    expect(LANGUAGES["rust"]!.referenceTarget!("Cargo-example.toml", "poker")).toBe("Cargo.toml");
    expect(LANGUAGES["cpp"]!.referenceTarget!("example.h", "all-your-base")).toBe("all_your_base.h");
    expect(LANGUAGES["java"]!.referenceTarget!("src/reference/java/Frame.java", "bowling")).toBe("src/main/java/Frame.java");
    expect(LANGUAGES["javascript"]!.referenceTarget!("proof.ci.js", "two-bucket")).toBe("two-bucket.js");
    expect(LANGUAGES["python"]!.referenceTarget!("config.json", "x")).toBeUndefined();
  });
});

describe("switching the tests on", () => {
  it("javascript: the official rules switch on xtest only, the strict ones xit and xdescribe too", () => {
    const js = LANGUAGES["javascript"]!;
    const text = "test('a', f);\n  xtest('b', g);\nxit('c', h); xdescribe('d', k);";
    expect(js.enable!("grep.spec.js", text, "official", true)).toBe("test('a', f);\n  test('b', g);\nxit('c', h); xdescribe('d', k);");
    expect(js.enable!("grep.spec.js", text, "strict", true)).toBe("test('a', f);\n  test('b', g);\nit('c', h); describe('d', k);");
    // npm-test.sh's sed touches `*.spec.js` in the exercise root and nothing else.
    expect(js.enable!("lib/other.js", text, "strict", false)).toBe(text);
  });

  it("java: the official rules remove @Disabled(...) from the listed tests only", () => {
    const java = LANGUAGES["java"]!;
    const text = '  @Test\n  @Disabled("Remove to run test")\n  void a() {}\n  @Test\n  @Disabled\n  void b() {}\n';
    // The bare annotation stays under the official rules, as in java/forth.
    expect(java.enable!("src/test/java/T.java", text, "official", true)).toBe("  @Test\n    void a() {}\n  @Test\n  @Disabled\n  void b() {}\n");
    expect(java.enable!("src/test/java/T.java", text, "strict", true)).toBe("  @Test\n    void a() {}\n  @Test\n  void b() {}\n");
    // An unlisted file, like satellite's TreeTest.java, only under the strict rules.
    expect(java.enable!("src/test/java/TreeTest.java", text, "official", false)).toBe(text);
    expect(java.enable!("src/test/java/TreeTest.java", text, "strict", false)).toBe("  @Test\n    void a() {}\n  @Test\n  void b() {}\n");
    // Where the official rule already covers a file, the strict one agrees byte for byte.
    const covered = '  @Test\n  @Disabled("Remove to run test")\n  void a() {}\n';
    expect(java.enable!("src/test/java/T.java", covered, "strict", true)).toBe(java.enable!("src/test/java/T.java", covered, "official", true));
  });

  it("rust and c++ switch everything on in the command, and track V in the file", () => {
    expect(LANGUAGES["rust"]!.command).toEqual(["cargo", "test", "--", "--include-ignored"]);
    expect(LANGUAGES["cpp"]!.command.join(" ")).toContain('cmake -DEXERCISM_RUN_ALL_TESTS=1 -G "Unix Makefiles" ..');
    expect(LANGUAGES["rust"]!.reveal!("tests/a.rs", "#[test]\n#[ignore]\nfn a() {}\n    #[ignore]\nfn b() {}\n")).toBe("#[test]\nfn a() {}\nfn b() {}\n");
    expect(LANGUAGES["cpp"]!.reveal!("bob_test.cpp", '#include "bob.h"\n')).toBe('#define EXERCISM_RUN_ALL_TESTS\n#include "bob.h"\n');
  });

  it("uses each track's official test command", () => {
    expect(LANGUAGES["python"]!.command).toEqual(["python3", "-m", "pytest"]);
    expect(LANGUAGES["go"]!.command).toEqual(["go", "test", "./..."]);
    expect(LANGUAGES["javascript"]!.command).toEqual(["npm", "run", "test"]);
    expect(LANGUAGES["java"]!.command).toEqual(["./gradlew", "test"]);
  });
});

describe("the task text", () => {
  it("is Aider's: introduction, instructions and append as they are, then the addendum", () => {
    const dir = mkdtempSync(join(tmpdir(), "motif-task-"));
    mkdirSync(join(dir, ".docs"));
    writeFileSync(join(dir, ".docs", "introduction.md"), "Intro.\n");
    writeFileSync(join(dir, ".docs", "instructions.md"), "# Instructions\n\nDo it.\n");
    writeFileSync(join(dir, ".docs", "instructions.append.md"), "Also this.\n");
    writeFileSync(join(dir, ".docs", "hints.md"), "Not part of it.\n");
    expect(officialTaskText(dir, ["src/main/java/Satellite.java"])).toBe(
      "Intro.\n# Instructions\n\nDo it.\nAlso this.\n" +
        "\n####\n\nUse the above instructions to modify the supplied files: Satellite.java\n" +
        "Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.\n" +
        "Only use standard libraries, don't suggest installing any packages.\n",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the solution files the way Aider does, and closes with the track's line", () => {
    expect(officialAddendum("bob.cpp bob.h")).toContain("modify the supplied files: bob.cpp bob.h\n");
    expect(officialTestFailures("bob.cpp")).toBe(
      "\n####\n\nSee the testing errors above.\nThe tests are correct, don't try and change them.\nFix the code in bob.cpp to resolve the errors.\n",
    );
    expect(trackLine("H", ["x_test.py"])).toBe(
      "The unit tests used for grading are not in this directory. You may write and run your own tests; test files you add are removed before grading.\n",
    );
    expect(trackLine("V", ["a.spec.js", "b.spec.js"])).toBe(
      "The tests are in `a.spec.js`, `b.spec.js` — run them to check your work. Do not modify them: they are restored from a pristine copy before grading.\n",
    );
  });
});

describe("building a suite", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  /** A two-language benchmark checkout in miniature. */
  function checkout(): string {
    const root = mkdtempSync(join(tmpdir(), "motif-polyglot-"));
    made.push(root);
    const put = (path: string, text: string, exec = false): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
      if (exec) chmodSync(join(root, path), 0o755);
    };
    const cpp = "cpp/exercises/practice/bank-account";
    put(`${cpp}/.docs/instructions.md`, "# Bank\n");
    put(`${cpp}/.meta/config.json`, JSON.stringify({ files: { solution: ["bank_account.cpp", "bank_account.h"], test: ["bank_account_test.cpp"], example: [".meta/example.cpp", ".meta/example.h"] } }));
    put(`${cpp}/.meta/example.cpp`, "// answer\n");
    put(`${cpp}/.meta/example.h`, "// answer\n");
    put(`${cpp}/.approaches/locks/snippet.txt`, "std::mutex m; // a worked solution\n");
    put(`${cpp}/bank_account.cpp`, "// stub\n");
    put(`${cpp}/bank_account.h`, "// stub\n");
    put(`${cpp}/bank_account_test.cpp`, "TEST_CASE(\"a\") {}\n#if defined(EXERCISM_RUN_ALL_TESTS)\n#endif\n");
    put(`${cpp}/CMakeLists.txt`, "project(x)\n");
    put(`${cpp}/test/catch.hpp`, "// catch\n");
    put(`${cpp}/test/tests-main.cpp`, "// main\n");
    const js = "javascript/exercises/practice/grep";
    put(`${js}/.docs/instructions.md`, "# Grep\n");
    put(`${js}/.docs/introduction.md`, "Intro\n");
    put(`${js}/.meta/config.json`, JSON.stringify({ files: { solution: ["grep.js"], test: ["grep.spec.js"], example: [".meta/proof.ci.js"] } }));
    put(`${js}/.meta/proof.ci.js`, "// answer\n");
    put(`${js}/grep.js`, "// stub\n");
    put(`${js}/grep.spec.js`, "test('a', f);\nxtest('b', g);\nxit('c', h);\n");
    put(`${js}/data/iliad.txt`, "text\n");
    put(`${js}/package.json`, "{}\n");
    put(`${js}/run.sh`, "#!/bin/sh\n", true);
    return root;
  }

  it("track H: the graded tests and every worked solution stay out, vendored code stays in", () => {
    const root = checkout();
    const out = mkdtempSync(join(tmpdir(), "motif-suite-"));
    made.push(out);
    const [cpp, js] = buildPolyglotSuite({ root, languages: ["cpp", "javascript"], repoRoot: out });
    const tracked = (repo: string) =>
      execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
    expect(tracked(cpp!.repo)).toEqual([".docs/instructions.md", ".gitignore", "CMakeLists.txt", "bank_account.cpp", "bank_account.h", "test/catch.hpp", "test/tests-main.cpp"]);
    expect(tracked(js!.repo)).toEqual([".docs/instructions.md", ".docs/introduction.md", ".gitignore", "data/iliad.txt", "grep.js", "package.json", "run.sh"]);
    // Not in any commit either: the repository has exactly one.
    expect(execFileSync("git", ["rev-list", "--all", "--count"], { cwd: cpp!.repo, encoding: "utf8" }).trim()).toBe("1");
    expect(cpp!.workdirName).toBe("bank-account");
    expect(cpp!.testFiles).toEqual(["bank_account_test.cpp"]);
    expect(cpp!.track).toBe("H");
    expect(js!.prompt).toBe(
      "Intro\n# Grep\n" + officialAddendum("grep.js") + trackLine("H", ["grep.spec.js"]),
    );
    // Executable bits survive.
    expect(execFileSync("git", ["ls-files", "-s", "run.sh"], { cwd: js!.repo, encoding: "utf8" })).toMatch(/^100755/);
  });

  it("track V: the tests are there with every skip switched off", () => {
    const root = checkout();
    const out = mkdtempSync(join(tmpdir(), "motif-suite-"));
    made.push(out);
    const [cpp, js] = buildPolyglotSuite({ root, languages: ["cpp", "javascript"], repoRoot: out, track: "V" });
    const show = (repo: string, path: string) => execFileSync("git", ["show", `HEAD:${path}`], { cwd: repo, encoding: "utf8" });
    expect(show(cpp!.repo, "bank_account_test.cpp").startsWith("#define EXERCISM_RUN_ALL_TESTS\n")).toBe(true);
    expect(show(js!.repo, "grep.spec.js")).toBe("test('a', f);\ntest('b', g);\nit('c', h);\n");
    expect(js!.prompt.endsWith(trackLine("V", ["grep.spec.js"]))).toBe(true);
    expect(existsSync(join(cpp!.repo, ".approaches"))).toBe(false);
  });

  it("builds the same base commits twice and fingerprints them like make_manifest.py", () => {
    const root = checkout();
    const out = mkdtempSync(join(tmpdir(), "motif-suite-"));
    made.push(out);
    const env = { GIT_AUTHOR_DATE: process.env["GIT_AUTHOR_DATE"], GIT_COMMITTER_DATE: process.env["GIT_COMMITTER_DATE"] };
    process.env["GIT_AUTHOR_DATE"] = "2024-12-22T00:00:00+0000";
    process.env["GIT_COMMITTER_DATE"] = "2024-12-22T00:00:00+0000";
    try {
      const a = buildPolyglotSuite({ root, languages: ["cpp", "javascript"], repoRoot: out });
      const b = buildPolyglotSuite({ root, languages: ["cpp", "javascript"], repoRoot: out });
      expect(a.map((i) => i.baseCommit)).toEqual(b.map((i) => i.baseCommit));
      const rows = a.map((i) => ({ id: i.id, baseCommit: i.baseCommit, language: i.language }));
      // What toolkit/campaign/make_manifest.py writes for the same list.
      const python = execFileSync(
        "python3",
        ["-c", "import json,sys,hashlib; r=sorted(json.load(sys.stdin), key=lambda x: x['id']); print(hashlib.sha256(json.dumps(r, sort_keys=True).encode()).hexdigest())"],
        { input: JSON.stringify(rows), encoding: "utf8" },
      ).trim();
      expect(instancesSha256(rows)).toBe(python);
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("reads the reference, Rust's crate manifest included, for verify only", () => {
    const root = checkout();
    const out = mkdtempSync(join(tmpdir(), "motif-suite-"));
    made.push(out);
    const [cpp] = buildPolyglotSuite({ root, languages: ["cpp"], repoRoot: out });
    expect(referenceSolution(cpp!)).toEqual({ "bank_account.cpp": "// answer\n", "bank_account.h": "// answer\n" });
    expect(readFileSync(join(root, "cpp/exercises/practice/bank-account/.meta/example.cpp"), "utf8")).toBe("// answer\n");
  });
});
