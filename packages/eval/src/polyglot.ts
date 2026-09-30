/**
 * Instances from the Exercism polyglot benchmark, the way Aider's benchmark
 * defines them, run as a benchmark of the harness around the model.
 *
 * A published suite rather than one written here. A benchmark whose author is
 * also the person reporting the score has a problem no amount of care in the
 * arithmetic fixes, and these exercises predate this project by years.
 *
 * The task set, the task text and the grading are Aider's own: all 225
 * exercises with no exclusions, the introduction, instructions and append
 * followed by Aider's addendum, and each track's official test command with
 * its own way of switching on the tests an exercise ships switched off. What
 * differs is the protocol, because Aider's is a benchmark of a model — it sees
 * the stub and the instructions, has no shell and gets two tries — and a
 * harness has nothing to do there. Here the agent works in a directory of its
 * own with a shell and as many turns as it wants, and one line after the
 * addendum says which of two tracks it is in:
 *
 *   H — the graded tests are not in the directory. The agent may write and run
 *       tests of its own; they are removed before grading. The primary track.
 *   V — the tests are there with every skip switched off, the way a repository
 *       with a test suite looks. A ceiling, not the primary number.
 *
 * Each exercise becomes its own single-commit git repository: a base commit to
 * check out from and no history to inherit. What the agent must never reach is
 * kept out of that repository entirely rather than hidden in it: `.meta` holds
 * the reference solution, the `.approaches` and `.articles` write-ups hold
 * worked solutions, and in track H the tests themselves. A file left in any
 * commit is one `git log -p` away from an agent with a shell. Grading starts
 * from the exercise in the benchmark checkout instead; see
 * `polyglot-grader.ts`.
 *
 * Six language tracks, and they agree on almost nothing. So a language says
 * which of its files are tests, what an agent's new file must look like to be
 * graded as source, how its tests run and how they are switched on, and what
 * is common — the task text, the repository, the tracks — is written once.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { basename, dirname, join, relative } from "node:path";
import type { Instance } from "./runner.js";

/** Where the graded tests are: hidden from the agent (primary), or shown to it. */
export type Track = "H" | "V";

/**
 * Which tests a grade switches on.
 *
 * `official` is Aider's benchmark exactly, holes included: JavaScript switches
 * on `xtest(` but not `xit(`, Java removes `@Disabled(...)` with an argument
 * and only from the files the exercise's config lists. `strict` switches on
 * everything a track ships switched off. The primary number uses the official
 * rules so it means what the leaderboard's does; the strict one is reported
 * beside it.
 */
export type GradingRules = "official" | "strict";
export const GRADING_RULES: readonly GradingRules[] = ["official", "strict"];

/** Directories never copied out of an exercise: the answer, and worked solutions. */
export const NEVER_COPIED: ReadonlySet<string> = new Set([".meta", ".approaches", ".articles", ".git"]);

/**
 * Files an exercise's config never lets the model edit, whatever its
 * `solution` list says. Aider's benchmark removes these from the files it puts
 * in the chat; every Rust exercise lists its `Cargo.toml` as a solution file.
 */
const NOT_A_SOLUTION = new Set(["CMakeLists.txt", "Cargo.toml"]);

export interface LanguageSpec {
  name: string;
  /**
   * Test material by name: what the track's test runner would pick up, beyond
   * what the exercise's config lists. Removed from a track H directory, and
   * dropped from an agent's work before grading.
   */
  isTest: (path: string) => boolean;
  /** Harness code that sits beside the tests but is not one: kept in track H. */
  isVendored?: (path: string) => boolean;
  /**
   * A file the agent created that grading keeps: source code of the language,
   * where the build looks for it, and not a test, a build product or a
   * configuration that would change how the tests run.
   */
  isSource: (path: string) => boolean;
  /** The official test command, run from a directory named after the exercise. */
  command: string[];
  /**
   * Switch on the tests of one file under a rule set. `listed` says whether
   * the exercise's config names the file as a test, which is all Aider's Java
   * rule looks at.
   */
  enable?: (path: string, text: string, rules: GradingRules, listed: boolean) => string;
  /** Track V: every skip in a visible test file switched off. */
  reveal?: (path: string, text: string) => string;
  /** Where a file under `.meta` belongs in the exercise, for `motif-suite verify`. */
  referenceTarget?: (metaPath: string, exercise: string) => string | undefined;
  /** Written to `.gitignore`, so build output never enters the agent's patch. */
  ignore?: string[];
  /** A shared dependency directory linked into every fresh directory. */
  link?: { to: string };
  env?: Record<string, string>;
}

