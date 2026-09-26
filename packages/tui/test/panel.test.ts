import xterm from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPanel, type PanelView } from "../src/panel.js";
import { Screen } from "../src/screen.js";
import { term } from "../src/theme.js";
import { displayWidth } from "../src/width.js";

const strip = (text: string): string => text.replace(/\x1b\[[\d;]*m/g, "");
const panel = (extra: Partial<PanelView> = {}): PanelView => ({
  tabs: ["Config", "Status", "Stats", "Usage"], activeTab: 0,
  subtitle: "Settings for this session",
  rows: Array.from({ length: 30 }, (_, i) => ({ label: `Setting ${i}`, value: `value ${i}`, detail: `Detail for setting ${i}` })),
  selected: 0, hint: "↑↓ select · enter edit · esc close", ...extra,
});
const plainRows = (view: PanelView, width = 60, height = 12): string[] => renderPanel(view, { width, height }).rows.map((r) => strip(r.text));

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("session panel layout", () => {
  it("keeps a selected setting and its description visible instead of showing the list tail", () => {
    const initial = plainRows(panel());
    expect(initial.join("\n")).toContain("❯ Setting 0");
    expect(initial.join("\n")).not.toContain("Setting 29");
    const selected = plainRows(panel({ selected: 25 }));
    expect(selected.join("\n")).toContain("❯ Setting 25");
    expect(selected.join("\n")).toContain("Detail for setting 25");
    expect(selected.join("\n")).toMatch(/Config\W+Status\W+Stats\W+Usage/);
    expect(selected.join("\n")).toContain("esc close");
  });

  it("scrolls read-only readings from the requested offset", () => {
    const view = panel({ selected: undefined, activeTab: 1 });
    expect(plainRows(view, 40, 8).join("\n")).toContain("Setting 0");
    const scrolled = plainRows({ ...view, offset: 10 }, 40, 8).join("\n");
    expect(scrolled).toContain("Setting 10");
    expect(scrolled).not.toContain("Setting 0");
    expect(scrolled).not.toContain("Setting 29");
  });

  it("keeps editing text and its caret visible across wraps and multiline input", () => {
    const text = "very-long-model/한글🙂\nother/model";
    const view = panel({ editing: { label: "Model", draft: { text, cursor: [...text].length } } });
    const result = renderPanel(view, { width: 20, height: 9 });
    expect(result.cursor).not.toBeNull();
    expect(result.cursor!.row).toBeLessThan(result.rows.length);
    expect(result.cursor!.col).toBeLessThan(20);
    expect(result.rows.map((row) => strip(row.text)).join("\n")).toContain("other/model");
    expect(view.editing!.draft.text).toBe(text);
  });

  it("bounds every physical row and editing caret in small viewports", () => {
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", "2");
    for (const width of [1, 2, 3, 7, 8, 20, 80]) for (const height of [0, 1, 2, 3, 6, 12]) {
      const result = renderPanel(panel({ selected: 20, message: "Saved Ω·한", editing: { label: "Model", draft: { text: "Ω·한\tmodel\nnext", cursor: 7 } } }), { width, height });
      expect(result.rows.length, `${width}x${height}`).toBeLessThanOrEqual(height);
      for (const row of result.rows) {
        expect(displayWidth(strip(row.text)), `${width}x${height}: ${strip(row.text)}`).toBeLessThanOrEqual(width);
        expect(strip(row.text)).not.toMatch(/[\t\r\n]/);
      }
      if (result.cursor) {
        expect(result.cursor.row).toBeGreaterThanOrEqual(0);
        expect(result.cursor.row).toBeLessThan(result.rows.length);
        expect(result.cursor.col).toBeGreaterThanOrEqual(0);
        expect(result.cursor.col).toBeLessThan(width);
      }
    }
  });

  it("renders external labels and values as inert text", () => {
    const result = renderPanel(panel({ rows: [{ label: "label\nline", value: "\x1b[2J\tvalue", detail: "detail\rhidden" }], message: "\x1b]0;title\x07", error: true }), { width: 80, height: 12 });
    const plain = result.rows.map((r) => strip(r.text)).join("\n");
    expect(plain).toContain("label line");
    expect(plain).toContain("^[[2J");
    expect(plain).toContain("^M");
    expect(plain).not.toContain("\x1b");
  });

  it("uses no colour when NO_COLOR is set", async () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.resetModules();
    const { renderPanel: renderPlain } = await import("../src/panel.js");
    const result = renderPlain(panel({ message: "Invalid value", error: true }), { width: 80, height: 12 });
    expect(result.rows.map((row) => row.text).join("\n")).not.toContain("\x1b");
  });
});

