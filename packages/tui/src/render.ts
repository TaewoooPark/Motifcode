/**
 * Cells to lines. Pure, so the screen is snapshot-testable.
 *
 * No ANSI here and no terminal writes — this returns plain text plus a tone
 * per line, and the writer colours it. Codex keeps 125 render snapshots for
 * the same reason: a TUI that is only ever checked by eye breaks quietly on
 * every refactor.
 *
 * The shape is Claude Code's, because that is the transcript people already
 * read: the user's line echoed after `>`, the model's prose and each tool call
 * behind a `⏺`, results hanging off a `⎿`, reasoning folded into one dim line.
 * Rules and timings are gone from the transcript — a session's numbers belong
 * in `/status` and the journal, not between every two lines of a conversation.
 */

import type { Cell, ViewState } from "./cells.js";
import { sanitize } from "./sanitize.js";
import { displayWidth, truncateEndToWidth, truncateToWidth } from "./width.js";

export interface RenderOptions {
  width: number;
  /**
   * Show the model's reasoning.
   *
   * Off by default: this model thinks before every turn, and Claude Code's
   * answer to the same situation — a spinner while it happens, nothing after
   * — is the right one for a conversation. On, the reasoning is shown in full
   * and dim, for anyone debugging what the model was doing.
   */
  showThinking?: boolean;
  /** Cap on tool output lines shown inline. */
  outputLines?: number;
  /**
   * Show keyboard hints.
   *
   * False unless a key handler is actually attached. Printing a hint when
   * nothing listens for the key is a promise the program does not keep, and
   * the user's conclusion is that the tool is broken rather than that the hint
   * was decorative.
   */
  showShortcuts?: boolean;
}

/** How the writer should colour a line. */
export type Tone = "plain" | "dim" | "warn" | "bad" | "user" | "bullet" | "rule";

export interface StyledLine {
  text: string;
  tone: Tone;
}

const DEFAULTS = { outputLines: 6 };

/** The bullet before the model's prose and each of its tool calls. */
export const BULLET = "⏺";
/** The corner under a bullet, for what came back. */
export const RESULT = "⎿";
/** The mark on a reasoning line. */
export const THINK = "✻";

const TOOL_TITLES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  apply_patch: "Patch",
  term: "Term",
  skill: "Skill",
  task: "Task",
  mcp: "MCP",
};

function rule(label: string, width: number, trailing = ""): string {
  const head = `──  ${label}  `;
  const tail = trailing ? `  ${trailing}` : "";
  // Column width, not string length: a label carrying Hangul or CJK occupies
  // two columns per character and would push the rule past the terminal edge.
  const fill = Math.max(0, width - displayWidth(head) - displayWidth(tail));
  return head + "─".repeat(fill) + tail;
}

function clip(text: string, maxLines: number): { lines: string[]; hidden: number } {
  const all = text.replace(/\s+$/, "").split("\n");
  if (all.length <= maxLines) return { lines: all, hidden: 0 };
  return { lines: all.slice(0, maxLines), hidden: all.length - maxLines };
}

/** The one argument worth showing in a tool's head line, on one line. */
function headArg(name: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  if (name === "task") {
    const agent = typeof args["agent"] === "string" ? args["agent"] : "";
    const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
    return `${agent}${prompt ? `: ${prompt}` : ""}`;
  }
  const first = entries[0]!;
  const v = typeof first[1] === "string" ? first[1] : JSON.stringify(first[1]);
  const [firstLine, ...rest] = v.split("\n");
  return rest.length > 0 ? `${firstLine}…` : (firstLine ?? "");
}

/** `⏺ Bash(ls -la)`, fitted to the width. */
function toolHead(cell: Extract<Cell, { kind: "tool" }>, width: number): string {
  const title = TOOL_TITLES[cell.name] ?? cell.name;
  const suffix = cell.repaired ? " · repaired" : "";
  const room = Math.max(8, width - displayWidth(`${BULLET} ${title}()${suffix}`));
  const arg = truncateToWidth(headArg(cell.name, cell.args), room);
  return `${BULLET} ${title}(${arg})${suffix}`;
}

/** Result lines under a bullet: the first behind `⎿`, the rest aligned to it. */
function results(lines: string[]): string[] {
  return lines.map((l, i) => (i === 0 ? `  ${RESULT}  ${l}` : `     ${l}`));
}

