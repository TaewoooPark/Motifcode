/**
 * Instances from the Exercism polyglot benchmark.
 *
 * A published suite rather than one written here. A benchmark whose author is
 * also the person reporting the score has a problem no amount of care in the
 * arithmetic fixes, and these exercises predate this project by years.
 *
 * Each exercise becomes its own single-commit git repository, which is what the
 * runner and the grader both want: a base commit to check out from, and no
 * history to inherit. Building them is cheap — a few files each.
 *
 * The part that has to be exactly right is `.meta/`. Every exercise ships the
 * reference solution there, and the agent has a shell. So `.meta` is excluded
 * when the repository is built, not hidden afterwards: an agent that finds a
 * file it was not meant to read has not cheated, it has been handed the answer
 * by the harness, and the resulting number would be meaningless in a way that
 * looks exactly like the model being good.
 *
 * Six language tracks, and they agree on almost nothing. Python and Go put the
 * solution beside its test; Rust splits `src/lib.rs` from `tests/`; Java nests
 * both under `src/main` and `src/test`; C++ needs a compile before there is
 * anything to run. So a language says where its files are and how its tests are
 * run, and what is common — build the repository, exclude `.meta`, restore the
 * tests before grading — is written once.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Instance } from "./runner.js";
import { WorktreeGrader, type WorktreeGraderOptions } from "./worktree-grader.js";

export interface LanguageSpec {
  name: string;
  /** Identifies the graded tests among the exercise's files, by relative path. */
  isTest: (path: string, exercise: string) => boolean;
  /** Files the agent is told to edit. */
  isSolution: (path: string, exercise: string) => boolean;
  /** Run from the repository root; exit zero is a pass. */
  testCommand: (tests: string[], exercise: string) => string[];
  /**
   * Where a file under `.meta` belongs in the exercise, or `undefined` if it is
   * not part of the reference solution. Used only by `motif-suite verify`.
   */
  referenceTarget?: (metaPath: string, exercise: string) => string | undefined;
  env?: Record<string, string>;
  /** Written to `.gitignore`, so build output never enters the agent's diff. */
  ignore?: string[];
  /** A shared dependency directory linked into every fresh checkout. */
  link?: { to: string };
}

const snake = (exercise: string): string => exercise.replace(/-/g, "_");

export const LANGUAGES: Record<string, LanguageSpec> = {
  python: {
    name: "python",
    isTest: (p) => p.endsWith("_test.py"),
    isSolution: (p, e) => p === `${snake(e)}.py`,
    // `-p no:cacheprovider` so the run leaves no `.pytest_cache` in the
    // worktree; it would show up in the agent's diff as work it did not do.
    testCommand: (tests) => ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", ...tests],
    referenceTarget: (m, e) => (m === "example.py" ? `${snake(e)}.py` : undefined),
  },

  javascript: {
    name: "javascript",
    isTest: (p) => p.endsWith(".spec.js"),
    isSolution: (p, e) => p === `${e}.js`,
    // `node_modules` is linked in rather than resolved through `NODE_PATH`:
    // jest and babel look for their plugins relative to the root they are run
    // from, and a `NODE_PATH` that works for `require` does not make jest find
    // its own transform.
    testCommand: (tests) => ["node", "node_modules/jest/bin/jest.js", "--ci", ...tests],
    referenceTarget: (m, e) => (m === "proof.ci.js" ? `${e}.js` : undefined),
    ignore: ["node_modules/"],
    link: { to: "node_modules" },
  },

  go: {
    name: "go",
    // `cases_test.go` holds the table the real test file reads, so it is graded
    // material too: restoring one without the other would let an agent rewrite
    // the cases and keep the assertions.
    isTest: (p) => p.endsWith("_test.go"),
    isSolution: (p, e) => p === `${snake(e)}.go`,
    testCommand: () => ["go", "test", "./..."],
    referenceTarget: (m, e) => (m === "example.go" ? `${snake(e)}.go` : undefined),
  },

  rust: {
    name: "rust",
    isTest: (p) => p.startsWith("tests/"),
    isSolution: (p) => p === "src/lib.rs",
    testCommand: () => ["cargo", "test", "-q"],
    referenceTarget: (m) => (m === "example.rs" ? "src/lib.rs" : undefined),
    ignore: ["target/"],
  },

  cpp: {
    name: "cpp",
    isTest: (p, e) => p === `${snake(e)}_test.cpp`,
    // The header too: several exercises are header-only, and an agent told to
    // edit only the `.cpp` cannot declare the type the tests construct.
    isSolution: (p, e) => p === `${snake(e)}.cpp` || p === `${snake(e)}.h`,
    // Compiled directly rather than through the exercise's CMakeLists, which
    // derives its target name from the *directory* name. Every checkout here
    // is called `checkout`, so CMake looks for `checkout.cpp` and fails with
    // "No SOURCES given to target". The tests and the vendored Catch2 are the
    // same either way; only the build driver differs.
    //
    // The solution `.cpp` is globbed rather than named because header-only
    // exercises do not have one, and naming a file that is not there fails the
    // compile for a reason that has nothing to do with the agent.
    // `CXX_EXTRA_INCLUDE` rather than a hard-coded path: two exercises
    // (`gigasecond`, `meetup`) include boost date-time headers, which are not
    // vendored the way Catch2 is. With them the track is 26/26; without them
    // those two fail to compile for a reason that has nothing to do with the
    // agent.
    testCommand: (tests, e) => [
      "sh",
      "-c",
      `g++ -std=c++17 -I. -Itest \${CXX_EXTRA_INCLUDE:+-I$CXX_EXTRA_INCLUDE} ` +
        `-o runner $(ls ${snake(e)}.cpp 2>/dev/null) ` +
        `${tests.join(" ")} test/tests-main.cpp && ./runner`,
    ],
    referenceTarget: (m, e) =>
      m === "example.cpp" ? `${snake(e)}.cpp` : m === "example.h" ? `${snake(e)}.h` : undefined,
    ignore: ["runner", "build/"],
  },

  java: {
    name: "java",
    isTest: (p) => p.startsWith("src/test/"),
    isSolution: (p) => p.startsWith("src/main/"),
    testCommand: () => ["./gradlew", "test", "--quiet"],
    referenceTarget: (m) =>
      m.startsWith("src/reference/java/")
        ? m.replace("src/reference/java/", "src/main/java/")
        : undefined,
    ignore: [".gradle/", "build/"],
  },
};

