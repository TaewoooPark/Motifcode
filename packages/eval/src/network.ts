/**
 * The network rule, fixed before any row runs.
 *
 * With the graded tests hidden, an agent has a reason to look for them, and
 * Exercism's tests and example solutions are public. HAL caught agents looking
 * a benchmark up instead of solving it. The first line of defence is a
 * network that reaches the model endpoint and nothing else; where the agents
 * run on a host that cannot be restricted, this is the second: every command
 * and tool call an agent made is read back from its own log, and a row that
 * fetched from outside, installed a package or called a web tool is invalid.
 *
 * The rule is a constant with a version. Changing it after rows have run
 * would let the result decide which rows count, so a change is a new version,
 * recorded in every row it judged.
 *
 * What it looks for is what a person would call fetching: a download command,
 * a package installer, a git remote operation, a web tool, or a URL on a
 * source-code or package host anywhere in a command. Build tools fetching
 * their own declared dependencies — Gradle resolving JUnit — are the
 * exercise's infrastructure and are not counted; the grader restores every
 * build file anyway, so a dependency an agent added cannot pass.
 */

export const NETWORK_RULE = "network-v1";

/** One thing an agent did: a tool call, and the command when it ran one. */
export interface AgentAction {
  tool: string;
  command?: string;
}

export interface NetworkViolation {
  tool: string;
  command?: string;
  reason: string;
}

const WEB_TOOL = /^(web[_-]?fetch|web[_-]?search|fetch_url|http_request|browser[_a-z-]*)$/i;

const SOURCE_HOSTS =
  /\b(?:https?:\/\/|git@)(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|exercism\.(?:org|io)|pypi\.org|pythonhosted\.org|npmjs\.(?:org|com)|yarnpkg\.com|crates\.io|golang\.org|pkg\.go\.dev|maven\.org|huggingface\.co)\b/i;

/**
 * Programs that only print, search or move text: a source-host URL among
 * their arguments is being written down, not fetched.
 */
const QUIET = new Set([
  "echo", "printf", "cat", "grep", "egrep", "rg", "sed", "awk", "tee", "ls", "find", "head", "tail", "wc",
  "diff", "cp", "mv", "mkdir", "touch", "rm", "test", "[", "git", "sort", "uniq", "cut", "tr", "less", "more",
]);

/** Wrappers that run the command after them. */
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "nice", "timeout", "gtimeout", "stdbuf"]);

/**
 * The simple commands in a command line, as a shell would split them: at
 * unquoted `;`, `&&`, `||`, `|`, `&`, newlines, `$(`, backticks and
 * parentheses, into words with their quotes removed. A heredoc's body is data,
 * not commands, and is skipped: an agent writing a file through `cat <<EOF`
 * has not run what the file says. A shell run with `-c` is split again, so
 * `bash -c "curl …"` and Codex's `zsh -lc '…'` are read for what they run.
 */
export function simpleCommands(command: string, depth = 0): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  const heredocs: string[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i]!;
    if (c === "\\" && i + 1 < n) {
      word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      const end = close === -1 ? n : close;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(i));
      if (m) {
        heredocs.push(m[2]!);
        i += m[0].length;
        continue;
      }
    }
    if (c === "\n") {
      endCommand();
      i++;
      // The bodies of the heredocs opened on the line just ended.
      while (heredocs.length > 0) {
        const tag = heredocs.shift()!;
        const re = new RegExp(`^[ \\t]*${tag}[ \\t]*$`, "m");
        const rest = command.slice(i);
        const m = re.exec(rest);
        i = m ? i + m.index + m[0].length : n;
      }
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      endCommand();
      i += 2;
      continue;
    }
    if (";&|`()".includes(c)) {
      endCommand();
      i += c === "&" && command[i + 1] === "&" ? 2 : c === "|" && command[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand();

  const expanded: string[][] = [];
  for (const cmd of out) {
    let k = 0;
    // Leading assignments and wrappers, and a wrapper's own options.
    for (;;) {
      const w = cmd[k];
      if (w === undefined) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) k++;
      else if (WRAPPERS.has(w.split("/").pop()!)) {
        k++;
        while (cmd[k]?.startsWith("-") || /^\d+[smh]?$/.test(cmd[k] ?? "")) k++;
      } else break;
    }
    const rest = cmd.slice(k).map((w, j) => (j === 0 ? w.split("/").pop()! : w));
    if (rest.length === 0) continue;
    const c = rest.indexOf("-c") !== -1 ? rest.indexOf("-c") : rest.findIndex((w) => /^-[a-z]*c$/.test(w));
    if (depth < 3 && /^(ba|z|da|k)?sh$/.test(rest[0]!) && c !== -1 && rest[c + 1] !== undefined) {
      expanded.push(...simpleCommands(rest[c + 1]!, depth + 1));
    } else {
      expanded.push(rest);
    }
  }
  return expanded;
}

