import { describe, expect, it } from "vitest";
import { CORE_TOOLS, lintTools } from "@motifcode/tools";
import { getCodec, repairContext, toolCallParts, ToolValidator, type Tool } from "@motifcode/protocol";
import { runLoop } from "@motifcode/core";
import { ScriptedTransport, toolCallBody } from "@motifcode/replay";
import { McpSession, ResultStore } from "@motifcode/mcp";

describe("MCP runtime bridge", () => {
  it("keeps one closed object proxy and confines the nested schema exception", () => {
    const validator = new ToolValidator(CORE_TOOLS);
    expect(validator.validate("mcp", { server: "lab", method: "echo", args: { rows: [{ no: false, value: null }] } }).ok).toBe(true);
    for (const args of ["{}", [], null]) expect(validator.validate("mcp", { server: "lab", method: "echo", args }).ok).toBe(false);
    expect(validator.validate("mcp", { server: "lab", method: "echo", args: {}, command: "no" }).ok).toBe(false);
    const proxy = structuredClone(CORE_TOOLS.at(-1)!) as Tool & { function: { name: string } };
    proxy.function.name = "other";
    expect(lintTools([proxy]).some((issue) => issue.rule === "no-nested-objects")).toBe(true);
  });

  it("preserves native MCP wire arguments and reasoning without adopting another call's payload", () => {
    const codec = getCodec("toolcall");
    const wire = '{ "server": "lab", "method": "echo", "args": {"text":"한글\\n\\\\path", "empty": {}} }';
    const native = { type: "function" as const, function: { name: "mcp", arguments: wire } };
    const parse = codec.parse({ content: "", rawText: "", ms: 1, toolCalls: [native] }, repairContext([...CORE_TOOLS]));
    const calls = [{ id: "test-1", name: "mcp", arguments: JSON.parse(wire) as Record<string, unknown> }];
    const message = codec.serializeAssistant("", "kept reasoning", parse, calls)[0]!;
    expect(message.reasoning_content).toBe("kept reasoning");
    expect(toolCallParts(message.tool_calls![0]!).args).toBe(wire);
    const refused = codec.parse({ content: "", rawText: "", ms: 1, toolCalls: [{ type: "function", function: { name: "mcp", arguments: "invalid json" } }, native] }, repairContext([...CORE_TOOLS]));
    expect(toolCallParts(codec.serializeAssistant("", undefined, refused, calls)[0]!.tool_calls![0]!).args).toEqual(JSON.parse(wire));
  });

  it("appends runtime data after the task and does not re-truncate bounded result JSON", async () => {
    const transport = new ScriptedTransport([toolCallBody("mcp", { server: "lab", method: "echo", args: {} }), "</think>Finished."]);
    const output = JSON.stringify({ content: "x".repeat(15_000), handle: "intact" });
    const result = await runLoop({
      transport, tools: [...CORE_TOOLS], system: () => "stable system", userTask: "exact task", context: "runtime data",
      executor: { run: async () => ({ ok: true, bounded: true, output }) }, emit: () => {},
      replyEnds: true, confirmDone: false, maxTurns: 2,
    });
    expect(result.reason).toBe("done");
    expect(transport.seen[0]!.messages.map((m) => m.content)).toEqual(["stable system", "exact task", "runtime data"]);
    const next = transport.seen[1]!.messages;
    expect(next[0]!.content).toBe("stable system");
    expect(next.at(-1)!.content).toBe(output);
    expect(JSON.parse(next.at(-1)!.content as string).handle).toBe("intact");
  });

  it("rejects mixed paging before a control executes and supplies concrete recovery calls", async () => {
    const session = new McpSession({ servers: [] });
    try {
      const bad = await session.invoke("__motif_host__", "read_result", { handle: "x", startLine: 1, charCount: 10 }, { scopeId: "root" });
      expect(JSON.parse(bad.output).error.code).toBe("invalid_arguments");
      const store = new ResultStore({ maxOutputBytes: 4096 });
      const shown = store.present("root", { content: [{ type: "text", text: "abc\n".repeat(5000) }] }) as any;
      expect(shown.nextCall).toMatchObject({ server: "__motif_host__", method: "read_result", args: { pointer: "/content/0/text", startLine: 1 } });
      expect(shown.guidance).toContain("NOT a file path");
      const oneLine = store.present("root", { content: [{ type: "text", text: JSON.stringify({ rows: "한🙂".repeat(5000) }) }] }) as any;
      expect(oneLine.nextCall.args).toMatchObject({ pointer: "/content/0/text", startChar: 0, charCount: 2000 });
      expect(store.read("root", oneLine.nextCall.args)).toMatchObject({ ok: true, coverage: { unit: "utf16_code_units" } });
      const found = store.find("root", { handle: shown.handle, query: "abc", limit: 1 }) as any;
      expect(found.matches[0].excerpt).toContain("abc");
      expect(found.coverage).toMatchObject({ complete: false, wholeResult: false, predicateComplete: true });
    } finally { await session.close(); }
  });
});
