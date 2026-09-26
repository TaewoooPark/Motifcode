import { describe, expect, it } from "vitest";
import { configField, parseConfigValue } from "../src/config-controls.js";

const parse = (key: string, raw: string) => parseConfigValue(configField(key)!, raw);

describe("interactive configuration values", () => {
  it("accepts false without treating it as missing, and normalizes documented key aliases", () => {
    expect(parse("thinking", "false")).toBe(false);
    expect(parse("verbose", "true")).toBe(true);
    expect(parse("max-tokens", "2048")).toBe(2048);
    expect(parse("MAX_OUTPUT_TOKENS", "1024")).toBe(1024);
    expect(configField("unknown")).toBeUndefined();
  });

  it("accepts safe integer boundaries and off only where supported", () => {
    expect(parse("seed", "0")).toBe(0);
    expect(parse("seed", String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parse("seed", "off")).toBeUndefined();
    expect(parse("max-tokens", "off")).toBeUndefined();
    expect(() => parse("maxTurns", "off")).toThrow();
    for (const value of ["0", "-1", "1.5", "2e3", "0x10", "Infinity", "NaN", "9007199254740992", ""]) {
      expect(() => parse("max-tokens", value), value).toThrow();
    }
  });

  it("rejects control sequences and enforces endpoint URL boundaries", () => {
    for (const value of ["model\x1b[2J", "foo\nbar", "foo\tbar", "foo\x00bar", "foo\x7fbar"]) {
      expect(() => parse("model", value), JSON.stringify(value)).toThrow();
    }
    for (const value of ["file:///tmp/socket", "https://name:password@api.example", "https://api.example?key=secret", "https://api.example#path", "not a url"]) {
      expect(() => parse("endpoint", value), value).toThrow();
    }
    expect(parse("endpoint", " https://api.example/v1/ ")).toBe("https://api.example");
    expect(parse("endpoint", "http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => parse("model", "x".repeat(2049))).toThrow();
    expect(() => parse("model", " ")).toThrow();
  });

  it("bounds compaction fractions and restricts enum choices", () => {
    expect(parse("compactAt", "0.1")).toBe(0.1);
    expect(parse("compactAt", "1")).toBe(1);
    for (const value of ["", "0", "0.09", "1.01", "NaN", "Infinity"]) {
      expect(() => parse("compactAt", value), value).toThrow();
    }
    expect(() => parse("thinking", "yes")).toThrow();
    expect(() => parse("permissions", "all")).toThrow();
    expect(() => parse("channel", "chat")).toThrow();
  });
});
