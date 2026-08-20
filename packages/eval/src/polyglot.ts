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
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Instance } from "./runner.js";
import { WorktreeGrader, type WorktreeGraderOptions } from "./worktree-grader.js";

export interface LanguageSpec {
  /** Directory under the benchmark root. */
  name: string;
  /** Identifies the test file among the exercise's files. */
  isTest: (file: string) => boolean;
  /** Files the agent may edit, and is told to. */
  isSolution: (file: string, exercise: string) => boolean;
  /** Run from the repository root; exit zero is a pass. */
  testCommand: (testFile: string) => string[];
  env?: Record<string, string>;
  /** Written to `.gitignore`, so the link below never enters a diff. */
  ignore?: string[];
  /** Needs a `node_modules` linked into every fresh checkout. */
  linkModules?: boolean;
}

const toSnake = (exercise: string): string => exercise.replace(/-/g, "_");

export const LANGUAGES: Record<string, LanguageSpec> = {
  python: {
    name: "python",
    isTest: (f) => f.endsWith("_test.py"),
    isSolution: (f, exercise) => f === `${toSnake(exercise)}.py`,
    // `-p no:cacheprovider` so the run leaves no `.pytest_cache` in the
    // worktree; it would show up in the agent's diff as work it did not do.
    testCommand: (test) => ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", test],
  },
  javascript: {
    name: "javascript",
    isTest: (f) => f.endsWith(".spec.js"),
    isSolution: (f, exercise) => f === `${exercise}.js`,
    // `node_modules` is linked in rather than resolved through `NODE_PATH`:
    // jest and babel look for their plugins relative to the root they are run
    // from, and a `NODE_PATH` that works for `require` does not make jest find
    // its own transform.
    testCommand: (test) => ["node", "node_modules/jest/bin/jest.js", "--ci", test],
    ignore: ["node_modules/"],
    linkModules: true,
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
  testFile: string;
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

/**
 * What the agent is asked, and the only description of the task it gets.
 *
 * The instruction not to edit the test is not a defence — the grader restores
 * the tests either way. It is here so that a model which obeys it is not
 * penalised relative to one that does not, which would otherwise be the
 * difference between a wasted turn and a useful one.
 */
function promptFor(instructions: string, solution: string[], testFile: string): string {
  return [
    instructions.trim(),
    "",
    "---",
    "",
    `Implement this in \`${solution.join("`, `")}\`. The tests are in \`${testFile}\` — run them to check your work.`,
    "Do not modify the tests: they are restored from a pristine copy before grading, so changes to them are discarded.",
  ].join("\n");
}

export function buildPolyglotSuite(opts: PolyglotOptions): PolyglotInstance[] {
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
      const files = readdirSync(source, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);

      const testFiles = files.filter((f) => spec.isTest(f));
      const solutionFiles = files.filter((f) => spec.isSolution(f, exercise));
      if (testFiles.length !== 1 || solutionFiles.length === 0) {
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
        copyFileSync(join(source, file), join(repo, file));
      }
      writeFileSync(join(repo, "INSTRUCTIONS.md"), instructions, "utf8");
      if (spec.ignore) {
        // Without this the linked modules land in `git add -A` and the agent's
        // patch is thirty thousand files of somebody else's code.
        writeFileSync(join(repo, ".gitignore"), spec.ignore.join("\n") + "\n", "utf8");
      }

      git(["init", "-q", "-b", "main"], repo);
      git(["add", "-A"], repo);
      git(["commit", "-qm", `${language}/${exercise}`], repo);
      const baseCommit = git(["rev-parse", "HEAD"], repo).trim();

      const setup =
        spec.linkModules && opts.nodePath
          ? ["ln", "-sfn", opts.nodePath, "node_modules"]
          : undefined;

      instances.push({
        id: `${language}/${exercise}`,
        repo,
        baseCommit,
        prompt: promptFor(instructions, solutionFiles, testFiles[0]!),
        ...(setup ? { setupCommand: setup } : {}),
        language,
        exercise,
        testFile: testFiles[0]!,
        solutionFiles,
      });
    }
  }
  return instances;
}

/** The grader for one instance: its own test file, its own command. */
export function polyglotGrader(
  instance: PolyglotInstance,
  opts: { nodePath?: string } = {},
): WorktreeGrader {
  const spec = LANGUAGES[instance.language]!;
  const options: WorktreeGraderOptions = {
    repo: instance.repo,
    testCommand: spec.testCommand(instance.testFile),
    testPaths: [instance.testFile],
    ...(spec.env ? { env: spec.env } : {}),
  };
  if (spec.linkModules && opts.nodePath) {
    options.setupCommand = ["ln", "-sfn", opts.nodePath, "node_modules"];
  }
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
 * is a separate function taking the source path rather than something the
 * runner could reach.
 */
export function referenceSolution(
  benchmarkRoot: string,
  instance: PolyglotInstance,
): Record<string, string> | undefined {
  const meta = join(benchmarkRoot, instance.language, "exercises", "practice", instance.exercise, ".meta");
  if (!existsSync(meta)) return undefined;
  const out: Record<string, string> = {};
  for (const file of readdirSync(meta)) {
    // The reference file is not named after the exercise, and each language
    // track names it differently: `example.py` in Python, `proof.ci.js` in
    // JavaScript. The mapping is by extension, which is the only thing they
    // agree on.
    if (!/^(example|proof)\b/.test(file)) continue;
    const target = instance.solutionFiles.find((s) => s.endsWith(`.${file.split(".").pop()}`));
    if (target) out[target] = readFileSync(join(meta, file), "utf8");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function instanceSummary(instances: readonly PolyglotInstance[]): string {
  const byLanguage = new Map<string, number>();
  for (const i of instances) byLanguage.set(i.language, (byLanguage.get(i.language) ?? 0) + 1);
  return [...byLanguage].map(([l, n]) => `${l} ${n}`).join(", ") + ` (${instances.length} total)`;
}

export function exerciseName(id: string): string {
  return basename(id);
}
