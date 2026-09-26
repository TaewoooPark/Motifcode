import { Client, SSEClientTransport, StreamableHTTPClientTransport, UrlElicitationRequiredError, isInputRequiredResult } from '@modelcontextprotocol/client';
import type { CallToolResult, ElicitRequestParams, ElicitResult, Tool, Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GITHUB_MCP_ENDPOINT, type ResolvedMcpServerConfig } from './config.js';
import { McpAuthError } from './auth.js';
import { compileArguments } from './schema.js';
import { deadline, McpClientError, McpOperationBudget, McpToolRejectedError, type McpConnectionOptions, type McpElicitationRequest } from './operation.js';
export { deadline, McpClientError, McpOperationBudget, McpToolRejectedError } from './operation.js';
export type { McpAuthorization, McpConnectionOptions, McpElicitationHandler, McpElicitationRequest, McpElicitationResponse } from './operation.js';

/** One connection and one authorization context. No tool-call retry path. */
export class McpConnection {
  private readonly client: Client;
  private readonly transport: Transport;
  private readonly dispatchContext = new AsyncLocalStorage<{ onDispatch: () => void; toolRequest?: boolean; requestIds?: (string | number)[] }>();
  /** In-flight tools/call ids, and the JSON-RPC error the server answered with. */
  private readonly toolReplies = new Map<string | number, { code: number; message: string } | null>();
  private readonly lifetime = new AbortController();
  private closePromise?: Promise<void>;
  private opening = false;
  private startupAuthError?: McpClientError;
  private generation = 0;
  private cached?: { tools: Tool[]; expires: number; generation: number };
  private elicitationPending = false;
  private readonly activeBudgets = new Set<McpOperationBudget>();
  closed = false;

