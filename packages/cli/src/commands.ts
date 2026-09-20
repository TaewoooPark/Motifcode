/**
 * Slash commands.
 *
 * What the interactive session can do besides send a task: look at its own
 * settings, change them, and reach the housekeeping subcommands — doctor,
 * sessions, resume — without leaving the conversation. The set follows what
 * Claude Code and Codex both converged on (`/help`, `/status`, `/config`,
 * `/model`, `/clear`, `/compact`, `/resume`, `/doctor`, `/quit`), plus the
 * knobs that are specific to this harness: the action channel, the turn and
 * token budgets, the seed, the theme.
 *
 * A setting changed here is remembered: the context persists it to the
 * person's settings file and says so. Skills are commands too — `/commit`
 * runs the `commit` skill — but they come from the registry, so the chat
 * controller resolves them after this table has said no.
 *
 * Every command is a pure function of its arguments and a `CommandContext`,
 * which is the whole of what a command may touch. Nothing here knows about
 * the screen, the loop or the terminal, so the table is testable against a
 * fake context and the chat controller is the only place the real one is
 * built.
 */

import type { ChannelId } from "@motifcode/protocol";

export const CHANNEL_IDS: readonly ChannelId[] = ["toolcall", "object", "raw"];

/** The settings a session can change between tasks. */
export interface ChatSettings {
  model: string;
  endpoint: string;
  channel: ChannelId;
  maxTurns: number;
  maxOutputTokens?: number;
  seed?: number;
  cwd: string;
  theme: string;
  /** Fraction of the context window at which the transcript is compacted. */
  compactAt: number;
  /** Ask before a tool that changes the world runs, or run everything. */
  permissions: "ask" | "auto";
}

/** Settings a command may write to the person's file. */
export type PersistableKey = "model" | "endpoint" | "channel" | "maxTurns" | "maxOutputTokens" | "seed" | "theme" | "thinking" | "compactAt" | "permissions";

export interface CommandContext {
  settings: ChatSettings;
  /** Current settings and session totals, one line each. */
  status(): string[];
  /** Effective settings with where each came from, and the files involved. */
  config(): string[];
  doctor(): Promise<string[]>;
  skills(): string[];
  agents(): string[];
  plugins(): string[];
  sessions(): string[];
  /** Available themes, one line each. */
  themes(): string[];
  /** Switch palettes; returns what happened. */
  setTheme(name: string): string[];
  /** Load a journal's transcript into this conversation. */
  resume(file: string): Promise<string[]>;
  /** Replace the transcript with the model's summary of it, concentrating on `focus` when given. */
  compact(focus?: string): Promise<string[]>;
  /** The project notes every task reads. */
  notes(): string[];
  /** Configured hooks and whether the project's are trusted. */
  hooks(): string[];
  /** Forget the transcript and start again; the reason is shown. */
  newConversation(reason: string): void;
  /** Change the working directory; returns what happened. */
  setCwd(path: string): string[];
  /** Show or hide reasoning cells; returns the new state. */
  toggleThinking(): boolean;
  /** Remember a setting across sessions; the file it went to, or null when not persisted. */
  persist(key: PersistableKey, value: unknown): string | null;
  quit(): void;
}

export interface CommandOutput {
  /** Rule label for the output cell. */
  title: string;
  lines: string[];
  /** True when the command failed and the output is an error. */
  error?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** Argument hint for the menu and for `/help`. */
  usage?: string;
  run(ctx: CommandContext, args: string): Promise<CommandOutput> | CommandOutput;
}

