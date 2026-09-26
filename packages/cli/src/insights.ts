/** Local journal facts, not provider quotas or a claim that completed work passed tests. */
import { closeSync, fstatSync, openSync, opendirSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseJournal, type JournalEnvelopeV2, type ParsedJournal } from "@motifcode/journal";

export interface InsightRow {
  label: string;
  value?: string;
  detail?: string;
  tone?: "normal" | "muted" | "good" | "warn" | "bad";
}

export interface ReportedCostInsights {
  provider: "infron";
  unit: "credits";
  /** Finite subtotal; unavailable as a total when overflow is true. */
  amount: number;
  reports: number;
  invalidReports: number;
  otherReports: number;
  overflow: boolean;
}

interface TokenUsage {
  events: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  promptReports: number;
  completionReports: number;
  cachedReports: number;
  pairedPromptTokens: number;
  pairedCachedTokens: number;
  pairedReports: number;
  invalidReports: number;
  cost: ReportedCostInsights;
}

export interface ModelInsights extends TokenUsage {
  model: string;
  sessions: number;
  turns: number;
  toolCalls: number;
}

export interface Insights {
  sessions: number;
  completed: number;
  active: number;
  interrupted: number;
  errors: number;
  stopped: number;
  unfinished: number;
  turns: number;
  toolCalls: number;
  recentSessions: number;
  durationMs: number;
  timedSessions: number;
  /** Durations of active/incomplete runs are observed spans, not final runtimes. */
  partialDurations: number;
  usage: TokenUsage;
  models: ModelInsights[];
  files: {
    found: number;
    read: number;
    corrupt: number;
    truncated: number;
    unreadable: number;
    duplicate: number;
    oversized: number;
    limited: number;
    scanLimited: boolean;
  };
}

// Synchronous commands must remain bounded even when checkpoints contain large transcripts.
const MAX_ENTRIES = 10_000;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const emptyUsage = (): TokenUsage => ({
  events: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
  promptReports: 0, completionReports: 0, cachedReports: 0,
  pairedPromptTokens: 0, pairedCachedTokens: 0, pairedReports: 0, invalidReports: 0,
  cost: { provider: "infron", unit: "credits", amount: 0, reports: 0, invalidReports: 0, otherReports: 0, overflow: false },
});
const tokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function addReportedCost(total: ReportedCostInsights, raw: unknown): void {
  if (raw === undefined) return;
  if (!object(raw) || typeof raw.provider !== "string" || !raw.provider || typeof raw.unit !== "string" || !raw.unit ||
      typeof raw.amount !== "number" || !Number.isFinite(raw.amount) || raw.amount < 0) {
    total.invalidReports++;
    return;
  }
  if (raw.provider !== total.provider || raw.unit !== total.unit) {
    total.otherReports++;
    return;
  }
  // Details describe the same charge; adding them would count the cost twice.
  // Only the validated total amount is used, including for older malformed detail objects.
  total.reports++;
  const sum = total.amount + raw.amount;
  if (Number.isFinite(sum)) total.amount = sum;
  else total.overflow = true;
}

/** Validate fields used below; malformed JSON objects must not crash an interactive command. */
function usable(parsed: ParsedJournal): boolean {
  const h = parsed.header;
  if (parsed.corruption || !h || h.schemaVersion !== 2 || typeof h.runId !== "string" || !h.runId ||
      typeof h.startedAt !== "string" || !object(h.model) || typeof h.model.id !== "string") return false;
  const roots = new Set<string>();
  for (const r of parsed.records) {
    if (typeof r.scopeId !== "string" || !r.scopeId || !["root", "subagent"].includes(r.scopeKind) ||
        typeof r.at !== "string" || !object(r.record) || typeof r.record.t !== "string") return false;
    if (r.scopeKind === "root") roots.add(r.scopeId);
    if (r.record.t === "event" && (!object(r.record.event) || typeof r.record.event.type !== "string")) return false;
    if (r.record.t === "scope_end" && (!object(r.record.result) || typeof r.record.result.endReason !== "string")) return false;
  }
  return roots.size <= 1;
}