  constructor(readonly config: ResolvedMcpServerConfig, fetchImpl: typeof fetch = globalThis.fetch, private readonly options: McpConnectionOptions = {}) {
    this.client = new Client({ name: 'motifcode', version: '0.3.4' }, {
      capabilities: { elicitation: { form: {}, url: {} } }, inputRequired: { autoFulfill: false }, listMaxPages: 64,
      versionNegotiation: { mode: config.protocol === 'modern' ? { pin: '2026-07-28' } : config.protocol ?? 'legacy', probe: { maxRetries: 0 } },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => this.invalidate() } },
      defaultCacheTtlMs: 0,
    });
    this.client.onerror = () => this.invalidate(); // Do not print server-controlled diagnostics or credentials.
    this.client.onclose = () => { this.closed = true; this.invalidate(); };
    this.client.setRequestHandler('elicitation/create', (request, context) => this.elicit(request.params, context.mcpReq.signal));
    if (config.transport === 'stdio') {
      this.transport = new StdioClientTransport({ command: config.command!, args: config.args,
        cwd: config.cwd, env: config.env, stderr: 'ignore', maxBufferSize: 10 * 1024 * 1024 });
    } else {
      const url = new URL(config.url!);
      const guardedFetch: typeof fetch = async (input, init) => {
        const destination = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (destination.origin !== url.origin) return Promise.reject(new McpClientError('origin_changed', 'MCP request crossed the configured origin.'));
        if (config.credentialProvider === 'github-cli' && destination.href !== GITHUB_MCP_ENDPOINT) return Promise.reject(new McpClientError('origin_changed', 'GitHub MCP credential delegation is restricted to its configured endpoint.'));
        const signals = [this.lifetime.signal, ...(init?.signal ? [init.signal] : [])];
        const signal = AbortSignal.any(signals);
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        const token = await this.prepareAuthorization(signal);
        if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
        signal.throwIfAborted();
        // Authentication and SDK schema preparation can still fail locally.
        // Only crossing this fetch boundary makes a tool's outcome uncertain.
        const dispatch = this.dispatchContext.getStore();
        if (dispatch?.toolRequest) dispatch.onDispatch();
        const response = await fetchImpl(input, { ...init, headers, redirect: 'error', signal });
        if (response.status === 401 || response.status === 403) {
          // Only HTTP status is trusted here; never surface response bodies,
          // authentication challenges, URLs, or credential-bearing headers.
          const error = response.status === 401
            ? new McpClientError('authentication_required', 'MCP credentials are missing, expired, or rejected. Use motif mcp login for OAuth, or review the configured authentication header, then reconnect. The request was not retried.')
            : new McpClientError('permission_denied', 'The MCP server denied access (HTTP 403). Check the connected account and granted scopes. The request was not retried.');
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
    const send = this.transport.send.bind(this.transport);
    this.transport.send = (message, options) => {
      const dispatch = this.dispatchContext.getStore();
      if (!dispatch) return send(message, options);
      const calls = (Array.isArray(message) ? message : [message]).filter(part =>
        'method' in part && part.method === 'tools/call' && 'id' in part) as { id: string | number }[];
      const toolRequest = calls.length > 0;
      for (const { id } of calls) { dispatch.requestIds?.push(id); this.toolReplies.set(id, null); }
      // Per-operation async context keeps concurrent calls separate, including
      // auth awaits. Notifications and elicitation replies are not tool sends.
      return this.dispatchContext.run({ ...dispatch, toolRequest }, () => {
        if (toolRequest && config.transport === 'stdio') dispatch.onDispatch();
        return send(message, options);
      });
    };
    // Installed before connect: the SDK chains a pre-set handler ahead of its
    // own. A JSON-RPC error answering one of our tool calls proves the server
    // received and rejected it, unlike local timeouts or result validation.
    this.transport.onmessage = message => {
      const reply = message as { id?: string | number; error?: { code?: unknown; message?: unknown } };
      if (reply.id === undefined || !reply.error || !this.toolReplies.has(reply.id)) return;
      this.toolReplies.set(reply.id, { code: typeof reply.error.code === 'number' ? reply.error.code : 0,
        message: typeof reply.error.message === 'string' ? reply.error.message : '' });
    };
  }

  /** Refresh expired credentials before dispatch only; errors contain no provider text. */
  async prepareAuthorization(signal?: AbortSignal): Promise<string | undefined> {
    if (this.config.transport === 'stdio' || !this.options.auth || Object.keys(this.config.headers).some(name => name.toLowerCase() === 'authorization')) return undefined;
    try {
      const token = await this.options.auth.token(this.config, { signal });
      if (token !== undefined && (!token || /[\s\x00-\x1f\x7f]/.test(token))) throw new McpClientError('authentication_required', 'The stored MCP credential is invalid. Run motif mcp login again.');
      return token;
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      if (signal?.aborted || error instanceof McpAuthError && error.code === 'cancelled') throw new McpClientError('cancelled', 'MCP authentication was cancelled before dispatch.');
      if (error instanceof McpAuthError && error.code === 'timeout') throw new McpClientError('timeout', 'MCP authentication exceeded its deadline before dispatch.');
      throw new McpClientError('authentication_required', 'MCP authentication could not be prepared before dispatch. Run motif mcp login again.');
    }
  }

  private async elicit(params: ElicitRequestParams, requestSignal: AbortSignal): Promise<ElicitResult> {
    const signal = AbortSignal.any([this.lifetime.signal, requestSignal]);
    // Unattended callers never accept a server's request on the user's behalf.
    // Legacy elicitation has no reliable parent-call id. Never pause an
    // unrelated concurrent operation or attribute its question to another call.
    if (!this.options.onElicitation || this.elicitationPending || this.activeBudgets.size !== 1) return { action: 'decline' };
    if (signal.aborted) return { action: 'cancel' };
    if (!params || typeof params.message !== 'string') return { action: 'decline' };
    const message = params.message.slice(0, 8000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
    let request: McpElicitationRequest;
    if (params.mode === 'url') {
      if (typeof params.url !== 'string' || typeof params.elicitationId !== 'string' || params.elicitationId.length > 1024) return { action: 'decline' };
      let url: URL;
      try { url = new URL(params.url); } catch { return { action: 'decline' }; }
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (params.url.length > 8192 || /[\x00-\x20\x7f]/.test(params.url) || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) return { action: 'decline' };
      request = { server: this.config.id, mode: 'url', url: url.href, elicitationId: params.elicitationId, message, signal };
    } else {
      if (JSON.stringify(params.requestedSchema).length > 64_000 || Object.keys(params.requestedSchema.properties).length > 64) return { action: 'decline' };
      request = { server: this.config.id, mode: 'form', requestedSchema: structuredClone(params.requestedSchema), message, signal };
    }
    this.elicitationPending = true;
    try {
      const budget = this.activeBudgets.values().next().value!;
      const response = await budget.waitForHuman(activeSignal => this.options.onElicitation!({ ...request, signal: AbortSignal.any([signal, activeSignal]) }));
      if (signal.aborted) return { action: 'cancel' };
      if (!response || !['accept', 'decline', 'cancel'].includes(response.action)) return { action: 'decline' };
      if (response.action !== 'accept' || request.mode === 'url') return { action: response.action };
      const content = structuredClone(response.content ?? {});
      if (JSON.stringify(content).length > 64_000 || !Object.values(content).every(value => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) && value.every(item => typeof item === 'string'))) return { action: 'decline' };
      if (!compileArguments({ ...request.requestedSchema, additionalProperties: false }).check(content).valid) return { action: 'decline' };
      return { action: 'accept', content };
    } catch { return { action: signal.aborted ? 'cancel' : 'decline' }; }
    finally { this.elicitationPending = false; }
  }

  async open(signal?: AbortSignal): Promise<void> {
    const ms = this.config.startupTimeoutMs ?? 10_000;
    this.opening = true;
    try {
      await deadline(ms, signal, async abortSignal => {
        await this.prepareAuthorization(abortSignal);
        return this.client.connect(this.transport, { signal: abortSignal, timeout: ms, maxTotalTimeout: ms });
      }, () => { void this.close(); });
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

  async call(tool: Tool, args: Record<string, unknown>, signal?: AbortSignal, sharedBudget?: McpOperationBudget, onDispatch?: () => void): Promise<CallToolResult> {
    const ms = this.config.toolTimeoutMs ?? 30_000;
    const budget = sharedBudget ?? new McpOperationBudget(ms);
    const requestIds: (string | number)[] = [];
    const operation = async (abortSignal: AbortSignal) => {
      this.activeBudgets.add(budget);
      try {
        const ceiling = ms + (this.options.onElicitation ? budget.humanAllowanceMs : 0);
        const call = () => this.client.callTool({ name: tool.name, arguments: args }, {
          // The SDK ceiling includes human time; the shared host clock still
          // enforces the original active-work limit before and after the UI.
          signal: abortSignal, timeout: ceiling, maxTotalTimeout: ceiling, resetTimeoutOnProgress: false,
          // Explicit definition disables the SDK's HEADER_MISMATCH refetch/retry.
          toolDefinition: tool, allowInputRequired: true,
        });
        return await this.dispatchContext.run({ onDispatch: onDispatch ?? (() => {}), requestIds }, call);
      } catch (error) {
        if (!(error instanceof UrlElicitationRequiredError)) {
          const rejected = requestIds.map(id => this.toolReplies.get(id)).find(reply => reply);
          if (rejected) throw new McpToolRejectedError(rejected.code, rejected.message);
          throw error;
        }
        // -32042 ended the original request. A human browser handoff does not
        // establish whether a write already happened, so never replay the call.
        const requests = error.elicitations;
        let action: ElicitResult['action'] = 'decline';
        if (Array.isArray(requests) && requests.length === 1 && requests[0]?.mode === 'url') action = (await this.elicit(requests[0], abortSignal)).action;
        throw new McpClientError('interaction_required', action === 'accept'
          ? 'Browser interaction was completed, but the original MCP operation was not replayed. Reconcile its outcome before explicitly issuing a new operation.'
          : 'The MCP browser interaction was declined, cancelled, or unavailable. The original operation was not replayed.');
      } finally {
        this.activeBudgets.delete(budget);
        for (const id of requestIds) this.toolReplies.delete(id);
      }
    };
    const result = sharedBudget ? await operation(signal ?? this.lifetime.signal)
      : await budget.run(signal, operation, () => { void this.close(); });
    if (isInputRequiredResult(result)) throw new McpClientError('interaction_required', 'This MCP operation requires a modern multi-round continuation that is not supported. No embedded input was accepted and the tool call was not replayed.');
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