/**
 * Cells to lines, with every byte made safe to print.
 *
 * The sanitiser runs on the finished lines rather than on each untrusted field,
 * so nothing can be added later that forgets to call it. The harness's own
 * decoration is printable text and passes through unchanged; the writer adds
 * ANSI styling afterwards, which is the only ANSI that reaches the terminal.
 */
export function renderCellStyled(cell: Cell, opts: RenderOptions): StyledLine[] {
  return renderCellRaw(cell, opts).map((l) => ({ text: sanitize(l.text), tone: l.tone }));
}

export function renderCell(cell: Cell, opts: RenderOptions): string[] {
  return renderCellStyled(cell, opts).map((l) => l.text);
}

function line(text: string, tone: Tone = "plain"): StyledLine {
  return { text, tone };
}

function renderCellRaw(cell: Cell, opts: RenderOptions): StyledLine[] {
  const width = opts.width;
  const outputLines = opts.outputLines ?? DEFAULTS.outputLines;
  const blank = line("");

  switch (cell.kind) {
    case "session":
      // One dim line: the model, where it is, and the tool list whose exact
      // order the prompt prefix lives or dies with.
      return [
        line(`· ${cell.model} · ${cell.endpoint} · ${cell.channel} · tools[${cell.tools.length}] #${cell.toolsHash}`, "dim"),
        blank,
      ];

    case "user": {
      const [first, ...rest] = cell.text.split("\n");
      return [line(`> ${first ?? ""}`, "user"), ...rest.map((l) => line(`  ${l}`, "user")), blank];
    }

    case "think": {
      // Motif opens a thinking block on every generation; hidden unless asked.
      if (!opts.showThinking) return [];
      const seconds = `${(cell.ms / 1000).toFixed(1)}s`;
      return [
        line(`${THINK} Thought for ${seconds}`, "dim"),
        ...cell.text.split("\n").map((l) => line(`  ${l}`, "dim")),
        blank,
      ];
    }

    case "plan": {
      const out: StyledLine[] = [];
      if (cell.analysis) {
        const [first, ...rest] = cell.analysis.split("\n");
        out.push(line(`${BULLET} ${first ?? ""}`), ...rest.map((l) => line(`  ${l}`)));
      }
      if (cell.plan) out.push(...cell.plan.split("\n").map((l) => line(`  ${l}`, "dim")));
      out.push(blank);
      return out;
    }

    case "assistant": {
      const [first, ...rest] = cell.text.split("\n");
      return [line(`${BULLET} ${first ?? ""}`, "bullet"), ...rest.map((l) => line(`  ${l}`)), blank];
    }

    case "tool": {
      const out: StyledLine[] = [line(toolHead(cell, width), "bullet")];
      if (cell.ok === undefined) {
        out.push(line(`  ${RESULT}  Running…`, "dim"));
      } else if (!cell.ok) {
        const { lines, hidden } = clip(cell.output ?? "", outputLines);
        const body = lines.length > 0 && lines[0] !== "" ? lines : ["(failed)"];
        out.push(...results([`Error: ${body[0]}`, ...body.slice(1)]).map((l) => line(l, "bad")));
        if (hidden > 0) out.push(line(`     … +${hidden} lines`, "dim"));
      } else if (cell.name === "read") {
        // The model read it; the person does not need it dumped again. A count
        // says the call worked, and the file is a `cat` away.
        const count = (cell.output ?? "").replace(/\s+$/, "").split("\n").filter((l) => l !== "").length;
        out.push(line(`  ${RESULT}  Read ${count} line${count === 1 ? "" : "s"}`, "dim"));
      } else {
        const { lines, hidden } = clip(cell.output ?? "", outputLines);
        const body = lines.length > 0 && lines[0] !== "" ? lines : ["(no output)"];
        out.push(...results(body).map((l) => line(l, "dim")));
        if (hidden > 0) out.push(line(`     … +${hidden} lines`, "dim"));
      }
      for (const h of cell.hooks) out.push(line(`     hook ${h.label} ${h.ok ? "✓" : "✗"}`, "dim"));
      out.push(blank);
      return out;
    }

    case "repair":
      // Its own line on purpose. Without it the loop looks like it is
      // flailing; with it, a designed recovery is visibly running.
      return [line(`↻ repair ${cell.attempt}/${cell.max} · ${cell.reason}`, "dim"), blank];

    case "breakage": {
      const head = `⚠ parse ${cell.kindOf}`;
      const sample = cell.sample.split("\n")[0] ?? "";
      const room = Math.max(10, width - displayWidth(head) - 3);
      return [line(sample ? `${head} · ${truncateToWidth(sample, room)}` : head, "warn"), blank];
    }

    case "downgrade":
      return [line(`⇄ channel ${cell.from} → ${cell.to} · ${cell.reason}`, "warn"), blank];

    case "queue":
      return [line(`${BULLET} Task(${cell.agent}) · ${cell.state}`, "dim"), blank];

    case "notice": {
      const mark = cell.level === "error" ? "✗" : cell.level === "warn" ? "!" : "·";
      return [line(`  ${mark} ${cell.text}`, cell.level === "error" ? "bad" : cell.level === "warn" ? "warn" : "dim"), blank];
    }

    case "loop":
      return [line(`⟲ loop detected ${cell.repeats}× · ${cell.signature}`, "bad"), blank];

    case "end": {
      if (cell.reason === "done") {
        if (!cell.summary) return [];
        const [first, ...rest] = cell.summary.split("\n");
        return [line(`${BULLET} ${first ?? ""}`, "bullet"), ...rest.map((l) => line(`  ${l}`)), blank];
      }
      const label: Record<string, string> = {
        aborted: "Interrupted",
        turn_limit: "Stopped: turn limit reached",
        breakage_limit: "Stopped: too many malformed actions",
        loop_detected: "Stopped: the same action kept repeating",
        no_action_limit: "Stopped: no action for several turns",
        transport_error: "Stopped: the endpoint could not be reached",
      };
      return [line(`  ${RESULT}  ${label[cell.reason] ?? `Stopped: ${cell.reason}`}`, "warn"), blank];
    }

    case "system":
      return [line(rule(cell.title, width), "rule"), ...cell.lines.map((l) => line(`  ${l}`)), blank];

    default:
      return [];
  }
}

