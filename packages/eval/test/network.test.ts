/**
 * The network rule: what invalidates a row, what does not, and how the three
 * harnesses' logs are read.
 *
 * A false positive costs a row a correct answer and a false negative lets a
 * fetched answer count, so both directions are pinned here.
 */

import { describe, expect, it } from "vitest";
import { actionsFromLog, networkViolations, simpleCommands, type AgentAction } from "../src/network.js";

const bash = (command: string): AgentAction => ({ tool: "bash", command });
const reasons = (commands: string[]) => networkViolations(commands.map(bash)).map((v) => v.reason);

describe("splitting a command line", () => {
  it("splits at operators outside quotes, and drops assignments and wrappers", () => {
    expect(simpleCommands(`FOO=1 sudo -n curl -s x && echo "a; b" | wc -l`)).toEqual([
      ["curl", "-s", "x"],
      ["echo", "a; b"],
      ["wc", "-l"],
    ]);
  });

  it("reads what a shell's -c runs, the way Codex wraps every command", () => {
    expect(simpleCommands(`/bin/zsh -lc 'cd /w && wget -q https://example.com/x'`)).toEqual([
      ["cd", "/w"],
      ["wget", "-q", "https://example.com/x"],
    ]);
  });

  it("does not read a heredoc's body as commands", () => {
    expect(simpleCommands("cat > notes.md <<'EOF'\ncurl is how you would fetch it\nEOF\nls")).toEqual([
      ["cat", ">", "notes.md"],
      ["ls"],
    ]);
  });
});

describe("what invalidates a row", () => {
  it("downloads, package installs and git remote operations", () => {
    expect(
      reasons([
        "curl -sL https://example.com/tests.py -o t.py",
        "wget http://x/y",
        "pip install numpy",
        "python3 -m pip install requests",
        "npm install lodash",
        "npm ci",
        "yarn add left-pad",
        "go get golang.org/x/exp",
        "go mod download",
        "cargo add itertools",
        "git clone https://github.com/exercism/python",
        "git -C repo fetch origin",
        "brew install boost",
        "npx --yes create-thing",
      ]),
    ).toEqual([
      "downloads with curl",
      "downloads with wget",
      "pip install",
      "pip install",
      "npm install",
      "npm ci",
      "yarn add",
      "go get",
      "go mod",
      "cargo add",
      "git clone",
      "git fetch",
      "brew install",
      "npx downloading a package",
    ]);
  });

  it("a URL on a source or package host anywhere in a command", () => {
    const found = reasons([`python3 -c "import urllib.request as u; print(u.urlopen('https://raw.githubusercontent.com/exercism/x/main/t.py').read())"`]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("githubusercontent.com");
  });

  it("any web tool call", () => {
    expect(networkViolations([{ tool: "webfetch", command: "https://exercism.org" }, { tool: "web_search" }]).map((v) => v.reason)).toEqual([
      "web tool",
      "web tool",
    ]);
  });
});

describe("what does not", () => {
  it("running the tests and builds, searching, writing files that mention the words", () => {
    expect(
      reasons([
        "npm test",
        "npm run test",
        "npx jest grep.spec.js",
        "go test ./...",
        "go mod tidy",
        "cargo test -- --include-ignored",
        "./gradlew test",
        "python3 -m pytest -q",
        'grep -rn "curl" .',
        'echo "pip install is not allowed"',
        "git status && git diff",
        "cat > README <<EOF\ncurl https://github.com/x\nEOF",
        "mkdir -p build && cd build && cmake .. && make",
      ]),
    ).toEqual([]);
  });
});

describe("reading the three harnesses' logs", () => {
  it("motifcode: tool_start events in every scope, bash commands and term keystrokes", () => {
    const line = (scope: string, name: string, args: Record<string, unknown>) =>
      JSON.stringify({ v: 2, scopeId: scope, record: { t: "event", event: { type: "tool_start", call: { id: "c", name, arguments: args } } } });
    const log = [
      JSON.stringify({ t: "header", header: {} }),
      line("root", "bash", { command: "ls" }),
      line("sub-explorer-1", "term", { keystrokes: "curl x\n" }),
      line("root", "write", { path: "a.py", content: "curl" }),
    ].join("\n");
    expect(actionsFromLog(log)).toEqual([
      { tool: "bash", command: "ls" },
      { tool: "term", command: "curl x\n" },
      { tool: "write" },
    ]);
    expect(networkViolations(actionsFromLog(log))).toHaveLength(1);
  });

  it("codex: command_execution items, counted once across started and completed", () => {
    const item = (type: string, id: string, extra: Record<string, unknown>) =>
      JSON.stringify({ type, item: { id, type: "command_execution", ...extra } });
    const log = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      item("item.started", "item_1", { command: "/bin/zsh -lc 'go test ./...'" }),
      item("item.completed", "item_1", { command: "/bin/zsh -lc 'go test ./...'", exit_code: 0 }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "curl it" } }),
    ].join("\n");
    expect(actionsFromLog(log)).toEqual([{ tool: "shell", command: "/bin/zsh -lc 'go test ./...'" }]);
  });

  it("opencode: tool parts, each call once", () => {
    const part = (tool: string, input: Record<string, unknown>, id: string) =>
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool, callID: id, state: { status: "completed", input } } });
    const log = [part("bash", { command: "ls -la" }, "a"), part("bash", { command: "ls -la" }, "a"), part("webfetch", { url: "https://github.com/x" }, "b")].join("\n");
    expect(actionsFromLog(log)).toEqual([
      { tool: "bash", command: "ls -la" },
      { tool: "webfetch", command: "https://github.com/x" },
    ]);
    expect(networkViolations(actionsFromLog(log)).map((v) => v.reason)).toEqual(["web tool"]);
  });
});
