import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../src/manager.js';
import { McpSession } from '../src/session.js';
import { loadMcpConfig, type McpServerConfig } from '../src/config.js';

const managers: McpManager[] = [];
const sessions: McpSession[] = [];
const directories: string[] = [];
const scope = { scopeId: 'controls-test' };
function fixture(id = 'lab') {
  const dir = mkdtempSync(join(tmpdir(), 'motif-controls-')); directories.push(dir);
  const log = join(dir, 'events.ndjson');
  const server: McpServerConfig = { id, enabled: true, transport: 'stdio', protocol: 'legacy',
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/client-legacy.mjs', import.meta.url)), log],
    startupTimeoutMs: 3_000, toolTimeoutMs: 2_000, catalogTtlMs: 60_000 };
  const events = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { event: string; name?: string; pid: number }) : [];
  return { dir, server, events };
}
function manager(servers: McpServerConfig[]) { const result = new McpManager({ servers }); managers.push(result); return result; }
async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Fixture did not reach the expected state.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
afterEach(async () => {
  await Promise.all([...sessions.splice(0).map(s => s.close()), ...managers.splice(0).map(m => m.close())]);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('human MCP connection controls with real SDK clients', () => {
  it('lists safe immutable configuration status and cannot enable disabled or untrusted entries', async () => {
    const f = fixture();
    const server = { ...f.server, enabled: false, profile: 'playwright' as const, env: { SECRET: 'synthetic-hidden' } };
    const m = manager([server]); server.enabled = true; server.transport = 'http';
    expect(m.statuses()).toEqual([{ server: 'lab', transport: 'stdio', enabled: false, profile: 'playwright', state: 'disabled', toolCount: 0 }]);
    for (const operation of [m.connect('lab'), m.reconnect('lab'), m.disconnect('lab'), m.connect('unknown')]) {
      await expect(operation).rejects.toMatchObject({ code: 'server_not_allowed' });
    }
    const configFile = join(f.dir, 'untrusted.json');
    writeFileSync(configFile, JSON.stringify({ version: 1, servers: [f.server] }));
    const untrusted = new McpManager(loadMcpConfig({ path: configFile })); managers.push(untrusted);
    await expect(untrusted.connect('lab')).rejects.toMatchObject({ code: 'server_not_allowed' });
    expect(await m.catalog()).toEqual([]);
    expect(f.events()).toEqual([]);
    expect(JSON.stringify(m.statuses())).not.toContain('synthetic-hidden');
    const statuses = m.statuses(); statuses[0]!.state = 'ready';
    expect(m.statuses()[0]!.state).toBe('disabled');
  });

  it('pauses idle servers without spawning and model discovery or calls cannot resume them', async () => {
    const f = fixture(); const m = manager([f.server]);
    expect(await m.disconnect('lab')).toMatchObject({ state: 'paused', toolCount: 0 });
    expect(await m.catalog({ refresh: true })).toEqual([]);
    expect(await m.getTool('lab', 'echo')).toBeUndefined();
    expect(await m.invoke('lab', 'echo', { text: 'no dispatch' }, scope)).toMatchObject({ execution: 'not_started', error: { code: 'tool_not_allowed' } });
    expect(f.events()).toEqual([]);
    expect(await m.connect('lab')).toMatchObject({ state: 'ready', toolCount: 7 });
    expect(f.events().filter(event => event.event === 'call')).toHaveLength(0);
  });

  it('coalesces connects, disconnects only the chosen server, and reconnects with a fresh child', async () => {
    const a = fixture('a'), b = fixture('b'); const m = manager([a.server, b.server]);
    await Promise.all([m.connect('a'), m.connect('a'), m.connect('b')]);
    expect(a.events().filter(event => event.event === 'boot')).toHaveLength(1);
    const oldPid = a.events()[0]!.pid, keptPid = b.events()[0]!.pid;
    await m.disconnect('a');
    expect(() => process.kill(oldPid, 0)).toThrow();
    expect(() => process.kill(keptPid, 0)).not.toThrow();
    expect((await m.catalog()).every(tool => tool.server === 'b')).toBe(true);
    expect(await m.reconnect('a')).toMatchObject({ state: 'ready', toolCount: 7 });
    expect(a.events().filter(event => event.event === 'boot')).toHaveLength(2);
    expect(await m.invoke('b', 'echo', { text: 'kept' }, scope)).toMatchObject({ ok: true });
  });

  it('cancels an active operation on disconnect and retains its unknown outcome across reconnect and scopes', async () => {
    const f = fixture(); const m = manager([f.server]); await m.connect('lab');
    const pending = m.invoke('lab', 'wait', {}, scope);
    await waitFor(() => f.events().some(event => event.event === 'call' && event.name === 'wait'));
    await m.disconnect('lab');
    expect(await pending).toMatchObject({ execution: 'unknown', error: { code: 'cancelled' } });
    expect(m.statuses()[0]!.state).toBe('paused');
    await m.connect('lab');
    expect(await m.invoke('lab', 'wait', {}, { scopeId: 'new-child' })).toMatchObject({ execution: 'not_started', error: { code: 'previous_execution_unknown' } });
    await m.reconnect('lab');
    expect(await m.invoke('lab', 'wait', {}, scope)).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    expect(f.events().filter(event => event.event === 'call' && event.name === 'wait')).toHaveLength(1);
    expect(await m.invoke('lab', 'echo', { text: 'other arguments still usable' }, scope)).toMatchObject({ ok: true });
  });

  it('retains lost acknowledgements after a manual reconnect', async () => {
    const f = fixture(); const m = manager([f.server]);
    expect(await m.invoke('lab', 'lose_ack', {}, scope)).toMatchObject({ execution: 'unknown' });
    await m.reconnect('lab');
    expect(await m.invoke('lab', 'lose_ack', {}, scope)).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    expect(f.events().filter(event => event.event === 'call')).toHaveLength(1);
  });

  it('rejects a reconnect superseded by disconnect and never resurrects paused connections', async () => {
    const f = fixture(); const m = manager([f.server]); await m.connect('lab');
    const reconnect = m.reconnect('lab').then(() => 'connected', error => (error as { code: string }).code);
    await m.disconnect('lab');
    expect(await reconnect).toBe('cancelled');
    expect(m.statuses()[0]!.state).toBe('paused');
    expect(await m.catalog()).toEqual([]);
    expect(f.events().filter(event => event.event === 'boot')).toHaveLength(1);
  });

  it('prevents interrupted startup from overwriting the status of a newer connection', async () => {
    let initialize = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const message = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      if (message.method === 'initialize' && ++initialize === 1) return new Promise<Response>(() => {});
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'controls', version: '1' } }
        : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'Content-Type': 'application/json' } });
    };
    const m = new McpManager({ servers: [{ id: 'web', enabled: true, transport: 'http', url: 'http://127.0.0.1:1/mcp', startupTimeoutMs: 2_000, toolTimeoutMs: 1_000 }] }, { fetch: fetchImpl }); managers.push(m);
    const first = m.connect('web').then(() => 'connected', error => (error as { code: string }).code);
    await waitFor(() => initialize === 1);
    expect(m.statuses()[0]!.state).toBe('connecting');
    const pause = m.disconnect('web');
    const second = m.connect('web');
    await pause;
    expect(await first).toBe('cancelled');
    expect(await second).toMatchObject({ state: 'ready', toolCount: 1 });
    expect(m.statuses()[0]!.state).toBe('ready');
    expect(initialize).toBe(2);
  });

  it('cancels one startup waiter without interrupting another and still reaps the shared child on close', async () => {
    const f = fixture();
    const started = join(f.dir, 'started');
    const wrapper = join(f.dir, 'delayed-start.mjs');
    writeFileSync(wrapper, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(started)}, String(process.pid));\nawait new Promise(resolve => setTimeout(resolve, 200));\nawait import(${JSON.stringify(new URL('./fixtures/client-legacy.mjs', import.meta.url).href)});\n`);
    const m = manager([{ ...f.server, args: [wrapper, f.server.args![1]!] }]);
    const controller = new AbortController();
    const cancelled = m.connect('lab', controller.signal).then(() => 'connected', error => (error as { code: string }).code);
    const kept = m.connect('lab');
    await waitFor(() => existsSync(started)); controller.abort();
    expect(await cancelled).toBe('cancelled');
    expect(m.statuses()[0]!.state).toBe('connecting');
    expect(await kept).toMatchObject({ state: 'ready', toolCount: 7 });
    expect(f.events().filter(event => event.event === 'boot')).toHaveLength(1);
    const pid = Number(readFileSync(started, 'utf8'));
    await m.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(m.statuses()[0]!.state).toBe('closed');
  });

  it('makes repeated shutdown idempotent during startup and supersedes pending reconnect', async () => {
    const f = fixture(); const m = manager([f.server]);
    const startup = m.connect('lab').then(() => 'connected', error => (error as { code: string }).code);
    const firstClose = m.close();
    expect(m.close()).toBe(firstClose);
    await firstClose; expect(await startup).toBe('cancelled');
    expect(m.statuses()[0]!.state).toBe('closed');
    expect(await m.catalog()).toEqual([]);
    await expect(m.connect('lab')).rejects.toMatchObject({ code: 'manager_closed' });
    await expect(m.reconnect('lab')).rejects.toMatchObject({ code: 'manager_closed' });
    expect(f.events()).toEqual([]);
  });

  it('refreshes session discovery after controls without exposing lifecycle operations to the model', async () => {
    const f = fixture(); const session = new McpSession({ servers: [f.server] }); sessions.push(session);
    await session.prepare('echo text');
    const reply = JSON.stringify({ server: 'lab', method: 'echo', args: { text: 'hello' } });
    expect(session.replyRecovery(reply)).toBeTypeOf('string');
    await session.disconnect('lab');
    expect(session.replyRecovery(reply)).toBeUndefined();
    expect(await session.invoke('__motif_host__', 'connect', { server: 'lab' }, scope)).toMatchObject({ ok: false });
    const paused = await session.prepare('echo text');
    expect(paused).toContain('"state":"paused"');
    expect(session.replyRecovery(reply)).toBeUndefined();
    await session.connect('lab');
    await session.prepare('echo text');
    expect(session.statuses()[0]).toMatchObject({ state: 'ready', toolCount: 7 });
    expect(session.replyRecovery(reply)).toBeTypeOf('string');
    expect(f.events().filter(event => event.event === 'call')).toHaveLength(0);
  });
});
