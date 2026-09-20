/**
 * Slash commands.
 *
 * What the interactive session can do besides send a task: look at its own
 * settings, change them, and reach the housekeeping subcommands — doctor,
 * sessions, resume — without leaving the conversation. The set follows what
 * Claude Code and Codex both converged on (`/help`, `/status`, `/model`,
 * `/clear`, `/resume`, `/doctor`, `/quit`), plus the knobs that are specific
 * to this harness: the action channel, the turn and token budgets, the seed.
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
}

export interface CommandContext {
  settings: ChatSettings;
  /** Current settings and session totals, one line each. */
  status(): string[];
  doctor(): Promise<string[]>;
  skills(): string[];
  agents(): string[];
  sessions(): string[];
  /** Load a journal's transcript into this conversation. */
  resume(file: string): Promise<string[]>;
  /** Forget the transcript and start again; the reason is shown. */
  newConversation(reason: string): void;
  /** Change the working directory; returns what happened. */
  setCwd(path: string): string[];
  /** Fold or unfold reasoning cells; returns the new state. */
  toggleThinking(): boolean;
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
  ["tab", "complete the selected command; on an empty prompt, fold or unfold reasoning"],
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

export const COMMANDS: readonly SlashCommand[] = [
  {
    name: "help",
    description: "commands and keys",
    run: () => {
      const width = Math.max(...COMMANDS.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ""}`.length));
      const lines = COMMANDS.map(
        (c) => `${`/${c.name}${c.usage ? ` ${c.usage}` : ""}`.padEnd(width)}  ${c.description}`,
      );
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
      return ok("/model", [`model set to ${args} for the next task`]);
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
      return ok("/endpoint", [`endpoint set to ${ctx.settings.endpoint} for the next task`]);
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
      return ok("/max-turns", [`turn ceiling set to ${n}`]);
    },
  },
  {
    name: "max-tokens",
    description: "show or set the output cap per model step",
    usage: "[n|off]",
    run: (ctx, args) => {
      if (args === "") return ok("/max-tokens", [ctx.settings.maxOutputTokens === undefined ? "off (server default)" : String(ctx.settings.maxOutputTokens)]);
      if (args === "off") {
        delete ctx.settings.maxOutputTokens;
        return ok("/max-tokens", ["output cap removed; the server's default applies"]);
      }
      const n = parseIntArg(args, "max-tokens", 1);
      if (typeof n === "string") return fail("/max-tokens", n);
      ctx.settings.maxOutputTokens = n;
      return ok("/max-tokens", [`output cap set to ${n} tokens per step`]);
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
        return ok("/seed", ["seed removed"]);
      }
      const n = parseIntArg(args, "seed", 0);
      if (typeof n === "string") return fail("/seed", n);
      ctx.settings.seed = n;
      return ok("/seed", [`seed set to ${n}`]);
    },
  },
  {
    name: "thinking",
    description: "fold or unfold the model's reasoning",
    run: (ctx) => ok("/thinking", [ctx.toggleThinking() ? "reasoning expanded" : "reasoning folded"]),
  },
  {
    name: "cwd",
    description: "show or change the working directory",
    usage: "[path]",
    run: (ctx, args) => (args === "" ? ok("/cwd", [ctx.settings.cwd]) : ok("/cwd", ctx.setCwd(args))),
  },
  {
    name: "skills",
    description: "list the skills the model can load",
    run: (ctx) => ok("/skills", ctx.skills()),
  },
  {
    name: "agents",
    description: "list the subagents the model can delegate to",
    run: (ctx) => ok("/agents", ctx.agents()),
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
    description: "continue the conversation from a recorded session",
    usage: "<file>",
    run: async (ctx, args) => {
      if (args === "") return fail("/resume", "resume needs a journal file — see /sessions");
      return ok("/resume", await ctx.resume(args));
    },
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

const ALIASES: Record<string, string> = { exit: "quit", clear: "new", q: "quit" };

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
