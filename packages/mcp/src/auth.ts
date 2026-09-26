import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OAuthClientProvider, OAuthDiscoveryState, StoredOAuthTokens } from '@modelcontextprotocol/client';
/** OAuth helpers load on first use, keeping the SDK out of CLI startup. */
const oauthSdk = () => import('@modelcontextprotocol/client');
import { McpAuthError, McpAuthStore, authKey, type McpAuthRecord } from './auth-store.js';
import { GitHubCliAuth, type GitHubCredentialReader, type GitHubCredentialValidator } from './github-auth.js';
export { McpAuthError } from './auth-store.js';

export interface McpAuthTarget {
  id: string;
  url?: string;
  transport?: string;
  credentialProvider?: 'github-cli';
  headers?: Record<string, unknown>;
  oauth?: { clientId?: string; clientMetadataUrl?: string; scope?: string; callbackPort?: number };
}
export interface McpAuthStatus {
  server: string;
  state: 'authenticated' | 'not_authenticated' | 'expired';
  storage: 'file' | 'github-cli';
  source?: 'github-cli';
  expiresAt?: number;
}
export interface McpLoginOptions {
  signal?: AbortSignal;
  clientId?: string;
  clientMetadataUrl?: string;
  scope?: string;
  timeoutMs?: number;
  noBrowser?: boolean;
  /** Human UI only: never forward the authorization URL to model context. */
  onAuthorization?: (url: URL) => void | Promise<void>;
  /** Human UI only: run GitHub CLI browser login without forwarding its output to a model. */
  onGitHubLogin?: (options: { signal: AbortSignal }) => void | Promise<void>;
}
export interface McpAuthBrokerOptions {
  home?: string;
  fetch?: typeof fetch;
  openBrowser?: (url: URL) => void | Promise<void>;
  fetchTimeoutMs?: number;
  /** Private credential reader seam; never log or serialize its result. */
  githubCredentialReader?: GitHubCredentialReader;
  githubCredentialValidator?: GitHubCredentialValidator;
  githubCredentialTimeoutMs?: number;
}
const required = () => new McpAuthError('authentication_required', 'MCP login is required. Use the human login controls, then retry the operation explicitly.');
const failed = () => new McpAuthError('oauth_failed', 'MCP authorization failed. Check the provider configuration and try login again.');
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    listener = () => reject(new McpAuthError('cancelled', 'MCP authorization was cancelled.'));
    if (signal.aborted) listener(); else signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([operation, stopped]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}
function secureUrl(input: string | URL): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw failed(); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) throw failed();
  return url;
}
function identity(target: McpAuthTarget): { endpoint: string; key: string } {
  if (!target.url || target.transport === 'stdio') throw new McpAuthError('oauth_unsupported', 'OAuth login requires an HTTP MCP server.');
  const endpoint = secureUrl(target.url).href;
  return { endpoint, key: authKey(endpoint, target.oauth?.clientId, target.oauth?.scope, target.oauth?.clientMetadataUrl) };
}
function checkDiscovery(state: OAuthDiscoveryState, endpoint: string): void {
  const issuer = secureUrl(state.authorizationServerUrl);
  const metadata = state.authorizationServerMetadata;
  if (!metadata || metadata.issuer !== issuer.href.replace(/\/$/, '') && metadata.issuer !== issuer.href) throw failed();
  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new McpAuthError('oauth_unsupported', 'The provider must support PKCE S256.');
  // Verified issuer metadata may declare endpoints on another origin (RFC 8414).
  // Keep TLS/URL checks here; the private fetch wrapper forbids redirects.
  for (const name of ['token_endpoint', 'registration_endpoint'] as const) {
    const value = metadata[name];
    if (value) secureUrl(value);
  }
  if (!metadata.authorization_endpoint) throw failed();
  secureUrl(metadata.authorization_endpoint);
  if (state.resourceMetadata && secureUrl(state.resourceMetadata.resource).href !== endpoint) throw new McpAuthError('oauth_resource_mismatch', 'OAuth metadata does not match the configured MCP resource.');
}
function validateTokens(tokens: StoredOAuthTokens): void {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || /[\s\x00-\x1f\x7f]/.test(tokens.access_token) || tokens.token_type?.toLowerCase() !== 'bearer') throw failed();
  if (tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in < 0)) throw failed();
}
function applyTokens(record: McpAuthRecord, tokens: StoredOAuthTokens): void {
  validateTokens(tokens);
  const issuer = record.discovery?.authorizationServerMetadata?.issuer;
  if (!issuer || tokens.issuer !== issuer) throw failed();
  record.tokens = tokens;
  record.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
}
async function defaultBrowser(url: URL): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  try { await promisify(execFile)(command, args, { timeout: 10_000 }); }
  catch { throw new McpAuthError('browser_open_failed', 'The browser could not be opened. Use login with the manual browser option.'); }
}

