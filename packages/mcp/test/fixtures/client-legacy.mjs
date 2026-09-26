import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const log = process.argv[2];
const record = (event, fields = {}) => appendFileSync(log, JSON.stringify({ event, pid: process.pid, ...fields }) + '\n');
record('boot');
process.on('exit', () => record('exit'));
let changed = false;
const empty = { type: 'object', properties: {}, additionalProperties: false };
const tools = () => [
  { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: changed ? 'number' : 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'business', inputSchema: empty },
  { name: 'wait', inputSchema: empty },
  { name: 'lose_ack', inputSchema: empty },
  { name: 'gated', inputSchema: empty, _meta: { 'anthropic/requiresUserInteraction': true } },
  { name: 'change', inputSchema: empty },
  { name: 'unresolved_schema', inputSchema: { type: 'object', properties: { x: { $ref: 'https://example.invalid/schema' } }, required: ['x'] } },
];
const server = new Server({ name: 'motif-client-legacy-test', version: '1' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, request => {
  record('list');
  return Object.hasOwn(request.params ?? {}, 'cursor') ? { tools: tools().slice(2) } : { tools: tools().slice(0, 2), nextCursor: '' };
});
server.setRequestHandler(CallToolRequestSchema, async (request, ctx) => {
  const name = request.params.name;
  record('call', { name, args: request.params.arguments });
  if (name === 'lose_ack') { process.exit(0); }
  if (name === 'wait') await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 10_000);
    ctx.signal.addEventListener('abort', () => { clearTimeout(timer); record('cancel'); reject(new Error('cancelled')); }, { once: true });
  });
  if (name === 'change') { changed = true; await server.notification({ method: 'notifications/tools/list_changed' }); }
  if (name === 'business') return { isError: true, content: [{ type: 'text', text: 'business rule' }], structuredContent: { code: 'MOVED', replacement_id: 'CASE-042' } };
  return { content: [{ type: 'text', text: 'ok' }], structuredContent: { received: request.params.arguments, modelKeyInherited: Boolean(process.env.MOTIF_API_KEY) } };
});
await server.connect(new StdioServerTransport());