function addUsage(total: TokenUsage, event: Extract<JournalEnvelopeV2["record"], { t: "event" }>["event"]): void {
  if (event.type !== "usage") return;
  total.events++;
  addReportedCost(total.cost, "reportedCost" in event ? event.reportedCost : undefined);
  const prompt = tokenCount(event.promptTokens) ? event.promptTokens : undefined;
  const completion = tokenCount(event.completionTokens) ? event.completionTokens : undefined;
  // A cache count greater than its known prompt total is inconsistent, not a cache hit rate above 100%.
  const cached = tokenCount(event.cachedTokens) && (prompt === undefined || event.cachedTokens <= prompt) ? event.cachedTokens : undefined;
  for (const [raw, valid] of [[event.promptTokens, prompt], [event.completionTokens, completion], [event.cachedTokens, cached]]) {
    if (raw !== undefined && valid === undefined) total.invalidReports++;
  }
  if (prompt !== undefined) { total.promptTokens += prompt; total.promptReports++; }
  if (completion !== undefined) { total.completionTokens += completion; total.completionReports++; }
  if (cached !== undefined) { total.cachedTokens += cached; total.cachedReports++; }
  if (prompt !== undefined && cached !== undefined) {
    total.pairedPromptTokens += prompt;
    total.pairedCachedTokens += cached;
    total.pairedReports++;
  }
}

/** Each journal run is counted once; checkpoints and scope summaries do not duplicate its events. */
export function collectInsights(journalDir: string, opts: { now?: number; activePath?: string } = {}): Insights {
  const now = opts.now ?? Date.now();
  const activePath = opts.activePath ? resolve(opts.activePath) : undefined;
  const result: Insights = {
    sessions: 0, completed: 0, active: 0, interrupted: 0, errors: 0, stopped: 0, unfinished: 0,
    turns: 0, toolCalls: 0, recentSessions: 0, durationMs: 0, timedSessions: 0, partialDurations: 0,
    usage: emptyUsage(), models: [],
    files: { found: 0, read: 0, corrupt: 0, truncated: 0, unreadable: 0, duplicate: 0, oversized: 0, limited: 0, scanLimited: false },
  };
  const candidates: { path: string; mtime: number }[] = [];
  try {
    const dir = opendirSync(journalDir);
    try {
      let count = 0;
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++count > MAX_ENTRIES) { result.files.scanLimited = true; break; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        result.files.found++;
        const path = join(journalDir, entry.name);
        try { candidates.push({ path, mtime: statSync(path).mtimeMs }); }
        catch { result.files.unreadable++; }
      }
    } finally { dir.closeSync(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.files.unreadable++;
    return result;
  }
  candidates.sort((a, b) => Number(resolve(b.path) === activePath) - Number(resolve(a.path) === activePath) || b.mtime - a.mtime || a.path.localeCompare(b.path));
  result.files.limited = Math.max(0, candidates.length - MAX_FILES);
  const seen = new Set<string>();
  const models = new Map<string, ModelInsights>();
  let bytes = 0;
  for (const { path } of candidates.slice(0, MAX_FILES)) {
    let text: string;
    try {
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        if (size > MAX_FILE_BYTES) { result.files.oversized++; continue; }
        if (bytes + size > MAX_TOTAL_BYTES) { result.files.limited++; continue; }
        // Read the snapshot size only: an active journal can keep growing while it is inspected.
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const n = readSync(fd, buffer, offset, size - offset, offset);
          if (n === 0) break;
          offset += n;
        }
        bytes += offset;
        text = buffer.subarray(0, offset).toString("utf8");
      } finally { closeSync(fd); }
    } catch { result.files.unreadable++; continue; }
    result.files.read++;
    let parsed: ParsedJournal;
    try { parsed = parseJournal(text); }
    catch { result.files.corrupt++; continue; }
    if (!usable(parsed)) { result.files.corrupt++; continue; }
    const header = parsed.header!;
    if (seen.has(header.runId)) { result.files.duplicate++; continue; }
    seen.add(header.runId);
    result.sessions++;
    if (parsed.truncatedTail) result.files.truncated++;
    const root = parsed.records.find((r) => r.scopeKind === "root")?.scopeId;
    const roots = parsed.records.filter((r) => r.scopeId === root);
    const ending = roots.findLast((r) => r.record.t === "scope_end");
    const active = resolve(path) === activePath;
    if (active) result.active++;
    else if (!ending || ending.record.t !== "scope_end") result.unfinished++;
    else {
      switch (ending.record.result.endReason) {
        case "done": result.completed++; break;
        case "aborted": result.interrupted++; break;
        case "transport_error": result.errors++; break;
        default: result.stopped++; break;
      }
    }
    const started = Date.parse(header.startedAt);
    if (started >= now - WEEK_MS && started <= now) result.recentSessions++;
    const ended = active ? now : Date.parse(ending?.at ?? parsed.records.at(-1)?.at ?? "");
    if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
      result.durationMs += ended - started;
      result.timedSessions++;
      if (active || !ending) result.partialDurations++;
    }
    const scopeModels = new Map<string, string>();
    const sessionModels = new Set<string>();
    const modelFor = (name: string): ModelInsights => {
      let model = models.get(name);
      if (!model) { model = { model: name, sessions: 0, turns: 0, toolCalls: 0, ...emptyUsage() }; models.set(name, model); }
      if (!sessionModels.has(name)) { model.sessions++; sessionModels.add(name); }
      return model;
    };
    modelFor(header.model.id);
    for (const r of parsed.records) {
      if (r.record.t !== "event") continue;
      const event = r.record.event;
      if (event.type === "session_start" && typeof event.model === "string") scopeModels.set(r.scopeId, event.model);
      const model = modelFor(scopeModels.get(r.scopeId) ?? header.model.id);
      if (event.type === "turn_start") { result.turns++; model.turns++; }
      if (event.type === "tool_start") { result.toolCalls++; model.toolCalls++; }
      addUsage(result.usage, event);
      addUsage(model, event);
    }
  }
  result.models = [...models.values()].sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
  return result;
}

