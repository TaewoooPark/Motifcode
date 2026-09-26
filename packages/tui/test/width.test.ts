import { afterEach, describe, expect, it, vi } from "vitest";
import { displayWidth, padToWidth, truncateEndToWidth, truncateToWidth, wrapToWidth, wrapWords } from "../src/width.js";

afterEach(() => vi.unstubAllEnvs());

describe("terminal width policy", () => {
  it.each(["1", "2"])("matches Ambiguous-width=%s without widening combining marks", (policy) => {
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", policy);
    expect(displayWidth("·─…Ωé")).toBe(5 * Number(policy));
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("한글🙂🚀🫠⌚Ａ")).toBe(14);
    expect(displayWidth("ascii")).toBe(5);
  });

  it("defaults to narrow ambiguous characters", () => {
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", undefined);
    expect(displayWidth("·─…Ωé")).toBe(5);
  });

  it("does not emit a two-column ellipsis into a one-column budget", () => {
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", "2");
    for (const truncate of [truncateToWidth, truncateEndToWidth]) {
      expect(truncate("abcdef", 0)).toBe("");
      expect(truncate("abcdef", 1)).toBe("");
      expect(truncate("abcdef", 2)).toBe("…");
      expect(truncate("abcdef", 1, ".")).toBe(".");
    }
    expect(truncateToWidth("abcdef", 4)).toBe("ab…");
    expect(truncateEndToWidth("abcdef", 4)).toBe("…ef");
  });

  it("wraps ambiguous characters using the selected cell width", () => {
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", "2");
    expect(wrapToWidth("aΩb·", 3)).toEqual(["aΩ", "b·"]);
    expect(wrapToWidth("한Ωa", 1)).toEqual(["?", "?", "a"]);
  });

  it("wraps and truncates wide emoji outside the legacy ranges", () => {
    vi.stubEnv("MOTIF_AMBIGUOUS_WIDTH", "1");
    expect(wrapToWidth("a🚀b🫠", 3)).toEqual(["a🚀", "b🫠"]);
    expect(wrapToWidth("🚀", 1)).toEqual(["?"]);
    expect(truncateToWidth("ab🚀", 3)).toBe("ab…");
  });

  it("measures and projects tabs consistently without emitting terminal tab movement", () => {
    expect(displayWidth("a\tb")).toBe(6);
    expect(wrapToWidth("a\tb", 3)).toEqual(["a  ", "  b"]);
    expect(wrapToWidth("\t", 1)).toEqual([" ", " ", " ", " "]);
    expect(truncateToWidth("a\tb", 6)).toBe("a    b");
    expect(truncateToWidth("a\tb", 4)).toBe("a  …");
    expect(truncateEndToWidth("a\tb", 4)).toBe("…  b");
    expect(padToWidth("a\tb", 7)).toBe("a    b ");
  });
});

describe("wrapWords", () => {
  it("breaks prose at spaces and keeps command flags whole", () => {
    const line = "Use motif mcp install gmail --token-env GOOGLE_ACCESS_TOKEN --enable after setup, then restart.";
    const rows = wrapWords(line, 40);
    expect(rows.every((row) => displayWidth(row) <= 40)).toBe(true);
    expect(rows.join(" ")).toBe(line);
    expect(rows.some((row) => row.includes("--token-env"))).toBe(true);
    expect(rows.some((row) => row.startsWith(" "))).toBe(false);
  });
  it("hard-wraps only a word wider than the row and keeps indentation", () => {
    expect(wrapWords("see https://example.test/abcdefghij", 12)).toEqual(["see", "https://exam", "ple.test/abc", "defghij"]);
    expect(wrapWords("  alpha beta gamma", 12)).toEqual(["  alpha beta", "  gamma"]);
  });
});
