import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpManager } from '../src/manager.js';
import { McpAuthError } from '../src/auth.js';
import type { McpAuthorization } from '../src/client.js';
import { parseMcpConfig } from '../src/config.js';

const managers: McpManager[] = [];
const cleanups: (() => Promise<void>)[] = [];
const tool = { name: 'write_once', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
async function fixture(rejectCall = false) {
  const requests: { method: string; authorization?: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void (async () => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let text = ''; for await (const part of req) text += String(part);
    const request = JSON.parse(text) as { id?: number; method: string };
    requests.push({ method: request.method, authorization: req.headers.authorization });
    if (request.method === 'tools/call' && rejectCall) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token", error_description="private-fixture"' }); res.end('private-fixture'); return; }
    if (request.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1' } }
      : request.method === 'tools/list' ? { tools: [tool] }
      : { content: [{ type: 'text', text: 'completed' }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  })().catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, requests };
}
function manager(url: string, auth: McpAuthorization, headers?: Record<string, string>) {
  const result = new McpManager({ servers: [{ id: 'oauth', enabled: true, transport: 'http', url, headers, startupTimeoutMs: 1_000, toolTimeoutMs: 1_000 }] }, { auth });
  managers.push(result); return result;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(item => item.close()));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('OAuth credentials on ordinary MCP operations', () => {
  it('uses host credentials for initialize, discovery and calls and picks up a refreshed token before dispatch', async () => {
    const f = await fixture(); let current = 'first-token';
    const token = vi.fn(async () => current);
    const m = manager(f.url, { token });
    expect(await m.catalog()).toHaveLength(1);
    expect(f.requests.every(row => row.authorization === 'Bearer first-token')).toBe(true);
    current = 'refreshed-token';
    expect(await m.invoke('oauth', 'write_once', {}, { scopeId: 'test' })).toMatchObject({ ok: true });
    expect(f.requests.filter(row => row.method === 'tools/call')).toEqual([{ method: 'tools/call', authorization: 'Bearer refreshed-token' }]);
    expect(token).toHaveBeenCalledWith(expect.objectContaining({ id: 'oauth', url: f.url }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(m.statuses())).not.toContain('token');
  });

  it('keeps an expired-token refresh failure before dispatch retryable only as a new explicit request', async () => {
    const f = await fixture(); let expired = false;
    const m = manager(f.url, { token: async () => { if (expired) throw new McpAuthError('authentication_required', 'private refresh detail'); return 'first-token'; } });
    await m.catalog(); expired = true;
    const failure = await m.invoke('oauth', 'write_once', {}, { scopeId: 'test' });
    expect(failure).toMatchObject({ ok: false, execution: 'not_started', error: { code: 'authentication_required', retryable: false } });
    expect(JSON.stringify(failure)).not.toContain('private refresh detail');
    expect(f.requests.filter(row => row.method === 'tools/call')).toHaveLength(0);
    expired = false;
    expect(await m.invoke('oauth', 'write_once', {}, { scopeId: 'test' })).toMatchObject({ ok: true });
    expect(f.requests.filter(row => row.method === 'tools/call')).toHaveLength(1);
  });

  it('never refreshes or replays a dispatched tool after HTTP 401, including after reconnect', async () => {
    const f = await fixture(true); const token = vi.fn(async () => 'stored-token');
    const m = manager(f.url, { token });
    const result = await m.invoke('oauth', 'write_once', {}, { scopeId: 'test' });
    expect(result).toMatchObject({ execution: 'unknown', error: { code: 'authentication_required', retryable: false } });
    expect(JSON.stringify(result)).not.toContain('private-fixture');
    const count = token.mock.calls.length;
    expect(await m.invoke('oauth', 'write_once', {}, { scopeId: 'other' })).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    expect(token.mock.calls).toHaveLength(count);
    await m.reconnect('oauth');
    expect(await m.invoke('oauth', 'write_once', {}, { scopeId: 'other' })).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    expect(f.requests.filter(row => row.method === 'tools/call')).toHaveLength(1);
  });

  it('preserves an explicit environment-resolved header without consulting saved login state', async () => {
    const f = await fixture(); const token = vi.fn(async () => 'wrong-account');
    const m = manager(f.url, { token }, { authorization: 'Bearer explicit' });
    expect(await m.invoke('oauth', 'write_once', {}, { scopeId: 'test' })).toMatchObject({ ok: true });
    expect(token).not.toHaveBeenCalled();
    expect(f.requests.every(row => row.authorization === 'Bearer explicit')).toBe(true);
  });

  it('rejects invalid stored token bytes before any HTTP request', async () => {
    const f = await fixture(); const m = manager(f.url, { token: async () => 'token\r\nInjected: yes' });
    expect(await m.catalog()).toEqual([]);
    expect(m.statuses()[0]).toMatchObject({ state: 'error', error: { code: 'authentication_required' } });
    expect(f.requests).toHaveLength(0);
  });

  it('preserves a clear authentication diagnostic for an SSE preflight refresh failure', async () => {
    const f = await fixture();
    const m = new McpManager({ servers: [{ id: 'sse', enabled: true, transport: 'sse', url: f.url }] }, {
      auth: { token: async () => { throw new McpAuthError('authentication_required', 'private refresh detail'); } },
    });
    managers.push(m);
    expect(await m.catalog()).toEqual([]);
    expect(m.statuses()[0]).toMatchObject({ error: { code: 'authentication_required' } });
    expect(JSON.stringify(m.statuses())).not.toContain('private refresh detail');
    expect(f.requests).toHaveLength(0);
  });

  it('does not impose OAuth URL requirements on a public HTTP server without saved OAuth', async () => {
    const f = await fixture();
    // This injected transport reaches only the local fixture, never this host.
    const m = new McpManager({ servers: [{ id: 'public', enabled: true, transport: 'http', url: 'http://public.example.test/mcp' }] }, {
      fetch: async (_input, init) => fetch(f.url, init),
    });
    managers.push(m);
    expect(await m.catalog()).toHaveLength(1);
    expect(f.requests.every(row => row.authorization === undefined)).toBe(true);
  });
});

describe('public OAuth configuration', () => {
  const parse = (entry: unknown) => parseMcpConfig(JSON.stringify({ servers: { server: entry } }));
  const http = { transport: 'http', url: 'https://example.test/mcp' };
  it('accepts public client metadata without resolving credentials', () => {
    const result = parse({ ...http, oauth: { clientId: 'motif-public', clientMetadataUrl: 'https://client.test/metadata.json', scope: 'read write', callbackPort: 8123 } });
    expect(result.diagnostics).toEqual([]);
    expect(result.servers[0]?.oauth).toMatchObject({ clientId: 'motif-public', callbackPort: 8123 });
  });
  it.each([
    { ...http, oauth: { clientSecret: 'must-not-be-configured' } },
    { ...http, oauth: { clientId: '${CLIENT_ID}' } },
    { ...http, oauth: { clientMetadataUrl: 'http://remote.test/metadata' } },
    { ...http, oauth: { clientMetadataUrl: 'https://user:password@client.test/metadata' } },
    { ...http, oauth: { callbackPort: 0 } },
    { ...http, oauth: { scope: 'read\nwrite' } },
    { ...http, oauth: {}, headers: { Authorization: { env: 'TOKEN' } } },
    { transport: 'stdio', command: 'server', oauth: {} },
  ])('rejects conflicting/private/invalid configuration %#', entry => {
    const result = parse(entry); expect(result.servers).toEqual([]); expect(result.diagnostics.some(row => row.severity === 'error')).toBe(true);
    expect(JSON.stringify(result.diagnostics)).not.toContain('must-not-be-configured');
  });
});