export interface PolyglotOptions {
  /** A checkout of Aider-AI/polyglot-benchmark. */
  root: string;
  languages: readonly string[];
  /** Where the per-exercise repositories are built. */
  repoRoot: string;
  /** Cap per language, for a dev split. Omit for all of them. */
  limit?: number;
  /** Node modules directory shared by the JavaScript exercises. */
  nodePath?: string;
}

export interface PolyglotInstance extends Instance {
  language: string;
  exercise: string;
  testFiles: string[];
  solutionFiles: string[];
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "polyglot",
      GIT_AUTHOR_EMAIL: "polyglot@example.invalid",
      GIT_COMMITTER_NAME: "polyglot",
      GIT_COMMITTER_EMAIL: "polyglot@example.invalid",
    },
  });
}

/** Every file under `root`, relative, skipping the directory names given. */
function walk(root: string, exclude: ReadonlySet<string>, base = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const full = join(base, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, exclude, full));
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out;
}

/**
 * What the agent is asked, and the only description of the task it gets.
 *
 * The instruction not to edit the tests is not a defence — the grader restores
 * them either way. It is here so that a model which obeys it is not penalised
 * relative to one that does not, which would otherwise be the difference
 * between a wasted turn and a useful one.
 */
function promptFor(instructions: string, solution: string[], tests: string[]): string {
  return [
    instructions.trim(),
    "",
    "---",
    "",
    `Implement this in \`${solution.join("`, `")}\`. The tests are in ` +
      `\`${tests.join("`, `")}\` — run them to check your work.`,
    "Do not modify the tests: they are restored from a pristine copy before grading, so changes to them are discarded.",
  ].join("\n");
}

function setupFor(spec: LanguageSpec, opts: { nodePath?: string }): string[] | undefined {
  if (spec.link && opts.nodePath) return ["ln", "-sfn", opts.nodePath, spec.link.to];
  return undefined;
}

