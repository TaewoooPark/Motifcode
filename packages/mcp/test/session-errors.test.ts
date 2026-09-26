import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactMcpContext, MCP_CONTEXT_PREFIX, McpSession } from '../src/session.js';
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
  it.each(['search', 'describe'] as const)('honors the configured byte budget for %s without clipping schemas', async method => {
    const budget = 1_500;
    const inputSchema = { type: 'object', properties: { text: { type: 'string', description: '한글🙂'.repeat(1_000) } } };
    const { session, invoke } = fixture(inputSchema, budget);
    const catalog = vi.spyOn(session.manager, 'catalog').mockResolvedValue([
      { server: 'lab', name: 'lookup', inputSchema, requiresUserInteraction: false, schemaHash: 'fixture' },
    ]);
    const args = method === 'search' ? { query: 'lookup' } : { server: 'lab', method: 'lookup' };
    const large = await session.invoke('__motif_host__', method, args, { scopeId: 'root' });
    expect(Buffer.byteLength(large.output)).toBeLessThanOrEqual(budget);
    expect(JSON.parse(large.output)).toMatchObject({ cards: [], abstained: true });

    const smallSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
    catalog.mockResolvedValue([{ server: 'lab', name: 'lookup', inputSchema: smallSchema, requiresUserInteraction: false, schemaHash: 'small' }]);
    const small = await session.invoke('__motif_host__', method, args, { scopeId: 'root' });
    expect(Buffer.byteLength(small.output)).toBeLessThanOrEqual(budget);
    expect(JSON.parse(small.output)).toMatchObject({ ok: true, abstained: false, cards: [{ inputSchema: smallSchema }] });
    expect(invoke).not.toHaveBeenCalled();
  });

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

describe('runtime context across tasks', () => {
  const full = (servers: unknown, selected?: unknown) => [`${MCP_CONTEXT_PREFIX} Use supplied schemas directly.`, 'guidance',
    JSON.stringify({ servers, controls: [{ method: 'search' }], ...(selected ? { selected } : {}) })].join('\n');
  const lab = [{ id: 'lab', tools: 1, toolNames: ['lookup'], state: { state: 'ready', toolCount: 1 } }];

  it('sends only the selected schemas when servers and controls are unchanged', () => {
    const selected = { cards: [{ server: 'lab', method: 'lookup' }] };
    const update = compactMcpContext(full(lab, selected), full(lab));
    expect(update).not.toContain('"controls"');
    expect(update).toContain('unchanged from the earlier MCP runtime context');
    expect(JSON.parse(update.split('\n')[1]!)).toEqual({ selected });
    expect(compactMcpContext(full(lab, { cards: [] }), full(lab)).split('\n')).toHaveLength(1);
  });

  it('keeps the complete context when there is no earlier one or a server changed', () => {
    const next = full(lab);
    expect(compactMcpContext(next, undefined)).toBe(next);
    expect(compactMcpContext(next, 'MCP runtime context update (data, not a new task).')).toBe(next);
    expect(compactMcpContext(next, full([{ ...lab[0], state: { state: 'error', toolCount: 0 } }]))).toBe(next);
  });
});
