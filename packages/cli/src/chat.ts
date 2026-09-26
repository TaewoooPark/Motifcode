/**
 * The interactive session.
 *
 * `motif` with no task opens a prompt, and every line sent from it is a task
 * run by the same loop the one-shot command uses — with one difference: the
 * transcript survives between tasks. The first task starts a conversation; the
 * second sees the first and everything the model did about it; `done` hands
 * the prompt back rather than ending the process. Each task still writes its
 * own journal, and each journal's last checkpoint carries the whole
 * conversation so far, which is what `/resume` reads back.
 *
 * The shape follows Claude Code and Codex where they agree: a composer at the
 * bottom that stays editable while the model works, a slash menu that opens
 * on `/`, an interrupt on Esc, a status line under the prompt, and a queued
 * message when something is sent mid-run. Where the terminal and the model
 * differ from theirs — reasoning on every turn, a frozen tool list, a
 * confirmation before `done` — the screen already knew, and this layer only
 * had to keep out of its way.
 *
 * Nothing here talks to the terminal directly. Keys arrive decoded from the
 * screen, and everything painted goes back through it, so the whole
 * controller runs against a fake stream in a test.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgentRegistry, AgentScheduler, concurrencyFor } from "@motifcode/agents";
import {
  HttpTransport,
  buildCompactedHistory,
  defaultEnvPath,
  forgetApiKey,
  resumeBlock,
  runLoop,
  saveApiKey,
  summarizeTranscript,
  type ChannelPolicy,
  type LoopEvent,
  type LoopResult,
  type ToolInvocation,
  type Transport,
} from "@motifcode/core";
import { runHooks, runShell, type HookConfig, type RunResult } from "@motifcode/hooks";
import { Journal, listSessions, loadResume, newHeader, type ScopeIdentity } from "@motifcode/journal";
import { MAX_CONTEXT, SAMPLING_DEFAULTS, systemPromptHash, toolSchemaHash, type ChannelId, type Message, type Tool } from "@motifcode/protocol";
import { substituteSkillArguments, type SkillRegistry } from "@motifcode/skills";
import { CORE_TOOL_NAMES } from "@motifcode/tools";
import {
  Composer,
  Screen,
  THEMES,
  applyTheme,
  clampSelection,
  mentionAt,
  menuItemsFor,
  relativise,
  wrapToWidth,
  type ComposerView,
  type Key,
  type MenuItem,
} from "@motifcode/tui";
import { forgetFiles, listFiles, matchFiles } from "./files.js";
import { expandSkillInput } from "./skill-input.js";
import { installCommand } from "./install.js";
import { loginLines, normaliseKeyInput, verifyApiKey, type VerifyResult } from "./login.js";
import { COMMANDS, findCommand, parseSlash, runSlash, type ChatSettings, type CommandContext, type CommandOutput, type PersistableKey } from "./commands.js";
import { MCP_USAGE, mcpCatalogEntries, mcpFailureHint, mcpListLines, mcpLoginPanelView, mcpPanelKeys, mcpPanelView, mcpStatusLabel, mcpToolCount, parseMcpRequest, type McpAction } from "./mcp-ui.js";
import type { LoadedSettings } from "./settings.js";
import { doctor, formatChecks } from "./doctor.js";
import { ToolExecutor, type ExecutorOptions } from "./executor.js";
import { policyForAgent } from "./policy.js";
import { buildAgentPrompt, buildSystemPrompt } from "./prompt.js";
import { compactMcpContext, MCP_CONTEXT_PREFIX, type McpSession, type McpPreset, type McpStatus, type McpElicitationRequest, type McpElicitationResponse } from "@motifcode/mcp";
import { requestMcpInteraction } from "./mcp-interaction.js";
import { McpAuthError } from "../../mcp/src/auth.js";
import { McpPresetError } from "../../mcp/src/presets.js";
import { McpConfigEditError } from "./mcp-config-edit.js";

export interface ChatOptions {
  screen: Screen;
  stdin: NodeJS.ReadStream;
  settings: ChatSettings;
  channelPolicy: ChannelPolicy;
  apiKey?: string;
  apiKeySource?: string;
  skills: SkillRegistry;
  agents: AgentRegistry;
  hooks: HookConfig;
  projectNotes?: string;
  tools: Tool[];
  mcp?: McpSession;
  mcpPresets?: () => McpPreset[];
  mcpConfigLabel?: string;
  mcpInstall?: (id: string, options: { root?: string; tokenEnv?: string }, signal: AbortSignal) => Promise<McpStatus>;
  mcpLogin?: (server: string, signal: AbortSignal, onProgress?: (message: string) => void) => Promise<void>;
  mcpLogout?: (server: string) => void | Promise<void>;
  openBrowser?: (url: URL) => Promise<void>;
  /** Where each task's journal is written. */
  journalDir: string;
  version: string;
  /** Injected for tests; defaults to `HttpTransport`. */
  makeTransport?: (settings: ChatSettings, apiKey: string | undefined) => Transport;
  hero?: boolean;
  /** A task to send before the first prompt, from the command line. */
  initialTask?: string;
  now?: () => number;
  /** What the settings files said, for `/config`. */
  settingsInfo?: LoadedSettings;
  /** Writes one setting to the person's file; returns its path, or null when not persisted. */
  persist?: (key: PersistableKey, value: unknown) => string | null;
  /** Where the composer's history is kept between sessions. */
  historyPath?: string;
  /** Lines for `/plugins`. */
  pluginLines?: string[];
  /** Lines for `/hooks`. */
  hookLines?: string[];
  /** Where `#` notes go; also what the system prompt reads as project notes. */
  notesPath?: string;
  /** A journal to continue from before the first prompt — `--continue`. */
  continueFrom?: string;
  /**
   * Ask for a key when none is configured — before the first prompt, and
   * again before a task if it was skipped. On for the hosted endpoint, which
   * refuses unauthenticated requests; off for a local server without auth.
   */
  requireKey?: boolean;
  /** Where a key typed at the prompt is saved. Defaults to `~/.motif/.env`. */
  envPath?: string;
  /** Injected for tests; defaults to a one-token completion with the key. */
  verifyKey?: (apiKey: string) => Promise<VerifyResult>;
  /**
   * Offer to install the `motif` command before the first prompt. Set when
   * this run came from `npx` and no `motif` is on the PATH.
   */
  offerInstall?: boolean;
  /** Injected for tests; defaults to running `npm install -g motifcode@<version>`. */
  installGlobal?: (command: string) => Promise<RunResult>;
}

interface ActiveTask {
  task: string;
  journal: Journal;
  transport: Transport;
  abort: AbortController;
  scope: ScopeIdentity;
}

interface Totals {
  tasks: number;
  done: number;
  interrupted: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  lastContext: number;
}

const PLACEHOLDER = "type a task, / for commands";
/** Empty: the screen shows `? for shortcuts` in its place. */
const IDLE_HINT = "";
const RUNNING_HINT = "esc to interrupt";
const CTRL_C_WINDOW_MS = 2000;

/**
 * Commands that rewrite the conversation, refused while a task is running.
 *
 * The running task will hand back its transcript when it ends, and that
 * would silently undo a `/new` or a `/resume` issued in the meantime; a
 * `/channel` would leave the next task reading a transcript in the wrong
 * format. Waiting, or interrupting, is the honest answer.
 */
const BLOCKED_WHILE_RUNNING = new Set(["new", "clear", "channel", "resume", "cwd", "compact"]);

const MENU_ITEMS: MenuItem[] = COMMANDS.map((c) => ({
  name: c.name,
  description: c.description,
  ...(c.usage ? { usage: c.usage } : {}),
}));

/** The most recent entries kept from the history file; older lines are left on disk. */
const HISTORY_LOADED = 200;

let runSequence = 0;
function nextRunId(prefix: string): string {
  runSequence += 1;
  return `${prefix}-${String(runSequence).padStart(3, "0")}`;
}

