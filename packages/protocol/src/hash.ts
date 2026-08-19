/**
 * One canonical hash, used by everyone.
 *
 * There used to be two implementations of "hash the tool list" — one in the
 * CLI, one in the loop — with different separators, so a resume compared a
 * session against a fingerprint the loop had never produced. Worse, both hashed
 * the tool *names*: changing a description or a required field, which changes
 * every rendered prompt and every argument the repair oracle will accept, left
 * the fingerprint identical.
 *
 * So: SHA-256 over a canonical serialisation, in one place, with the full
 * schema and its order included.
 *
 * Canonical here means key order is normalised. That is exactly the opposite of
 * what the prompt renderer wants — `pyJson` preserves insertion order because
 * the model reads those bytes — and the difference is deliberate. A hash asks
 * "is this the same configuration"; a prompt asks "what does the model see".
 * Two objects that differ only in key order are the same configuration and are
 * a different prompt.
 */

import { createHash } from "node:crypto";
import type { Message, Tool } from "./types.js";
import { unwrapTool } from "./types.js";

/** Stable JSON: object keys sorted, arrays left in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    // Distinguish -0 from 0 and refuse non-finite values rather than emitting
    // something no JSON reader will accept back.
    if (!Number.isFinite(value)) throw new Error(`cannot canonicalise ${String(value)}`);
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * Fingerprint of the frozen tool list.
 *
 * Order is part of it, because order is part of the prompt: rendering the same
 * tools in a different order leaves about a quarter of the prefix intact. So is
 * every description and every schema detail, because both decide what the model
 * reads and what the repair oracle will accept.
 */
export function toolSchemaHash(tools: readonly Tool[]): string {
  return canonicalHash(tools.map((t) => unwrapTool(t)));
}

export function systemPromptHash(system: string): string {
  return sha256(system);
}

/** Identity of one tool call, for deduplicating a re-emitted action. */
export function callDigest(name: string, args: Record<string, unknown>): string {
  return canonicalHash({ name, arguments: args });
}

/**
 * Identity of a request, for replay comparison.
 *
 * The abort signal is excluded — it is a handle, not content — and everything
 * else is in: the whole transcript, the full tool schemas in order, the
 * sampling settings, the token cap, and whether this is the chat or the raw
 * endpoint. A replay that passes has to mean the model was handed the same
 * thing, and anything left out of this hash is something a change could slip
 * through.
 */
export function requestDigest(req: {
  messages: readonly Message[];
  tools: readonly Tool[];
  raw?: boolean;
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  stop?: readonly string[];
}): string {
  return canonicalHash({
    messages: req.messages,
    tools: req.tools.map((t) => unwrapTool(t)),
    raw: req.raw ?? false,
    prompt: req.prompt ?? null,
    maxTokens: req.maxTokens ?? null,
    temperature: req.temperature ?? null,
    topP: req.topP ?? null,
    seed: req.seed ?? null,
    stop: req.stop ?? null,
  });
}
