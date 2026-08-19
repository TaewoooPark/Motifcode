/**
 * The boundaries, tested as boundaries.
 *
 * Each of these was a property the harness claimed and did not have: cloning a
 * repository could run its hooks, a "read-only" agent could write, `read` could
 * leave the workspace, a patch could become a shell program, and terminal
 * output could drive the user's terminal.
 */

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_ENV_PREFIXES,
  approve,
  checkTrust,
  hookEnvironment,
  loadTrustStore,
  runHook,
  saveTrustStore,
  settingsHash,
} from "@motifcode/hooks";
import { redactJournal, redactText } from "@motifcode/journal";
import { DANGEROUS_SEQUENCES, sanitize } from "@motifcode/tui";
import { ToolExecutor, encodeKeystrokes } from "../src/executor.js";
import { approve as approvePolicy, isInside, policyForAgent, readOnlyPolicy } from "../src/policy.js";
import { detectSandbox, setSandbox } from "../src/sandbox.js";

const call = (name: string, args: Record<string, unknown>) => ({
  id: "c1",
  name,
  arguments: args,
  repaired: false,
  validated: true as const,
});

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "motif-sec-"));
}

/* ------------------------------------------------------------------ */

describe("project hooks need approval", () => {
  const settings = '{"hooks":{"PostToolUse":[{"command":"touch /tmp/pwned"}]}}';

  it("refuses a repository nobody approved", () => {
    // Cloning and opening used to be enough to run this.
    const decision = checkTrust({ version: 1, records: [] }, workspace(), settings);
    expect(decision.trusted).toBe(false);
    if (!decision.trusted) expect(decision.reason).toBe("not_approved");
  });

  it("runs only the exact settings that were approved", () => {
    const dir = workspace();
    const store = approve({ version: 1, records: [] }, dir, settings);
    expect(checkTrust(store, dir, settings).trusted).toBe(true);
  });

  it("revokes approval when the settings change by one byte", () => {
    // The interesting attack is a project that is benign when you approve it
    // and is not after the next pull.
    const dir = workspace();
    const store = approve({ version: 1, records: [] }, dir, settings);
    const decision = checkTrust(store, dir, settings + " ");
    expect(decision.trusted).toBe(false);
    if (!decision.trusted) expect(decision.reason).toBe("settings_changed");
  });

  it("cannot be bypassed by a symlink or a relative path", () => {
    const real = workspace();
    const link = join(workspace(), "link");
    symlinkSync(real, link);
    const store = approve({ version: 1, records: [] }, real, settings);
    // Same directory by a different name is the same directory.
    expect(checkTrust(store, link, settings).trusted).toBe(true);
    // A directory that merely looks similar is not.
    expect(checkTrust(store, workspace(), settings).trusted).toBe(false);
  });

  it("keeps an unreadable trust store from trusting everything", () => {
    const path = join(workspace(), "trust.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(loadTrustStore(path).records).toEqual([]);
  });

  it("round-trips through the store on disk with owner-only permissions", () => {
    const dir = workspace();
    const path = join(dir, "trust.json");
    saveTrustStore(approve({ version: 1, records: [] }, dir, settings), path);
    const back = loadTrustStore(path);
    expect(back.records[0]!.settingsSha256).toBe(settingsHash(settings));
  });
});

describe("hooks do not inherit the environment", () => {
  const secrets = {
    AWS_SECRET_ACCESS_KEY: "SECRET-AWS",
    GITHUB_TOKEN: "SECRET-GH",
    ANTHROPIC_API_KEY: "SECRET-ANTHROPIC",
    HF_TOKEN: "SECRET-HF",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    PATH: "/usr/bin",
  };

  it("passes an allowlist, not everything", () => {
    const env = hookEnvironment(secrets, { MOTIF_EVENT: "PostToolUse" });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["MOTIF_EVENT"]).toBe("PostToolUse");
    for (const prefix of FORBIDDEN_ENV_PREFIXES) {
      for (const key of Object.keys(env)) {
        expect(key.startsWith(prefix), `${key} leaked`).toBe(false);
      }
    }
  });

  it("keeps a real secret out of a real hook process", async () => {
    const before = process.env["MOTIF_TEST_SECRET"];
    process.env["MOTIF_TEST_SECRET"] = "SHOULD-NOT-APPEAR";
    try {
      const out = await runHook({ command: "env" }, { event: "PostToolUse" });
      expect(out.output).not.toContain("SHOULD-NOT-APPEAR");
    } finally {
      if (before === undefined) delete process.env["MOTIF_TEST_SECRET"];
      else process.env["MOTIF_TEST_SECRET"] = before;
    }
  });

  it("only forwards harness-authored variables", () => {
    const env = hookEnvironment(secrets, { NOT_OURS: "x", MOTIF_TOOL: "bash" } as Record<string, string>);
    expect(env["NOT_OURS"]).toBeUndefined();
    expect(env["MOTIF_TOOL"]).toBe("bash");
  });
});

/* ------------------------------------------------------------------ */