export class Chat {
  private readonly screen: Screen;
  private readonly composer = new Composer();
  private readonly settings: ChatSettings;
  private menuSelected = 0;
  private menuFilter = "";
  private history: Message[] = [];
  /** Every task sent in this conversation, verbatim, for compaction to keep. */
  private tasks: string[] = [];
  private projectNotes: string | undefined;
  private shellSequence = 0;
  /** A `!command` in flight; tasks sent meanwhile wait behind it. */
  private shellBusy = false;
  /** A tool call waiting for the person's yes or no, and which of the three answers is selected. */
  private pendingConfirm: { call: ToolInvocation; resolve: (v: "allow" | "deny") => void; selected: number; force: boolean } | null = null;
  /** A question with numbered answers in place of the prompt, and which one is selected. */
  private pendingChoice: { title: string; lines: string[]; options: string[]; selected: number; wrap?: boolean; resolve: (v: number | null) => void } | null = null;
  /** A secret being typed in place of the prompt — the API key at login. */
  private pendingSecret: { title: string; lines: string[]; prompt: string; cancelHint: string; allowEmpty: boolean; masked: boolean; resolve: (v: string | null) => void } | null = null;
  /** Connection controls never share a model task's tool-dispatch lifetime. */
  private mcpPanel: { selected: number; notice?: string } | null = null;
  private mcpInteractionBusy = false;
  private mcpLoginNotice: string | null = null;
  private readonly mcpLoginOffered = new Set<string>();
  private mcpBusy: { abort: AbortController; server: string; action: McpAction | "install"; notice?: string } | null = null;
  private mcpRefreshTimer: NodeJS.Timeout | null = null;
  /** The credential for this session. Starts as the caller's; `/login` replaces it, `/logout` drops it. */
  private apiKey: string | undefined;
  private apiKeySource: string | undefined;
  /** Tools the person allowed for the rest of the session with `a`. */
  private readonly alwaysAllowed = new Set<string>();
  /** MCP calls a person approved in the call prompt, consumed by the same call. */
  private readonly humanApprovedMcp = new Set<string>();
  private active: ActiveTask | null = null;
  /** A finished loop can still compact history before starting a queued task. */
  private settlingTask = false;
  /** Messages sent while a task ran, in order; each becomes a task when the prompt is free. */
  private queued: string[] = [];
  private quitting = false;
  private ctrlCArmedAt = 0;
  private lastJournalPath: string | undefined;
  private executor: ToolExecutor;
  private readonly scheduler: AgentScheduler;
  private readonly totals: Totals = {
    tasks: 0,
    done: 0,
    interrupted: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    lastContext: 0,
  };
  private finished: ((code: number) => void) | null = null;
  private idleWaiters: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: ChatOptions) {
    this.screen = opts.screen;
    this.settings = { ...opts.settings };
    this.projectNotes = opts.projectNotes;
    this.apiKey = opts.apiKey;
    this.apiKeySource = opts.apiKeySource;
    this.now = opts.now ?? (() => Date.now());
    this.scheduler = new AgentScheduler(concurrencyFor(this.settings.endpoint), (entry) =>
      this.screen.apply({ type: "queue", agent: entry.agent, state: entry.state === "failed" ? "done" : entry.state }),
    );
    this.executor = this.makeExecutor(this.settings.cwd);
    if (opts.historyPath) this.composer.seedHistory(readHistory(opts.historyPath));
  }

  /** The number of tasks that have finished, however they ended. Tests wait on it. */
  get tasksCompleted(): number {
    return this.totals.tasks;
  }

  get running(): boolean {
    return this.active !== null;
  }

  get transcript(): readonly Message[] {
    return this.history;
  }

  /** Resolves once no task is running and nothing is queued. */
  whenIdle(): Promise<void> {
    if (!this.active && !this.settlingTask && this.queued.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** Open the prompt; resolves with an exit code when the session ends. */
  run(): Promise<number> {
    return new Promise((resolveRun) => {
      this.finished = resolveRun;
      if (this.opts.hero !== false) {
        this.screen.splash({
          model: this.settings.model,
          endpoint: this.settings.endpoint,
          channel: this.settings.channel,
          maxTokens: 262_144,
          version: this.opts.version,
          cwd: this.settings.cwd,
        });
      }
      this.screen.setLabel(this.settings.model);
      this.screen.setTitle(`motif · ${this.settings.cwd.split("/").pop() ?? this.settings.cwd}`);
      if (this.apiKey === undefined && !this.opts.requireKey) {
        this.screen.append({
          kind: "notice",
          level: "warn",
          text: "no API key is configured: /login, or set MOTIF_API_KEY in ~/.motif/.env or ./.env, then /doctor",
        });
      }
      this.screen.attachInput(this.opts.stdin, (key) => this.onKey(key), () => this.stop());
      this.refresh();
      void this.start();
    });
  }

  /** What happens before the first prompt is free: the login, the resumed conversation, the first task. */
  private async start(): Promise<void> {
    if (this.needsLogin) {
      this.screen.append({ kind: "system", title: "login", lines: await this.login("startup") });
      this.refresh();
    }
    if (this.opts.offerInstall) await this.offerInstall();
    if (this.opts.continueFrom) {
      try {
        this.screen.append({ kind: "system", title: "continuing", lines: await this.resume(this.opts.continueFrom) });
      } catch (err) {
        this.screen.append({ kind: "notice", level: "error", text: err instanceof Error ? err.message : String(err) });
        this.refresh();
        return; // Do not silently submit an initial task as a new run after continuation failed.
      }
      this.refresh();
    }
    if (this.opts.initialTask) void this.submit(this.opts.initialTask);
  }

  /* ---------------------------------------------------------------- */
  /* keys                                                              */
  /* ---------------------------------------------------------------- */

  private onKey(key: Key): void {
    if (this.pendingSecret) {
      this.answerSecret(key);
      return;
    }
    if (this.pendingChoice) {
      this.answerChoice(key);
      return;
    }
    if (this.pendingConfirm) {
      this.answerConfirm(key);
      return;
    }
    if (this.mcpPanel || this.mcpBusy) {
      this.answerMcp(key);
      return;
    }
    const menu = this.menuItems();
    switch (key.type) {
      case "shift-tab":
        this.settings.permissions = this.settings.permissions === "ask" ? "auto" : "ask";
        this.opts.persist?.("permissions", this.settings.permissions);
        this.screen.append({
          kind: "notice",
          level: "info",
          text: this.settings.permissions === "ask" ? "permissions: asking before tools that change the world" : "permissions: running every tool call without asking",
        });
        break;
      case "text":
        // `?` on an empty prompt opens the shortcuts panel, as in Claude Code;
        // anywhere else it is a character.
        if (key.text === "?" && this.composer.empty) this.screen.toggleShortcuts();
        else this.composer.insert(key.text);
        break;
      case "paste":
        this.composer.paste(key.text);
        break;
      case "newline":
        this.composer.insert("\n");
        break;
      case "enter":
        if (menu.length > 0 && this.mentionOpen()) {
          this.completeMention(menu[clampSelection(this.menuSelected, menu.length)]!);
        } else if (menu.length > 0) {
          // The menu's selection is the command, whatever fragment was typed.
          const item = menu[clampSelection(this.menuSelected, menu.length)]!;
          this.composer.clear();
          this.composer.insert(`/${item.name}`);
          void this.submit(this.composer.submit());
        } else if (this.composer.text.endsWith("\\") && this.composer.cursor === [...this.composer.text].length) {
          // A trailing backslash asks for a line break, as in Claude Code.
          this.composer.backspace();
          this.composer.insert("\n");
        } else {
          void this.submit(this.composer.submit());
        }
        break;
      case "tab":
        if (menu.length > 0 && this.mentionOpen()) {
          this.completeMention(menu[clampSelection(this.menuSelected, menu.length)]!);
        } else if (menu.length > 0) {
          const item = menu[clampSelection(this.menuSelected, menu.length)]!;
          this.composer.clear();
          this.composer.insert(`/${item.name}${item.usage ? " " : ""}`);
        } else if (this.composer.empty) {
          this.screen.toggleThinking();
        }
        break;
      case "escape":
        // A running task comes first, as the hint says; the draft is kept.
        if (this.active) this.interrupt();
        else if (menu.length > 0 || !this.composer.empty) this.composer.clear();
        break;
      case "up":
        if (menu.length > 0) this.menuSelected = clampSelection(this.menuSelected - 1, menu.length);
        else this.composer.up();
        break;
      case "down":
        if (menu.length > 0) this.menuSelected = clampSelection(this.menuSelected + 1, menu.length);
        else this.composer.down();
        break;
      case "backspace":
        this.composer.backspace();
        break;
      case "delete":
        this.composer.deleteForward();
        break;
      case "left":
        this.composer.left();
        break;
      case "right":
        this.composer.right();
        break;
      case "home":
        this.composer.home();
        break;
      case "end":
        this.composer.end();
        break;
      case "word-left":
        this.composer.wordLeft();
        break;
      case "word-right":
        this.composer.wordRight();
        break;
      case "delete-word":
        this.composer.deleteWordBack();
        break;
      case "ctrl":
        this.onControl(key.key);
        break;
      default:
        break;
    }
    if (key.type !== "ctrl" || key.key !== "c") this.ctrlCArmedAt = 0;
    this.refresh();
  }

  private onControl(letter: string): void {
    switch (letter) {
      case "c":
        if (this.active) {
          this.interrupt();
        } else if (!this.composer.empty) {
          this.composer.clear();
        } else if (this.now() - this.ctrlCArmedAt <= CTRL_C_WINDOW_MS) {
          this.quit();
        } else {
          // Armed. A single Ctrl-C on an empty prompt is too easy to hit by
          // reflex to be an exit; the second one within a moment is a decision.
          this.ctrlCArmedAt = this.now();
        }
        break;
      case "d":
        if (this.composer.empty) this.quit();
        else this.composer.deleteForward();
        break;
      case "u":
        this.composer.killToStart();
        break;
      case "k":
        this.composer.killToEnd();
        break;
      case "o":
        this.screen.toggleVerbose();
        break;
      case "l":
        this.screen.redraw();
        break;
      default:
        break;
    }
  }

  /** Built-in commands, then every skill that does not share a name with one. */
  private allMenuItems(): MenuItem[] {
    const skills = this.opts.skills
      .listFor("user")
      .filter((s) => !findCommand(s.name))
      .map((s) => ({ name: s.name, description: `skill · ${s.description}`, usage: s.argumentHint ?? "[input]" }));
    return [...MENU_ITEMS, ...skills];
  }

  /** True when the cursor sits in an `@` token, which opens the file picker. */
  private mentionOpen(): boolean {
    return mentionAt(this.composer.text, this.composer.cursor) !== null;
  }

  /** Files and skills matching the `@` token under the cursor. */
  private mentionItems(): MenuItem[] {
    const m = mentionAt(this.composer.text, this.composer.cursor);
    if (!m) return [];
    const q = m.query;
    const skills: MenuItem[] = this.opts.skills
      .listFor("user")
      .filter((s) => q === "" || `skill:${s.name}`.includes(q.toLowerCase()) || s.name.startsWith(q.toLowerCase()))
      .map((s) => ({ name: `skill:${s.name}`, description: `skill · ${s.description}` }));
    const files: MenuItem[] = matchFiles(listFiles(this.settings.cwd), q).map((f) => ({
      name: f.path,
      description: f.kind === "dir" ? "directory" : "file",
    }));
    // Files first unless the query says skill; either way, at most a screenful.
    const ordered = q.startsWith("s") && "skill:".startsWith(q.slice(0, 6)) ? [...skills, ...files] : [...files, ...skills];
    return ordered.slice(0, 10);
  }

  /** Replace the `@` token under the cursor with the chosen mention. */
  private completeMention(item: MenuItem): void {
    const m = mentionAt(this.composer.text, this.composer.cursor);
    if (!m) return;
    const chars = [...this.composer.text];
    const before = chars.slice(0, m.start).join("");
    const after = chars.slice(m.end).join("");
    const trailing = item.name.endsWith("/") ? "" : " ";
    const next = `${before}@${item.name}${trailing}`;
    this.composer.clear();
    this.composer.insert(next);
    this.composer.insert(after);
    for (let i = 0; i < [...after].length; i++) this.composer.left();
  }

  /**
   * The person's answer to a pending tool call.
   *
   * Three numbered answers, as in Claude Code's dialog: 1 runs it once, 2
   * runs that tool without asking for the rest of the session, 3 declines.
   * Up and down move between them and Enter takes the selected one; Esc
   * declines; `y` and `n` stand for 1 and 3. Every other key is ignored:
   * the question stays until it is answered, and typing cannot slip past
   * it — a letter meant for the draft must not be able to grant a tool for
   * the whole session, which a bare `a` once could.
   */
  private answerConfirm(key: Key): void {
    const pending = this.pendingConfirm;
    if (!pending) return;
    let choice: number | null = null;
    if (key.type === "enter") choice = pending.selected;
    else if (key.type === "escape") choice = 3;
    else if (key.type === "up") pending.selected = pending.selected === 1 ? 3 : pending.selected - 1;
    else if (key.type === "down") pending.selected = pending.selected === 3 ? 1 : pending.selected + 1;
    else if (key.type === "text") {
      const k = key.text.toLowerCase();
      if (k === "1" || k === "y") choice = 1;
      else if (k === "2") choice = 2;
      else if (k === "3" || k === "n") choice = 3;
    } else if (key.type === "ctrl" && key.key === "c") {
      this.interrupt();
      return;
    }
    if (choice === null) {
      this.refresh();
      return;
    }
    if (choice === 2 && !pending.force) this.alwaysAllowed.add(this.permissionKey(pending.call));
    // A person just approved this exact MCP call: that is the per-call human
    // confirmation a server-gated tool needs, so do not ask a second time.
    if (choice !== 3 && !pending.force && pending.call.name === "mcp") this.humanApprovedMcp.add(mcpApprovalKey(pending.call.arguments.server, pending.call.arguments.method, pending.call.arguments.args));
    this.pendingConfirm = null;
    pending.resolve(choice === 3 ? "deny" : "allow");
    this.refresh();
  }

  /** Put a tool call to the person, unless the mode or an earlier `a` says not to. */
  private permissionKey(call: ToolInvocation): string {
    return call.name === "mcp" ? `mcp:${String(call.arguments.server)}/${String(call.arguments.method)}` : call.name;
  }

  private confirm(call: ToolInvocation, force = false): Promise<"allow" | "deny"> {
    if (!force && (this.settings.permissions === "auto" || this.alwaysAllowed.has(this.permissionKey(call)))) return Promise.resolve("allow");
    return new Promise((resolve) => {
      this.pendingConfirm = { call, resolve, selected: 1, force };
      this.refresh();
    });
  }

  /** The question the panel shows for a call. */
  private confirmView(call: ToolInvocation, selected: number): { title: string; lines: string[]; choices: string[] } {
    const a = call.arguments;
    const text = (k: string): string => relativise(typeof a[k] === "string" ? (a[k] as string) : "", this.settings.cwd);
    const preview = (s: string, max: number): string[] => {
      const lines = s.replace(/\s+$/, "").split("\n");
      return lines.length > max ? [...lines.slice(0, max), `… +${lines.length - max} lines`] : lines;
    };
    let title: string;
    let lines: string[];
    switch (call.name) {
      case "bash":
        title = "Run this command?";
        lines = preview(text("command"), 8);
        break;
      case "write":
        title = `Write ${text("path")}?`;
        lines = preview(text("content"), 6);
        break;
      case "apply_patch":
        title = "Apply this patch?";
        lines = preview(text("patch"), 10);
        break;
      case "term":
        title = "Send this to the terminal?";
        lines = preview(text("keystrokes"), 6);
        break;
      case "mcp":
        title = `Call ${text("server")}/${text("method")}?`;
        lines = preview(JSON.stringify(a.args, null, 2), 10);
        break;
      default:
        title = `Run ${call.name}?`;
        lines = preview(JSON.stringify(a), 4);
    }
    const options = ["1. Yes", this.pendingConfirm?.force
      ? "2. Yes, for this call (the server requires human confirmation)"
      : `2. Yes, and don't ask again for ${this.permissionKey(call)} this session`, "3. No, and tell the model what to do instead"];
    return {
      title,
      lines,
      choices: options.map((o, i) => `${i + 1 === selected ? "❯" : " "} ${o}`),
    };
  }

  /* ---------------------------------------------------------------- */
  /* signing in                                                        */
  /* ---------------------------------------------------------------- */

  private get envPath(): string {
    return this.opts.envPath ?? defaultEnvPath();
  }

  private get needsLogin(): boolean {
    return this.opts.requireKey === true && this.apiKey === undefined;
  }

  /** Take over the prompt for one question; resolves with the index chosen, or null on esc. */
  private askChoice(title: string, lines: string[], options: string[], wrap = false): Promise<number | null> {
    return new Promise((resolve) => {
      this.pendingChoice = { title, lines, options, selected: 0, wrap, resolve };
      this.refresh();
    });
  }

  /** A number, or ↑↓ and Enter, picks an answer; Esc (and Ctrl-C, Ctrl-D) declines. Nothing else does anything. */
  private answerChoice(key: Key): void {
    const pending = this.pendingChoice;
    if (!pending) return;
    const n = pending.options.length;
    let choice: number | null | undefined;
    if (key.type === "enter") choice = pending.selected;
    else if (key.type === "escape" || (key.type === "ctrl" && (key.key === "c" || key.key === "d"))) choice = null;
    else if (key.type === "up") pending.selected = (pending.selected + n - 1) % n;
    else if (key.type === "down") pending.selected = (pending.selected + 1) % n;
    else if (key.type === "text" && /^[1-9]$/.test(key.text) && Number(key.text) <= n) choice = Number(key.text) - 1;
    if (choice !== undefined) {
      this.pendingChoice = null;
      pending.resolve(choice);
    }
    this.refresh();
  }

  /**
   * `npx motifcode` runs the package without leaving a command behind, and
   * the first person to try it typed `motif` afterwards and found nothing.
   * So a run from npx, on a machine without `motif`, is offered the global
   * install once — npm's own, of exactly the version that is running — and
   * the session carries on either way.
   */
  private async offerInstall(): Promise<void> {
    const command = installCommand(this.opts.version);
    const choice = await this.askChoice(
      "Install the motif command?",
      ["This run came from npx, which leaves no command behind.", `${command} puts motif and motifcode on your PATH.`],
      ["1. Yes, install it now", "2. Not now — npx motifcode keeps working"],
    );
    if (choice !== 0) return;
    const id = `install-${++this.shellSequence}`;
    this.screen.append({ kind: "tool", id, name: "bash", args: { command }, repaired: false, hooks: [] });
    this.refresh();
    const r = await (this.opts.installGlobal ?? ((c: string) => runShell(c, { cwd: this.settings.cwd, timeoutMs: 180_000, outputCap: 20_000 })))(command);
    const ok = r.code === 0 && !r.timedOut;
    const output = r.timedOut ? `${r.output.trim()}\n(killed after ${Math.round(r.ms / 1000)}s)`.trim() : r.output.trim() || `(exit ${r.code})`;
    this.screen.apply({ type: "tool_end", id, ok, output, ms: r.ms });
    this.screen.append(
      ok
        ? { kind: "notice", level: "info", text: "installed: from now on `motif` (or `motifcode`) opens this from any folder; this session carries on" }
        : { kind: "notice", level: "warn", text: `the install did not finish; run \`${command}\` yourself (with sudo if npm's global folder is not yours), or keep using npx motifcode` },
    );
    this.refresh();
  }

  /** Take over the prompt for one secret; resolves with the text, or null when given up. */
  private askSecret(title: string, lines: string[], prompt: string, cancelHint: string, allowEmpty = false, masked = true): Promise<string | null> {
    return new Promise((resolve) => {
      this.composer.clear();
      this.pendingSecret = { title, lines, prompt, cancelHint, allowEmpty, masked, resolve };
      this.refresh();
    });
  }

  /**
   * Keys while a secret is being typed. Editing keys edit; Enter sends what
   * is there; Esc, Ctrl-C and Ctrl-D give up. Nothing else does anything —
   * no menu, no history, no shortcuts panel — and the text never reaches the
   * composer's history or the history file, because it is never submitted.
   */
  private answerSecret(key: Key): void {
    const pending = this.pendingSecret;
    if (!pending) return;
    const finish = (value: string | null): void => {
      this.pendingSecret = null;
      this.composer.clear();
      pending.resolve(value);
    };
    switch (key.type) {
      case "text":
        this.composer.insert(key.text);
        break;
      case "paste":
        // A key never contains a line break; the newline a copy carries would
        // otherwise be sent as part of it.
        this.composer.insert(key.text.replace(/[\r\n]+/g, ""));
        break;
      case "enter":
        if (pending.allowEmpty || this.composer.text.trim() !== "") finish(this.composer.text);
        break;
      case "escape":
        finish(null);
        break;
      case "backspace":
        this.composer.backspace();
        break;
      case "delete":
        this.composer.deleteForward();
        break;
      case "left":
        this.composer.left();
        break;
      case "right":
        this.composer.right();
        break;
      case "home":
        this.composer.home();
        break;
      case "end":
        this.composer.end();
        break;
      case "word-left":
        this.composer.wordLeft();
        break;
      case "word-right":
        this.composer.wordRight();
        break;
      case "delete-word":
        this.composer.deleteWordBack();
        break;
      case "ctrl":
        if (key.key === "c" || key.key === "d") finish(null);
        else if (key.key === "u") this.composer.killToStart();
        else if (key.key === "k") this.composer.killToEnd();
        else if (key.key === "l") this.screen.redraw();
        break;
      default:
        break;
    }
    this.refresh();
  }

  /**
   * Ask for the key, check it, keep it.
   *
   * Before the first prompt when none was found, before a task if that was
   * skipped, and on `/login`. A rejected key is asked for again with the
   * endpoint's reason. Giving up leaves the session without a key: the next
   * task asks once more, which is a better place to find out than a refusal
   * to open at all.
   */
  private async login(reason: "startup" | "task" | "command"): Promise<string[]> {
    const title =
      reason === "command" ? "Paste your Infron API key" : reason === "task" ? "An API key is needed before the task can run" : "Paste your Infron API key to get started";
    const cancelHint = reason === "command" ? "enter to check and save · esc to cancel" : "enter to check and save · esc to skip for now";
    for (;;) {
      const raw = await this.askSecret(title, loginLines(this.envPath), "key › ", cancelHint);
      if (raw === null) {
        return reason === "command"
          ? ["login cancelled"]
          : [`no key entered; /login when you have one, or put MOTIF_API_KEY in ${this.envPath}`];
      }
      const key = normaliseKeyInput(raw);
      if (key === "") continue;
      this.screen.setActivity("Checking the key…");
      let result: VerifyResult;
      try {
        result = await (this.opts.verifyKey ?? ((k: string) => verifyApiKey({ endpoint: this.settings.endpoint, model: this.settings.model, apiKey: k })))(key);
      } finally {
        this.screen.setActivity(null);
      }
      if (!result.ok) {
        this.screen.append({ kind: "notice", level: "error", text: `${result.reason} — try again, or press esc` });
        continue;
      }
      this.apiKey = key;
      try {
        const path = saveApiKey(key, this.envPath);
        this.apiKeySource = `${path} (MOTIF_API_KEY)`;
      } catch (err) {
        this.apiKeySource = "this session only";
        return [`the key works, but ${this.envPath} could not be written: ${err instanceof Error ? err.message : String(err)}`, "it is kept for this session only"];
      }
      return [`signed in · the key is saved to ${this.envPath}`];
    }
  }

  private logout(): string[] {
    const source = this.apiKeySource;
    const had = this.apiKey !== undefined;
    const removed = forgetApiKey(this.envPath);
    this.apiKey = undefined;
    this.apiKeySource = undefined;
    if (!had && !removed) return ["no key is set"];
    const lines = removed ? [`the key was removed from ${this.envPath}`] : [`this session's key came from ${source ?? "the caller"}, which was left as it is`];
    lines.push("the session no longer sends a key; the next task asks for one, or /login now");
    return lines;
  }

  private menuItems(): MenuItem[] {
    const items = this.mentionOpen() ? this.mentionItems() : menuItemsFor(this.composer.text, this.allMenuItems());
    // A new filter starts at the top; a longer or shorter one keeps whatever
    // was selected when it still exists.
    const filter = `${this.composer.text}#${this.mentionOpen() ? this.composer.cursor : ""}`;
    if (filter !== this.menuFilter) {
      this.menuFilter = filter;
      this.menuSelected = 0;
    }
    return items;
  }

  private async askMcpChoice(signal: AbortSignal, title: string, lines: string[], options: string[]): Promise<number | null> {
    if (signal.aborted || this.quitting) return null;
    const answer = this.askChoice(title, lines, options, true);
    const pending = this.pendingChoice;
    const cancel = () => { if (pending && this.pendingChoice === pending) { this.pendingChoice = null; pending.resolve(null); this.refresh(); } };
    signal.addEventListener("abort", cancel, { once: true });
    try { return await answer; } finally { signal.removeEventListener("abort", cancel); }
  }

  /** MCP dispatch for one result scope, with the person's per-call decisions. */
  private mcpInvoker(scopeId: string): ExecutorOptions["callMcp"] {
    const session = this.opts.mcp;
    if (!session) return undefined;
    return async (server, method, args, signal, observe) => {
      const approval = mcpApprovalKey(server, method, args);
      try {
        return await session.invoke(server, method, args, {
          scopeId, signal, observe,
          confirmInteraction: (server, method, args) => this.humanApprovedMcp.delete(approval) ? Promise.resolve(true)
            : this.confirm({ id: "mcp-interaction", name: "mcp", arguments: { server, method, args }, validated: true, repaired: false }, true).then((answer) => answer === "allow"),
          confirmRepeat: (server, method) => this.confirmMcpRepeat(server, method, signal),
        });
      } finally { this.humanApprovedMcp.delete(approval); }
    };
  }

  /** A person, not the model, decides whether an uncertain call runs again. */
  private async confirmMcpRepeat(server: string, method: string, signal?: AbortSignal): Promise<boolean> {
    const choice = await this.askMcpChoice(signal ?? new AbortController().signal, `Run ${server}/${method} again?`, [
      "An identical earlier call may or may not have run; its outcome is unknown.",
      "Check the service first. Repeating a write can apply it twice.",
    ], ["1. Run it again", "2. Don't run it"]);
    return choice === 0;
  }

  /** SDK callback: the human, not the model, supplies remote form/URL consent. */
  async handleMcpElicitation(request: McpElicitationRequest): Promise<McpElicitationResponse> {
    if (this.mcpInteractionBusy || this.pendingChoice || this.pendingSecret || this.pendingConfirm || this.quitting) return { action: "decline" };
    this.mcpInteractionBusy = true;
    try {
      return await requestMcpInteraction(request, {
        choose: (title, lines, choices) => this.askMcpChoice(request.signal, title, lines, choices),
        input: async (title, lines, prompt, masked = true) => {
          if (request.signal.aborted) return null;
          const answer = this.askSecret(title, lines, prompt, "enter submit · esc cancel", true, masked);
          const pending = this.pendingSecret;
          const cancel = () => { if (pending && this.pendingSecret === pending) { this.pendingSecret = null; this.composer.clear(); pending.resolve(null); this.refresh(); } };
          request.signal.addEventListener("abort", cancel, { once: true });
          try { return await answer; } finally { request.signal.removeEventListener("abort", cancel); }
        },
        openBrowser: this.opts.openBrowser,
      });
    } finally { this.mcpInteractionBusy = false; }
  }

  private async loginMcp(server: string, signal: AbortSignal): Promise<void> {
    if (!this.opts.mcpLogin) throw new McpAuthError("unsupported", "MCP login is unavailable in this session.");
    try {
      await this.opts.mcpLogin(server, signal, message => {
        // Device codes belong only to this temporary human interface: never
        // append them to the conversation, task context or journal.
        if (this.mcpBusy) this.mcpBusy.notice = message;
        else this.mcpLoginNotice = message;
        if (!this.quitting) this.refresh();
      });
    } finally {
      if (this.mcpBusy) delete this.mcpBusy.notice;
      this.mcpLoginNotice = null;
      if (!this.quitting) this.refresh();
    }
  }

  private async prepareMcp(task: string, signal: AbortSignal): Promise<string | undefined> {
    const session = this.opts.mcp;
    if (!session) return undefined;
    // Starting a server can take seconds (npx downloads, slow endpoints); say so.
    const connecting = session.statuses().some((s) => s.enabled && !["ready", "paused", "disabled"].includes(s.state));
    if (connecting) this.screen.setActivity("Connecting to MCP…");
    let context: string;
    try { context = await session.prepare(task, signal); }
    finally { if (connecting) this.screen.setActivity(null); }
    if (!this.opts.mcpLogin || signal.aborted) return context;
    let changed = false;
    for (const status of session.statuses()) {
      if (status.error?.code !== "authentication_required" || this.mcpLoginOffered.has(status.server) || signal.aborted) continue;
      this.mcpLoginOffered.add(status.server);
      const answer = await this.askMcpChoice(signal, "Connect your MCP account", [`${status.server} needs browser authorization before its tools can be used.`], ["1. Sign in", "2. Continue without this connection"]);
      if (answer !== 0 || signal.aborted) continue;
      try { await this.loginMcp(status.server, signal); await session.reconnect(status.server, signal); changed = true; }
      catch { this.screen.append({ kind: "notice", level: "warn", text: `${status.server}: authorization did not complete. Use /mcp login ${status.server} to try again.` }); }
    }
    if (changed && !signal.aborted) context = await session.prepare(task, signal);
    return context;
  }

  private async mcpCommand(args: string): Promise<CommandOutput> {
    const request = parseMcpRequest(args);
    if (!request) return { title: "/mcp", lines: [MCP_USAGE], error: true };
    const servers = this.opts.mcp?.statuses() ?? [];
    const taskPending = this.active || this.settlingTask || this.queued.length > 0;
    if (request.action === "list" || (request.action === "panel" && taskPending)) {
      return { title: "/mcp", lines: [...mcpListLines(servers, this.opts.mcpPresets?.()), ...(taskPending ? ["Wait for the task to finish before changing connections."] : [])] };
    }
    if (request.action === "panel") {
      this.mcpPanel = { selected: 0 };
      this.refresh();
      return { title: "/mcp", lines: [] };
    }
    if (request.action === "install") return this.installMcp(request.server);
    return this.changeMcp(request.action, request.server);
  }

  /** Human-only setup: browsing the catalog never saves config or starts a server. */
  private async installMcp(id: string, login = false): Promise<CommandOutput> {
    const output = (line: string, error = false): CommandOutput => ({ title: "/mcp", lines: [line], ...(error ? { error } : {}) });
    if (this.active || this.settlingTask || this.queued.length > 0 || this.shellBusy) return output("Wait for the running task and its queued work to finish before changing connections.", true);
    if (this.mcpBusy) return output("An MCP connection change is already in progress.", true);
    const preset = this.opts.mcpPresets?.().find(entry => entry.id === id);
    if (!preset || !this.opts.mcpInstall) return output("Preset setup is unavailable. Use motif mcp install PRESET, then restart this session.", true);
    const before = this.opts.mcp?.statuses().find(entry => entry.server === id);
    if (before?.enabled) return output(`${id} is already registered. Use /mcp connect ${id}.`);
    // Gmail's developer preview needs external enrollment and a token reference.
    // Do not solicit a bearer token or pretend generic browser OAuth can supply it.
    if (!before && id === "gmail") return output("Gmail preview requires Google enrollment and an OAuth token environment variable. Use motif mcp install gmail --token-env GOOGLE_ACCESS_TOKEN --enable after setup, then restart.", true);
    const abort = new AbortController();
    this.mcpBusy = { abort, action: "install", server: id };
    this.refresh();
    try {
      const options: { root?: string; tokenEnv?: string } = {};
      if (!before && preset.options.includes("root")) {
        const choice = await this.askMcpChoice(abort.signal, "Choose filesystem access", ["This server can read and write inside the selected directory.", `Current project: ${this.settings.cwd}`], ["1. Use current project directory", "2. Enter another directory", "3. Cancel"]);
        if (choice === null || choice === 2) return output("MCP setup cancelled; no configuration changed.");
        let typed = this.settings.cwd;
        if (choice !== 0) {
          const answer = this.askSecret("Filesystem directory", ["Enter an existing directory. You will review it before connecting."], "path › ", "enter review · esc cancel", false, false);
          const pending = this.pendingSecret;
          const cancel = () => { if (pending && this.pendingSecret === pending) { this.pendingSecret = null; this.composer.clear(); pending.resolve(null); this.refresh(); } };
          abort.signal.addEventListener("abort", cancel, { once: true });
          let root: string | null;
          try { root = await answer; } finally { abort.signal.removeEventListener("abort", cancel); }
          if (root === null || abort.signal.aborted) return output("MCP setup cancelled; no configuration changed.");
          typed = root.trim();
        }
        // Review the directory that will actually be granted: ~ expanded,
        // relative to the project, symlinks resolved.
        const expanded = typed === "~" ? homedir() : typed.startsWith("~/") ? join(homedir(), typed.slice(2)) : typed;
        try {
          options.root = realpathSync(resolve(this.settings.cwd, expanded));
          if (!statSync(options.root).isDirectory()) throw new Error("not a directory");
        } catch { return output(`${typed} is not an existing directory; no configuration changed.`, true); }
      }
      const choice = await this.askMcpChoice(abort.signal, before ? `Enable ${preset.title}?` : `Set up ${preset.title}?`, [
        ...(before ? ["Enable the existing server configuration and connect now."] : [preset.description, ...preset.prerequisites, preset.authentication]),
        `Save to: ${this.opts.mcpConfigLabel ?? "the selected MCP configuration"}`,
        ...(options.root ? [`Read/write root: ${options.root}`] : []),
      ], [before ? "1. Enable and connect" : "1. Install and connect", "2. Cancel"]);
      if (choice !== 0 || abort.signal.aborted) return output("MCP setup cancelled; no configuration changed.");
      let after = await this.opts.mcpInstall(id, options, abort.signal);
      if (this.opts.mcpLogin && this.opts.mcp && !abort.signal.aborted && (login || after.error?.code === "authentication_required")) {
        const consent = login ? 0 : await this.askMcpChoice(abort.signal, "MCP login required", [`${id} needs account authorization. The saved connection will remain available next session.`], ["1. Sign in", "2. Not now"]);
        if (consent === 0 && !abort.signal.aborted) {
          await this.loginMcp(id, abort.signal);
          after = await this.opts.mcp.reconnect(id, abort.signal);
        }
      }
      return output(`${id}: registered · ${mcpStatusLabel(after)} · ${mcpToolCount(after)}${after.state === "error" ? `. ${mcpFailureHint(after)}` : ". Available in this and future sessions."}`, after.state === "error");
    } catch (cause) {
      if (cause instanceof McpPresetError || cause instanceof McpConfigEditError || cause instanceof McpAuthError) return output(cause.message, true);
      return output(abort.signal.aborted ? "MCP setup stopped. Check /mcp list for any saved connection." : "MCP setup did not complete. Check /mcp list and motif mcp doctor; saved connections can be retried.", true);
    } finally {
      this.mcpBusy = null;
      if (!this.quitting) this.refresh();
    }
  }

  private async changeMcp(action: McpAction, server: string): Promise<CommandOutput> {
    const fail = (line: string): CommandOutput => ({ title: "/mcp", lines: [line], error: true });
    if (this.active || this.settlingTask || this.queued.length > 0 || this.shellBusy) return fail("Wait for the running task and its queued work to finish before changing connections.");
    if (this.mcpBusy) return fail("An MCP connection change is already in progress.");
    const session = this.opts.mcp;
    const before = session?.statuses().find((s) => s.server === server);
    const preset = this.opts.mcpPresets?.().find(entry => entry.id === server);
    if ((!before || !before.enabled) && preset && ["connect", "reconnect", "login"].includes(action)) return this.installMcp(server, action === "login");
    if (!session || !before) return fail("Unknown MCP server. /mcp list shows configured names and available presets.");
    if (!before.enabled) return fail(mcpFailureHint(before));
    const abort = new AbortController();
    this.mcpBusy = { abort, action, server };
    this.refresh();
    try {
      if (action === "logout") {
        if (!this.opts.mcpLogout) return fail("MCP logout is unavailable in this session.");
        await this.opts.mcpLogout(server);
        this.mcpLoginOffered.delete(server);
        await session.disconnect(server);
        return { title: "/mcp", lines: [`${server}: signed out locally and disconnected. Provider account grants are unchanged.`] };
      }
      if (action === "login") {
        if (!this.opts.mcpLogin) return fail("MCP login is unavailable in this session.");
        await this.loginMcp(server, abort.signal);
      }
      let after;
      try { after = await session[action === "login" ? "reconnect" : action](server, abort.signal); }
      catch (cause) { after = session.statuses().find(row => row.server === server); if (after?.state !== "error") throw cause; }
      if (after.error?.code === "authentication_required" && action !== "login" && action !== "disconnect" && this.opts.mcpLogin) {
        const answer = await this.askMcpChoice(abort.signal, "MCP login required", [`${server} requires authorization in your browser.`], ["1. Sign in", "2. Not now"]);
        if (answer === 0 && !abort.signal.aborted) { await this.loginMcp(server, abort.signal); after = await session.reconnect(server, abort.signal); }
      }
      if (after.state === "error") return fail(mcpFailureHint(after));
      return { title: "/mcp", lines: [`${server}: ${mcpStatusLabel(after)} · ${mcpToolCount(after)}`] };
    } catch (cause) {
      // Connection failures can contain credentials or stderr. Only fixed
      // guidance and the manager's public state are allowed onto the screen.
      if (cause instanceof McpAuthError) return fail(cause.message);
      return fail(abort.signal.aborted
        ? action === "login" ? "MCP login cancelled." : `Stopped waiting. The connection may still finish; /mcp disconnect ${server} stops it.`
        : mcpFailureHint(session.statuses().find((s) => s.server === server)));
    } finally {
      this.mcpBusy = null;
      if (!this.quitting) this.refresh();
    }
  }

  private answerMcp(key: Key): void {
    const close = key.type === "escape" || (key.type === "ctrl" && (key.key === "c" || key.key === "d"));
    if (this.mcpBusy) {
      if (close && this.mcpBusy.action !== "disconnect") this.mcpBusy.abort.abort();
      return;
    }
    const panel = this.mcpPanel;
    if (!panel) return;
    const servers = mcpCatalogEntries(this.opts.mcp?.statuses() ?? [], this.opts.mcpPresets?.());
    if (close || (!servers.length && key.type === "enter")) this.mcpPanel = null;
    else if (key.type === "up" || key.type === "down") {
      const direction = key.type === "up" ? -1 : 1;
      panel.selected = Math.max(0, Math.min(servers.length - 1, panel.selected + direction));
      delete panel.notice;
    } else {
      const server = servers[panel.selected];
      const shortcut = key.type === "text" ? key.text.toLowerCase() : "";
      const action = key.type === "enter" ? (server?.status?.state === "ready" || server?.status?.state === "connecting" ? "disconnect" : "connect")
        : shortcut === "r" ? "reconnect" : shortcut === "c" ? "connect" : shortcut === "d" ? "disconnect" : shortcut === "l" ? "login" : undefined;
      if (action && server) {
        void this.changeMcp(action, server.server).then((out) => {
          if (this.mcpPanel === panel) {
            panel.notice = out.lines.join(" ");
            panel.selected = Math.max(0, mcpCatalogEntries(this.opts.mcp?.statuses() ?? [], this.opts.mcpPresets?.()).findIndex(entry => entry.server === server.server));
          }
          if (!this.quitting) this.refresh();
        });
      }
    }
    this.refresh();
  }

  /** Repaint the composer, the menu and the hint from current state. */
  private refresh(): void {
    // Reading local status is cheap. Keep a visible panel current if a shared
    // startup outlives a cancelled waiter; never poll a remote server here.
    const pendingConnection = this.mcpPanel && this.opts.mcp?.statuses().some((s) => s.state === "connecting");
    if (pendingConnection && !this.mcpRefreshTimer && !this.quitting) {
      this.mcpRefreshTimer = setTimeout(() => { this.mcpRefreshTimer = null; if (!this.quitting) this.refresh(); }, 250);
      this.mcpRefreshTimer.unref();
    } else if (!pendingConnection && this.mcpRefreshTimer) {
      clearTimeout(this.mcpRefreshTimer);
      this.mcpRefreshTimer = null;
    }
    const items = this.menuItems();
    const pendingChoice = this.pendingChoice;
    const loginNotice = this.mcpBusy?.notice ?? this.mcpLoginNotice;
    const view: ComposerView = {
      draft: this.composer.snapshot(),
      placeholder: PLACEHOLDER,
      ...(this.pendingConfirm ? { confirm: this.confirmView(this.pendingConfirm.call, this.pendingConfirm.selected) } : {}),
      ...(pendingChoice?.wrap ? { panel: (width: number) => ({ title: pendingChoice.title, lines: pendingChoice.lines.flatMap(line => wrapToWidth(line, Math.max(1, width - 8))), choices: pendingChoice.options.map((option, index) => `${index === pendingChoice.selected ? "❯" : " "} ${option}`) }) } : {}),
      ...(this.pendingChoice && !this.pendingChoice.wrap
        ? { confirm: { title: this.pendingChoice.title, lines: this.pendingChoice.lines, choices: this.pendingChoice.options.map((o, i) => `${i === this.pendingChoice!.selected ? "❯" : " "} ${o}`) } }
        : {}),
      ...(this.pendingSecret ? { secret: { title: this.pendingSecret.title, lines: this.pendingSecret.lines, prompt: this.pendingSecret.prompt, masked: this.pendingSecret.masked } } : {}),
      ...((this.mcpPanel || this.mcpBusy) && !this.pendingConfirm && !this.pendingChoice && !this.pendingSecret ? { panel: (width: number, height: number) => ({ ...mcpPanelView(
        this.opts.mcp?.statuses() ?? [], this.mcpPanel?.selected ?? Math.max(0, this.opts.mcp?.statuses().findIndex((s) => s.server === this.mcpBusy?.server) ?? 0),
        width, this.mcpBusy ? this.mcpBusy.notice ?? `${this.mcpBusy.action} in progress…` : this.mcpPanel?.notice, height, this.opts.mcpPresets?.(),
      ), hint: this.mcpBusy ? this.hintText() : mcpPanelKeys(width) }) } : {}),
      ...(loginNotice && !this.pendingConfirm && !this.pendingChoice && !this.pendingSecret ? { panel: (width: number, height: number) => ({ ...mcpLoginPanelView(loginNotice, width, height), hint: "esc cancels authorization" }) } : {}),
      ...(items.length > 0 && !this.mcpLoginNotice && !this.pendingConfirm && !this.pendingSecret && !this.pendingChoice && !this.mcpPanel && !this.mcpBusy
        ? { menu: { items, selected: clampSelection(this.menuSelected, items.length), prefix: this.mentionOpen() ? "@" : "/" } }
        : {}),
    };
    this.screen.setHint(this.hintText());
    this.screen.setComposer(view);
  }

  private hintText(): string {
    if (this.pendingSecret) return this.pendingSecret.cancelHint;
    if (this.pendingChoice) return "1 2 or ↑↓ enter · esc leaves it";
    if (this.pendingConfirm) return "1 2 3 or ↑↓ enter · esc declines";
    if (this.mcpBusy) return this.mcpBusy.action === "disconnect" ? "closing connection…" : "esc stops waiting";
    if (this.mcpPanel) return mcpPanelKeys(this.screen.width);
    if (this.ctrlCArmedAt > 0 && this.now() - this.ctrlCArmedAt <= CTRL_C_WINDOW_MS) return "ctrl-c again to quit";
    if (this.queued.length > 0) {
      const first = this.queued[0]!.split("\n")[0]!;
      return this.queued.length === 1 ? `queued: ${first}` : `${this.queued.length} queued · next: ${first}`;
    }
    if (this.active) return RUNNING_HINT;
    if (this.settings.permissions === "auto") return "⏵⏵ auto-approve on (shift-tab to ask)";
    return IDLE_HINT;
  }

  /* ---------------------------------------------------------------- */
  /* tasks and commands                                                */
  /* ---------------------------------------------------------------- */

  private async submit(text: string): Promise<void> {
    if (text.trim() === "") return;
    if (this.opts.historyPath) appendHistory(this.opts.historyPath, text);
    if (this.shellBusy) {
      this.queued.push(text);
      this.refresh();
      return;
    }
    if (text.startsWith("!") && text.length > 1) {
      await this.runShellLine(text.slice(1).trim());
      const next = this.queued.shift();
      if (next !== undefined) await this.submit(next);
      return;
    }
    if (text.startsWith("#") && text.length > 1) {
      this.addNote(text.slice(1).trim());
      return;
    }
    const slash = parseSlash(text);
    if (slash && !findCommand(slash.name) && this.opts.skills.get(slash.name)) {
      // A skill as a command, the way Claude Code runs one: its instructions
      // become the task, with whatever followed the name as the input.
      if (this.active) {
        this.queued.push(text);
        this.refresh();
        return;
      }
      const expanded = expandSkillInput(text, { cwd: this.settings.cwd, skills: this.opts.skills });
      if (expanded.errors.length) {
        this.screen.append({ kind: "notice", level: "error", text: expanded.errors.join("\n") }); this.refresh(); return;
      }
      await this.runTask(expanded.task, text);
      return;
    }
    if (slash) {
      if ((this.active || this.settlingTask) && BLOCKED_WHILE_RUNNING.has(slash.name.toLowerCase())) {
        this.screen.append({
          kind: "notice",
          level: "warn",
          text: `/${slash.name} changes the conversation; wait for the running task to end, or press esc to interrupt it`,
        });
        this.refresh();
        return;
      }
      const out = await runSlash(text, this.context());
      if (!this.quitting && out.lines.length > 0) {
        this.screen.append(
          out.error
            ? { kind: "notice", level: "error", text: out.lines.join(" ") }
            : { kind: "system", title: out.title, lines: out.lines },
        );
        this.refresh();
      }
      return;
    }
    if (this.active || this.settlingTask) {
      // Queued, in order, and sent one by one as the prompt frees up — the
      // person keeps typing while the model works.
      this.queued.push(text);
      this.refresh();
      return;
    }
    const { task, attached, errors } = expandSkillInput(text, {
      cwd: this.settings.cwd, skills: this.opts.skills,
      automatic: this.opts.tools.some(tool => "function" in tool && tool.function?.name === "skill"), slash: false,
    });
    if (errors.length) { this.screen.append({ kind: "notice", level: "error", text: errors.join("\n") }); this.refresh(); return; }
    if (attached.length > 0) {
      this.screen.append({ kind: "notice", level: "info", text: `attached ${attached.map((a) => `@${a}`).join(", ")}` });
    }
    await this.runTask(task, text);
  }

  /**
   * `!command`: run it here, now, and let the model see what it printed.
   *
   * Claude Code's shortcut for the thing people otherwise do in a second
   * terminal. The command runs in the working directory with a fresh shell,
   * shows as a tool call would, and goes into the transcript as a user turn
   * — it is something the person did, and the model should know.
   */
  private async runShellLine(command: string): Promise<void> {
    if (command === "") return;
    const id = `shell-${++this.shellSequence}`;
    this.shellBusy = true;
    this.screen.append({ kind: "tool", id, name: "bash", args: { command }, repaired: false, hooks: [] });
    let r;
    try {
      r = await runShell(command, { cwd: this.settings.cwd, timeoutMs: 120_000, outputCap: 20_000 });
    } finally {
      this.shellBusy = false;
    }
    const output = r.timedOut ? `${r.output.trim()}\n(killed after ${Math.round(r.ms / 1000)}s)`.trim() : r.output.trim() || `(exit ${r.code})`;
    this.screen.apply({ type: "tool_end", id, ok: r.code === 0 && !r.timedOut, output, ms: r.ms });
    this.history.push({
      role: "user",
      content: `I ran this in the shell myself:\n$ ${command}\n\n\`\`\`\n${output.slice(0, 8000)}\n\`\`\`\n(exit ${r.code ?? "?"})`,
    });
    forgetFiles();
    this.refresh();
  }

  /**
   * `#note`: a line for the project notes, which every session reads into
   * its system prompt. Applies from the next task, because the system turn
   * is built per task.
   */
  private addNote(note: string): void {
    const path = this.opts.notesPath ?? join(this.settings.cwd, ".motif", "NOTES.md");
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
      appendFileSync(path, `${sep}- ${note}\n`, "utf8");
      this.projectNotes = readFileSync(path, "utf8");
      this.screen.append({ kind: "notice", level: "info", text: `noted in ${path}; the next task reads it` });
    } catch (err) {
      this.screen.append({ kind: "notice", level: "error", text: `could not write ${path}: ${err instanceof Error ? err.message : String(err)}` });
    }
    this.refresh();
  }

  /**
   * Run one task. `display` is what the transcript shows for it when the
   * task text itself is not what was typed — a skill's instructions stand in
   * for `/commit`, and the person should see `/commit`.
   */
  private async runTask(task: string, display?: string): Promise<void> {
    this.screen.append({ kind: "user", text: display ?? task });
    if (this.needsLogin) {
      // Skipped at startup, or logged out since: the task waits for a key.
      this.screen.append({ kind: "system", title: "login", lines: await this.login("task") });
      this.refresh();
    }
    this.tasks.push(task);
    const transport = (this.opts.makeTransport ?? defaultTransport)(this.settings, this.apiKey);
    const runId = new Date(this.now()).toISOString().replace(/[:.]/g, "-") + `-${String(this.totals.tasks + 1).padStart(2, "0")}`;
    const journalPath = join(this.opts.journalDir, `${runId}.jsonl`);
    const scope: ScopeIdentity = { scopeId: "root", scopeKind: "root" };
    const journal = new Journal(
      journalPath,
      newHeader({
        runId,
        cwd: this.settings.cwd,
        model: this.settings.model,
        endpoint: this.settings.endpoint,
        systemHash: systemPromptHash(this.systemFor(this.settings.channel)),
        toolSchemaHash: toolSchemaHash(this.opts.tools),
        harnessVersion: this.opts.version,
        config: {
          initialChannel: this.settings.channel,
          channelPolicy: this.opts.channelPolicy,
          temperature: SAMPLING_DEFAULTS.temperature,
          topP: SAMPLING_DEFAULTS.top_p,
          ...(this.settings.seed !== undefined ? { seed: this.settings.seed } : {}),
          maxTurns: this.settings.maxTurns,
          ...(this.settings.maxOutputTokens !== undefined ? { maxOutputTokens: this.settings.maxOutputTokens } : {}),
          maxRepairs: 2,
        },
      }),
    );
    journal.record(scope, {
      t: "scope_start",
      task,
      initialMessages: [...this.history, { role: "user", content: task }],
    });
    this.lastJournalPath = journalPath;

    const abort = new AbortController();
    this.active = { task, journal, transport, abort, scope };
    this.screen.setTitle(`✳ motif · ${(display ?? task).split("\n")[0]!.slice(0, 40)}`);
    this.refresh();

    const sink = journal.sinkFor(scope);
    let contentThisTurn = false;
    const emit = (e: LoopEvent): void => {
      // Stream pieces are for the screen; the journal keeps the whole turn.
      if (e.type !== "stream") sink(e);
      switch (e.type) {
        case "stream":
          // Once words arrive the words are the progress; while a tool call
          // is still being sent, say which.
          if (e.content) this.screen.setActivity(null);
          else if (e.tool) this.screen.setActivity(`Calling ${e.tool}…`);
          break;
        case "session_start":
          // The welcome card already says which model and endpoint this is;
          // a line per task saying it again is noise in a conversation. The
          // instruments still need the channel, so the event is folded
          // without its cell.
          this.screen.setLabel(this.settings.model);
          return;
        case "turn_start":
          contentThisTurn = false;
          this.screen.setActivity("Thinking…");
          break;
        case "reasoning_end":
        case "content_delta":
        case "tool_start":
          if (e.type === "content_delta") contentThisTurn = true;
          this.screen.setActivity(null);
          break;
        case "usage":
          this.totals.promptTokens += e.promptTokens ?? 0;
          this.totals.completionTokens += e.completionTokens ?? 0;
          this.totals.cachedTokens += e.cachedTokens ?? 0;
          if (e.promptTokens !== undefined) this.totals.lastContext = e.promptTokens;
          break;
        case "session_end":
          this.screen.setActivity(null);
          if (e.reason === "done") {
            // A turn that ended in prose already shows it; one that ended in
            // `done` shows the summary as the reply it stands for. Either way
            // there is no banner: the prompt coming back is the ending.
            if (e.summary && !contentThisTurn) this.screen.append({ kind: "assistant", text: e.summary });
            return;
          }
          break;
        default:
          break;
      }
      this.screen.apply(e);
    };

    let result: LoopResult | undefined;
    try {
      const mcpContext = await this.prepareMcp(display ?? task, abort.signal);
      // Earlier tasks' contexts stay in history for the cached prefix; repeat
      // only what changed since the latest complete one.
      const previous = this.history.findLast((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(MCP_CONTEXT_PREFIX));
      result = await runLoop({
        transport,
        tools: this.opts.tools,
        system: (ch) => this.systemFor(ch),
        userTask: task,
        context: mcpContext && compactMcpContext(mcpContext, previous?.content as string | undefined),
        contextOnRestart: mcpContext,
        replyRecovery: (content) => this.opts.mcp?.replyRecovery(content),
        history: this.history,
        executor: this.executor,
        emit,
        onCheckpoint: journal.checkpointFor(scope),
        lifecycle: async (event, context) => {
          const outcomes = await runHooks(this.opts.hooks, {
            event,
            cwd: this.settings.cwd,
            payload: { scopeId: context.scopeId, turn: context.turn, channel: context.channel, detail: context.detail ?? null },
          });
          for (const h of outcomes) emit({ type: "hook", event, label: h.label, ok: h.ok });
        },
        scopeId: scope.scopeId,
        repo: { cwd: this.settings.cwd },
        channel: this.settings.channel,
        channelPolicy: this.opts.channelPolicy,
        maxTurns: this.settings.maxTurns,
        ...(this.settings.maxOutputTokens !== undefined ? { maxOutputTokens: this.settings.maxOutputTokens } : {}),
        ...(this.settings.seed !== undefined ? { seed: this.settings.seed } : {}),
        // A conversation: a reply is an answer, and the person is the
        // confirmation a `done` would otherwise need.
        replyEnds: true,
        confirmDone: false,
        compaction: { limitTokens: this.compactLimit(), userTurns: this.tasks.slice(0, -1) },
        stream: true,
        signal: abort.signal,
      });
      journal.record(scope, {
        t: "scope_end",
        result: {
          endReason: result.reason,
          ...(result.summary !== undefined ? { summary: result.summary } : {}),
          turns: result.turns,
        },
      });
      // The conversation is whatever the loop had when it stopped — after a
      // `done`, and after an interruption too. The system turn is the
      // caller's and is rebuilt per task, so it is not carried.
      this.history = result.transcript.slice(1);
      if (result.reason === "done") this.totals.done += 1;
      if (result.reason === "aborted") this.totals.interrupted += 1;
    } catch (err) {
      this.screen.append({ kind: "notice", level: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      this.settlingTask = true;
      this.active = null;
      this.screen.setActivity(null);
      this.screen.setTitle(`motif · ${this.settings.cwd.split("/").pop() ?? this.settings.cwd}`);
      this.totals.tasks += 1;
      forgetFiles();
      this.refresh();
    }

    if (this.quitting) {
      this.settlingTask = false;
      this.finish();
      return;
    }
    if (this.totals.lastContext >= this.compactLimit() && this.history.length > 0) {
      // The last request was already over the line; compact now rather than
      // at the next task's first turn, so the person sees it happen. A
      // summary that fails leaves the transcript as it was, with a warning —
      // never an unhandled rejection out of a fire-and-forget submit.
      try {
        const lines = await this.compactNow();
        this.screen.append({ kind: "system", title: "compaction", lines });
      } catch (err) {
        this.screen.append({
          kind: "notice",
          level: "warn",
          text: `${err instanceof Error ? err.message : String(err)}; the transcript was left as it was`,
        });
      }
    }
    this.settlingTask = false;
    if (this.quitting) { this.finish(); return; }
    const next = this.queued.shift();
    if (next !== undefined) {
      await this.submit(next);
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Stop the running task.
   *
   * Messages queued behind it are not sent: an interruption says stop, and
   * launching the next task on its heels is the opposite. They go into the
   * composer's history instead, where ↑ brings them back to be sent again or
   * changed — Claude Code's "press up to edit queued messages".
   */
  private interrupt(): void {
    if (this.pendingConfirm) {
      const pending = this.pendingConfirm;
      this.pendingConfirm = null;
      pending.resolve("deny");
    }
    if (this.queued.length > 0) {
      const held = this.queued.splice(0);
      this.composer.seedHistory(held);
      this.screen.append({
        kind: "notice",
        level: "info",
        text: `${held.length} queued message${held.length === 1 ? "" : "s"} not sent; ↑ brings ${held.length === 1 ? "it" : "them"} back`,
      });
    }
    this.active?.abort.abort();
  }

  private compactLimit(): number {
    return Math.floor(this.settings.compactAt * MAX_CONTEXT);
  }

  /**
   * Replace the transcript with the model's summary of it, Codex-style: the
   * person's messages stay verbatim, the rest becomes a handoff.
   */
  private async compactNow(focus = ""): Promise<string[]> {
    if (this.history.length === 0) return ["nothing to compact; the conversation is empty"];
    const before = this.totals.lastContext;
    const transport = (this.opts.makeTransport ?? defaultTransport)(this.settings, this.apiKey);
    this.screen.setActivity("Compacting the conversation…");
    try {
      const summary = await summarizeTranscript({
        transport,
        messages: [{ role: "system", content: this.systemFor(this.settings.channel) }, ...this.history],
        tools: this.opts.tools,
        ...(focus ? { focus } : {}),
      });
      this.history = buildCompactedHistory(this.tasks, summary);
      this.screen.apply({ type: "compaction", beforeTokens: before, summaryChars: summary.length, summary });
      return [
        `the transcript was replaced by a ${summary.length}-character summary${before > 0 ? ` (last request: ${before.toLocaleString("en-US")} tokens)` : ""}`,
        `${this.tasks.length} of your message(s) were kept verbatim ahead of it`,
      ];
    } catch (err) {
      throw new Error(`compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.screen.setActivity(null);
    }
  }

  /** Abort active work and let the owner await connection cleanup. */
  stop(): void {
    this.quit();
  }

  private quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.mcpBusy?.abort.abort();
    if (this.pendingChoice) { const pending = this.pendingChoice; this.pendingChoice = null; pending.resolve(null); }
    if (this.pendingSecret) { const pending = this.pendingSecret; this.pendingSecret = null; this.composer.clear(); pending.resolve(null); }
    if (this.mcpRefreshTimer) clearTimeout(this.mcpRefreshTimer);
    this.mcpRefreshTimer = null;
    if (this.active) {
      // The task ends first; `finish` runs from its tail.
      this.interrupt();
      return;
    }
    this.finish();
  }

  private finish(): void {
    this.executor.close();
    this.screen.finish();
    this.finished?.(0);
    this.finished = null;
  }

  private systemFor(channel: ChannelId): string {
    return buildSystemPrompt({
      mode: "chat",
      channel,
      tools: this.opts.tools,
      skills: this.opts.skills,
      agents: this.opts.agents,
      ...(this.projectNotes !== undefined ? { projectNotes: this.projectNotes } : {}),
      cwd: this.settings.cwd,
    });
  }

  /**
   * The executor for a working directory.
   *
   * One per directory, not per task: `term` is a shell that keeps its state,
   * and a conversation that loses its shell between tasks is not a
   * conversation. Subagents spawned from it run against whichever task is
   * active when they are asked for.
   */
  private makeExecutor(cwd: string): ToolExecutor {
    const toolNames = CORE_TOOL_NAMES.slice(0, this.opts.tools.length);
    return new ToolExecutor({
      cwd,
      hooks: this.opts.hooks,
      skills: this.opts.skills,
      policy: policyForAgent({ root: cwd, tools: toolNames, readOnly: false }),
      callMcp: this.mcpInvoker("root"),
      confirm: (call) => this.confirm(call),
      onHook: (event, label, ok) => this.screen.apply({ type: "hook", event, label, ok }),
      runAgent: async (name, prompt, callId) => {
        const active = this.active;
        const def = this.opts.agents.get(name);
        if (!def || !active) {
          return {
            ok: false,
            reason: def ? "no_active_task" : "unknown_agent",
            runId: "-",
            summary: def
              ? "no task is running to delegate from"
              : `no such subagent: ${name}. Available: ${this.opts.agents.list().map((a) => a.name).join(", ")}`,
          };
        }
        const childScope: ScopeIdentity = {
          scopeId: nextRunId(`sub-${def.name}`),
          scopeKind: "subagent",
          parentScopeId: active.scope.scopeId,
          agentName: def.name,
        };
        return this.scheduler.submit(name, prompt, async () => {
          const childExecutor = new ToolExecutor({
            cwd: this.settings.cwd,
            skills: this.opts.skills,
            callMcp: this.mcpInvoker(childScope.scopeId),
            confirm: (call) => this.confirm(call),
            policy: policyForAgent({
              root: this.settings.cwd,
              tools: CORE_TOOL_NAMES.slice(0, def.toolCount),
              readOnly: def.readOnly === true,
            }),
          });
          active.journal.record(childScope, {
            t: "scope_start",
            task: prompt,
            initialMessages: [{ role: "user", content: prompt }],
          });
          // The parent's cell shows how the child is getting on: tool uses and
          // seconds, the way Claude Code's Task cell does.
          const childSink = active.journal.sinkFor(childScope);
          const startedAt = this.now();
          let toolUses = 0;
          const childEmit = (e: LoopEvent): void => {
            if (e.type !== "stream") childSink(e);
            if (e.type === "tool_start" && callId) {
              toolUses += 1;
              const seconds = Math.floor((this.now() - startedAt) / 1000);
              this.screen.apply({ type: "tool_progress", id: callId, text: `${toolUses} tool use${toolUses === 1 ? "" : "s"} · ${seconds}s` });
            }
          };
          try {
            const sub = await runLoop({
              transport: active.transport,
              tools: def.tools,
              system: (ch) =>
                buildAgentPrompt({
                  name: def.name,
                  instructions: def.instructions,
                  skills: this.opts.skills,
                  tools: def.tools,
                  channel: ch,
                  cwd: this.settings.cwd,
                }),
              userTask: prompt,
              context: def.toolCount >= CORE_TOOL_NAMES.length && !def.readOnly ? await this.opts.mcp?.prepare(prompt, active.abort.signal, childScope.scopeId) : undefined,
              replyRecovery: def.toolCount >= CORE_TOOL_NAMES.length && !def.readOnly ? (content) => this.opts.mcp?.replyRecovery(content) : undefined,
              executor: childExecutor,
              emit: childEmit,
              onCheckpoint: active.journal.checkpointFor(childScope),
              scopeId: childScope.scopeId,
              repo: { cwd: this.settings.cwd },
              channel: this.settings.channel,
              channelPolicy: this.opts.channelPolicy,
              maxTurns: def.maxTurns ?? 25,
              ...(this.settings.maxOutputTokens !== undefined ? { maxOutputTokens: this.settings.maxOutputTokens } : {}),
              ...(this.settings.seed !== undefined ? { seed: this.settings.seed } : {}),
              signal: active.abort.signal,
            });
            active.journal.record(childScope, {
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
            this.opts.mcp?.clearScope(childScope.scopeId);
          }
        });
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* what the commands may touch                                       */
  /* ---------------------------------------------------------------- */

  private context(): CommandContext {
    return {
      settings: this.settings,
      status: () => this.statusLines(),
      config: () => this.configLines(),
      themes: () => Object.entries(THEMES).map(([name, t]) => `${name.padEnd(10)} ${t.description}`),
      setTheme: (name) => {
        if (!applyTheme(name)) return [`no theme named ${name}; /theme lists them`];
        this.settings.theme = name;
        this.refresh();
        return [`theme set to ${name}`];
      },
      compact: (focus) => this.compactNow(focus),
      notes: () => {
        const path = this.opts.notesPath ?? join(this.settings.cwd, ".motif", "NOTES.md");
        if (!existsSync(path)) return [`no notes yet; # <text> at the prompt writes ${path}`];
        return [path, "", ...readFileSync(path, "utf8").replace(/\s+$/, "").split("\n")];
      },
      hooks: () => this.opts.hookLines ?? ["no hooks"],
      mcp: (args) => this.mcpCommand(args),
      persist: (key, value) => (this.opts.persist ? this.opts.persist(key, value) : null),
      login: () => this.login("command"),
      logout: () => this.logout(),
      doctor: async () =>
        formatChecks(
          await doctor({
            endpoint: this.settings.endpoint,
            model: this.settings.model,
            ...(this.apiKey !== undefined ? { apiKey: this.apiKey } : {}),
            ...(this.apiKeySource !== undefined ? { apiKeySource: this.apiKeySource } : {}),
          }),
        ).split("\n"),
      skills: () => this.opts.skills.list().map((s) => `${s.name.padEnd(16)} ${s.description}  (${s.source})`),
      agents: () =>
        this.opts.agents.list().map((a) => {
          const tools = CORE_TOOL_NAMES.slice(0, a.toolCount).join(" ");
          return `${a.name.padEnd(12)} ${a.description}  ·  tools: ${tools}`;
        }),
      plugins: () => this.opts.pluginLines ?? ["no plugins"],
      sessions: () => {
        const sessions = listSessions(this.opts.journalDir);
        if (sessions.length === 0) return [`no sessions in ${this.opts.journalDir}`];
        return sessions.map((s) => {
          const grade = s.grade ? ` grade=${s.grade.status}` : "";
          return `${s.header.startedAt}  ${s.outcome.padEnd(12)}${grade} ${s.rootEvents} events  ${s.path}`;
        });
      },
      resume: async (file) => this.resume(file),
      newConversation: (reason) => {
        this.history = [];
        this.tasks = [];
        this.opts.mcp?.clearScope("root");
        this.screen.append({ kind: "notice", level: "info", text: `${reason}; the transcript was cleared` });
      },
      setCwd: (path) => this.setCwd(path),
      toggleThinking: () => {
        this.screen.toggleThinking();
        return this.screen.thinkingShown;
      },
      quit: () => this.quit(),
    };
  }

  private configLines(): string[] {
    const info = this.opts.settingsInfo;
    const s = this.settings;
    const src = (key: keyof LoadedSettings["sources"]): string => info?.sources[key] ?? "default";
    const rows: [string, string, string][] = [
      ["model", s.model, src("model")],
      ["endpoint", s.endpoint, src("endpoint")],
      ["channel", s.channel, src("channel")],
      ["maxTurns", String(s.maxTurns), src("maxTurns")],
      ["maxOutputTokens", s.maxOutputTokens === undefined ? "off" : String(s.maxOutputTokens), src("maxOutputTokens")],
      ["seed", s.seed === undefined ? "off" : String(s.seed), src("seed")],
      ["theme", s.theme, src("theme")],
      ["thinking", this.screen.thinkingShown ? "shown" : "hidden", src("thinking")],
      ["compactAt", String(s.compactAt), src("compactAt")],
      ["permissions", s.permissions, src("permissions")],
    ];
    const lines = rows.map(([k, v, from]) => `${k.padEnd(16)} ${v.padEnd(40)} ${from}`);
    lines.push("");
    if (info) {
      lines.push(`user file     ${info.userPath}${existsSync(info.userPath) ? "" : " (absent)"}`);
      const projectState = !existsSync(info.projectPath) ? " (absent)" : info.projectApplied ? " (applied)" : " (present, not trusted — run `motif trust`)";
      lines.push(`project file  ${info.projectPath}${projectState}`);
    }
    lines.push("flags and MOTIF_* in the environment or .env outrank both files; /model and the rest save to the user file");
    return lines;
  }

  private statusLines(): string[] {
    const s = this.settings;
    const t = this.totals;
    const fmt = (n: number): string => n.toLocaleString("en-US");
    return [
      `model       ${s.model}`,
      `endpoint    ${s.endpoint}`,
      `channel     ${s.channel} (policy ${this.opts.channelPolicy})`,
      `cwd         ${s.cwd}`,
      `max-turns   ${s.maxTurns}`,
      `max-tokens  ${s.maxOutputTokens === undefined ? "off (server default)" : s.maxOutputTokens}`,
      `seed        ${s.seed === undefined ? "off" : s.seed}`,
      `theme       ${s.theme}`,
      `permissions ${s.permissions}${this.alwaysAllowed.size ? ` (always: ${[...this.alwaysAllowed].join(", ")})` : ""}`,
      `thinking    ${this.screen.thinkingShown ? "shown" : "hidden"}`,
      `compact-at  ${s.compactAt} of ${MAX_CONTEXT.toLocaleString("en-US")} tokens`,
      `api key     ${this.apiKey ? `present, from ${this.apiKeySource ?? "the caller"}` : "none — /login"}`,
      `journal     ${this.lastJournalPath ?? `(none yet; ${this.opts.journalDir})`}`,
      `history     ${this.history.length} turn(s) in the conversation`,
      `tasks       ${t.tasks} run · ${t.done} done · ${t.interrupted} interrupted`,
      `tokens      prompt ${fmt(t.promptTokens)} · completion ${fmt(t.completionTokens)} · cached ${fmt(t.cachedTokens)} · last context ${fmt(t.lastContext)}`,
    ];
  }

  /**
   * `/resume`: with nothing, the recent sessions numbered; with a number,
   * that one; with a path, that file.
   */
  private async resume(arg: string): Promise<string[]> {
    const sessions = listSessions(this.opts.journalDir);
    if (arg === "") {
      if (sessions.length === 0) return [`no sessions in ${this.opts.journalDir}`];
      const lines = sessions.slice(0, 10).map((s, i) => {
        let task = "";
        try {
          task = loadResume(s.path).task ?? "";
        } catch {
          // An unreadable journal is still listed, by its path.
        }
        return `${String(i + 1).padStart(2)}  ${s.header.startedAt.slice(0, 16).replace("T", " ")}  ${s.outcome.padEnd(12)} ${task ? task.split("\n")[0]!.slice(0, 60) : s.path}`;
      });
      lines.push("", "/resume <n> continues from one of these; /resume <file> from any journal");
      return lines;
    }
    let file = arg;
    if (/^\d+$/.test(arg)) {
      const picked = sessions[Number(arg) - 1];
      if (!picked) throw new Error(`no session ${arg}; /resume lists ${Math.min(sessions.length, 10)}`);
      file = picked.path;
    }
    const path = resolve(this.settings.cwd, file);
    if (!existsSync(path)) throw new Error(`${path} does not exist`);
    const state = loadResume(path);
    if (state.corruption !== undefined) throw new Error(`this journal is corrupt (${state.corruption})`);
    if (!state.checkpoint) throw new Error("no checkpoint was written in that session; there is nothing to continue");
    const blocker = resumeBlock(state.checkpoint, null);
    if (blocker?.kind === "execution_uncertain") {
      throw new Error(
        `cannot resume: the run stopped while \`${blocker.tool}\` (${blocker.id}) was running, and whether it ` +
        "took effect is unknowable from here. Inspect the working tree, then start a new run",
      );
    }
    const lines: string[] = [];
    if (state.checkpoint.currentChannel !== this.settings.channel) {
      // The transcript is in that channel's format, so the session follows it.
      this.settings.channel = state.checkpoint.currentChannel;
      lines.push(`channel set to ${this.settings.channel}, which the recorded transcript uses`);
    }
    if (state.header.model.id !== this.settings.model) {
      lines.push(`recorded against ${state.header.model.id}; this session sends ${this.settings.model}`);
    }
    this.opts.skills.restoreResourceAccess(state.checkpoint.messages);
    this.history = state.checkpoint.messages.slice(1);
    this.opts.mcp?.clearScope("root");
    lines.unshift(
      `continuing from ${path}`,
      `${this.history.length} turn(s) loaded${state.task ? ` — last task: ${state.task.split("\n")[0]}` : ""}`,
      state.finished ? "that session had finished; the next task picks up after it" : "that session was interrupted; the next task picks up where it stopped",
    );
    return lines;
  }

  private setCwd(path: string): string[] {
    const target = resolve(this.settings.cwd, path);
    if (!existsSync(target) || !statSync(target).isDirectory()) return [`not a directory: ${target}`];
    if (this.active) return ["a task is running; wait for it or interrupt it first"];
    this.executor.close();
    this.settings.cwd = target;
    this.screen.setCwd(target);
    this.executor = this.makeExecutor(target);
    return [`working directory is now ${target}`, "the persistent shell was restarted there"];
  }
}

/**
 * A skill's instructions as a task, with the input where the skill wants it.
 *
 * `$ARGUMENTS` is the ecosystem's convention for the slot; a skill without
 * one gets the input appended, labelled, so the model knows which part is
 * the person's and which the sheet's.
 */
function mcpApprovalKey(server: unknown, method: unknown, args: unknown): string {
  return JSON.stringify([server, method, args ?? {}]);
}

export function skillTask(rendered: string, input: string): string {
  return substituteSkillArguments(rendered, input);
}

function readHistory(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { text?: unknown };
      if (typeof parsed.text === "string") entries.push(parsed.text);
    } catch {
      // A torn line from an interrupted write is not worth losing the file over.
    }
  }
  return entries.slice(-HISTORY_LOADED);
}

function appendHistory(path: string, text: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), text }) + "\n", "utf8");
  } catch {
    // History is a convenience; a read-only directory must not stop a task.
  }
}

function defaultTransport(settings: ChatSettings, apiKey: string | undefined): Transport {
  return new HttpTransport({
    endpoint: settings.endpoint,
    model: settings.model,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
}