const base = (path: string): string => basename(path);
const snake = (exercise: string): string => exercise.replace(/-/g, "_");

/** Aider's `npm-test.sh`: `sed -i 's/\bxtest(/test(/g' *.spec.js`. */
const jsOfficial = (text: string): string => text.replace(/\bxtest\(/g, "test(");
const jsStrict = (text: string): string =>
  jsOfficial(text).replace(/\bxit\(/g, "it(").replace(/\bxdescribe\(/g, "describe(");
/** Aider's `re.sub(r"@Disabled\([^)]*\)\s*\n", "", content)`, applied to the config's test files. */
const javaOfficial = (text: string): string => text.replace(/@Disabled\([^)]*\)\s*\n/g, "");
/** The official rule first, so a file it already covers comes out byte for byte the same. */
const javaStrict = (text: string): string =>
  javaOfficial(text).replace(/^[ \t]*@(?:Disabled|Ignore)\b.*\r?\n/gm, "");

export const LANGUAGES: Record<string, LanguageSpec> = {
  python: {
    name: "python",
    // pytest collects `test_*.py` and `*_test.py`; `conftest.py` changes what
    // it collects and how, so an agent's own counts as test material too.
    isTest: (p) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(p) || base(p) === "conftest.py",
    isSource: (p) =>
      p.endsWith(".py") &&
      !/(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(p) &&
      !["conftest.py", "setup.py"].includes(base(p)) &&
      !p.split("/").includes("__pycache__"),
    command: ["python3", "-m", "pytest"],
    referenceTarget: (m, e) => (m === "example.py" ? `${snake(e)}.py` : undefined),
    ignore: ["__pycache__/", ".pytest_cache/"],
  },

  javascript: {
    name: "javascript",
    isTest: (p) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(p) || p.split("/").includes("__tests__"),
    isSource: (p) =>
      /\.[cm]?js$/.test(p) &&
      !/\.(spec|test)\.[cm]?[jt]sx?$/.test(p) &&
      !p.split("/").includes("__tests__") &&
      !/(^|\/)[^/]*\.config\.[cm]?js$/.test(p) &&
      !p.startsWith("node_modules/"),
    // Aider's `npm-test.sh` after its `sed`: the exercise's own `test` script,
    // which is `jest ./*`.
    command: ["npm", "run", "test"],
    enable: (p, text, rules) =>
      !/^[^/]*\.spec\.js$/.test(p) ? text : rules === "official" ? jsOfficial(text) : jsStrict(text),
    reveal: (_p, text) => jsStrict(text),
    referenceTarget: (m, e) => (m === "proof.ci.js" ? `${e}.js` : undefined),
    ignore: ["node_modules", "package-lock.json"],
    link: { to: "node_modules" },
    // Nothing on stdout but the tests: no update check, no funding notice.
    env: { NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT: "false" },
  },

  go: {
    name: "go",
    // `cases_test.go` holds the table the assertions read; `bonus_test.go` is
    // behind a build tag Aider does not set either. Both are test material.
    isTest: (p) => p.endsWith("_test.go"),
    isSource: (p) => p.endsWith(".go") && !p.endsWith("_test.go"),
    command: ["go", "test", "./..."],
    referenceTarget: (m, e) => (m === "example.go" ? `${snake(e)}.go` : undefined),
  },

  rust: {
    name: "rust",
    isTest: (p) => p.startsWith("tests/"),
    // Modules under `src/`. A `build.rs`, an example or a bench runs code or
    // builds targets the tests did not ask for.
    isSource: (p) => p.startsWith("src/") && p.endsWith(".rs"),
    command: ["cargo", "test", "--", "--include-ignored"],
    reveal: (_p, text) => text.replace(/^[ \t]*#\[ignore(?:\s*=\s*"[^"]*")?\][ \t]*\r?\n/gm, ""),
    referenceTarget: (m) =>
      m === "example.rs" ? "src/lib.rs" : m === "Cargo-example.toml" ? "Cargo.toml" : undefined,
    ignore: ["target/", "Cargo.lock"],
  },

  cpp: {
    name: "cpp",
    isTest: (p) => /_test\.(cpp|cc|cxx)$/.test(p) || p.startsWith("test/"),
    // Catch2 and its main, which the exercise's CMakeLists compiles in: an
    // agent that writes `<exercise>_test.cpp` of its own can then use the
    // official build, and grading replaces that file with the real one.
    isVendored: (p) => p.startsWith("test/"),
    isSource: (p) =>
      /\.(cpp|cc|cxx|h|hh|hpp)$/.test(p) &&
      !/_test\.(cpp|cc|cxx)$/.test(p) &&
      !p.startsWith("test/") &&
      !p.startsWith("build/") &&
      !p.split("/").includes("CMakeFiles"),
    // Aider's `cpp-test.sh`, verbatim. The CMakeLists builds with
    // `-Wall -Wextra -Wpedantic -Werror` and runs the tests inside `make`.
    command: [
      "sh",
      "-c",
      'set -e\n[ ! -d "build" ] && mkdir build\ncd build\ncmake -DEXERCISM_RUN_ALL_TESTS=1 -G "Unix Makefiles" ..\nmake',
    ],
    reveal: (_p, text) => `#define EXERCISM_RUN_ALL_TESTS\n${text}`,
    referenceTarget: (m, e) =>
      m === "example.cpp" ? `${snake(e)}.cpp` : m === "example.h" ? `${snake(e)}.h` : undefined,
    ignore: ["build/", "CMakeCache.txt", "CMakeFiles/", "cmake_install.cmake", "Makefile", "*.o"],
  },

  java: {
    name: "java",
    isTest: (p) => p.startsWith("src/test/"),
    isSource: (p) => p.startsWith("src/main/") && p.endsWith(".java"),
    command: ["./gradlew", "test"],
    enable: (p, text, rules, listed) =>
      !p.endsWith(".java") ? text : rules === "official" ? (listed ? javaOfficial(text) : text) : javaStrict(text),
    reveal: (p, text) => (p.endsWith(".java") ? javaStrict(text) : text),
    referenceTarget: (m) =>
      m.startsWith("src/reference/java/") ? m.replace("src/reference/java/", "src/main/java/") : undefined,
    ignore: [".gradle/", "build/"],
  },
};

/** `.meta/config.json`'s `files`, as the exercise declares them. */
export interface ExerciseConfig {
  solution: string[];
  test: string[];
  editor: string[];
  example: string[];
}

export function readExerciseConfig(dir: string): ExerciseConfig {
  const path = join(dir, ".meta", "config.json");
  const files = existsSync(path)
    ? ((JSON.parse(readFileSync(path, "utf8")) as { files?: Partial<ExerciseConfig> }).files ?? {})
    : {};
  return {
    solution: files.solution ?? [],
    test: files.test ?? [],
    editor: files.editor ?? [],
    example: files.example ?? [],
  };
}

/** Every file under `root`, relative and sorted, skipping the directory names given. */
export function walk(root: string, exclude: ReadonlySet<string> = NEVER_COPIED, from = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const full = join(from, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, exclude, full));
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out.sort();
}

/** The exercise's files as it ships them, without the answer or the write-ups. */
export function exerciseFiles(dir: string): string[] {
  return walk(dir);
}

/**
 * The graded tests: what the config lists, and whatever else the track's test
 * runner would pick up, less the vendored harness code. `python/paasio` lists
 * a `test_utils.py` no name pattern catches; `java/satellite` ships a
 * `TreeTest.java` its config does not list.
 */
export function gradedTests(spec: LanguageSpec, config: ExerciseConfig, files: readonly string[]): string[] {
  const listed = new Set(config.test);
  return files.filter((f) => (listed.has(f) || spec.isTest(f)) && !spec.isVendored?.(f)).sort();
}

/**
 * The files the model is told to modify, as Aider's benchmark lists them: the
 * config's solution files that exist, less build files, tests and examples.
 */
export function solutionFiles(config: ExerciseConfig, files: readonly string[]): string[] {
  const present = new Set(files);
  const excluded = new Set([...config.test, ...config.example]);
  return config.solution
    .filter((f) => present.has(f) && !NOT_A_SOLUTION.has(base(f)) && !excluded.has(f) && !f.startsWith(".docs/"))
    .sort();
}

/** Aider's `instructions_addendum`, byte for byte. */
export function officialAddendum(fileList: string): string {
  return (
    "\n####\n\n" +
    `Use the above instructions to modify the supplied files: ${fileList}\n` +
    "Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.\n" +
    "Only use standard libraries, don't suggest installing any packages.\n"
  );
}

/** Aider's `test_failures`, byte for byte: what follows the test output in a feedback round. */
export function officialTestFailures(fileList: string): string {
  return (
    "\n####\n\n" +
    "See the testing errors above.\n" +
    "The tests are correct, don't try and change them.\n" +
    `Fix the code in ${fileList} to resolve the errors.\n`
  );
}

/** How Aider names the solution files in its prompts: file names, space-separated. */
export function fileList(solution: readonly string[]): string {
  return solution.map(base).join(" ");
}

/**
 * The task as Aider's benchmark writes it: the introduction, the instructions
 * and the append, concatenated as they are, then the addendum.
 */
export function officialTaskText(dir: string, solution: readonly string[]): string {
  const read = (name: string): string => {
    const path = join(dir, ".docs", name);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  return read("introduction.md") + read("instructions.md") + read("instructions.append.md") + officialAddendum(fileList(solution));
}

/** The one line a track adds after the official text. */
export function trackLine(track: Track, visibleTests: readonly string[]): string {
  return track === "H"
    ? "The unit tests used for grading are not in this directory. You may write and run your own tests; test files you add are removed before grading.\n"
    : `The tests are in \`${visibleTests.join("`, `")}\` — run them to check your work. ` +
        "Do not modify them: they are restored from a pristine copy before grading.\n";
}

export interface PolyglotOptions {
  /** A checkout of Aider-AI/polyglot-benchmark. */
  root: string;
  languages: readonly string[];
  /** Where the per-exercise repositories are built. */
  repoRoot: string;
  /** Default H. */
  track?: Track;
  /** Cap per language, for a dev split. Omit for all of them. */
  limit?: number;
  /** Node modules directory shared by the JavaScript exercises. */
  nodePath?: string;
}

export interface PolyglotInstance extends Instance {
  language: string;
  exercise: string;
  track: Track;
  /** The graded tests, by path in the exercise. Not in the agent's directory in track H. */
  testFiles: string[];
  /** The files the agent is told to modify. */
  solutionFiles: string[];
  /** The exercise in the benchmark checkout, which grading starts from. */
  sourceDir: string;
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

function setupFor(spec: LanguageSpec, opts: { nodePath?: string }): string[] | undefined {
  if (spec.link && opts.nodePath) return ["ln", "-sfn", opts.nodePath, spec.link.to];
  return undefined;
}

export function buildPolyglotSuite(opts: PolyglotOptions): PolyglotInstance[] {
  const track: Track = opts.track ?? "H";
  const instances: PolyglotInstance[] = [];
  mkdirSync(opts.repoRoot, { recursive: true });

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
      const files = exerciseFiles(source);
      const config = readExerciseConfig(source);
      const tests = gradedTests(spec, config, files);
      const solution = solutionFiles(config, files);
      if (solution.length === 0 || tests.length === 0 || !existsSync(join(source, ".docs", "instructions.md"))) {
        // Every exercise in the pinned checkout has all three, so this is a
        // checkout that is not the one the benchmark names. Refusing is better
        // than an instance that can never pass and scores zero everywhere.
        throw new Error(`${language}/${exercise} has no solution file, test or instructions; wrong checkout?`);
      }

      // Rebuilt from scratch each time. Reusing a directory that is already
      // there makes the suite depend on what a previous run left behind, and
      // the second `git commit` fails with "nothing to commit" rather than
      // producing the same suite twice.
      const repo = join(opts.repoRoot, `${language}--${exercise}`);
      rmSync(repo, { recursive: true, force: true });
      mkdirSync(repo, { recursive: true });

      const hidden = new Set(track === "H" ? tests : []);
      for (const file of files) {
        if (hidden.has(file)) continue;
        const from = join(source, file);
        const target = join(repo, file);
        mkdirSync(dirname(target), { recursive: true });
        if (track === "V" && tests.includes(file) && spec.reveal) {
          writeFileSync(target, spec.reveal(file, readFileSync(from, "utf8")), "utf8");
        } else {
          copyFileSync(from, target);
        }
        // The executable bit survives the copy. A `gradlew` that cannot be run
        // turns every Java instance into an infrastructure failure.
        if (statSync(from).mode & 0o111) execFileSync("chmod", ["+x", target]);
      }
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
        prompt: officialTaskText(source, solution) + trackLine(track, tests),
        // The name matters: C++'s CMakeLists takes its target from it.
        workdirName: exercise,
        ...(setup ? { setupCommand: setup } : {}),
        language,
        exercise,
        track,
        testFiles: tests,
        solutionFiles: solution,
        sourceDir: source,
      });
    }
  }
  return instances;
}

/**
 * The instance list's fingerprint, the way `make_manifest.py` computes it:
 * sorted ids with their base commits, as Python's `json.dumps(sort_keys=True)`
 * writes them. A run refuses a suite whose fingerprint is not its manifest's.
 */
export function instancesSha256(instances: readonly { id: string; baseCommit: string; language: string }[]): string {
  const rows = [...instances]
    .map((i) => ({ baseCommit: i.baseCommit, id: i.id, language: i.language }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const text =
    "[" +
    rows
      .map((r) => `{"baseCommit": ${JSON.stringify(r.baseCommit)}, "id": ${JSON.stringify(r.id)}, "language": ${JSON.stringify(r.language)}}`)
      .join(", ") +
    "]";
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The exercise's reference solution, as files to write into a candidate.
 *
 * For `motif-suite verify` only, never during a campaign: it reads `.meta`.
 * Rust's `Cargo-example.toml` is included where there is one — six references
 * use crates the stub's `Cargo.toml` does not declare, and the grader keeps
 * that file only in reference mode.
 */
export function referenceSolution(instance: PolyglotInstance): Record<string, string> | undefined {
  const spec = LANGUAGES[instance.language]!;
  if (!spec.referenceTarget) return undefined;
  const meta = join(instance.sourceDir, ".meta");
  if (!existsSync(meta)) return undefined;

  const out: Record<string, string> = {};
  for (const file of walk(meta, new Set())) {
    const target = spec.referenceTarget(file, instance.exercise);
    if (target) out[target] = readFileSync(join(meta, file), "utf8");
  }
  return Object.keys(out).some((k) => instance.solutionFiles.includes(k) || spec.isSource(k)) ? out : undefined;
}

export function instanceSummary(instances: readonly PolyglotInstance[]): string {
  const byLanguage = new Map<string, number>();
  for (const i of instances) byLanguage.set(i.language, (byLanguage.get(i.language) ?? 0) + 1);
  return [...byLanguage].map(([l, n]) => `${l} ${n}`).join(", ") + ` (${instances.length} total)`;
}
