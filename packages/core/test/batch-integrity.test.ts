import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import type { ChannelId } from "@motifcode/protocol";
import { HttpTransport, runLoop, type Executor } from "../src/index.js";

const args = { path: "fixture.txt", content: "expected" };
const write = { id: "w", type: "function", function: { name: "write", arguments: JSON.stringify(args) } };
const malformed = { id: "m", type: "function", function: { name: "write", arguments: "[42]" } };
const done = { id: "d", type: "function", function: { name: "done", arguments: '{"summary":"finished"}' } };

const native = (calls: unknown[]) =>
  Response.json({ choices: [{ message: { content: null, tool_calls: calls }, finish_reason: "tool_calls" }] });
const formatted = (text: string) =>
  Response.json({ choices: [{ text, reasoning: "separate reasoning", finish_reason: "stop" }] });

const event = (data: unknown) => "data: " + JSON.stringify(data) + "\n\n";
const writeEvent = event({ choices: [{ delta: { tool_calls: [{ ...write, index: 0 }] } }] });
const finishedEvent = event({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
const end = "data: [DONE]";
const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

async function run(channel: ChannelId, replies: Array<() => Response>, maxTurns = 1, maxServerRetries = 0) {
  const requests: string[] = [];
  const effects: Array<{ attempt: number; name: string; args: unknown }> = [];
  const transport = new HttpTransport({
    endpoint: "http://fixture.invalid", model: "fixture",
    fetchImpl: async (_, opts) => {
      const reply = replies[requests.length];
      if (!reply) throw Error("unexpected model request");
      requests.push(String(opts?.body));
      return reply();
    },
  });
  const executor: Executor = { run: async call => {
    effects.push({ attempt: requests.length, name: call.name, args: call.arguments });
    return { ok: true, output: "recorded" };
  } };
  const result = await runLoop({
    channel, channelPolicy: "fixed", tools: [...CORE_TOOLS], transport, executor, maxTurns, maxServerRetries,
    confirmDone: false, stream: true, random: () => 0, emit: () => {}, system: () => "fixture",
    userTask: "Apply the fixture.",
  });
  return { result, requests, effects };
}

describe("validate the complete tool batch before dispatch", () => {
  it.each([[write, malformed], [malformed, write], [done, malformed]])("rejects an undecodable native sibling", async (left, right) => {
    const r = await run("toolcall", [() => native([left, right]), () => native([write])], 2);
    expect(r.effects).toEqual([{ attempt: 2, name: "write", args }]);
    expect(r.result.reason).toBe("turn_limit");
  });

  it("retries a response containing a nameless native call before any sibling runs", async () => {
    const r = await run("toolcall", [
      () => native([write, { id: "bad", function: { arguments: "{}" } }]), () => native([write]),
    ], 1, 1);
    expect(r.requests[0]).toBe(r.requests[1]);
    expect(r.effects).toEqual([{ attempt: 2, name: "write", args }]);
  });

  it.each([
    ["object", '{"commands":[{"keystrokes":"OK"},null]}'],
    ["object", '{"commands":[{"keystrokes":null},{"keystrokes":"OK"}]}'],
    ["object", '{"commands":[null],"task_complete":true,"summary":"finished"}'],
    ["raw", "<response><keystrokes>OK</keystrokes><keystrokes"],
    ["raw", "<response><keystrokes/><keystrokes>unfinished"],
    ["raw", "<response><task_complete>true</task_complete><keystrokes>unfinished"],
    ["raw", "<response><keystrokes>OK</keystrokes></keystrokes>"],
  ] as const)("refuses every action in a broken %s batch", async (channel, text) => {
    const r = await run(channel, [() => formatted(text)]);
    expect(r.effects).toEqual([]);
    expect(r.result.reason).toBe("turn_limit");
  });

  it("executes raw waits and literal input in the supplied order", async () => {
    const text = '<response><commands><keystrokes duration="2"/><keystrokes>echo "& <keystrokes/>"</keystrokes>' +
      '<keystrokes duration="4" /></commands></response>';
    const r = await run("raw", [() => formatted(text)]);
    expect(r.effects.map(e => e.args)).toEqual([
      { keystrokes: "", duration_s: 2 },
      { keystrokes: 'echo "& <keystrokes/>"', duration_s: 1 },
      { keystrokes: "", duration_s: 4 },
    ]);
  });
});

describe("integrity of streamed tool calls", () => {
  it.each(["", ": heartbeat\n\n", 'data: {"choices":', 'data: {"choices":\n\n' + finishedEvent + end,
    event(null) + finishedEvent + end, event([]) + finishedEvent + end, event({ choices: "broken" }) + finishedEvent + end])(
    "does not dispatch the intact prefix when the tail is missing or damaged", async tail => {
      const r = await run("toolcall", [
        () => sse(writeEvent + tail), () => sse(writeEvent + finishedEvent + end),
      ], 1, 1);
      expect(r.requests[0]).toBe(r.requests[1]);
      expect(r.effects).toEqual([{ attempt: 2, name: "write", args }]);
    });

  it("stops a persistently interrupted stream without running its parseable action", async () => {
    const r = await run("toolcall", [() => sse(writeEvent), () => sse(writeEvent)], 1, 1);
    expect(r.effects).toEqual([]);
    expect(r.result.reason).toBe("transport_error");
  });

  it.each([
    writeEvent + end,
    writeEvent + finishedEvent + event({ choices: [], usage: { prompt_tokens: 10 } }),
    writeEvent.replace('"choices":[', '"choices":\ndata: [').replace(/\n/g, "\r\n") + end,
    (": heartbeat\n\n" + writeEvent + finishedEvent + end).replace(/\n/g, "\r"),
  ])("preserves complete streams with either terminal marker or multiline SSE", async text => {
    const r = await run("toolcall", [() => sse(text)]);
    expect(r.effects).toEqual([{ attempt: 1, name: "write", args }]);
  });
});
