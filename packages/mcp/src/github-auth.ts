import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { BASE_ENV_ALLOWLIST, GITHUB_MCP_ENDPOINT, validateCredentialProvider } from './config.js';
import { authKey, McpAuthError, McpAuthStore } from './auth-store.js';
import type { McpAuthStatus, McpAuthTarget, McpLoginOptions } from './auth.js';

export interface GitHubCredentialReadOptions { signal: AbortSignal; timeoutMs: number }
/** Host-only seam for credential storage integration. Never expose the result to a model. */
export type GitHubCredentialReader = (options: GitHubCredentialReadOptions) => Promise<string>;
export type GitHubCredentialValidator = (token: string, options: GitHubCredentialReadOptions) => Promise<boolean>;

/** gh must read its durable login, never ambient GH_TOKEN/GITHUB_TOKEN overrides. */
export function githubCredentialEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_ALLOWLIST) if (environment[key] !== undefined) env[key] = environment[key];
  return { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' };
}
const loginRequired = () => new McpAuthError('github_login_required', 'GitHub CLI login is required. Run gh auth login --hostname github.com --git-protocol https --web, then motif mcp login for this server.');
const cancelled = () => new McpAuthError('cancelled', 'GitHub MCP authorization was cancelled.');
const timedOut = () => new McpAuthError('timeout', 'GitHub CLI authorization exceeded its deadline.');
const validationFailed = () => new McpAuthError('github_connection_failed', 'GitHub account authorization could not be verified. Check network connectivity and service access, then retry login.');

const validateCliToken: GitHubCredentialValidator = async (token, { signal }) => {
  // Explicit-login validation only. An ordinary MCP request never makes this
  // extra API call or retries a business operation after a 401 response.
  const response = await fetch('https://api.github.com/user', { method: 'GET', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'motifcode', 'X-GitHub-Api-Version': '2022-11-28' } });
  void response.body?.cancel().catch(() => {});
  if (response.status === 401) return false;
  if (response.status !== 200) throw validationFailed();
  return true;
};

const readCliToken: GitHubCredentialReader = ({ signal, timeoutMs }) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(cancelled()); return; }
  // No shell, token argument, inherited output, or complete command error object.
  execFile('gh', ['auth', 'token', '--hostname', 'github.com'], {
    env: githubCredentialEnvironment(), signal, timeout: timeoutMs, maxBuffer: 16_384, encoding: 'utf8', windowsHide: true,
  }, (error, stdout) => {
    if (signal.aborted) reject(cancelled());
    else if (error) reject((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? new McpAuthError('github_cli_missing', 'GitHub CLI is not installed. Install gh, then retry GitHub MCP login.')
      : error.killed ? timedOut() : loginRequired());
    else resolve(stdout.trim());
  });
});

async function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    listener = () => reject(cancelled());
    if (signal.aborted) listener(); else signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([operation, stopped]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}

