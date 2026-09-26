import { McpClientError, McpManager, type McpManagerOptions, type McpStatus, resolveServerConfig, type McpConfig, type McpServerConfig, McpAuthBroker, McpAuthError, type McpAuthTarget } from "@motifcode/mcp";
import { openExternalUrl } from "./browser-open.js";
import { runGithubBrowserLogin } from "./github-login.js";

export interface ConnectMcpOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Explicit user request to start browser authentication when needed. */
  login?: boolean;
  forceLogin?: boolean;
  timeoutMs?: number;
  openBrowser?: (url: URL) => Promise<void>;
  onProgress?: (message: string) => void;
  fetch?: typeof fetch;
  auth?: McpAuthBroker;
  onElicitation?: McpManagerOptions["onElicitation"];
  /** Print the authorization URL instead of launching a browser (interactive terminals only). */
  noBrowser?: boolean;
  /** A person reads this terminal; defaults to stdin and stderr being TTYs. */
  humanInteractive?: boolean;
}
export interface McpConnectResult { mode: "connection-check"; ready: boolean; connections: McpStatus[]; }

/** Local credential controls need the endpoint identity, never transport secrets. */
export function localMcpAuthTarget(server: McpServerConfig, env: NodeJS.ProcessEnv = process.env): McpAuthTarget {
  const { id, enabled, transport, url, oauth, credentialProvider } = server;
  return resolveServerConfig({ id, enabled, transport, url, oauth, credentialProvider }, env);
}

/** Explicit host action: authenticates once, reconnects, and lists tools. No business calls. */
export async function connectMcpServers(config: McpConfig, options: ConnectMcpOptions = {}): Promise<McpConnectResult> {
  const auth = options.auth ?? new McpAuthBroker({ home: options.home, fetch: options.fetch, openBrowser: options.openBrowser ?? openExternalUrl });
  const manager = new McpManager(config, { env: options.env, fetch: options.fetch, auth, onElicitation: options.onElicitation });
  const results: McpStatus[] = [];
  const connect = async (id: string, reconnect = false): Promise<McpStatus> => {
    try { return await manager[reconnect ? "reconnect" : "connect"](id, options.signal); }
    catch (cause) { const status = manager.statuses().find(row => row.server === id); if (status?.state === "error") return status; throw cause; }
  };
  const login = async (server: McpServerConfig) => {
    if (server.transport === "stdio") throw new Error("OAuth is only available for HTTP MCP servers.");
    if (Object.keys(server.headers ?? {}).some(name => name.toLowerCase() === "authorization")) throw new Error("Explicit credentials cannot be replaced by OAuth.");
    // Only a person's terminal receives the URL; a model piping this command
    // through its shell must not be able to open and approve consent itself.
    const human = options.humanInteractive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
    if (options.noBrowser && !human) throw new McpAuthError("interactive_login_required", "--no-browser shows the authorization URL only in an interactive terminal.");
    options.onProgress?.(server.credentialProvider === "github-cli"
      ? `${server.id}: checking the saved GitHub CLI login. A browser sign-in is offered if needed.`
      : `${server.id}: ${options.noBrowser ? "open the URL below to authorize" : "opening the browser for authorization"}; complete sign-in there. Cancel to stop waiting.`);
    await auth.login(resolveServerConfig(server, options.env ?? process.env), {
      signal: options.signal, timeoutMs: options.timeoutMs, noBrowser: options.noBrowser === true,
      ...(human ? { onAuthorization: (url: URL) => { options.onProgress?.(`Authorization URL for ${server.id}${options.noBrowser ? "" : " (if the browser did not open)"}:\n${url.href}`); } } : {}),
      onGitHubLogin: ({ signal }) => runGithubBrowserLogin({ signal, onProgress: options.onProgress, openBrowser: options.openBrowser, env: options.env }),
    });
  };
  try {
    for (const server of config.servers) {
      if (options.signal?.aborted) break;
      if (!server.enabled) { results.push(manager.statuses().find(row => row.server === server.id)!); continue; }
      try {
        if (options.forceLogin) await login(server);
        let status = await connect(server.id);
        if (!options.forceLogin && options.login && status.error?.code === "authentication_required") {
          await login(server);
          status = await connect(server.id, true);
        }
        results.push(status);
      } catch (cause) {
        // Never print provider exceptions, callback codes, token responses, or URLs.
        results.push({ server: server.id, transport: server.transport, enabled: true, state: "error", toolCount: 0,
          error: { code: options.signal?.aborted ? "cancelled" : cause instanceof McpAuthError || cause instanceof McpClientError ? cause.code : "authentication_failed", message: options.signal?.aborted ? "Authorization cancelled." : cause instanceof McpAuthError ? cause.message : cause instanceof McpClientError ? "MCP connection did not complete. Check the reported status, server prerequisites and configured timeout." : "Authorization did not complete. Check provider access, OAuth client configuration, or try login again." } });
      }
    }
    if (options.signal?.aborted) for (const server of config.servers.filter(row => !results.some(result => result.server === row.id))) results.push({ server: server.id, transport: server.transport, enabled: server.enabled, state: "error", toolCount: 0, error: { code: "cancelled", message: "Connection cancelled." } });
    return { mode: "connection-check", ready: results.length > 0 && results.every(row => row.state === "ready"), connections: results };
  } finally { await manager.close(); }
}
