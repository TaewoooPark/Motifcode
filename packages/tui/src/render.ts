/**
 * Cells to lines. Pure, so the screen is snapshot-testable.
 *
 * No ANSI here and no terminal writes — this returns plain text and the writer
 * colours it. Codex keeps 125 render snapshots for the same reason: a TUI that
 * is only ever checked by eye breaks quietly on every refactor.
 */

import type { Cell, ViewState } from "./cells.js";
import { displayWidth, truncateEndToWidth, truncateToWidth } from "./width.js";

export interface RenderOptions {
  width: number;
  /** Expand collapsed reasoning cells. Bound to a key in the writer. */
  expandThinking?: boolean;
  /** Cap on tool output lines shown inline. */
  outputLines?: number;
}

const DEFAULTS = { outputLines: 8 };

function rule(label: string, width: number, trailing = ""): string {
  const head = `──  ${label}  `;
  const tail = trailing ? `  ${trailing}` : "";
  // Column width, not string length: a label carrying Hangul or CJK occupies
  // two columns per character and would push the rule past the terminal edge.
  const fill = Math.max(0, width - displayWidth(head) - displayWidth(tail));
  return head + "─".repeat(fill) + tail;
}

function indent(lines: string[], prefix = "  "): string[] {
  return lines.map((l) => prefix + l);
}

function clip(text: string, maxLines: number): { lines: string[]; hidden: number } {
  const all = text.replace(/\s+$/, "").split("\n");
  if (all.length <= maxLines) return { lines: all, hidden: 0 };
  return { lines: all.slice(0, maxLines), hidden: all.length - maxLines };
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const first = entries[0]!;
  const v = typeof first[1] === "string" ? first[1] : JSON.stringify(first[1]);
  return truncateToWidth(v, 400);
}

export function renderCell(cell: Cell, opts: RenderOptions): string[] {
  const width = opts.width;
  const outputLines = opts.outputLines ?? DEFAULTS.outputLines;

  switch (cell.kind) {
    case "session":
      return [
        rule("session", width),
        `  ${cell.model}  ·  ${cell.endpoint}`,
        // The hash is shown because the prompt prefix lives or dies with this
        // exact list in this exact order.
        `  ch ${cell.channel}  ·  tools[${cell.tools.length}] ${cell.tools.join(" ")}  ·  #${cell.toolsHash}`,
        "",
      ];

    case "user":
      return [rule("user", width), ...indent(cell.text.split("\n")), ""];

    case "think": {
      // Motif opens a thinking block on every generation, so an expanded view
      // would bury the session in reasoning. One line, and a key to open it.
      const chars = cell.text.length;
      const meta = `${(cell.ms / 1000).toFixed(1)}s · ${chars} chars`;
      if (!opts.expandThinking) {
        const firstLine = cell.text.split("\n").find((l) => l.trim() !== "") ?? "";
        const room = Math.max(10, width - 6);
        const preview = truncateToWidth(firstLine, room);
        return [rule("think", width, `${meta}  [tab]`), `  │ ${preview}`, ""];
      }
      return [rule("think", width, meta), ...indent(cell.text.split("\n"), "  │ "), ""];
    }

    case "plan": {
      const out = [rule("plan", width)];
      if (cell.analysis) out.push(...indent(cell.analysis.split("\n")));
      if (cell.plan) out.push(...indent(cell.plan.split("\n")));
      out.push("");
      return out;
    }

    case "assistant":
      return [...cell.text.split("\n"), ""];

    case "tool": {
      const status = cell.ok === undefined ? "…" : cell.ok ? "" : " ✗";
      const timing = cell.ms !== undefined ? `${cell.ms}ms` : "";
      const repaired = cell.repaired ? "repaired" : "";
      const trailing = [repaired, timing].filter(Boolean).join(" · ");
      const out = [rule(cell.name + status, width, trailing)];
      const argLine = summarizeArgs(cell.args);
      if (argLine) out.push(...indent(argLine.split("\n"), "  $ "));
      if (cell.output) {
        const { lines, hidden } = clip(cell.output, outputLines);
        out.push(...indent(lines, "  "));
        if (hidden > 0) out.push(`  … ${hidden} more lines`);
      }
      for (const h of cell.hooks) {
        out.push(`  ↳ hook  ${h.label} ${h.ok ? "✓" : "✗"}`);
      }
      out.push("");
      return out;
    }

    case "repair":
      // Given its own cell type on purpose. Without it the loop looks like it
      // is flailing; with it, a designed recovery is visibly running — which
      // matters more when the model on the other end has been pruned.
      return [
        rule("↻ repair", width, `attempt ${cell.attempt}/${cell.max}`),
        `  │ ${cell.reason} — handing the result back`,
        "",
      ];

    case "breakage":
      return [
        rule("⚠ parse", width, cell.kindOf),
        ...(cell.sample ? indent([cell.sample.split("\n")[0] ?? ""], "  │ ") : []),
        "",
      ];

    case "downgrade":
      return [
        rule("channel", width, `${cell.from} → ${cell.to}`),
        `  │ ${cell.reason}`,
        "",
      ];

    case "queue":
      return [rule("queue", width), `  │ ${cell.agent}  ${cell.state}`, ""];

    case "notice":
      return [`  ${cell.level === "error" ? "✗" : cell.level === "warn" ? "!" : "·"} ${cell.text}`, ""];

    case "loop":
      return [
        rule("⟲ loop", width, `${cell.repeats}×`),
        `  │ same action repeating: ${cell.signature}`,
        "",
      ];

    case "end": {
      const out = [rule("end", width, cell.reason)];
      if (cell.summary) out.push(...indent(cell.summary.split("\n")));
      out.push("");
      return out;
    }

    default:
      return [];
  }
}

export function renderTranscript(state: ViewState, opts: RenderOptions): string[] {
  const lines: string[] = [];
  for (const cell of state.cells) lines.push(...renderCell(cell, opts));
  return lines;
}

/** The live tail: reasoning still arriving, shown as a single ticker line. */
export function renderTail(state: ViewState, opts: RenderOptions): string[] {
  if (state.pendingThink === "") return [];
  const last = state.pendingThink.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  const room = Math.max(10, opts.width - 12);
  const preview = truncateEndToWidth(last, room);
  return [`  think │ ${preview}`];
}
