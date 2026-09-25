import { describe, expect, it } from 'vitest';
import { compileArguments, jsonDigest } from '../src/schema.js';

describe('original MCP schema validation', () => {
  it('keeps null/false, resolves local refs, and rejects coercion, missing required and extra fields', () => {
    const validate = compileArguments({ type: 'object', $defs: { quantity: { type: 'integer', minimum: 1 } },
      properties: { count: { $ref: '#/$defs/quantity' }, coupon: { type: ['string', 'null'] }, flag: { type: 'boolean' } },
      required: ['count', 'coupon', 'flag'], additionalProperties: false });
    const args = { count: 2, coupon: null, flag: false };
    expect(validate.check(args).valid).toBe(true);
    expect(args).toEqual({ count: 2, coupon: null, flag: false });
    for (const bad of [{ ...args, count: '2' }, { count: 2, flag: false }, { ...args, extra: true }, { ...args, count: NaN }]) expect(validate.check(bad).valid).toBe(false);
  });
  it('checks formats and regex; unresolved remote refs and unsupported dialects fail closed', () => {
    const validate = compileArguments({ type: 'object', properties: { date: { type: 'string', format: 'date' }, id: { type: 'string', pattern: '^CASE-[0-9]{3}$' } }, required: ['date', 'id'] });
    expect(validate.check({ date: '2026-09-25', id: 'CASE-042' }).valid).toBe(true);
    expect(validate.check({ date: '2026-13-25', id: 'CASE-042' }).valid).toBe(false);
    expect(() => compileArguments({ type: 'object', $ref: 'https://example.invalid/schema' })).toThrow();
    expect(() => compileArguments({ $schema: 'https://example.invalid/dialect', type: 'object' })).toThrow();
    expect(() => compileArguments({ $async: true, type: 'object' })).toThrow();
  });
  it('canonical call identity ignores property order but not value types or array order', () => {
    expect(jsonDigest({ a: 1, b: false })).toBe(jsonDigest({ b: false, a: 1 }));
    expect(jsonDigest([1, 2])).not.toBe(jsonDigest([2, 1]));
    expect(jsonDigest({ a: 1 })).not.toBe(jsonDigest({ a: '1' }));
    expect(() => jsonDigest({ value: undefined })).toThrow();
    expect(() => jsonDigest(new Array(1))).toThrow();
  });
  it('bounds escaped Unicode paths and supplies exact short recovery fields without argument values', () => {
    const properties = compileArguments({ type: 'object', additionalProperties: { type: 'number' } });
    const issue = properties.check({ ['\u0000🙂'.repeat(5_000)]: 'do-not-echo-this-value' }).issues[0]!;
    expect(issue).toMatchObject({ keyword: 'type', expectedType: 'number', truncated: true });
    expect(Buffer.byteLength(JSON.stringify(issue.path)) - 2).toBeLessThanOrEqual(256);
    expect(JSON.stringify(issue)).not.toContain('do-not-echo-this-value');
    const required = compileArguments({ type: 'object', required: ['names'] }).check({}).issues[0];
    expect(required).toMatchObject({ keyword: 'required', missingProperty: 'names', message: 'A required property is missing.' });
    const longRequired = compileArguments({ type: 'object', required: ['한글'.repeat(10_000)] }).check({}).issues[0]!;
    expect(longRequired.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(longRequired.missingProperty)) - 2).toBeLessThanOrEqual(128);
    const extra = compileArguments({ type: 'object', additionalProperties: false }).check({ unexpected: true }).issues[0];
    expect(extra).toMatchObject({ keyword: 'additionalProperties', additionalProperty: 'unexpected' });
  });
});
