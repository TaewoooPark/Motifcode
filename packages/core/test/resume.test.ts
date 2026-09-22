/**
 * Resume, as continuation rather than retry.
 *
 * `motif resume` used to rebuild the conversation from the recorded *user*
 * turns and hand the last one to a fresh loop — losing every assistant turn,
 * every tool result, the current channel, the breakage budget, the loop guard,
 * the repair count and any pending `done`. What came back was a new attempt at
 * the same task in a repository the earlier attempt had already modified, which
 * is a strictly worse starting position than the original and was reported as
 * continuity.
 *
 * The test that matters is the first one: an interrupted-and-resumed run and an
 * uninterrupted one must ask the model exactly the same next question.
 */

import { describe, expect, it } from "vitest";
import { requestDigest } from "@motifcode/protocol";
import { CORE_TOOLS } from "@motifcode/tools";
import { ScriptedTransport, doneBody, toolCallBody } from "@motifcode/replay";
import {
  compatibilityProblem,
  isMutating,
  resumeBlock,
  runLoop,
  type Executor,
  type LoopCheckpoint,
  type LoopEvent,
} from "../src/index.js";

const okExecutor: Executor = { run: async () => ({ ok: true, output: "listing" }) };
const sink = (_e: LoopEvent) => {};
const TASK = "rename the helper";

const base = {
  tools: [...CORE_TOOLS],
  system: () => "You are motifcode.",
  userTask: TASK,
  executor: okExecutor,
  emit: sink,
};

const SCRIPT = [
  toolCallBody("bash", { command: "rg -n helper" }, { reasoning: "orient" }),
  toolCallBody("bash", { command: "sed -i s/helper/aide/ x.ts" }),
  doneBody("renamed it"),
  doneBody("renamed it", { confirm: true }),
];

