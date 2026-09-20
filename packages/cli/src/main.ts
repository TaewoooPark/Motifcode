#!/usr/bin/env node
/**
 * `motif` — the command line.
 *
 * Ties the packages together: transport, loop, executor, skills, agents, hooks,
 * journal and screen. Everything below it is pure or testable in isolation;
 * this file is the wiring and the argument parsing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, AgentScheduler, BUILTIN_AGENTS, concurrencyFor, parseAgent } from "@motifcode/agents";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  HttpTransport,
  defaultDotenvPaths,
  defaultEnvPath,
  forgetApiKey,
  relaxNodeHttpTimeouts,
  resolveEndpointConfig,
  runLoop,
  saveApiKey,
  withholdSecrets,
  type LoopEvent,
} from "@motifcode/core";
import { DEFAULT_HOOKS } from "@motifcode/hooks";
import {
  approve as approveTrust,
  checkTrust,
  loadTrustStore,
  runHooks,
  saveTrustStore,
  type HookConfig,
} from "@motifcode/hooks";
import {
  Journal,
  checkResumable,
  distil,
  listSessions,
  loadResume,
  newHeader,
  parseJournal,
  redactJournal,
  toTrajectories,
  type DistilFilter,
  type DistilFormat,
  type ResumeState,
  type ScopeIdentity,
} from "@motifcode/journal";
import { readFileSync as readFile } from "node:fs";
import {
  SAMPLING_DEFAULTS,
  renderPrompt,
  systemPromptHash,
  toolSchemaHash,
  type ChannelId,
  type Message,
  type Tool,
} from "@motifcode/protocol";
import { BUILTIN_SKILLS, SkillRegistry, parseSkill } from "@motifcode/skills";
import { CORE_TOOLS, CORE_TOOL_NAMES, lintTools, formatFindings, toolPrefix } from "@motifcode/tools";
import { Screen, applyTheme, themeNames } from "@motifcode/tui";
import { Chat } from "./chat.js";
import { describePlugins, loadPlugins, type LoadedPlugins } from "./plugins.js";
import { loadSettings, saveUserSetting } from "./settings.js";
import { commandOnPath, ranFromNpx } from "./install.js";
import { KEY_PAGE, normaliseKeyInput, readSecret, verifyApiKey } from "./login.js";
import { doctor, formatChecks, worstState } from "./doctor.js";
import { ToolExecutor } from "./executor.js";
import { policyForAgent } from "./policy.js";
import { buildAgentPrompt, buildSystemPrompt } from "./prompt.js";

const VERSION = "0.3.0";

interface Args {
  command: string;
  rest: string[];
  flags: Record<string, string | boolean>;
}

/** One-letter spellings, as Claude Code has them: `-p` for `--print`, `-c` for `--continue`. */
const SHORT_FLAGS: Record<string, string> = { p: "print", c: "continue", i: "interactive", v: "verbose", h: "help" };

/**
 * Flags that never take a value.
 *
 * The parser used to hand any flag the word after it, so `motif -p "fix the
 * tests"` made the task the value of `--print` and ran with no task at all.
 * Claude Code's most common invocation is flag first, then the prompt.
 */
const BOOLEAN_FLAGS = new Set([
  "print",
  "interactive",
  "chat",
  "continue",
  "no-hero",
  "thinking",
  "verbose",
  "experimental-channel",
  "include-children",
]);

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let command = "run";
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]!;
    // A short flag is its long form; the task text itself never starts with
    // a dash and a single letter.
    if (/^-[a-z]$/.test(a) && SHORT_FLAGS[a.slice(1)]) a = `--${SHORT_FLAGS[a.slice(1)]}`;
    if (a === "--help") {
      command = "help";
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(a.slice(2))) flags[a.slice(2)] = true;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else if (rest.length === 0 && ["doctor", "login", "logout", "sessions", "resume", "skills", "agents", "plugins", "config", "lint", "distil", "metrics", "trust", "redact", "corpus-spec", "corpus-render", "help", "version"].includes(a)) {
      command = a;
    } else {
      rest.push(a);
    }
  }
  return { command, rest, flags };
}

function flagStr(flags: Args["flags"], key: string, fallback: string): string {
  const v = flags[key];
  return typeof v === "string" ? v : fallback;
}

/** Raised for bad usage. Reported as one line and exit 2, never as a stack. */
class UsageError extends Error {}

function flagEnum<T extends string>(
  flags: Args["flags"],
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = flags[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new UsageError(`--${key} must be one of ${allowed.join(", ")}; got ${String(v)}`);
  }
  return v as T;
}

function flagInt(flags: Args["flags"], key: string, fallback: number, min: number): number {
  const v = flags[key];
  if (v === undefined) return fallback;
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min) {
    throw new UsageError(`--${key} must be an integer >= ${min}; got ${String(v)}`);
  }
  return n;
}

const CHANNELS = ["toolcall", "object", "raw"] as const;

/**
 * Whether an MCP adapter is wired up.
 *
 * False, and stated once rather than in two places: the tool list the harness
 * sends and the tool list a corpus is rendered against have to be the same
 * list, or the corpus describes a prompt nobody sends.
 */
const mcpConnectedDefault = false;
const CHANNEL_POLICIES = ["fixed", "adaptive"] as const;
const DISTIL_FORMATS = ["trajectory-jsonl", "profile-jsonl"] as const satisfies readonly DistilFormat[];
const DISTIL_FILTERS = ["grader-passed", "grader-failed", "all"] as const satisfies readonly DistilFilter[];

