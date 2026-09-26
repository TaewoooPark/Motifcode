import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtocolError, Server, createMcpHandler } from '@modelcontextprotocol/server';
import { Server as LegacyServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { McpManager } from '../src/manager.js';
import { McpAuthError } from '../src/auth.js';
import type { McpAuthorization } from '../src/client.js';

type Wire = 'legacy' | 'modern' | 'sse';
const managers: McpManager[] = [];
const cleanups: (() => Promise<void>)[] = [];
const scope = { scopeId: 'dispatch-test' };
const inputSchema = { type: 'object' as const, properties: { tag: { type: 'string' } }, additionalProperties: false };

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(wire: Wire, auth?: McpAuthorization, beforeResult?: () => Promise<void>) {
  const state = { invalidSchema: false, invalidResult: false, reject: false, calls: 0 };
  const tools = () => ({ tools: [{ name: 'write_once', inputSchema, outputSchema: state.invalidSchema
    ? { type: 'object' as const, properties: { answer: { $ref: 'https://example.invalid/unavailable-schema' } } }
    : { type: 'object' as const, properties: { answer: { type: 'integer' } }, required: ['answer'] } }], ttlMs: 60_000 });
  const call = async () => {
    state.calls++; await beforeResult?.();
    if (state.reject) throw wire === 'sse' ? new McpError(-32602, 'No record with that id') : new ProtocolError(-32602, 'No record with that id');
    return { content: [{ type: 'text' as const, text: 'completed' }], structuredContent: { answer: state.invalidResult ? 'wrong type' : 42 } };
  };
  let origin: string;
  let route: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  if (wire === 'sse') {
    let transport: SSEServerTransport | undefined;
    route = async (req, res) => {
      if (req.method === 'GET' && req.url === '/mcp') {
        const server = new LegacyServer({ name: 'dispatch-sse', version: '1' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, tools);
        server.setRequestHandler(CallToolRequestSchema, call);
        cleanups.push(() => server.close());
        transport = new SSEServerTransport('/messages', res);
        await server.connect(transport);
      } else if (req.method === 'POST' && req.url?.startsWith('/messages') && transport) await transport.handlePostMessage(req, res);
      else { res.writeHead(404); res.end(); }
    };
  } else {
    const handler = createMcpHandler(() => {
      const server = new Server({ name: 'dispatch-http', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', tools);
      server.setRequestHandler('tools/call', call);
      return server;
    }, { legacy: 'stateless', responseMode: 'auto', keepAliveMs: 0 });
    cleanups.push(() => handler.close());
    route = async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const controller = new AbortController(); res.once('close', () => controller.abort());
      const response = await handler.fetch(new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks).toString() : undefined, signal: controller.signal }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) { const reader = response.body.getReader(); for (;;) { const next = await reader.read(); if (next.done) break; res.write(next.value); } }
      res.end();
    };
  }
  const http = createServer((req, res) => { void route(req, res).catch(() => res.destroy()); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const manager = new McpManager({ servers: [{ id: 'lab', enabled: true, transport: wire === 'sse' ? 'sse' : 'http',
    protocol: wire === 'modern' ? 'modern' : 'legacy', url: `${origin}/mcp`, startupTimeoutMs: 2_000, toolTimeoutMs: 2_000 }] }, { auth });
  managers.push(manager);
  return { state, manager };
}

describe('actual MCP tool dispatch boundary', () => {
  it.each(['legacy', 'modern', 'sse'] as const)('allows an explicit retry after fixing a %s output-schema preflight failure', async wire => {
    const { manager, state } = await fixture(wire);
    state.invalidSchema = true;
    expect(await manager.invoke('lab', 'write_once', {}, scope)).toMatchObject({ ok: false, execution: 'not_started' });
    expect(state.calls).toBe(0);
    state.invalidSchema = false;
    await manager.reconnect('lab');
    expect(await manager.invoke('lab', 'write_once', {}, scope)).toMatchObject({ ok: true, execution: 'completed' });
    expect(state.calls).toBe(1);
  });

  it.each(['legacy', 'modern', 'sse'] as const)('checks %s credentials once at send and permits an explicit retry after failure', async wire => {
    let checks: number | undefined;
    let reject = true;
    const { manager, state } = await fixture(wire, { token: async () => {
      if (checks !== undefined) { checks++; if (reject) throw new McpAuthError('authentication_required', 'synthetic refresh failure'); }
      return 'synthetic-token';
    } });
    await manager.catalog();
    checks = 0;
    const result = await manager.invoke('lab', 'write_once', {}, scope);
    expect(checks).toBe(1);
    expect(result).toMatchObject({ ok: false, execution: 'not_started', error: { code: 'authentication_required' } });
    expect(JSON.stringify(result)).not.toContain('synthetic refresh failure');
    expect(state.calls).toBe(0);
    reject = false;
    // A transport error invalidates discovery. Refresh before counting only
    // the successful tools/call, which must not prepare a short-lived token twice.
    checks = undefined; await manager.catalog(); checks = 0;
    expect(await manager.invoke('lab', 'write_once', {}, scope)).toMatchObject({ ok: true });
    expect(checks).toBe(1);
    expect(state.calls).toBe(1);
  });

  it.each(['legacy', 'modern', 'sse'] as const)('still blocks replay after a sent %s call returns an invalid result', async wire => {
    const { manager, state } = await fixture(wire);
    state.invalidResult = true;
    expect(await manager.invoke('lab', 'write_once', {}, scope)).toMatchObject({ ok: false, execution: 'unknown' });
    expect(state.calls).toBe(1);
    state.invalidResult = false;
    await manager.reconnect('lab');
    expect(await manager.invoke('lab', 'write_once', {}, { scopeId: 'another-scope' })).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    expect(state.calls).toBe(1);
  });

  it.each(['legacy', 'modern', 'sse'] as const)('reports a %s JSON-RPC rejection as a completed error without blocking a retry', async wire => {
    const { manager, state } = await fixture(wire);
    state.reject = true;
    const rejected = await manager.invoke('lab', 'write_once', {}, scope);
    expect(rejected).toMatchObject({ ok: true, execution: 'completed', isError: true });
    expect(JSON.stringify(rejected)).toContain('No record with that id');
    expect(manager.statuses()[0]).toMatchObject({ state: 'ready' });
    state.reject = false;
    expect(await manager.invoke('lab', 'write_once', {}, scope)).toMatchObject({ ok: true, execution: 'completed', isError: false });
    expect(state.calls).toBe(2);
  });

  it.each(['legacy', 'modern'] as const)('distinguishes %s stdio schema preparation from a written request', async protocol => {
    const dir = mkdtempSync(join(tmpdir(), 'motif-dispatch-'));
    cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
    const flag = join(dir, 'schema-fixed'); const log = join(dir, 'calls');
    const script = `
      import { existsSync, appendFileSync } from 'node:fs';
      import { Server } from '@modelcontextprotocol/server';
      import { serveStdio } from '@modelcontextprotocol/server/stdio';
      serveStdio(() => {
        const server = new Server({ name: 'dispatch-stdio', version: '1' }, { capabilities: { tools: {} } });
        server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'write_once', inputSchema: { type: 'object' },
          outputSchema: existsSync(${JSON.stringify(flag)}) ? { type: 'object' } : { type: 'object', properties: { value: { $ref: 'https://example.invalid/missing' } } }
        }], ttlMs: 60000 }));
        server.setRequestHandler('tools/call', () => {
          appendFileSync(${JSON.stringify(log)}, 'call\\n');
          return { content: [{ type: 'text', text: 'written' }], structuredContent: {} };
        });
        return server;
      }, { legacy: 'accept' });
    `;
    const manager = new McpManager({ servers: [{ id: 'lab', enabled: true, transport: 'stdio', protocol,
      command: process.execPath, args: ['--input-type=module', '--eval', script], cwd: fileURLToPath(new URL('..', import.meta.url)),
      startupTimeoutMs: 3_000, toolTimeoutMs: 2_000 }] });
    managers.push(manager);
    expect(await manager.invoke('lab', 'write_once', {}, scope)).toMatchObject({ execution: 'not_started' });
    expect(existsSync(log)).toBe(false);
    writeFileSync(flag, 'fixed');
    await manager.reconnect('lab');
    expect(await manager.invoke('lab', 'write_once', {}, scope)).toMatchObject({ ok: true });
    expect(readFileSync(log, 'utf8')).toBe('call\n');
  });

  it('attributes concurrent HTTP preparation and sent-result failures to their own call', async () => {
    let reject = false;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const { manager, state } = await fixture('modern', { token: async () => {
      if (reject) throw new McpAuthError('authentication_required', 'synthetic refresh failure');
      return 'synthetic-token';
    } }, async () => { entered(); await held; });
    state.invalidResult = true;
    const sent = manager.invoke('lab', 'write_once', { tag: 'sent' }, scope);
    await started;
    reject = true;
    try {
      expect(await manager.invoke('lab', 'write_once', { tag: 'preflight' }, scope)).toMatchObject({ execution: 'not_started' });
      expect(state.calls).toBe(1);
    } finally { release(); }
    expect(await sent).toMatchObject({ execution: 'unknown' });
    reject = false; state.invalidResult = false;
    expect(await manager.invoke('lab', 'write_once', { tag: 'sent' }, scope)).toMatchObject({ error: { code: 'previous_execution_unknown' } });
    expect(await manager.invoke('lab', 'write_once', { tag: 'preflight' }, scope)).toMatchObject({ ok: true });
    expect(state.calls).toBe(2);
  });
});
