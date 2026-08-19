/**
 * The instrument panel.
 *
 * Every reading here is something a hosted API cannot show you and a local
 * deployment can. That is the whole selection rule:
 *
 *   ch          which action channel is live, and whether it downgraded
 *   parse       tool-call parse failures over attempts — the model's documented
 *               weak spot, surfaced rather than buried in a log
 *   prefix      prompt-cache reuse. No hosted API reports this; here the tool
 *               list is frozen precisely to keep it high, so it is worth seeing
 *   ctx / kv    tokens and the actual KV bytes, which are computable because
 *               the model's MLA geometry is known
 *   tok/s       there is no dollar cost on local hardware; speed is the price
 */

import type { Instruments } from "./cells.js";
import { fmtTokens } from "./hero.js";

export type Severity = "ok" | "warn" | "bad";

export interface Reading {
  label: string;
  value: string;
  severity: Severity;
}

export function readings(inst: Instruments): Reading[] {
  return [channelReading(inst), parseReading(inst), prefixReading(inst), contextReading(inst), speedReading(inst)];
}

function channelReading(inst: Instruments): Reading {
  // Anything other than the native channel means we degraded to get here.
  const severity: Severity = inst.channel === "toolcall" ? "ok" : "warn";
  return { label: "ch", value: inst.channel, severity };
}

function parseReading(inst: Instruments): Reading {
  const rate = inst.parseAttempts > 0 ? inst.parseFailures / inst.parseAttempts : 0;
  const severity: Severity = rate > 0.25 ? "bad" : rate > 0.05 ? "warn" : "ok";
  return { label: "parse", value: `${inst.parseFailures}/${inst.parseAttempts}`, severity };
}

function prefixReading(inst: Instruments): Reading {
  if (inst.prefixTotal === 0) return { label: "prefix", value: "—", severity: "ok" };
  const pct = Math.round((inst.prefixShared / inst.prefixTotal) * 100);
  // Below about half, something invalidated the tools block or the system turn
  // — which on this model usually means the tool list changed.
  const severity: Severity = pct >= 80 ? "ok" : pct >= 50 ? "warn" : "bad";
  const mark = severity === "ok" ? "✓" : "✗";
  return { label: "prefix", value: `${mark} ${pct}%`, severity };
}

function contextReading(inst: Instruments): Reading {
  const frac = inst.maxTokens > 0 ? inst.contextTokens / inst.maxTokens : 0;
  const severity: Severity = frac > 0.85 ? "bad" : frac > 0.6 ? "warn" : "ok";
  return {
    label: "ctx",
    value: `${fmtTokens(inst.contextTokens)}/${fmtTokens(inst.maxTokens)} · kv ${fmtBytes(inst.kvBytes)}`,
    severity,
  };
}

function speedReading(inst: Instruments): Reading {
  const tps = inst.tokensPerSecond;
  // 33 tok/s is the reported median decode speed of a production coding agent;
  // it is the only reference point that means anything to a user here.
  const severity: Severity = tps === 0 ? "ok" : tps >= 20 ? "ok" : tps >= 10 ? "warn" : "bad";
  return { label: "", value: tps > 0 ? `${tps.toFixed(0)} tok/s` : "—", severity };
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)}KB`;
  return `${bytes}B`;
}

/** Plain-text status line. The ANSI writer colours it by severity. */
export function statusLine(inst: Instruments): string {
  return readings(inst)
    .map((r) => (r.label ? `${r.label} ${r.value}` : r.value))
    .join("  ·  ");
}