describe("panel on the physical screen", () => {
  it("keeps the caret hidden on read-only panels while the work dot blinks", async () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("TERM", "xterm-256color");
    vi.resetModules();
    const { Screen: ColourScreen } = await import("../src/screen.js");
    const chunks: string[] = [];
    const screen = new ColourScreen({ write: (text) => chunks.push(text), columns: () => 60, rows: () => 16, interactive: true });
    vi.useFakeTimers();
    try {
      screen.setComposer({ draft: { text: "saved", cursor: 0 }, panel: panel({ activeTab: 1, selected: undefined }) });
      screen.setWorking(true);
      chunks.length = 0;
      vi.advanceTimersByTime(1000);
      expect(chunks.join("")).toContain("Working…");
      expect(chunks.join("")).toContain(term.hideCursor);
      expect(chunks.join("")).not.toContain(term.showCursor);
      expect(chunks.join("")).not.toContain("\n");
    } finally { screen.finish(); }
  });

  it("replaces the draft, restores it on close, and defers to confirmation and secrets", async () => {
    const terminal = new xterm.Terminal({ cols: 60, rows: 16, allowProposedApi: true });
    const chunks: string[] = [];
    const screen = new Screen({ write: (text) => chunks.push(text), columns: () => 60, rows: () => 16, interactive: true });
    const flush = async (): Promise<string> => {
      const output = chunks.splice(0).join("");
      await new Promise<void>((resolve) => terminal.write(output, resolve));
      return Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)!.translateToString(true)).join("\n");
    };
    const draft = { text: "UNSENT_DRAFT", cursor: 4 };
    try {
      screen.setComposer({ draft, panel: panel() });
      expect(chunks.join("")).toContain(term.hideCursor);
      expect(chunks.join("")).not.toContain(term.showCursor);
      let visible = await flush();
      expect(visible).toContain("Config");
      expect(visible).not.toContain("UNSENT_DRAFT");
      screen.setComposer({ draft, panel: panel(), confirm: { title: "Permission", lines: ["Run?"], choices: ["❯ Yes", "No"] } });
      visible = await flush();
      expect(visible).toContain("Permission");
      expect(visible).not.toContain("Setting 0");
      screen.setComposer({ draft, panel: panel(), secret: { title: "Login", lines: [], prompt: "key: " } });
      visible = await flush();
      expect(visible).toContain("Login");
      expect(visible).not.toContain("UNSENT_DRAFT");
      expect(visible).not.toContain("Setting 0");
      screen.setComposer({ draft });
      visible = await flush();
      expect(visible).toContain("UNSENT_DRAFT");
      expect(terminal.buffer.active.cursorX).toBe(8);
    } finally { screen.finish(); terminal.dispose(); }
  });

  it("follows the editing caret and selected setting after resize", async () => {
    let cols = 60;
    let rows = 16;
    const terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true });
    const chunks: string[] = [];
    const screen = new Screen({ write: (text) => chunks.push(text), columns: () => cols, rows: () => rows, interactive: true });
    const view = { draft: { text: "saved draft", cursor: 0 }, panel: panel({ selected: 25, editing: { label: "Model", draft: { text: "한글model", cursor: 2 } } }) };
    try {
      for (const size of [[60, 16], [20, 8], [8, 6], [60, 16]]) {
        [cols, rows] = size as [number, number];
        terminal.resize(cols, rows);
        screen.setComposer(view);
        await new Promise<void>((resolve) => terminal.write(chunks.splice(0).join(""), resolve));
        const buffer = terminal.buffer.active;
        expect(buffer.cursorX).toBeLessThan(cols);
        expect(buffer.cursorY).toBeLessThan(rows);
        expect(buffer.getLine(buffer.baseY + buffer.cursorY)!.getCell(buffer.cursorX)!.getChars()).toBe("m");
        for (let i = buffer.baseY; i < buffer.length; i++) expect(buffer.getLine(i)!.isWrapped).toBe(false);
      }
    } finally { screen.finish(); terminal.dispose(); }
  });
});