export function buildPolyglotSuite(opts: PolyglotOptions): PolyglotInstance[] {
  const instances: PolyglotInstance[] = [];
  mkdirSync(opts.repoRoot, { recursive: true });
  const EXCLUDE = new Set([".meta", ".git"]);

  for (const language of opts.languages) {
    const spec = LANGUAGES[language];
    if (!spec) throw new Error(`no language spec for ${language}; add one to LANGUAGES`);

    const practice = join(opts.root, language, "exercises", "practice");
    if (!existsSync(practice)) {
      throw new Error(`${practice} does not exist; is ${opts.root} a polyglot-benchmark checkout?`);
    }

    // Sorted, so two people building the same suite with the same limit get
    // the same instances. Directory order is not a specification.
    const exercises = readdirSync(practice, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const exercise of exercises.slice(0, opts.limit ?? exercises.length)) {
      const source = join(practice, exercise);
      const files = walk(source, EXCLUDE);

      const testFiles = files.filter((f) => spec.isTest(f, exercise)).sort();
      const solutionFiles = files.filter((f) => spec.isSolution(f, exercise)).sort();
      if (testFiles.length === 0 || solutionFiles.length === 0) {
        // An exercise whose layout does not match is skipped rather than
        // guessed at. Guessing produces an instance that can never pass and
        // scores zero for every configuration, which looks like difficulty.
        continue;
      }

      const instructionsPath = join(source, ".docs", "instructions.md");
      if (!existsSync(instructionsPath)) continue;
      let instructions = readFileSync(instructionsPath, "utf8");
      const appendPath = join(source, ".docs", "instructions.append.md");
      if (existsSync(appendPath)) instructions += "\n\n" + readFileSync(appendPath, "utf8");

      // Rebuilt from scratch each time. Reusing a directory that is already
      // there makes the suite depend on what a previous run left behind, and
      // the second `git commit` fails with "nothing to commit" rather than
      // producing the same suite twice.
      const repo = join(opts.repoRoot, `${language}--${exercise}`);
      rmSync(repo, { recursive: true, force: true });
      mkdirSync(repo, { recursive: true });

      // Only the files an exercise legitimately exposes. `.meta` holds the
      // reference solution and is never copied — not copied and then ignored,
      // not copied and then deleted in a second commit where `git log -p`
      // would still show it.
      for (const file of files) {
        const from = join(source, file);
        const target = join(repo, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(from, target);
        // The executable bit survives the copy. A `gradlew` that cannot be run
        // turns every Java instance into an infrastructure failure.
        if (statSync(from).mode & 0o111) execFileSync("chmod", ["+x", target]);
      }
      writeFileSync(join(repo, "INSTRUCTIONS.md"), instructions, "utf8");
      if (spec.ignore) {
        // Without this, build output and linked dependencies land in
        // `git add -A`, and the agent's patch is thousands of files of
        // somebody else's code.
        writeFileSync(join(repo, ".gitignore"), spec.ignore.join("\n") + "\n", "utf8");
      }

      git(["init", "-q", "-b", "main"], repo);
      git(["add", "-A"], repo);
      git(["commit", "-qm", `${language}/${exercise}`], repo);
      const baseCommit = git(["rev-parse", "HEAD"], repo).trim();

      const setup = setupFor(spec, opts);
      instances.push({
        id: `${language}/${exercise}`,
        repo,
        baseCommit,
        prompt: promptFor(instructions, solutionFiles, testFiles),
        ...(setup ? { setupCommand: setup } : {}),
        language,
        exercise,
        testFiles,
        solutionFiles,
      });
    }
  }
  return instances;
}

/** The grader for one instance: its own test files, its own command. */
export function polyglotGrader(
  instance: PolyglotInstance,
  opts: { nodePath?: string; env?: Record<string, string> } = {},
): WorktreeGrader {
  const spec = LANGUAGES[instance.language]!;
  const options: WorktreeGraderOptions = {
    repo: instance.repo,
    testCommand: spec.testCommand(instance.testFiles, instance.exercise),
    testPaths: instance.testFiles,
    ...(spec.env || opts.env ? { env: { ...spec.env, ...opts.env } } : {}),
  };
  const setup = setupFor(spec, opts);
  if (setup) options.setupCommand = setup;
  return new WorktreeGrader(options);
}

/**
 * Does the exercise's own reference solution pass its own tests here?
 *
 * Run before a campaign, never during one. An exercise that cannot pass on this
 * machine — a missing toolchain, a test that needs the network — scores zero
 * for every configuration, and a suite full of those reports a model that
 * cannot code when what it has is a machine that cannot run the tests.
 *
 * The reference solution is read from the benchmark checkout, which is why this
 * takes the source path rather than being something the runner could reach.
 */
export function referenceSolution(
  benchmarkRoot: string,
  instance: PolyglotInstance,
): Record<string, string> | undefined {
  const spec = LANGUAGES[instance.language]!;
  if (!spec.referenceTarget) return undefined;
  const meta = join(
    benchmarkRoot,
    instance.language,
    "exercises",
    "practice",
    instance.exercise,
    ".meta",
  );
  if (!existsSync(meta)) return undefined;

  const out: Record<string, string> = {};
  for (const file of walk(meta, new Set())) {
    const target = spec.referenceTarget(file, instance.exercise);
    if (target) out[target] = readFileSync(join(meta, file), "utf8");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function instanceSummary(instances: readonly PolyglotInstance[]): string {
  const byLanguage = new Map<string, number>();
  for (const i of instances) byLanguage.set(i.language, (byLanguage.get(i.language) ?? 0) + 1);
  return [...byLanguage].map(([l, n]) => `${l} ${n}`).join(", ") + ` (${instances.length} total)`;
}
