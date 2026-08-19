/**
 * Python-compatible JSON serialisation.
 *
 * The Motif chat template is Jinja, and Jinja's `tojson` is `json.dumps`.
 * Transformers overrides the filter with `ensure_ascii=False`, so non-ASCII
 * stays raw. Everything else is `json.dumps` defaults — and those differ from
 * `JSON.stringify` in one way that matters:
 *
 *     python  json.dumps({"a": 1, "b": 2})  ->  '{"a": 1, "b": 2}'
 *     js      JSON.stringify({a: 1, b: 2})  ->  '{"a":1,"b":2}'
 *
 * Python's default separators are `(', ', ': ')`. Miss that and every rendered
 * prompt differs from the server's by a handful of spaces — which is enough to
 * miss the prefix cache on every single request while looking correct.
 */

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

/** `json.dumps(s, ensure_ascii=False)` for a string. */
export function pyJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const esc = ESCAPES[ch];
    if (esc !== undefined) {
      out += esc;
    } else if (ch < " ") {
      out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

/**
 * `json.dumps(value, ensure_ascii=False)`.
 *
 * Key order follows insertion order, matching Python dicts. Beware that
 * JavaScript reorders integer-like keys ("0", "1", ...) ahead of string keys;
 * do not use such keys in tool schemas.
 */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "string":
      return pyJsonString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        // Python emits bare Infinity / NaN here. Reproduce it rather than
        // throwing, so a faithful render stays faithful even when it is ugly.
        return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
      }
      return Number.isInteger(value) ? String(value) : String(value);
    }
    default:
      break;
  }
  if (Array.isArray(value)) {
    return "[" + value.map(pyJson).join(", ") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return "{" + entries.map(([k, v]) => `${pyJsonString(k)}: ${pyJson(v)}`).join(", ") + "}";
}
