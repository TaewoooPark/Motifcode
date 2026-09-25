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
export interface McpStatus {
  server: string;
  transport: McpServerConfig['transport'];
  profile?: McpServerConfig['profile'];
  enabled: boolean;
  state: 'idle' | 'connecting' | 'ready' | 'paused' | 'error' | 'disabled' | 'closed';
  toolCount: number;
  error?: { code: string; message: string };
}
interface ServerRuntime {
  generation: number;
  controller: AbortController;
  paused: boolean;
  pending?: Promise<McpConnection>;
  current?: McpConnection;
}

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
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly closing = new Set<Promise<void>>();
  private readonly states = new Map<string, McpStatus>();
  private readonly validators = new Map<string, ArgumentValidator>();
  private readonly unknownCalls = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly lifetime = new AbortController();
  private readonly environment: NodeJS.ProcessEnv;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(config: McpConfig, private readonly options: McpManagerOptions = {}) {
    this.environment = { ...(options.env ?? process.env) };
    for (const original of config.servers) {
      if (this.servers.has(original.id)) throw new Error('Duplicate MCP server identity.');
      this.servers.set(original.id, structuredClone(original));
      this.runtimes.set(original.id, { generation: 0, controller: new AbortController(), paused: false });
      this.setState(original.id, original.enabled ? 'idle' : 'disabled');
    }
  }

  /** Local, human-facing status only: no process arguments, URLs or resolved credentials. */
  statuses(): McpStatus[] { return structuredClone([...this.states.values()]); }

  private setState(server: string, state: McpStatus['state'], toolCount = 0, error?: McpStatus['error']): void {
    const config = this.servers.get(server)!;
    this.states.set(server, { server, transport: config.transport, profile: config.profile,
      enabled: config.enabled, state, toolCount, ...(error ? { error } : {}) });
  }

  private active(server: string): ServerRuntime {
    if (this.closed) throw new McpClientError('manager_closed', 'MCP manager is closed.');
    const config = this.servers.get(server);
    if (!config?.enabled) throw new McpClientError('server_not_allowed', 'MCP server is not enabled in the trusted configuration.');
    const runtime = this.runtimes.get(server)!;
    if (runtime.paused) throw new McpClientError('server_paused', 'MCP server is disconnected for this session. Use the human connection controls to connect it.');
    return runtime;
  }

  private isCurrent(server: string, generation: number, connection?: McpConnection): boolean {
    const runtime = this.runtimes.get(server);
    return !this.closed && !!runtime && !runtime.paused && runtime.generation === generation
      && (!connection || runtime.current === connection);
  }

  private async connection(server: string, signal?: AbortSignal): Promise<McpConnection> {
    const runtime = this.active(server);
    if (signal?.aborted) throw new McpClientError('cancelled', 'MCP operation was cancelled.');
    const config = this.servers.get(server)!;
    if (runtime.current?.closed) { runtime.current = undefined; runtime.pending = undefined; }
    const generation = runtime.generation;
    if (!runtime.pending) {
      this.setState(server, 'connecting');
      const pending = Promise.resolve().then(async () => {
        let connection: McpConnection | undefined;
        try {
          if (!this.isCurrent(server, generation)) throw new McpClientError('cancelled', 'MCP connection was cancelled.');
          connection = new McpConnection(resolveServerConfig(config, this.environment), this.options.fetch);
          runtime.current = connection;
          await connection.open(AbortSignal.any([this.lifetime.signal, runtime.controller.signal]));
          if (!this.isCurrent(server, generation, connection)) throw new McpClientError('cancelled', 'MCP connection was cancelled.');
          this.setState(server, 'ready');
          return connection;
        } catch (error) {
          await connection?.close();
          const diagnostic = safeError(error);
          if (this.isCurrent(server, generation) && runtime.pending === pending) {
            runtime.pending = undefined;
            runtime.current = undefined;
            this.setState(server, 'error', 0, diagnostic);
          }
          throw new McpClientError(diagnostic.code, diagnostic.message);
        }
      });
      runtime.pending = pending;
    }
    // A cancelled waiter must settle promptly without cancelling another caller's
    // shared startup. Human disconnect aborts the actual generation instead.
    return deadline(config.startupTimeoutMs ?? 10_000,
      AbortSignal.any([this.lifetime.signal, runtime.controller.signal, ...(signal ? [signal] : [])]),
      () => runtime.pending!);
  }

  /** Human-only lifecycle operations; deliberately absent from model host controls. */
  async connect(server: string, signal?: AbortSignal): Promise<McpStatus> {
    if (this.closed) throw new McpClientError('manager_closed', 'MCP manager is closed.');
    if (!this.servers.get(server)?.enabled) throw new McpClientError('server_not_allowed', 'MCP server is not enabled in the trusted configuration.');
    if (signal?.aborted) throw new McpClientError('cancelled', 'MCP operation was cancelled.');
    const runtime = this.runtimes.get(server)!;
    if (runtime.paused) {
      runtime.paused = false;
      runtime.controller = new AbortController();
      this.setState(server, 'idle');
    }
    const generation = runtime.generation;
    let connection: McpConnection | undefined;
    try {
      connection = await this.connection(server, signal);
      const tools = await connection.list({ signal: AbortSignal.any([runtime.controller.signal, ...(signal ? [signal] : [])]) });
      if (!this.isCurrent(server, generation, connection)) throw new McpClientError('cancelled', 'MCP connection was cancelled.');
      this.setState(server, 'ready', tools.filter(tool => this.allowed(server, tool.name)).length);
      return structuredClone(this.states.get(server)!);
    } catch (error) {
      const diagnostic = safeError(error);
      if (connection && this.isCurrent(server, generation, connection)) this.setState(server, 'error', 0, diagnostic);
      throw new McpClientError(diagnostic.code, diagnostic.message);
    }
  }

  private pause(server: string): { generation: number; settled: Promise<void> } {
    if (this.closed) throw new McpClientError('manager_closed', 'MCP manager is closed.');
    if (!this.servers.get(server)?.enabled) throw new McpClientError('server_not_allowed', 'MCP server is not enabled in the trusted configuration.');
    const runtime = this.runtimes.get(server)!;
    const pending = runtime.pending;
    const connection = runtime.current;
    runtime.generation++;
    runtime.paused = true;
    runtime.pending = undefined;
    runtime.current = undefined;
    runtime.controller.abort();
    this.setState(server, 'paused');
    const settled = Promise.allSettled([
      ...(connection ? [connection.close()] : []),
      ...(pending ? [pending.then(client => client.close())] : []),
    ]).then(() => {});
    this.closing.add(settled);
    void settled.then(() => this.closing.delete(settled));
    return { generation: runtime.generation, settled };
  }

  async disconnect(server: string): Promise<McpStatus> {
    await this.pause(server).settled;
    return structuredClone(this.states.get(server)!);
  }

  async reconnect(server: string, signal?: AbortSignal): Promise<McpStatus> {
    if (signal?.aborted) throw new McpClientError('cancelled', 'MCP operation was cancelled.');
    const paused = this.pause(server);
    await paused.settled;
    if (this.closed || this.runtimes.get(server)!.generation !== paused.generation) {
      throw new McpClientError('cancelled', 'MCP reconnection was superseded by another connection control.');
    }
    return this.connect(server, signal);
  }

  private allowed(server: string, name: string): boolean {
    const config = this.servers.get(server);
    return !!config?.enabled && !this.runtimes.get(server)?.paused && !config.deniedTools?.includes(name) && (config.allowedTools === undefined || config.allowedTools.includes(name));
  }

  private describe(server: string, tool: Tool): McpTool {
    const requiresUserInteraction = tool._meta?.['anthropic/requiresUserInteraction'] === true;
    return { server, name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema),
      annotations: structuredClone(tool.annotations), requiresUserInteraction,
      schemaHash: jsonDigest({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null,
        requiresUserInteraction, annotations: tool.annotations ?? null }) };
  }

  async catalog(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<McpTool[]> {
    const results = await Promise.all([...this.servers].map(async ([server, config]) => {
      const runtime = this.runtimes.get(server)!;
      if (!config.enabled || runtime.paused || this.closed) return [];
      const generation = runtime.generation;
      const signal = AbortSignal.any([this.lifetime.signal, runtime.controller.signal, ...(options.signal ? [options.signal] : [])]);
      let connection: McpConnection | undefined;
      try {
        connection = await this.connection(server, signal);
        const tools = await connection.list({ ...options, signal });
        if (!this.isCurrent(server, generation, connection)) return [];
        const allowed = tools.filter(tool => this.allowed(server, tool.name));
        this.setState(server, 'ready', allowed.length);
        return allowed.map(tool => this.describe(server, tool));
      } catch (error) {
        if (connection && this.isCurrent(server, generation, connection)) this.setState(server, 'error', 0, safeError(error));
        return [];
      }
    }));
    return results.flat();
  }

  async getTool(server: string, name: string, options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<McpTool | undefined> {
    if (!this.allowed(server, name)) return undefined;
    const runtime = this.active(server);
    const generation = runtime.generation;
    const signal = AbortSignal.any([this.lifetime.signal, runtime.controller.signal, ...(options.signal ? [options.signal] : [])]);
    const connection = await this.connection(server, signal);
    const tools = await connection.list({ ...options, signal });
    if (!this.isCurrent(server, generation, connection)) throw new McpClientError('cancelled', 'MCP tool discovery was cancelled.');
    this.setState(server, 'ready', tools.filter(tool => this.allowed(server, tool.name)).length);
    const tool = tools.find(t => t.name === name);
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
    const runtime = this.runtimes.get(server)!;
    const generation = runtime.generation;
    const invocationSignal = AbortSignal.any([this.lifetime.signal, runtime.controller.signal, ...(options.signal ? [options.signal] : [])]);
    this.inFlight.add(digest);
    let dispatched = false;
    let connection: McpConnection | undefined;
    try {
      return await deadline(this.servers.get(server)!.toolTimeoutMs ?? 30_000, invocationSignal, async signal => {
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
        if (signal.aborted || !this.isCurrent(server, generation, connection)) return failure('cancelled', 'MCP invocation was cancelled before execution.');
        dispatched = true;
        const result = await connection.call(tool, snapshot, signal);
        return { ok: true as const, execution: 'completed' as const, isError: result.isError === true, result };
      }, () => { void connection?.close(); });
    } catch (error) {
      if (dispatched) this.unknownCalls.add(digest);
      const diagnostic = safeError(error);
      if (connection && this.isCurrent(server, generation, connection)) this.setState(server, 'error', 0, diagnostic);
      return failure(diagnostic.code, diagnostic.message, dispatched ? 'unknown' : 'not_started');
    } finally { this.inFlight.delete(digest); }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.lifetime.abort();
      const pending: Promise<unknown>[] = [...this.closing];
      for (const [server, runtime] of this.runtimes) {
        runtime.generation++;
        runtime.controller.abort();
        if (runtime.current) pending.push(runtime.current.close());
        if (runtime.pending) pending.push(runtime.pending.then(connection => connection.close()));
        runtime.pending = undefined;
        runtime.current = undefined;
        this.setState(server, 'closed');
      }
      this.validators.clear();
      for (const key of Object.keys(this.environment)) delete this.environment[key];
      this.closePromise = Promise.allSettled(pending).then(() => {});
    }
    return this.closePromise;
  }
}
