import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../src/manager.js';
import type { McpElicitationHandler } from '../src/client.js';

const managers: McpManager[] = [], directories: string[] = [];
function fixture(onElicitation?: McpElicitationHandler, toolTimeoutMs = 2_000, humanWaitTimeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'motif-elicit-')); directories.push(dir);
  const log = join(dir, 'events.ndjson');
  const m = new McpManager({ servers: [{ id: 'prompt', enabled: true, transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/client-elicitation.mjs', import.meta.url)), log], startupTimeoutMs: 3_000, toolTimeoutMs }] }, { onElicitation, humanWaitTimeoutMs });
  managers.push(m);
  return { m, events: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; action?: string; content?: unknown }) };
}
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.close())); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scope = { scopeId: 'human-session' };

describe('host-only legacy MCP elicitation', () => {
  it('continues the same tool call after the human explicitly completes URL authorization', async () => {
    const onElicitation = vi.fn<McpElicitationHandler>(async request => {
      expect(request).toMatchObject({ server: 'prompt', mode: 'url', elicitationId: 'fixture-elicitation' });
      if (request.mode === 'url') expect(request.url).toContain('host-only-fixture');
      expect(request.signal.aborted).toBe(false);
      return { action: 'accept' };
    });
    const f = fixture(onElicitation); const result = await f.m.invoke('prompt', 'url', {}, scope);
    expect(result).toMatchObject({ ok: true, result: { content: [{ text: 'human action: accept' }] } });
    expect(onElicitation).toHaveBeenCalledTimes(1);
    expect(f.events().filter(row => row.event === 'call')).toHaveLength(1);
    expect(JSON.stringify({ result, statuses: f.m.statuses() })).not.toContain('host-only-fixture');
  });

  it.each(['decline', 'cancel'] as const)('sends the human %s without accepting or replaying', async action => {
    const f = fixture(async () => ({ action }));
    expect(await f.m.invoke('prompt', 'url', {}, scope)).toMatchObject({ ok: true, result: { content: [{ text: `human action: ${action}` }] } });
    expect(f.events().filter(row => row.event === 'call')).toHaveLength(1);
  });

  it('declines unattended requests explicitly at the protocol boundary', async () => {
    const f = fixture();
    expect(await f.m.invoke('prompt', 'url', {}, scope)).toMatchObject({ ok: true, result: { content: [{ text: 'human action: decline' }] } });
    expect(f.events().find(row => row.event === 'elicitation')?.action).toBe('decline');
  });

  it('validates a human form answer against the original required fields and constraints', async () => {
    const f = fixture(async request => {
      expect(request.mode).toBe('form');
      return { action: 'accept', content: { choice: 'b', count: 2 } };
    });
    expect(await f.m.invoke('prompt', 'form', {}, scope)).toMatchObject({ ok: true });
    expect(f.events().find(row => row.event === 'elicitation')).toMatchObject({ action: 'accept', content: { choice: 'b', count: 2 } });
  });

  it.each([{ choice: 'c', count: 2 }, { choice: 'a', count: 0 }, { choice: 'a' }, { choice: 'a', count: 2, extra: 'unrequested' }])('declines invalid form answers %#', async content => {
    const f = fixture(async () => ({ action: 'accept', content: content as Record<string, string | number> }));
    expect(await f.m.invoke('prompt', 'form', {}, scope)).toMatchObject({ ok: true, result: { content: [{ text: 'human action: decline' }] } });
  });

  it('rejects unsafe URL schemes before calling a browser/UI callback', async () => {
    const callback = vi.fn<McpElicitationHandler>(async () => ({ action: 'accept' }));
    const f = fixture(callback);
    expect(await f.m.invoke('prompt', 'unsafe_url', {}, scope)).toMatchObject({ ok: true, result: { content: [{ text: 'human action: decline' }] } });
    expect(callback).not.toHaveBeenCalled();
  });

  it('declines UI failures without leaking their messages', async () => {
    const f = fixture(async () => { throw new Error('private UI contents'); });
    const result = await f.m.invoke('prompt', 'url', {}, scope);
    expect(result).toMatchObject({ ok: true, result: { content: [{ text: 'human action: decline' }] } });
    expect(JSON.stringify(result)).not.toContain('private UI contents');
  });

  it.each(['accept', 'decline', 'cancel'] as const)('hands off a -32042 URL once after human %s and never replays the dispatched operation', async action => {
    const callback = vi.fn<McpElicitationHandler>(async request => {
      expect(request.mode).toBe('url'); return { action };
    });
    const f = fixture(callback);
    const result = await f.m.invoke('prompt', 'url_error', {}, scope);
    expect(result).toMatchObject({ ok: false, execution: 'unknown', error: { code: 'interaction_required', retryable: false } });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/host-only-fixture|private provider detail|example\.test/);
    expect(await f.m.invoke('prompt', 'url_error', {}, scope)).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.events().filter(row => row.event === 'call')).toHaveLength(1);
  });

  it('cancels a hanging UI and preserves unknown execution instead of retrying', async () => {
    let callbackSignal: AbortSignal | undefined;
    const f = fixture(async request => { callbackSignal = request.signal; return new Promise(() => {}); }, 150, 150);
    await f.m.catalog();
    const result = await f.m.invoke('prompt', 'url', {}, scope);
    expect(result).toMatchObject({ ok: false, execution: 'unknown', error: { code: 'timeout' } });
    expect(callbackSignal?.aborted).toBe(true);
    expect(await f.m.invoke('prompt', 'url', {}, scope)).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    expect(f.events().filter(row => row.event === 'call')).toHaveLength(1);
  });

  it('permits real human waiting beyond the active-work deadline without increasing network time', async () => {
    const f = fixture(async () => { await new Promise(resolve => setTimeout(resolve, 300)); return { action: 'accept' }; }, 180, 800);
    await f.m.catalog();
    const start = Date.now();
    expect(await f.m.invoke('prompt', 'url', {}, scope)).toMatchObject({ ok: true });
    expect(Date.now() - start).toBeGreaterThanOrEqual(290);
    expect(f.events().filter(row => row.event === 'call')).toHaveLength(1);
  });

  it('restores the remaining network deadline after human approval', async () => {
    const f = fixture(async () => { await new Promise(resolve => setTimeout(resolve, 220)); return { action: 'accept' }; }, 150, 800);
    await f.m.catalog();
    const start = Date.now();
    expect(await f.m.invoke('prompt', 'url_wait', {}, scope)).toMatchObject({ execution: 'unknown', error: { code: 'timeout' } });
    expect(Date.now() - start).toBeLessThan(750);
  });

  it('does not extend a network-only call merely because a human callback exists', async () => {
    const callback = vi.fn<McpElicitationHandler>(async () => ({ action: 'accept' }));
    const f = fixture(callback, 150, 800); await f.m.catalog();
    const start = Date.now();
    expect(await f.m.invoke('prompt', 'wait', {}, scope)).toMatchObject({ error: { code: 'timeout' } });
    expect(Date.now() - start).toBeLessThan(700);
    expect(callback).not.toHaveBeenCalled();
  });

  it('bounds the total human allowance across multiple requests within one call', async () => {
    const callback = vi.fn<McpElicitationHandler>(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { action: 'accept' }; });
    const f = fixture(callback, 200, 150); await f.m.catalog();
    expect(await f.m.invoke('prompt', 'double_url', {}, scope)).toMatchObject({ execution: 'unknown', error: { code: 'timeout' } });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(f.events().filter(row => row.event === 'call')).toHaveLength(1);
  });

  it('declines an ambiguous concurrent elicitation instead of pausing another call', async () => {
    const callback = vi.fn<McpElicitationHandler>(async () => ({ action: 'accept' }));
    const f = fixture(callback, 250, 800); await f.m.catalog();
    const waiting = f.m.invoke('prompt', 'wait', {}, scope);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await f.m.invoke('prompt', 'url', {}, scope)).toMatchObject({ ok: true, result: { content: [{ text: 'human action: decline' }] } });
    expect(callback).not.toHaveBeenCalled();
    expect(await waiting).toMatchObject({ error: { code: 'timeout' } });
  });

  it('cancels human waiting immediately on an explicit abort without granting the request', async () => {
    let ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    let uiSignal: AbortSignal | undefined;
    const f = fixture(async request => { uiSignal = request.signal; ready(); return new Promise(() => {}); }, 500, 1000);
    await f.m.catalog();
    const controller = new AbortController();
    const pending = f.m.invoke('prompt', 'url', {}, { ...scope, signal: controller.signal });
    await entered; controller.abort();
    expect(await pending).toMatchObject({ execution: 'unknown', error: { code: 'cancelled' } });
    expect(uiSignal?.aborted).toBe(true);
    expect(f.events().some(row => row.action === 'accept')).toBe(false);
  });

  it('does not fulfil modern input_required URLs or replay their original call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'motif-modern-input-')); directories.push(directory);
    const log = join(directory, 'events.ndjson');
    const callback = vi.fn<McpElicitationHandler>(async () => ({ action: 'accept' }));
    const manager = new McpManager({ servers: [{ id: 'modern', enabled: true, transport: 'stdio', protocol: 'modern', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/client-modern.mjs', import.meta.url)), log], startupTimeoutMs: 3000 }] }, { onElicitation: callback });
    managers.push(manager);
    const result = await manager.invoke('modern', 'input', {}, scope);
    expect(result).toMatchObject({ execution: 'unknown', error: { code: 'interaction_required' } });
    expect(callback).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/modern-private|opaque-fixture-state|example\.test/);
    expect(await manager.invoke('modern', 'input', {}, scope)).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    const events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string });
    expect(events.filter(row => row.event === 'call')).toHaveLength(1);
  });
});
