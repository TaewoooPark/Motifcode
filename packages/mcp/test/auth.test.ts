import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, chmodSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAuthBroker, McpAuthError, type McpAuthTarget } from '../src/auth.js';
import { authKey, McpAuthStore } from '../src/auth-store.js';
import { createOAuthFixture } from './fixtures/oauth-server.js';
import { McpManager } from '../src/manager.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const home = () => { const path = mkdtempSync(join(tmpdir(), 'motif-auth-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return path; };
async function fixture(options: { resource?: string; pkce?: boolean; issuer?: string; hang?: boolean; tokenError?: boolean; cimd?: boolean; tokenMethod?: string; customResource?: boolean; issuerPath?: string; postUnsupported?: boolean; metadataOrigin?: string; expiresIn?: number; omitRefresh?: boolean; splitEndpoints?: boolean; tokenEndpoint?: string; registrationEndpoint?: string; redirectEndpoint?: 'token' | 'register' } = {}) {
  let base = ''; let endpointBase = ''; let challenge = ''; let registrationCount = 0; let exchangeCount = 0; let refreshCount = 0; let invalidVerifier = false;
  const requests: { path: string; host?: string; body?: string }[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, host: req.headers.host, ...(body ? { body } : {}) });
    res.setHeader('content-type', 'application/json');
    if (options.hang) return;
    if (options.redirectEndpoint && req.url === `/${options.redirectEndpoint}`) { res.writeHead(307, { Location: `${base}/redirect-target` }).end(); return; }
    if (options.customResource && req.url === '/mcp') {
      if (options.postUnsupported && req.method === 'POST') { res.statusCode=405; res.end('{}'); return; }
      res.statusCode=401; res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${options.metadataOrigin ?? base}/custom-resource", scope="read custom"`); res.end('{}'); return;
    }
    if (options.customResource && req.url!.startsWith('/.well-known/oauth-protected-resource')) { res.statusCode=404; res.end('{}'); return; }
    if (req.url === '/custom-resource' || req.url!.startsWith('/.well-known/oauth-protected-resource')) { res.end(JSON.stringify({ resource: options.resource ?? `${base}/mcp`, authorization_servers: [base + (options.issuerPath ?? '')], scopes_supported: ['read'] })); return; }
    if (req.url === '/.well-known/oauth-authorization-server' + (options.issuerPath ?? '')) {
      res.end(JSON.stringify({ issuer: options.issuer ?? base + (options.issuerPath ?? ''), authorization_endpoint: `${base}/authorize`, token_endpoint: options.tokenEndpoint ?? `${endpointBase}/token`, registration_endpoint: options.registrationEndpoint ?? `${endpointBase}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: [options.tokenMethod ?? 'none'], code_challenge_methods_supported: options.pkce === false ? ['plain'] : ['S256'], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: options.cimd ?? false })); return;
    }
    if (req.url === '/register') { registrationCount++; if (JSON.parse(body).token_endpoint_auth_method !== (options.tokenMethod ?? 'none')) { res.statusCode = 400; res.end(JSON.stringify({error:'invalid_client_metadata'})); return; } res.statusCode = 201; res.end(JSON.stringify({ ...JSON.parse(body), client_id: 'fixture-client', client_secret: 'fixture-client-secret' })); return; }
    if (req.url === '/token') {
      const fields = new URLSearchParams(body);
      if (options.tokenMethod === 'client_secret_basic' && req.headers.authorization !== 'Basic ' + Buffer.from('fixture-client:fixture-client-secret').toString('base64')) { res.statusCode=401; res.end(JSON.stringify({error:'invalid_client'})); return; }
      if (options.tokenMethod === 'client_secret_post' && fields.get('client_secret') !== 'fixture-client-secret') { res.statusCode=401; res.end(JSON.stringify({error:'invalid_client'})); return; }
      if (fields.get('grant_type') === 'refresh_token') refreshCount++;
      else {
        exchangeCount++;
        if (fields.get('code') !== 'fixture-code' || createHash('sha256').update(fields.get('code_verifier') ?? '').digest('base64url') !== challenge || fields.get('resource') !== `${base}/mcp`) invalidVerifier = true;
      }
      if (options.tokenError || invalidVerifier) { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'provider-secret-access-token-sensitive' })); return; }
      res.end(JSON.stringify({ access_token: refreshCount ? 'refreshed-private-token' : 'private-token', ...(options.omitRefresh ? {} : {refresh_token: 'private-refresh-token'}), token_type: 'Bearer', expires_in: options.expiresIn ?? 3600, scope: 'read' })); return;
    }
    res.statusCode = 404; res.end('{}');
  };
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('fixture'); base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  endpointBase = base;
  if (options.splitEndpoints) {
    const endpoints = createServer(handler);
    await new Promise<void>(resolve => endpoints.listen(0, '127.0.0.1', resolve));
    const endpointAddress = endpoints.address(); if (!endpointAddress || typeof endpointAddress === 'string') throw Error('fixture'); endpointBase = `http://127.0.0.1:${endpointAddress.port}`;
    cleanups.push(async () => { endpoints.closeAllConnections(); await new Promise<void>(resolve => endpoints.close(() => resolve())); });
  }
  const target: McpAuthTarget = { id: 'fixture', transport: 'http', url: `${base}/mcp` };
  const authorize = async (url: URL, tweak?: (callback: URL) => void) => {
    expect(url.searchParams.get('code_challenge_method')).toBe('S256'); challenge = url.searchParams.get('code_challenge')!;
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('iss', base + (options.issuerPath ?? '')); tweak?.(callback);
    return fetch(callback);
  };
  return { target, base, endpointBase, authorize, requests, counts: () => ({ registrationCount, exchangeCount, refreshCount, invalidVerifier }) };
}
function expire(directory: string, server: McpAuthTarget) {
  const store = new McpAuthStore(directory); const key = authKey(server.url!, server.oauth?.clientId, server.oauth?.scope, server.oauth?.clientMetadataUrl);
  const record = store.read(key)!; record.expiresAt = 0; store.write(record); return { store, key };
}

describe('host OAuth broker', () => {
  it('connects the real MCP manager and reads a protected tool after an HTML-provider login', async () => {
    const f = await createOAuthFixture(); cleanups.push(f.close); const directory = home();
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { const page = await fetch(url); expect(await page.text()).toContain('Approve test access'); await f.approve(url); } });
    const server = { id: 'protected', url: f.mcpUrl, transport: 'http' as const, enabled: true, protocol: 'legacy' as const };
    await broker.login(server);
    const manager = new McpManager({ servers: [server] }, { home: directory, auth: broker });
    try {
      expect((await manager.connect(server.id)).state).toBe('ready');
      const result = await manager.invoke(server.id, 'read_public_fact', {}, { scopeId: 'oauth-test' });
      expect(result.ok).toBe(true); expect(JSON.stringify(result)).toContain(f.fact); expect(f.counts.read).toBe(1);
    } finally { await manager.close(); }
    expect(f.counts.exchange).toBe(1); expect(f.counts.approved).toBe(1);
  });
  it('performs real discovery, DCR, loopback state, PKCE and issuer exchange; stores privately and logs out', async () => {
    const f = await fixture(); const directory = home(); let opened = 0;
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { opened++; await f.authorize(url); } });
    expect(broker.status(f.target).state).toBe('not_authenticated');
    const result = await broker.login(f.target);
    expect(result.state).toBe('authenticated'); expect(opened).toBe(1);
    expect(f.counts()).toEqual({ registrationCount: 1, exchangeCount: 1, refreshCount: 0, invalidVerifier: false });
    expect(await broker.token(f.target)).toBe('private-token');
    const dir = join(directory, '.motif', 'auth'); const file = join(dir, readdirSync(dir)[0]!);
    expect(statSync(dir).mode & 0o777).toBe(0o700); expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('code_verifier'); expect(readFileSync(file, 'utf8')).not.toContain('fixture-code');
    expect(JSON.stringify(result)).not.toMatch(/private-token|fixture-client-secret|state=/);
    expect(broker.logout(f.target).state).toBe('not_authenticated'); expect(await broker.token(f.target)).toBeUndefined();
  });
  it('supports a pre-registered public client and never calls DCR', async () => {
    const f = await fixture(); f.target.oauth = { clientId: 'registered-motif', scope: 'read' };
    const broker = new McpAuthBroker({ home: home(), openBrowser: async url => { expect(url.searchParams.get('client_id')).toBe('registered-motif'); await f.authorize(url); } });
    await broker.login(f.target); expect(f.counts().registrationCount).toBe(0); expect(await broker.token(f.target)).toBe('private-token');
  });
  it.each(['client_secret_basic', 'client_secret_post'])('negotiates DCR-issued %s credentials and refreshes privately', async tokenMethod => {
    const f = await fixture({ tokenMethod }); const directory = home();
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { await f.authorize(url); } });
    await broker.login(f.target); expire(directory, f.target); expect(await broker.token(f.target)).toBe('refreshed-private-token');
    expect(f.counts().registrationCount).toBe(1); expect(f.counts().refreshCount).toBe(1);
  });
  it('supports an explicit client metadata URL on a provider that advertises CIMD', async () => {
    const f = await fixture({ cimd: true }); f.target.oauth = { clientMetadataUrl: 'https://motif.example/oauth/client.json' };
    const broker = new McpAuthBroker({ home: home(), openBrowser: async url => { expect(url.searchParams.get('client_id')).toBe(f.target.oauth!.clientMetadataUrl); await f.authorize(url); } });
    await broker.login(f.target); expect(f.counts().registrationCount).toBe(0);
  });
  it('refreshes expired tokens once for concurrent preflight callers without a browser', async () => {
    const f = await fixture(); const directory = home(); let opened = 0;
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { opened++; await f.authorize(url); } });
    await broker.login(f.target); expire(directory, f.target);
    expect(broker.status(f.target).state).toBe('expired');
    expect(await Promise.all([broker.token(f.target), broker.token(f.target)])).toEqual(['refreshed-private-token', 'refreshed-private-token']);
    expect(opened).toBe(1); expect(f.counts().refreshCount).toBe(1); expect(broker.status(f.target).state).toBe('authenticated');
  });
  it('isolates endpoint, configured client and scope identity', async () => {
    const f = await fixture(); const broker = new McpAuthBroker({ home: home(), openBrowser: async url => { await f.authorize(url); } });
    await broker.login(f.target);
    for (const changed of [{ ...f.target, url: `${f.base}/other` }, { ...f.target, oauth: { clientId: 'other' } }, { ...f.target, oauth: { scope: 'write' } }]) expect(await broker.token(changed)).toBeUndefined();
    expect(await broker.token({ ...f.target, id: 'renamed' })).toBe('private-token');
  });
  it('ignores forged and Unicode state callbacks without exchanging a code', async () => {
    const f = await fixture(); const responses: number[] = [];
    const broker = new McpAuthBroker({ home: home(), openBrowser: async url => {
      responses.push((await f.authorize(url, callback => callback.searchParams.set('state', '界'.repeat(url.searchParams.get('state')!.length)))).status);
      responses.push((await f.authorize(url, callback => callback.searchParams.set('state', 'x'.repeat(url.searchParams.get('state')!.length)))).status);
      await f.authorize(url);
    } });
    await broker.login(f.target); expect(responses).toEqual([400, 400]); expect(f.counts().exchangeCount).toBe(1);
  });
  it.each(['missing', 'mismatched'])('rejects a %s issuer before code exchange', async mode => {
    const f = await fixture(); const directory = home();
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { await f.authorize(url, callback => { if (mode === 'missing') callback.searchParams.delete('iss'); else callback.searchParams.set('iss', 'https://wrong.example'); }); } });
    await expect(broker.login(f.target)).rejects.toMatchObject({ code: 'oauth_failed' });
    expect(f.counts().exchangeCount).toBe(0); expect(broker.status(f.target).state).toBe('not_authenticated');
  });
  it('handles declined consent without exposing provider text or persisting partial credentials', async () => {
    const f = await fixture(); const broker = new McpAuthBroker({ home: home(), openBrowser: async url => { await f.authorize(url, callback => { callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('error_description', 'secret-provider-account'); }); } });
    await expect(broker.login(f.target)).rejects.toMatchObject({ code: 'authorization_denied', message: 'The provider declined MCP authorization.' });
    expect(f.counts().exchangeCount).toBe(0); expect(broker.status(f.target).state).toBe('not_authenticated');
  });
  it('supports manual browser UI without launching a system browser', async () => {
    const f = await fixture(); const openBrowser = vi.fn(); const broker = new McpAuthBroker({ home: home(), openBrowser });
    await broker.login(f.target, { noBrowser: true, onAuthorization: async url => { await f.authorize(url); } }); expect(openBrowser).not.toHaveBeenCalled();
  });
  it('cancels a pending login and closes its loopback listener', async () => {
    const f = await fixture(); const controller = new AbortController(); let callback = '';
    const broker = new McpAuthBroker({ home: home(), openBrowser: url => { callback = url.searchParams.get('redirect_uri')!; controller.abort(); } });
    await expect(broker.login(f.target, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(fetch(callback)).rejects.toThrow(); expect(broker.status(f.target).state).toBe('not_authenticated');
  });
  it('times out waiting for a user without storing DCR credentials', async () => {
    const f = await fixture(); const broker = new McpAuthBroker({ home: home(), openBrowser: () => {} });
    await expect(broker.login(f.target, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' }); expect(broker.status(f.target).state).toBe('not_authenticated');
  });
  it('bounds an OAuth fetch even if a custom fetch ignores abort', async () => {
    const broker = new McpAuthBroker({ home: home(), fetch: () => new Promise(() => {}), fetchTimeoutMs: 30 });
    await expect(broker.login({ id: 'hang', url: 'https://example.com/mcp' }, { timeoutMs: 150 })).rejects.toMatchObject({ code: expect.stringMatching(/timeout|oauth_failed/) });
  });
  it.each([{ resource: 'https://wrong.example/mcp' }, { pkce: false }, { issuer: 'https://wrong.example' }])('rejects unsupported or mismatched discovery before browser launch: %j', async options => {
    const f = await fixture(options); const openBrowser = vi.fn(); const broker = new McpAuthBroker({ home: home(), openBrowser });
    await expect(broker.login(f.target)).rejects.toBeInstanceOf(McpAuthError); expect(openBrowser).not.toHaveBeenCalled(); expect(f.counts().exchangeCount).toBe(0);
  });
  it('registers, exchanges and refreshes at secure metadata endpoints on a different origin', async () => {
    const f = await fixture({ splitEndpoints: true, tokenMethod: 'client_secret_basic' }); const directory = home();
    expect(new URL(f.endpointBase).origin).not.toBe(new URL(f.base).origin);
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { await f.authorize(url); } });
    await broker.login(f.target); expect(await broker.token(f.target)).toBe('private-token');
    expire(directory, f.target); expect(await broker.token(f.target)).toBe('refreshed-private-token');
    expect(f.counts()).toEqual({ registrationCount: 1, exchangeCount: 1, refreshCount: 1, invalidVerifier: false });
    expect(f.requests.filter(row => ['/register', '/token'].includes(row.path)).every(row => row.host === new URL(f.endpointBase).host)).toBe(true);
  });
  it.each([
    { tokenEndpoint: 'http://insecure.example/token' },
    { registrationEndpoint: 'http://insecure.example/register' },
    { tokenEndpoint: 'not an endpoint' },
    { registrationEndpoint: 'not an endpoint' },
  ])('rejects insecure or malformed declared endpoints before registration: %j', async options => {
    const f = await fixture(options); const openBrowser = vi.fn(); const destinations: string[] = [];
    const broker = new McpAuthBroker({ home: home(), openBrowser, fetch: async (input, init) => {
      const url = new URL(String(input)); destinations.push(url.origin);
      if (url.origin !== f.base) throw Error('Unexpected endpoint request');
      return fetch(input, init);
    } });
    await expect(broker.login(f.target)).rejects.toBeInstanceOf(McpAuthError);
    expect(openBrowser).not.toHaveBeenCalled(); expect(destinations.every(origin => origin === f.base)).toBe(true);
    expect(f.counts().registrationCount).toBe(0); expect(f.counts().exchangeCount).toBe(0);
  });
  it.each(['token', 'register'] as const)('never follows a cross-origin declared %s endpoint redirect', async redirectEndpoint => {
    const f = await fixture({ splitEndpoints: true, redirectEndpoint });
    const broker = new McpAuthBroker({ home: home(), openBrowser: async url => { await f.authorize(url); } });
    await expect(broker.login(f.target)).rejects.toBeInstanceOf(McpAuthError);
    expect(f.requests.some(row => row.path === `/${redirectEndpoint}` && row.host === new URL(f.endpointBase).host)).toBe(true);
    expect(f.requests.some(row => row.path === '/redirect-target')).toBe(false);
    expect(broker.status(f.target).state).toBe('not_authenticated');
  });
  it('sanitizes OAuth endpoint errors before SDK diagnostics', async () => {
    const f = await fixture({ tokenError: true }); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broker = new McpAuthBroker({ home: home(), openBrowser: async url => { await f.authorize(url); } });
    await expect(broker.login(f.target)).rejects.toMatchObject({ code: 'oauth_failed' }); expect(JSON.stringify(warning.mock.calls)).not.toContain('provider-secret');
  });
  it('does not break anonymous non-TLS HTTP MCP or trigger an OAuth request', async () => {
    const fetchImpl = vi.fn(); const broker = new McpAuthBroker({ home: home(), fetch: fetchImpl });
    expect(await broker.token({ id: 'plain', transport: 'http', url: 'http://public.example/mcp' })).toBeUndefined(); expect(fetchImpl).not.toHaveBeenCalled();
    expect(await broker.token({ id: 'local', transport: 'http', url: 'http://localhost:1234/mcp' })).toBeUndefined();
  });
  it('rejects private credential files with permissive modes and symlink stores', async () => {
    const directory = home(); const store = new McpAuthStore(directory); const key = authKey('https://example.com/mcp');
    store.write({ version: 1, key, endpoint: 'https://example.com/mcp', revision: 'test' });
    chmodSync(join(store.directory, `${key}.json`), 0o644); expect(() => store.read(key)).toThrow(McpAuthError);
    const other = home(); mkdirSync(join(other, '.motif')); symlinkSync(store.directory, join(other, '.motif', 'auth'));
    expect(() => new McpAuthStore(other).write({ version: 1, key, endpoint: 'https://example.com/mcp', revision: 'test' })).toThrow(McpAuthError);
  });
  it('stops on refresh denial without a browser or repeated refresh attempts', async () => {
    const settings = { tokenError: false }; const f = await fixture(settings); const directory = home(); let opened = 0;
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { opened++; await f.authorize(url); } });
    await broker.login(f.target); expire(directory, f.target); settings.tokenError = true;
    await expect(broker.token(f.target)).rejects.toMatchObject({ code: 'authentication_required' });
    expect(await broker.token(f.target)).toBeUndefined(); expect(f.counts().refreshCount).toBe(1); expect(opened).toBe(1);
  });
  it('rejects metadata redirects without reaching their destination', async () => {
    const f = await fixture(); let calls = 0;
    const redirect = createServer((_req, res) => { calls++; res.writeHead(302, { Location: `${f.base}/.well-known/oauth-protected-resource/mcp` }).end(); });
    await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => { redirect.closeAllConnections(); await new Promise<void>(resolve => redirect.close(() => resolve())); });
    const addr = redirect.address(); if (!addr || typeof addr === 'string') throw Error('fixture');
    const broker = new McpAuthBroker({ home: home(), openBrowser: vi.fn() });
    await expect(broker.login({ id: 'redirect', url: `http://127.0.0.1:${addr.port}/mcp` })).rejects.toBeInstanceOf(McpAuthError);
    expect(calls).toBeGreaterThan(0); expect(f.requests).toHaveLength(0);
  });
  it('rejects oversized OAuth responses without exposing their content', async () => {
    const broker = new McpAuthBroker({ home: home(), fetch: async () => new Response('sensitive'.repeat(40000)) });
    await expect(broker.login({ id: 'big', url: 'https://example.com/mcp' })).rejects.toMatchObject({ message: expect.not.stringContaining('sensitive') });
  });
  it('aborts an in-progress browser callback on logout before credentials can be stored', async () => {
    const f = await fixture(); const directory = home();
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { broker.logout(f.target); await f.authorize(url).catch(() => {}); } });
    await expect(broker.login(f.target)).rejects.toMatchObject({ code: 'cancelled' }); expect(broker.status(f.target).state).toBe('not_authenticated');
  });
  it('does not restore authorization after another broker logs out during browser consent', async () => {
    const f = await fixture(); const directory = home(); const other = new McpAuthBroker({ home: directory });
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { other.logout(f.target); await f.authorize(url); } });
    await expect(broker.login(f.target)).rejects.toMatchObject({ code: 'auth_changed' });
    expect(other.status(f.target).state).toBe('not_authenticated'); expect(await other.token(f.target)).toBeUndefined();
    const stored = new McpAuthStore(directory).read(authKey(f.target.url!)); expect(stored?.tokens).toBeUndefined(); expect(stored?.clientInformation).toBeUndefined();
  });
  it('serializes a durable logout tombstone against a stale credential commit', async () => {
    const directory = home(); const store = new McpAuthStore(directory); const other = new McpAuthStore(directory); const key = authKey('https://example.com/mcp');
    expect(store.read(key)).toBeUndefined(); other.remove(key);
    expect(() => store.write({ version: 1, key, endpoint: 'https://example.com/mcp', revision: 'late' }, null)).toThrow(McpAuthError);
    expect(other.read(key)?.revision).not.toBe('late');
  });
  it.each([false, true])('discovers custom challenge metadata and a path-based issuer (POST unsupported: %s)', async postUnsupported => {
    const f = await fixture({ customResource: true, issuerPath: '/tenant', postUnsupported });
    const broker = new McpAuthBroker({ home: home(), openBrowser: async url => { expect(url.searchParams.get('scope')).toBe('read custom'); await f.authorize(url); } });
    await broker.login(f.target); expect(await broker.token(f.target)).toBe('private-token');
    expect(f.requests.some(row => row.path === '/custom-resource')).toBe(true); expect(f.requests.some(row => row.path === '/.well-known/oauth-authorization-server/tenant')).toBe(true);
  });
  it('rejects challenge metadata on a different resource origin', async () => {
    const f = await fixture({ customResource: true, metadataOrigin: 'https://other.example' }); const openBrowser=vi.fn();
    const broker = new McpAuthBroker({ home: home(), openBrowser });
    await expect(broker.login(f.target)).rejects.toMatchObject({code:'oauth_resource_mismatch'}); expect(openBrowser).not.toHaveBeenCalled();
  });
  it('keeps an explicit scope bound to the configured identity despite a broader challenge', async () => {
    const f = await fixture({ customResource: true }); const directory = home();
    const target = { ...f.target, oauth: { scope: 'read' } };
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { expect(url.searchParams.get('scope')).toBe('read'); await f.authorize(url); } });
    await broker.login(target); expect(await broker.token(target)).toBe('private-token');
    expect(await broker.token({ ...target, oauth: { scope: 'read custom' } })).toBeUndefined();
  });
  it('uses a short-lived unrefreshable token until its actual expiry', async () => {
    const f = await fixture({expiresIn:20, omitRefresh:true}); const directory=home();
    const broker=new McpAuthBroker({home:directory,openBrowser:async url=>{await f.authorize(url);}});
    await broker.login(f.target); expect(await broker.token(f.target)).toBe('private-token'); expire(directory,f.target);
    await expect(broker.token(f.target)).rejects.toMatchObject({code:'authentication_required'}); expect(f.counts().refreshCount).toBe(0);
  });
  it('does not restore a credential deleted during a late refresh', async () => {
    const f = await fixture(); const directory = home(); let release!: () => void; let refreshStarted!: () => void;
    const ready = new Promise<void>(resolve => { refreshStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const broker = new McpAuthBroker({ home: directory, openBrowser: async url => { await f.authorize(url); }, fetch: async (input, init) => {
      if (String(init?.body).includes('grant_type=refresh_token')) { refreshStarted(); await gate; } return fetch(input, init);
    } });
    await broker.login(f.target); expire(directory, f.target); const pending = broker.token(f.target); await ready; broker.logout(f.target); release();
    await expect(pending).rejects.toMatchObject({ code: 'auth_changed' }); expect(broker.status(f.target).state).toBe('not_authenticated');
  });
});