function commandReason(words: string[]): string | undefined {
  const [cmd, ...args] = words;
  const sub = args.find((a) => !a.startsWith("-"));
  switch (cmd) {
    case "curl":
    case "wget":
    case "aria2c":
    case "http":
    case "https":
    case "xh":
      return `downloads with ${cmd}`;
    case "git": {
      // Past the options that take a value: `git -C dir clone …`.
      let k = 0;
      while (k < args.length && args[k]!.startsWith("-")) k += ["-C", "-c", "--git-dir", "--work-tree"].includes(args[k]!) ? 2 : 1;
      const verb = args[k];
      return verb && ["clone", "fetch", "pull", "ls-remote", "submodule"].includes(verb) ? `git ${verb}` : undefined;
    }
    case "pip":
    case "pip3":
    case "pipx":
      return sub === "install" || sub === "download" ? `${cmd} ${sub}` : undefined;
    case "python":
    case "python3": {
      const m = args.indexOf("-m");
      return m !== -1 && /^(pip|pip3)$/.test(args[m + 1] ?? "") && ["install", "download"].includes(args[m + 2] ?? "")
        ? "pip install"
        : undefined;
    }
    case "uv":
      return (sub === "pip" && args.includes("install")) || sub === "add" || sub === "tool" ? `uv ${sub}` : undefined;
    case "poetry":
      return sub === "add" || sub === "install" ? `poetry ${sub}` : undefined;
    case "npm":
      return sub && ["install", "i", "add", "ci", "update"].includes(sub) ? `npm ${sub}` : undefined;
    case "npx":
      return args.some((a) => ["-y", "--yes", "-p", "--package"].includes(a)) ? "npx downloading a package" : undefined;
    case "yarn":
    case "pnpm":
    case "bun":
      return sub && ["add", "install", "i", "dlx", "x"].includes(sub) ? `${cmd} ${sub}` : undefined;
    case "go":
      return sub === "get" || sub === "install" || (sub === "mod" && args.includes("download")) ? `go ${sub}` : undefined;
    case "cargo":
      return sub && ["install", "add", "fetch"].includes(sub) ? `cargo ${sub}` : undefined;
    case "gem":
    case "brew":
    case "apt":
    case "apt-get":
    case "yum":
    case "dnf":
    case "apk":
    case "port":
      return sub === "install" ? `${cmd} install` : undefined;
    default:
      return undefined;
  }
}

/**
 * A source-code or package host named in a command that could reach it: the
 * `urlopen(...)` inside a `python3 -c`, a `node -e` fetch, a browser opened on
 * it. Printing or grepping the URL is not reaching it.
 */
function urlReason(words: string[]): string | undefined {
  if (QUIET.has(words[0]!)) return undefined;
  for (const w of words) {
    const m = SOURCE_HOSTS.exec(w);
    if (m) return `reaches ${m[0]}`;
  }
  return undefined;
}

/** Every violation among an agent's actions, in the order they happened. */
export function networkViolations(actions: readonly AgentAction[]): NetworkViolation[] {
  const out: NetworkViolation[] = [];
  for (const a of actions) {
    if (WEB_TOOL.test(a.tool)) {
      out.push({ tool: a.tool, ...(a.command !== undefined ? { command: a.command } : {}), reason: "web tool" });
      continue;
    }
    if (a.command === undefined) continue;
    const reason = simpleCommands(a.command)
      .map((words) => commandReason(words) ?? urlReason(words))
      .find((r) => r !== undefined);
    if (reason) out.push({ tool: a.tool, command: a.command.slice(0, 500), reason });
  }
  return out;
}

function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A torn line from a killed process.
    }
  }
  return out;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The actions in a log, whichever of the three harnesses wrote it: a motifcode
 * journal (`tool_start` events, every scope), `codex exec --json` items, or
 * `opencode run --format json` tool parts. Lines of any other shape are skipped.
 */
export function actionsFromLog(text: string): AgentAction[] {
  const out: AgentAction[] = [];
  const seen = new Set<string>();
  for (const line of jsonLines(text)) {
    const o = obj(line);
    if (!o) continue;
    // motifcode: {record: {t: "event", event: {type: "tool_start", call: {name, arguments}}}}
    const event = obj(obj(o["record"])?.["event"]);
    if (event?.["type"] === "tool_start") {
      const call = obj(event["call"]);
      const args = obj(call?.["arguments"]);
      const name = str(call?.["name"]) ?? "?";
      const command = str(args?.["command"]) ?? str(args?.["keystrokes"]);
      out.push({ tool: name, ...(command !== undefined ? { command } : {}) });
      continue;
    }
    // codex: {type: "item.started" | "item.completed", item: {id, type, command}}
    const item = obj(o["item"]);
    if (item && typeof o["type"] === "string" && String(o["type"]).startsWith("item.")) {
      const id = str(item["id"]) ?? "";
      const type = str(item["type"]) ?? "";
      if (seen.has(`codex:${id}:${type}`)) continue;
      if (type === "command_execution") {
        seen.add(`codex:${id}:${type}`);
        out.push({ tool: "shell", ...(str(item["command"]) !== undefined ? { command: str(item["command"])! } : {}) });
      } else if (/web_search|web_fetch/.test(type)) {
        seen.add(`codex:${id}:${type}`);
        out.push({ tool: "web_search", ...(str(item["query"]) !== undefined ? { command: str(item["query"])! } : {}) });
      } else if (type === "mcp_tool_call") {
        seen.add(`codex:${id}:${type}`);
        out.push({ tool: `mcp:${str(item["tool"]) ?? "?"}` });
      }
      continue;
    }
    // opencode: {type: "tool_use", part: {tool, callID, state: {input: {command}}}}
    const part = obj(o["part"]);
    if (o["type"] === "tool_use" && part) {
      const id = str(part["callID"]) ?? str(part["id"]) ?? "";
      if (id && seen.has(`opencode:${id}`)) continue;
      if (id) seen.add(`opencode:${id}`);
      const input = obj(obj(part["state"])?.["input"]);
      const tool = str(part["tool"]) ?? "?";
      const command = str(input?.["command"]) ?? str(input?.["url"]) ?? str(input?.["query"]);
      out.push({ tool, ...(command !== undefined ? { command } : {}) });
    }
  }
  return out;
}