const number = (n: number): string => n.toLocaleString("en-US");
function reportedCost(cost: ReportedCostInsights): string {
  if (!cost.reports) return "Not reported";
  if (cost.overflow) return "Unavailable (total overflow)";
  if (cost.amount > 0 && cost.amount < 0.00000001) return "<0.00000001 credits";
  return `${cost.amount.toLocaleString("en-US", { maximumFractionDigits: 8 })} credits`;
}
function duration(ms: number): string {
  if (ms > 0 && ms < 1000) return "<1s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function qualityRows(data: Insights): InsightRow[] {
  const f = data.files;
  const rows: InsightRow[] = [{ label: "Source", value: "Local saved journals", detail: "This directory only; root tasks are sessions, child work contributes to turns, tools, tokens and reported costs.", tone: "muted" }];
  if (f.truncated) rows.push({ label: "Partial journals", value: number(f.truncated), detail: "Valid records before an incomplete final line are included.", tone: "warn" });
  if (f.corrupt || f.unreadable || f.duplicate) rows.push({ label: "Skipped journals", value: number(f.corrupt + f.unreadable + f.duplicate), detail: `${f.corrupt} corrupt/unsupported, ${f.unreadable} unreadable, ${f.duplicate} duplicate run IDs.`, tone: "warn" });
  if (f.oversized || f.limited || f.scanLimited) rows.push({ label: "Read limits", value: "Partial totals", detail: `${f.oversized} oversized and ${f.limited} other files skipped; at most 200 files, 8 MiB/file, 32 MiB total and 10,000 directory entries.${f.scanLimited ? " Directory scan stopped early." : ""}`, tone: "warn" });
  return rows;
}

