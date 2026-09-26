import { describe, expect, it, vi } from "vitest";
import { externalUrl } from "../src/browser-open.js";
import { requestMcpInteraction, type McpHumanUi } from "../src/mcp-interaction.js";
import type { McpElicitationRequest } from "@motifcode/mcp";

const request = (url = "https://accounts.example.test/approve?state=private"): McpElicitationRequest => ({ server: "demo", mode: "url", message: "Authorize account", url, elicitationId: "flow", signal: new AbortController().signal });
function ui(choices: Array<number | null>, inputs: Array<string | null> = []) {
  return { choose: vi.fn(async () => choices.shift() ?? null), input: vi.fn(async () => inputs.shift() ?? null), openBrowser: vi.fn(async () => {}) } satisfies McpHumanUi;
}
describe("MCP human interaction", () => {
  it("opens only after consent and waits for separate completion", async () => {
    const prompts = ui([0, 0]);
    expect(await requestMcpInteraction(request(), prompts)).toEqual({ action: "accept" });
    expect(prompts.openBrowser).toHaveBeenCalledOnce();
    expect(prompts.choose).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(prompts.choose.mock.calls)).not.toContain("state=private");
  });
  it.each([[1, "decline"], [null, "cancel"]] as const)("does not open after %s", async (choice, action) => {
    const prompts = ui([choice]);
    expect(await requestMcpInteraction(request(), prompts)).toEqual({ action });
    expect(prompts.openBrowser).not.toHaveBeenCalled();
  });
  it("does not treat a launched browser as completed authorization", async () => {
    expect(await requestMcpInteraction(request(), ui([0, null]))).toEqual({ action: "cancel" });
  });
  it.each(["javascript:alert(1)", "file:///etc/passwd", "https://user:password@example.com", "http://example.com/", "https://example.com/\x1b"])("rejects unsafe browser URL %s", async url => {
    expect(() => externalUrl(url)).toThrow();
    const prompts = ui([0, 0]);
    expect(await requestMcpInteraction(request(url), prompts)).toEqual({ action: "decline" });
    expect(prompts.choose).not.toHaveBeenCalled();
  });
  it("collects structured input directly from the person", async () => {
    const prompts = ui([0, 0], ["Ada", "2", '["a"]']);
    const form: McpElicitationRequest = { server: "demo", mode: "form", message: "Settings", signal: new AbortController().signal, requestedSchema: { type: "object", required: ["name", "count", "enabled"], properties: { name: { type: "string" }, count: { type: "integer" }, enabled: { type: "boolean" }, tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } } } };
    expect(await requestMcpInteraction(form, prompts)).toEqual({ action: "accept", content: { name: "Ada", count: 2, enabled: true, tags: ["a"] } });
  });
  it("masks only free text whose name, title or description looks like a credential", async () => {
    const prompts = ui([0], ["", "", "", "", ""]);
    const form: McpElicitationRequest = { server: "demo", mode: "form", message: "Shipment", signal: new AbortController().signal, requestedSchema: { type: "object", properties: {
      shipping_note: { type: "string" }, pinCode: { type: "string" }, label: { type: "string", title: "Personal token" },
      code: { type: "string", description: "One-time passcode" }, spinner_style: { type: "string", enum: ["dots", "line"] } } } };
    await requestMcpInteraction(form, prompts);
    const calls = prompts.input.mock.calls as unknown as Parameters<McpHumanUi["input"]>[];
    expect(calls.map(call => [call[0], call[3]])).toEqual([["shipping_note", false], ["pinCode", true], ["Personal token", true], ["code", true], ["spinner_style", false]]);
  });
  it("declines credential forms and already cancelled requests", async () => {
    const form: McpElicitationRequest = { server: "demo", mode: "form", message: "Secret", signal: new AbortController().signal, requestedSchema: { type: "object", properties: { password: { type: "string" } } } };
    expect(await requestMcpInteraction(form, ui([0]))).toEqual({ action: "decline" });
    expect(await requestMcpInteraction({ ...request(), signal: AbortSignal.abort() }, ui([0, 0]))).toEqual({ action: "cancel" });
  });
});
