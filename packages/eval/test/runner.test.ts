/**
 * The runner, with a stand-in for the agent and a real grader.
 *
 * The agent is faked here and the grader is not, which is the right way round.
 * What these tests are about is the plumbing between them — that the agent's
 * checkout and the grader's copy are separate, that a patch is what crosses,
 * and that each way a row can end badly gets its own status. None of that needs
 * a model, and involving one would make the tests slow and non-deterministic
 * for no gain in what they cover.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvalManifest } from "../src/manifest.js";
import type { PlannedRun } from "../src/results.js";
import { runRow } from "../src/runner.js";
import { WorktreeGrader } from "../src/worktree-grader.js";

let repo: string;
let baseCommit: string;
let workRoot: string;

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

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "motif-runner-repo-"));
  workRoot = mkdtempSync(join(tmpdir(), "motif-runner-work-"));
  git(["init", "-q", "-b", "main"]);
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(
    join(repo, "tests", "test_calc.py"),
    "import sys\nsys.path.insert(0, '.')\nfrom calc import add\nassert add(2, 3) == 5\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "bug"]);
  baseCommit = git(["rev-parse", "HEAD"]).trim();
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

/**
 * A script that stands in for `motif`: it reads `--cwd`, does something to the
 * checkout, and writes a journal the way the real agent does.
 */
function fakeAgent(body: string): string[] {
  const path = join(workRoot, `agent-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(
    path,
    `#!/bin/sh
cwd=""; journal=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) cwd="$2"; shift 2 ;;
    --journal) journal="$2"; shift 2 ;;
    *) shift ;;
  esac
done
${body}
`,
  );
  chmodSync(path, 0o755);
  return [path];
}

const SESSION_END = (reason: string): string =>
  `printf '%s\\n' '{"v":2,"seq":1,"at":"now","runId":"r","scopeId":"root","scopeKind":"root",` +
  `"record":{"t":"event","event":{"type":"session_end","reason":"${reason}"}}}' > "$journal"`;

const manifest = {
  budgets: {
    max_turns: 20,
    task_wall_timeout_seconds: 20,
    command_timeout_seconds: 30,
    max_model_steps: 40,
    max_repairs_per_failure: 2,
    max_total_tokens: null,
  },
  sampling: { max_output_tokens_per_step: 4096 },
  harness: { initial_channel: "toolcall", channel_policy: "fixed" },
} as unknown as EvalManifest;

const planned: PlannedRun = {
  manifestId: "m",
  configId: "c",
  instanceId: "calc-1",
  seed: 1,
  replicate: 0,
  status: "planned",
};

function options(agent: string[], keepArtifacts = false) {
  return {
    manifest,
    instances: [{ id: "calc-1", repo, baseCommit, prompt: "fix add" }],
    grader: new WorktreeGrader({
      repo,
      testCommand: ["python3", "tests/test_calc.py"],
      testPaths: ["tests/test_calc.py"],
    }),
    agentCommand: agent,
    endpoint: "http://127.0.0.1:1",
    model: "test",
    workRoot,
    keepArtifacts,
  };
}

const instance = () => ({ id: "calc-1", repo, baseCommit, prompt: "fix add" });

describe("runner", () => {
  it("grades the work the agent left in its checkout", async () => {
    const agent = fakeAgent(
      `printf 'def add(a, b):\\n    return a + b\\n' > "$cwd/calc.py"\n${SESSION_END("done")}`,
    );
    const row = await runRow(options(agent), planned, instance());
    expect(row.status).toBe("completed");
    expect(row.grade?.status).toBe("passed");
  });

  it("counts a file the agent created, not just files it edited", async () => {
    // `git diff` without staging shows nothing for a new file. An agent that
    // solves the task by adding a module would score zero with a transcript
    // showing it working perfectly.
    const agent = fakeAgent(
      `printf 'def add(a, b):\\n    return a + b\\n' > "$cwd/calc.py"\n` +
        `printf 'helper\\n' > "$cwd/new_module.py"\n${SESSION_END("done")}`,
    );
    const row = await runRow(options(agent), planned, instance());
    expect(row.grade?.status).toBe("passed");
  });

  it("does not let the agent reach the copy it is graded on", async () => {
    // The agent rewrites its own tests to be vacuous. The grade comes from a
    // checkout it never had a path to, so this changes nothing.
    const agent = fakeAgent(
      `printf 'assert True\\n' > "$cwd/tests/test_calc.py"\n${SESSION_END("done")}`,
    );
    const row = await runRow(options(agent), planned, instance());
    expect(row.grade?.status).toBe("failed");
  });

  it("reports a session that ended on transport separately from a crash", async () => {
    // Collapsing these loses the one signal that says the campaign is invalid
    // rather than the model being bad.
    const agent = fakeAgent(`${SESSION_END("transport_error")}\nexit 1`);
    const row = await runRow(options(agent), planned, instance());
    expect(row.status).toBe("model_transport_failure");
  });

  it("reports an agent that died without writing an ending as a crash", async () => {
    const agent = fakeAgent(`exit 3`);
    const row = await runRow(options(agent), planned, instance());
    expect(row.status).toBe("agent_crash");
  });

  it("still grades the work of an agent that ran out of wall clock", async () => {
    // An agent that wrote the fix and then hung has solved the instance.
    // Discarding its patch would score the clock rather than the model.
    const agent = fakeAgent(
      `printf 'def add(a, b):\\n    return a + b\\n' > "$cwd/calc.py"\nsleep 120`,
    );
    const brief = options(agent);
    brief.manifest = {
      ...manifest,
      budgets: { ...manifest.budgets, task_wall_timeout_seconds: 2 },
    } as EvalManifest;
    const row = await runRow(brief, planned, instance());
    expect(row.status).toBe("agent_timeout");
    expect(row.grade?.status).toBe("passed");
  });

  it("leaves no worktree behind, whatever the row did", async () => {
    const agent = fakeAgent(`exit 3`);
    await runRow(options(agent), planned, instance());
    expect(git(["worktree", "list"]).trim().split("\n")).toHaveLength(1);
  });

  it("removes the row's artifacts unless asked to keep them", async () => {
    const agent = fakeAgent(SESSION_END("done"));
    await runRow(options(agent), planned, instance());
    expect(existsSync(join(workRoot, "c--calc-1--1--0"))).toBe(false);

    await runRow(options(agent, true), planned, instance());
    expect(existsSync(join(workRoot, "c--calc-1--1--0", "session.jsonl"))).toBe(true);
  });
});
