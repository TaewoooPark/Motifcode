import { describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES } from "@motifcode/tools";
import { unwrapTool, type Tool } from "@motifcode/protocol";
import { AgentRegistry, AgentScheduler, BUILTIN_AGENTS, concurrencyFor, parseAgent, parseToolCount } from "../src/index.js";

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
    // `task` sits last but one in the canonical order, past every count used
    // here, so no subagent can spawn another. The guard falls out of the
    // ordering rather than needing to be enforced — which also means adding a
    // tool ahead of it, as `write` was, cannot quietly hand it to anyone.
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

  it("gives the explorer room to map a repository", () => {
    // At 20, three of eleven live runs ran out before calling `done` and the
    // parent got nothing back; the ones that finished used up to 19.
    expect(reg.get("explorer")!.maxTurns).toBeGreaterThanOrEqual(40);
  });
});

describe("the index the parent sees", () => {
  it("lists each agent and says what to do with what comes back", () => {
    const index = reg.index();
    for (const def of reg.list()) expect(index).toContain(`  ${def.name} — ${def.description}`);
    // The parent went back over a finished child's ground after every
    // delegation, and once reported an unfinished child as done.
    expect(index).toContain("summary is its result: build on it rather than redoing");
    expect(index).toContain("did not finish has not done the work");
  });

  it("is empty when there is no one to delegate to", () => {
    expect(new AgentRegistry().index()).toBe("");
  });
});

describe("scheduling", () => {
  it("serialises on a local endpoint and fans out on a hosted one", () => {
    // One GPU means the requests queue in the server anyway; queueing here just
    // makes the wait visible instead of looking like a stall. A hosted endpoint
    // has its own queue and admits several.
    expect(concurrencyFor("http://127.0.0.1:8080")).toBe(1);
    expect(concurrencyFor("http://localhost:8080")).toBe(1);
    expect(concurrencyFor("http://box.local:8080")).toBe(1);
    expect(concurrencyFor("https://llm.onerouter.pro")).toBe(4);
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

  it("marks a result the caller calls a failure as failed, and still returns it", async () => {
    // A child that hits its turn limit comes back with `ok: false` instead of
    // throwing, and the queue used to show it as done.
    const states: string[] = [];
    const s = new AgentScheduler(1, (e) => states.push(e.state));
    const out = await s.submit("explorer", "x", async () => ({ ok: false }), (r) => !r.ok);
    expect(out).toEqual({ ok: false });
    expect(states).toEqual(["queued", "running", "failed"]);
    expect(s.pending).toHaveLength(0);
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

describe("agent definitions from markdown", () => {
  const doc = [
    "---",
    "name: auditor",
    "description: Checks a change for security problems",
    "tools: done bash read",
    "readOnly: true",
    "maxTurns: 12",
    "---",
    "Look for injection, secrets in the tree, and unsafe shell.",
    "",
  ].join("\n");

  it("reads the frontmatter and the body", () => {
    const def = parseAgent(doc, "project");
    expect(def).toMatchObject({ name: "auditor", toolCount: 3, readOnly: true, maxTurns: 12, source: "project" });
    expect(def.instructions).toContain("Look for injection");
  });

  it("accepts a count or a prefix, and refuses a set", () => {
    expect(parseToolCount("4", "x")).toBe(4);
    expect(parseToolCount("done bash", "x")).toBe(2);
    expect(() => parseToolCount("bash task", "x")).toThrow(/prefix/);
    expect(() => parseToolCount("0", "x")).toThrow();
  });

  it("refuses a definition with no name, no description or no body", () => {
    expect(() => parseAgent("no frontmatter")).toThrow(/frontmatter/);
    expect(() => parseAgent("---\ndescription: d\n---\nbody")).toThrow(/name/);
    expect(() => parseAgent("---\nname: a\n---\nbody")).toThrow(/description/);
    expect(() => parseAgent("---\nname: a\ndescription: d\n---\n")).toThrow(/instructions/);
  });

  it("shadows a built-in of the same name when registered after it", () => {
    const reg = new AgentRegistry();
    reg.registerAll(BUILTIN_AGENTS);
    reg.register(parseAgent("---\nname: explorer\ndescription: mine\n---\nDo it my way.", "project"));
    expect(reg.get("explorer")?.source).toBe("project");
  });
});
