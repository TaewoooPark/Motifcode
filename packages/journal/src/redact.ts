/**
 * Keeping secrets out of a file that gets shared.
 *
 * A journal is the thing people attach to a bug report, hand to a colleague, or
 * upload as benchmark evidence. It also holds every command the agent ran and
 * everything those commands printed — which on a bad day is `env`, a `.env`
 * file, a curl with a bearer token, or a stack trace carrying a connection
 * string.
 *
 * The rules are pattern-based, and pattern-based redaction is never complete.
 * That is stated rather than hidden: the version is written into the header, so
 * a journal redacted by an older rule set can be recognised as such instead of
 * being assumed clean. Anything genuinely sensitive belongs behind file
 * permissions — journals are created `0600` — and out of a repository.
 *
 * What redaction must *not* do is quietly change a recording. A replay compares
 * bytes, and a redacted journal that still claims to be an exact recording will
 * diverge for reasons nobody can see. So redaction is applied on export, the
 * result is marked, and `REDACTION_VERSION` moves when the rules do.
 */

export const REDACTION_VERSION = 1;

interface Rule {
  name: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const MASK = "«redacted»";

/**
 * Ordered, and order matters: the specific token shapes run before the generic
 * assignment rule, so a recognised key is labelled by kind rather than by the
 * variable that happened to hold it.
 */
const RULES: readonly Rule[] = [
  {
    name: "aws-access-key",
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => `${MASK}:aws-access-key`,
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    replace: () => `${MASK}:github-token`,
  },
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => `${MASK}:api-key`,
  },
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => `${MASK}:api-key`,
  },
  {
    name: "huggingface-token",
    pattern: /\bhf_[A-Za-z0-9]{20,}\b/g,
    replace: () => `${MASK}:hf-token`,
  },
  {
    name: "bearer-header",
    pattern: /\b([Aa]uthorization:\s*[Bb]earer\s+)\S+/g,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `${MASK}:private-key`,
  },
  {
    name: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}${MASK}@`,
  },
  {
    // Deliberately last and deliberately narrow: an assignment whose *name*
    // says secret. Widening this to "any long random-looking string" would
    // redact commit hashes, base64 test fixtures and half of a lockfile.
    name: "secret-assignment",
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[=:]\s*)(?:"([^"]*)"|'([^']*)'|(\S+))/g,
    replace: (_m, name, sep) => `${name}${sep}${MASK}`,
  },
];

export interface RedactionReport {
  text: string;
  /** Which rules fired, so a reader can tell redaction happened at all. */
  hits: string[];
}

export function redactText(text: string): RedactionReport {
  let out = text;
  const hits: string[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(out)) continue;
    hits.push(rule.name);
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return { text: out, hits };
}

/** Redact every string inside a structure, leaving its shape untouched. */
export function redactValue<T>(value: T): { value: T; hits: string[] } {
  const hits = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v);
      for (const h of r.hits) hits.add(h);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(value) as T, hits: [...hits] };
}

/** Redact a whole journal file, line by line, keeping it valid JSONL. */
export function redactJournal(text: string): RedactionReport {
  const hits = new Set<string>();
  const lines = text.split("\n").map((line) => {
    if (line.trim() === "") return line;
    try {
      const parsed = JSON.parse(line) as unknown;
      const r = redactValue(parsed);
      for (const h of r.hits) hits.add(h);
      return JSON.stringify(r.value);
    } catch {
      // A line that does not parse is the truncated tail; redact it as text so
      // a secret in the half-written record is still covered.
      const r = redactText(line);
      for (const h of r.hits) hits.add(h);
      return r.text;
    }
  });
  return { text: lines.join("\n"), hits: [...hits] };
}
