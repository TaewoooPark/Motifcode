/**
 * Grading a polyglot instance the way Aider's benchmark does, from input an
 * agent with a shell has had its hands on.
 *
 * Aider's model has no shell and edits only the files in its chat, so its
 * grader copies the tests back and runs one command. An agent leaves more
 * behind: build directories, a `CMakeCache.txt` in the source tree, an edited
 * `CMakeLists.txt`, test files of its own that `jest ./*`, `pytest`,
 * `go test ./...` and Gradle would all pick up. Campaign patches carried every
 * one of these, and four C++ rows failed the official build on the cache file
 * alone. So the tree that is graded is built rather than patched:
 *
 *   - the exercise as the benchmark checkout ships it (without `.meta`),
 *   - the agent's version of each solution file, or its absence if it deleted one,
 *   - any new source file the agent added — a Java `Frame.java`, a Python helper,
 *
 * and nothing else. Tests, build configuration, vendored and helper files are
 * the originals whatever the agent did to them; build output and the agent's
 * own tests are left out. The official test command then runs from a
 * directory named after the exercise — C++'s CMakeLists takes its target from
 * that name — with a 180-second limit, and exit zero is a pass.
 *
 * Two rule sets for switching on disabled tests are graded: `official`, which
 * is Aider's with its holes, and `strict`. They differ only where a test file
 * differs under them, so most exercises run once and share the verdict.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GraderResult } from "@motifcode/journal";
import { patchHash, type GradeRequest, type GraderAdapter } from "./grader.js";
import {
  LANGUAGES,
  exerciseFiles,
  fileList,
  officialTestFailures,
  readExerciseConfig,
  walk,
  type GradingRules,
  type PolyglotInstance,
} from "./polyglot.js";

export interface PolyglotGraderOptions {
  /** Node modules linked into JavaScript trees: the shared jest and babel. */
  nodePath?: string;
  env?: Record<string, string>;
  /**
   * Keep the candidate's build configuration: for grading a reference
   * solution in `motif-suite verify`, whose Rust `Cargo.toml` declares crates
   * the stub's does not. Never during a campaign.
   */
  reference?: boolean;
}

/** One grade under one rule set, with what went into it. */
export interface PolyglotGrade {
  rules: GradingRules;
  result: GraderResult;
  /** The whole test output, stderr folded into stdout, cleaned as Aider cleans it. */
  output: string;
  /** Agent files the grade used: its solution files and new source files. */
  carried: string[];
  /** Agent files the grade left out, and why. A test is dropped, or replaced by the graded one. */
  dropped: { path: string; why: "test" | "not source" }[];
  /** Files the agent had been given and changed or deleted, put back as shipped. */
  restored: string[];
  /** Solution files the agent deleted, which stay deleted. */
  deleted: string[];
}

export interface PolyglotGrades {
  official: PolyglotGrade;
  strict: PolyglotGrade;
  /** True when the strict rules changed no test file, so one run served both. */
  shared: boolean;
}

