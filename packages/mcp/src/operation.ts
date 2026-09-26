/**
 * SDK-free operation primitives. Keeping them apart from client.ts lets the
 * manager load the MCP SDK only when a connection is first opened.
 */
import type { ElicitRequestFormParams } from '@modelcontextprotocol/client';
import type { McpServerConfig } from './config.js';
import { boundedDiagnosticText } from './schema.js';

/** Host-only authentication boundary. This never opens a browser or retries a request. */
export interface McpAuthorization {
  token(server: McpServerConfig, options?: { signal?: AbortSignal }): Promise<string | undefined>;
}
export type McpElicitationRequest = { server: string; message: string; signal: AbortSignal } & (
  | { mode: 'url'; url: string; elicitationId: string }
  | { mode: 'form'; requestedSchema: ElicitRequestFormParams['requestedSchema'] }
);
export interface McpElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}
/** Only the human UI receives URLs/forms; neither is included in model-facing diagnostics. */
export type McpElicitationHandler = (request: McpElicitationRequest) => Promise<McpElicitationResponse>;
export interface McpConnectionOptions { auth?: McpAuthorization; onElicitation?: McpElicitationHandler }

export class McpClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'McpClientError'; }
}
/** The server answered a sent tools/call with a JSON-RPC error: a known outcome. */
export class McpToolRejectedError extends McpClientError {
  constructor(readonly rpcCode: number, detail: string) {
    super('tool_rejected', `The server rejected the call (JSON-RPC ${rpcCode}): ${boundedDiagnosticText(detail.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ''), 1024)}`);
  }
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

/** One active-work clock, with a separate finite allowance for actual human UI. */
export class McpOperationBudget {
  readonly humanAllowanceMs: number;
  private readonly controller = new AbortController();
  private remaining: number;
  private humanRemaining: number;
  private started = 0;
  private phase: 'work' | 'human' = 'work';
  private timer?: ReturnType<typeof setTimeout>;
  private finished = false;
  private stop?: () => void;

  constructor(workMs: number, humanMs = 180_000) {
    this.remaining = workMs;
    this.humanAllowanceMs = this.humanRemaining = Number.isFinite(humanMs) ? Math.max(1, Math.min(180_000, humanMs)) : 180_000;
  }

  private arm(): void {
    this.started = Date.now();
    this.timer = setTimeout(() => this.stop?.(), this.phase === 'work' ? this.remaining : this.humanRemaining);
  }
  private charge(): void {
    clearTimeout(this.timer);
    const elapsed = Date.now() - this.started;
    if (this.phase === 'work') this.remaining = Math.max(0, this.remaining - elapsed);
    else this.humanRemaining = Math.max(0, this.humanRemaining - elapsed);
  }

  async run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>, abort?: () => void): Promise<T> {
    let listener: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      const stop = (code: 'timeout' | 'cancelled') => {
        if (this.finished) return;
        this.controller.abort(); abort?.();
        reject(new McpClientError(code, code === 'timeout' ? 'MCP operation exceeded its active-work or human-interaction deadline.' : 'MCP operation was cancelled.'));
      };
      this.stop = () => stop('timeout');
      listener = () => stop('cancelled');
      if (signal?.aborted) listener();
      else { signal?.addEventListener('abort', listener, { once: true }); this.arm(); }
    });
    try {
      if (this.controller.signal.aborted) return await stopped;
      return await Promise.race([operation(this.controller.signal), stopped]);
    } finally {
      this.finished = true; clearTimeout(this.timer); this.controller.abort();
      if (listener) signal?.removeEventListener('abort', listener);
    }
  }

  async waitForHuman<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.finished || this.controller.signal.aborted) throw new McpClientError('cancelled', 'MCP operation was cancelled.');
    if (this.phase === 'human') throw new McpClientError('interaction_required', 'Another human interaction is already pending.');
    this.charge();
    if (this.remaining <= 0) { this.stop?.(); throw new McpClientError('timeout', 'MCP active-work deadline was exhausted before human interaction.'); }
    this.phase = 'human'; this.arm();
    let listener: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      listener = () => reject(new McpClientError('cancelled', 'MCP human interaction was cancelled.'));
      this.controller.signal.addEventListener('abort', listener, { once: true });
    });
    try { return await Promise.race([operation(this.controller.signal), cancelled]); }
    finally {
      if (listener) this.controller.signal.removeEventListener('abort', listener);
      this.charge(); this.phase = 'work';
      if (!this.finished && !this.controller.signal.aborted) this.arm();
    }
  }
}
