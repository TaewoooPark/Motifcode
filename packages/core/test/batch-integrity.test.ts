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

const event = (data: unknown) => "data: " + JSON.stringify(data) + "\n\n";
const writeEvent = event({ choices: [{ delta: { tool_calls: [{ ...write, index: 0 }] } }] });
const finishedEvent = event({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
const end = "data: [DONE]";
const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

async function run(channel: ChannelId, replies: Array<() => Response>, maxTurns = 1, maxServerRetries = 0) {
  const requests: string[] = [];
  const effects: Array<{ attempt: number; name: string; args: unknown }> = [];
  const transport = new HttpTransport({
    endpoint: "https://openrouter.ai/api", model: "fixture",
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
    ["raw", "<response><plan>Mention the literal </keystrokes> tag.</plan><keystrokes>OK</keystrokes></response>",
      [{ keystrokes: "OK", duration_s: 1 }]],
    ["object", '{"commands":[{"keystrokes":null,"duration":2}]}', [{ keystrokes: "", duration_s: 2 }]],
  ] as const)("preserves legacy %s input", async (channel, text, expected) => {
    const r = await run(channel, [() => Response.json({
      choices: [{ text, reasoning: "separate reasoning", finish_reason: "stop" }],
    })]);
    expect(r.effects.map(e => e.args)).toEqual(expected);
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

describe("end-of-stream compatibility", () => {
  const reply = (content: string) => event({ choices: [{ delta: { content } }] });
  const request = { messages: [{ role: "user" as const, content: "Status?" }], tools: [...CORE_TOOLS], onDelta: () => {} };
  const complete = (body: string) => new HttpTransport({
    endpoint: "https://openrouter.ai/api", model: "fixture", fetchImpl: async () => sse(body),
  }).complete(request);

  it("accepts a text-only chat response at graceful EOF in a single request", async () => {
    let requests = 0;
    const answer = "The report is ready.";
    const transport = new HttpTransport({
      endpoint: "https://openrouter.ai/api", model: "fixture", fetchImpl: async () => {
        requests++;
        return sse(event({ choices: [{ delta: { reasoning: "checking" } }] }) + reply(answer));
      },
    });
    const result = await runLoop({
      tools: [...CORE_TOOLS], transport, system: () => "fixture", userTask: "Status?",
      executor: { run: async () => { throw new Error("unexpected tool call"); } },
      stream: true, replyEnds: true, maxServerRetries: 1, emit: () => {},
    });
    expect(result.reason).toBe("done");
    expect(result.summary).toBe(answer);
    expect(requests).toBe(1);
    expect((await complete(reply(answer))).content).toBe(answer);
  });

  it.each([
    ["toolcall", reply('<tool_call>{"name":"write","arguments":{}}</tool_call>')],
    ["toolcall", reply('<tool_call>{"name":"write"')],
    ["toolcall", reply(JSON.stringify({ name: "write", arguments: args }))],
    ["toolcall", reply("analysis</think>" + JSON.stringify({ name: "write", arguments: args }))],
    ["toolcall", event({ choices: [{ delta: { reasoning: "only reasoning" } }] })],
    ["toolcall", reply("<think>only reasoning</think>")],
    ["toolcall", reply("A mixed reply") + writeEvent],
    ["raw", event({ choices: [{ text: "<response><keystrokes>OK</keystrokes></response>" }] })],
    ["object", event({ choices: [{ text: '{"commands":[{"keystrokes":"OK"}]}' }] })],
  ] as const)("requires a terminal marker for actions and empty replies on %s", async (channel, body) => {
    const r = await run(channel, [() => sse(body)]);
    expect(r.result.reason).toBe("transport_error");
    expect(r.effects).toEqual([]);
  });

  it.each([
    finishedEvent + writeEvent,
    event({ choices: [{ delta: {}, finish_reason: "length" }] }) + finishedEvent,
    finishedEvent + reply("changed"),
    finishedEvent + event({ choices: [{ delta: { tool_calls: {} } }] }),
  ])("refuses the entire batch when the finished choice changes", async tail => {
    const r = await run("toolcall", [() => sse(writeEvent + tail + end)]);
    expect(r.result.reason).toBe("transport_error");
    expect(r.effects).toEqual([]);
  });

  it("accepts a repeated identical finish and trailing usage", async () => {
    const body = writeEvent + finishedEvent + finishedEvent + event({ choices: [], usage: { prompt_tokens: 17 } }) + end;
    const r = await complete(body);
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.usage?.promptTokens).toBe(17);
  });

  it("honors a provider error following a finished choice", async () => {
    const body = writeEvent + finishedEvent + event({ error: { code: "interrupted", message: "stopped" } }) + end;
    await expect(complete(body)).rejects.toMatchObject({ kind: "generation", code: "interrupted" });
  });
});
