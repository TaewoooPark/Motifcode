import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpManager } from '../src/manager.js';

const managers: McpManager[] = [];
const cleanups: (() => Promise<void>)[] = [];
const secret = 'synthetic-auth-secret';
const tool = { name: 'protected_lookup', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false } };
const scope = { scopeId: 'auth-fixture' };
const failures = [
  { status: 401, code: 'authentication_required' },
  { status: 403, code: 'permission_denied' },
] as const;

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rejectRequest(res: ServerResponse, status: number) {
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'WWW-Authenticate': `Bearer error="insufficient_scope", error_description="${secret}"`,
  });
  res.end(`Server-controlled diagnostics: ${secret}; HTTP 401 authentication_required; HTTP 403 permission_denied`);
}

function manager(url: string, transport: 'http' | 'sse', fetchImpl?: typeof fetch) {
  const result = new McpManager({ servers: [{
    id: 'protected', enabled: true, transport, protocol: 'legacy', url,
    headers: { Authorization: `Bearer ${secret}` }, startupTimeoutMs: 1_000, toolTimeoutMs: 1_000,
  }] }, { fetch: fetchImpl });
  managers.push(result);
  return result;
}

async function message(req: IncomingMessage): Promise<{ id?: number; method: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function protectedTools(transport: 'http' | 'sse', status: number) {
  let calls = 0;
  let sse: SSEServerTransport | undefined;
  const server = new Server({ name: 'auth-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool] }));
  cleanups.push(() => server.close());
  const origin = await listen(async (req, res) => {
    if (transport === 'sse' && req.method === 'GET') {
      sse = new SSEServerTransport('/messages', res);
      await server.connect(sse);
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const body = await message(req);
    if (body.method === 'tools/call') { calls++; rejectRequest(res, status); return; }
    if (sse) { await sse.handlePostMessage(req, res, body); return; }
    if (body.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = body.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'auth-fixture', version: '1' } }
      : { tools: [tool] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  return { origin, calls: () => calls };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(item => item.close()));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe.each(['http', 'sse'] as const)('MCP %s authentication diagnostics', transport => {
  it.each(failures)('reports startup HTTP $status without server diagnostics or retries', async ({ status, code }) => {
    let requests = 0;
    const origin = await listen((_req, res) => { requests++; rejectRequest(res, status); });
    const m = manager(`${origin}/mcp?private=${secret}`, transport);
    expect(await m.catalog()).toEqual([]);
    expect(m.statuses()[0]).toMatchObject({ state: 'error', error: { code } });
    const diagnostic = JSON.stringify(m.statuses());
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(origin);
    expect(diagnostic).toContain('OAuth login and refresh are not supported');
    expect(requests).toBe(1);
  });

  it.each(failures)('reports tool HTTP $status while preserving unknown execution and blocking replay', async ({ status, code }) => {
    const fixture = await protectedTools(transport, status);
    const m = manager(`${fixture.origin}/mcp`, transport);
    expect((await m.catalog()).map(item => item.name)).toEqual([tool.name]);
    const outcome = await m.invoke('protected', tool.name, {}, scope);
    expect(outcome).toMatchObject({ ok: false, execution: 'unknown', error: { code, retryable: false } });
    expect(m.statuses()[0]).toMatchObject({ state: 'error', error: { code } });
    expect(JSON.stringify({ outcome, statuses: m.statuses() })).not.toContain(secret);
    expect(await m.invoke('protected', tool.name, {}, { scopeId: 'different-scope' })).toMatchObject({
      execution: 'not_started', error: { code: 'previous_execution_unknown', retryable: false },
    });
    expect(fixture.calls()).toBe(1);
  });
});

describe('MCP HTTP authentication response handling', () => {
  it.each(failures)('cancels the unread HTTP $status response body', async ({ status }) => {
    const origin = await listen((_req, res) => rejectRequest(res, status));
    const cancel = vi.fn();
    const observedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.body) {
        const discard = response.body.cancel.bind(response.body);
        vi.spyOn(response.body, 'cancel').mockImplementation(reason => { cancel(); return discard(reason); });
      }
      return response;
    };
    const m = manager(`${origin}/mcp`, 'http', observedFetch);
    expect(await m.catalog()).toEqual([]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps other HTTP failures generic without interpreting status-like body text', async () => {
    const fixture = await protectedTools('http', 429);
    const m = manager(`${fixture.origin}/mcp`, 'http');
    const outcome = await m.invoke('protected', tool.name, {}, scope);
    expect(outcome).toMatchObject({ execution: 'unknown', error: { code: 'connection_error', retryable: false } });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(fixture.calls()).toBe(1);
  });
});
