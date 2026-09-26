#!/usr/bin/env node
// Original Motif helper. Discovery only; no tools/call or configuration writes.
import { spawn } from 'node:child_process';

const usage = `Usage: node smoke-stdio.mjs [--timeout-ms 30000] [--protocol VERSION] -- COMMAND [ARG ...]
Starts the reviewed command and checks MCP initialize plus paginated tools/list.
No dependencies are installed and no business tools are called. Stderr is suppressed.
Supports basic protocol versions 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25.
Does not validate complete JSON Schema or advanced capabilities; use SDK tests for those.
`;
const supported = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const argv = process.argv.slice(2);
if (argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(usage);
  process.exit(0);
}
const separator = argv.indexOf('--');
let timeoutMs = 30_000;
let protocol = '2025-11-25';
try {
  if (separator < 0 || !argv[separator + 1]) throw new Error('A command after -- is required.');
  for (let i = 0; i < separator; i += 2) {
    const value = argv[i + 1];
    if (i + 1 >= separator) throw new Error('An option is missing its value.');
    if (argv[i] === '--timeout-ms' && /^\d+$/.test(value)) timeoutMs = Number(value);
    else if (argv[i] === '--protocol' && supported.has(value)) protocol = value;
    else throw new Error('Unsupported option or value.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('Timeout must be 100..120000 milliseconds.');
} catch (error) {
  process.stderr.write(`${error.message}\n${usage}`);
  process.exit(2);
}

const child = spawn(argv[separator + 1], argv.slice(separator + 2), { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
let nextId = 1;
let fatal;
let buffer = '';
let outputBytes = 0;
let closing = false;
const pending = new Map();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => {
  fatal ??= new Error(message);
  for (const { reject } of pending.values()) reject(fatal);
  pending.clear();
};
const send = message => {
  if (!child.stdin.writable) throw new Error('Server input closed.');
  child.stdin.write(JSON.stringify(message) + '\n');
};
const request = (method, params = {}) => new Promise((resolve, reject) => {
  if (fatal) { reject(fatal); return; }
  const id = nextId++;
  pending.set(id, { resolve, reject });
  try { send({ jsonrpc: '2.0', id, method, params }); }
  catch { fail('Could not send an MCP request.'); }
});

child.on('error', () => fail('Could not start the server command.'));
child.stdin.on('error', () => { if (!closing) fail('Server input failed.'); });
child.stdout.on('error', () => fail('Server output failed.'));
child.on('exit', () => { if (!closing) fail('Server exited before discovery completed.'); });
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  if (fatal) return;
  outputBytes += Buffer.byteLength(chunk);
  buffer += chunk;
  if (outputBytes > 8 * 1024 * 1024) { fail('Server output exceeded 8 MiB.'); return; }
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    if (Buffer.byteLength(line) > 1024 * 1024) { fail('One MCP message exceeded 1 MiB.'); return; }
    let message;
    try { message = JSON.parse(line); }
    catch { fail('Non-JSON stdout: send server diagnostics to stderr.'); return; }
    if (!isObject(message) || message.jsonrpc !== '2.0') { fail('Invalid JSON-RPC envelope.'); return; }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        try {
          send(message.method === 'ping'
            ? { jsonrpc: '2.0', id: message.id, result: {} }
            : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'This smoke client does not support client requests.' } });
        } catch { fail('Could not respond to the server.'); return; }
      }
      continue;
    }
    const waiter = pending.get(message.id);
    if (!waiter || ('result' in message) === ('error' in message)) { fail('Unexpected or malformed JSON-RPC response.'); return; }
    if ('error' in message) { fail('Server returned a JSON-RPC error. Inspect server diagnostics separately.'); return; }
    pending.delete(message.id);
    waiter.resolve(message.result);
  }
  if (Buffer.byteLength(buffer) > 1024 * 1024) fail('Unterminated MCP message exceeded 1 MiB.');
});
const timer = setTimeout(() => fail('MCP discovery timed out.'), timeoutMs);

try {
  const init = await request('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'motif-builtin-smoke', version: '1.0.0' } });
  if (!isObject(init) || !supported.has(init.protocolVersion) || !isObject(init.capabilities) || !isObject(init.serverInfo)
    || typeof init.serverInfo.name !== 'string' || typeof init.serverInfo.version !== 'string') throw new Error('Invalid or unsupported initialize result.');
  if (!isObject(init.capabilities.tools)) throw new Error('Server does not advertise tools capability.');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const names = new Set();
  const cursors = new Set();
  let cursor;
  let pages = 0;
  do {
    if (++pages > 20) throw new Error('Discovery exceeded 20 pages.');
    const result = await request('tools/list', cursor === undefined ? {} : { cursor });
    if (!isObject(result) || !Array.isArray(result.tools)) throw new Error('Invalid tools/list result.');
    for (const tool of result.tools) {
      if (!isObject(tool) || typeof tool.name !== 'string' || !tool.name || tool.name.length > 256 || /[\x00-\x1f\x7f]/.test(tool.name)
        || !isObject(tool.inputSchema) || tool.inputSchema.type !== 'object') throw new Error('Invalid tool name or input schema.');
      if (names.has(tool.name)) throw new Error('Duplicate tool name across discovery pages.');
      names.add(tool.name);
      if (names.size > 10_000) throw new Error('Discovery exceeded 10000 tools.');
    }
    cursor = result.nextCursor;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Invalid or repeated pagination cursor.');
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  if (fatal) throw fatal;
  process.stdout.write(JSON.stringify({ ok: true, protocol: init.protocolVersion, toolCount: names.size, pages, tools: [...names], businessToolsCalled: false }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`MCP smoke failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  closing = true;
  clearTimeout(timer);
  child.stdin.end();
  const waitForExit = ms => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const done = () => { clearTimeout(wait); child.off('exit', done); resolve(); };
    const wait = setTimeout(done, ms);
    child.once('exit', done);
  });
  await waitForExit(200);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await waitForExit(500);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child.stdin.destroy();
  child.stdout.destroy();
  child.unref();
}
