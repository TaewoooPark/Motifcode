/**
 * The agent loop, driven entirely by injected faults.
 *
 * There is no Motif-3 endpoint to test against, and the behaviours worth
 * testing are the ones that only appear when the model misbehaves. So every
 * documented failure becomes a fault we inject on purpose, and the loop's
 * response to it becomes an assertion. This is the part of the plan that said
 * the fragile, Motif-specific logic could be settled on a laptop.
 */

import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import { FaultTransport, ScriptedTransport, doneBody, toolCallBody } from "@motifcode/replay";
import {
  EmptyTaskError,
  TransportError,
  runLoop,
  resetIds,
  clampOutput,
  type Executor,
  type LoopEvent,
} from "../src/index.js";

function collect() {
  const events: LoopEvent[] = [];
  return { events, emit: (e: LoopEvent) => events.push(e) };
}

const okExecutor: Executor = { run: async () => ({ ok: true, output: "ok" }) };
const failExecutor: Executor = { run: async () => ({ ok: false, output: "error: no such file" }) };

const TASK = "fix the failing test in src/parse.ts";
const base = { tools: [...CORE_TOOLS], system: () => "You are motifcode.", userTask: TASK };

function kinds(events: LoopEvent[], type: LoopEvent["type"]) {
  return events.filter((e) => e.type === type);
}

describe("the task reaches the model", () => {
  it("opens the conversation with system then the exact user task", async () => {
    // The whole harness is downstream of this. A first request that carries
    // only a system turn asks the model to work on nothing, and every
    // trajectory, benchmark row and profiling document built on top of it
    // inherits that while still looking like a real run.
    const { emit } = collect();
    const transport = new ScriptedTransport([doneBody("x"), doneBody("x", { confirm: true })]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });

    const first = transport.seen[0]!;
    expect(first.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(first.messages[1]!.content).toBe(TASK);
  });

  it("keeps the task byte-for-byte, including newlines and non-ASCII", async () => {
    const task = "패치를 적용해줘:\n\n```\n\\$HOME\t<tag> & \"quote\"\n```\n";
    const { emit } = collect();
    const transport = new ScriptedTransport([doneBody("x"), doneBody("x", { confirm: true })]);
    await runLoop({ ...base, userTask: task, transport, executor: okExecutor, emit });
    expect(transport.seen[0]!.messages[1]!.content).toBe(task);
  });

  it("keeps the task out of the system turn", async () => {
    // Folding user text into the system role erases the boundary a
    // prompt-injection defence depends on, and gives every session its own
    // system prefix — which is the cached prefix, gone.
    const { emit } = collect();
    const transport = new ScriptedTransport([doneBody("x"), doneBody("x", { confirm: true })]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(String(transport.seen[0]!.messages[0]!.content)).not.toContain(TASK);
  });

  it("refuses a blank task before any request is made", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([doneBody("x")]);
    await expect(
      runLoop({ ...base, userTask: "   \n ", transport, executor: okExecutor, emit }),
    ).rejects.toBeInstanceOf(EmptyTaskError);
    expect(transport.seen).toHaveLength(0);
  });
});

