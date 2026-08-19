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
import { runLoop, resetIds, clampOutput, type Executor, type LoopEvent } from "../src/index.js";

function collect() {
  const events: LoopEvent[] = [];
  return { events, emit: (e: LoopEvent) => events.push(e) };
}

const okExecutor: Executor = { run: async () => ({ ok: true, output: "ok" }) };
const failExecutor: Executor = { run: async () => ({ ok: false, output: "error: no such file" }) };

const base = { tools: [...CORE_TOOLS], system: "You are motifcode." };

function kinds(events: LoopEvent[], type: LoopEvent["type"]) {
  return events.filter((e) => e.type === type);
}

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

describe("channel downgrade", () => {
  it("moves off toolcall after repeated parse failures", async () => {
    // Two consecutive failures is the trigger. The point is not to keep trying
    // the channel that is failing — it is to move to one that cannot fail that
    // way, which is the whole reason three channels exist.
    const { events, emit } = collect();
    const inner = new ScriptedTransport([toolCallBody("bash", { command: "ls" })], true);
    const transport = new FaultTransport(inner, [{ at: [1, 2, 3, 4, 5, 6], kind: "corrupt" }]);
    await runLoop({ ...base, transport, executor: okExecutor, emit, maxTurns: 8 });
    const downgrades = kinds(events, "channel_downgrade") as Extract<
      LoopEvent,
      { type: "channel_downgrade" }
    >[];
    expect(downgrades.length).toBeGreaterThan(0);
    expect(downgrades[0]!.from).toBe("toolcall");
    expect(downgrades[0]!.to).toBe("object");
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
      new TransportError("engine core died", 500),
      toolCallBody("bash", { command: "ls" }),
      doneBody("d"),
      doneBody("d", { confirm: true }),
    ]);
    const r = await runLoop({ ...base, transport, executor: okExecutor, emit });
    expect(r.reason).toBe("done");
    const warns = kinds(events, "notice") as Extract<LoopEvent, { type: "notice" }>[];
    expect(warns.some((w) => w.level === "warn" && /server unavailable/.test(w.text))).toBe(true);
  });

  it("gives up after the retry budget", async () => {
    const { emit } = collect();
    const { TransportError } = await import("../src/transport.js");
    const transport = new ScriptedTransport([new TransportError("dead", 500)], true);
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
