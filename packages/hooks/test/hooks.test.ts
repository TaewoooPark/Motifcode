import { describe, expect, it } from "vitest";
import { runHook, runHooks, selectHooks, wasBlocked, type HookConfig } from "../src/index.js";

describe("matching", () => {
  const config: HookConfig = {
    PostToolUse: [
      { matcher: "apply_patch", command: "echo patched" },
      { matcher: "bash|term", command: "echo shell" },
      { command: "echo always" },
    ],
  };

  it("matches an exact tool name", () => {
    const hits = selectHooks(config, { event: "PostToolUse", tool: "apply_patch" });
    expect(hits.map((h) => h.command)).toEqual(["echo patched", "echo always"]);
  });

  it("matches a simple alternation", () => {
    expect(selectHooks(config, { event: "PostToolUse", tool: "term" }).map((h) => h.command)).toEqual([
      "echo shell",
      "echo always",
    ]);
  });

  it("does not match by prefix", () => {
    // No globbing on purpose: a matcher that silently catches more than
    // intended is worse than one that is verbose.
    expect(selectHooks(config, { event: "PostToolUse", tool: "apply" })).toHaveLength(1);
  });

  it("ignores unrelated events", () => {
    expect(selectHooks(config, { event: "SessionStart" })).toHaveLength(0);
  });
});

describe("execution", () => {
  it("captures output and exit status", async () => {
    const out = await runHook({ command: "echo hello" }, { event: "PostToolUse" });
    expect(out.ok).toBe(true);
    expect(out.output).toBe("hello");
    expect(out.label).toBe("echo");
  });

  it("reports a non-zero exit without throwing", async () => {
    // A broken formatter must not end a session.
    const out = await runHook({ command: "exit 3" }, { event: "PostToolUse" });
    expect(out.ok).toBe(false);
    expect(out.blocked).toBe(false);
  });

  it("exports the context to the environment", async () => {
    const out = await runHook(
      { command: 'echo "$MOTIF_EVENT $MOTIF_TOOL $MOTIF_PATHS"' },
      { event: "PostToolUse", tool: "apply_patch", paths: ["a.ts", "b.ts"] },
    );
    expect(out.output).toBe("PostToolUse apply_patch a.ts b.ts");
  });

  it("kills a hook that overruns its timeout", async () => {
    const out = await runHook({ command: "sleep 5", timeoutMs: 120 }, { event: "PostToolUse" });
    expect(out.ok).toBe(false);
    expect(out.ms).toBeLessThan(3000);
  });

  it("caps runaway output so it cannot eat the context", async () => {
    const out = await runHook(
      { command: "yes abcdefghij | head -20000", timeoutMs: 10_000 },
      { event: "PostToolUse" },
    );
    expect(out.output.length).toBeLessThan(9000);
  });
});

describe("blocking", () => {
  it("vetoes a tool call when a blocking PreToolUse hook fails", async () => {
    const config: HookConfig = {
      PreToolUse: [{ matcher: "bash", command: "exit 1", blocking: true }],
    };
    const outcomes = await runHooks(config, { event: "PreToolUse", tool: "bash" });
    expect(wasBlocked(outcomes)).toBe(true);
  });

  it("stops at the first veto", async () => {
    const config: HookConfig = {
      PreToolUse: [
        { command: "exit 1", blocking: true },
        { command: "echo never" },
      ],
    };
    const outcomes = await runHooks(config, { event: "PreToolUse", tool: "bash" });
    expect(outcomes).toHaveLength(1);
  });

  it("treats a failing post hook as advisory", async () => {
    const config: HookConfig = { PostToolUse: [{ command: "exit 1", blocking: true }] };
    const outcomes = await runHooks(config, { event: "PostToolUse", tool: "bash" });
    // `blocking` only means anything before the call; afterwards there is
    // nothing left to block.
    expect(wasBlocked(outcomes)).toBe(false);
  });
});
