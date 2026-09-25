import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpSession } from '../src/session.js';
import type { McpTool } from '../src/manager.js';

const sessions: McpSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())); vi.restoreAllMocks(); });
function fixture(inputSchema: Record<string, unknown>, budget = 16_000) {
  const session = new McpSession({ servers: [] }, { maxOutputBytes: budget }); sessions.push(session);
  const tool: McpTool = { server: 'lab', name: 'lookup', inputSchema, requiresUserInteraction: false, schemaHash: 'fixture' };
  vi.spyOn(session.manager, 'getTool').mockResolvedValue(tool);
  const invoke = vi.spyOn(session.manager, 'invoke').mockResolvedValue({ ok: false, execution: 'not_started',
    error: { code: 'invalid_arguments', message: 'Arguments do not satisfy the original schema.', retryable: false },
    issues: [{ path: '', keyword: 'required', message: 'A required property is missing.', missingProperty: 'names' }] });
  return { session, invoke };
}
const nextCall = { server: '__motif_host__', method: 'describe', args: { server: 'lab', method: 'lookup' } };

describe('bounded MCP validation recovery envelopes', () => {
  it('returns the exact small schema and missing field with a concrete describe call, without retry', async () => {
    const inputSchema = { type: 'object', required: ['names'], properties: { names: { type: 'array', items: { type: 'string' } } }, additionalProperties: false };
    const { session, invoke } = fixture(inputSchema);
    const result = await session.invoke('lab', 'lookup', {}, { scopeId: 'root' });
    expect(JSON.parse(result.output)).toMatchObject({ execution: 'not_started', nextCall, inputSchema, issues: [{ missingProperty: 'names' }] });
    expect(result.bounded).toBe(true); expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('omits a large schema whole and preserves the describe fallback within a smaller budget', async () => {
    const { session } = fixture({ type: 'object', description: '🙂'.repeat(10_000) }, 1_500);
    const result = await session.invoke('lab', 'lookup', {}, { scopeId: 'root' });
    const value = JSON.parse(result.output);
    expect(value).toMatchObject({ nextCall, schemaOmitted: true });
    expect(value.inputSchema).toBeUndefined();
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1_500);
  });

  it('defensively bounds a future unbounded error and preserves unknown execution', async () => {
    const { session, invoke } = fixture({}, 1_500);
    invoke.mockResolvedValue({ ok: false, execution: 'unknown', error: { code: 'connection_error', message: '\u0000🙂'.repeat(10_000), retryable: false },
      issues: [{ path: 'x'.repeat(20_000), keyword: 'x'.repeat(20_000), message: 'x'.repeat(20_000) }] });
    const result = await session.invoke('lab', 'lookup', {}, { scopeId: 'root' });
    expect(JSON.parse(result.output)).toMatchObject({ execution: 'unknown', error: { code: 'connection_error', retryable: false }, diagnosticsTruncated: true });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1_500);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not present the stale previously fetched schema after a schema change', async () => {
    const { session, invoke } = fixture({ type: 'object', properties: { old_name: { type: 'string' } } });
    invoke.mockResolvedValue({ ok: false, execution: 'not_started', error: { code: 'schema_changed', message: 'Schema changed.', retryable: false } });
    const result = JSON.parse((await session.invoke('lab', 'lookup', {}, { scopeId: 'root' })).output);
    expect(result).toMatchObject({ nextCall });
    expect(result.inputSchema).toBeUndefined();
  });
});
