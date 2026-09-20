import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEMES, activeTheme, applyTheme, style, themeNames } from "../src/theme.js";

describe("themes", () => {
  it("swaps the palette in place, so every writer sees the change", () => {
    const before = style.accent;
    expect(applyTheme("claude")).toBe(true);
    expect(activeTheme()).toBe("claude");
    expect(style.accent).toBe(THEMES["claude"]!.palette.accent);
    expect(style.accent).not.toBe(before);
    applyTheme(DEFAULT_THEME);
    expect(style.accent).toBe(before);
  });

  it("refuses an unknown name and changes nothing", () => {
    const before = { ...style };
    expect(applyTheme("neon")).toBe(false);
    expect(style).toEqual(before);
    expect(themeNames()).toContain("mono");
  });
});
