import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../src/manager.js';
import type { McpServerConfig } from '../src/config.js';

const managers: McpManager[] = [];
const directories: string[] = [];
const scope = { scopeId: 'test-session' };
function fixture(kind: 'legacy' | 'modern' = 'legacy', extra: Partial<McpServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'motif-mcp-')); directories.push(dir);
  const log = join(dir, 'events.ndjson');
  const server: McpServerConfig = { id: 'lab', enabled: true, transport: 'stdio', protocol: kind,
    command: process.execPath, args: [fileURLToPath(new URL(`./fixtures/client-${kind}.mjs`, import.meta.url)), log],
    startupTimeoutMs: 3_000, toolTimeoutMs: 2_000, catalogTtlMs: 60_000, ...extra };
  return { server, log, events: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { event: string; name?: string; pid: number }) };
}
function manager(servers: McpServerConfig[]) { const m = new McpManager({ servers }, { env: { ...process.env, MOTIF_API_KEY: 'synthetic-test-value' } }); managers.push(m); return m; }
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.close())); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('McpManager real SDK connections', () => {
  it('lists every legacy page, filters deny over allow, validates without execution and preserves business errors', async () => {
    const f = fixture('legacy', { allowedTools: ['echo', 'business', 'gated'], deniedTools: ['gated'] });
    const m = manager([f.server]);
    expect(m.statuses()[0]?.state).toBe('idle');
    expect((await m.catalog()).map(t => t.name)).toEqual(['echo', 'business']);
    const invalid = await m.invoke('lab', 'echo', { text: 42 }, scope);
    expect(invalid).toMatchObject({ ok: false, execution: 'not_started', error: { code: 'invalid_arguments' } });
    expect(f.events().filter(e => e.event === 'call')).toHaveLength(0);
    const echo = await m.invoke('lab', 'echo', { text: '한글 "x"\nC:\\tmp' }, scope);
    expect(echo).toMatchObject({ ok: true, result: { structuredContent: { received: { text: '한글 "x"\nC:\\tmp' }, modelKeyInherited: false } } });
    expect(await m.invoke('lab', 'business', {}, scope)).toMatchObject({ ok: true, execution: 'completed', isError: true, result: { structuredContent: { replacement_id: 'CASE-042' } } });
    expect(await m.invoke('lab', 'gated', {}, scope)).toMatchObject({ error: { code: 'tool_not_allowed' } });
    // Catalog reads are cached; pagination was walked once, including empty cursor.
    expect(f.events().filter(e => e.event === 'list')).toHaveLength(2);
    const pid = f.events()[0]!.pid;
    await m.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each(['modern', 'auto'] as const)('connects to modern stdio with %s and preserves structured arrays', async protocol => {
    const f = fixture('modern', { protocol }); const m = manager([f.server]);
    expect((await m.catalog()).map(t => t.name)).toEqual(['array', 'input']);
    expect(await m.invoke('lab', 'array', {}, scope)).toMatchObject({ ok: true, result: { structuredContent: ['서울', '부산'] } });
    expect(await m.invoke('lab', 'input', {}, scope)).toMatchObject({ ok: false, execution: 'unknown', error: { code: 'interaction_required' } });
    expect(f.events().filter(e => e.event === 'call' && e.name === 'input')).toHaveLength(1);
  });

  it('requires user approval tied to current tool metadata, and invalidates on list_changed', async () => {
    const f = fixture(); const m = manager([f.server]);
    const gated = await m.getTool('lab', 'gated');
    expect(gated?.requiresUserInteraction).toBe(true);
    expect(await m.invoke('lab', 'gated', {}, scope)).toMatchObject({ execution: 'not_started', error: { code: 'interaction_required' } });
    expect(await m.invoke('lab', 'gated', {}, { ...scope, approvedInteraction: true, expectedSchemaHash: gated!.schemaHash })).toMatchObject({ ok: true });
    const original = await m.getTool('lab', 'echo');
    expect(await m.invoke('lab', 'change', {}, scope)).toMatchObject({ ok: true });
    const updated = await m.getTool('lab', 'echo');
    expect(updated!.schemaHash).not.toBe(original!.schemaHash);
    expect(await m.invoke('lab', 'echo', { text: 1 }, { ...scope, expectedSchemaHash: original!.schemaHash })).toMatchObject({ execution: 'not_started', error: { code: 'schema_changed' } });
    expect(await m.invoke('lab', 'echo', { text: 1 }, scope)).toMatchObject({ ok: true });
  });

  it('records unknown execution and blocks identical calls across next turns and child scopes', async () => {
    const f = fixture(); const m = manager([f.server]);
    expect(await m.invoke('lab', 'lose_ack', {}, scope)).toMatchObject({ ok: false, execution: 'unknown' });
    expect(await m.invoke('lab', 'lose_ack', {}, scope)).toMatchObject({ execution: 'not_started', error: { code: 'previous_execution_unknown' } });
    expect(await m.invoke('lab', 'lose_ack', {}, { scopeId: 'child-task-scope' })).toMatchObject({ execution: 'not_started', error: { code: 'previous_execution_unknown' } });
    expect(f.events().filter(e => e.event === 'call')).toHaveLength(1);
  });

  it('cancels in-flight work, cleans up child and never retries it', async () => {
    const f = fixture(); const m = manager([f.server]); await m.catalog();
    const controller = new AbortController();
    const pending = m.invoke('lab', 'wait', {}, { ...scope, signal: controller.signal });
    expect(await m.invoke('lab', 'wait', {}, { scopeId: 'child-task-scope' })).toMatchObject({ execution: 'not_started', error: { code: 'already_in_flight' } });
    await new Promise(resolve => setTimeout(resolve, 50)); controller.abort();
    expect(await pending).toMatchObject({ execution: 'unknown', error: { code: 'cancelled' } });
    expect(await m.invoke('lab', 'wait', {}, scope)).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    await m.close(); expect(() => process.kill(f.events()[0]!.pid, 0)).toThrow();
    expect(f.events().filter(e => e.event === 'call' && e.name === 'wait')).toHaveLength(1);
  });

  it('enforces hard call deadlines and blocks unresolvable schemas before dispatch', async () => {
    const f = fixture('legacy', { toolTimeoutMs: 150 }); const m = manager([f.server]); await m.catalog();
    expect(await m.invoke('lab', 'unresolved_schema', { x: 1 }, scope)).toMatchObject({ execution: 'not_started', error: { code: 'unsupported_schema' } });
    const start = Date.now();
    expect(await m.invoke('lab', 'wait', {}, scope)).toMatchObject({ execution: 'unknown', error: { code: 'timeout' } });
    expect(Date.now() - start).toBeLessThan(1_500);
  });

  it('isolates a failed server while keeping another catalog available', async () => {
    const f = fixture(); const m = manager([{ ...f.server, id: 'broken', command: '/no-such-mcp-executable' }, f.server]);
    expect((await m.catalog()).some(t => t.server === 'lab')).toBe(true);
    expect(m.statuses()).toEqual(expect.arrayContaining([expect.objectContaining({ server: 'broken', state: 'error' }), expect.objectContaining({ server: 'lab', state: 'ready' })]));
  });
});
