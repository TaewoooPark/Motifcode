/** A bounded settings/status panel. The controller owns navigation and edits. */
import { renderComposer, type ComposerSnapshot } from "./composer.js";
import { sanitize } from "./sanitize.js";
import { NO_COLOR, paint, style } from "./theme.js";
import { displayWidth, expandTabs, truncateToWidth, wrapToWidth } from "./width.js";

export interface PanelView {
  tabs: string[];
  activeTab: number;
  subtitle?: string;
  rows: { label: string; value?: string; detail?: string; tone?: "normal" | "muted" | "good" | "warn" | "bad" }[];
  selected?: number;
  offset?: number;
  message?: string;
  error?: boolean;
  hint: string;
  editing?: { label: string; draft: ComposerSnapshot };
}

export interface PanelRender {
  rows: { text: string; width: number }[];
  cursor: { row: number; col: number } | null;
}

const singleLine = (text: string): string => expandTabs(sanitize(text).replace(/\n/g, " "));
const clamp = (value: number, max: number): number => Math.max(0, Math.min(Number.isFinite(value) ? Math.floor(value) : 0, Math.max(0, max)));

/** Decorate only after measuring plain text, so ANSI never moves the caret. */
export function renderPanel(view: PanelView, opts: { width: number; height: number }): PanelRender {
  const width = Math.max(1, Math.floor(opts.width));
  const height = Math.max(0, Math.floor(opts.height));
  if (height === 0) return { rows: [], cursor: null };
  const boxed = width >= 8 && height >= 6;
  const inner = boxed ? width - 4 : width;
  const edge = boxed ? 2 : 0;
  const wideBox = displayWidth("─") > 1;
  const side = wideBox ? "|" : "│";
  const rows: PanelRender["rows"] = [];
  const fitted = (text: string): string => truncateToWidth(singleLine(text), inner);
  const add = (plain: string, decorated = plain): void => {
    const pad = " ".repeat(Math.max(0, inner - displayWidth(plain)));
    rows.push({
      text: boxed ? paint(`${side} `, style.faint) + decorated + pad + paint(` ${side}`, style.faint) : decorated,
      width: boxed ? width : displayWidth(plain),
    });
  };
  const line = (text: string, tone = ""): void => {
    const plain = fitted(text);
    add(plain, tone ? paint(plain, tone) : plain);
  };
  const border = (top: boolean): void => {
    const plain = (wideBox ? "+" : top ? "╭" : "╰") + (wideBox ? "-" : "─").repeat(width - 2) + (wideBox ? "+" : top ? "╮" : "╯");
    rows.push({ text: paint(plain, style.faint), width });
  };
  if (boxed) border(true);

  const selected = view.selected === undefined || view.rows.length === 0 ? undefined : clamp(view.selected, view.rows.length - 1);
  let budget = height - (boxed ? 2 : 0);
  const showHeader = budget >= 3;
  const showHint = budget >= 3;
  if (showHeader) {
    const active = clamp(view.activeTab, view.tabs.length - 1);
    const names = view.tabs.map(singleLine);
    const label = (name: string, i: number): string => NO_COLOR && i === active ? `[${name}]` : ` ${name} `;
    const colour = (i: number): string => style.tabText + (i === active ? style.accentBackground + style.bold : style.tabBackground);
    const labels = names.map(label);
    const all = labels.join(" ");
    if (displayWidth(all) <= inner) add(all, labels.map((name, i) => paint(name, colour(i))).join(" "));
    else {
      const compact = inner >= 2 ? label(truncateToWidth(names[active] ?? "", inner - 2), active) : fitted(names[active] ?? "");
      add(compact, paint(compact, colour(active)));
    }
    budget -= 1;
  }
  if (showHint) budget -= 1;
  if (view.subtitle && budget >= 4) {
    line(view.subtitle, style.faint);
    budget -= 1;
  }

  // Keep one list/editor row before spending space on explanation. On short
  // terminals decoration disappears before the selected setting or its caret.
  const message = view.message && budget >= 3 ? fitted(view.message) : undefined;
  if (message !== undefined) budget -= 1;
  const detail = selected === undefined ? undefined : view.rows[selected]!.detail;
  const details = detail && budget >= 5 ? wrapToWidth(singleLine(detail), inner).slice(0, Math.min(2, budget - 3)) : [];
  budget -= details.length;

  const editing = view.editing;
  const editor = editing ? renderComposer({
    text: sanitize(editing.draft.text),
    cursor: [...sanitize([...editing.draft.text].slice(0, editing.draft.cursor).join(""))].length,
  }, { width: inner, prompt: "> " }) : undefined;
  const editRows = editor ? Math.min(editor.rows.length, Math.max(1, Math.min(3, budget - (view.rows.length > 0 ? 1 : 0)))) : 0;
  const editLabel = editing && budget - editRows >= 2;
  const listRoom = Math.max(0, budget - editRows - Number(Boolean(editLabel)));
  let offset = clamp(view.offset ?? 0, view.rows.length - listRoom);
  if (selected !== undefined && listRoom > 0) {
    if (selected < offset) offset = selected;
    if (selected >= offset + listRoom) offset = selected - listRoom + 1;
  }
  const labelWidth = Math.min(Math.max(0, ...view.rows.map((row) => displayWidth(singleLine(row.label)))), Math.max(1, Math.floor((inner - 4) / 2)));
  for (const [j, row] of view.rows.slice(offset, offset + listRoom).entries()) {
    const isSelected = selected === offset + j;
    const marker = inner >= 4 ? isSelected ? "❯ " : "  " : "";
    const room = Math.max(0, inner - displayWidth(marker));
    const label = truncateToWidth(singleLine(row.label), row.value === undefined || room < 8 ? room : labelWidth);
    const gap = row.value === undefined || room < 8 ? "" : " ".repeat(Math.max(2, labelWidth - displayWidth(label) + 2));
    const value = gap ? truncateToWidth(singleLine(row.value!), Math.max(0, room - displayWidth(label + gap))) : "";
    const plain = marker + label + gap + value;
    const tone = row.tone === "good" ? style.ok : row.tone === "warn" ? style.warn : row.tone === "bad" ? style.bad : row.tone === "muted" ? style.faint : "";
    add(plain, isSelected ? paint(plain, style.accent) : row.tone === "muted" || (tone && value === "")
      ? paint(plain, tone) : marker + label + gap + (tone ? paint(value, tone) : value));
  }
  if (view.rows.length === 0 && listRoom > 0 && !editing) line("No entries", style.faint);
  for (const detailLine of details) line(detailLine, style.faint);
  if (message !== undefined) line(message, view.error ? style.bad : style.ok);
  let cursor: PanelRender["cursor"] = null;
  if (editing && editor) {
    if (editLabel) line(editing.label, style.accent);
    const start = Math.max(0, Math.min(editor.cursorRow - Math.floor(editRows / 2), editor.rows.length - editRows));
    cursor = { row: rows.length + editor.cursorRow - start, col: Math.min(width - 1, edge + editor.cursorCol) };
    for (const row of editor.rows.slice(start, start + editRows)) add(row.prefix + row.body, paint(row.prefix, style.accent) + row.body);
  }
  if (showHint) line(view.hint, style.faint);
  if (boxed) border(false);
  return { rows, cursor };
}