describe("happy path", () => {
  it("runs a tool then finishes on confirmed done", async () => {
    resetIds();
    const { events, emit } = collect();
    const transport = new ScriptedTransport([
      toolCallBody("bash", { command: "ls" }, { reasoning: "look around" }),
      doneBody("listed the directory"),
      doneBody("listed the directory", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(r.reason).toBe("done");
    expect(r.summary).toBe("listed the directory");
    expect(kinds(events, "tool_start")).toHaveLength(1);
  });

  it("requires done twice — a single claim is not enough", async () => {
    // Terminus 2 asks for confirmation before grading, and so do we: a
    // hallucinated completion should cost one turn, not the task.
    const { events, emit } = collect();
    const transport = new ScriptedTransport([doneBody("all set"), toolCallBody("bash", { command: "ls" }), doneBody("really done"), doneBody("really done", { confirm: true })]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(r.reason).toBe("done");
    expect(transport.seen.length).toBeGreaterThan(2);
  });

  it("preserves reasoning into history", async () => {
    // The chat template renders intermediate reasoning when tools are
    // registered; dropping it here would put the model off its own
    // distribution.
    const { emit } = collect();
    const transport = new ScriptedTransport([
      toolCallBody("bash", { command: "ls" }, { reasoning: "REASONING-MARKER" }),
      doneBody("x"),
      doneBody("x", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });
    const second = transport.seen[1]!;
    const assistant = second.messages.find((m) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBe("REASONING-MARKER");
  });
});

describe("malformed output", () => {
  it("repairs invalid escapes rather than losing the turn", async () => {
    // `\$HOME` and `\s` are not JSON escapes. This is the failure the vendor's
    // own parser comments single out, and it must not cost a turn.
    const { events, emit } = collect();
    const inner = new ScriptedTransport([
      toolCallBody("bash", { command: "grep x f" }),
      doneBody("done"),
      doneBody("done", { confirm: true }),
    ]);
    const transport = new FaultTransport(inner, [{ at: [1], kind: "bad_escape" }]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(r.reason).toBe("done");
    const started = kinds(events, "tool_start");
    expect(started).toHaveLength(1);
    expect((started[0] as Extract<LoopEvent, { type: "tool_start" }>).call.repaired).toBe(true);
  });

  it("treats an unparseable turn as unfinished, not as an answer", async () => {
    // The silent killer: stock parsers drop the turn and leave tool syntax in
    // `content`, which reads as a final reply. The loop must re-prompt.
    const { events, emit } = collect();
    const inner = new ScriptedTransport([
      toolCallBody("bash", { command: "ls" }),
      toolCallBody("bash", { command: "ls" }),
      doneBody("done"),
      doneBody("done", { confirm: true }),
    ]);
    const transport = new FaultTransport(inner, [{ at: [1], kind: "corrupt" }]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(r.reason).toBe("done");
    expect(kinds(events, "parse_failure").length).toBeGreaterThan(0);
    expect(kinds(events, "repair").length).toBeGreaterThan(0);
  });

  it("recovers a truncated tool call", async () => {
    const { emit } = collect();
    const inner = new ScriptedTransport([
      toolCallBody("bash", { command: "ls -la /very/long/path" }),
      doneBody("done"),
      doneBody("done", { confirm: true }),
    ]);
    const transport = new FaultTransport(inner, [{ at: [1], kind: "truncate" }]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(r.reason).toBe("done");
  });

  it("does not mistake an empty body for completion", async () => {
    // An empty turn is the shape a dropped tool call takes once the stock
    // parser has given up. It must re-prompt, not finish — and then the session
    // is expected to carry on to a real completion.
    const { events, emit } = collect();
    const inner = new ScriptedTransport(
      [toolCallBody("bash", { command: "ls" }), doneBody("d"), doneBody("d", { confirm: true })],
      false,
    );
    const transport = new FaultTransport(inner, [{ at: [1], kind: "empty" }]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(kinds(events, "repair").length).toBeGreaterThan(0);
    // Turn 1 produced nothing usable, so completion cannot have happened there.
    expect(r.turns).toBeGreaterThan(1);
    expect(r.reason).toBe("done");
  });
});

describe("a turn that announces an action and then stops", () => {
  // The single most common way this model loses a turn, measured over a
  // polyglot campaign: 135 turns produced no action at all, a median of 37
  // completion tokens each, and the content was a sentence like "Let me write
  // the file directly:" with nothing after it. Left alone it compounds — a
  // no-action turn was followed by another 55.7% of the time against 20.6%
  // after a turn that acted — because the failed turn and an identical
  // instruction went into history, and the model imitated the pattern.
  const ANNOUNCE = "Let me write the file directly:";

  it("gives up on a task that has stopped acting instead of spending every turn", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([ANNOUNCE], true);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit, maxTurns: 25 });
    expect(r.reason).toBe("no_action_limit");
    // Four turns, not twenty-five. The longest run seen before this guard was
    // eleven, every one of them a full model request.
    expect(r.turns).toBe(4);
  });

  it("counts consecutively, so one bad turn among good ones costs nothing", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport(
      [ANNOUNCE, toolCallBody("bash", { command: "ls" }), ANNOUNCE],
      true,
    );
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit, maxTurns: 25 });
    expect(r.reason).toBe("no_action_limit");
    // 1 announce, 1 tool call that resets the count, then four more.
    expect(r.turns).toBe(6);
  });

  it("does not let the history grow a pattern to imitate", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([ANNOUNCE], true);
    await runLoop({ ...base, transport, executor: okExecutor, emit, maxTurns: 25 });
    const sizes = transport.seen.map((r) => r.messages?.length ?? 0);
    // The first failure adds the turn and one instruction. Every later one
    // replaces the instruction in place, so the conversation stops growing.
    expect(sizes[1]).toBeGreaterThan(sizes[0]!);
    expect(sizes[2]).toBe(sizes[1]);
    expect(sizes[3]).toBe(sizes[1]);
  });

  it("escalates what it says instead of repeating itself", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([ANNOUNCE], true);
    await runLoop({ ...base, transport, executor: okExecutor, emit, maxTurns: 25 });
    const nudge = (i: number) => String(transport.seen[i]?.messages?.at(-1)?.content ?? "");
    // Second attempt names the behaviour rather than the syntax rules.
    expect(nudge(2)).toMatch(/Do not announce/);
    // Third asks for the action alone.
    expect(nudge(3)).toMatch(/nothing else/);
    expect(nudge(1)).not.toMatch(/Do not announce/);
  });

  it("shows the model the tool output it was responding to", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport(
      [toolCallBody("bash", { command: "pytest" }), ANNOUNCE],
      true,
    );
    const executor: Executor = { run: async () => ({ ok: false, output: "E   assert 1 == 2" }) };
    await runLoop({ ...base, transport, executor, emit, maxTurns: 25 });
    const escalated = transport.seen
      .map((r) => String(r.messages?.at(-1)?.content ?? ""))
      .filter((c) => /Do not announce/.test(c));
    expect(escalated.length).toBeGreaterThan(0);
    // An instruction that only restates the format gives a stuck model nothing
    // to act on.
    expect(escalated[0]).toContain("assert 1 == 2");
  });
});

describe("the action gate", () => {
  /** An executor that records every call it is asked to run. */
  function spy(): { calls: string[]; executor: Executor } {
    const calls: string[] = [];
    return {
      calls,
      executor: {
        run: async (c) => {
          calls.push(c.name);
          return { ok: true, output: "ok" };
        },
      },
    };
  }

  const raw = (body: string) => ({ content: body, rawText: body, ms: 1 });
  const block = (obj: unknown) => `</think><tool_call>${JSON.stringify(obj)}</tool_call>`;

  it("runs nothing when one call in a batch is schema-invalid", async () => {
    // All-or-nothing. A turn that asks for three things and gets one wrong
    // leaves the tree in a state neither side can describe: two edits applied,
    // one not, and a repair prompt that cannot say which.
    const { calls, executor } = spy();
    const { emit } = collect();
    const transport = new ScriptedTransport([
      raw(
        block({ name: "bash", arguments: { command: "echo one" } }) +
          block({ name: "bash", arguments: { command: 42 } }),
      ),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor, emit });
    expect(calls).toEqual([]);
  });

  it("refuses a call with a missing required argument", async () => {
    const { calls, executor } = spy();
    const { events, emit } = collect();
    const transport = new ScriptedTransport([
      raw(block({ name: "bash", arguments: {} })),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor, emit });
    expect(calls).toEqual([]);
    const failures = kinds(events, "parse_failure") as Extract<LoopEvent, { type: "parse_failure" }>[];
    expect(failures.some((f) => f.kind === "rejected")).toBe(true);
  });

  it("refuses an unregistered tool before it reaches the executor", async () => {
    const { calls, executor } = spy();
    const { emit } = collect();
    const transport = new ScriptedTransport([
      raw(block({ name: "curl", arguments: { url: "http://x" } })),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor, emit });
    expect(calls).toEqual([]);
  });

  it("refuses a batch whose payload was only closed by the bracket balancer", async () => {
    // A command cut off mid-word balances as cleanly as a whole one, and the
    // difference is the part of the command that is missing.
    const { calls, executor } = spy();
    const { emit } = collect();
    const transport = new ScriptedTransport([
      raw('</think><tool_call>{"name": "bash", "arguments": {"command": "rm -rf /tmp/build-ca</tool_call>'),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor, emit });
    expect(calls).toEqual([]);
  });

  it("refuses everything when the response hit the output token cap", async () => {
    const { calls, executor } = spy();
    const { emit } = collect();
    const transport = new ScriptedTransport([
      { ...raw(block({ name: "bash", arguments: { command: "ls" } })), finishReason: "length" },
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor, emit });
    expect(calls).toEqual([]);
  });

  it("runs a re-emitted call exactly once after a refusal", async () => {
    const { calls, executor } = spy();
    const { emit } = collect();
    const transport = new ScriptedTransport([
      raw(
        block({ name: "bash", arguments: { command: "echo good" } }) +
          block({ name: "bash", arguments: { command: null } }),
      ),
      raw(block({ name: "bash", arguments: { command: "echo good" } })),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor, emit });
    expect(calls).toEqual(["bash"]);
  });

  it("refuses done mixed with other actions", async () => {
    const { calls, executor } = spy();
    const { emit } = collect();
    const transport = new ScriptedTransport([
      raw(
        block({ name: "bash", arguments: { command: "ls" } }) +
          block({ name: "done", arguments: { summary: "and finished" } }),
      ),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor, emit });
    expect(calls).toEqual([]);
    expect(r.turns).toBeGreaterThan(1);
  });

  it("does not execute a server-extracted call whose arguments did not decode", async () => {
    // "We still know which tool was meant" turns a broken bash call into bash
    // with an empty command.
    const { calls, executor } = spy();
    const { emit } = collect();
    const transport = new ScriptedTransport([
      {
        content: "",
        rawText: "",
        ms: 1,
        toolCalls: [{ id: "s1", type: "function" as const, function: { name: "bash", arguments: "{not json" } }],
      },
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor, emit });
    expect(calls).toEqual([]);
  });
});

describe("the done contract", () => {
  const okExec: Executor = { run: async () => ({ ok: true, output: "ok" }) };

  it("does not end on a second done with no confirm flag", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport(
      [doneBody("all set"), doneBody("all set"), doneBody("all set"), doneBody("all set", { confirm: true })],
    );
    const r = await runLoop({ ...base, transport, executor: okExec, emit, maxTurns: 6 });
    expect(r.reason).toBe("done");
    // Three unconfirmed proposals had to pass before the confirmed one.
    expect(r.turns).toBe(4);
  });

  it("does not end on confirm: false", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([
      doneBody("all set"),
      toolCallBody("done", { summary: "all set", confirm: false }),
      doneBody("all set", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExec, emit, maxTurns: 6 });
    expect(r.reason).toBe("done");
    expect(r.turns).toBe(3);
  });

  it("does not end when the confirmed summary is a different claim", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([
      doneBody("fixed the parser"),
      toolCallBody("done", { summary: "fixed everything, shipped it", confirm: true }),
      doneBody("fixed the parser"),
      doneBody("fixed the parser", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExec, emit, maxTurns: 8 });
    expect(r.reason).toBe("done");
    expect(r.summary).toBe("fixed the parser");
    expect(r.turns).toBe(4);
  });

  it("tolerates reflowed whitespace in the confirmed summary", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([
      doneBody("fixed   the\nparser"),
      toolCallBody("done", { summary: "fixed the parser", confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExec, emit, maxTurns: 4 });
    expect(r.reason).toBe("done");
  });

  it("still challenges a first done that already says confirm: true", async () => {
    // The flag answers a question the harness has not asked yet. Accepting it
    // makes the confirmation step decorative.
    const { emit } = collect();
    const transport = new ScriptedTransport([
      doneBody("done immediately", { confirm: true }),
      doneBody("done immediately", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExec, emit, maxTurns: 4 });
    expect(r.reason).toBe("done");
    expect(r.turns).toBe(2);
  });

  it("withdraws a pending proposal when the model goes back to work", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([
      doneBody("nearly"),
      toolCallBody("bash", { command: "ls" }),
      doneBody("nearly", { confirm: true }),
      doneBody("nearly"),
      doneBody("nearly", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExec, emit, maxTurns: 8 });
    expect(r.reason).toBe("done");
    // Turn 3's confirmation had nothing to confirm, so it became a fresh
    // proposal and needed its own confirmation.
    expect(r.turns).toBe(5);
  });
});

describe("channel policy", () => {
  const corrupted = () => {
    const inner = new ScriptedTransport([toolCallBody("bash", { command: "ls" })], true);
    return new FaultTransport(inner, [{ at: [1, 2, 3, 4, 5, 6], kind: "corrupt" }]);
  };

  it("moves off toolcall after repeated parse failures when adaptive", async () => {
    // The point is not to keep trying the channel that is failing — it is to
    // move to one that cannot fail that way, which is the whole reason three
    // channels exist.
    const { events, emit } = collect();
    const r = await runLoop({
      ...base,
      transport: corrupted(),
      executor: okExecutor,
      emit,
      maxTurns: 8,
      channelPolicy: "adaptive",
    });
    const downgrades = kinds(events, "channel_downgrade") as Extract<
      LoopEvent,
      { type: "channel_downgrade" }
    >[];
    expect(downgrades.length).toBeGreaterThan(0);
    expect(downgrades[0]!.from).toBe("toolcall");
    expect(downgrades[0]!.to).toBe("object");
    // Grouping stays with the channel the run started in: reclassifying an
    // adaptive run by where it ended up would compare it against runs that
    // never had the chance to move.
    expect(r.initialChannel).toBe("toolcall");
    expect(r.transitions[0]).toMatchObject({ from: "toolcall", to: "object" });
  });

  it("never changes channel under the fixed policy", async () => {
    // Every benchmark runs fixed. A run that silently switched protocol
    // mid-flight would be two experiments reported as one.
    const { events, emit } = collect();
    const r = await runLoop({
      ...base,
      transport: corrupted(),
      executor: okExecutor,
      emit,
      maxTurns: 8,
    });
    expect(kinds(events, "channel_downgrade")).toHaveLength(0);
    expect(r.transitions).toEqual([]);
    expect(r.channel).toBe("toolcall");
  });

  it("restarts the transcript rather than translating it", async () => {
    // The old transcript is written in a format the new channel does not use.
    // Dressing it up as the new one would show the model a conversation it
    // never had.
    const { emit } = collect();
    const inner = new ScriptedTransport([toolCallBody("bash", { command: "ls" })], true);
    const transport = new FaultTransport(inner, [{ at: [1, 2, 3, 4, 5, 6], kind: "corrupt" }]);
    await runLoop({
      ...base,
      // The system turn is a function of the channel, exactly as it is in the
      // CLI: after a switch the old prompt would still be instructing the model
      // in a format the parser no longer reads.
      system: (ch) => `You are motifcode. Answer in the ${ch} format.`,
      transport,
      executor: okExecutor,
      emit,
      maxTurns: 6,
      channelPolicy: "adaptive",
    });
    const afterSwitch = inner.seen.find((r) => r.raw === true);
    expect(afterSwitch, "the object channel drives the completions endpoint").toBeDefined();
    expect(afterSwitch!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(String(afterSwitch!.messages[1]!.content)).toContain(TASK);
    expect(String(afterSwitch!.messages[0]!.content)).toContain("object format");
    expect(String(afterSwitch!.messages[0]!.content)).not.toContain("toolcall format");
  });
});

describe("repair turn", () => {
  it("hands execution output back after a tool failure", async () => {
    // One repair turn erased a 2-bit quantisation penalty in the pruning
    // literature, and compressed models gained more from it than intact ones.
    // We ship a pruned model, so this loop is not optional.
    const { events, emit } = collect();
    const transport = new ScriptedTransport(
      [
        toolCallBody("bash", { command: "cat missing" }),
        toolCallBody("bash", { command: "ls" }),
        doneBody("d"),
        doneBody("d", { confirm: true }),
      ],
    );
    let calls = 0;
    const executor: Executor = {
      run: async () => {
        calls++;
        return calls === 1 ? { ok: false, output: "no such file" } : { ok: true, output: "ok" };
      },
    };
    const r = await runLoop({ ...base, transport, executor, emit });
    expect(r.reason).toBe("done");
    const repairs = kinds(events, "repair") as Extract<LoopEvent, { type: "repair" }>[];
    expect(repairs.some((x) => x.reason === "tool failure")).toBe(true);
  });
});

describe("loop detection", () => {
  it("stops when the same action repeats with the same result", async () => {
    // Motif's chat teacher was trained against repetition as an explicit
    // anti-pattern, which means it is a real behaviour to guard against.
    const { events, emit } = collect();
    const transport = new ScriptedTransport([toolCallBody("bash", { command: "ls" })], true);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit, maxTurns: 20 });
    expect(r.reason).toBe("loop_detected");
    expect(kinds(events, "loop_detected")).toHaveLength(1);
  });
});

describe("server death", () => {
  it("retries a 5xx without losing the session", async () => {
    // vLLM on GB10 has open reports of fatal engine errors. Mid-session death
    // is expected, so it is a retry, not a crash.
    const { events, emit } = collect();
    const { TransportError } = await import("../src/transport.js");
    const transport = new ScriptedTransport([
      new TransportError("engine core died", { kind: "http", status: 500 }),
      toolCallBody("bash", { command: "ls" }),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(r.reason).toBe("done");
    const warns = kinds(events, "notice") as Extract<LoopEvent, { type: "notice" }>[];
    expect(warns.some((w) => w.level === "warn" && /retry 1\/3/.test(w.text))).toBe(true);
  });

  it("gives up after the retry budget", async () => {
    const { emit } = collect();
    const { TransportError } = await import("../src/transport.js");
    const transport = new ScriptedTransport([new TransportError("dead", { kind: "http", status: 500 })], true);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit, maxServerRetries: 2 });
    expect(r.reason).toBe("transport_error");
  });
});

describe("prefix reporting", () => {
  it("reports a long shared prefix once the session is under way", async () => {
    const { events, emit } = collect();
    const transport = new ScriptedTransport([
      toolCallBody("bash", { command: "ls" }),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });
    const prefixes = kinds(events, "prefix") as Extract<LoopEvent, { type: "prefix" }>[];
    expect(prefixes.length).toBeGreaterThan(1);
    const later = prefixes[prefixes.length - 1]!;
    // The tools block and system turn are unchanged, so most of the prompt is
    // reused — which is exactly what freezing the tool list buys.
    expect(later.sharedChars / later.totalChars).toBeGreaterThan(0.5);
  });
});

describe("output clamping", () => {
  it("keeps the head and the tail", () => {
    const text = "A".repeat(4000) + "MIDDLE" + "B".repeat(4000);
    const out = clampOutput(text, 1000);
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).toContain("bytes omitted");
    expect(out).not.toContain("MIDDLE");
  });

  it("leaves short output alone", () => {
    expect(clampOutput("short", 1000)).toBe("short");
  });
});

