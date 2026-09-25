import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { resolveServerConfig } from './config.js';
import type { McpConfig, McpServerConfig } from './config.js';
import { deadline, McpClientError, McpConnection } from './client.js';
import { compileArguments, jsonDigest } from './schema.js';
import type { ArgumentIssue, ArgumentValidator } from './schema.js';

export interface McpTool {
  server: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Tool['annotations'];
  requiresUserInteraction: boolean;
  schemaHash: string;
}
export interface McpStatus { server: string; state: 'idle' | 'ready' | 'error' | 'closed'; error?: { code: string; message: string } }
export type McpOutcome =
  | { ok: true; execution: 'completed'; isError: boolean; result: CallToolResult }
  | { ok: false; execution: 'not_started' | 'unknown'; error: { code: string; message: string; retryable: false }; issues?: ArgumentIssue[] };
export interface InvokeOptions { signal?: AbortSignal; scopeId: string; approvedInteraction?: boolean; expectedSchemaHash?: string }
export interface McpManagerOptions { env?: NodeJS.ProcessEnv; fetch?: typeof fetch }

const failure = (code: string, message: string, execution: 'not_started' | 'unknown' = 'not_started'): McpOutcome =>
  ({ ok: false, execution, error: { code, message, retryable: false } });
const safeError = (error: unknown): { code: string; message: string } => error instanceof McpClientError
  ? { code: error.code, message: error.message }
  : { code: 'connection_error', message: 'The MCP connection or response failed. Server diagnostics are withheld.' };

/** Config is a trusted immutable snapshot; model input can select only configured tools. */
export class McpManager {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly connections = new Map<string, Promise<McpConnection>>();
  private readonly states = new Map<string, McpStatus>();
  private readonly validators = new Map<string, ArgumentValidator>();
  private readonly unknownCalls = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly lifetime = new AbortController();
  private readonly environment: NodeJS.ProcessEnv;
  private closed = false;

  constructor(config: McpConfig, private readonly options: McpManagerOptions = {}) {
    this.environment = { ...(options.env ?? process.env) };
    for (const original of config.servers) {
      if (this.servers.has(original.id)) throw new Error('Duplicate MCP server identity.');
      if (!original.enabled) continue;
      this.servers.set(original.id, structuredClone(original));
      this.states.set(original.id, { server: original.id, state: 'idle' });
    }
  }

  statuses(): McpStatus[] { return structuredClone([...this.states.values()]); }

