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

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AgentRegistry, AgentScheduler, concurrencyFor } from "@motifcode/agents";
import {
  HttpTransport,
  buildCompactedHistory,
  runLoop,
  summarizeTranscript,
  type ChannelPolicy,
  type LoopEvent,
  type LoopResult,
  type ToolInvocation,
  type Transport,
} from "@motifcode/core";
import { runHooks, runShell, type HookConfig } from "@motifcode/hooks";
import { Journal, listSessions, loadResume, newHeader, type ScopeIdentity } from "@motifcode/journal";
import { MAX_CONTEXT, SAMPLING_DEFAULTS, systemPromptHash, toolSchemaHash, type ChannelId, type Message, type Tool } from "@motifcode/protocol";
import type { SkillRegistry } from "@motifcode/skills";
import { CORE_TOOL_NAMES } from "@motifcode/tools";
import {
  Composer,
  Screen,
  THEMES,
  applyTheme,
  clampSelection,
  mentionAt,
  mentionsIn,
  menuItemsFor,
  type ComposerView,
  type Key,
  type MenuItem,
} from "@motifcode/tui";
import { expandMentions, forgetFiles, listFiles, matchFiles } from "./files.js";
import { COMMANDS, findCommand, parseSlash, runSlash, type ChatSettings, type CommandContext, type PersistableKey } from "./commands.js";
import type { LoadedSettings } from "./settings.js";
import { doctor, formatChecks } from "./doctor.js";
import { ToolExecutor } from "./executor.js";
import { policyForAgent } from "./policy.js";
import { buildAgentPrompt, buildSystemPrompt } from "./prompt.js";

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
const BLOCKED_WHILE_RUNNING = new Set(["new", "clear", "channel", "resume", "cwd"]);

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
  /** A tool call waiting for the person's yes or no. */
  private pendingConfirm: { call: ToolInvocation; resolve: (v: "allow" | "deny") => void } | null = null;
  /** Tools the person allowed for the rest of the session with `a`. */
  private readonly alwaysAllowed = new Set<string>();
  private active: ActiveTask | null = null;
  private queued: string | null = null;
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
    if (!this.active && this.queued === null) return Promise.resolve();
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
      if (!this.opts.apiKey) {
        this.screen.append({
          kind: "notice",
          level: "warn",
          text: "no API key is configured: set MOTIF_API_KEY in ~/.motif/.env or ./.env, then /doctor",
        });
      }
      this.screen.attachInput(this.opts.stdin, (key) => this.onKey(key));
      this.refresh();
      if (this.opts.continueFrom) {
        void this.resume(this.opts.continueFrom)
          .then((lines) => this.screen.append({ kind: "system", title: "continuing", lines }))
          .catch((err: unknown) => this.screen.append({ kind: "notice", level: "error", text: err instanceof Error ? err.message : String(err) }))
          .then(() => {
            this.refresh();
            if (this.opts.initialTask) void this.submit(this.opts.initialTask);
          });
      } else if (this.opts.initialTask) {
        void this.submit(this.opts.initialTask);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* keys                                                              */
  /* ---------------------------------------------------------------- */

  private onKey(key: Key): void {
    if (this.pendingConfirm) {
      this.answerConfirm(key);
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
      .list()
      .filter((s) => !findCommand(s.name))
      .map((s) => ({ name: s.name, description: `skill · ${s.description}`, usage: "[input]" }));
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
      .list()
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
   * `y` or Enter allows it once, `a` allows that tool for the rest of the
   * session, `n` or Esc declines. Anything else is ignored: the question
   * stays until it is answered, and typing cannot slip past it.
   */
  private answerConfirm(key: Key): void {
    const pending = this.pendingConfirm;
    if (!pending) return;
    let verdict: "allow" | "deny" | null = null;
    if (key.type === "enter") verdict = "allow";
    else if (key.type === "escape") verdict = "deny";
    else if (key.type === "text") {
      const k = key.text.toLowerCase();
      if (k === "y") verdict = "allow";
      else if (k === "n") verdict = "deny";
      else if (k === "a") {
        this.alwaysAllowed.add(pending.call.name);
        verdict = "allow";
      }
    } else if (key.type === "ctrl" && key.key === "c") {
      verdict = "deny";
      this.interrupt();
    }
    if (verdict === null) return;
    this.pendingConfirm = null;
    pending.resolve(verdict);
    this.refresh();
  }

  /** Put a tool call to the person, unless the mode or an earlier `a` says not to. */
  private confirm(call: ToolInvocation): Promise<"allow" | "deny"> {
    if (this.settings.permissions === "auto" || this.alwaysAllowed.has(call.name)) return Promise.resolve("allow");
    return new Promise((resolve) => {
      this.pendingConfirm = { call, resolve };
      this.refresh();
    });
  }

  /** The question the panel shows for a call. */
  private confirmView(call: ToolInvocation): { title: string; lines: string[]; choices: string } {
    const a = call.arguments;
    const text = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
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
      default:
        title = `Run ${call.name}?`;
        lines = preview(JSON.stringify(a), 4);
    }
    return { title, lines, choices: `[y] yes   [a] always for ${call.name} this session   [n] no` };
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

  /** Repaint the composer, the menu and the hint from current state. */
  private refresh(): void {
    const items = this.menuItems();
    const view: ComposerView = {
      draft: this.composer.snapshot(),
      placeholder: PLACEHOLDER,
      ...(this.pendingConfirm ? { confirm: this.confirmView(this.pendingConfirm.call) } : {}),
      ...(items.length > 0 && !this.pendingConfirm
        ? { menu: { items, selected: clampSelection(this.menuSelected, items.length), prefix: this.mentionOpen() ? "@" : "/" } }
        : {}),
    };
    this.screen.setHint(this.hintText());
    this.screen.setComposer(view);
  }

  private hintText(): string {
    if (this.pendingConfirm) return "waiting for your answer";
    if (this.ctrlCArmedAt > 0 && this.now() - this.ctrlCArmedAt <= CTRL_C_WINDOW_MS) return "ctrl-c again to quit";
    if (this.queued !== null) return `queued: ${this.queued.split("\n")[0]}`;
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
      this.queued = text;
      this.refresh();
      return;
    }
    if (text.startsWith("!") && text.length > 1) {
      await this.runShellLine(text.slice(1).trim());
      const next = this.queued;
      this.queued = null;
      if (next !== null) await this.submit(next);
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
        this.queued = text;
        this.refresh();
        return;
      }
      await this.runTask(skillTask(this.opts.skills.render(slash.name), slash.args), text);
      return;
    }
    if (slash) {
      if (this.active && BLOCKED_WHILE_RUNNING.has(slash.name.toLowerCase())) {
        this.screen.append({
          kind: "notice",
          level: "warn",
          text: `/${slash.name} changes the conversation; wait for the running task to end, or press esc to interrupt it`,
        });
        this.refresh();
        return;
      }
      const out = await runSlash(text, this.context());
      if (!this.quitting) {
        this.screen.append(
          out.error
            ? { kind: "notice", level: "error", text: out.lines.join(" ") }
            : { kind: "system", title: out.title, lines: out.lines },
        );
        this.refresh();
      }
      return;
    }
    if (this.active) {
      // One queued message, the newest. Sent the moment the current task ends.
      this.queued = text;
      this.refresh();
      return;
    }
    const { task, attached } = expandMentions(text, mentionsIn(text), {
      cwd: this.settings.cwd,
      renderSkill: (name) => (this.opts.skills.get(name) ? this.opts.skills.render(name) : undefined),
    });
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
    this.tasks.push(task);
    const transport = (this.opts.makeTransport ?? defaultTransport)(this.settings, this.opts.apiKey);
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
      result = await runLoop({
        transport,
        tools: this.opts.tools,
        system: (ch) => this.systemFor(ch),
        userTask: task,
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
      this.active = null;
      this.screen.setActivity(null);
      this.screen.setTitle(`motif · ${this.settings.cwd.split("/").pop() ?? this.settings.cwd}`);
      this.totals.tasks += 1;
      forgetFiles();
      this.refresh();
    }

    if (this.quitting) {
      this.finish();
      return;
    }
    if (this.totals.lastContext >= this.compactLimit() && this.history.length > 0) {
      // The last request was already over the line; compact now rather than
      // at the next task's first turn, so the person sees it happen.
      const lines = await this.compactNow();
      this.screen.append({ kind: "system", title: "compaction", lines });
    }
    const next = this.queued;
    this.queued = null;
    if (next !== null) {
      await this.submit(next);
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private interrupt(): void {
    if (this.pendingConfirm) {
      const pending = this.pendingConfirm;
      this.pendingConfirm = null;
      pending.resolve("deny");
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
    const transport = (this.opts.makeTransport ?? defaultTransport)(this.settings, this.opts.apiKey);
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

  private quit(): void {
    if (this.quitting) return;
    this.quitting = true;
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
                  tools: def.tools,
                  channel: ch,
                  cwd: this.settings.cwd,
                }),
              userTask: prompt,
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
      persist: (key, value) => (this.opts.persist ? this.opts.persist(key, value) : null),
      doctor: async () =>
        formatChecks(
          await doctor({
            endpoint: this.settings.endpoint,
            model: this.settings.model,
            ...(this.opts.apiKey !== undefined ? { apiKey: this.opts.apiKey } : {}),
            ...(this.opts.apiKeySource !== undefined ? { apiKeySource: this.opts.apiKeySource } : {}),
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
      `api key     ${this.opts.apiKey ? `present, from ${this.opts.apiKeySource ?? "the caller"}` : "none"}`,
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
    const lines: string[] = [];
    if (state.checkpoint.currentChannel !== this.settings.channel) {
      // The transcript is in that channel's format, so the session follows it.
      this.settings.channel = state.checkpoint.currentChannel;
      lines.push(`channel set to ${this.settings.channel}, which the recorded transcript uses`);
    }
    if (state.header.model.id !== this.settings.model) {
      lines.push(`recorded against ${state.header.model.id}; this session sends ${this.settings.model}`);
    }
    this.history = state.checkpoint.messages.slice(1);
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
export function skillTask(rendered: string, input: string): string {
  if (rendered.includes("$ARGUMENTS")) return rendered.replaceAll("$ARGUMENTS", input);
  return input === "" ? rendered : `${rendered}\n\nInput from the person:\n${input}`;
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
