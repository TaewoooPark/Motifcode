/**
 * Runtime schema validation.
 *
 * The schemas were documentation until this existed: they shaped the prompt and
 * gave the repair ladder a set of legal key names, and nothing checked an
 * actual call against them. These tests are the cases that used to reach the
 * executor.
 */

import { describe, expect, it } from "vitest";
import { CORE_TOOLS } from "../src/index.js";
import { ToolValidator, formatErrors } from "@motifcode/protocol";

const v = new ToolValidator(CORE_TOOLS);

function errors(name: string, args: unknown): string {
  const r = v.validate(name, args);
  return r.ok ? "" : formatErrors(r.errors);
}

describe("tool validator", () => {
  it("accepts a well-formed call", () => {
    expect(v.validate("bash", { command: "ls" }).ok).toBe(true);
    expect(v.validate("bash", { command: "ls", timeout_s: 30 }).ok).toBe(true);
  });

  it("rejects a tool nobody registered", () => {
    expect(errors("rm_rf", { path: "/" })).toContain("unknown tool");
  });

  it("rejects a missing required argument", () => {
    // `{"name":"bash","arguments":{}}` used to run an empty command.
    expect(errors("bash", {})).toContain("arguments.command: required");
  });

  it("rejects a wrong primitive type instead of coercing it", () => {
    expect(errors("bash", { command: 42 })).toContain("expected a string");
    expect(errors("bash", { command: "ls", timeout_s: "abc" })).toContain("expected a finite number");
  });

  it("rejects NaN and Infinity, which JSON cannot carry but coercion can invent", () => {
    // A NaN timeout is a command that never gets killed.
    expect(errors("bash", { command: "ls", timeout_s: Number.NaN })).toContain("finite");
    expect(errors("bash", { command: "ls", timeout_s: Number.POSITIVE_INFINITY })).toContain("finite");
  });

  it("rejects an undeclared property on a closed schema", () => {
    expect(errors("bash", { command: "ls", sudo: true })).toContain("not declared");
  });

  it("rejects arguments that are not an object at all", () => {
    expect(errors("bash", "ls")).toContain("expected an object");
    expect(errors("bash", ["ls"])).toContain("expected an object");
    expect(errors("bash", null)).toContain("expected an object");
  });

  it("checks the done confirmation flag's type", () => {
    expect(v.validate("done", { summary: "s", confirm: true }).ok).toBe(true);
    expect(errors("done", { summary: "s", confirm: "yes" })).toContain("expected a boolean");
  });

  it("checks term's duration, which the object channel fills in", () => {
    expect(v.validate("term", { keystrokes: "ls\n", duration_s: 0.5 }).ok).toBe(true);
    expect(errors("term", { keystrokes: "ls\n", duration_s: "0.5" })).toContain("finite number");
    expect(errors("term", { keystrokes: "ls\n" })).toContain("duration_s: required");
  });

  it("reports every problem at once rather than the first", () => {
    const r = v.validate("bash", { timeout_s: "x", sudo: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});
