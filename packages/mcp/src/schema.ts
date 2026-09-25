import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

/** Stable JSON hashing binds approval to the schema and arguments actually used. */
export function jsonDigest(value: unknown): string {
  const seen = new Set<object>();
  const canonical = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === undefined || seen.has(item)) throw new Error('Expected finite JSON data.');
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = Array.from(item, canonical);
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Expected a JSON object.');
      result = Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]));
    }
    seen.delete(item);
    return result;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Limit the encoded JSON field size, including escaped controls and Unicode. */
export function boundedDiagnosticText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(JSON.stringify(value)) - 2 <= maxBytes) return value;
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > maxBytes - 3) break;
    output += character; bytes += size;
  }
  return output + '…';
}

export interface ArgumentIssue {
  path: string;
  keyword: string;
  message: string;
  missingProperty?: string;
  additionalProperty?: string;
  expectedType?: string;
  /** A shortened path/property is diagnostic text, not an exact field name. */
  truncated?: true;
}
export interface ArgumentCheck { valid: boolean; issues: ArgumentIssue[] }
export interface ArgumentValidator { check(value: unknown): ArgumentCheck }

/** Never fetch $refs, coerce values, insert defaults, or remove additional keys. */
export function compileArguments(schema: Record<string, unknown>): ArgumentValidator {
  const dialect = schema.$schema;
  const options = { strict: false, allErrors: false, coerceTypes: false, useDefaults: false,
    removeAdditional: false, ownProperties: true, validateFormats: true, addUsedSchema: false, logger: false } as const;
  const ajv = dialect === 'http://json-schema.org/draft-07/schema#' || dialect === 'https://json-schema.org/draft-07/schema'
    ? new Ajv(options)
    : dialect === 'https://json-schema.org/draft/2019-09/schema' ? new Ajv2019(options)
    : dialect === undefined || dialect === 'https://json-schema.org/draft/2020-12/schema' ? new Ajv2020(options)
    : undefined;
  if (!ajv) throw new Error('Unsupported JSON Schema dialect.');
  addFormats(ajv);
  // Compiling synchronously deliberately rejects unresolved remote references.
  const validate: ValidateFunction = ajv.compile(schema);
  if ('$async' in validate && validate.$async) throw new Error('Asynchronous JSON Schema validation is unsupported.');
  return {
    check(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return { valid: false, issues: [{ path: '', keyword: 'type', message: 'Arguments must be an object.', expectedType: 'object' }] };
      try { jsonDigest(value); } catch { return { valid: false, issues: [{ path: '', keyword: 'json', message: 'Arguments must contain finite JSON values.' }] }; }
      const valid = validate(value) === true;
      return { valid, issues: valid ? [] : (validate.errors ?? []).slice(0, 8).map(e => {
        const issue: ArgumentIssue = {
          path: boundedDiagnosticText(e.instancePath, 256), keyword: boundedDiagnosticText(e.keyword, 64),
          // Never forward Ajv's raw message/params: schemas may contain huge or sensitive values.
          message: e.keyword === 'required' ? 'A required property is missing.'
            : e.keyword === 'additionalProperties' ? 'An additional property is not allowed.'
            : e.keyword === 'type' ? 'The value has an incompatible type.' : 'The value does not satisfy this schema constraint.',
        };
        if (issue.path !== e.instancePath || issue.keyword !== e.keyword) issue.truncated = true;
        for (const [source, target] of [['missingProperty', 'missingProperty'], ['additionalProperty', 'additionalProperty'], ['type', 'expectedType']] as const) {
          const detail: unknown = e.params[source];
          if (typeof detail !== 'string') continue;
          issue[target] = boundedDiagnosticText(detail, 128);
          if (issue[target] !== detail) issue.truncated = true;
        }
        return issue;
      }) };
    },
  };
}