/** Host-only OAuth broker. It is deliberately not passed to the SDK transport:
 * transport automatic 401 retry could repeat a dispatched write operation. */
export class McpAuthBroker {
  private readonly store: McpAuthStore;
  private readonly refreshing = new Map<string, { revision: string; promise: Promise<string> }>();
  private readonly activeLogins = new Map<string, AbortController>();
  private readonly github: GitHubCliAuth;
  constructor(private readonly options: McpAuthBrokerOptions = {}) {
    this.store = new McpAuthStore(options.home);
    this.github = new GitHubCliAuth({ home: options.home, reader: options.githubCredentialReader, validator: options.githubCredentialValidator, timeoutMs: options.githubCredentialTimeoutMs });
  }
  status(server: McpAuthTarget): McpAuthStatus {
    if (server.credentialProvider) return this.github.status(server);
    if (!server.oauth) { try { identity(server); } catch { return { server: server.id, state: 'not_authenticated', storage: 'file' }; } }
    const { key } = identity(server); const saved = this.store.read(key);
    return { server: server.id, state: !saved?.tokens ? 'not_authenticated' : saved.expiresAt !== undefined && saved.expiresAt <= Date.now() ? 'expired' : 'authenticated',
      storage: 'file', ...(saved?.expiresAt !== undefined ? { expiresAt: saved.expiresAt } : {}) };
  }
  logout(server: McpAuthTarget): McpAuthStatus {
    if (server.credentialProvider) return this.github.logout(server);
    const { key } = identity(server); this.activeLogins.get(key)?.abort(); this.store.remove(key);
    return { server: server.id, state: 'not_authenticated', storage: 'file' };
  }
  private fetch(signal?: AbortSignal): typeof fetch {
    return async (input, init) => {
      const url = secureUrl(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const timeout = AbortSignal.timeout(this.options.fetchTimeoutMs ?? 15_000);
      const combined = AbortSignal.any([timeout, ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]);
      try {
        const response = await abortable((this.options.fetch ?? globalThis.fetch)(url, { ...init, redirect: 'error', signal: combined }), combined);
        // SDK errors can include provider-controlled response bodies in warnings.
        // Bound and sanitize every response before handing it to the SDK.
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        if (reader) try {
          for (;;) {
            const { done, value } = await abortable(reader.read(), combined); if (done) break;
            bytes += value.byteLength; if (bytes > 256 * 1024) throw failed(); chunks.push(value);
          }
        } finally { void reader.cancel().catch(() => {}); }
        const body = Buffer.concat(chunks).toString('utf8');
        if (!response.ok) {
          let code = 'server_error';
          try { const candidate = JSON.parse(body).error; if (['invalid_client', 'unauthorized_client', 'invalid_grant', 'access_denied', 'invalid_scope'].includes(candidate)) code = candidate; } catch { /* No provider diagnostics. */ }
          return new Response(JSON.stringify({ error: code }), { status: response.status, headers: { 'content-type': 'application/json' } });
        }
        return new Response(body || null, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
      } catch (error) {
        if (signal?.aborted) throw new McpAuthError('cancelled', 'MCP authorization was cancelled.');
        if (timeout.aborted) throw new McpAuthError('timeout', 'The OAuth provider did not respond before the deadline.');
        if (error instanceof McpAuthError) throw error;
        throw failed();
      }
    };
  }
  /** An unauthenticated handshake only, never a business tool request. Challenge
   * metadata stays inside the host and is never included in model diagnostics. */
  private async challenge(endpoint: string, signal: AbortSignal): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
    const timeout = AbortSignal.timeout(this.options.fetchTimeoutMs ?? 15_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      for (const method of ['POST', 'GET']) {
        const response = await abortable((this.options.fetch ?? globalThis.fetch)(endpoint, {
          method, redirect: 'error', signal: combined,
          headers: { Accept: 'application/json, text/event-stream', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'motifcode', version: '0.3.4' } } }) } : {}),
        }), combined);
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) {
          if ((response.headers.get('WWW-Authenticate')?.length ?? 0) > 8192) throw failed();
          const hint = (await oauthSdk()).extractWWWAuthenticateParams(response);
          const resourceMetadataUrl = hint.resourceMetadataUrl ? secureUrl(hint.resourceMetadataUrl) : undefined;
          if (resourceMetadataUrl && resourceMetadataUrl.origin !== new URL(endpoint).origin) throw new McpAuthError('oauth_resource_mismatch', 'OAuth resource metadata must use the configured MCP origin.');
          if (hint.scope && (hint.scope.length > 2048 || /[\x00-\x1f\x7f]/.test(hint.scope))) throw failed();
          return { resourceMetadataUrl, scope: hint.scope };
        }
        // Close an anonymous initialize session if the provider created one.
        const session = response.headers.get('Mcp-Session-Id');
        if (method === 'POST' && response.ok && session && session.length <= 1024) {
          const closed = await abortable((this.options.fetch ?? globalThis.fetch)(endpoint, { method: 'DELETE', redirect: 'error', signal: combined, headers: { 'Mcp-Session-Id': session } }), combined);
          void closed.body?.cancel().catch(() => {});
        }
        if (response.status !== 405) break;
      }
      return {};
    } catch (error) {
      if (signal.aborted) throw new McpAuthError('cancelled', 'MCP authorization was cancelled.');
      if (timeout.aborted) throw new McpAuthError('timeout', 'The MCP authorization challenge exceeded its deadline.');
      if (error instanceof McpAuthError) throw error;
      throw failed();
    }
  }
  /** Return a token only before dispatch. Never opens a browser or retries a tool. */
  async token(server: McpAuthTarget, options: { signal?: AbortSignal } = {}): Promise<string | undefined> {
    if (server.credentialProvider) return this.github.token(server, options);
    // Existing anonymous HTTP servers do not opt into OAuth's HTTPS requirement.
    if (!server.oauth) { try { identity(server); } catch { return undefined; } }
    const { key, endpoint } = identity(server); const saved = this.store.read(key);
    if (!saved?.tokens) return undefined;
    if (options.signal?.aborted) throw new McpAuthError('cancelled', 'MCP authorization was cancelled.');
    validateTokens(saved.tokens);
    if (saved.endpoint !== endpoint) throw required();
    if (saved.expiresAt === undefined || saved.expiresAt > Date.now() + 30_000 || !saved.tokens.refresh_token && saved.expiresAt > Date.now()) return saved.tokens.access_token;
    if (!saved.tokens.refresh_token || !saved.discovery || !saved.clientInformation) throw required();
    let pending = this.refreshing.get(key);
    if (!pending || pending.revision !== saved.revision) {
      // A caller owns only its wait, not a shared credential transaction. Finish
      // an already-dispatched refresh within the fetch deadline even if nobody
      // is waiting: the provider may have rotated the refresh token. Durable
      // revision checks still prevent logout or a new login being overwritten.
      const promise = this.refresh(saved).finally(() => {
        if (this.refreshing.get(key)?.promise === promise) this.refreshing.delete(key);
      });
      pending = { revision: saved.revision, promise };
      this.refreshing.set(key, pending);
    }
    return options.signal ? abortable(pending.promise, options.signal) : pending.promise;
  }
  private async refresh(record: McpAuthRecord): Promise<string> {
    const { refreshAuthorization, OAuthError } = await oauthSdk();
    try {
      checkDiscovery(record.discovery!, record.endpoint);
      const issuer = record.discovery!.authorizationServerMetadata!.issuer;
      if (record.tokens!.issuer !== issuer || record.clientInformation!.issuer !== issuer) throw required();
      const tokens = await refreshAuthorization(record.discovery!.authorizationServerUrl, {
        metadata: record.discovery!.authorizationServerMetadata, clientInformation: record.clientInformation!,
        refreshToken: record.tokens!.refresh_token!, resource: new URL(record.endpoint), fetchFn: this.fetch(),
      });
      const revision = record.revision;
      applyTokens(record, { ...tokens, refresh_token: tokens.refresh_token ?? record.tokens!.refresh_token, issuer });
      record.revision = randomBytes(16).toString('hex'); this.store.write(record, revision);
      if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) throw required();
      return record.tokens!.access_token;
    } catch (error) {
      if (error instanceof OAuthError && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)) this.store.remove(record.key, record.revision);
      if (error instanceof McpAuthError && ['cancelled', 'timeout', 'auth_changed', 'auth_storage_error'].includes(error.code)) throw error;
      throw required();
    }
  }
  async login(server: McpAuthTarget, options: McpLoginOptions = {}): Promise<McpAuthStatus> {
    if (server.credentialProvider) return this.github.login(server, options);
    const target = { ...server, oauth: { ...server.oauth, ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}), ...(options.scope ? { scope: options.scope } : {}) } };
    const { endpoint, key } = identity(target);
    const startingRevision = this.store.read(key)?.revision ?? null;
    if (this.activeLogins.has(key)) throw new McpAuthError('login_in_progress', 'MCP login is already in progress for this server.');
    const controller = new AbortController(); this.activeLogins.set(key, controller);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
    const signal = AbortSignal.any([controller.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    const record: McpAuthRecord = { version: 1, key, endpoint, revision: randomBytes(16).toString('hex') };
    let listener: Server | undefined;
    let stopWaiting: (() => void) | undefined;
    try {
      if (signal.aborted) throw new McpAuthError('cancelled', 'MCP authorization was cancelled.');
      const state = randomBytes(32).toString('base64url'); let redirectUrl = ''; let verifier = '';
      let resolveCallback!: (value: { code: string; iss?: string }) => void;
      let rejectCallback!: (reason: Error) => void;
      const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
      // Prevent an early cancellation/error callback from becoming unhandled while discovery runs.
      void callback.catch(() => {});
      listener = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        let url: URL;
        try { url = new URL(request.url ?? '/', redirectUrl); } catch { response.writeHead(400).end('Invalid request.'); return; }
        if (request.method !== 'GET' || url.pathname !== '/callback' || request.headers.host !== new URL(redirectUrl).host) { response.writeHead(404).end('Not found.'); return; }
        const received = url.searchParams.get('state') ?? '';
        if (Buffer.byteLength(received) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received), Buffer.from(state)) || url.searchParams.getAll('state').length !== 1) { response.writeHead(400).end('Invalid authorization state.'); return; }
        if (url.searchParams.has('error')) { response.writeHead(200).end('Authorization was declined. Return to Motif.'); rejectCallback(new McpAuthError('authorization_denied', 'The provider declined MCP authorization.')); return; }
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('iss').length > 1) { response.writeHead(400).end('Invalid authorization response.'); return; }
        response.writeHead(200).end('Authorization received. Return to Motif to check completion.');
        resolveCallback({ code, ...(url.searchParams.has('iss') ? { iss: url.searchParams.get('iss')! } : {}) });
      });
      await new Promise<void>((resolve, reject) => { listener!.once('error', reject); listener!.listen(target.oauth?.callbackPort ?? 0, '127.0.0.1', resolve); });
      const address = listener.address(); if (!address || typeof address === 'string') throw failed();
      redirectUrl = `http://127.0.0.1:${address.port}/callback`;
      stopWaiting = () => rejectCallback(new McpAuthError(timeout.aborted ? 'timeout' : 'cancelled', timeout.aborted ? 'MCP login timed out.' : 'MCP authorization was cancelled.'));
      signal.addEventListener('abort', stopWaiting, { once: true }); if (signal.aborted) stopWaiting();
      const fetchFn = this.fetch(signal);
      const { auth, discoverOAuthServerInfo } = await oauthSdk();
      const challenge = await this.challenge(endpoint, signal);
      // A challenge supplies the default, but cannot widen a human's explicit scope.
      const scope = target.oauth?.scope ?? challenge.scope;
      record.discovery = { ...await abortable(discoverOAuthServerInfo(endpoint, { fetchFn, resourceMetadataUrl: challenge.resourceMetadataUrl }), signal), ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl.href } : {}) };
      checkDiscovery(record.discovery, endpoint);
      const methods = record.discovery.authorizationServerMetadata?.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
      const clientMethod = ['none', 'client_secret_basic', 'client_secret_post'].find(method => methods.includes(method));
      if (!clientMethod || (target.oauth?.clientId || target.oauth?.clientMetadataUrl) && clientMethod !== 'none') {
        throw new McpAuthError('oauth_unsupported', 'This provider requires a client authentication method that is not supported by the configured public client.');
      }
      const provider: OAuthClientProvider = {
        redirectUrl,
        clientMetadataUrl: target.oauth?.clientMetadataUrl,
        clientMetadata: { client_name: 'Motifcode', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: clientMethod },
        state: () => state,
        clientInformation: context => {
          if (!record.clientInformation && target.oauth?.clientId) record.clientInformation = { client_id: target.oauth.clientId, issuer: context?.issuer };
          return record.clientInformation;
        },
        saveClientInformation: information => { record.clientInformation = information; record.clientRedirectUrl = redirectUrl; },
        tokens: () => undefined,
        saveTokens: tokens => applyTokens(record, tokens),
        saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
        discoveryState: () => record.discovery,
        saveDiscoveryState: value => { checkDiscovery(value, endpoint); record.discovery = value; },
        validateResourceURL: async (_server, resource) => { if (resource && secureUrl(resource).href !== endpoint) throw new McpAuthError('oauth_resource_mismatch', 'OAuth metadata does not match the configured MCP resource.'); return new URL(endpoint); },
        invalidateCredentials: () => { throw failed(); },
        redirectToAuthorization: async url => {
          secureUrl(url); if (signal.aborted) throw new McpAuthError('cancelled', 'MCP authorization was cancelled.');
          await options.onAuthorization?.(url);
          if (signal.aborted) throw new McpAuthError('cancelled', 'MCP authorization was cancelled.');
          if (!options.noBrowser) {
            try { await (this.options.openBrowser ?? defaultBrowser)(url); }
            catch {
              // A human UI that already shows the URL can still finish sign-in
              // (SSH, headless or no default browser); otherwise say why.
              if (!options.onAuthorization) throw new McpAuthError('browser_open_failed', 'The browser could not be opened. Run motif mcp login in an interactive terminal to see the authorization URL, or add --no-browser there.');
            }
          }
        },
      };
      await abortable(auth(provider, { serverUrl: endpoint, scope, fetchFn, forceReauthorization: true }), signal);
      const result = await callback;
      await abortable(auth(provider, { serverUrl: endpoint, scope, fetchFn, authorizationCode: result.code, iss: result.iss }), signal);
      if (signal.aborted) throw new McpAuthError('cancelled', 'MCP authorization was cancelled.');
      if (!record.tokens) throw failed();
      // The login transaction stores nothing until the full callback and issuer checks succeed.
      this.store.write(record, startingRevision);
      return this.status(target);
    } catch (error) {
      if (signal.aborted) throw new McpAuthError(timeout.aborted ? 'timeout' : 'cancelled', timeout.aborted ? 'MCP login timed out.' : 'MCP authorization was cancelled.');
      if (error instanceof McpAuthError) throw error;
      throw failed();
    } finally {
      if (stopWaiting) signal.removeEventListener('abort', stopWaiting);
      listener?.closeAllConnections(); await new Promise<void>(resolve => { if (listener?.listening) listener.close(() => resolve()); else resolve(); });
      this.activeLogins.delete(key);
    }
  }
}
