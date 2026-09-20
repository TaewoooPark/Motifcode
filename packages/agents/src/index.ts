/**
 * Subagents.
 *
 * A subagent is a separate conversation with its own context, run to
 * completion, returning text. Two things about it are decided by the model
 * rather than by taste.
 *
 * **Tools come from a canonical prefix, not a filter.** Rendering the same tools
 * in a different order leaves about a quarter of the prompt prefix intact, so a
 * subagent that hand-picked a set would pay a cold cache on every spawn. It
 * takes the first N of the canonical list instead, which is why that list is
 * ordered by how universally a tool is needed.
 *
 * **Concurrency follows the endpoint.** A hosted endpoint admits several
 * requests at once, and subagents fan out there. A local endpoint is one GPU
 * and the engine serialises anyway, so parallel spawning there buys queueing
 * latency and a frozen-looking screen. The concurrency is a knob, defaulting
 * to 1 for a local endpoint and 4 otherwise.
 */

import type { Tool } from "@motifcode/protocol";
import { toolPrefix } from "@motifcode/tools";

export interface AgentDef {
  name: string;
  description: string;
  /**
   * How many tools from the canonical list this agent gets.
   *
   * The order is `done, bash, read, apply_patch, term, skill, task, mcp`, so 3
   * is a read-only agent, 4 can edit, 5 can drive a terminal, and 8 is
   * everything.
   */
  toolCount: number;
  /**
   * This agent must not change anything.
   *
   * Enforced by the executor's policy, not by the instructions. A prompt that
   * asks an agent not to write is a request; a policy that will not run a
   * program outside a read-only sandbox is a boundary.
   */
  readOnly?: boolean;
  /** Appended to the subagent's system prompt. */
  instructions: string;
  /** Turn ceiling. Subagents should be cheap and bounded. */
  maxTurns?: number;
  source?: "builtin" | "project" | "user";
}

export interface ResolvedAgent extends AgentDef {
  tools: Tool[];
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDef>();

  register(def: AgentDef): void {
    if (def.toolCount < 1) throw new Error(`agent "${def.name}" needs at least the done tool`);
    this.agents.set(def.name, def);
  }

  registerAll(defs: readonly AgentDef[]): void {
    for (const d of defs) this.register(d);
  }

  get(name: string): ResolvedAgent | undefined {
    const def = this.agents.get(name);
    if (!def) return undefined;
    return { ...def, tools: toolPrefix(def.toolCount) };
  }

  list(): AgentDef[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One line each, for the system prompt. */
  index(): string {
    const rows = this.list().map((a) => `  ${a.name} — ${a.description}`);
    if (rows.length === 0) return "";
    return ["# Subagents", "", "Delegate with the `task` tool:", ...rows].join("\n");
  }
}

/* ------------------------------------------------------------------ */

export interface QueueEntry {
  agent: string;
  prompt: string;
  state: "queued" | "running" | "done" | "failed";
  result?: string;
}

function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Runs subagents with a concurrency cap.
 *
 * One is the honest setting for a single local GPU: the requests would queue
 * in the server anyway, and doing it here means the queue is visible on
 * screen instead of appearing as a stall. A hosted endpoint gets more.
 */
export class AgentScheduler {
  private readonly queue: QueueEntry[] = [];
  private running = 0;

  constructor(
    private readonly concurrency: number,
    private readonly onChange?: (entry: QueueEntry) => void,
  ) {}

  get pending(): readonly QueueEntry[] {
    return this.queue;
  }

  async submit<T>(
    agent: string,
    prompt: string,
    run: (agent: string, prompt: string) => Promise<T>,
  ): Promise<T> {
    const entry: QueueEntry = { agent, prompt, state: "queued" };
    this.queue.push(entry);
    this.onChange?.(entry);

    while (this.running >= this.concurrency) {
      await new Promise((r) => setTimeout(r, 10));
    }

    this.running++;
    entry.state = "running";
    this.onChange?.(entry);
    try {
      const result = await run(agent, prompt);
      entry.state = "done";
      entry.result = describe(result);
      this.onChange?.(entry);
      return result;
    } catch (err) {
      entry.state = "failed";
      entry.result = String(err);
      this.onChange?.(entry);
      throw err;
    } finally {
      this.running--;
      const i = this.queue.indexOf(entry);
      if (i >= 0) this.queue.splice(i, 1);
    }
  }
}

/** Concurrency that suits the endpoint. */
export function concurrencyFor(endpoint: string): number {
  // Anything pointing at this machine or one on the LAN is one box with one
  // model loaded; fanning out there is counterproductive. Everything else is
  // a hosted endpoint with its own queue.
  const local = /localhost|127\.0\.0\.1|\.local\b|::1/i.test(endpoint);
  return local ? 1 : 4;
}

export { BUILTIN_AGENTS } from "./builtin.js";
export { parseAgent, parseToolCount } from "./parse.js";
