/**
 * The slash-command menu.
 *
 * Opens the moment the draft starts with `/`, narrows as the name is typed,
 * and closes once a space follows the name — from then on the user is typing
 * arguments and a list under the cursor would only be in the way. Claude Code
 * and Codex both settled on that shape, and for the same reason: the menu is
 * for finding the command, not for reading its manual.
 *
 * Pure. The controller owns the selection index and hands it back in; the
 * renderer returns plain rows and the writer colours the selected one.
 */

import { displayWidth, padToWidth, truncateToWidth } from "./width.js";

export interface MenuItem {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** Argument hint, shown after the name: `[id]`, `<file>`. */
  usage?: string;
}

/** The typed command name, or null when the draft is not naming a command. */
export function commandPrefix(text: string): string | null {
  if (!text.startsWith("/")) return null;
  if (/\s/.test(text)) return null;
  return text.slice(1).toLowerCase();
}

/**
 * Items matching the draft.
 *
 * Prefix matches first, because that is what a person typing a name means;
 * substring matches only when nothing starts with what was typed, so a
 * half-remembered `tok` still finds `max-tokens`.
 */
export function menuItemsFor(text: string, all: readonly MenuItem[]): MenuItem[] {
  const prefix = commandPrefix(text);
  if (prefix === null) return [];
  const starts = all.filter((i) => i.name.startsWith(prefix));
  if (starts.length > 0) return starts;
  return all.filter((i) => i.name.includes(prefix));
}

export function clampSelection(selected: number, count: number): number {
  if (count === 0) return 0;
  return ((selected % count) + count) % count;
}

export interface MenuRenderOptions {
  width: number;
  /** Rows shown at once; the window follows the selection. */
  maxRows?: number;
  /** What precedes each name: `/` for commands, `@` for mentions. */
  prefix?: string;
}

const DEFAULT_ROWS = 8;

export interface MenuRender {
  /** One row per visible item; the window follows the selection. */
  rows: string[];
  /** Index of the selected row within `rows`, so a highlight lands on the marked row. */
  selectedRow: number;
}

/**
 * The visible window of the menu.
 *
 * The marker and the highlight have to agree, and they used to drift: the
 * marker was placed by the selection's index in the whole list, the highlight
 * by that same index inside the window — right until the list scrolled.
 * Both now come from here, as one number.
 */
export function renderMenu(items: readonly MenuItem[], selected: number, opts: MenuRenderOptions): MenuRender {
  if (items.length === 0) return { rows: [], selectedRow: -1 };
  const maxRows = opts.maxRows ?? DEFAULT_ROWS;
  const sel = clampSelection(selected, items.length);
  const start = Math.max(0, Math.min(sel - Math.floor(maxRows / 2), items.length - maxRows));
  const window = items.slice(start, start + maxRows);
  const prefix = opts.prefix ?? "/";
  const label = (i: MenuItem): string => `${prefix}${i.name}${i.usage ? ` ${i.usage}` : ""}`;
  // Names wider than half the screen are cut, so a deep path cannot push the
  // description off the edge.
  const nameWidth = Math.min(Math.max(...window.map((i) => displayWidth(label(i)))), Math.max(12, Math.floor(opts.width / 2)));
  const room = Math.max(8, opts.width - 4 - nameWidth - 2);
  const rows = window.map((item, i) => {
    const marker = start + i === sel ? "❯ " : "  ";
    const name = padToWidth(truncateToWidth(label(item), nameWidth), nameWidth);
    return `  ${marker}${name}  ${truncateToWidth(item.description, room)}`;
  });
  return { rows, selectedRow: sel - start };
}