/** Durable local delegation. The grant is persisted, but gh remains the sole token owner. */
export class GitHubCliAuth {
  private readonly store: McpAuthStore;
  private readonly activeLogins = new Map<string, AbortController>();
  constructor(private readonly options: { home?: string; reader?: GitHubCredentialReader; validator?: GitHubCredentialValidator; timeoutMs?: number } = {}) {
    this.store = new McpAuthStore(options.home);
  }
  private key(server: McpAuthTarget): string {
    try { validateCredentialProvider(server); }
    catch { throw new McpAuthError('invalid_credential_provider', 'GitHub CLI credentials can be used only with the exact official GitHub HTTP MCP endpoint, without another authentication method.'); }
    if (server.credentialProvider !== 'github-cli') throw new McpAuthError('invalid_credential_provider', 'GitHub CLI credential delegation was not enabled for this server.');
    return authKey(GITHUB_MCP_ENDPOINT, 'github-cli');
  }
  status(server: McpAuthTarget): McpAuthStatus {
    const saved = this.store.read(this.key(server));
    return { server: server.id, state: saved?.endpoint === GITHUB_MCP_ENDPOINT && saved.externalCredential?.provider === 'github-cli' && saved.externalCredential.granted === true ? 'authenticated' : 'not_authenticated', storage: 'github-cli', source: 'github-cli' };
  }
  logout(server: McpAuthTarget): McpAuthStatus {
    const key = this.key(server);
    this.activeLogins.get(key)?.abort();
    // A durable tombstone stops later processes from silently reusing gh login.
    // Deliberately do not run gh auth logout: other applications retain access.
    this.store.remove(key);
    return this.status(server);
  }
  private async read(signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    if (combined.aborted) throw cancelled();
    try {
      const token = await waitFor((this.options.reader ?? readCliToken)({ signal: combined, timeoutMs: this.options.timeoutMs ?? 10_000 }), combined);
      if (!token || token.length > 16_384 || /[\s\x00-\x1f\x7f]/.test(token)) throw loginRequired();
      return token;
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (timeout.aborted || error instanceof McpAuthError && error.code === 'timeout') throw timedOut();
      if (error instanceof McpAuthError && error.code === 'github_cli_missing') throw new McpAuthError('github_cli_missing', 'GitHub CLI is not installed. Install gh, then retry GitHub MCP login.');
      // Never propagate gh stderr/stdout, token contents, or injected reader errors.
      throw loginRequired();
    }
  }
  private async verifyLogin(signal: AbortSignal): Promise<void> {
    const token = await this.read(signal);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const valid = await waitFor((this.options.validator ?? validateCliToken)(token, { signal: combined, timeoutMs: this.options.timeoutMs ?? 10_000 }), combined);
      if (!valid) throw loginRequired();
    } catch (error) {
      if (signal.aborted) throw cancelled();
      if (timeout.aborted) throw timedOut();
      if (error instanceof McpAuthError && error.code === 'github_login_required') throw loginRequired();
      throw validationFailed();
    }
  }
  async token(server: McpAuthTarget, options: { signal?: AbortSignal } = {}): Promise<string> {
    const key = this.key(server); const saved = this.store.read(key);
    if (!saved || saved.endpoint !== GITHUB_MCP_ENDPOINT || saved.externalCredential?.provider !== 'github-cli' || saved.externalCredential.granted !== true) {
      throw new McpAuthError('authentication_required', 'GitHub MCP access is not authorized in Motif. Run motif mcp login for this server.');
    }
    let token: string;
    try { token = await this.read(options.signal); }
    catch (error) {
      if (error instanceof McpAuthError && error.code === 'github_login_required') this.store.remove(key, saved.revision);
      throw error;
    }
    if (options.signal?.aborted) throw cancelled();
    if (this.store.read(key)?.revision !== saved.revision) throw new McpAuthError('auth_changed', 'GitHub MCP authorization changed; log in again before continuing.');
    return token;
  }
  async login(server: McpAuthTarget, options: McpLoginOptions = {}): Promise<McpAuthStatus> {
    const key = this.key(server);
    if (options.clientId || options.clientMetadataUrl || options.scope) throw new McpAuthError('authentication_conflict', 'GitHub CLI login cannot be combined with OAuth client options.');
    if (this.activeLogins.has(key)) throw new McpAuthError('login_in_progress', 'GitHub MCP login is already in progress.');
    let startingRevision = this.store.read(key)?.revision ?? null;
    const controller = new AbortController(); this.activeLogins.set(key, controller);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
    const signal = AbortSignal.any([controller.signal, timeout, ...(options.signal ? [options.signal] : [])]);
    try {
      try { await this.verifyLogin(signal); }
      catch (error) {
        if (!(error instanceof McpAuthError) || error.code !== 'github_login_required') throw error;
        if (signal.aborted) throw cancelled();
        // A confirmed invalid credential cannot leave an old local grant active.
        // The compare-and-write also prevents a concurrent logout being undone.
        const revision = randomBytes(16).toString('hex');
        this.store.write({ version: 1, key, endpoint: GITHUB_MCP_ENDPOINT, revision }, startingRevision);
        startingRevision = revision;
        if (!options.onGitHubLogin) throw error;
        // Interactive account setup stays in the human terminal/UI. This broker
        // never runs an unattended device login or sends its code to the model.
        await waitFor(Promise.resolve(options.onGitHubLogin({ signal })), signal);
        await this.verifyLogin(signal);
      }
      if (signal.aborted) throw cancelled();
      this.store.write({ version: 1, key, endpoint: GITHUB_MCP_ENDPOINT, revision: randomBytes(16).toString('hex'), externalCredential: { provider: 'github-cli', granted: true } }, startingRevision);
      return this.status(server);
    } catch (error) {
      if (signal.aborted) throw timeout.aborted ? timedOut() : cancelled();
      if (error instanceof McpAuthError) throw error;
      throw loginRequired();
    } finally { this.activeLogins.delete(key); }
  }
}