/** Distinguishes one delegated run from another in tool output and the journal. */
let runSequence = 0;
function nextRunId(prefix: string): string {
  runSequence += 1;
  return `${prefix}-${String(runSequence).padStart(3, "0")}`;
}

/* ------------------------------------------------------------------ */

const CONFIG_DIR = ".motif";

/** Plugins are read once per process; the registries take from here. */
let pluginsLoaded: LoadedPlugins | null = null;
function plugins(cwd: string): LoadedPlugins {
  pluginsLoaded ??= loadPlugins({ cwd, home: homedir() });
  return pluginsLoaded;
}

function loadSkills(cwd: string): SkillRegistry {
  const reg = new SkillRegistry();
  reg.registerAll(BUILTIN_SKILLS);
  // Plugins sit between the built-ins and the person's own skills: what a
  // plugin ships can be overridden by hand, never the other way round.
  reg.registerAll(plugins(cwd).skills);
  // Project skills shadow built-ins of the same name, which is the precedence
  // every other harness uses.
  for (const [dir, source] of [
    [join(homedir(), CONFIG_DIR, "skills"), "user"],
    [join(cwd, CONFIG_DIR, "skills"), "project"],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      try {
        reg.register(parseSkill(readFileSync(file, "utf8"), source));
      } catch (err) {
        process.stderr.write(`skipping ${file}: ${String(err)}\n`);
      }
    }
  }
  return reg;
}

/**
 * Load project hooks, but only from a repository that has been trusted.
 *
 * Reading `.motif/settings.json` and running what it says used to be
 * unconditional, which made cloning a repository and opening it sufficient to
 * execute arbitrary code as the user — with the full environment, tokens
 * included, inherited by the child. The trust decision lives outside the
 * repository, because a file inside the thing being trusted cannot authorise
 * itself, and it is keyed by content hash, because the interesting attack is a
 * project that is benign when you approve it and is not after the next pull.
 */
function loadHooks(cwd: string, opts: { trustFlag?: string | boolean }): HookConfig {
  const file = join(cwd, CONFIG_DIR, "settings.json");
  if (!existsSync(file)) return DEFAULT_HOOKS;

  const content = readFileSync(file, "utf8");
  let parsed: { hooks?: HookConfig };
  try {
    parsed = JSON.parse(content) as { hooks?: HookConfig };
  } catch (err) {
    process.stderr.write(`ignoring ${file}: ${String(err)}\n`);
    return DEFAULT_HOOKS;
  }
  if (!parsed.hooks) return DEFAULT_HOOKS;

  const decision = checkTrust(loadTrustStore(), cwd, content);
  if (decision.trusted) return parsed.hooks;

  // A non-interactive run can pre-authorise an exact hash. That is how a
  // benchmark or CI job opts in without a prompt, and pinning the hash means
  // the authorisation does not survive a change to the file.
  if (typeof opts.trustFlag === "string") {
    const again = checkTrust(
      approveTrust(loadTrustStore(), cwd, content),
      cwd,
      content,
    );
    if (again.trusted && again.record.settingsSha256 === opts.trustFlag) return parsed.hooks;
    process.stderr.write(
      `--trust-project-hooks does not match: this settings.json hashes to ` +
        `${again.trusted ? again.record.settingsSha256 : "?"}\n`,
    );
    return DEFAULT_HOOKS;
  }

  process.stderr.write(
    `project hooks in ${file} are not enabled: ${decision.detail}.\n` +
      `Review the file, then run \`motif trust\` in this directory to approve it.\n`,
  );
  return DEFAULT_HOOKS;
}

/**
 * Subagents: the built-ins, then `~/.motif/agents/*.md`, then the project's
 * `.motif/agents/*.md` — later ones shadow earlier ones of the same name,
 * the precedence skills already use.
 */