describe("a resumed run asks the same next question", () => {
  it("matches an uninterrupted run's request, canonical hash and all", async () => {
    // Uninterrupted: run the whole script and keep every request.
    const straight = new ScriptedTransport(SCRIPT);
    await runLoop({ ...base, transport: straight });

    // Interrupted: stop after two turns, keeping the last checkpoint.
    const checkpoints: LoopCheckpoint[] = [];
    const partial = new ScriptedTransport(SCRIPT.slice(0, 2));
    await runLoop({
      ...base,
      transport: partial,
      maxTurns: 2,
      onCheckpoint: (c) => checkpoints.push(c),
    });
    const last = checkpoints[checkpoints.length - 1]!;
    expect(last.inFlightTool).toBeUndefined();

    // Resumed: continue from that checkpoint.
    const resumed = new ScriptedTransport(SCRIPT.slice(2));
    await runLoop({ ...base, transport: resumed, resume: last });

    // The third request of the straight run is the first of the resumed one.
    const expected = straight.seen[2]!;
    const actual = resumed.seen[0]!;
    expect(requestDigest(actual)).toBe(requestDigest(expected));
  });

  it("keeps the transcript, not just the task", async () => {
    const checkpoints: LoopCheckpoint[] = [];
    await runLoop({
      ...base,
      transport: new ScriptedTransport(SCRIPT.slice(0, 1)),
      maxTurns: 1,
      onCheckpoint: (c) => checkpoints.push(c),
    });
    const last = checkpoints[checkpoints.length - 1]!;
    const roles = last.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(last.messages[2]!.reasoning_content).toBe("orient");
  });

  it("keeps a pending done proposal across the interruption", async () => {
    // Resuming into a fresh loop would forget the challenge, so the model's
    // next `done` would be read as a first proposal and challenged again.
    const checkpoints: LoopCheckpoint[] = [];
    await runLoop({
      ...base,
      transport: new ScriptedTransport([doneBody("renamed it")]),
      maxTurns: 1,
      onCheckpoint: (c) => checkpoints.push(c),
    });
    const last = checkpoints[checkpoints.length - 1]!;
    expect(last.pendingDone).toBe("renamed it");

    const resumed = new ScriptedTransport([doneBody("renamed it", { confirm: true })]);
    const r = await runLoop({ ...base, transport: resumed, resume: last });
    expect(r.reason).toBe("done");
    expect(r.turns).toBe(2);
  });

  it("keeps the breakage budget and the loop guard", async () => {
    const checkpoints: LoopCheckpoint[] = [];
    await runLoop({
      ...base,
      transport: new ScriptedTransport(["</think>nothing useful here"]),
      maxTurns: 1,
      onCheckpoint: (c) => checkpoints.push(c),
    });
    const last = checkpoints[checkpoints.length - 1]!;
    // The turn produced no action, so the failure is already counted — and the
    // limits travel with the counts, because a budget restored under different
    // limits is a different budget.
    expect(last.breakage.state.failures).toBe(1);
    expect(last.breakage.options.hardLimit).toBe(20);
    expect(last.loopGuard.options.repeatLimit).toBe(3);
  });

  it("keeps call ids unique across the interruption", async () => {
    // A module-global counter restarted from 1 on resume and collided with ids
    // already in the transcript.
    const checkpoints: LoopCheckpoint[] = [];
    await runLoop({
      ...base,
      transport: new ScriptedTransport(SCRIPT.slice(0, 1)),
      maxTurns: 1,
      onCheckpoint: (c) => checkpoints.push(c),
    });
    const last = checkpoints[checkpoints.length - 1]!;
    expect(last.nextCallSequence).toBe(2);

    // The checkpoint's turn counter is already 1, so the resumed run needs
    // room for turn 2 — the budget is global, not per-attempt.
    const resumed = new ScriptedTransport(SCRIPT.slice(1, 2));
    await runLoop({ ...base, transport: resumed, resume: last, maxTurns: 2 });
    const ids = resumed.seen[0]!.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("an uncertain command is not re-run", () => {
  it("records the intent before the tool runs", async () => {
    const checkpoints: LoopCheckpoint[] = [];
    await runLoop({
      ...base,
      transport: new ScriptedTransport(SCRIPT.slice(0, 1)),
      maxTurns: 1,
      onCheckpoint: (c) => checkpoints.push(c),
    });
    const withIntent = checkpoints.filter((c) => c.inFlightTool !== undefined);
    expect(withIntent).toHaveLength(1);
    expect(withIntent[0]!.inFlightTool).toMatchObject({ name: "bash", mutating: true });
    // Cleared afterwards, so a checkpoint that still holds one means the
    // process died mid-command.
    expect(checkpoints[checkpoints.length - 1]!.inFlightTool).toBeUndefined();
  });

  it("classifies which tools can change the world", () => {
    for (const t of ["bash", "write", "apply_patch", "term", "task", "mcp"]) {
      expect(isMutating(t), t).toBe(true);
    }
    for (const t of ["read", "skill", "done"]) {
      expect(isMutating(t), t).toBe(false);
    }
  });

  it("blocks a resume whose mutating tool was in flight", () => {
    const cp = {
      inFlightTool: { id: "root-c1", name: "apply_patch", argumentsHash: "x", mutating: true },
    } as LoopCheckpoint;
    expect(resumeBlock(cp, null)).toMatchObject({ kind: "execution_uncertain", tool: "apply_patch" });
  });

  it.each([
    ["write", false],
    ["write", true],
    ["apply_patch", false],
    ["custom_mutation", true],
  ] as const)("blocks in-flight %s with recorded mutating=%s", (name, mutating) => {
    const cp = {
      inFlightTool: { id: "root-c1", name, argumentsHash: "x", mutating },
    } as LoopCheckpoint;
    expect(resumeBlock(cp, null)).toEqual({ kind: "execution_uncertain", tool: name, id: "root-c1" });
    // A classification correction must not override compatibility checks.
    expect(resumeBlock(cp, "schema changed")).toEqual({ kind: "incompatible", detail: "schema changed" });
  });

  it("allows a resume whose in-flight tool only read", () => {
    const cp = {
      inFlightTool: { id: "root-c1", name: "read", argumentsHash: "x", mutating: false },
    } as LoopCheckpoint;
    expect(resumeBlock(cp, null)).toBeNull();
  });
});

describe("compatibility is checked fail-closed", () => {
  const recorded = {
    toolSchemaHash: "a",
    systemPromptHash: "b",
    model: "Motif-3",
    channelPolicy: "fixed",
    protocolVersion: 2,
  };

  it("accepts an identical configuration", () => {
    expect(compatibilityProblem(recorded, { ...recorded })).toBeNull();
  });

  for (const [field, value] of [
    ["toolSchemaHash", "different"],
    ["systemPromptHash", "different"],
    ["model", "other"],
    ["channelPolicy", "adaptive"],
    ["protocolVersion", 1],
  ] as const) {
    it(`refuses a changed ${field}`, () => {
      expect(compatibilityProblem(recorded, { ...recorded, [field]: value })).not.toBeNull();
    });
  }
});
