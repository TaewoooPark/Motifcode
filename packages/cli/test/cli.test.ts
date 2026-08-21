import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRegistry, BUILTIN_AGENTS } from "@motifcode/agents";
import { renderPrompt, sharedPrefixLength } from "@motifcode/protocol";
import { BUILTIN_SKILLS, SkillRegistry } from "@motifcode/skills";
import { CORE_TOOLS, toolPrefix } from "@motifcode/tools";
import { readinessMarker, readinessProbe, ToolExecutor, patchHint, patchPaths } from "../src/executor.js";
import { buildAgentPrompt, buildSystemPrompt } from "../src/prompt.js";
import { doctor, formatChecks, worstState } from "../src/doctor.js";

const skills = new SkillRegistry();
skills.registerAll(BUILTIN_SKILLS);
const agents = new AgentRegistry();
agents.registerAll(BUILTIN_AGENTS);

const opts = { channel: "toolcall" as const, tools: [...CORE_TOOLS], skills, agents, cwd: "/repo" };

describe("system prompt", () => {
  it("is a pure function of its inputs", async () => {
    // Everything in it lands in the cached prefix, immediately after the tools
    // block. A timestamp, a session id or a hash-map ordering would mean a cold
    // prefix on every single request.
    const a = buildSystemPrompt(opts);
    await new Promise((r) => setTimeout(r, 20));
    const b = buildSystemPrompt(opts);
    expect(a).toBe(b);
  });

  it("carries no digits that look like a clock or an id", () => {
    const prompt = buildSystemPrompt(opts);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prompt).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("lists skills and agents by name only", () => {
    const prompt = buildSystemPrompt(opts);
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("explorer");
    // Bodies must not be inlined; they load on demand through the skill tool.
    expect(prompt).not.toContain("Correctness first");
  });

  it("puts project notes last so they outrank ours", () => {
    const prompt = buildSystemPrompt({ ...opts, projectNotes: "PROJECT-RULE" });
    expect(prompt.indexOf("PROJECT-RULE")).toBeGreaterThan(prompt.indexOf("Skills"));
  });

  it("changes with the channel, and only there", () => {
    const a = buildSystemPrompt(opts);
    const b = buildSystemPrompt({ ...opts, channel: "raw" });
    expect(a).not.toBe(b);
    expect(b).toContain("verbatim");
  });

  it("keeps the rendered prefix stable across turns", () => {
    // The end-to-end version of the same claim: same tools, same system text,
    // so everything up to the first user turn is byte-identical.
    const system = buildSystemPrompt(opts);
    const one = renderPrompt({
      messages: [{ role: "system", content: system }, { role: "user", content: "a" }],
      tools: [...CORE_TOOLS],
      addGenerationPrompt: true,
    });
    const two = renderPrompt({
      messages: [
        { role: "system", content: system },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      tools: [...CORE_TOOLS],
      addGenerationPrompt: true,
    });
    expect(sharedPrefixLength(one, two) / one.length).toBeGreaterThan(0.9);
  });
});

describe("subagent prompt", () => {
  it("omits the skill and agent catalogues", () => {
    // A subagent cannot spawn further agents, and giving it the full skill list
    // would spend its context on options it was not delegated.
    const prompt = buildAgentPrompt({
      name: "reviewer",
      instructions: "review it",
      tools: toolPrefix(3),
      channel: "toolcall",
    });
    expect(prompt).not.toContain("# Skills");
    expect(prompt).not.toContain("# Subagents");
  });

  it("tells the agent nobody can see its work", () => {
    const prompt = buildAgentPrompt({
      name: "explorer",
      instructions: "explore",
      tools: toolPrefix(3),
      channel: "toolcall",
    });
    expect(prompt).toMatch(/cannot see|only thing that survives/);
  });
});

describe("executor", () => {
  const cwd = mkdtempSync(join(tmpdir(), "motifcode-exec-"));

  it("runs a command and captures output", async () => {
    const ex = new ToolExecutor({ cwd });
    const r = await ex.run({ id: "1", name: "bash", arguments: { command: "echo hi" }, repaired: false, validated: true });
    ex.close();
    expect(r.ok).toBe(true);
    expect(r.output).toBe("hi");
  });

  it("reports a non-zero exit as a failure the loop can repair", async () => {
    const ex = new ToolExecutor({ cwd });
    const r = await ex.run({ id: "1", name: "bash", arguments: { command: "exit 7" }, repaired: false, validated: true });
    ex.close();
    expect(r.ok).toBe(false);
  });

  it("reads a file with line numbers and a range", async () => {
    writeFileSync(join(cwd, "f.txt"), "a\nb\nc\nd\n", "utf8");
    const ex = new ToolExecutor({ cwd });
    const r = await ex.run({ id: "1", name: "read", arguments: { path: "f.txt", offset: 2, limit: 2 }, repaired: false, validated: true });
    ex.close();
    expect(r.output).toContain("2\tb");
    expect(r.output).toContain("3\tc");
    expect(r.output).not.toContain("1\ta");
  });

  it("keeps state between term calls", async () => {
    // The difference between being able to drive a REPL and not. Stateless
    // bash cannot do this, and Terminal-Bench 74.9 was scored on a session
    // that could.
    const ex = new ToolExecutor({ cwd });
    await ex.run({ id: "1", name: "term", arguments: { keystrokes: "MOTIF_X=42\n", duration_s: 0.3 }, repaired: false, validated: true });
    const r = await ex.run({ id: "2", name: "term", arguments: { keystrokes: "echo $MOTIF_X\n", duration_s: 0.4 }, repaired: false, validated: true });
    ex.close();
    expect(r.output).toContain("42");
  });

  it("does not race the shell into existence on the first call", async () => {
    // `spawn` returns before bash has read its startup files. Without waiting
    // for the shell to actually start, a short first call spends its whole
    // budget on startup and returns "", which the model reads as a command
    // that produced no output — and then acts on.
    const ex = new ToolExecutor({ cwd });
    const r = await ex.run({ id: "1", name: "term", arguments: { keystrokes: "echo first-call\n", duration_s: 0.2 }, repaired: false, validated: true });
    ex.close();
    expect(r.output).toContain("first-call");
  });

  it("writes a readiness probe that does not read as its own output", () => {
    // The bug this exists for: an interactive bash with a prompt echoes what it
    // is sent, so a probe whose command contains the marker matches its own
    // echo. The reader then consumes up to the echo and returns the real marker
    // line as the first call's output. Reproduces on Linux CI, not on macOS.
    const marker = readinessMarker(1234, 1);
    expect(readinessProbe(marker)).not.toContain(marker);
    expect(readinessProbe(marker)).not.toContain("motif_ready");
  });

  it("keeps the readiness probe out of the first call's output", async () => {
    const ex = new ToolExecutor({ cwd });
    const r = await ex.run({ id: "1", name: "term", arguments: { keystrokes: "echo visible\n", duration_s: 0.2 }, repaired: false, validated: true });
    ex.close();
    expect(r.output).toContain("visible");
    expect(r.output).not.toContain("motif_ready");
  });

  it("loads a skill body through the skill tool", async () => {
    const ex = new ToolExecutor({ cwd, skills });
    const r = await ex.run({ id: "1", name: "skill", arguments: { name: "commit" }, repaired: false, validated: true });
    ex.close();
    expect(r.output).toContain('<skill name="commit">');
  });

  it("rejects MCP args that are not a JSON object string", async () => {
    const ex = new ToolExecutor({ cwd, callMcp: async () => "ok" });
    const r = await ex.run({ id: "1", name: "mcp", arguments: { server: "s", method: "m", args: "not json" }, repaired: false, validated: true });
    ex.close();
    expect(r.ok).toBe(false);
    expect(r.output).toContain("JSON object string");
  });

  it("says so when a tool is unavailable rather than failing silently", async () => {
    const ex = new ToolExecutor({ cwd });
    const r = await ex.run({ id: "1", name: "task", arguments: { agent: "x", prompt: "y" }, repaired: false, validated: true });
    ex.close();
    expect(r.output).toContain("not available");
  });

  it("refuses to delegate an empty prompt", async () => {
    // A child with no task still costs a model run, and comes back with a
    // summary of nothing that the parent has no way to recognise as empty.
    let spawned = 0;
    const ex = new ToolExecutor({
      cwd,
      runAgent: async () => {
        spawned++;
        return { ok: true, reason: "done", runId: "r1", summary: "s" };
      },
    });
    const r = await ex.run({ id: "1", name: "task", arguments: { agent: "explorer", prompt: "  " }, repaired: false, validated: true });
    ex.close();
    expect(r.ok).toBe(false);
    expect(spawned).toBe(0);
  });

  it("reports an unfinished subagent as a tool failure, not a summary", async () => {
    // A child that hit its turn limit has also produced text. Folding that into
    // an ok result makes an abandoned subtask read to the parent as a finished
    // one, which is exactly the confusion the parent cannot detect.
    const ex = new ToolExecutor({
      cwd,
      runAgent: async () => ({ ok: false, reason: "turn_limit", runId: "r7", summary: "got partway" }),
    });
    const r = await ex.run({ id: "1", name: "task", arguments: { agent: "explorer", prompt: "look" }, repaired: false, validated: true });
    ex.close();
    expect(r.ok).toBe(false);
    expect(r.output).toContain("turn_limit");
    expect(r.output).toContain("r7");
  });

  it("passes a finished subagent's summary through with its run id", async () => {
    const ex = new ToolExecutor({
      cwd,
      runAgent: async () => ({ ok: true, reason: "done", runId: "r8", summary: "found it in parse.ts" }),
    });
    const r = await ex.run({ id: "1", name: "task", arguments: { agent: "explorer", prompt: "look" }, repaired: false, validated: true });
    ex.close();
    expect(r.ok).toBe(true);
    expect(r.output).toContain("found it in parse.ts");
    expect(r.output).toContain("r8");
  });

  it("lets a PreToolUse hook veto a call", async () => {
    const ex = new ToolExecutor({
      cwd,
      hooks: { PreToolUse: [{ matcher: "bash", command: "exit 1", blocking: true }] },
    });
    const r = await ex.run({ id: "1", name: "bash", arguments: { command: "echo nope" }, repaired: false, validated: true });
    ex.close();
    expect(r.ok).toBe(false);
    expect(r.output).toContain("blocked by a PreToolUse hook");
  });

  it("surfaces a failing PostToolUse hook without pretending the tool failed", async () => {
    const ex = new ToolExecutor({
      cwd,
      hooks: { PostToolUse: [{ command: "echo lint-failed >&2; exit 1" }] },
    });
    const r = await ex.run({ id: "1", name: "bash", arguments: { command: "echo ok" }, repaired: false, validated: true });
    ex.close();
    expect(r.ok).toBe(true);
    expect(r.output).toContain("[hooks]");
    expect(r.output).toContain("lint-failed");
  });

  it("extracts the paths a patch touches, for the hook environment", () => {
    const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-old\n+new\n--- a/y.ts\n+++ b/y.ts\n";
    expect(patchPaths(patch)).toEqual(["src/x.ts", "y.ts"]);
  });

  it("writes a file without the content passing through a shell", async () => {
    // The reason this tool exists. Given only `apply_patch` and `bash`, the
    // model wrote files with heredocs and had to escape the file's own
    // contents; a backtick or a `$` in the code became a shell problem on top
    // of the task. Here the content is an argument, so nothing in it is
    // interpreted.
    const dir = mkdtempSync(join(tmpdir(), "motifcode-write-"));
    const ex = new ToolExecutor({ cwd: dir });
    const content = "const s = `${x}` // $(rm -rf /) 'quoted' \"double\"\n";
    const r = await ex.run({
      id: "1", name: "write", arguments: { path: "src/deep/x.ts", content },
      repaired: false, validated: true,
    });
    ex.close();
    expect(r.ok).toBe(true);
    // Parent directories are created, because the alternative is a `mkdir -p`
    // turn and a turn costs a model request.
    expect(readFileSync(join(dir, "src/deep/x.ts"), "utf8")).toBe(content);
    expect(r.output).toContain("created");
  });

  it("says whether a write created or replaced the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motifcode-write2-"));
    writeFileSync(join(dir, "a.txt"), "old\n");
    const ex = new ToolExecutor({ cwd: dir });
    const r = await ex.run({
      id: "1", name: "write", arguments: { path: "a.txt", content: "new\n" },
      repaired: false, validated: true,
    });
    ex.close();
    expect(r.output).toContain("replaced");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new\n");
  });

  it("applies a patch with miscounted hunks and no trailing newline", async () => {
    // Both faults arrived together in one real patch, and either alone is
    // enough for `git apply` to reject it. What it says is "corrupt patch at
    // line 14", which names the diff's last line rather than the missing byte
    // after it — so a model asked to repair from that message is being pointed
    // at the wrong thing. Over a campaign of 12 calls this tool applied once.
    const dir = mkdtempSync(join(tmpdir(), "motifcode-patch-"));
    writeFileSync(join(dir, "lib.rs"), "one\ntwo\nthree\n}\n");
    const ex = new ToolExecutor({ cwd: dir });
    // Header claims 5 old and 7 new; the body carries 4 and 6. Ends on `}`
    // with nothing after it.
    const patch = "--- a/lib.rs\n+++ b/lib.rs\n@@ -1,5 +1,7 @@\n-one\n-two\n-three\n+1\n+2\n+3\n+4\n+5\n }";
    const r = await ex.run({
      id: "1", name: "apply_patch", arguments: { patch }, repaired: false, validated: true,
    });
    ex.close();
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "lib.rs"), "utf8")).toBe("1\n2\n3\n4\n5\n}\n");
  });

  it("names the cause when a patch is rejected", () => {
    // The three shapes the failures actually took. Each hint is appended to
    // git's own message rather than replacing it.
    expect(patchHint("@@ -1,4 +1,3 @@\n-a\n+b\n", "error: No valid patches in input"))
      .toContain("no `--- a/path`");
    expect(patchHint("--- a/x\n+++ b/x\n@@\n-a\n", "error: x: does not exist in index"))
      .toContain("not in the tree");
    expect(patchHint("--- a/x\n+++ b/x\n@@\n-a\n", "error: patch failed: x:7"))
      .toContain("context lines do not match");
    // Nothing to add when git's message is already specific.
    expect(patchHint("--- a/x\n+++ b/x\n@@\n-a\n", "error: unrecognized input")).toBe("");
  });
});