const KEYS: readonly [string, string][] = [
  ["enter", "send the task; with a slash menu open, run the selected command"],
  ["\\ then enter", "insert a newline instead of sending"],
  ["esc", "interrupt the running task, or clear the draft"],
  ["ctrl-c", "interrupt; twice on an empty prompt to quit (ctrl-d too)"],
  ["tab", "complete the selected command; on an empty prompt, show or hide reasoning"],
  ["?", "on an empty prompt, show or hide the key list"],
  ["shift-tab", "toggle permissions: ask before tools run, or run everything"],
  ["y / a / n", "when asked about a tool call: allow once, allow that tool for the session, decline"],
  ["ctrl-o", "show tool output in full, or clipped again"],
  ["ctrl-l", "redraw the screen"],
  ["@path", "attach a file or directory to the message; @skill:name attaches a skill's instructions"],
  ["!command", "run a shell command here and put its output in the conversation"],
  ["#note", "append a line to .motif/NOTES.md, which every session reads"],
  ["up / down", "browse earlier tasks, or move within a multi-line draft"],
  ["ctrl-a / ctrl-e", "start / end of the line;  ctrl-u / ctrl-k delete to either end;  ctrl-w delete a word"],
];

function ok(title: string, lines: string[]): CommandOutput {
  return { title, lines };
}

function fail(title: string, line: string): CommandOutput {
  return { title, lines: [line], error: true };
}

function parseIntArg(args: string, name: string, min: number): number | string {
  const n = Number(args);
  if (!Number.isInteger(n) || n < min) return `${name} must be an integer >= ${min}; got ${args}`;
  return n;
}

/** The sentence added when a change was written to disk. */
function saved(ctx: CommandContext, key: PersistableKey, value: unknown): string[] {
  const path = ctx.persist(key, value);
  return path ? [`saved to ${path}`] : [];
}

