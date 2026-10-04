import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runLoop, type LoopCheckpoint, type LoopEvent } from "@motifcode/core";
import { ScriptedTransport, doneBody, toolCallBody } from "@motifcode/replay";
import { CORE_TOOLS } from "@motifcode/tools";
import { ToolExecutor } from "../src/executor.js";

describe("tool batch cancellation", () => {
  for (const cancelAt of ["tool_start", "tool_end", undefined] as const) {
    const cancel = cancelAt !== undefined;
    it(`preserves the transcript when cancellation occurs at ${cancelAt ?? "no boundary"}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "motif-batch-"));
      writeFileSync(join(cwd, "input.txt"), "read completed");
      const executor = new ToolExecutor({ cwd });
      const controller = new AbortController();
      const events: LoopEvent[] = [];
      const checkpoints: LoopCheckpoint[] = [];
      const transport = new ScriptedTransport([
        toolCallBody("read", { path: "input.txt" }) +
          '<tool_call>{"name":"write","arguments":{"path":"marker.txt","content":"written"}}</tool_call>',
        doneBody("finished"), doneBody("finished", { confirm: true }),
      ]);
      try {
        const result = await runLoop({
          transport, tools: [...CORE_TOOLS], system: () => "Test agent", userTask: "read then write",
          executor, signal: controller.signal,
          emit: (event) => {
            events.push(event);
            // Cancel synchronously at the completed first call's production
            // boundary, without a race against a timeout or child process.
            if (event.type === cancelAt) controller.abort();
          },
          onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
        });
        expect(result.reason).toBe(cancel ? "aborted" : "done");
        expect(transport.seen).toHaveLength(cancel ? 1 : 3);
        expect(events.filter((event) => event.type === "tool_start").map((event) => event.call.name))
          .toEqual(cancel ? ["read"] : ["read", "write"]);
        expect(events.filter((event) => event.type === "tool_end")).toHaveLength(cancel ? 1 : 2);
        expect(existsSync(join(cwd, "marker.txt"))).toBe(!cancel);
        if (!cancel) expect(readFileSync(join(cwd, "marker.txt"), "utf8")).toBe("written");
        const last = checkpoints.at(-1)!;
        expect(last.inFlightTool).toBeUndefined();
        expect(last.messages).toEqual(result.transcript);
        if (cancel) {
          expect(JSON.stringify(result.transcript)).toContain("Tool call not executed");
          expect(checkpoints.filter((checkpoint) => checkpoint.inFlightTool?.name === "write")).toHaveLength(0);
          expect(events.some((event) => event.type === "repair")).toBe(false);
        }
      } finally {
        executor.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it("refuses an already-cancelled direct write before approval", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "motif-aborted-"));
    const confirm = vi.fn(async () => "allow" as const);
    const executor = new ToolExecutor({ cwd, confirm });
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await executor.run({ id: "write", name: "write", arguments: { path: "marker.txt", content: "x" }, repaired: false, validated: true }, controller.signal);
      expect(result.ok).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
      expect(existsSync(join(cwd, "marker.txt"))).toBe(false);
    } finally {
      executor.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
