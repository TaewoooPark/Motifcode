/** Opt-in live candidate probe. Uses Motifcode's actual manager; no model/account credentials. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../packages/mcp/src/manager.js';
import { createMcpPresetConfig } from '../packages/mcp/src/presets.js';

const output = resolve(process.argv[2] ?? '/tmp/motif-mcp-evidence/candidates.json');
const selected = process.argv[3]?.split(',');
const candidates = ['filesystem', 'playwright', 'context7', 'hugging-face', 'openai-docs'];
if (selected?.some(id => !candidates.includes(id))) throw new Error('Unknown smoke candidate ID');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = ['scripts/mcp-candidates-probe.ts', ...readdirSync(join(root, 'packages/mcp/src')).filter(p => p.endsWith('.ts')).map(p => `packages/mcp/src/${p}`)];
const source = Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'motif-mcp-probe-')));
const marker = 'Motif MCP live probe 37';
writeFileSync(join(scratch, 'probe.txt'), marker + '\n');
const web = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<html><title>Motif MCP probe</title><body><h1>${marker}</h1></body></html>`); });
await new Promise<void>(done => web.listen(0, '127.0.0.1', done));
const address = web.address();
if (!address || typeof address === 'string') throw new Error('No loopback port');
const localUrl = `http://127.0.0.1:${address.port}`;
const servers = candidates.filter(id => !selected || selected.includes(id)).map(id => createMcpPresetConfig(id, { enabled: true, ...(id === 'filesystem' ? { root: scratch } : {}) }));
const reports: Record<string, unknown>[] = [];
try {
  await Promise.all(servers.map(async server => {
    const started = Date.now();
    const manager = new McpManager({ servers: [server] });
    const report: Record<string, unknown> = { server: server.id, config: server, startedAt: new Date().toISOString() };
    reports.push(report);
    const calls: { tool: string; arguments: Record<string, unknown>; passed: boolean; execution: string; expectedFound?: boolean; bytes: number; sha256: string; preview: string }[] = [];
    try {
      const catalog = await manager.catalog();
      report.status = manager.statuses()[0];
      report.tools = catalog.map(({ name, inputSchema }) => ({ name, inputSchema }));
      const call = async (tool: string, args: Record<string, unknown>, expected?: string) => {
        const result = await manager.invoke(server.id, tool, args, { scopeId: 'candidate-smoke' });
        const body = JSON.stringify(result);
        calls.push({ tool, arguments: args, passed: result.ok && !result.isError && (expected === undefined || body.includes(expected)), execution: result.execution, expectedFound: expected === undefined ? undefined : body.includes(expected), bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), preview: body.slice(0, 1200) });
        return result;
      };
      if (catalog.length) {
        if (server.id === 'filesystem') await call('read_text_file', { path: join(scratch, 'probe.txt') }, marker);
        if (server.id === 'playwright') {
          await call('browser_navigate', { url: localUrl });
          await call('browser_snapshot', {}, marker);
          await call('browser_close', {});
        }
        if (server.id === 'context7') {
          await call('resolve-library-id', { libraryName: 'react', query: 'React useState documentation' }, 'react');
          await call('query-docs', { libraryId: '/websites/react_dev', query: 'How does useState update component state?' }, 'useState');
        }
        if (server.id === 'hugging-face') {
          await call('hub_repo_search', { query: 'bert-base-uncased', repo_types: ['model'], limit: 1 }, 'bert');
          await call('hf_fs', { operations: [{ cmd: 'cat', args: ['hf://models/google-bert/bert-base-uncased/README.md'] }] }, 'BERT');
        }
        if (server.id === 'openai-docs') await call('search_openai_docs', { query: 'Codex MCP configuration', limit: 2 }, 'mcp');
      }
      report.calls = calls;
      report.passed = manager.statuses()[0]?.state === 'ready' && calls.length > 0 && calls.every(call => call.passed);
    } catch (err) { report.failure = err instanceof Error ? err.message : String(err); }
    finally { await manager.close(); report.closedStatus = manager.statuses()[0]; report.elapsedMs = Date.now() - started; }
    process.stdout.write(JSON.stringify({ server: server.id, status: report.status, passed: report.passed === true, elapsedMs: report.elapsedMs, calls: calls.map(({ tool, passed }) => ({ tool, passed })) }) + '\n');
  }));
} finally {
  await new Promise<void>(done => web.close(() => done()));
  const passed = reports.length > 0 && reports.every(report => report.passed === true);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ timestamp: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), source, node: process.version, scratch, method: 'Actual PR37 McpManager with built-in preset configs; catalog and tools/call; no model inference or borrowed login session', passed, reports }, null, 2) + '\n', { mode: 0o600 });
  if (!passed) process.exitCode = 1;
  process.stdout.write(`Evidence: ${output}\n`);
}
