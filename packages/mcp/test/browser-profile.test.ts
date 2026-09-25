import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSession } from "../src/session.js";
import type { McpTool } from "../src/manager.js";

const sessions: McpSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((s) => s.close())); vi.restoreAllMocks(); });
const actionResult = { content: [{ type: "text" as const, text: "action completed" }] };
function fixture(profile = true, readOnly = true) {
  const session = new McpSession({ servers: [{ id: "browser", enabled: true, transport: "stdio", command: "unused", ...(profile ? { profile: "playwright" as const } : {}) }] });
  sessions.push(session);
  const tool: McpTool = { server: "browser", name: "browser_snapshot", inputSchema: { type: "object", properties: {}, additionalProperties: false }, requiresUserInteraction: false, schemaHash: "test", annotations: { readOnlyHint: readOnly } };
  vi.spyOn(session.manager, "getTool").mockResolvedValue(tool);
  const invoke = vi.spyOn(session.manager, "invoke").mockResolvedValue({ ok: true, execution: "completed", isError: false, result: actionResult });
  const observe = vi.fn(async () => ({ ok: true, output: JSON.stringify({ ok: true, execution: "completed", result: { content: [{ type: "text", text: '- spinbutton "수량" [ref=e8]: "3"' }] } }) }));
  return { session, invoke, observe };
}

describe("opt-in Playwright observations", () => {
  it("combines a completed action with one fresh observation without replaying the action", async () => {
    const { session, invoke, observe } = fixture();
    const result = await session.invoke("browser", "browser_fill_form", { fields: [] }, { scopeId: "root", observe });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, execution: "completed", result: { action: actionResult, observation: { server: "browser", method: "browser_snapshot", args: {}, outcome: { ok: true, execution: "completed" } } } });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(["denied", "throws", "unknown"])("preserves completed action status when observation %s", async (failure) => {
    const { session, observe, invoke } = fixture();
    if (failure === "throws") observe.mockRejectedValue(new Error("unavailable"));
    else observe.mockResolvedValue({ ok: failure === "denied", output: failure === "denied" ? "The person declined this tool call." : JSON.stringify({ ok: false, execution: "unknown", error: { code: "timeout" } }) });
    const result = await session.invoke("browser", "browser_click", {}, { scopeId: "root", observe });
    const value = JSON.parse(result.output);
    expect(result.ok).toBe(true);
    expect(value).toMatchObject({ execution: "completed", result: { action: actionResult, observation: { outcome: { ok: false } } } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed business error distinct while observing current state", async () => {
    const { session, observe, invoke } = fixture();
    invoke.mockResolvedValue({ ok: true, execution: "completed", isError: true, result: { ...actionResult, isError: true } });
    const result = await session.invoke("browser", "browser_fill_form", {}, { scopeId: "root", observe });
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, execution: "completed", result: { action: { isError: true }, observation: { outcome: { ok: true } } } });
  });

  it("does not observe an unknown or not-started action, or recursively observe a snapshot", async () => {
    const { session, observe, invoke } = fixture();
    for (const execution of ["unknown", "not_started"] as const) {
      invoke.mockResolvedValue({ ok: false, execution, error: { code: "connection_error", message: "unavailable", retryable: false } });
      expect(JSON.parse((await session.invoke("browser", "browser_click", {}, { scopeId: "root", observe })).output).execution).toBe(execution);
    }
    invoke.mockResolvedValue({ ok: true, execution: "completed", isError: false, result: actionResult });
    await session.invoke("browser", "browser_snapshot", {}, { scopeId: "root", observe });
    expect(observe).not.toHaveBeenCalled();
  });

  it("requires the trusted profile, available snapshot tool and caller's observation gate", async () => {
    for (const [profile, readOnly] of [[false, true], [true, false]]) {
      const { session, observe } = fixture(profile, readOnly);
      await session.invoke("browser", "browser_click", {}, { scopeId: "root", observe });
      expect(observe).not.toHaveBeenCalled();
    }
    const { session, observe } = fixture();
    vi.mocked(session.manager.getTool).mockResolvedValue(undefined);
    await session.invoke("browser", "browser_click", {}, { scopeId: "root", observe });
    expect(observe).not.toHaveBeenCalled();
    expect(JSON.parse((await session.invoke("browser", "browser_click", {}, { scopeId: "root" })).output).result).toEqual(actionResult);
  });

  it("does not start observation after cancellation", async () => {
    const { session, observe, invoke } = fixture();
    const controller = new AbortController();
    invoke.mockImplementation(async () => { controller.abort(); return { ok: true, execution: "completed", isError: false, result: actionResult }; });
    const result = await session.invoke("browser", "browser_click", {}, { scopeId: "root", signal: controller.signal, observe });
    expect(JSON.parse(result.output).execution).toBe("completed");
    expect(observe).not.toHaveBeenCalled();
  });
});