function loadAgents(cwd: string): AgentRegistry {
  const reg = new AgentRegistry();
  reg.registerAll(BUILTIN_AGENTS);
  reg.registerAll(plugins(cwd).agents);
  for (const [dir, source] of [
    [join(homedir(), CONFIG_DIR, "agents"), "user"],
    [join(cwd, CONFIG_DIR, "agents"), "project"],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const file = join(dir, name);
      try {
        reg.register(parseAgent(readFileSync(file, "utf8"), source));
      } catch (err) {
        process.stderr.write(`skipping ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  return reg;
}

/**
 * Whether the project's `.motif/settings.json` may be applied.
 *
 * The same decision the hooks make, for the same reason: a cloned repository
 * must not be able to point the harness — and the credential it sends — at
 * an endpoint of its choosing. `--trust-project-hooks <sha256>` pre-approves
 * an exact content hash for non-interactive runs.
 */
function projectTrusted(cwd: string, content: string, trustFlag: string | boolean | undefined): boolean {
  const decision = checkTrust(loadTrustStore(), cwd, content);
  if (decision.trusted) return true;
  if (typeof trustFlag !== "string") return false;
  const again = checkTrust(approveTrust(loadTrustStore(), cwd, content), cwd, content);
  return again.trusted && again.record.settingsSha256 === trustFlag;
}

/** What `/hooks` shows: every configured hook, and where the project's stand. */
function describeHooks(cwd: string, hooks: HookConfig): string[] {
  const lines: string[] = [];
  for (const [event, defs] of Object.entries(hooks)) {
    for (const d of defs ?? []) lines.push(`${event.padEnd(12)} ${d.matcher ? `[${d.matcher}] ` : ""}${d.command}${d.blocking ? "  (blocking)" : ""}`);
  }
  if (lines.length === 0) lines.push("no hooks configured");
  const file = join(cwd, CONFIG_DIR, "settings.json");
  if (existsSync(file)) {
    const content = readFileSync(file, "utf8");
    const trusted = checkTrust(loadTrustStore(), cwd, content).trusted;
    lines.push("", `${file}: ${trusted ? "trusted" : "present but not trusted — its hooks and settings are not applied; run motif trust"}`);
  } else {
    lines.push("", `${file}: absent (the defaults above apply)`);
  }
  return lines;
}

function loadProjectNotes(cwd: string): string | undefined {
  for (const name of ["AGENTS.md", "CLAUDE.md", join(CONFIG_DIR, "NOTES.md")]) {
    const file = join(cwd, name);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return undefined;
}

function toolsHash(names: readonly string[]): string {
  let h = 2166136261;
  for (const ch of names.join(" ")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------------ */

const HELP = `motif ${VERSION} — a coding agent built for Motif-3 (unofficial; not affiliated with Motif Technologies)

  motif                     open the interactive session (a terminal is required)
  motif "<task>"            run one task and exit; add --interactive to stay
  motif -p "<question>"     print only the final reply, for scripts and pipes (also --print)
  motif login               paste an Infron API key; it is checked and saved to ~/.motif/.env
  motif logout              remove the saved key
  motif doctor              check the endpoint, the credentials and what the server produces
  motif sessions            list recorded sessions
  motif resume <file>       resume an interrupted session
  motif skills              list available skills
  motif agents              list available subagents
  motif config              show the effective settings and where each came from
  motif plugins             list the plugins under ~/.motif/plugins and .motif/plugins
  motif lint                lint the tool schemas
  motif trust               approve this repository's .motif/settings.json hooks
  motif distil <dir>        export graded trajectories
  motif metrics <dir>       per-run metrics, one JSON object per line
  motif redact <file>       print a journal with recognised secrets masked
  motif corpus-spec         emit the system prompt and tool schemas, with hashes
  motif corpus-render       render a corpus JSONL to prompt text, as the harness would

Flags
  --endpoint <url>          model server (default ${DEFAULT_ENDPOINT}; a trailing /v1 is accepted)
  --model <name>            model id to request (default ${DEFAULT_MODEL})
  --env-file <path>         read MOTIF_* settings from this file first
  --channel <id>            toolcall | object | raw (default toolcall)
  --channel-policy <p>      fixed | adaptive (default fixed)
  --max-turns <n>           turn ceiling (default 100)
  --max-output-tokens <n>   cap on each model step
  --seed <n>                sampling seed, passed to the server
  --cwd <path>              working directory
  --journal <path>          write the session record here instead of .motif/sessions
  --interactive             open the prompt after the task, or with no task at all
  --continue                open the prompt with the most recent conversation here loaded
  --thinking                show the model's reasoning in the transcript
  --verbose                 show tool output in full (ctrl-o toggles it in the session)
  --theme <name>            colour theme (motif, claude, mono, solarized, dracula)
  --permissions <mode>      ask (default) before commands, writes and patches run, or auto
  --no-hero                 skip the splash

distil flags
  --format <f>              trajectory-jsonl | profile-jsonl (default trajectory-jsonl)
  --filter <f>              grader-passed | grader-failed | all (default grader-passed)
  --include-children        also export subagent scopes

Connection
  The first session asks for an Infron API key, checks it against the endpoint
  and saves it to ~/.motif/.env; 'motif login' does the same outside a session.
  MOTIF_API_KEY, MOTIF_ENDPOINT and MOTIF_MODEL are read from the environment,
  then from ./.env, then from ~/.motif/.env — MOTIF_* keys only, and never into
  the environment. The key is sent as a bearer token and is withheld from every
  command the agent runs.

The .motif directory
  ~/.motif/settings.json    your defaults: model, channel, budgets, theme, thinking, compactAt
  ~/.motif/skills, agents   your skills (SKILL.md) and subagents (*.md)
  <repo>/.motif/            the project's settings.json (hooks too; trusted with 'motif trust'),
                            skills/, agents/, plugins/, NOTES.md, sessions/*.jsonl, history.jsonl
  plugins/<name>/           plugin.json + skills/<s>/SKILL.md + agents/<a>.md, under either .motif

At the prompt
  @path attaches a file or directory to the message (a picker opens as you type);
  @skill:name attaches a skill's instructions; /skill runs one; !cmd runs a shell
  command and shows the model its output; #note appends to .motif/NOTES.md.

A trajectory carries structured messages for training; a profile document
carries one rendered text per line for the routing profiler. They are different
contracts on purpose — presenting one as the other is how a profiling corpus
ends up measuring the wrong distribution.

The object and raw channels drive /v1/completions with a locally rendered
prompt. Neither has been measured against Motif-3, so both need
--experimental-channel to run. "fixed" never changes channel mid-session, which
is what any comparable measurement requires; "adaptive" moves to a simpler
channel after repeated parse failures, and that move restarts the conversation
because the transcript formats are not interchangeable.
`;

/** The hosted endpoint refuses unauthenticated requests; a local server may not need a key at all. */
function keyRequired(endpoint: string): boolean {
  return endpoint === DEFAULT_ENDPOINT;
}

/**
 * `motif login`, and the fallback for a one-shot task without a key: ask at
 * the terminal, check with the endpoint, save. Returns the key, or null when
 * none was entered or it was refused — with the reason already printed.
 */
async function loginAtTerminal(endpoint: string, model: string): Promise<string | null> {
  const path = defaultEnvPath();
  if (process.stdin.isTTY) {
    process.stdout.write(
      `Paste your Infron API key. Get one at ${KEY_PAGE} — Motif-3 is free there through September 2026.\n` +
        `It is checked against ${endpoint}, then saved to ${path} (readable only by you).\n`,
    );
  }
  const raw = await readSecret("key › ");
  const key = raw === null ? "" : normaliseKeyInput(raw);
  if (key === "") {
    process.stderr.write("no key entered\n");
    return null;
  }
  const result = await verifyApiKey({ endpoint, model, apiKey: key });
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    return null;
  }
  saveApiKey(key, path);
  process.stdout.write(`signed in · the key is saved to ${path}\n`);
  return key;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = flagStr(args.flags, "cwd", process.cwd());
  const envFile = flagStr(args.flags, "env-file", "");
  // The settings files sit below the environment and the flags: a one-off
  // override belongs on the command line, a lasting choice in the file.
  const stored = loadSettings({
    cwd,
    projectTrusted: (content) => projectTrusted(cwd, content, args.flags["trust-project-hooks"]),
    warn: (m) => process.stderr.write(`${m}\n`),
  });
  const connection = resolveEndpointConfig({
    flags: {
      ...(typeof args.flags["endpoint"] === "string" ? { endpoint: args.flags["endpoint"] } : {}),
      ...(typeof args.flags["model"] === "string" ? { model: args.flags["model"] } : {}),
    },
    dotenvPaths: [...(envFile ? [envFile] : []), ...defaultDotenvPaths()],
    defaults: {
      ...(stored.values.endpoint !== undefined ? { endpoint: stored.values.endpoint } : {}),
      ...(stored.values.model !== undefined ? { model: stored.values.model } : {}),
    },
  });
  const themeName = flagStr(args.flags, "theme", stored.values.theme ?? "motif");
  if (!applyTheme(themeName)) {
    process.stderr.write(`no theme named ${themeName}; using motif (themes: ${themeNames().join(", ")})\n`);
  }
  const showThinking = args.flags["thinking"] === true || stored.values.thinking === true;
  const compactAt = stored.values.compactAt ?? 0.75;
  const permissions = flagEnum(args.flags, "permissions", ["ask", "auto"] as const, stored.values.permissions ?? "ask");
  const { endpoint, model, apiKey } = connection;
  // Read once, then gone: every command the agent runs inherits this process's
  // environment, and a credential in it is one `env` away from a tool result.
  withholdSecrets(process.env);
  let resumeFrom: ResumeState | undefined;

  switch (args.command) {
    case "help":
      process.stdout.write(HELP);
      return 0;

    case "version":
      process.stdout.write(`${VERSION}\n`);
      return 0;

    case "corpus-spec": {
      // The exact bytes a profiling corpus has to be rendered against.
      //
      // A calibration corpus is only about *this* harness if it carries the
      // system prompt, the tools block and the role markers this harness
      // actually sends. Reading them out of the harness rather than
      // transcribing them is the difference between a corpus that is provably
      // current and one that was right when somebody last copied it — and the
      // hashes let the profiler refuse a stale one.
      const chan: ChannelId = flagEnum(args.flags, "channel", CHANNELS, "toolcall");
      const tools = mcpConnectedDefault ? [...CORE_TOOLS] : toolPrefix(CORE_TOOLS.length - 1);
      const skillsForSpec = loadSkills(cwd);
      const agentsForSpec = new AgentRegistry();
      agentsForSpec.registerAll(BUILTIN_AGENTS);
      const system = buildSystemPrompt({
        channel: chan,
        tools,
        skills: skillsForSpec,
        agents: agentsForSpec,
        cwd,
      });
      process.stdout.write(
        JSON.stringify(
          {
            schemaVersion: "motifcode.corpus-spec/v1",
            harnessVersion: VERSION,
            channel: chan,
            system,
            tools,
            systemPromptSha256: systemPromptHash(system),
            toolSchemaSha256: toolSchemaHash(tools),
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    case "corpus-render": {
      // Render a corpus with the harness's own renderer, not with Jinja.
      //
      // The profiler needs to tokenise exactly what this harness puts on the
      // wire. Two renderers that agree today can drift tomorrow, and a profile
      // taken through the second one describes a prompt nobody sends. So the
      // corpus is rendered once, here, by the same `renderPrompt` the loop
      // uses, and the profiler consumes the text rather than re-deriving it.
      const specPath = flagStr(args.flags, "spec", "");
      const corpusPath = args.rest[0];
      if (!specPath || !corpusPath) {
        process.stderr.write("corpus-render needs --spec <spec.json> and a corpus JSONL path\n");
        return 2;
      }
      const spec = JSON.parse(readFileSync(specPath, "utf8")) as {
        tools: Tool[];
        systemPromptSha256: string;
        toolSchemaSha256: string;
      };
      let rendered = 0;
      for (const line of readFileSync(corpusPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as { messages: Message[]; tools_sha256?: string };
        if (record.tools_sha256 && record.tools_sha256 !== spec.toolSchemaSha256) {
          process.stderr.write(
            `record was built against tool schemas ${record.tools_sha256.slice(0, 12)}, ` +
              `spec is ${spec.toolSchemaSha256.slice(0, 12)}\n`,
          );
          return 1;
        }
        const text = renderPrompt({
          messages: record.messages,
          tools: spec.tools,
          addGenerationPrompt: false,
        });
        process.stdout.write(
          JSON.stringify({ ...record, text, rendered_by: `motifcode/${VERSION}` }) + "\n",
        );
        rendered++;
      }
      process.stderr.write(`rendered ${rendered} record(s)\n`);
      return 0;
    }

    case "redact": {
      const file = args.rest[0];
      if (!file) {
        process.stderr.write("redact needs a journal file — see `motif sessions`\n");
        return 2;
      }
      const { text, hits } = redactJournal(readFileSync(file, "utf8"));
      process.stdout.write(text);
      // Pattern-based redaction is never complete, and saying which rules fired
      // is the only way a reader can tell the difference between "clean" and
      // "the rules did not recognise it".
      process.stderr.write(
        hits.length > 0
          ? `masked: ${hits.join(", ")}. Pattern matching is not exhaustive; check before sharing.\n`
          : "no recognised secrets. Pattern matching is not exhaustive; check before sharing.\n",
      );
      return 0;
    }

    case "login": {
      const key = await loginAtTerminal(endpoint, model);
      return key === null ? 1 : 0;
    }

    case "logout": {
      const path = defaultEnvPath();
      process.stdout.write(forgetApiKey(path) ? `the key was removed from ${path}\n` : `no key in ${path}\n`);
      return 0;
    }

    case "trust": {
      const file = join(cwd, CONFIG_DIR, "settings.json");
      if (!existsSync(file)) {
        process.stderr.write(`${file} does not exist; there is nothing to approve\n`);
        return 2;
      }
      const content = readFileSync(file, "utf8");
      const store = approveTrust(loadTrustStore(), cwd, content);
      saveTrustStore(store);
      const record = store.records[store.records.length - 1]!;
      process.stdout.write(
        `approved project hooks for ${record.path}\n` +
          `settings sha256 ${record.settingsSha256}\n` +
          `Changing that file revokes this approval.\n`,
      );
      return 0;
    }

    case "lint": {
      const findings = lintTools(CORE_TOOLS);
      process.stdout.write(formatFindings(findings) + "\n");
      return findings.length > 0 ? 1 : 0;
    }

    case "skills": {
      const reg = loadSkills(cwd);
      for (const s of reg.list()) {
        process.stdout.write(`${s.name.padEnd(16)} ${s.description}  (${s.source})\n`);
      }
      return 0;
    }

    case "agents": {
      for (const a of loadAgents(cwd).list()) {
        const tools = CORE_TOOL_NAMES.slice(0, a.toolCount).join(" ");
        process.stdout.write(`${a.name.padEnd(12)} ${a.description}  (${a.source ?? "builtin"})\n${"".padEnd(12)} tools: ${tools}\n`);
      }
      return 0;
    }

    case "plugins": {
      for (const line of describePlugins(plugins(cwd))) process.stdout.write(`${line}\n`);
      return 0;
    }

    case "config": {
      const rows: [string, string, string][] = [
        ["model", model, connection.sources.model],
        ["endpoint", endpoint, connection.sources.endpoint],
        ["channel", stored.values.channel ?? "toolcall", stored.sources.channel ?? "default"],
        ["maxTurns", String(stored.values.maxTurns ?? 100), stored.sources.maxTurns ?? "default"],
        ["maxOutputTokens", stored.values.maxOutputTokens === undefined ? "off" : String(stored.values.maxOutputTokens), stored.sources.maxOutputTokens ?? "default"],
        ["seed", stored.values.seed === undefined ? "off" : String(stored.values.seed), stored.sources.seed ?? "default"],
        ["theme", themeName, typeof args.flags["theme"] === "string" ? "flag" : (stored.sources.theme ?? "default")],
        ["thinking", showThinking ? "shown" : "hidden", args.flags["thinking"] === true ? "flag" : (stored.sources.thinking ?? "default")],
        ["compactAt", String(compactAt), stored.sources.compactAt ?? "default"],
        ["permissions", permissions, typeof args.flags["permissions"] === "string" ? "flag" : (stored.sources.permissions ?? "default")],
      ];
      for (const [k, v, from] of rows) process.stdout.write(`${k.padEnd(16)} ${v.padEnd(40)} ${from}\n`);
      process.stdout.write(`\nuser file     ${stored.userPath}${existsSync(stored.userPath) ? "" : " (absent)"}\n`);
      const projectState = !existsSync(stored.projectPath) ? " (absent)" : stored.projectApplied ? " (applied)" : " (present, not trusted — run `motif trust`)";
      process.stdout.write(`project file  ${stored.projectPath}${projectState}\n`);
      return 0;
    }

    case "doctor": {
      const checks = await doctor({
        endpoint,
        model,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(connection.sources.apiKey !== undefined ? { apiKeySource: connection.sources.apiKey } : {}),
      });
      process.stdout.write(formatChecks(checks) + "\n");
      return worstState(checks) === "fail" ? 1 : 0;
    }

    case "sessions": {
      const dir = join(cwd, CONFIG_DIR, "sessions");
      const sessions = listSessions(dir);
      if (sessions.length === 0) {
        process.stdout.write(`no sessions in ${dir}\n`);
        return 0;
      }
      for (const s of sessions) {
        // The grade is shown next to the outcome, and only when there is one.
        // `done` is the agent's claim about itself; a grade is a verdict from
        // outside, and conflating them is how a self-report becomes a score.
        const grade = s.grade ? ` grade=${s.grade.status}` : "";
        const partial = s.truncatedTail ? " (truncated)" : "";
        process.stdout.write(
          `${s.header.startedAt}  ${s.outcome.padEnd(12)}${grade} ${s.rootEvents} root events` +
            `${s.childEvents > 0 ? ` +${s.childEvents} child` : ""}${partial}  ${s.path}\n`,
        );
      }
      return 0;
    }

    case "distil": {
      const dir = args.rest[0] ?? join(cwd, CONFIG_DIR, "sessions");
      const format = flagEnum(args.flags, "format", DISTIL_FORMATS, "trajectory-jsonl");
      const filter = flagEnum(args.flags, "filter", DISTIL_FILTERS, "grader-passed");
      const includeChildren = args.flags["include-children"] === true;

      let exported = 0;
      let scanned = 0;
      let ungraded = 0;
      for (const s of listSessions(dir)) {
        scanned++;
        const parsed = parseJournal(readFile(s.path, "utf8"));
        if (s.grade === undefined) ungraded++;
        for (const line of distil(parsed, { format, filter, includeChildren })) {
          process.stdout.write(line + "\n");
          exported++;
        }
      }
      // Export is gated on a grader's verdict, not on the model saying `done`.
      // A session that never ran its tests, or hid a failure, would otherwise
      // become training data and profiling corpus on its own say-so.
      process.stderr.write(
        `${exported} document(s) from ${scanned} session(s) as ${format}, filter ${filter}` +
          (ungraded > 0 && filter === "grader-passed"
            ? `; ${ungraded} session(s) were never graded and are excluded`
            : "") +
          "\n",
      );
      return 0;
    }

    case "metrics": {
      const dir = args.rest[0] ?? join(cwd, CONFIG_DIR, "sessions");
      for (const s of listSessions(dir)) {
        const parsed = parseJournal(readFile(s.path, "utf8"));
        for (const t of toTrajectories(parsed)) {
          process.stdout.write(
            JSON.stringify({
              runId: t.runId,
              scopeId: t.scopeId,
              endReason: t.agentResult.endReason,
              grade: t.grade.status,
              metrics: t.metrics,
            }) + "\n",
          );
        }
      }
      return 0;
    }

    case "resume": {
      const file = args.rest[0];
      if (!file) {
        process.stderr.write("resume needs a session file — see `motif sessions`\n");
        return 2;
      }
      resumeFrom = loadResume(file);
      break;
    }

    default:
      break;
  }

  const channel: ChannelId = flagEnum(args.flags, "channel", CHANNELS, stored.values.channel ?? "toolcall");
  const channelPolicy = flagEnum(args.flags, "channel-policy", CHANNEL_POLICIES, "fixed");
  const maxTurns = flagInt(args.flags, "max-turns", stored.values.maxTurns ?? 100, 1);
  const maxOutputTokens =
    args.flags["max-output-tokens"] !== undefined
      ? flagInt(args.flags, "max-output-tokens", 0, 1)
      : stored.values.maxOutputTokens;
  const seed = args.flags["seed"] !== undefined ? flagInt(args.flags, "seed", 0, 0) : stored.values.seed;

  // The two body-parsing channels are implemented end to end but have never
  // been run against Motif-3. Saying so with a flag is more honest than a
  // README note nobody reads at the point of use. A channel chosen in a
  // settings file was chosen on purpose, and is not asked again.
  const channelFromFlag = typeof args.flags["channel"] === "string";
  if (channel !== "toolcall" && channelFromFlag && args.flags["experimental-channel"] !== true) {
    throw new UsageError(
      `the ${channel} channel has never been measured against Motif-3; pass --experimental-channel to try it`,
    );
  }
  if (channelPolicy === "adaptive" && args.flags["experimental-channel"] !== true) {
    throw new UsageError(
      "adaptive channel policy restarts the conversation on a downgrade and has never been measured; " +
        "pass --experimental-channel to try it",
    );
  }

  const skills = loadSkills(cwd);
  const agents = loadAgents(cwd);
  const hooks = loadHooks(cwd, { trustFlag: args.flags["trust-project-hooks"] });
  const projectNotes = loadProjectNotes(cwd);

  const systemFor = (ch: ChannelId): string =>
    buildSystemPrompt({
      channel: ch,
      tools: activeTools,
      skills,
      agents,
      ...(projectNotes !== undefined ? { projectNotes } : {}),
      cwd,
    });

  // No MCP adapter is wired up yet, so the tool is not advertised. Offering a
  // tool that always answers "no MCP servers are connected" spends prefix
  // tokens on every request to teach the model about a capability it does not
  // have. `mcp` is last in the canonical order, so leaving it out is exactly a
  // prefix and costs no cache.
  const mcpConnected = mcpConnectedDefault;
  const activeTools = mcpConnected ? [...CORE_TOOLS] : toolPrefix(CORE_TOOLS.length - 1);
  const activeToolNames = CORE_TOOL_NAMES.slice(0, activeTools.length);
  const schemaHash = toolSchemaHash(activeTools);
  const promptHash = systemPromptHash(systemFor(channel));

  // Resume, or start. A resume keeps the recorded task: continuing someone
  // else's transcript with a different task is a new run wearing the old one's
  // history.
  let task: string;
  if (resumeFrom) {
    const blocker = checkResumable(resumeFrom, {
      systemHash: promptHash,
      toolSchemaHash: schemaHash,
      model,
    });
    if (blocker) {
      process.stderr.write(`cannot resume: ${blocker}\n`);
      return 2;
    }
    task = resumeFrom.task ?? "";
    process.stdout.write(
      `resuming ${resumeFrom.header.runId} from turn ${resumeFrom.checkpoint!.turn}` +
        `${resumeFrom.truncatedTail ? " (last record was truncated)" : ""}\n`,
    );
  } else {
    task = args.rest.join(" ").trim();
  }

  // No task and a terminal on both ends means a conversation, not a usage
  // error. Without a terminal the old answer stands: a pipe cannot host a
  // prompt, and printing help is the honest response to an empty command.
  const wantsChat = args.flags["interactive"] === true || args.flags["chat"] === true || args.flags["continue"] === true;
  const printOnly = args.flags["print"] === true || args.flags["p"] === true;
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (wantsChat && !tty) {
    throw new UsageError("--interactive needs a terminal on stdin and stdout");
  }
  if ((wantsChat || !task) && tty && !resumeFrom) {
    const chat = new Chat({
      screen: new Screen({ showThinking, verbose: args.flags["verbose"] === true, cwd }),
      stdin: process.stdin,
      settings: {
        model,
        endpoint,
        channel,
        maxTurns,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(seed !== undefined ? { seed } : {}),
        cwd,
        theme: applyTheme(themeName) ? themeName : "motif",
        compactAt,
        permissions,
      },
      settingsInfo: stored,
      persist: (key, value) => saveUserSetting(key, value as never),
      historyPath: join(cwd, CONFIG_DIR, "history.jsonl"),
      pluginLines: describePlugins(plugins(cwd)),
      hookLines: describeHooks(cwd, hooks),
      notesPath: join(cwd, CONFIG_DIR, "NOTES.md"),
      ...(args.flags["continue"] === true
        ? { continueFrom: listSessions(join(cwd, CONFIG_DIR, "sessions"))[0]?.path ?? "" }
        : {}),
      channelPolicy,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(connection.sources.apiKey !== undefined ? { apiKeySource: connection.sources.apiKey } : {}),
      requireKey: keyRequired(endpoint),
      envPath: defaultEnvPath(),
      offerInstall: ranFromNpx(process.argv[1]) && !commandOnPath("motif"),
      skills,
      agents,
      hooks,
      ...(projectNotes !== undefined ? { projectNotes } : {}),
      tools: activeTools,
      journalDir: join(cwd, CONFIG_DIR, "sessions"),
      version: VERSION,
      hero: args.flags["no-hero"] !== true,
      ...(task ? { initialTask: task } : {}),
    });
    return chat.run();
  }

  if (!task) {
    process.stdout.write(HELP);
    return 2;
  }

  // A one-shot task or a print against the hosted endpoint needs the key as
  // much as the session does. With a terminal it is asked for here; in a
  // pipe there is nobody to ask, and saying so beats a 401 later.
  let sessionKey = apiKey;
  if (sessionKey === undefined && keyRequired(endpoint)) {
    if (!tty) {
      process.stderr.write(`no API key: run 'motif login', or put MOTIF_API_KEY in ${defaultEnvPath()}\n`);
      return 2;
    }
    const key = await loginAtTerminal(endpoint, model);
    if (key === null) return 2;
    sessionKey = key;
  }

  if (printOnly) {
    // The conversational contract without the conversation: a reply ends
    // the task and is written to stdout, nothing else is. For pipes.
    const transport = new HttpTransport({ endpoint, model, ...(sessionKey !== undefined ? { apiKey: sessionKey } : {}) });
    const executor = new ToolExecutor({
      cwd,
      hooks,
      skills,
      policy: policyForAgent({ root: cwd, tools: activeToolNames, readOnly: false }),
    });
    try {
      const result = await runLoop({
        transport,
        tools: activeTools,
        system: (ch) => buildSystemPrompt({ mode: "chat", channel: ch, tools: activeTools, skills, agents, ...(projectNotes !== undefined ? { projectNotes } : {}), cwd }),
        userTask: task,
        executor,
        emit: (e) => {
          if (e.type === "notice" && e.level === "error") process.stderr.write(`${e.text}\n`);
        },
        scopeId: "root",
        repo: { cwd },
        channel,
        channelPolicy,
        maxTurns,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(seed !== undefined ? { seed } : {}),
        replyEnds: true,
        confirmDone: false,
      });
      if (result.summary) process.stdout.write(result.summary.replace(/\s+$/, "") + "\n");
      if (result.reason !== "done") process.stderr.write(`ended: ${result.reason}\n`);
      return result.reason === "done" ? 0 : 1;
    } finally {
      executor.close();
    }
  }

  const transport = new HttpTransport({ endpoint, model, ...(sessionKey !== undefined ? { apiKey: sessionKey } : {}) });
  const screen = new Screen({ showThinking, verbose: args.flags["verbose"] === true, cwd });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  // `--journal` so a benchmark runner knows where the record went without
  // scraping a directory for the newest file. Two rows finishing in the same
  // second would otherwise be indistinguishable, and the one that lost would
  // be scored against the other's transcript.
  const journalPath = flagStr(args.flags, "journal", "")
    || join(cwd, CONFIG_DIR, "sessions", `${runId}.jsonl`);
  const journal = new Journal(
    journalPath,
    newHeader({
      runId,
      cwd,
      model,
      endpoint,
      systemHash: promptHash,
      toolSchemaHash: schemaHash,
      harnessVersion: VERSION,
      config: {
        initialChannel: channel,
        channelPolicy,
        temperature: SAMPLING_DEFAULTS.temperature,
        topP: SAMPLING_DEFAULTS.top_p,
        ...(seed !== undefined ? { seed } : {}),
        maxTurns,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        maxRepairs: 2,
      },
    }),
  );

  const rootScope: ScopeIdentity = { scopeId: "root", scopeKind: "root" };
  journal.record(rootScope, {
    t: "scope_start",
    task,
    initialMessages: [{ role: "user", content: task }],
  });
  if (resumeFrom?.checkpoint) {
    journal.record(rootScope, {
      t: "resume",
      fromSeq: resumeFrom.checkpoint.afterSeq,
      previousRunId: resumeFrom.header.runId,
    });
  }

  if (args.flags["no-hero"] !== true) {
    screen.splash({ model, endpoint, channel, maxTokens: 262_144 });
  }
  // Attach the key handler before the loop starts, so the shortcut the status
  // line offers exists for the whole session.
  screen.attachInput();

  const rootSink = journal.sinkFor(rootScope);
  const emit = (e: LoopEvent) => {
    if (e.type !== "stream") rootSink(e);
    screen.apply(e);
  };

  const scheduler = new AgentScheduler(concurrencyFor(endpoint), (entry) =>
    emit({ type: "queue", agent: entry.agent, state: entry.state === "failed" ? "done" : entry.state }),
  );

  const executor = new ToolExecutor({
    cwd,
    hooks,
    skills,
    policy: policyForAgent({ root: cwd, tools: activeToolNames, readOnly: false }),
    onHook: (event, label, ok) => emit({ type: "hook", event, label, ok }),
    runAgent: async (name, prompt) => {
      const def = agents.get(name);
      if (!def) {
        // No generation at all for an unknown name: spawning a loop to
        // discover the agent does not exist costs a model round-trip and
        // produces a summary the parent would have to distrust anyway.
        return {
          ok: false,
          reason: "unknown_agent",
          runId: "-",
          summary: `no such subagent: ${name}. Available: ${agents.list().map((a) => a.name).join(", ")}`,
        };
      }
      const childScope: ScopeIdentity = {
        scopeId: nextRunId(`sub-${def.name}`),
        scopeKind: "subagent",
        parentScopeId: rootScope.scopeId,
        agentName: def.name,
      };
      return scheduler.submit(name, prompt, async () => {
        // Its own executor, and its own `close()`. A child that throws or is
        // aborted still leaves a persistent shell behind unless the cleanup is
        // in `finally`.
        // The child's policy comes from its declaration, not from its prompt.
        const childExecutor = new ToolExecutor({
          cwd,
          skills,
          policy: policyForAgent({
            root: cwd,
            tools: CORE_TOOL_NAMES.slice(0, def.toolCount),
            readOnly: def.readOnly === true,
          }),
        });
        journal.record(childScope, {
          t: "scope_start",
          task: prompt,
          initialMessages: [{ role: "user", content: prompt }],
        });
        try {
          const sub = await runLoop({
            transport,
            tools: def.tools,
            // The system prompt carries the role. The delegated task is a user
            // turn, exactly as the parent's own task is — a child that only
            // receives its role instructions has been told who it is and never
            // told what to do.
            system: (ch) =>
              buildAgentPrompt({
                name: def.name,
                instructions: def.instructions,
                tools: def.tools,
                channel: ch,
                cwd,
              }),
            userTask: prompt,
            executor: childExecutor,
            // Subagent events are journalled under their own scope but not
            // painted: the parent's screen shows the queue, not the child's
            // transcript. Under one scope they would also have been able to
            // label the parent's run.
            emit: journal.sinkFor(childScope),
            onCheckpoint: journal.checkpointFor(childScope),
            scopeId: childScope.scopeId,
            repo: { cwd },
            channel,
            channelPolicy,
            maxTurns: def.maxTurns ?? 25,
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(seed !== undefined ? { seed } : {}),
          });
          journal.record(childScope, {
            t: "scope_end",
            result: {
              endReason: sub.reason,
              ...(sub.summary !== undefined ? { summary: sub.summary } : {}),
              turns: sub.turns,
            },
          });
          return {
            ok: sub.reason === "done",
            reason: sub.reason,
            runId: childScope.scopeId,
            ...(sub.summary !== undefined ? { summary: sub.summary } : {}),
          };
        } finally {
          childExecutor.close();
        }
      });
    },
  });

  try {
    const result = await runLoop({
      transport,
      tools: activeTools,
      system: systemFor,
      userTask: task,
      executor,
      emit,
      onCheckpoint: journal.checkpointFor(rootScope),
      lifecycle: async (event, context) => {
        const outcomes = await runHooks(hooks, {
          event,
          cwd,
          payload: { scopeId: context.scopeId, turn: context.turn, channel: context.channel, detail: context.detail ?? null },
        });
        for (const h of outcomes) emit({ type: "hook", event, label: h.label, ok: h.ok });
      },
      scopeId: rootScope.scopeId,
      repo: { cwd },
      channel,
      channelPolicy,
      maxTurns,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(resumeFrom?.checkpoint ? { resume: resumeFrom.checkpoint } : {}),
      // Streaming shows the reply as it arrives; a pipe gets the same events
      // and the screen ignores them there.
      stream: Boolean(process.stdout.isTTY),
    });
    journal.record(rootScope, {
      t: "scope_end",
      result: {
        endReason: result.reason,
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        turns: result.turns,
      },
    });
    // Exit 0 means the agent finished its own loop cleanly. It is not a claim
    // that the work is correct — that requires a grader, and `motif distil`
    // reads the grade rather than this exit code.
    return result.reason === "done" ? 0 : 1;
  } finally {
    executor.close();
    screen.finish();
  }
}

// Before anything opens a socket. Node's default HTTP idle timeouts are set for
// endpoints that answer in seconds; a large model served locally answers a
// single step in minutes, and the transport's own 30-minute deadline is the one
// that should decide. See `relaxNodeHttpTimeouts` for what that cost when it
// was left in place.
//
// Awaited rather than fired and forgotten: it has to make Node load its bundled
// undici before it can reach the dispatcher, so the swap lands a microtask late
// and the first request would otherwise race it.
relaxNodeHttpTimeouts()
  .then(() => main())
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Bad usage gets one line and exit 2; anything else is a real failure and
    // keeps its message. Neither prints a stack — a stack trace tells a user
    // nothing about a mistyped flag.
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
