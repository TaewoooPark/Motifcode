import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpManager } from '../src/manager.js';
import type { McpServerConfig } from '../src/config.js';

const managers: McpManager[] = [];
const cleanups: (() => Promise<void>)[] = [];
const empty = { type: 'object' as const, properties: {}, additionalProperties: false };
const scope = { scopeId: 'http-session' };
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) {
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function manager(url: string, extra: Partial<McpServerConfig> = {}, fetchImpl?: typeof fetch) {
  const m = new McpManager({ servers: [{ id: 'web', enabled: true, transport: 'http', protocol: 'legacy', url,
    startupTimeoutMs: 1_000, toolTimeoutMs: 1_000, ...extra }] }, { fetch: fetchImpl });
  managers.push(m); return m;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(m => m.close()));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('MCP HTTP transport boundaries', () => {
  it.each(['legacy', 'modern'] as const)('uses real %s HTTP, walks pagination and preserves business results', async protocol => {
    const calls: string[] = [];
    const headers: (string | undefined)[] = [];
    const handler = createMcpHandler(() => {
      const s = new Server({ name: 'http-fixture', version: '1' }, { capabilities: { tools: {} } });
      s.setRequestHandler('tools/list', request => Object.hasOwn(request.params ?? {}, 'cursor')
        ? { tools: [{ name: 'business', inputSchema: empty }], ttlMs: 60_000 }
        : { tools: [{ name: 'echo', inputSchema: empty }], nextCursor: '', ttlMs: 60_000 });
      s.setRequestHandler('tools/call', request => {
        calls.push(request.params.name);
        return { content: [{ type: 'text', text: 'completed' }], isError: request.params.name === 'business', structuredContent: { kept: false } };
      });
      return s;
    }, { legacy: 'stateless', responseMode: 'auto', keepAliveMs: 0 });
    cleanups.push(() => handler.close());
    const origin = await listen(async (req, res) => {
      headers.push(req.headers.authorization);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const controller = new AbortController(); res.once('close', () => controller.abort());
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks).toString() : undefined, signal: controller.signal });
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) { const reader = response.body.getReader(); for (;;) { const next = await reader.read(); if (next.done) break; res.write(next.value); } }
      res.end();
    });
    const m = manager(`${origin}/mcp`, { protocol, headers: { Authorization: 'Bearer synthetic-fixture' } });
    expect((await m.catalog()).map(t => t.name)).toEqual(['echo', 'business']);
    expect(await m.invoke('web', 'echo', {}, scope)).toMatchObject({ ok: true, result: { structuredContent: { kept: false } } });
    expect(await m.invoke('web', 'business', {}, scope)).toMatchObject({ ok: true, isError: true });
    expect(calls).toEqual(['echo', 'business']);
    expect(headers.length).toBeGreaterThan(2);
    expect(headers.every(value => value === 'Bearer synthetic-fixture')).toBe(true);
  });

  it('connects legacy SSE only when explicitly configured', async () => {
    let transport: SSEServerTransport | undefined;
    let calls = 0;
    const auth: (string | undefined)[] = [];
    const s = new LegacyServer({ name: 'sse-fixture', version: '1' }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'echo', inputSchema: empty }] }));
    s.setRequestHandler(CallToolRequestSchema, () => { calls++; return { content: [{ type: 'text', text: 'sse' }] }; });
    cleanups.push(() => s.close());
    const origin = await listen(async (req, res) => {
      auth.push(req.headers.authorization);
      if (req.method === 'GET' && req.url === '/sse') { transport = new SSEServerTransport('/messages', res); await s.connect(transport); }
      else if (req.method === 'POST' && req.url?.startsWith('/messages') && transport) await transport.handlePostMessage(req, res);
      else { res.writeHead(404); res.end(); }
    });
    const m = manager(`${origin}/sse`, { transport: 'sse', headers: { Authorization: 'Bearer synthetic-sse' } });
    expect((await m.catalog()).map(t => t.name)).toEqual(['echo']);
    expect(await m.invoke('web', 'echo', {}, scope)).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    expect(auth.every(value => value === 'Bearer synthetic-sse')).toBe(true);
  });

  it('rejects redirects without sending credentials to the destination', async () => {
    let destinationHits = 0;
    const destination = await listen((_req, res) => { destinationHits++; res.end(); });
    const origin = await listen((_req, res) => { res.writeHead(307, { Location: `${destination}/steal` }); res.end(); });
    const m = manager(`${origin}/mcp`, { headers: { Authorization: 'Bearer synthetic-secret' } });
    expect(await m.catalog()).toEqual([]);
    expect(m.statuses()[0]?.state).toBe('error');
    expect(destinationHits).toBe(0);
  });

  it('does not replay a tool call whose HTTP response is lost', async () => {
    let callCount = 0;
    const origin = await listen(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
      if (message.method === 'tools/call') { callCount++; res.destroy(); return; }
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'lost-ack', version: '1' } }
        : { tools: [{ name: 'write_once', inputSchema: empty }] };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    const m = manager(`${origin}/mcp`);
    expect(await m.invoke('web', 'write_once', {}, scope)).toMatchObject({ execution: 'unknown' });
    expect(await m.invoke('web', 'write_once', {}, scope)).toMatchObject({ execution: 'not_started', error: { code: 'previous_execution_unknown' } });
    expect(callCount).toBe(1);
  });

  it('enforces startup deadlines even when a supplied fetch ignores cancellation', async () => {
    const m = manager('http://127.0.0.1:1/mcp', { startupTimeoutMs: 60 }, () => new Promise<Response>(() => {}));
    const start = Date.now();
    expect(await m.catalog()).toEqual([]);
    await m.close();
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(m.statuses()[0]?.state).toBe('closed');
  });
});
