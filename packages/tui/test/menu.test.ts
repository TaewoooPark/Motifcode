import { describe, expect, it } from "vitest";
import { clampSelection, commandPrefix, menuItemsFor, renderMenu, type MenuItem } from "../src/menu.js";

const ITEMS: MenuItem[] = [
  { name: "help", description: "commands and keys" },
  { name: "model", description: "show or set the model id", usage: "[id]" },
  { name: "max-tokens", description: "output cap", usage: "[n|off]" },
  { name: "max-turns", description: "turn ceiling", usage: "[n]" },
  { name: "status", description: "settings and totals" },
];

describe("slash menu", () => {
  it("opens on a slash and closes once arguments begin", () => {
    expect(commandPrefix("")).toBeNull();
    expect(commandPrefix("fix it")).toBeNull();
    expect(commandPrefix("/")).toBe("");
    expect(commandPrefix("/Mod")).toBe("mod");
    expect(commandPrefix("/model x")).toBeNull();
  });

  it("filters by prefix, then by substring when nothing starts with the text", () => {
    expect(menuItemsFor("/", ITEMS).map((i) => i.name)).toEqual(ITEMS.map((i) => i.name));
    expect(menuItemsFor("/m", ITEMS).map((i) => i.name)).toEqual(["model", "max-tokens", "max-turns"]);
    expect(menuItemsFor("/tok", ITEMS).map((i) => i.name)).toEqual(["max-tokens"]);
    expect(menuItemsFor("/zzz", ITEMS)).toEqual([]);
  });

  it("wraps the selection", () => {
    expect(clampSelection(-1, 3)).toBe(2);
    expect(clampSelection(3, 3)).toBe(0);
    expect(clampSelection(5, 0)).toBe(0);
  });

  it("renders aligned rows with the selection marked", () => {
    const rows = renderMenu(menuItemsFor("/m", ITEMS), 1, { width: 60 });
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^ {2}❯ \/max-tokens \[n\|off\] {2}output cap$/);
    // Names pad to the widest (`/max-tokens [n|off]`, 19 columns), then two
    // spaces separate the description.
    expect(rows[0]).toMatch(/^ {4}\/model \[id\] {10}show or set/);
  });

  it("windows a long list around the selection", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `c${String(i).padStart(2, "0")}`, description: "d" }));
    const rows = renderMenu(many, 15, { width: 40, maxRows: 5 });
    expect(rows).toHaveLength(5);
    expect(rows.some((r) => r.includes("❯ /c15"))).toBe(true);
  });
});
