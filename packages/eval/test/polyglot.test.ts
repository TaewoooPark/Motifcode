/**
 * Which files each track calls a test, a solution, and a reference.
 *
 * These three answers decide whether an instance can work at all, and every
 * way of getting them wrong is quiet. Miss a test file and the agent can edit
 * it, because only the paths named here are restored before grading. Miss a
 * solution file and the agent is told to implement in the wrong place. Map a
 * reference wrongly and `verify` reports a broken exercise when what is broken
 * is the mapping — which is exactly what happened to six Java exercises.
 */

import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../src/polyglot.js";

/** The files each track actually ships, from the checkout. */
const LAYOUTS: Record<string, { exercise: string; files: string[]; meta: string[] }> = {
  python: {
    exercise: "affine-cipher",
    files: ["affine_cipher.py", "affine_cipher_test.py", "INSTRUCTIONS.md"],
    meta: ["example.py", "template.j2", "config.json"],
  },
  javascript: {
    exercise: "transpose",
    files: ["transpose.js", "transpose.spec.js", "package.json", "babel.config.js", ".eslintrc"],
    meta: ["proof.ci.js", "config.json"],
  },
  go: {
    exercise: "alphametics",
    files: ["alphametics.go", "alphametics_test.go", "cases_test.go", "go.mod"],
    meta: ["example.go", "gen.go", "config.json"],
  },
  rust: {
    exercise: "acronym",
    files: ["src/lib.rs", "tests/acronym.rs", "Cargo.toml"],
    meta: ["example.rs", "test_template.tera", "config.json"],
  },
  cpp: {
    exercise: "all-your-base",
    files: [
      "all_your_base.cpp",
      "all_your_base.h",
      "all_your_base_test.cpp",
      "CMakeLists.txt",
      "test/catch.hpp",
      "test/tests-main.cpp",
    ],
    meta: ["example.cpp", "example.h", "config.json"],
  },
  java: {
    exercise: "bowling",
    files: [
      "src/main/java/BowlingGame.java",
      "src/test/java/BowlingGameTest.java",
      "build.gradle",
      "gradlew",
    ],
    meta: ["src/reference/java/BowlingGame.java", "src/reference/java/Frame.java", "config.json"],
  },
};

const EXPECTED: Record<string, { tests: string[]; solution: string[]; reference: Record<string, string> }> = {
  python: {
    tests: ["affine_cipher_test.py"],
    solution: ["affine_cipher.py"],
    reference: { "example.py": "affine_cipher.py" },
  },
  javascript: {
    tests: ["transpose.spec.js"],
    solution: ["transpose.js"],
    reference: { "proof.ci.js": "transpose.js" },
  },
  go: {
    // Both. `cases_test.go` holds the table the assertions read, so restoring
    // one without the other lets an agent rewrite the cases.
    tests: ["alphametics_test.go", "cases_test.go"],
    solution: ["alphametics.go"],
    reference: { "example.go": "alphametics.go" },
  },
  rust: {
    tests: ["tests/acronym.rs"],
    solution: ["src/lib.rs"],
    reference: { "example.rs": "src/lib.rs" },
  },
  cpp: {
    tests: ["all_your_base_test.cpp"],
    // The header too: header-only exercises have no `.cpp`, and an agent told
    // to edit only the source cannot declare the type the tests construct.
    solution: ["all_your_base.cpp", "all_your_base.h"],
    reference: { "example.cpp": "all_your_base.cpp", "example.h": "all_your_base.h" },
  },
  java: {
    tests: ["src/test/java/BowlingGameTest.java"],
    solution: ["src/main/java/BowlingGame.java"],
    reference: {
      "src/reference/java/BowlingGame.java": "src/main/java/BowlingGame.java",
      "src/reference/java/Frame.java": "src/main/java/Frame.java",
    },
  },
};

describe("language specs", () => {
  for (const [language, layout] of Object.entries(LAYOUTS)) {
    const spec = LANGUAGES[language]!;
    const want = EXPECTED[language]!;

    it(`${language}: picks out the graded tests`, () => {
      const found = layout.files.filter((f) => spec.isTest(f, layout.exercise)).sort();
      expect(found).toEqual([...want.tests].sort());
    });

    it(`${language}: picks out the files the agent edits`, () => {
      const found = layout.files.filter((f) => spec.isSolution(f, layout.exercise)).sort();
      expect(found).toEqual([...want.solution].sort());
    });

    it(`${language}: never calls a test file a solution`, () => {
      // The two sets overlapping would mean the grader restores a file it also
      // told the agent to write, and every run scores zero.
      for (const file of layout.files) {
        expect(spec.isTest(file, layout.exercise) && spec.isSolution(file, layout.exercise)).toBe(false);
      }
    });

    it(`${language}: maps every reference file to where it belongs`, () => {
      const found: Record<string, string> = {};
      for (const file of layout.meta) {
        const target = spec.referenceTarget?.(file, layout.exercise);
        if (target) found[file] = target;
      }
      expect(found).toEqual(want.reference);
    });

    it(`${language}: does not mistake config for a reference solution`, () => {
      expect(spec.referenceTarget?.("config.json", layout.exercise)).toBeUndefined();
      expect(spec.referenceTarget?.("tests.toml", layout.exercise)).toBeUndefined();
    });

    it(`${language}: names the graded tests in its test command`, () => {
      // The command has to mention what it grades, or `testPaths` and the run
      // are describing different files.
      const command = spec.testCommand(want.tests, layout.exercise).join(" ");
      const wholeSuite = ["go", "rust", "java"].includes(language);
      if (!wholeSuite) {
        for (const test of want.tests) expect(command).toContain(test);
      }
    });
  }

  it("java maps a second reference file the stub does not have", () => {
    // `bowling` ships `Frame.java` beside `BowlingGame.java`. Missing it left
    // the reference a partial solution that would not compile, which read as a
    // broken exercise rather than a broken mapping.
    const spec = LANGUAGES["java"]!;
    expect(spec.referenceTarget?.("src/reference/java/Frame.java", "bowling")).toBe(
      "src/main/java/Frame.java",
    );
  });

  it("dashes become underscores where the track expects it", () => {
    expect(LANGUAGES["python"]!.isSolution("all_your_base.py", "all-your-base")).toBe(true);
    expect(LANGUAGES["python"]!.isSolution("all-your-base.py", "all-your-base")).toBe(false);
    // JavaScript keeps the dash.
    expect(LANGUAGES["javascript"]!.isSolution("all-your-base.js", "all-your-base")).toBe(true);
  });
});