/**
 * A cell is settled once nothing can change it again.
 *
 * Only tool cells are ever unsettled: they are created at `tool_start` and
 * completed at `tool_end`, so between the two their output and status are still
 * arriving. Committing one to scrollback in that window prints a tool that
 * looks like it produced nothing — the two-region rule applied to cells rather
 * than to text.
 */
export function isSettled(cell: Cell): boolean {
  return cell.kind !== "tool" || cell.ok !== undefined;
}

/** Index of the first cell that may still change. */
export function settledCount(state: ViewState): number {
  let i = 0;
  while (i < state.cells.length && isSettled(state.cells[i]!)) i++;
  return i;
}

export function renderTranscript(state: ViewState, opts: RenderOptions): string[] {
  const lines: string[] = [];
  for (const cell of state.cells) lines.push(...renderCell(cell, opts));
  return lines;
}

/** Lines safe to commit to scrollback. */
export function renderSettled(state: ViewState, opts: RenderOptions): string[] {
  return renderSettledStyled(state, opts).map((l) => l.text);
}

export function renderSettledStyled(state: ViewState, opts: RenderOptions): StyledLine[] {
  const lines: StyledLine[] = [];
  for (const cell of state.cells.slice(0, settledCount(state))) lines.push(...renderCellStyled(cell, opts));
  return lines;
}

/** Lines that must be repainted because their cells are still changing. */
export function renderPending(state: ViewState, opts: RenderOptions): string[] {
  return renderPendingStyled(state, opts).map((l) => l.text);
}

export function renderPendingStyled(state: ViewState, opts: RenderOptions): StyledLine[] {
  const lines: StyledLine[] = [];
  for (const cell of state.cells.slice(settledCount(state))) lines.push(...renderCellStyled(cell, opts));
  return lines;
}

/** The live tail: reasoning still arriving, shown as a single ticker line. */
export function renderTail(state: ViewState, opts: RenderOptions): string[] {
  if (state.pendingThink === "") return [];
  const last = state.pendingThink.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  const room = Math.max(10, opts.width - 4);
  return [sanitize(`${THINK} ${truncateEndToWidth(last, room)}`)];
}
