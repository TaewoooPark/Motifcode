import { describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES } from "@motifcode/tools";
import { unwrapTool, type Tool } from "@motifcode/protocol";
import { AgentRegistry, AgentScheduler, BUILTIN_AGENTS, concurrencyFor } from "../src/index.js";

const reg = new AgentRegistry();
reg.registerAll(BUILTIN_AGENTS);

const names = (a: { tools: Tool[] }) => a.tools.map((t) => unwrapTool(t).name);

describe("built-in agents", () => {
  it("ships the set every coding harness needs", () => {
    const list = reg.list().map((a) => a.name);
    for (const n of ["explorer", "reviewer", "tester", "planner", "patcher"]) {
      expect(list, n).toContain(n);
    }
  });

  it("gives every agent a canonical-order tool prefix", () => {
    // Not a filtered set: rendering the same tools in a different order leaves
    // about a quarter of the prompt prefix intact, so subsets must be prefixes.
    for (const def of reg.list()) {
      const agent = reg.get(def.name)!;
      expect(names(agent), def.name).toEqual(CORE_TOOL_NAMES.slice(0, def.toolCount));
    }
  });

  it("keeps read-only agents read-only", () => {
    for (const n of ["explorer", "reviewer", "planner"]) {
      const tools = names(reg.get(n)!);
      expect(tools, n).not.toContain("apply_patch");
      expect(tools, n).not.toContain("term");
    }
  });

  it("gives the tester a terminal, because a debugger needs one", () => {
    expect(names(reg.get("tester")!)).toContain("term");
  });

  it("prevents recursion without a special rule", () => {
    // `task` sits at position 7 in the canonical order, past every count used
    // here, so no subagent can spawn another. The guard falls out of the
    // ordering rather than needing to be enforced.
    for (const def of reg.list()) {
      expect(names(reg.get(def.name)!), def.name).not.toContain("task");
    }
  });

  it("gives every agent at least the done tool", () => {
    for (const def of reg.list()) {
      expect(names(reg.get(def.name)!)[0], def.name).toBe("done");
    }
    expect(() => reg.register({ ...BUILTIN_AGENTS[0]!, toolCount: 0 })).toThrow(/done tool/);
  });

  it("bounds every agent's turns", () => {
    for (const def of reg.list()) expect(def.maxTurns, def.name).toBeGreaterThan(0);
  });
});

describe("scheduling", () => {
  it("serialises on a local endpoint", () => {
    // One GPU means the requests queue in the server anyway; queueing here just
    // makes the wait visible instead of looking like a stall.
    expect(concurrencyFor("http://127.0.0.1:8080")).toBe(1);
    expect(concurrencyFor("http://zgx-1c3b:8080")).toBe(1);
    expect(concurrencyFor("https://api.example.com")).toBeGreaterThan(1);
  });

  it("runs one at a time when told to", async () => {
    let peak = 0;
    let live = 0;
    const s = new AgentScheduler(1);
    const run = async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      return "ok";
    };
    await Promise.all([
      s.submit("explorer", "a", run),
      s.submit("explorer", "b", run),
      s.submit("explorer", "c", run),
    ]);
    expect(peak).toBe(1);
  });

  it("reports queue transitions so the screen can show them", async () => {
    const states: string[] = [];
    const s = new AgentScheduler(1, (e) => states.push(e.state));
    await s.submit("reviewer", "x", async () => "done");
    expect(states).toEqual(["queued", "running", "done"]);
  });

  it("marks a failure and rethrows", async () => {
    const states: string[] = [];
    const s = new AgentScheduler(1, (e) => states.push(e.state));
    await expect(
      s.submit("reviewer", "x", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(states).toContain("failed");
    expect(s.pending).toHaveLength(0);
  });
});