  private async connection(server: string, signal?: AbortSignal): Promise<McpConnection> {
    if (this.closed) throw new McpClientError('manager_closed', 'MCP manager is closed.');
    const config = this.servers.get(server);
    if (!config) throw new McpClientError('server_not_allowed', 'MCP server is not enabled in the trusted configuration.');
    let pending = this.connections.get(server);
    if (pending) {
      const existing = await pending;
      if (!existing.closed) return existing;
      if (this.connections.get(server) !== pending) return this.connection(server, signal);
      this.connections.delete(server);
    }
    pending = (async () => {
      let connection: McpConnection | undefined;
      try {
        connection = new McpConnection(resolveServerConfig(config, this.environment), this.options.fetch);
        await connection.open(AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]));
        this.states.set(server, { server, state: 'ready' });
        return connection;
      } catch (error) {
        await connection?.close();
        this.connections.delete(server);
        const diagnostic = safeError(error);
        this.states.set(server, { server, state: 'error', error: diagnostic });
        throw new McpClientError(diagnostic.code, diagnostic.message);
      }
    })();
    this.connections.set(server, pending);
    return pending;
  }

  private allowed(server: string, name: string): boolean {
    const config = this.servers.get(server);
    return !!config && !config.deniedTools?.includes(name) && (config.allowedTools === undefined || config.allowedTools.includes(name));
  }

  private describe(server: string, tool: Tool): McpTool {
    const requiresUserInteraction = tool._meta?.['anthropic/requiresUserInteraction'] === true;
    return { server, name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema),
      annotations: structuredClone(tool.annotations), requiresUserInteraction,
      schemaHash: jsonDigest({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null,
        requiresUserInteraction, annotations: tool.annotations ?? null }) };
  }

  async catalog(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<McpTool[]> {
    const results = await Promise.all([...this.servers].map(async ([server]) => {
      try {
        const connection = await this.connection(server, options.signal);
        const tools = await connection.list(options);
        this.states.set(server, { server, state: 'ready' });
        return tools.filter(tool => this.allowed(server, tool.name)).map(tool => this.describe(server, tool));
      } catch (error) {
        this.states.set(server, { server, state: this.closed ? 'closed' : 'error', error: safeError(error) });
        return [];
      }
    }));
    return results.flat();
  }

  async getTool(server: string, name: string, options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<McpTool | undefined> {
    if (!this.allowed(server, name)) return undefined;
    const connection = await this.connection(server, options.signal);
    const tool = (await connection.list(options)).find(t => t.name === name);
    return tool ? this.describe(server, tool) : undefined;
  }

  async invoke(server: string, method: string, args: unknown, options: InvokeOptions): Promise<McpOutcome> {
    if (!options.scopeId?.trim()) return failure('scope_required', 'MCP invocation requires a session scope.');
    if (!this.allowed(server, method)) return failure('tool_not_allowed', 'MCP server or tool is not allowed.');
    if (options.signal?.aborted || this.closed) return failure('cancelled', 'MCP invocation was cancelled before execution.');
    let digest: string;
    let snapshot: Record<string, unknown>;
    try {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error();
      // A child scope changes result visibility, not the authorization context.
      // Unknown and in-flight execution must remain shared across this manager.
      digest = jsonDigest([server, method, args]);
      snapshot = structuredClone(args) as Record<string, unknown>;
    } catch { return failure('invalid_arguments', 'MCP arguments must be a finite JSON object.'); }
    if (this.unknownCalls.has(digest)) return failure('previous_execution_unknown', 'An identical call has an unknown execution outcome in this MCP manager. Changing task scope does not permit retry; reconcile the outcome manually.');
    if (this.inFlight.has(digest)) return failure('already_in_flight', 'An identical MCP call is already in flight.');
    if (this.unknownCalls.size >= 10_000) return failure('reconciliation_required', 'Too many unresolved MCP outcomes; reconcile them before further calls.');
    this.inFlight.add(digest);
    let dispatched = false;
    let connection: McpConnection | undefined;
    try {
      return await deadline(this.servers.get(server)!.toolTimeoutMs ?? 30_000, options.signal, async signal => {
        connection = await this.connection(server, signal);
        const tool = (await connection.list({ signal })).find(t => t.name === method);
        if (!tool) return failure('tool_missing', 'The tool is not present in the current MCP catalog.');
        const metadata = this.describe(server, tool);
        if (options.expectedSchemaHash !== undefined && options.expectedSchemaHash !== metadata.schemaHash) return failure('schema_changed', 'The MCP tool changed after review; review the current schema before invoking it.');
        if (metadata.requiresUserInteraction && (!options.approvedInteraction || options.expectedSchemaHash !== metadata.schemaHash)) return failure('interaction_required', 'This tool requires explicit user approval bound to its current schema.');
        if (tool.execution?.taskSupport === 'required') return failure('unsupported_task', 'This tool requires the unsupported task execution extension.');
        let validator = this.validators.get(metadata.schemaHash);
        if (!validator) {
          try { validator = compileArguments(tool.inputSchema); }
          catch { return failure('unsupported_schema', 'The original MCP input schema could not be compiled safely.'); }
          if (this.validators.size >= 1_000) this.validators.clear();
          this.validators.set(metadata.schemaHash, validator);
        }
        const check = validator.check(snapshot);
        if (!check.valid) return { ...failure('invalid_arguments', 'Arguments do not satisfy the original MCP schema; no tool was executed.'), issues: check.issues };
        if (signal.aborted) return failure('cancelled', 'MCP invocation was cancelled before execution.');
        dispatched = true;
        const result = await connection.call(tool, snapshot, signal);
        return { ok: true as const, execution: 'completed' as const, isError: result.isError === true, result };
      }, () => { void connection?.close(); });
    } catch (error) {
      if (dispatched) this.unknownCalls.add(digest);
      const diagnostic = safeError(error);
      this.states.set(server, { server, state: 'error', error: diagnostic });
      return failure(diagnostic.code, diagnostic.message, dispatched ? 'unknown' : 'not_started');
    } finally { this.inFlight.delete(digest); }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.connections.values()].map(async pending => (await pending).close()));
    this.connections.clear();
    this.validators.clear();
    for (const key of Object.keys(this.environment)) delete this.environment[key];
    for (const server of this.servers.keys()) this.states.set(server, { server, state: 'closed' });
  }
}
