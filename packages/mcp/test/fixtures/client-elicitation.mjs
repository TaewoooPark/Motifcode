import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js';
const log = process.argv[2];
const record = (event, fields = {}) => appendFileSync(log, JSON.stringify({ event, ...fields }) + '\n');
const server = new Server({ name: 'elicitation-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: ['url', 'form', 'unsafe_url', 'url_error', 'url_wait', 'wait', 'double_url'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  record('call', { name: request.params.name });
  if (request.params.name === 'wait') return new Promise(() => {});
  const params = request.params.name === 'form'
    ? { mode: 'form', message: 'Choose a fixture option.', requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['a', 'b'] }, count: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['choice', 'count'] } }
    : { mode: 'url', message: 'Open the fixture authorization page.', url: request.params.name === 'unsafe_url' ? 'javascript:alert(1)' : 'https://example.test/authorize?ticket=host-only-fixture', elicitationId: 'fixture-elicitation' };
  if (request.params.name === 'url_error') throw new UrlElicitationRequiredError([params], 'private provider detail');
  const response = await server.elicitInput(params);
  record('elicitation', { action: response.action, content: response.content });
  if (request.params.name === 'url_wait') return new Promise(() => {});
  if (request.params.name === 'double_url') await server.elicitInput({ ...params, elicitationId: 'second-fixture' });
  return { content: [{ type: 'text', text: `human action: ${response.action}` }] };
});
await server.connect(new StdioServerTransport());
