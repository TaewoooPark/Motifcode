#!/usr/bin/env node
/** Opt-in public connectivity probes; uses no Gmail credentials or mailbox contents. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpManager } from '../packages/mcp/src/manager.js';
import { createMcpPresetConfig, getMcpPreset } from '../packages/mcp/src/presets.js';
import type { McpServerConfig } from '../packages/mcp/src/config.js';

const output = resolve(process.argv[2] ?? '/tmp/motif-mcp-evidence/tauri-gmail.json');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = ['scripts/mcp-tauri-gmail-smoke.ts', ...readdirSync(join(root, 'packages/mcp/src')).filter(p => p.endsWith('.ts')).map(p => `packages/mcp/src/${p}`)];
const source = Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
const configs: McpServerConfig[] = [
  createMcpPresetConfig('tauri', { enabled: true }),
  // Deliberate negative test: no token reference or inherited account session.
  { ...getMcpPreset('gmail')!.config, enabled: true },
];
const report: Record<string, unknown> = { timestamp: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), source, node: process.version, transport: 'PR #37 McpManager', limitations: ['No Gmail credential discovery or OAuth flow is attempted.', 'No email content is requested; unauthenticated list_labels only.', 'Tauri status only; no real application is modified.', 'Passing these conditional probes does not assert Gmail account access or a connected Tauri app.'], trials: [] };
const trials = report.trials as Record<string, unknown>[];
for (const config of configs) {
  const http: Record<string, unknown>[] = [];
  const wrappedFetch: typeof fetch = async (input, init) => {
    let method: string | undefined;
    try { method = typeof init?.body === 'string' ? JSON.parse(init.body).method : undefined; } catch {}
    try {
      const response = await fetch(input, init);
      http.push({ httpMethod: init?.method ?? 'GET', rpcMethod: method, status: response.status, contentType: response.headers.get('content-type') });
      return response;
    } catch (error) {
      http.push({ httpMethod: init?.method ?? 'GET', rpcMethod: method, exception: error instanceof Error ? error.name : typeof error, code: (error as { code?: unknown })?.code });
      throw error;
    }
  };
  const manager = new McpManager({ servers: [config] }, { fetch: wrappedFetch });
  const trial: Record<string, unknown> = { id: config.id, config, http, started: new Date().toISOString() };
  trials.push(trial);
  const started = Date.now();
  try {
    const catalog = await manager.catalog();
    trial.statusAfterCatalog = manager.statuses();
    trial.toolNames = catalog.map(tool => tool.name);
    const method = config.id === 'tauri' ? 'driver_session' : 'list_labels';
    const tool = catalog.find(candidate => candidate.name === method);
    if (tool) {
      trial.probeSchema = tool.inputSchema;
      trial.probe = { method, arguments: config.id === 'tauri' ? { action: 'status' } : {} };
      const outcome = await manager.invoke(config.id, method, config.id === 'tauri' ? { action: 'status' } : {}, { scopeId: 'live' });
      trial.outcome = outcome;
      trial.expectedProbePassed = config.id === 'tauri' ? outcome.ok && !outcome.isError
        : !outcome.ok && outcome.error.code === 'authentication_required' && http.some(item => item.rpcMethod === 'tools/call' && item.status === 401);
      trial.statusAfterInvoke = manager.statuses();
    }
  } catch (error) {
    trial.exception = { name: error instanceof Error ? error.name : typeof error, code: (error as { code?: unknown })?.code };
  } finally {
    await manager.close();
    trial.elapsedMs = Date.now() - started;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(JSON.stringify({ id: config.id, status: trial.statusAfterCatalog, toolCount: (trial.toolNames as string[] | undefined)?.length, outcome: trial.outcome, elapsedMs: trial.elapsedMs }));
}
report.expectedProbesPassed = trials.length === 2 && trials.every(trial => trial.expectedProbePassed === true);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
if (!report.expectedProbesPassed) process.exitCode = 1;
console.log(JSON.stringify({ output }));
