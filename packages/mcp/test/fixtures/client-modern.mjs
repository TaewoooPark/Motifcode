import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
const log = process.argv[2];
const record = (event, fields = {}) => appendFileSync(log, JSON.stringify({ event, pid: process.pid, ...fields }) + '\n');
record('boot');
process.on('exit', () => record('exit'));
serveStdio(() => {
  const server = new Server({ name: 'motif-client-modern-test', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', () => ({ tools: [
    { name: 'array', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'array', items: { type: 'string' } } },
    { name: 'input', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ], ttlMs: 60_000, cacheScope: 'private' }));
  server.setRequestHandler('tools/call', request => {
    record('call', { name: request.params.name });
    if (request.params.name === 'input') return { resultType: 'input_required', requestState: 'opaque-fixture-state' };
    return { content: [{ type: 'text', text: 'cities' }], structuredContent: ['서울', '부산'] };
  });
  return server;
}, { legacy: 'reject' });