interface Run {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Run a command in its own process group, stderr folded into stdout the way
 * Aider's `subprocess.run(..., stderr=STDOUT)` reads it.
 */
function run(command: string[], cwd: string, timeoutMs: number, env?: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", 'exec "$@" 2>&1', "sh", ...command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let output = "";
    let timedOut = false;
    child.stdout?.on("data", (c: Buffer) => {
      output += c.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // The group: a test runner that spawned a server leaves the server
      // running if only the runner is signalled.
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/**
 * Aider's `cleanup_test_output`: drop timings, which would make the same
 * failure read differently every run, and show the directory by its name.
 */
export function cleanTestOutput(output: string, tree: string, exercise: string): string {
  let out = output.replace(/\bin \d+\.\d+s\b/g, "");
  const paths = [tree];
  try {
    const real = realpathSync(tree);
    if (real !== tree) paths.unshift(real);
  } catch {
    // Already removed; the plain path is all there is to replace.
  }
  for (const p of paths) out = out.split(p).join(exercise);
  return out;
}

/** Python's `str.splitlines()`: line breaks of any kind, no empty last line for a trailing break. */
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * What a feedback round sends: the failed run's output and Aider's
 * `test_failures`, joined the way its benchmark joins them.
 */
export function feedbackMessage(grade: PolyglotGrade, instance: PolyglotInstance): string {
  return splitlines(grade.output).join("\n") + officialTestFailures(fileList(instance.solutionFiles));
}

function copyWithMode(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const mode = statSync(from).mode;
  // The executable bit survives: a `gradlew` that cannot run is an
  // infrastructure failure dressed as the agent's.
  if (mode & 0o111) chmodSync(to, mode & 0o777);
}

export class PolyglotGrader implements GraderAdapter {
  readonly name = "polyglot-v2";
  readonly version = "2";

  constructor(
    private readonly instance: PolyglotInstance,
    private readonly opts: PolyglotGraderOptions = {},
  ) {}

  /** The primary grade: official rules. */
  async grade(request: GradeRequest): Promise<GraderResult> {
    return (await this.gradeAll(request)).official.result;
  }

  async gradeAll(request: GradeRequest): Promise<PolyglotGrades> {
    const root = mkdtempSync(join(tmpdir(), "motif-grade-"));
    const candidate = join(root, "candidate");
    try {
      const applied = await this.materialize(request, candidate);
      if (applied !== true) {
        const unusable = (rules: GradingRules): PolyglotGrade => ({
          rules,
          result: this.result(request, applied.status, {
            ...(applied.code !== undefined ? { exitCode: applied.code } : {}),
            stderrArtifact: applied.detail.slice(0, 4000),
          }),
          output: applied.detail,
          carried: [],
          dropped: [],
          restored: [],
          deleted: [],
        });
        return { official: unusable("official"), strict: unusable("strict"), shared: true };
      }
      const official = await this.gradeTree(request, candidate, join(root, "official"), "official");
      if (!official.differs) {
        return { official: official.grade, strict: { ...official.grade, rules: "strict" }, shared: true };
      }
      const strict = await this.gradeTree(request, candidate, join(root, "strict"), "strict");
      return { official: official.grade, strict: strict.grade, shared: false };
    } catch (err) {
      const broken = (rules: GradingRules): PolyglotGrade => ({
        rules,
        result: this.result(request, "infra_error", { stderrArtifact: String(err).slice(0, 4000) }),
        output: String(err),
        carried: [],
        dropped: [],
        restored: [],
        deleted: [],
      });
      return { official: broken("official"), strict: broken("strict"), shared: true };
    } finally {
      await run(["git", "worktree", "remove", "--force", candidate], this.instance.repo, 60_000).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }

  private result(request: GradeRequest, status: GraderResult["status"], extra: Partial<GraderResult> = {}): GraderResult {
    const now = new Date().toISOString();
    return {
      status,
      score: status === "passed" ? 1 : 0,
      graderName: this.name,
      graderVersion: this.version,
      startedAt: now,
      finishedAt: now,
      patchSha256: patchHash(request.patch),
      ...extra,
    };
  }

  /**
   * The agent's directory as it left it: the base commit with the patch
   * applied. An empty patch is graded too — six exercises pass untouched, and
   * Aider counts them as passed when the model does not break them.
   */
  private async materialize(
    request: GradeRequest,
    candidate: string,
  ): Promise<true | { status: GraderResult["status"]; code?: number; detail: string }> {
    const timeoutMs = 120_000;
    const added = await run(["git", "worktree", "add", "--detach", "-f", candidate, request.baseCommit], this.instance.repo, timeoutMs);
    if (added.code !== 0) {
      // The grader is broken, not the agent; scoring it a failure would
      // silently penalise the candidate.
      return { status: "infra_error", detail: added.output };
    }
    if (request.patch.trim() === "") return true;
    const patchFile = join(dirname(candidate), "candidate.patch");
    writeFileSync(patchFile, request.patch, "utf8");
    const applied = await run(["git", "apply", "--whitespace=nowarn", patchFile], candidate, timeoutMs);
    if (applied.code !== 0) {
      // A patch that will not apply is a failed task, not a grader malfunction.
      return { status: "failed", ...(applied.code !== null ? { code: applied.code } : {}), detail: applied.output };
    }
    return true;
  }

  private async gradeTree(
    request: GradeRequest,
    candidate: string,
    parent: string,
    rules: GradingRules,
  ): Promise<{ grade: PolyglotGrade; differs: boolean }> {
    const { instance } = this;
    const spec = LANGUAGES[instance.language]!;
    const config = readExerciseConfig(instance.sourceDir);
    const original = exerciseFiles(instance.sourceDir);
    const originalSet = new Set(original);
    const solutions = new Set(instance.solutionFiles);
    const tests = new Set(instance.testFiles);
    const listedTests = new Set(config.test);
    // What the agent was handed: the exercise less its hidden tests, plus the
    // suite's own `.gitignore`. Anything else in its directory it made.
    const given = new Set(
      execFileSync("git", ["ls-tree", "-r", "--name-only", request.baseCommit], {
        cwd: instance.repo,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
        .split("\n")
        .filter(Boolean),
    );
    const agentFiles = walk(candidate, new Set([".git"]));
    const agentSet = new Set(agentFiles);

    const tree = join(parent, instance.exercise);
    mkdirSync(tree, { recursive: true });

    // The exercise as shipped.
    for (const file of original) copyWithMode(join(instance.sourceDir, file), join(tree, file));

    const carried: string[] = [];
    const dropped: PolyglotGrade["dropped"] = [];
    const restored: string[] = [];
    const deleted: string[] = [];

    for (const file of original) {
      const mine = join(candidate, file);
      if (solutions.has(file)) {
        // Its solution files as the agent left them.
        if (agentSet.has(file)) {
          copyWithMode(mine, join(tree, file));
          carried.push(file);
        } else {
          rmSync(join(tree, file), { force: true });
          deleted.push(file);
        }
      } else if (!given.has(file)) {
        // A graded test the agent never saw. One of the same name is its own,
        // and the real one takes its place.
        if (agentSet.has(file)) dropped.push({ path: file, why: "test" });
      } else if (!agentSet.has(file)) {
        restored.push(file);
      } else {
        // Compared as bytes: the Gradle wrapper jar is among these.
        const shipped = readFileSync(join(instance.sourceDir, file));
        const handed =
          instance.track === "V" && tests.has(file) && spec.reveal
            ? Buffer.from(spec.reveal(file, shipped.toString("utf8")), "utf8")
            : shipped;
        if (!readFileSync(mine).equals(handed)) restored.push(file);
      }
    }
    // Its new files: source is graded, nothing else it created is.
    for (const file of agentFiles) {
      if (originalSet.has(file) || given.has(file)) continue;
      if (spec.isTest(file)) dropped.push({ path: file, why: "test" });
      else if (spec.isSource(file)) {
        copyWithMode(join(candidate, file), join(tree, file));
        carried.push(file);
      } else dropped.push({ path: file, why: "not source" });
    }
    if (this.opts.reference && instance.language === "rust" && agentSet.has("Cargo.toml")) {
      copyWithMode(join(candidate, "Cargo.toml"), join(tree, "Cargo.toml"));
      const at = restored.indexOf("Cargo.toml");
      if (at !== -1) restored.splice(at, 1);
      carried.push("Cargo.toml");
    }

    // Switch on the tests under this rule set, and note whether the other
    // rule set would have switched on anything more.
    let differs = false;
    if (spec.enable) {
      for (const file of instance.testFiles) {
        const path = join(tree, file);
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf8");
        const listed = listedTests.has(file);
        const enabled = spec.enable(file, text, rules, listed);
        if (enabled !== text) writeFileSync(path, enabled, "utf8");
        if (spec.enable(file, text, "official", listed) !== spec.enable(file, text, "strict", listed)) differs = true;
      }
    }

    if (spec.link && this.opts.nodePath) symlinkSync(this.opts.nodePath, join(tree, spec.link.to));

    const env: Record<string, string> = { ...spec.env, ...this.opts.env };
    // Two C++ exercises include Boost date-time. The official image has it on
    // the default include path; a host that keeps it elsewhere says where.
    if (instance.language === "cpp" && process.env["CXX_EXTRA_INCLUDE"]) {
      env["CPLUS_INCLUDE_PATH"] = [process.env["CXX_EXTRA_INCLUDE"], process.env["CPLUS_INCLUDE_PATH"]]
        .filter(Boolean)
        .join(":");
    }

    const startedAt = new Date().toISOString();
    const ran = await run(spec.command, tree, Math.max(1, request.timeoutSeconds) * 1000, env);
    // Aider's wording for a run that did not finish; a failure, not an
    // infrastructure problem — an agent can write an infinite loop.
    const output = ran.timedOut ? "Tests timed out!" : cleanTestOutput(ran.output, tree, instance.exercise);
    const status: GraderResult["status"] = !ran.timedOut && ran.code === 0 ? "passed" : "failed";
    const result: GraderResult = {
      ...this.result(request, status, {
        ...(ran.code !== null ? { exitCode: ran.code } : {}),
        stdoutArtifact: output.slice(-8000),
        ...(ran.timedOut ? { stderrArtifact: "grader timeout" } : {}),
      }),
      startedAt,
    };
    return {
      grade: { rules, result, output, carried: carried.sort(), dropped, restored: restored.sort(), deleted },
      differs,
    };
  }
}