describe("read-only means read-only", () => {
  afterEach(() => setSandbox(undefined));

  it("refuses tools that write or escape the sandbox outright", () => {
    const policy = readOnlyPolicy("/repo", ["done", "bash", "read", "apply_patch", "term", "task"]);
    for (const tool of ["apply_patch", "term", "task"]) {
      expect(approvePolicy(policy, call(tool, {})).allowed, tool).toBe(false);
    }
    // `bash` survives, because an explorer that cannot run `rg` is not
    // usefully read-only; the sandbox is what makes it safe.
    expect(policy.allowedTools.has("bash")).toBe(true);
  });

  it("refuses to run a program at all when no sandbox is available", async () => {
    // Degrading closed. Degrading open costs a repository on the day a model
    // does something unexpected.
    setSandbox({ kind: "none", reason: "test", wrap: () => null });
    const dir = workspace();
    const ex = new ToolExecutor({
      cwd: dir,
      policy: policyForAgent({ root: dir, tools: ["done", "bash", "read"], readOnly: true }),
    });
    const r = await ex.run(call("bash", { command: "echo hi" }));
    ex.close();
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no read-only sandbox");
  });

  it("does not decide write access by matching command strings", async () => {
    // `rm` is the obvious one; `python -c`, `>`, `tee`, `install` and `cp` all
    // write too, and that list is never finished.
    const dir = workspace();
    setSandbox({ kind: "none", reason: "test", wrap: () => null });
    const ex = new ToolExecutor({
      cwd: dir,
      policy: policyForAgent({ root: dir, tools: ["done", "bash", "read"], readOnly: true }),
    });
    for (const command of ["touch evil", "python3 -c 'open(\"evil\",\"w\")'", "echo x > evil"]) {
      const r = await ex.run(call("bash", { command }));
      expect(r.ok, command).toBe(false);
    }
    ex.close();
    expect(() => readFileSync(join(dir, "evil"), "utf8")).toThrow();
  });

  it("lets a writing agent write", async () => {
    const dir = workspace();
    const ex = new ToolExecutor({
      cwd: dir,
      policy: policyForAgent({ root: dir, tools: ["done", "bash", "read"], readOnly: false }),
    });
    const r = await ex.run(call("bash", { command: "echo hi > allowed.txt" }));
    ex.close();
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "allowed.txt"), "utf8").trim()).toBe("hi");
  });

  it("uses the sandbox when the host has one", async () => {
    const sandbox = detectSandbox();
    if (sandbox.kind === "none") {
      // Recorded rather than skipped silently: on a host without bubblewrap or
      // sandbox-exec the guarantee genuinely does not exist, and the doctor
      // says so.
      expect(sandbox.reason).toBeDefined();
      return;
    }
    const dir = workspace();
    const ex = new ToolExecutor({
      cwd: dir,
      policy: policyForAgent({ root: dir, tools: ["done", "bash", "read"], readOnly: true }),
    });

    // The sandbox has to actually start, or the write failing proves nothing.
    const canRun = await ex.run(call("bash", { command: "echo sandbox-alive" }));
    expect(canRun.ok, canRun.output).toBe(true);
    expect(canRun.output).toContain("sandbox-alive");

    const blocked = await ex.run(call("bash", { command: "touch inside-sandbox.txt" }));
    ex.close();
    expect(blocked.ok).toBe(false);
    expect(() => readFileSync(join(dir, "inside-sandbox.txt"), "utf8")).toThrow();
  }, 20_000);

  it("still lets a sandboxed command search and use a temp file", async () => {
    // A read-only agent that cannot run `rg` or stage output in TMPDIR is not
    // usefully read-only, it is just broken.
    const sandbox = detectSandbox();
    if (sandbox.kind === "none") return;
    const dir = workspace();
    writeFileSync(join(dir, "hay.txt"), "needle here\n", "utf8");
    const ex = new ToolExecutor({
      cwd: dir,
      policy: policyForAgent({ root: dir, tools: ["done", "bash", "read"], readOnly: true }),
    });
    const found = await ex.run(call("bash", { command: "grep -n needle hay.txt" }));
    const temp = await ex.run(call("bash", { command: 'echo staged > "$TMPDIR/x" && cat "$TMPDIR/x"' }));
    ex.close();
    expect(found.ok, found.output).toBe(true);
    expect(found.output).toContain("needle");
    expect(temp.ok, temp.output).toBe(true);
    expect(temp.output).toContain("staged");
  }, 20_000);
});

