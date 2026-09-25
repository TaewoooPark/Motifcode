import { Client, SSEClientTransport, StreamableHTTPClientTransport, isInputRequiredResult } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool, Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ResolvedMcpServerConfig } from './config.js';

export class McpClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'McpClientError'; }
}

/** An actual whole-operation timer, independent of fetch wrappers or progress. */
export async function deadline<T>(ms: number, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>, abort?: () => void): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    const stop = (code: string) => {
      controller.abort();
      abort?.();
      reject(new McpClientError(code, code === 'timeout' ? 'MCP operation exceeded its deadline.' : 'MCP operation was cancelled.'));
    };
    listener = () => stop('cancelled');
    if (signal?.aborted) listener();
    else {
      signal?.addEventListener('abort', listener, { once: true });
      timer = setTimeout(() => stop('timeout'), ms);
    }
  });
  try {
    if (controller.signal.aborted) return await stopped;
    return await Promise.race([operation(controller.signal), stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (listener) signal?.removeEventListener('abort', listener);
  }
}

/** One connection and one authorization context. No tool-call retry path. */
export class McpConnection {
  private readonly client: Client;
  private readonly transport: Transport;
  private readonly lifetime = new AbortController();
  private closePromise?: Promise<void>;
  private opening = false;
  private startupAuthError?: McpClientError;
  private generation = 0;
  private cached?: { tools: Tool[]; expires: number; generation: number };
  closed = false;

  constructor(readonly config: ResolvedMcpServerConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.client = new Client({ name: 'motifcode', version: '0.3.4' }, {
      capabilities: {}, inputRequired: { autoFulfill: false }, listMaxPages: 64,
      versionNegotiation: { mode: config.protocol === 'modern' ? { pin: '2026-07-28' } : config.protocol ?? 'legacy', probe: { maxRetries: 0 } },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => this.invalidate() } },
      defaultCacheTtlMs: 0,
    });
    this.client.onerror = () => this.invalidate(); // Do not print server-controlled diagnostics or credentials.
    this.client.onclose = () => { this.closed = true; this.invalidate(); };
    if (config.transport === 'stdio') {
      this.transport = new StdioClientTransport({ command: config.command!, args: config.args,
        cwd: config.cwd, env: config.env, stderr: 'ignore', maxBufferSize: 10 * 1024 * 1024 });
    } else {
      const url = new URL(config.url!);
      const guardedFetch: typeof fetch = async (input, init) => {
        const destination = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (destination.origin !== url.origin) return Promise.reject(new McpClientError('origin_changed', 'MCP request crossed the configured origin.'));
        const signals = [this.lifetime.signal, ...(init?.signal ? [init.signal] : [])];
        const response = await fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
        if (response.status === 401 || response.status === 403) {
          // Only HTTP status is trusted here; never surface response bodies,
          // authentication challenges, URLs, or credential-bearing headers.
          const error = response.status === 401
            ? new McpClientError('authentication_required', 'MCP credentials are missing, expired, or rejected. OAuth login and refresh are not supported; configure an environment-backed authentication header and reconnect.')
            : new McpClientError('permission_denied', 'The MCP server denied access (HTTP 403). Check account permissions and credential scopes; OAuth login and refresh are not supported.');
          if (this.opening) this.startupAuthError = error;
          // Discard the unread body before throwing so failed HTTP responses
          // cannot retain a connection or copy server-controlled diagnostics.
          await response.body?.cancel().catch(() => {});
          throw error;
        }
        return response;
      };
      const options = { requestInit: { headers: config.headers, redirect: 'error' as const }, fetch: guardedFetch };
      this.transport = config.transport === 'sse'
        ? new SSEClientTransport(url, options)
        : new StreamableHTTPClientTransport(url, { ...options, reconnectionOptions: {
          maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1,
        } });
    }
  }

  async open(signal?: AbortSignal): Promise<void> {
    const ms = this.config.startupTimeoutMs ?? 10_000;
    this.opening = true;
    try {
      await deadline(ms, signal, abortSignal => this.client.connect(this.transport, { signal: abortSignal, timeout: ms, maxTotalTimeout: ms }), () => { void this.close(); });
    } catch (error) {
      // Legacy SSE EventSource wraps fetch failures. Preserve only the fixed
      // diagnostic captured at our HTTP boundary, without replacing deadlines.
      const diagnostic = error instanceof McpClientError ? error : this.startupAuthError ?? error;
      await this.close();
      throw diagnostic;
    } finally { this.opening = false; this.startupAuthError = undefined; }
  }

  invalidate(): void { this.generation++; this.cached = undefined; }

  async list(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<Tool[]> {
    if (this.closed) throw new McpClientError('connection_closed', 'MCP connection is closed.');
    if (!options.refresh && this.cached && this.cached.expires > Date.now()) return structuredClone(this.cached.tools);
    if (!this.client.getServerCapabilities()?.tools) return [];
    const generation = this.generation;
    const ms = this.config.toolTimeoutMs ?? 30_000;
    const result = await deadline(ms, options.signal, signal => this.client.listTools(undefined, {
      signal, timeout: ms, maxTotalTimeout: ms, cacheMode: 'refresh',
    }), () => { void this.close(); });
    if (generation !== this.generation) throw new McpClientError('catalog_changed', 'MCP catalog changed while it was being read.');
    const configuredTtl = this.config.catalogTtlMs ?? 30_000;
    const hintedTtl = typeof result.ttlMs === 'number' ? Math.max(0, result.ttlMs) : this.client.getProtocolEra() === 'modern' ? 0 : configuredTtl;
    this.cached = { tools: structuredClone(result.tools), expires: Date.now() + Math.min(configuredTtl, hintedTtl), generation };
    return structuredClone(result.tools);
  }

  async call(tool: Tool, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const ms = this.config.toolTimeoutMs ?? 30_000;
    const result = await deadline(ms, signal, abortSignal => this.client.callTool({ name: tool.name, arguments: args }, {
      signal: abortSignal, timeout: ms, maxTotalTimeout: ms, resetTimeoutOnProgress: false,
      // Explicit definition disables the SDK's HEADER_MISMATCH refetch/retry.
      toolDefinition: tool, allowInputRequired: true,
    }), () => { void this.close(); });
    if (isInputRequiredResult(result)) throw new McpClientError('interaction_required', 'This MCP operation requires unsupported interactive input; it was not automatically continued.');
    return result;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.invalidate();
      this.lifetime.abort();
      // The stdio transport escalates to SIGKILL after four seconds. A broken
      // transport must not keep CLI shutdown pending beyond that grace period.
      this.closePromise = deadline(5_000, undefined, async () => {
        await this.client.close().catch(() => {});
        await this.transport.close().catch(() => {});
      }).catch(() => {});
    }
    return this.closePromise;
  }
}
