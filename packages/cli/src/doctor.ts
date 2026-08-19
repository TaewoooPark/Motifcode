/**
 * `motif doctor`.
 *
 * Bad output from this model is very often a server misconfiguration rather
 * than the model, and the failure is silent in every case: stock vLLM drops
 * malformed tool calls without saying so, prefix caching off just makes
 * everything slow, near-greedy sampling quietly puts you in a different regime
 * from the published numbers. A user who hits any of those blames the weights.
 *
 * So the harness checks, and says what is missing.
 */

import { KV_BYTES_PER_TOKEN, MAX_CONTEXT, SAMPLING_DEFAULTS } from "@motifcode/protocol";
import { detectSandbox } from "./sandbox.js";

export type CheckState = "ok" | "warn" | "fail" | "unknown";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** What to do about it. Absent when there is nothing to do. */
  fix?: string;
}

export interface DoctorOptions {
  endpoint: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Total unified/device memory in bytes, when the caller knows it. */
  deviceMemoryBytes?: number;
}

interface ModelsResponse {
  data?: { id?: string; max_model_len?: number }[];
}

export async function doctor(opts: DoctorOptions): Promise<Check[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const endpoint = opts.endpoint.replace(/\/+$/, "");
  const checks: Check[] = [];

  // Reported whether or not a server is reachable: it decides whether a
  // read-only subagent can run anything at all, and a user who finds out at the
  // moment the explorer refuses will not know why.
  const sandbox = detectSandbox();
  checks.push(
    sandbox.kind === "none"
      ? {
          name: "sandbox",
          state: "warn",
          detail: `no read-only sandbox: ${sandbox.reason ?? "unavailable"}`,
          fix: "read-only subagents cannot run commands here; install bubblewrap on Linux, or use only writing agents",
        }
      : { name: "sandbox", state: "ok", detail: `read-only agents run under ${sandbox.kind}` },
  );

  let models: ModelsResponse | null = null;
  try {
    const res = await fetchImpl(`${endpoint}/v1/models`, { method: "GET" });
    if (res.ok) {
      models = (await res.json()) as ModelsResponse;
      checks.push({ name: "endpoint", state: "ok", detail: `${endpoint} responded` });
    } else {
      checks.push({
        name: "endpoint",
        state: "fail",
        detail: `${endpoint} returned ${res.status}`,
        fix: "start the server, or point --endpoint somewhere else",
      });
    }
  } catch (err) {
    checks.push({
      name: "endpoint",
      state: "fail",
      detail: `${endpoint} unreachable (${String(err)})`,
      fix: "start the server, or point --endpoint somewhere else",
    });
    return checks;
  }

  const served = models?.data?.[0];
  const id = served?.id ?? "(unknown)";
  checks.push({ name: "model", state: "ok", detail: id });

  const isMotif = /motif/i.test(id);
  checks.push({
    name: "model family",
    state: isMotif ? "ok" : "warn",
    detail: isMotif ? "a Motif checkpoint" : `"${id}" does not look like Motif`,
    ...(isMotif
      ? {}
      : {
          fix: "this harness is built around Motif-3's template, parser quirks and tool semantics; other models will work badly",
        }),
  });

  const maxLen = served?.max_model_len;
  if (maxLen !== undefined) {
    const full = maxLen >= MAX_CONTEXT;
    checks.push({
      name: "context length",
      state: full ? "ok" : "warn",
      detail: `${maxLen.toLocaleString()} of ${MAX_CONTEXT.toLocaleString()}`,
      ...(full
        ? {}
        : {
            fix: `--max-model-len ${MAX_CONTEXT}. KV is MLA-compressed here at ~${Math.round(KV_BYTES_PER_TOKEN / 1024)} KB per token, so the full window costs about ${Math.round((MAX_CONTEXT * KV_BYTES_PER_TOKEN) / 1e9)} GB — usually affordable`,
          }),
    });
  }

  // The rest cannot be read back over the OpenAI API. Reporting them as
  // "unknown" with the exact flag is more honest than guessing, and more useful
  // than silence.
  checks.push({
    name: "tool-call parser",
    state: "unknown",
    detail: "not reported by the API",
    fix: "--tool-call-parser motif — without it the stock parser drops every turn whose tool-call JSON is malformed, and this model produces those often",
  });
  checks.push({
    name: "reasoning parser",
    state: "unknown",
    detail: "not reported by the API",
    fix: "--reasoning-parser motif — the generation prompt always leaves <think> open, so reasoning and content must be separated server-side",
  });
  checks.push({
    name: "prefix caching",
    state: "unknown",
    detail: "not reported by the API",
    fix: "--enable-prefix-caching — the tool list here is frozen and canonically ordered specifically to keep the cached prefix alive; without caching that design buys nothing",
  });
  checks.push({
    name: "speculative decoding",
    state: "unknown",
    detail: "not reported by the API",
    fix: `--speculative-config '{"model": "<checkpoint>", "num_speculative_tokens": 1}' — the checkpoint carries an MTP head, so this is free throughput`,
  });
  checks.push({
    name: "sampling",
    state: "ok",
    detail: `the harness sends temperature ${SAMPLING_DEFAULTS.temperature}, top_p ${SAMPLING_DEFAULTS.top_p}`,
    fix: "these are the model's published evaluation settings; near-greedy values are a different regime and will not reproduce its numbers",
  });

  if (opts.deviceMemoryBytes !== undefined) {
    const gib = opts.deviceMemoryBytes / 2 ** 30;
    const tight = gib < 200;
    checks.push({
      name: "memory",
      state: tight ? "warn" : "ok",
      detail: `${gib.toFixed(1)} GiB visible`,
      ...(tight
        ? {
            fix: "the full NVFP4 checkpoint needs ~174 GiB of weights. On a single GB10 box use the pruned coding checkpoint, and cap the KV cache explicitly — unified memory means an over-large cache is killed by the OOM killer rather than failing with a CUDA error",
          }
        : {}),
    });
  }

  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const mark: Record<CheckState, string> = { ok: "✓", warn: "!", fail: "✗", unknown: "?" };
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${mark[c.state]} ${c.name.padEnd(22)} ${c.detail}`);
    if (c.fix) lines.push(`    ${c.fix}`);
  }
  const bad = checks.filter((c) => c.state === "fail").length;
  const unknown = checks.filter((c) => c.state === "unknown").length;
  lines.push("");
  lines.push(
    bad > 0
      ? `${bad} problem(s) to fix first.`
      : unknown > 0
        ? `Nothing broken. ${unknown} setting(s) the API cannot report — check the server command line against the notes above.`
        : "All clear.",
  );
  return lines.join("\n");
}

export function worstState(checks: readonly Check[]): CheckState {
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "warn")) return "warn";
  if (checks.some((c) => c.state === "unknown")) return "unknown";
  return "ok";
}