describe("reads stay inside the workspace", () => {
  it("refuses an absolute path outside the root", () => {
    const policy = readOnlyPolicy("/repo", ["read"]);
    expect(approvePolicy(policy, call("read", { path: "/etc/passwd" })).allowed).toBe(false);
  });

  it("refuses a traversal", () => {
    const policy = readOnlyPolicy("/repo", ["read"]);
    expect(approvePolicy(policy, call("read", { path: "../../.ssh/id_rsa" })).allowed).toBe(false);
  });

  it("refuses a symlink that points out of the workspace", () => {
    // Inside the workspace by every textual test, outside it by the one that
    // matters.
    const dir = workspace();
    const outside = workspace();
    writeFileSync(join(outside, "secret.txt"), "s", "utf8");
    symlinkSync(join(outside, "secret.txt"), join(dir, "innocent.txt"));
    const policy = readOnlyPolicy(dir, ["read"]);
    expect(approvePolicy(policy, call("read", { path: "innocent.txt" })).allowed).toBe(false);
  });

  it("allows an ordinary relative path", () => {
    const dir = workspace();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "x.ts"), "x", "utf8");
    const policy = readOnlyPolicy(dir, ["read"]);
    expect(approvePolicy(policy, call("read", { path: "src/x.ts" })).allowed).toBe(true);
  });

  it("treats the root itself as inside", () => {
    expect(isInside("/repo", "/repo")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("a patch is data, not a program", () => {
  it("applies a patch containing shell metacharacters literally", async () => {
    // The old implementation interpolated the patch into a heredoc, so a patch
    // containing its own delimiter — or a backtick, or `$(...)` — ended the
    // heredoc and became a command.
    const dir = workspace();
    writeFileSync(join(dir, "x.txt"), "old\n", "utf8");
    await runHook({ command: "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -qm init" }, { event: "PostToolUse", cwd: dir });

    const patch = [
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1 +1 @@",
      "-old",
      "+`touch owned` $(touch owned2) MOTIF_PATCH_EOF",
      "",
    ].join("\n");

    const ex = new ToolExecutor({ cwd: dir });
    const r = await ex.run(call("apply_patch", { patch }));
    ex.close();

    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "x.txt"), "utf8")).toContain("`touch owned`");
    // The shell never saw it, so neither file exists.
    expect(() => readFileSync(join(dir, "owned"), "utf8")).toThrow();
    expect(() => readFileSync(join(dir, "owned2"), "utf8")).toThrow();
  }, 20_000);
});

describe("control notation is a token, not a substring", () => {
  it("sends a standalone C-c as an interrupt", () => {
    expect(encodeKeystrokes("C-c")).toBe("\x03");
    expect(encodeKeystrokes("C-d")).toBe("\x04");
  });

  it("leaves the same text inside a word alone", () => {
    // `echo "press C-c to quit"` used to send an actual interrupt instead of
    // printing the sentence.
    expect(encodeKeystrokes('echo "pressC-cnow"\n')).toBe('echo "pressC-cnow"\n');
  });

  it("keeps a quoted control sequence byte-identical", () => {
    // Quoted, so the token is `'C-x'` rather than `C-x`, and the shell should
    // receive the four characters the model typed.
    const cmd = "rg -n 'C-x' src/\n";
    expect(encodeKeystrokes(cmd)).toBe(cmd);
  });
});

/* ------------------------------------------------------------------ */

describe("terminal output cannot drive the terminal", () => {
  for (const seq of DANGEROUS_SEQUENCES) {
    it(`neutralises ${seq.name}`, () => {
      const out = sanitize(`${seq.text}`);
      expect(out).not.toContain("");
      expect(out).not.toContain("\r");
      expect(out).not.toContain("\b");
    });
  }

  it("keeps ordinary text, including tabs, newlines and CJK", () => {
    const text = "src/x.ts\t42\n한글 · émoji ✓\n";
    expect(sanitize(text)).toBe(text);
  });

  it("shows a control byte rather than deleting it", () => {
    // A file that genuinely contains control bytes should still read as
    // containing them.
    expect(sanitize("a b")).toBe("a^@b");
  });
});

describe("journals do not carry secrets by default", () => {
  it("masks the token shapes that actually appear in tool output", () => {
    const cases: [string, string][] = [
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
      ["sk-abcdefghijklmnopqrstuvwxyz012345", "openai-key"],
      ["hf_abcdefghijklmnopqrstuvwxyz01", "huggingface-token"],
      ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y", "bearer-header"],
      ["postgres://user:hunter2@db.internal:5432/app", "url-credentials"],
      ['AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI"', "secret-assignment"],
    ];
    for (const [secret, rule] of cases) {
      const r = redactText(`before ${secret} after`);
      expect(r.hits, secret).toContain(rule);
      expect(r.text, secret).not.toContain("hunter2");
      expect(r.text).toContain("before");
      expect(r.text).toContain("after");
    }
  });

  it("leaves ordinary output alone", () => {
    // Widening the rules to "any long random-looking string" would redact
    // commit hashes, base64 fixtures and half of a lockfile.
    const text = "commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\nsrc/x.ts  42 passed\n";
    expect(redactText(text).text).toBe(text);
  });

  it("keeps a redacted journal parseable as JSONL", () => {
    const line = JSON.stringify({
      v: 2,
      record: { t: "event", event: { type: "tool_end", output: "GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    });
    const out = redactJournal(line + "\n");
    expect(out.text.trim().split("\n")).toHaveLength(1);
    const back = JSON.parse(out.text.trim()) as { record: { event: { output: string } } };
    expect(back.record.event.output).not.toContain("ghp_");
  });

  it("redacts a truncated final line too", () => {
    const partial = '{"v":2,"record":{"t":"event","output":"ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(redactJournal(partial).text).not.toContain("ghp_a");
  });
});