describe("doctor", () => {
  const models = (id: string, maxLen?: number) =>
    async () =>
      new Response(JSON.stringify({ data: [{ id, ...(maxLen ? { max_model_len: maxLen } : {}) }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

  it("reports a healthy endpoint", async () => {
    const checks = await doctor({
      endpoint: "http://x",
      fetchImpl: models("Motif-Technologies/Motif-3", 262_144) as unknown as typeof fetch,
    });
    expect(checks.find((c) => c.name === "endpoint")!.state).toBe("ok");
    expect(checks.find((c) => c.name === "model family")!.state).toBe("ok");
    expect(checks.find((c) => c.name === "context length")!.state).toBe("ok");
  });

  it("warns about a non-Motif model", async () => {
    const checks = await doctor({
      endpoint: "http://x",
      fetchImpl: models("meta-llama/Llama-3") as unknown as typeof fetch,
    });
    expect(checks.find((c) => c.name === "model family")!.state).toBe("warn");
  });

  it("names the server flags the API cannot report", async () => {
    // The silent killers: without the fork's parser, malformed tool calls are
    // dropped and the user blames the model.
    const checks = await doctor({
      endpoint: "http://x",
      fetchImpl: models("Motif-3") as unknown as typeof fetch,
    });
    const text = formatChecks(checks);
    expect(text).toContain("--tool-call-parser motif");
    expect(text).toContain("--reasoning-parser motif");
    expect(text).toContain("--enable-prefix-caching");
    expect(worstState(checks)).not.toBe("fail");
  });

  it("fails cleanly when nothing is listening", async () => {
    const checks = await doctor({
      endpoint: "http://x",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(worstState(checks)).toBe("fail");
    // The sandbox check does not depend on a server and is reported either
    // way: a user who first learns the explorer cannot run commands at the
    // moment it refuses one has been told too late.
    expect(checks.map((c) => c.name)).toEqual(["sandbox", "endpoint"]);
  });

  it("warns when the box cannot hold the full checkpoint", async () => {
    const checks = await doctor({
      endpoint: "http://x",
      fetchImpl: models("Motif-3") as unknown as typeof fetch,
      deviceMemoryBytes: 121.6 * 2 ** 30,
    });
    const mem = checks.find((c) => c.name === "memory")!;
    expect(mem.state).toBe("warn");
    expect(mem.fix).toContain("pruned coding checkpoint");
  });
});