describe("history on the native channel", () => {
  // What a correctly served Motif-3 returns: an empty body, the call lifted
  // out into `tool_calls`. Everything the model knows about its own previous
  // turn has to come from what the harness writes back.
  const structured = (name: string, args: Record<string, unknown>) => ({
    content: "",
    rawText: "",
    ms: 1,
    toolCalls: [{ id: "srv-1", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
  });

  it("carries the call in the assistant turn, with the id its result answers", async () => {
    // Without this the second request showed an empty assistant turn followed
    // by a tool response — a reply to a call that was not there.
    const { emit } = collect();
    const transport = new ScriptedTransport([
      structured("bash", { command: "ls" }),
      structured("done", { summary: "s" }),
      structured("done", { summary: "s", confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });
    const second = transport.seen[1]!.messages;
    const assistant = second.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls![0]!.function).toEqual({ name: "bash", arguments: { command: "ls" } });
    const tool = second.find((m) => m.role === "tool")!;
    expect(tool.tool_call_id).toBe(assistant.tool_calls![0]!.id);
    expect(tool.content).toBe("ok");
  });

  it("shows the model the batch it refused, so it can correct it", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([
      structured("bash", { command: 42 }),
      structured("done", { summary: "s" }),
      structured("done", { summary: "s", confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });
    const second = transport.seen[1]!.messages;
    const assistant = second.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls?.[0]?.function?.name).toBe("bash");
    // Then the refusal, as a user turn, and no tool result — nothing ran.
    expect(second[second.length - 1]!.role).toBe("user");
    expect(String(second[second.length - 1]!.content)).toContain("None of the actions");
    expect(second.some((m) => m.role === "tool")).toBe(false);
  });

  it("shows the done proposal the confirmation challenge refers to", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([
      structured("done", { summary: "all green" }),
      structured("done", { summary: "all green", confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });
    const second = transport.seen[1]!.messages;
    const assistant = second.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls?.[0]?.function).toEqual({ name: "done", arguments: { summary: "all green" } });
  });

  it("assigns ids from the scope's own sequence, not the server's", async () => {
    // The server's ids are its own bookkeeping; a resumed session must not
    // collide with them, and two servers may reuse them.
    const { emit } = collect();
    const transport = new ScriptedTransport([
      structured("bash", { command: "ls" }),
      structured("done", { summary: "s" }),
      structured("done", { summary: "s", confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });
    const assistant = transport.seen[1]!.messages.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls![0]!.id).toMatch(/^root-c\d+$/);
  });
});

describe("continuing a conversation", () => {
  it("puts the history before the task and hands the transcript back", async () => {
    // The interactive session: the second task sees the first and everything
    // the model did about it, and gets back what to pass to the third.
    const { emit } = collect();
    const first = new ScriptedTransport([doneBody("one"), doneBody("one", { confirm: true })]);
    const a = await runLoop({ ...base, transport: first, executor: okExecutor, emit });
    expect(a.transcript[0]!.role).toBe("system");

    const second = new ScriptedTransport([doneBody("two"), doneBody("two", { confirm: true })]);
    const b = await runLoop({
      ...base,
      userTask: "and now this",
      history: a.transcript.slice(1),
      transport: second,
      executor: okExecutor,
      emit,
    });
    const roles = second.seen[0]!.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    expect(second.seen[0]!.messages[1]!.content).toBe(TASK);
    expect(second.seen[0]!.messages[5]!.content).toBe("and now this");
    expect(b.transcript.length).toBeGreaterThan(a.transcript.length);
  });

  it("records the confirming done turn before ending", async () => {
    // Otherwise the transcript stopped at the harness's challenge, and a
    // conversation continued from it showed the model asked to confirm and
    // never answering.
    const { emit } = collect();
    const checkpoints: { messages: { role: string }[] }[] = [];
    const transport = new ScriptedTransport([doneBody("s"), doneBody("s", { confirm: true })]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit, onCheckpoint: (c) => checkpoints.push(c) });
    const last = r.transcript[r.transcript.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.tool_calls?.[0]?.function).toEqual({ name: "done", arguments: { summary: "s", confirm: true } });
    expect(checkpoints[checkpoints.length - 1]!.messages.length).toBe(r.transcript.length);
  });

  it("hands back what it had when interrupted", async () => {
    const { emit } = collect();
    const ac = new AbortController();
    const transport = new ScriptedTransport([
      toolCallBody("bash", { command: "ls" }),
      new TransportError("stopped", { kind: "aborted" }),
    ]);
    const executor: Executor = {
      run: async () => {
        ac.abort();
        return { ok: true, output: "a.txt" };
      },
    };
    const r = await runLoop({ ...base, transport, executor, emit, signal: ac.signal });
    expect(r.reason).toBe("aborted");
    expect(r.transcript.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });
});

describe("the conversational ending", () => {
  it("ends on a reply with no action when asked to, with the prose as the summary", async () => {
    // A greeting gets a greeting. Off, the same turn is handed back.
    const { emit } = collect();
    const transport = new ScriptedTransport(["</think>안녕하세요! 무엇을 도와드릴까요?"]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit, replyEnds: true });
    expect(r.reason).toBe("done");
    expect(r.summary).toBe("안녕하세요! 무엇을 도와드릴까요?");
    expect(r.transcript.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(transport.seen).toHaveLength(1);
  });

  it("still hands back a turn whose action syntax leaked, even in a conversation", async () => {
    const { events, emit } = collect();
    const transport = new ScriptedTransport([
      '</think><tool_call>{"name": "bash", "arguments": {"command": "ls',
      doneBody("d"),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit, replyEnds: true, confirmDone: false });
    expect(r.reason).toBe("done");
    expect(transport.seen).toHaveLength(2);
    expect(kinds(events, "repair").length).toBeGreaterThan(0);
  });

  it("takes the first done as final when confirmation is off", async () => {
    const { emit } = collect();
    const transport = new ScriptedTransport([doneBody("finished")]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit, confirmDone: false });
    expect(r.reason).toBe("done");
    expect(r.summary).toBe("finished");
    const last = r.transcript[r.transcript.length - 1]!;
    expect(last.tool_calls?.[0]?.function).toEqual({ name: "done", arguments: { summary: "finished" } });
  });
});

describe("server-extracted tool calls", () => {
  it("uses tool_calls the server lifted out of the body", async () => {
    // A server running a tool-call parser — which is what
    // `--tool-call-parser motif` makes vLLM do — returns the calls
    // structured and leaves only prose in `content`. Reading `content` alone
    // means every turn looks empty, so the harness would report a failure that
    // never happened, on its own target. The mock in the first end-to-end run
    // happened to imitate a server *without* the parser, which is why this got
    // as far as it did.
    const { events, emit } = collect();
    const structured = (name: string, args: Record<string, unknown>) => ({
      content: "",
      rawText: "",
      ms: 1,
      toolCalls: [{ id: "s1", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
    });
    const transport = new ScriptedTransport([
      structured("bash", { command: "ls" }),
      structured("done", { summary: "listed" }),
      structured("done", { summary: "listed", confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(r.reason).toBe("done");
    const started = kinds(events, "tool_start") as Extract<LoopEvent, { type: "tool_start" }>[];
    expect(started).toHaveLength(1);
    expect(started[0]!.call.arguments).toEqual({ command: "ls" });
  });

  it("accepts arguments as an object as well as a string", async () => {
    const { events, emit } = collect();
    const transport = new ScriptedTransport([
      {
        content: "",
        rawText: "",
        ms: 1,
        toolCalls: [{ type: "function" as const, function: { name: "bash", arguments: { command: "pwd" } } }],
      },
      doneBody("ok"),
      doneBody("ok", { confirm: true }),
    ]);
    await runLoop({ ...base, transport, executor: okExecutor, emit });
    const started = kinds(events, "tool_start") as Extract<LoopEvent, { type: "tool_start" }>[];
    expect(started[0]!.call.arguments).toEqual({ command: "pwd" });
  });

  it("sends tool call arguments back as a JSON string", async () => {
    // The wire format says `arguments` is a string, and servers enforce it —
    // sending an object fails the request on the turn *after* the first tool
    // call, which is late enough to look like a model problem rather than ours.
    const seen: unknown[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { HttpTransport } = await import("../src/transport.js");
    const t = new HttpTransport({ endpoint: "http://x", model: "Motif-3", fetchImpl });
    await t.complete({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: { command: "ls" } } }],
        },
      ],
      tools: [],
    });
    const body = seen[0] as { messages: { tool_calls?: { function: { arguments: unknown } }[] }[] };
    const args = body.messages[1]!.tool_calls![0]!.function.arguments;
    expect(typeof args).toBe("string");
    expect(JSON.parse(args as string)).toEqual({ command: "ls" });
  });

  it("puts the server's error text in the thrown message", async () => {
    // "400 Bad Request" on its own tells nobody anything; the server almost
    // always names the field it rejected.
    const fetchImpl = (async () =>
      new Response('{"error":{"message":"cannot unmarshal object into field arguments"}}', {
        status: 400,
        statusText: "Bad Request",
      })) as unknown as typeof fetch;
    const { HttpTransport } = await import("../src/transport.js");
    const t = new HttpTransport({ endpoint: "http://x", model: "m", fetchImpl });
    await expect(t.complete({ messages: [], tools: [] })).rejects.toThrow(/cannot unmarshal/);
  });
});
