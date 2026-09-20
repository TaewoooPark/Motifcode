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

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentRegistry, AgentScheduler, concurrencyFor } from "@motifcode/agents";
import {
  HttpTransport,
  runLoop,
  type ChannelPolicy,
  type LoopEvent,
  type LoopResult,
  type Transport,
} from "@motifcode/core";
import { runHooks, type HookConfig } from "@motifcode/hooks";
import { Journal, listSessions, loadResume, newHeader, type ScopeIdentity } from "@motifcode/journal";
import { SAMPLING_DEFAULTS, systemPromptHash, toolSchemaHash, type ChannelId, type Message, type Tool } from "@motifcode/protocol";
import type { SkillRegistry } from "@motifcode/skills";
import { CORE_TOOL_NAMES } from "@motifcode/tools";
import {
  Composer,
  Screen,
  clampSelection,
  menuItemsFor,
  renderComposer,
  renderMenu,
  type ComposerView,
  type Key,
  type MenuItem,
} from "@motifcode/tui";
import { COMMANDS, parseSlash, runSlash, type ChatSettings, type CommandContext } from "./commands.js";
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
const IDLE_HINT = "/ commands · esc clears · ctrl-c twice quits";
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
  private active: ActiveTask | null = null;
  private queued: string | null = null;
  private quitting = false;
  private ctrlCArmedAt = 0;
  private lastJournalPath: string | undefined;
  private lastSessionCell: { model: string; endpoint: string; channel: string } | null = null;
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
        });
      }
      this.screen.append({
        kind: "system",
        title: "motif",
        lines: [
          "Type a task and press enter. The conversation continues across tasks;",
          "/help lists the commands, esc interrupts a running task, ctrl-c twice quits.",
        ],
      });
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
        this.composer.insert(key.text);
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

  private menuItems(): MenuItem[] {
    const items = menuItemsFor(this.composer.text, MENU_ITEMS);
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
    const view: ComposerView = {
      render: renderComposer(this.composer.snapshot(), { width, placeholder: PLACEHOLDER }),
      ...(items.length > 0
        ? {
            menu: {
              rows: renderMenu(items, this.menuSelected, { width }),
              selected: Math.min(
                clampSelection(this.menuSelected, items.length),
                renderMenu(items, this.menuSelected, { width }).length - 1,
              ),
            },
          }
        : {}),
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
    const slash = parseSlash(text);
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

  private async runTask(task: string): Promise<void> {
    this.screen.append({ kind: "user", text: task });
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
    const emit = (e: LoopEvent): void => {
      sink(e);
      if (e.type === "session_start") {
        // One session cell per connection, not per task: the model, endpoint
        // and channel are the same from one task to the next, and repeating
        // them is noise in a conversation.
        const same =
          this.lastSessionCell !== null &&
          this.lastSessionCell.model === e.model &&
          this.lastSessionCell.endpoint === e.endpoint &&
          this.lastSessionCell.channel === e.channel;
        this.lastSessionCell = { model: e.model, endpoint: e.endpoint, channel: e.channel };
        if (same) return;
      }
      if (e.type === "usage") {
        this.totals.promptTokens += e.promptTokens ?? 0;
        this.totals.completionTokens += e.completionTokens ?? 0;
        this.totals.cachedTokens += e.cachedTokens ?? 0;
        if (e.promptTokens !== undefined) this.totals.lastContext = e.promptTokens;
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
      this.totals.tasks += 1;
      this.refresh();
    }

    if (this.quitting) {
      this.finish();
      return;
    }
    const next = this.queued;
    this.queued = null;
    if (next !== null) {
      await this.runTask(next);
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private interrupt(): void {
    this.active?.abort.abort();
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
        this.screen.append({ kind: "notice", level: "info", text: `${reason}; the transcript was cleared` });
      },
      setCwd: (path) => this.setCwd(path),
      toggleThinking: () => {
        this.screen.toggleThinking();
        return this.screen.thinkingExpanded;
      },
      quit: () => this.quit(),
    };
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
      `thinking    ${this.screen.thinkingExpanded ? "expanded" : "folded"}`,
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

function defaultTransport(settings: ChatSettings, apiKey: string | undefined): Transport {
  return new HttpTransport({
    endpoint: settings.endpoint,
    model: settings.model,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
}
