/**
 * The shell limit a model gets when it does not name one.
 *
 * Motif-3 almost never sends `timeout_s`, so the limit for a long command is in
 * practice this default; it has to be configurable, and a call that does name
 * a limit must still win.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../src/executor.js";

const call = (args: Record<string, unknown>) => ({ id: "1", name: "bash", arguments: args, repaired: false, validated: true as const });

describe("bash timeout", () => {
  it("uses the executor's limit when the call sets none, and the call's own when it does", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "motif-bash-timeout-"));
    const ex = new ToolExecutor({ cwd, timeoutMs: 300 });
    const killed = await ex.run(call({ command: "sleep 3" }));
    expect(killed.ok).toBe(false);
    expect(killed.output).toMatch(/killed after/);
    const own = await ex.run(call({ command: "sleep 0.6 && echo finished", timeout_s: 5 }));
    expect(own.ok).toBe(true);
    expect(own.output).toContain("finished");
    ex.close();
  });

  it("keeps 120 s as the default", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "motif-bash-default-"));
    const ex = new ToolExecutor({ cwd });
    const r = await ex.run(call({ command: "sleep 0.6 && echo finished" }));
    expect(r.ok).toBe(true);
    ex.close();
  });
});