export const COMMANDS: readonly SlashCommand[] = [
  {
    name: "help",
    description: "commands and keys",
    run: () => {
      const width = Math.max(...COMMANDS.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ""}`.length));
      const lines = COMMANDS.map(
        (c) => `${`/${c.name}${c.usage ? ` ${c.usage}` : ""}`.padEnd(width)}  ${c.description}`,
      );
      lines.push("", "Skills are commands too: /<skill> [input] runs one — /skills lists them.");
      const keyWidth = Math.max(...KEYS.map(([k]) => k.length));
      lines.push("", "keys");
      for (const [k, what] of KEYS) lines.push(`${k.padEnd(keyWidth)}  ${what}`);
      return ok("/help", lines);
    },
  },
  {
    name: "status",
    description: "connection, settings and session totals",
    run: (ctx) => ok("/status", ctx.status()),
  },
  {
    name: "config",
    description: "effective settings, where each came from, and the files",
    run: (ctx) => ok("/config", ctx.config()),
  },
  {
    name: "doctor",
    description: "probe the endpoint: auth, parsers, cache, channels",
    run: async (ctx) => ok("/doctor", await ctx.doctor()),
  },
  {
    name: "model",
    description: "show or set the model id for the next task",
    usage: "[id]",
    run: (ctx, args) => {
      if (args === "") return ok("/model", [ctx.settings.model]);
      ctx.settings.model = args;
      return ok("/model", [`model set to ${args} for the next task`, ...saved(ctx, "model", args)]);
    },
  },
  {
    name: "endpoint",
    description: "show or set the endpoint URL",
    usage: "[url]",
    run: (ctx, args) => {
      if (args === "") return ok("/endpoint", [ctx.settings.endpoint]);
      if (!/^https?:\/\//.test(args)) return fail("/endpoint", `not a URL: ${args}`);
      ctx.settings.endpoint = args.replace(/\/+$/, "").replace(/\/v1$/, "");
      return ok("/endpoint", [
        `endpoint set to ${ctx.settings.endpoint} for the next task`,
        ...saved(ctx, "endpoint", ctx.settings.endpoint),
      ]);
    },
  },
  {
    name: "channel",
    description: "show or set the action channel; changing it restarts the conversation",
    usage: "[toolcall|object|raw]",
    run: (ctx, args) => {
      if (args === "") return ok("/channel", [ctx.settings.channel]);
      if (!CHANNEL_IDS.includes(args as ChannelId)) {
        return fail("/channel", `channel must be one of ${CHANNEL_IDS.join(", ")}; got ${args}`);
      }
      const to = args as ChannelId;
      if (to === ctx.settings.channel) return ok("/channel", [`already on ${to}`]);
      ctx.settings.channel = to;
      // The transcript so far is written in the old channel's format, and the
      // formats are not interchangeable — the same reason the loop restarts
      // the conversation on a downgrade rather than re-dressing history.
      ctx.newConversation(`channel changed to ${to}`);
      const lines = [`channel set to ${to}; the conversation was restarted, since transcript formats differ`];
      if (to !== "toolcall") {
        lines.push(
          `${to} is experimental: never measured against Motif-3, and it needs /v1/completions,`,
          "which the hosted endpoint does not have — the first request may fail",
        );
      }
      lines.push(...saved(ctx, "channel", to));
      return ok("/channel", lines);
    },
  },
  {
    name: "max-turns",
    description: "show or set the turn ceiling per task",
    usage: "[n]",
    run: (ctx, args) => {
      if (args === "") return ok("/max-turns", [String(ctx.settings.maxTurns)]);
      const n = parseIntArg(args, "max-turns", 1);
      if (typeof n === "string") return fail("/max-turns", n);
      ctx.settings.maxTurns = n;
      return ok("/max-turns", [`turn ceiling set to ${n}`, ...saved(ctx, "maxTurns", n)]);
    },
  },
  {
    name: "max-tokens",
    description: "show or set the output cap per model step",
    usage: "[n|off]",
    run: (ctx, args) => {
      if (args === "") {
        return ok("/max-tokens", [ctx.settings.maxOutputTokens === undefined ? "off (server default)" : String(ctx.settings.maxOutputTokens)]);
      }
      if (args === "off") {
        delete ctx.settings.maxOutputTokens;
        return ok("/max-tokens", ["output cap removed; the server's default applies", ...saved(ctx, "maxOutputTokens", undefined)]);
      }
      const n = parseIntArg(args, "max-tokens", 1);
      if (typeof n === "string") return fail("/max-tokens", n);
      ctx.settings.maxOutputTokens = n;
      return ok("/max-tokens", [`output cap set to ${n} tokens per step`, ...saved(ctx, "maxOutputTokens", n)]);
    },
  },
  {
    name: "seed",
    description: "show or set the sampling seed",
    usage: "[n|off]",
    run: (ctx, args) => {
      if (args === "") return ok("/seed", [ctx.settings.seed === undefined ? "off" : String(ctx.settings.seed)]);
      if (args === "off") {
        delete ctx.settings.seed;
        return ok("/seed", ["seed removed", ...saved(ctx, "seed", undefined)]);
      }
      const n = parseIntArg(args, "seed", 0);
      if (typeof n === "string") return fail("/seed", n);
      ctx.settings.seed = n;
      return ok("/seed", [`seed set to ${n}`, ...saved(ctx, "seed", n)]);
    },
  },
  {
    name: "theme",
    description: "show, list or set the colour theme",
    usage: "[name]",
    run: (ctx, args) => {
      if (args === "") return ok("/theme", [`current: ${ctx.settings.theme}`, "", ...ctx.themes()]);
      const lines = ctx.setTheme(args);
      if (ctx.settings.theme !== args) return fail("/theme", lines.join(" "));
      return ok("/theme", [...lines, ...saved(ctx, "theme", args)]);
    },
  },
  {
    name: "thinking",
    description: "show or hide the model's reasoning",
    run: (ctx) => {
      const shown = ctx.toggleThinking();
      return ok("/thinking", [shown ? "reasoning shown" : "reasoning hidden", ...saved(ctx, "thinking", shown)]);
    },
  },
  {
    name: "compact",
    description: "replace the transcript with the model's summary of it; words after it say what to keep",
    usage: "[focus]",
    run: async (ctx, args) => ok("/compact", await ctx.compact(args)),
  },
  {
    name: "notes",
    description: "show the project notes every task reads (# at the prompt adds one)",
    run: (ctx) => ok("/notes", ctx.notes()),
  },
  {
    name: "hooks",
    description: "show the hooks that run around tools, and whether the project's are trusted",
    run: (ctx) => ok("/hooks", ctx.hooks()),
  },
  {
    name: "compact-at",
    description: "show or set the context fraction at which compaction runs",
    usage: "[0.5-1]",
    run: (ctx, args) => {
      if (args === "") return ok("/compact-at", [`${ctx.settings.compactAt} of the context window`]);
      const f = Number(args);
      if (!Number.isFinite(f) || f < 0.1 || f > 1) return fail("/compact-at", `compact-at must be a fraction between 0.1 and 1; got ${args}`);
      ctx.settings.compactAt = f;
      return ok("/compact-at", [`the transcript is compacted at ${f} of the context window`, ...saved(ctx, "compactAt", f)]);
    },
  },
  {
    name: "permissions",
    description: "ask before commands, writes and patches run, or run everything (shift-tab toggles)",
    usage: "[ask|auto]",
    run: (ctx, args) => {
      if (args === "") {
        return ok("/permissions", [
          ctx.settings.permissions === "ask"
            ? "ask: bash, write, apply_patch, term and mcp wait for a yes; y allows once, a allows that tool for the session, n declines"
            : "auto: every tool call runs without asking",
        ]);
      }
      if (args !== "ask" && args !== "auto") return fail("/permissions", `permissions must be ask or auto; got ${args}`);
      ctx.settings.permissions = args;
      return ok("/permissions", [args === "ask" ? "asking before tools that change the world" : "running every tool call without asking", ...saved(ctx, "permissions", args)]);
    },
  },
  {
    name: "cwd",
    description: "show or change the working directory",
    usage: "[path]",
    run: (ctx, args) => (args === "" ? ok("/cwd", [ctx.settings.cwd]) : ok("/cwd", ctx.setCwd(args))),
  },
  {
    name: "skills",
    description: "list the skills; each runs as /<skill> [input]",
    run: (ctx) => ok("/skills", ctx.skills()),
  },
  {
    name: "agents",
    description: "list the subagents the model can delegate to",
    run: (ctx) => ok("/agents", ctx.agents()),
  },
  {
    name: "plugins",
    description: "list the plugins loaded from ~/.motif/plugins and .motif/plugins",
    run: (ctx) => ok("/plugins", ctx.plugins()),
  },
  {
    name: "new",
    description: "start a new conversation; the working tree is untouched",
    run: (ctx) => {
      ctx.newConversation("new conversation");
      return ok("/new", ["conversation restarted; the working tree is as you left it"]);
    },
  },
  {
    name: "sessions",
    description: "list recorded sessions",
    run: (ctx) => ok("/sessions", ctx.sessions()),
  },
  {
    name: "resume",
    description: "continue from a recorded session: a number from the list, or a file",
    usage: "[n|file]",
    run: async (ctx, args) => ok("/resume", await ctx.resume(args)),
  },
  {
    name: "quit",
    description: "leave (also /exit)",
    run: (ctx) => {
      ctx.quit();
      return ok("/quit", ["bye"]);
    },
  },
];

const ALIASES: Record<string, string> = { exit: "quit", clear: "new", q: "quit", cost: "status", memory: "notes" };

export function findCommand(name: string): SlashCommand | undefined {
  const key = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  return COMMANDS.find((c) => c.name === key);
}

/** `/name args` into its parts; null when the text is not a command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1]!, args: (m[2] ?? "").trim() };
}

export async function runSlash(text: string, ctx: CommandContext): Promise<CommandOutput> {
  const parsed = parseSlash(text);
  if (!parsed) return fail("/", "not a command");
  const command = findCommand(parsed.name);
  if (!command) return fail(`/${parsed.name}`, `unknown command /${parsed.name} — /help lists them`);
  try {
    return await command.run(ctx, parsed.args);
  } catch (err) {
    return fail(`/${command.name}`, err instanceof Error ? err.message : String(err));
  }
}
