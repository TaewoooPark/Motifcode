import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, type Executor, type LoopCheckpoint, type ToolInvocation } from "@motifcode/core";
import { ScriptedTransport, doneBody, toolCallBody } from "@motifcode/replay";
import { CORE_TOOLS } from "@motifcode/tools";
import { ToolExecutor } from "../src/executor.js";
import { loadTaskChecks } from "../src/task-checks.js";

let cwd: string;
const verification = "check-output";
const contract = { checks: [{ id: "check-a", command: verification, files: ["result.txt"] }], progress: { file: "steps.txt", milestones: ["one", "two", "three", "four", "five", "six"] } };
const manifest = () => loadTaskChecks(cwd, "contract.json");
const call = (command: string): ToolInvocation => ({ id: "c1", name: "bash", arguments: { command }, repaired: false, validated: true });
const result = (value: string) => writeFileSync(join(cwd, "result.txt"), value);
const fake: Executor = { run: async () => ({ ok: true, output: "passed" }) };

// This adapter supplies actual test dispatch results, after host policy and approval.
function checkedExecutor(c: Awaited<ReturnType<typeof manifest>>, host: Executor): Executor {
  return { run: (call, signal) => c.verifyBash(String(call.arguments.command), () => host.run(call, signal)) };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "motif-check-"));
  writeFileSync(join(cwd, "contract.json"), JSON.stringify(contract));
  result("A");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("task-declared output checks", () => {
  it("binds a receipt to the exact command and unchanged covered bytes", async () => {
    const c = await manifest();
    expect((await checkedExecutor(c, fake).run(call("echo passed"))).requiredOutputReceipt).toBeUndefined();
    const actual = (await checkedExecutor(c, fake).run(call(verification))).requiredOutputReceipt;
    expect(actual).toMatchObject({ id: "check-a", status: "pass" });
    expect(actual?.digest).toBe(await c.options.requiredOutputVerifier!.digest("check-a"));
    const changed: Executor = { run: async () => { result("B"); return { ok: true, output: "passed" }; } };
    expect((await checkedExecutor(c, changed).run(call(verification))).requiredOutputReceipt?.status).toBe("unavailable");
    expect(await c.options.requiredOutputVerifier!.digest("check-a")).not.toEqual(actual!.digest);
  });

  it("keeps a declined real bash tool as a benign result without issuing a check receipt", async () => {
    const c = await manifest();
    const real = new ToolExecutor({ cwd, confirm: async () => "deny", verifyBash: c.verifyBash });
    try {
      const denied = await real.run(call(verification));
      expect(denied.ok).toBe(true);
      expect(denied.output).toContain("declined");
      expect(denied.requiredOutputReceipt).toBeUndefined();
      const run = await runLoop({ tools: [...CORE_TOOLS], userTask:"check", system: () => "task", emit: () => {},
        ...c.options, executor:real, maxTurns:3, transport:new ScriptedTransport([
          toolCallBody("bash",{command:verification}), doneBody("done"), doneBody("done",{confirm:true}),
        ]) });
      expect(run.reason).toBe("turn_limit");
    } finally { real.close(); }
  });

  it("holds a matching claim after a failed check, then accepts fresh evidence", async () => {
    const c = await manifest();
    let attempts = 0;
    const checked: Executor = { run: async () => ({ ok: ++attempts > 1, output: "printed PASS" }) };
    const ds = (confirm = false) => doneBody("valid result", { confirm });
    const action = toolCallBody("bash", { command: verification });
    const transport = new ScriptedTransport([action, ds(), ds(true), action, ds(), ds(true)]);
    const checkpoints: LoopCheckpoint[] = [];
    const run = await runLoop({ tools: [...CORE_TOOLS], userTask: "write then check", system: () => "task", transport,
      executor: checkedExecutor(c, checked), emit: () => {}, ...c.options, onCheckpoint: cp => checkpoints.push(cp) });
    expect(run.reason).toBe("done");
    expect(run.turns).toBe(6);
    expect(checkpoints.some(cp => cp.requiredOutputProof?.["check-a"]?.status === "fail")).toBe(true);
    expect(checkpoints.at(-1)?.requiredOutputProof?.["check-a"]?.status).toBe("pass");
    expect(checkpoints.at(-1)?.taskChecksKey).toBe(c.key);
    result("new bytes");
    const last = checkpoints.find(cp => cp.requiredOutputProof?.["check-a"]?.status === "pass")!;
    const retry = await runLoop({ tools: [...CORE_TOOLS], userTask: "resume", system: () => "task", transport: new ScriptedTransport([ds(),ds(true)]),
      ...c.options, resume: last, executor: checkedExecutor(c, fake), emit: () => {}, maxTurns: last.turn + 2 });
    expect(retry.reason).toBe("turn_limit");
    await expect(runLoop({ tools: [...CORE_TOOLS], userTask: "resume", system: () => "task", transport: new ScriptedTransport([]),
      resume: last, executor: fake, emit: () => {} })).rejects.toThrow(/same task checks/);
  });

  it("cannot use prose to bypass an explicit owner-declared check", async () => {
    const c = await manifest();
    const run = await runLoop({ tools: [...CORE_TOOLS], userTask: "finish", system: () => "task", executor: fake,
      ...c.options, emit: () => {}, replyEnds: true, maxTurns: 1, transport: new ScriptedTransport(["</think>All work complete."]) });
    expect(run.reason).toBe("turn_limit");
  });

  it("only advances on the declared complete milestone prefix", async () => {
    const progress = (await manifest()).options.readProgress!;
    expect(await progress()).toBe(0);
    writeFileSync(join(cwd, "steps.txt"), "one\r\ntwo\r\n");
    expect(await progress()).toBe(2);
    writeFileSync(join(cwd, "steps.txt"), "one\nwrong\n");
    expect(await progress()).toBeUndefined();
  });

  it("keeps valid silent progress and stops a repeatedly incorrect operation", async () => {
    writeFileSync(join(cwd, "contract.json"), JSON.stringify({ progress: contract.progress }));
    for (const valid of [true, false]) {
      const c = await manifest();
      writeFileSync(join(cwd,"steps.txt"), "");
      let calls = 0;
      const seen: LoopCheckpoint[] = [];
      const act = toolCallBody("bash", { command: "advance" });
      const exec: Executor = { run: async () => {
        calls++;
        writeFileSync(join(cwd,"steps.txt"), valid ? contract.progress.milestones.slice(0,calls).join("\n") : "wrong " + calls);
        return { ok: true, output: "(exit 0)" };
      }};
      const run = await runLoop({ tools: [...CORE_TOOLS], userTask: "advance", system: () => "task", executor: exec, emit: () => {},
        ...c.options, onCheckpoint: cp => seen.push(cp), transport: new ScriptedTransport([...Array(6).fill(act),doneBody("complete"),doneBody("complete",{ confirm:true })]) });
      expect(run.reason).toBe(valid ? "done" : "loop_detected");
      expect(calls).toBe(valid ? 6 : 3);
      expect(seen.at(-1)?.verifiedProgress).toBe(valid ? 6 : 0);
    }
  });
});
