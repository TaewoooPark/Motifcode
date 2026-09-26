import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAuthBroker, McpAuthError, type McpAuthBrokerOptions, type McpAuthTarget } from '../src/auth.js';
import { GITHUB_MCP_ENDPOINT, parseMcpConfig, resolveServerConfig } from '../src/config.js';
import { githubCredentialEnvironment } from '../src/github-auth.js';
import { createMcpPresetConfig } from '../src/presets.js';

const createBroker = (options: McpAuthBrokerOptions) => new McpAuthBroker({ githubCredentialValidator: async () => true, ...options });
const directories: string[] = [];
const home = () => { const path = mkdtempSync(join(tmpdir(), 'motif-github-auth-')); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const target: McpAuthTarget = { id: 'github', transport: 'http', url: GITHUB_MCP_ENDPOINT, credentialProvider: 'github-cli' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

describe('GitHub CLI credential delegation', () => {
  it('does no credential lookup at construction/status and requires an explicit local login grant', async () => {
    const reader = vi.fn(async () => 'private-gh-token');
    const broker = createBroker({ home: home(), githubCredentialReader: reader });
    expect(broker.status(target)).toEqual({ server: 'github', state: 'not_authenticated', storage: 'github-cli', source: 'github-cli' });
    await expect(broker.token(target)).rejects.toMatchObject({ code: 'authentication_required' });
    expect(reader).not.toHaveBeenCalled();
  });
  it('persists only consent across fresh brokers, and reads current credentials at every dispatch', async () => {
    const directory = home(); let token = 'private-initial-token';
    const reader = vi.fn(async () => token);
    const broker = createBroker({ home: directory, githubCredentialReader: reader });
    const humanLogin = vi.fn();
    expect((await broker.login(target, { onGitHubLogin: humanLogin })).state).toBe('authenticated');
    expect(humanLogin).not.toHaveBeenCalled();
    const fresh = createBroker({ home: directory, githubCredentialReader: reader });
    expect(fresh.status(target).state).toBe('authenticated');
    expect(await fresh.token(target)).toBe('private-initial-token');
    token = 'private-rotated-token';
    expect(await fresh.token(target)).toBe('private-rotated-token');
    const store = join(directory, '.motif', 'auth');
    expect(statSync(store).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(store)) {
      expect(statSync(join(store, file)).mode & 0o777).toBe(0o600);
      const text = readFileSync(join(store, file), 'utf8');
      expect(text).not.toContain('private-');
      expect(text).not.toContain('access_token');
    }
    expect(reader).toHaveBeenCalledTimes(3);
  });
  it('revokes Motif delegation durably without logging out the shared gh account', async () => {
    const directory = home(); const reader = vi.fn(async () => 'private-token');
    const broker = createBroker({ home: directory, githubCredentialReader: reader });
    await broker.login(target); const calls = reader.mock.calls.length;
    expect(broker.logout(target).state).toBe('not_authenticated');
    const fresh = createBroker({ home: directory, githubCredentialReader: reader });
    await expect(fresh.token(target)).rejects.toMatchObject({ code: 'authentication_required' });
    expect(reader).toHaveBeenCalledTimes(calls);
    await fresh.login(target);
    expect(await fresh.token(target)).toBe('private-token');
  });
  it('clears the local grant when gh loses its login and requires explicit login to recover', async () => {
    const reader = vi.fn().mockResolvedValueOnce('private-token').mockRejectedValueOnce(new Error('secret-private-stderr')).mockResolvedValue('new-private-token');
    const broker = createBroker({ home: home(), githubCredentialReader: reader });
    await broker.login(target);
    await expect(broker.token(target)).rejects.toMatchObject({ code: 'github_login_required' });
    expect(broker.status(target).state).toBe('not_authenticated');
    await expect(broker.token(target)).rejects.toMatchObject({ code: 'authentication_required' });
    expect(reader).toHaveBeenCalledTimes(2);
    await broker.login(target);
    expect(await broker.token(target)).toBe('new-private-token');
  });
  it('launches human login only during an explicit login, and never stores or returns its token', async () => {
    const reader = vi.fn().mockRejectedValueOnce(new Error('private-provider-error')).mockResolvedValue('private-token');
    const humanLogin = vi.fn(async ({ signal }: { signal: AbortSignal }) => { expect(signal.aborted).toBe(false); });
    const broker = createBroker({ home: home(), githubCredentialReader: reader });
    expect(await broker.login(target, { onGitHubLogin: humanLogin })).toMatchObject({ state: 'authenticated', source: 'github-cli' });
    expect(humanLogin).toHaveBeenCalledTimes(1); expect(reader).toHaveBeenCalledTimes(2);
  });
  it('replaces a revoked cached token through one explicit human login, then validates the replacement', async () => {
    let token = 'revoked-private-token';
    const reader = vi.fn(async () => token);
    const validator = vi.fn(async (token: string) => token === 'valid-private-token');
    const humanLogin = vi.fn(async () => { token = 'valid-private-token'; });
    const broker = createBroker({ home: home(), githubCredentialReader: reader, githubCredentialValidator: validator });
    expect((await broker.login(target, { onGitHubLogin: humanLogin })).state).toBe('authenticated');
    expect(humanLogin).toHaveBeenCalledTimes(1); expect(validator).toHaveBeenCalledTimes(2);
    expect(await broker.token(target)).toBe('valid-private-token');
    expect(validator).toHaveBeenCalledTimes(2); // No validation HTTP request per business dispatch.
  });
  it('revokes old consent when explicit login confirms a cached token is invalid', async () => {
    let valid = true;
    const broker = createBroker({ home: home(), githubCredentialReader: async () => 'private-token', githubCredentialValidator: async () => valid });
    await broker.login(target); valid = false;
    await expect(broker.login(target)).rejects.toMatchObject({ code: 'github_login_required' });
    expect(broker.status(target).state).toBe('not_authenticated');
    await expect(broker.token(target)).rejects.toMatchObject({ code: 'authentication_required' });
  });
  it('does not start browser reauthorization after a network or service validation failure', async () => {
    const humanLogin = vi.fn();
    const broker = createBroker({ home: home(), githubCredentialReader: async () => 'private-token', githubCredentialValidator: async () => { throw new Error('private-token network diagnostic'); } });
    const error = await broker.login(target, { onGitHubLogin: humanLogin }).catch(error => error);
    expect(error).toMatchObject({ code: 'github_connection_failed' });
    expect(String(error)).not.toMatch(/private-token|network diagnostic/);
    expect(humanLogin).not.toHaveBeenCalled();
  });
  it.each([200, 401, 403, 503])('validates only with fixed GitHub user endpoint and rejects redirects/body diagnostics (%i)', async status => {
    const requests: { input: unknown; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => { requests.push({ input, init }); return new Response('private response body', { status }); }));
    const broker = new McpAuthBroker({ home: home(), githubCredentialReader: async () => 'private-token' });
    const result = await broker.login(target).catch(error => error);
    if (status === 200) expect(result.state).toBe('authenticated');
    else expect(result.code).toBe(status === 401 ? 'github_login_required' : 'github_connection_failed');
    expect(String(result)).not.toContain('private response body');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ input: 'https://api.github.com/user', init: { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer private-token' } } });
  });
  it('sanitizes failed CLI output and invalid token values', async () => {
    for (const reader of [async () => { throw new Error('private-token stderr provider body'); }, async () => 'private-token\nAuthorization: stolen']) {
      const broker = createBroker({ home: home(), githubCredentialReader: reader });
      const error = await broker.login(target).catch(error => error as Error);
      expect(error).toBeInstanceOf(McpAuthError);
      expect(String(error)).not.toMatch(/private-token|stderr|provider body|stolen/);
      expect(broker.status(target).state).toBe('not_authenticated');
    }
  });
  it.each([
    { url: 'https://api.githubcopilot.com.evil.example/mcp/' },
    { url: 'https://api.githubcopilot.com/mcp/?token=secret' },
    { url: 'https://api.githubcopilot.com/mcp/#fragment' },
    { url: 'https://api.githubcopilot.com/other' },
    { url: 'http://api.githubcopilot.com/mcp/' },
    { url: 'https://api.githubcopilot.com:443/mcp/' },
    { url: '${GITHUB_MCP_URL}' },
    { transport: 'sse' as const },
    { oauth: {} },
    { headers: { aUtHoRiZaTiOn: '${TOKEN}' } },
  ])('rejects redirected/lookalike destinations and alternate auth before reading gh: %j', async change => {
    const reader = vi.fn(async () => 'private-token');
    const server = { ...target, ...change };
    const broker = createBroker({ home: home(), githubCredentialReader: reader });
    await expect(broker.login(server)).rejects.toMatchObject({ code: 'invalid_credential_provider' });
    await expect(broker.token(server)).rejects.toMatchObject({ code: 'invalid_credential_provider' });
    const config = { ...createMcpPresetConfig('github'), ...change };
    expect(parseMcpConfig(JSON.stringify({ servers: [config] })).servers).toEqual([]);
    expect(() => resolveServerConfig(config)).toThrow();
    expect(reader).not.toHaveBeenCalled();
  });
  it('uses a valid provider preset and removes delegation for an explicit token environment override', () => {
    const config = createMcpPresetConfig('github');
    expect(config.credentialProvider).toBe('github-cli');
    expect(parseMcpConfig(JSON.stringify({ servers: [config] })).diagnostics).toEqual([]);
    const custom = createMcpPresetConfig('github', { tokenEnv: 'CUSTOM_GITHUB_TOKEN' });
    expect(custom.credentialProvider).toBeUndefined();
    expect(custom.headers).toEqual({ Authorization: 'Bearer ${CUSTOM_GITHUB_TOKEN}' });
    expect(parseMcpConfig(JSON.stringify({ servers: [custom] })).diagnostics).toEqual([]);
  });
  it('does not inherit ambient tokens, alternate hosts, or unreviewed credential config paths', () => {
    const env = githubCredentialEnvironment({ PATH: '/bin', HOME: '/home/person', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', GH_ENTERPRISE_TOKEN: 'secret', GITHUB_ENTERPRISE_TOKEN: 'secret', GH_HOST: 'evil.example', GH_CONFIG_DIR: '/tmp/other-account', XDG_CONFIG_HOME: '/tmp/other-config', PRIVATE_KEY: 'secret' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/person', GH_PROMPT_DISABLED: '1' });
    expect(JSON.stringify(env)).not.toMatch(/secret|evil|other-account|other-config/);
  });
  it('invokes gh without a shell, ambient token override, or token arguments', async () => {
    if (process.platform === 'win32') return;
    const directory = home(); const bin = join(directory, 'bin'); mkdirSync(bin);
    const command = join(bin, 'gh');
    writeFileSync(command, '#!/bin/sh\nif [ "$1 $2 $3 $4" != "auth token --hostname github.com" ] || [ -n "$GH_TOKEN$GITHUB_TOKEN$GH_HOST$GH_CONFIG_DIR" ]; then exit 2; fi\nprintf "fixture-keystore-token\\n"\n'); chmodSync(command, 0o700);
    vi.stubEnv('PATH', bin); vi.stubEnv('GH_TOKEN', 'ambient-private-token'); vi.stubEnv('GITHUB_TOKEN', 'ambient-private-token'); vi.stubEnv('GH_HOST', 'evil.example'); vi.stubEnv('GH_CONFIG_DIR', '/evil');
    const broker = createBroker({ home: directory });
    await broker.login(target);
    expect(await createBroker({ home: directory }).token(target)).toBe('fixture-keystore-token');
  });
  it('cancels a hanging credential read promptly and does not grant access', async () => {
    const gate = deferred<string>(); const entered = deferred<void>();
    const broker = createBroker({ home: home(), githubCredentialReader: async () => { entered.resolve(); return gate.promise; } });
    const controller = new AbortController();
    const result = broker.login(target, { signal: controller.signal }).catch(error => error);
    await entered.promise; controller.abort();
    expect(await result).toMatchObject({ code: 'cancelled' });
    gate.resolve('private-token');
    expect(broker.status(target).state).toBe('not_authenticated');
  });
  it('bounds even an unresponsive credential reader by its deadline', async () => {
    const broker = createBroker({ home: home(), githubCredentialTimeoutMs: 20, githubCredentialReader: async () => new Promise(() => {}) });
    await expect(broker.login(target)).rejects.toMatchObject({ code: 'timeout' });
    expect(broker.status(target).state).toBe('not_authenticated');
  });
  it('does not authorize in-flight reads after another process logs out', async () => {
    const directory = home(); const gate = deferred<string>(); const entered = deferred<void>();
    const reader = vi.fn().mockResolvedValueOnce('private-token').mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const broker = createBroker({ home: directory, githubCredentialReader: reader });
    await broker.login(target);
    const result = broker.token(target).catch(error => error);
    await entered.promise; createBroker({ home: directory }).logout(target); gate.resolve('private-token');
    expect(await result).toMatchObject({ code: 'auth_changed' });
  });
  it('cannot resurrect a local grant if another process logs out during login', async () => {
    const directory = home(); const gate = deferred<string>(); const entered = deferred<void>();
    const broker = createBroker({ home: directory, githubCredentialReader: async () => { entered.resolve(); return gate.promise; } });
    const result = broker.login(target).catch(error => error);
    await entered.promise; createBroker({ home: directory }).logout(target); gate.resolve('private-token');
    expect(await result).toMatchObject({ code: 'auth_changed' });
    expect(broker.status(target).state).toBe('not_authenticated');
  });
  it('cancels human login on logout and does not revive consent when the callback returns', async () => {
    const gate = deferred<void>(); const entered = deferred<void>(); const controller = new AbortController();
    const reader = vi.fn().mockRejectedValueOnce(new Error('not logged in')).mockResolvedValue('private-token');
    const broker = createBroker({ home: home(), githubCredentialReader: reader });
    const result = broker.login(target, { signal: controller.signal, onGitHubLogin: async () => { entered.resolve(); await gate.promise; } }).catch(error => error);
    await entered.promise; broker.logout(target);
    expect(await result).toMatchObject({ code: 'cancelled' }); gate.resolve();
    expect(broker.status(target).state).toBe('not_authenticated');
    expect(reader).toHaveBeenCalledTimes(1);
  });
});
