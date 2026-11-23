import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "@motifcode/tools";
import { ScriptedTransport, doneBody, toolCallBody } from "@motifcode/replay";
import { PROVIDERS, runLoop, type LoopCheckpoint } from "../src/index.js";

const base = {
  tools: [...CORE_TOOLS],
  system: () => "Use the fixture tools.",
  userTask: "Process the fixture.",
  emit: () => {},
  executor: { run: async () => ({ ok: true, output: "fixture result" }) },
};

function scriptAt(endpoint: string, replies: ConstructorParameters<typeof ScriptedTransport>[0]) {
  const script = new ScriptedTransport(replies);
  return { endpoint, model: script.model, complete: script.complete.bind(script), seen: script.seen };
}

describe.each([
  { name: "OpenRouter", endpoint: PROVIDERS.openrouter.endpoint, openRouter: true },
  { name: "Infron", endpoint: PROVIDERS.infron.endpoint, openRouter: false },
  { name: "Morphfactory", endpoint: PROVIDERS.morphfactory.endpoint, openRouter: false },
  { name: "wire base with an extra /v1", endpoint: "https://openrouter.ai/api/v1", openRouter: false },
  { name: "custom base", endpoint: "https://openrouter.ai/custom/v1", openRouter: false },
])("$name native loop compatibility", ({ endpoint, openRouter }) => {
  it("preserves or clears the original proposal across a mismatch and resume", async () => {
    const points: LoopCheckpoint[] = [];
    const transport = scriptAt(endpoint, [doneBody("original"), doneBody("different", { confirm: true })]);
    await runLoop({ ...base, transport, maxTurns: 2, onCheckpoint: point => points.push(point) });
    const resume = points.at(-1)!;
    expect(resume.pendingDone).toBe(openRouter ? "original" : null);

    const corrected = scriptAt(endpoint, [doneBody("original", { confirm: true })]);
    const result = await runLoop({ ...base, transport: corrected, resume, maxTurns: 3 });
    expect(result.reason).toBe(openRouter ? "done" : "turn_limit");
    const repeated = scriptAt(endpoint, [doneBody("different", { confirm: true }), doneBody("different", { confirm: true })]);
    const other = await runLoop({ ...base, transport: repeated, resume, maxTurns: 4 });
    expect(other.reason).toBe(openRouter ? "turn_limit" : "done");
  });

  it("sends provider-specific history after a refused tool call and an accepted done", async () => {
    const transport = scriptAt(endpoint, [toolCallBody("read", { path: 42 }), doneBody("finished")]);
    const result = await runLoop({ ...base, transport, maxTurns: 2, confirmDone: false });
    expect(result.reason).toBe("done");
    const history = transport.seen[1]!.messages;
    const results = history.filter(message => message.role === "tool");
    const refused = history.find(message => message.role === "assistant")!.tool_calls![0]!;
    expect(results.map(message => message.tool_call_id)).toEqual(openRouter ? [refused.id] : []);
    const accepted = result.transcript.filter(message => message.role === "assistant").at(-1)!.tool_calls![0]!;
    expect(result.transcript.at(-1)!.role).toBe(openRouter ? "tool" : "assistant");
    if (openRouter) expect(result.transcript.at(-1)).toMatchObject({ tool_call_id: accepted.id, content: "Completion accepted." });
  });

  it("refuses a whole batch or dispatches its decodable sibling", async () => {
    const transport = scriptAt(endpoint, [{
      rawText: "", content: "", ms: 1, toolCalls: [
        { function: { name: "write", arguments: { path: "out", content: "one" } } },
        { function: { name: "write", arguments: "[42]" } },
      ],
    }]);
    const writes: string[] = [];
    await runLoop({ ...base, transport, maxTurns: 1, executor: { run: async call => {
      writes.push(call.name);
      return { ok: true, output: "recorded" };
    } } });
    expect(writes).toEqual(openRouter ? [] : ["write"]);
  });

  it("resumes an interrupted read with its original batch IDs or the verbatim historical transcript", async () => {
    const points: LoopCheckpoint[] = [];
    const transport = scriptAt(endpoint, [{
      rawText: "", content: "", ms: 1, toolCalls: [
        { function: { name: "read", arguments: { path: "in.txt" } } },
        { function: { name: "write", arguments: { path: "out.txt", content: "out" } } },
      ],
    }]);
    await runLoop({ ...base, transport, maxTurns: 1, onCheckpoint: point => points.push(point) });
    const resume = points.find(point => point.inFlightTool?.name === "read")!;
    const advertised = resume.messages.at(-1)!.tool_calls!;
    expect(advertised).toHaveLength(2);
    const next = scriptAt(endpoint, [doneBody("finished")]);
    await runLoop({ ...base, transport: next, resume, maxTurns: 2, confirmDone: false });
    const messages = next.seen[0]!.messages;
    expect(messages.slice(0, resume.messages.length)).toEqual(resume.messages);
    expect(messages.slice(resume.messages.length).map(message => [message.role, message.tool_call_id]))
      .toEqual(openRouter ? advertised.map(call => ["tool", call.id]) : []);
  });
});
