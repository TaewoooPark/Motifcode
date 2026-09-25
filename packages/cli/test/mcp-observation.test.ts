import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvocation, ToolResult } from "@motifcode/core";
import { ToolExecutor, type ExecutorOptions } from "../src/executor.js";
import { readOnlyPolicy } from "../src/policy.js";
import { McpSession } from "../../mcp/src/session.js";

const dirs: string[] = [];
const executors: ToolExecutor[] = [];
afterEach(() => {
  for (const executor of executors.splice(0)) executor.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const call: ToolInvocation = {
  id: "root-c7", name: "mcp", arguments: { server: "trusted-browser", method: "browser_navigate", args: { url: "https://example.test" } },
  validated: true, repaired: false,
};
const success = (output = "observed"): ToolResult => ({ ok: true, output });
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

function fixture(options: Partial<ExecutorOptions> = {}, blockSnapshot = false) {
  const cwd = mkdtempSync(join(tmpdir(), "motif-mcp-observe-")); dirs.push(cwd);
  const log = join(cwd, "hooks.jsonl"); const script = join(cwd, "hook.cjs");
  writeFileSync(log, "");
  writeFileSync(script, `const fs = require('node:fs'); const input = fs.readFileSync(0, 'utf8'); fs.appendFileSync(process.argv[2], input + '\\n'); const event = JSON.parse(input); if (${blockSnapshot} && event.event === 'PreToolUse' && event.payload?.arguments?.method === 'browser_snapshot') process.exit(1);`);
  const command = `${quote(process.execPath)} ${quote(script)} ${quote(log)}`;
  const executor = new ToolExecutor({ cwd, hooks: {
    PreToolUse: [{ matcher: "mcp", command, blocking: true }], PostToolUse: [{ matcher: "mcp", command }],
  }, ...options });
  executors.push(executor);
  return { executor, cwd, events: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; payload?: { arguments?: { server?: string; method?: string }; ok?: boolean } }) };
}

