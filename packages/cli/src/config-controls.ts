import { normalizeEndpoint } from "@motifcode/core";
import { THEMES } from "@motifcode/tui";
import type { StoredSettings } from "./settings.js";

export interface ConfigField {
  key: keyof StoredSettings;
  label: string;
  detail: string;
  choices?: readonly string[];
}

/** The same persisted settings used by startup and the running chat. */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  { key: "thinking", label: "Show reasoning", choices: ["false", "true"], detail: "Show the model's reasoning in the transcript. Applies immediately; does not change model reasoning." },
  { key: "verbose", label: "Full tool output", choices: ["false", "true"], detail: "Show full tool output instead of clipped results. Applies immediately." },
  { key: "permissions", label: "Tool permissions", choices: ["ask", "auto"], detail: "ask waits for approval before writes and commands; auto runs tools without asking." },
  { key: "model", label: "Model", detail: "Model ID sent to the endpoint on the next task." },
  { key: "endpoint", label: "Endpoint", detail: "API base URL for the next task. The current API key will be sent to this server." },
  { key: "channel", label: "Action channel", choices: ["toolcall", "object", "raw"], detail: "Changing this restarts the conversation. object/raw are experimental and require /v1/completions." },
  { key: "maxTurns", label: "Max turns / task", detail: "Positive integer: maximum model steps per task." },
  { key: "maxOutputTokens", label: "Max output tokens", detail: "Positive integer per model step, or off to use the server default." },
  { key: "seed", label: "Sampling seed", detail: "Integer >= 0, or off. The endpoint must support seeded sampling." },
  { key: "compactAt", label: "Compact at", detail: "Context fraction from 0.1 to 1 at which automatic compaction runs." },
  { key: "theme", label: "Theme", choices: Object.keys(THEMES), detail: "Terminal color palette. Applies immediately; NO_COLOR takes precedence." },
];

export function configField(key: string): ConfigField | undefined {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return CONFIG_FIELDS.find((f) => f.key.toLowerCase() === (normalized === "maxtokens" ? "maxoutputtokens" : normalized));
}

export function parseConfigValue(field: ConfigField, raw: string): string | number | boolean | undefined {
  const value = raw.trim();
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Use a single line without control characters.");
  if (value.length > 2048) throw new Error("The value is too long (maximum 2048 characters).");
  if (field.choices) {
    if (!field.choices.includes(value)) throw new Error(`Choose ${field.choices.join(" or ")}.`);
    return field.key === "thinking" || field.key === "verbose" ? value === "true" : value;
  }
  if (field.key === "maxOutputTokens" || field.key === "seed") {
    if (value === "off") return undefined;
  }
  if (field.key === "maxTurns" || field.key === "maxOutputTokens" || field.key === "seed") {
    const n = Number(value);
    const min = field.key === "seed" ? 0 : 1;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) throw new Error(`Enter an integer >= ${min}${field.key !== "maxTurns" ? ", or off" : ""}.`);
    return n;
  }
  if (field.key === "compactAt") {
    const n = Number(value);
    if (value === "" || !Number.isFinite(n) || n < 0.1 || n > 1) throw new Error("Enter a context fraction from 0.1 to 1.");
    return n;
  }
  if (field.key === "endpoint") {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Enter a valid http:// or https:// URL."); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTP(S) base URL without credentials, query parameters or a fragment.");
    }
    return normalizeEndpoint(value);
  }
  if (!value) throw new Error("The value cannot be empty.");
  return value;
}
