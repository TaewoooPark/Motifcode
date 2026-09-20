/**
 * The instrument panel.
 *
 * Every reading here is something about this model's protocol or this
 * session's cost, chosen because a generic chat client shows none of it:
 *
 *   ch          which action channel is live, and whether it downgraded
 *   parse       tool-call parse failures over attempts — the model's documented
 *               weak spot, surfaced rather than buried in a log
 *   prefix      prompt-cache reuse. Textual overlap computed here, and beside
 *               it the server's own cached-token count when the endpoint
 *               reports one; the tool list is frozen precisely to keep both
 *               high, so they are worth seeing
 *   ctx / kv    tokens and the actual KV bytes, which are computable because
 *               the model's MLA geometry is known
 *   tok/s       request-effective throughput; speed is the price
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
  // The server's count, when it gives one, is the actual cache measurement;
  // the percentage is only what this process can compute from the text.
  const cached = inst.cachedTokens !== undefined ? ` · cached ${fmtTokens(inst.cachedTokens)}` : "";
  return { label: "prefix", value: `${mark} ${pct}%${cached}`, severity };
}

function contextReading(inst: Instruments): Reading {
  const frac = inst.maxTokens > 0 ? inst.contextTokens / inst.maxTokens : 0;
  const severity: Severity = frac > 0.85 ? "bad" : frac > 0.6 ? "warn" : "ok";
  return {
    label: "ctx",
    value: `${inst.contextTokensMeasured ? "" : "~"}${fmtTokens(inst.contextTokens)}/${fmtTokens(inst.maxTokens)} · kv ${fmtBytes(inst.kvBytes)}`,
    severity,
  };
}

function speedReading(inst: Instruments): Reading {
  const tps = inst.requestTokensPerSecond;
  // Labelled `req` because it is completion tokens over the whole request,
  // prefill and queueing included. Calling it `tok/s` invites comparison with
  // decode rates measured a completely different way.
  const severity: Severity = tps === 0 ? "ok" : tps >= 20 ? "ok" : tps >= 10 ? "warn" : "bad";
  return { label: "", value: tps > 0 ? `${tps.toFixed(0)} req tok/s` : "—", severity };
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