describe("MCP observation through the ordinary executor", () => {
  it("confirms both exact calls, uses the same signal, and runs pre/post hooks for both", async () => {
    const approved: ToolInvocation[] = []; const remote: unknown[][] = [];
    const controller = new AbortController();
    const { executor, events } = fixture({ confirm: async (invocation) => { approved.push(invocation); return "allow"; },
      callMcp: async (server, method, args, signal, observe) => {
        remote.push([server, method, args, signal]);
        if (method === "browser_snapshot") { expect(observe).toBeUndefined(); return success("inline snapshot"); }
        expect(await observe!()).toEqual(success("inline snapshot"));
        return success("action completed");
      },
    });
    expect(await executor.run(call, controller.signal)).toEqual(success("action completed"));
    expect(approved).toEqual([call, { id: "root-c7-snapshot", name: "mcp", arguments: { server: "trusted-browser", method: "browser_snapshot", args: {} }, validated: true, repaired: false }]);
    expect(remote).toEqual([
      ["trusted-browser", "browser_navigate", { url: "https://example.test" }, controller.signal],
      ["trusted-browser", "browser_snapshot", {}, controller.signal],
    ]);
    expect(events().map((event) => event.event)).toEqual(["PreToolUse", "PreToolUse", "PostToolUse", "PostToolUse"]);
    expect(events().slice(0, 2).map((event) => event.payload?.arguments?.method)).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  it("allows at most one snapshot attempt, including concurrent attempts", async () => {
    const results: ToolResult[] = []; const remote: string[] = [];
    const { executor } = fixture({ callMcp: async (_server, method, _args, _signal, observe) => {
      remote.push(method);
      if (observe) results.push(...await Promise.all([observe(), observe()]));
      return success();
    } });
    await executor.run(call);
    expect(remote).toEqual(["browser_navigate", "browser_snapshot"]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.output).toContain("already attempted");
  });

  it.each(["original", "snapshot"] as const)("does not dispatch a %s call that the person denied", async (denied) => {
    const remote: string[] = []; const confirmations: string[] = [];
    const { executor, events } = fixture({ confirm: async (invocation) => {
      const method = String(invocation.arguments.method); confirmations.push(method);
      return method === (denied === "original" ? "browser_navigate" : "browser_snapshot") ? "deny" : "allow";
    }, callMcp: async (_server, method, _args, _signal, observe) => {
      remote.push(method);
      if (observe) expect((await observe()).output).toContain("declined");
      return success("action completed");
    } });
    await executor.run(call);
    expect(remote).toEqual(denied === "original" ? [] : ["browser_navigate"]);
    expect(confirmations).toEqual(denied === "original" ? ["browser_navigate"] : ["browser_navigate", "browser_snapshot"]);
    expect(events().map((event) => event.event)).toEqual(denied === "original" ? [] : ["PreToolUse", "PostToolUse"]);
  });

  it("enforces read-only policy before confirmation, hooks or a remote call", async () => {
    const confirm = vi.fn(async () => "allow" as const); const callMcp = vi.fn(async () => success());
    const { executor, events } = fixture({ policy: readOnlyPolicy(tmpdir(), ["mcp"]), confirm, callMcp });
    expect((await executor.run(call)).ok).toBe(false);
    expect(confirm).not.toHaveBeenCalled(); expect(callMcp).not.toHaveBeenCalled(); expect(events()).toEqual([]);
  });

  it.each(["before", "after-action", "during-confirmation"] as const)("does not confirm, hook or dispatch the snapshot after cancellation %s", async (when) => {
    const controller = new AbortController(); const remote: string[] = []; const confirmed: string[] = [];
    const { executor, events } = fixture({ confirm: async (invocation) => {
      const method = String(invocation.arguments.method); confirmed.push(method);
      if (when === "during-confirmation" && method === "browser_snapshot") controller.abort();
      return "allow";
    }, callMcp: async (_server, method, _args, _signal, observe) => {
      remote.push(method);
      if (when === "after-action") controller.abort();
      if (observe) expect((await observe()).ok).toBe(false);
      return success("action completed");
    } });
    if (when === "before") controller.abort();
    await executor.run(call, controller.signal);
    expect(remote).toEqual(when === "before" ? [] : ["browser_navigate"]);
    expect(confirmed).toEqual(when === "before" ? [] : when === "after-action" ? ["browser_navigate"] : ["browser_navigate", "browser_snapshot"]);
    expect(events().map((event) => event.event)).toEqual(when === "before" ? [] : ["PreToolUse"]);
  });

  it("lets a snapshot PreToolUse hook veto only the observation", async () => {
    const remote: string[] = [];
    const { executor, events } = fixture({ callMcp: async (_server, method, _args, _signal, observe) => {
      remote.push(method);
      if (observe) expect((await observe()).output).toContain("blocked by a PreToolUse hook");
      return success("action completed");
    } }, true);
    expect(await executor.run(call)).toEqual(success("action completed"));
    expect(remote).toEqual(["browser_navigate"]);
    expect(events().map((event) => event.event)).toEqual(["PreToolUse", "PreToolUse", "PostToolUse"]);
  });

  it("does not give a direct snapshot call a recursive observation callback", async () => {
    const callback = vi.fn<NonNullable<ExecutorOptions["callMcp"]>>(async (_server, _method, _args, _signal, observe) => {
      expect(observe).toBeUndefined(); return success();
    });
    const { executor } = fixture({ callMcp: callback });
    await executor.run({ ...call, arguments: { server: "trusted-browser", method: "browser_snapshot", args: {} } });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("preserves bounded JSON byte-for-byte and reports failed post hooks separately", async () => {
    const result: ToolResult = { ok: true, bounded: true, output: '{"ok":true,"execution":"completed","result":{"text":"원본 🚪","handle":"mcp_result_exact"}}' };
    const hookEvents: unknown[] = [];
    const { executor } = fixture({
      hooks: { PostToolUse: [{ matcher: "mcp", command: "exit 1" }] },
      onHook: (...event) => hookEvents.push(event), callMcp: async () => result,
    });
    expect(await executor.run(call)).toBe(result);
    expect(hookEvents).toEqual([["PostToolUse", "exit", false]]);
  });

  it("retains the existing post-hook diagnostic for unbounded tool output", async () => {
    const { executor } = fixture({ hooks: { PostToolUse: [{ matcher: "mcp", command: "exit 1" }] }, callMcp: async () => success("legacy plain-text output") });
    const result = await executor.run(call);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("legacy plain-text output\n\n[hooks]");
    expect(result.bounded).toBeUndefined();
  });

  it("keeps fresh snapshot references when action and observation post hooks fail", async () => {
    const session = new McpSession({ servers: [{ id: "trusted-browser", enabled: true, transport: "stdio", command: "unused", profile: "playwright" }] });
    const snapshotText = "상세 화면\n" + "x".repeat(1100) + '\n- button "신청 확정" [ref=e12]';
    const hookEvents: unknown[] = [];
    vi.spyOn(session.manager, "getTool").mockImplementation(async (server, name) => ({ server, name, inputSchema: { type: "object" }, requiresUserInteraction: false, schemaHash: "test", annotations: { readOnlyHint: name === "browser_snapshot" } }));
    const remote = vi.spyOn(session.manager, "invoke").mockImplementation(async (_server, method) => ({ ok: true, execution: "completed", isError: false, result: { content: [{ type: "text", text: method === "browser_snapshot" ? snapshotText : "action completed" }] } }));
    const { executor } = fixture({
      hooks: { PostToolUse: [{ matcher: "mcp", command: "exit 1" }] },
      onHook: (...event) => hookEvents.push(event),
      callMcp: (server, method, args, signal, observe) => session.invoke(server, method, args, { scopeId: "root", signal, observe }),
    });
    try {
      const result = await executor.run(call);
      expect(result).toMatchObject({ ok: true, bounded: true });
      const envelope = JSON.parse(result.output);
      expect(envelope).toMatchObject({ ok: true, execution: "completed", result: { action: { content: [{ type: "text", text: "action completed" }] }, observation: { outcome: { ok: true, execution: "completed" } } } });
      expect(envelope.result.observation.outcome.result.content[0].text).toBe(snapshotText);
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(16_000);
      expect(remote.mock.calls.map((args) => args[1])).toEqual(["browser_navigate", "browser_snapshot"]);
      expect(hookEvents).toEqual([["PostToolUse", "exit", false], ["PostToolUse", "exit", false]]);
    } finally { await session.close(); }
  });
});
