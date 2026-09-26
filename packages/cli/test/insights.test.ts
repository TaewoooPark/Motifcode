import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectInsights, statsRows, usageRows } from "../src/insights.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const directories: string[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "motif-insights-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(runId: string, started = NOW - 60_000, model = "motif/motif-3") {
  const lines: unknown[] = [{ t: "header", header: { schemaVersion: 2, runId, startedAt: new Date(started).toISOString(), model: { id: model } } }];
  let seq = 0;
  return {
    record(record: unknown, scope = "root", at = started + (seq + 1) * 1000) {
      lines.push({ v: 2, seq: ++seq, at: new Date(at).toISOString(), runId, scopeId: scope, scopeKind: scope === "root" ? "root" : "subagent", record });
    },
    event(event: unknown, scope = "root") { this.record({ t: "event", event }, scope); },
    end(reason: string, scope = "root", at?: number) { this.record({ t: "scope_end", result: { endReason: reason, turns: 999 } }, scope, at); },
    text: () => lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    save(dir: string, name = `${runId}.jsonl`, suffix = "") {
      const path = join(dir, name);
      writeFileSync(path, this.text() + suffix);
      return path;
    },
  };
}

describe("local journal insights", () => {
  it("counts root and child events exactly once while only the root ending determines the outcome", () => {
    const dir = directory();
    const run = fixture("parent");
    run.record({ t: "scope_start", task: "task", initialMessages: [] });
    run.event({ type: "session_start", model: "motif/motif-3" });
    run.event({ type: "turn_start", turn: 1 });
    run.event({ type: "usage", promptTokens: 100, completionTokens: 20, cachedTokens: 80, contextTokens: 8000, kvBytes: 999, requestMs: 500 });
    run.event({ type: "tool_start", call: { id: "root-1", name: "task" } });
    run.record({ t: "scope_start", task: "child", initialMessages: [] }, "child");
    run.event({ type: "session_start", model: "child-model" }, "child");
    run.event({ type: "turn_start", turn: 1 }, "child");
    run.event({ type: "usage", promptTokens: 50, completionTokens: 10, cachedTokens: 0, contextTokens: 4000, requestMs: 100 }, "child");
    run.event({ type: "tool_start", call: { id: "child-1", name: "read" } }, "child");
    run.event({ type: "tool_end", id: "child-1", ok: true, ms: 5 }, "child");
    run.event({ type: "session_end", reason: "done" }, "child");
    run.end("done", "child");
    run.record({ t: "checkpoint", state: { turn: 999, toolCalls: 999, usage: { promptTokens: 99999 } } });
    run.event({ type: "session_end", reason: "transport_error" });
    run.end("transport_error", "root", NOW - 20_000);
    run.save(dir);

    const data = collectInsights(dir, { now: NOW });
    expect(data).toMatchObject({ sessions: 1, completed: 0, errors: 1, turns: 2, toolCalls: 2, durationMs: 40_000, recentSessions: 1 });
    expect(data.usage).toMatchObject({ events: 2, promptTokens: 150, completionTokens: 30, cachedTokens: 80, pairedPromptTokens: 150 });
    expect(data.models.find((m) => m.model === "child-model")).toMatchObject({ sessions: 1, turns: 1, toolCalls: 1, promptTokens: 50 });
    expect(usageRows(data).find((r) => r.label === "Cache ratio")?.value).toBe("53.3%");
    expect(statsRows(data).find((r) => r.label === "Completed")?.detail).toContain("not a test");
  });

  it("keeps active, aborted, failed, limited and unended root runs separate", () => {
    const dir = directory();
    for (const reason of ["done", "aborted", "transport_error", "turn_limit", "loop_detected", "breakage_limit", "no_action_limit"]) {
      const run = fixture(reason);
      run.event({ type: "turn_start", turn: 1 });
      run.end(reason);
      run.save(dir);
    }
    const active = fixture("active");
    active.event({ type: "turn_start", turn: 1 });
    const activePath = active.save(dir);
    const lost = fixture("lost");
    lost.end("done", "child");
    lost.save(dir);
    const data = collectInsights(dir, { now: NOW, activePath });
    expect(data).toMatchObject({ sessions: 9, completed: 1, active: 1, interrupted: 1, errors: 1, stopped: 4, unfinished: 1, partialDurations: 2 });
  });

  it("distinguishes absent usage from zero counts and uses only paired cache reports", () => {
    const dir = directory();
    const run = fixture("partial");
    run.event({ type: "turn_start", turn: 1 });
    run.event({ type: "usage", contextTokens: 999999, requestMs: 1 });
    run.event({ type: "usage", promptTokens: 100, completionTokens: 0, cachedTokens: 80 });
    run.event({ type: "usage", promptTokens: 900, completionTokens: 5 });
    run.event({ type: "usage", cachedTokens: 5 });
    run.end("done");
    run.save(dir);
    const data = collectInsights(dir, { now: NOW });
    expect(data.usage).toMatchObject({ events: 4, promptTokens: 1000, completionTokens: 5, cachedTokens: 85, promptReports: 2, completionReports: 2, pairedReports: 1 });
    expect(usageRows(data).find((r) => r.label === "Cache ratio")).toMatchObject({ value: "80.0%", detail: expect.stringContaining("1/4 events") });
    const empty = collectInsights(join(dir, "missing"), { now: NOW });
    expect(usageRows(empty).find((r) => r.label === "Prompt tokens")?.value).toBe("Not reported");
    expect(usageRows(empty).find((r) => r.label === "Reported cost")?.value).toBe("Not reported");
    expect(usageRows(empty).find((r) => r.label === "API quota / billing")).toBeUndefined();
  });

  it("counts server-reported root and child costs once, preserves zero, and shows local coverage", () => {
    const dir = directory();
    const run = fixture("costs");
    run.event({ type: "session_start", model: "motif/motif-3" });
    run.event({ type: "usage", reportedCost: { provider: "infron", unit: "credits", amount: 0.1, details: { prompt_cost: 0.1 } } });
    run.event({ type: "session_start", model: "child-model" }, "child");
    run.event({ type: "usage", reportedCost: { provider: "infron", unit: "credits", amount: 0.2, details: { completion_cost: 0.2 } } }, "child");
    run.event({ type: "usage", reportedCost: { provider: "infron", unit: "credits", amount: 0 } });
    run.event({ type: "usage", promptTokens: 100 });
    run.record({ t: "checkpoint", state: { reportedCost: { provider: "infron", unit: "credits", amount: 999 } } });
    run.end("done");
    run.save(dir);
    run.save(dir, "copy.jsonl");

    const data = collectInsights(dir);
    expect(data.files.duplicate).toBe(1);
    expect(data.usage.cost).toMatchObject({ provider: "infron", unit: "credits", reports: 3, invalidReports: 0, otherReports: 0, overflow: false });
    expect(data.usage.cost.amount).toBeCloseTo(0.3);
    expect(data.models.find((model) => model.model === "child-model")?.cost).toMatchObject({ amount: 0.2, reports: 1 });
    const rows = usageRows(data);
    expect(rows.find((row) => row.label === "Reported cost")).toMatchObject({ value: "0.3 credits", detail: expect.stringContaining("not account-wide") });
    expect(rows.find((row) => row.label === "Cost coverage")).toMatchObject({ value: "3/4 usage events", detail: expect.stringContaining("not estimated") });
    expect(rows.find((row) => row.label === "child-model")?.detail).toContain("cost 0.2 credits (1/1 events");
  });

  it("distinguishes zero cost from historical usage without cost and ignores cost detail subtotals", () => {
    const dir = directory();
    const run = fixture("zero");
    run.event({ type: "usage", promptTokens: 10 });
    run.save(dir);
    expect(usageRows(collectInsights(dir)).find((row) => row.label === "Reported cost")?.value).toBe("Not reported");
    // The amount is valid even if a historical detail object is not; details are never summed.
    run.event({ type: "usage", reportedCost: { provider: "infron", unit: "credits", amount: 0, details: { prompt_cost: "invalid", total_cost: 100 } } });
    run.save(dir);
    const data = collectInsights(dir);
    expect(data.usage.cost).toMatchObject({ amount: 0, reports: 1, invalidReports: 0 });
    expect(usageRows(data).find((row) => row.label === "Reported cost")?.value).toBe("0 credits");
    expect(usageRows(data).find((row) => row.label === "Cost coverage")?.value).toBe("1/2 usage events");
  });

  it("excludes malformed costs and separates unrecognized providers and units", () => {
    const dir = directory();
    const run = fixture("invalid-costs");
    for (const reportedCost of [
      null, 12, [], {},
      { provider: "infron", unit: "credits", amount: -1 },
      { provider: "infron", unit: "credits", amount: "0.2" },
      { provider: "infron", unit: "credits", amount: null },
      { provider: "infron", unit: "usd", amount: 100 },
      { provider: "other", unit: "credits", amount: 200 },
      { provider: "infron", unit: "credits", amount: 0.125 },
    ]) run.event({ type: "usage", reportedCost });
    run.event({ type: "usage", reportedCost: { provider: "infron", unit: "credits", amount: "INFINITE" } });
    // JSON allows a numeric exponent outside the finite JavaScript range.
    writeFileSync(join(dir, "invalid-costs.jsonl"), run.text().replace('"INFINITE"', "1e999"));
    const data = collectInsights(dir);
    expect(data.usage.cost).toMatchObject({ amount: 0.125, reports: 1, invalidReports: 8, otherReports: 2 });
    expect(usageRows(data).find((row) => row.label === "Excluded cost records")).toMatchObject({ value: "10", detail: expect.stringContaining("2 other providers or units") });
    expect(usageRows(data).find((row) => row.label === "Reported cost")?.value).toBe("0.125 credits");
  });

  it("never presents an overflowing total as Infinity or a tiny positive charge as free", () => {
    const dir = directory();
    const run = fixture("large-costs");
    run.event({ type: "usage", reportedCost: { provider: "infron", unit: "credits", amount: Number.MAX_VALUE } });
    run.event({ type: "usage", reportedCost: { provider: "infron", unit: "credits", amount: Number.MAX_VALUE } });
    run.event({ type: "session_start", model: "tiny-model" }, "child");
    run.event({ type: "usage", reportedCost: { provider: "infron", unit: "credits", amount: 0.000000001 } }, "child");
    run.save(dir);
    const data = collectInsights(dir);
    expect(data.usage.cost).toMatchObject({ reports: 3, overflow: true });
    expect(Number.isFinite(data.usage.cost.amount)).toBe(true);
    const rows = usageRows(data);
    expect(rows.find((row) => row.label === "Reported cost")).toMatchObject({ value: "Unavailable (total overflow)", tone: "warn" });
    expect(rows.find((row) => row.label === "tiny-model")?.detail).toContain("cost <0.00000001 credits");
    expect(JSON.stringify(rows)).not.toContain("Infinity");
  });

  it("ignores invalid token values instead of reporting negative counts or cache rates over 100%", () => {
    const dir = directory();
    const run = fixture("invalid-usage");
    run.event({ type: "usage", promptTokens: 10, completionTokens: -3, cachedTokens: 20 });
    run.event({ type: "usage", promptTokens: "50", completionTokens: 1.5, cachedTokens: null });
    run.end("done");
    run.save(dir);
    const data = collectInsights(dir);
    expect(data.usage).toMatchObject({ promptTokens: 10, promptReports: 1, completionReports: 0, cachedReports: 0, invalidReports: 5 });
    expect(usageRows(data).find((r) => r.label === "Cache ratio")?.value).toBe("Unavailable");
    expect(usageRows(data).find((r) => r.label === "Invalid usage fields")?.value).toBe("5");
  });

  it("includes a truncated final line, but excludes corrupt middle records and malformed envelopes explicitly", () => {
    const dir = directory();
    const truncated = fixture("truncated");
    truncated.event({ type: "usage", promptTokens: 12 });
    truncated.save(dir, undefined, '{"v":2');
    const corrupt = fixture("corrupt");
    corrupt.event({ type: "usage", promptTokens: 9999 });
    corrupt.save(dir, undefined, 'not-json\n{}\n');
    writeFileSync(join(dir, "null.jsonl"), "null\n");
    const invalid = fixture("invalid");
    invalid.record(null);
    invalid.save(dir);
    const repeated = fixture("repeated");
    repeated.event({ type: "turn_start", turn: 1 });
    const text = repeated.text();
    writeFileSync(join(dir, "repeated.jsonl"), text + text.split("\n")[1] + "\n");
    const data = collectInsights(dir);
    expect(data).toMatchObject({ sessions: 1, unfinished: 1, usage: { promptTokens: 12 }, files: { corrupt: 4, truncated: 1 } });
    expect(statsRows(data).find((r) => r.label === "Skipped journals")?.value).toBe("4");
    expect(usageRows(data).find((r) => r.label === "Partial journals")?.value).toBe("1");
  });

  it("deduplicates copied run IDs, preferring the active journal or newest saved copy", () => {
    const dir = directory();
    const run = fixture("same-run");
    run.event({ type: "turn_start", turn: 1 });
    const activePath = run.save(dir, "original.jsonl");
    utimesSync(activePath, new Date(NOW - 10000), new Date(NOW - 10000));
    run.end("done");
    const copy = run.save(dir, "copy.jsonl");
    utimesSync(copy, new Date(NOW), new Date(NOW));
    expect(collectInsights(dir, { now: NOW })).toMatchObject({ sessions: 1, completed: 1, turns: 1, files: { duplicate: 1 } });
    expect(collectInsights(dir, { now: NOW, activePath })).toMatchObject({ sessions: 1, completed: 0, active: 1, turns: 1, files: { duplicate: 1 } });
  });

  it("uses start timestamps for the seven-day window and exposes unavailable durations", () => {
    const dir = directory();
    for (const [name, start] of [["boundary", NOW - 7 * 86400000], ["old", NOW - 7 * 86400000 - 1], ["future", NOW + 1000]] as const) {
      const run = fixture(name, start);
      run.end("done", "root", start + 1000);
      run.save(dir);
    }
    const invalid = fixture("invalid-time");
    invalid.end("done");
    writeFileSync(join(dir, "invalid-time.jsonl"), invalid.text().replace(/"startedAt":"[^"]+"/, '"startedAt":"invalid"'));
    const data = collectInsights(dir, { now: NOW });
    expect(data).toMatchObject({ sessions: 4, recentSessions: 1, timedSessions: 3, durationMs: 3000 });
    expect(statsRows(data).find((r) => r.label === "Observed runtime")?.detail).toContain("3/4 runs");
  });

  it("bounds files and oversized reads and reports partial totals", () => {
    const dir = directory();
    for (let i = 0; i < 201; i++) {
      const run = fixture(`run-${i}`);
      run.end("done");
      run.save(dir);
    }
    const oversized = join(dir, "oversized.jsonl");
    const fd = openSync(oversized, "w");
    ftruncateSync(fd, 8 * 1024 * 1024 + 1);
    closeSync(fd);
    utimesSync(oversized, new Date(NOW + 86400000), new Date(NOW + 86400000));
    const data = collectInsights(dir);
    expect(data.sessions).toBe(199);
    expect(data.files).toMatchObject({ found: 202, read: 199, oversized: 1, limited: 2 });
    expect(statsRows(data).find((r) => r.label === "Read limits")).toMatchObject({ value: "Partial totals", tone: "warn" });
  });
});
