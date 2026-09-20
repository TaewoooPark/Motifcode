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
  type Transport,
} from "@motifcode/core";
import { runHooks, type HookConfig } from "@motifcode/hooks";
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
  menuItemsFor,
  renderComposer,
  renderMenu,
  type ComposerView,
  type Key,
  type MenuItem,
} from "@motifcode/tui";
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
      this.screen.attachInput(this.opts.stdin, (key) => this.onKey(key));
      this.refresh();
      if (this.opts.initialTask) void this.submit(this.opts.initialTask);
    });
  }

  /* ---------------------------------------------------------------- */
  /* keys                                                              */
  /* ---------------------------------------------------------------- */

  private onKey(key: Key): void {
    const menu = this.menuItems();
    switch (key.type) {
      case "text":
        // `?` on an empty prompt opens the shortcuts panel, as in Claude Code;
        // anywhere else it is a character.
        if (key.text === "?" && this.composer.empty) this.screen.toggleShortcuts();
        else this.composer.insert(key.text);
        break;
      case "paste":
        this.composer.insert(key.text);
        break;
      case "newline":
        this.composer.insert("\n");
        break;
      case "enter":
        if (menu.length > 0) {
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
        if (menu.length > 0) {
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

  private menuItems(): MenuItem[] {
    const items = menuItemsFor(this.composer.text, this.allMenuItems());
    // A new filter starts at the top; a longer or shorter one keeps whatever
    // was selected when it still exists.
    if (this.composer.text !== this.menuFilter) {
      this.menuFilter = this.composer.text;
      this.menuSelected = 0;
    }
    return items;
  }

  /** Repaint the composer, the menu and the hint from current state. */
  private refresh(): void {
    const width = this.screen.width;
    const items = this.menuItems();
    // The box takes four columns: its edges and a space inside each.
    const menu = items.length > 0 ? renderMenu(items, this.menuSelected, { width }) : null;
    const view: ComposerView = {
      render: renderComposer(this.composer.snapshot(), { width: width - 4, prompt: "> ", placeholder: PLACEHOLDER }),
      ...(menu ? { menu: { rows: menu.rows, selected: menu.selectedRow } } : {}),
    };
    this.screen.setHint(this.hintText());
    this.screen.setComposer(view);
  }

  private hintText(): string {
    if (this.ctrlCArmedAt > 0 && this.now() - this.ctrlCArmedAt <= CTRL_C_WINDOW_MS) return "ctrl-c again to quit";
    if (this.queued !== null) return `queued: ${this.queued.split("\n")[0]}`;
    if (this.active) return RUNNING_HINT;
    return IDLE_HINT;
  }

  /* ---------------------------------------------------------------- */
  /* tasks and commands                                                */
  /* ---------------------------------------------------------------- */

  private async submit(text: string): Promise<void> {
    if (text.trim() === "") return;
    if (this.opts.historyPath) appendHistory(this.opts.historyPath, text);
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
    await this.runTask(text);
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
    this.refresh();

    const sink = journal.sinkFor(scope);
    let contentThisTurn = false;
    const emit = (e: LoopEvent): void => {
      sink(e);
      switch (e.type) {
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
      this.totals.tasks += 1;
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
    this.active?.abort.abort();
  }

  private compactLimit(): number {
    return Math.floor(this.settings.compactAt * MAX_CONTEXT);
  }

  /**
   * Replace the transcript with the model's summary of it, Codex-style: the
   * person's messages stay verbatim, the rest becomes a handoff.
   */
  private async compactNow(): Promise<string[]> {
    if (this.history.length === 0) return ["nothing to compact; the conversation is empty"];
    const before = this.totals.lastContext;
    const transport = (this.opts.makeTransport ?? defaultTransport)(this.settings, this.opts.apiKey);
    this.screen.setActivity("Compacting the conversation…");
    try {
      const summary = await summarizeTranscript({
        transport,
        messages: [{ role: "system", content: this.systemFor(this.settings.channel) }, ...this.history],
        tools: this.opts.tools,
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
      ...(this.opts.projectNotes !== undefined ? { projectNotes: this.opts.projectNotes } : {}),
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
      onHook: (event, label, ok) => this.screen.apply({ type: "hook", event, label, ok }),
      runAgent: async (name, prompt) => {
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
              emit: active.journal.sinkFor(childScope),
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
      compact: () => this.compactNow(),
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
      `thinking    ${this.screen.thinkingShown ? "shown" : "hidden"}`,
      `compact-at  ${s.compactAt} of ${MAX_CONTEXT.toLocaleString("en-US")} tokens`,
      `api key     ${this.opts.apiKey ? `present, from ${this.opts.apiKeySource ?? "the caller"}` : "none"}`,
      `journal     ${this.lastJournalPath ?? `(none yet; ${this.opts.journalDir})`}`,
      `history     ${this.history.length} turn(s) in the conversation`,
      `tasks       ${t.tasks} run · ${t.done} done · ${t.interrupted} interrupted`,
      `tokens      prompt ${fmt(t.promptTokens)} · completion ${fmt(t.completionTokens)} · cached ${fmt(t.cachedTokens)} · last context ${fmt(t.lastContext)}`,
    ];
  }

  private async resume(file: string): Promise<string[]> {
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