export function statsRows(data: Insights): InsightRow[] {
  return [
    { label: "Saved runs", value: number(data.sessions) },
    { label: "Last 7 days", value: number(data.recentSessions), detail: "Runs started in the last seven days." },
    { label: "Completed", value: number(data.completed), detail: "Agent-reported completion; not a test or quality grade.", tone: "good" },
    { label: "Active", value: number(data.active) },
    { label: "Interrupted", value: number(data.interrupted), detail: "Root runs explicitly ended as aborted." },
    { label: "Errors", value: number(data.errors), detail: "Root runs ended with a transport error." },
    { label: "Other endings", value: number(data.stopped), detail: "Turn, loop, breakage or no-action limits; includes unrecognized end reasons." },
    { label: "No final run record", value: number(data.unfinished), detail: "Root scope_end missing; may be interrupted or running elsewhere, and is not counted as completed." },
    { label: "Model turns", value: number(data.turns), detail: "Recorded turn starts across root and child scopes." },
    { label: "Tool calls", value: number(data.toolCalls), detail: "Recorded tool starts across root and child scopes." },
    { label: "Observed runtime", value: duration(data.durationMs), detail: `${data.timedSessions}/${data.sessions} runs have usable timestamps; ${data.partialDurations} spans are partial. Overlapping runs are summed, not calendar time.` },
    ...qualityRows(data),
  ];
}

export function usageRows(data: Insights): InsightRow[] {
  const u = data.usage;
  const tokens = (sum: number, reports: number): string => reports ? number(sum) : "Not reported";
  const coverage = (reports: number): string => `${reports}/${u.events} usage events reported this count; missing values are not estimated.`;
  return [
    { label: "Prompt tokens", value: tokens(u.promptTokens, u.promptReports), detail: coverage(u.promptReports) },
    { label: "Completion tokens", value: tokens(u.completionTokens, u.completionReports), detail: coverage(u.completionReports) },
    { label: "Cached prompt tokens", value: tokens(u.cachedTokens, u.cachedReports), detail: coverage(u.cachedReports) },
    { label: "Cache ratio", value: u.pairedPromptTokens > 0 ? `${(100 * u.pairedCachedTokens / u.pairedPromptTokens).toFixed(1)}%` : "Unavailable", detail: `Only ${u.pairedReports}/${u.events} events reporting both prompt and cache counts; cached tokens are part of prompt tokens.` },
    { label: "Usage coverage", value: `${number(u.events)} events / ${number(data.turns)} turns`, detail: "Server-reported journal events only; failed requests or unrecorded operations may be absent." },
    { label: "Reported cost", value: reportedCost(u.cost), detail: "Infron credits reported for these local journal events only; not account-wide spending or remaining balance. Rounded to at most 8 decimal places.", ...(u.cost.overflow ? { tone: "warn" as const } : {}) },
    { label: "Cost coverage", value: `${number(u.cost.reports)}/${number(u.events)} usage events`, detail: "Only valid Infron credit amounts are added; zero is a reported charge. Missing costs in older journals or unrecorded requests are not estimated." },
    ...data.models.map((model): InsightRow => ({ label: model.model, value: `${number(model.turns)} turns`, detail: `${model.sessions} runs · prompt ${tokens(model.promptTokens, model.promptReports)} · completion ${tokens(model.completionTokens, model.completionReports)} · cached ${tokens(model.cachedTokens, model.cachedReports)} · cost ${reportedCost(model.cost)} (${model.cost.reports}/${model.events} events; reported totals only)` })),
    ...(u.invalidReports ? [{ label: "Invalid usage fields", value: number(u.invalidReports), detail: "Negative, non-integer or inconsistent token counts were ignored.", tone: "warn" as const }] : []),
    ...(u.cost.invalidReports || u.cost.otherReports ? [{ label: "Excluded cost records", value: number(u.cost.invalidReports + u.cost.otherReports), detail: `${u.cost.invalidReports} malformed amounts/metadata; ${u.cost.otherReports} other providers or units. Providers and units are never combined.`, tone: "warn" as const }] : []),
    ...qualityRows(data),
  ];
}
