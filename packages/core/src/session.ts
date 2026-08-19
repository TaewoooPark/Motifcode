/**
 * The context ledger.
 *
 * Append-only, and never rewritten in place. Compaction produces a new segment
 * appended after a stable prefix rather than editing history — the same
 * invariant the transcript renderer uses for scrollback, and for the same
 * reason: anything already committed has been paid for, and rewriting it throws
 * that away.
 *
 * Compaction happens late and rarely here. Most harnesses compact early because
 * their model's KV cache is expensive; Motif's is MLA-compressed at ~61 KB per
 * token, so a full 256K window costs about 15 GB and holding raw context is the
 * cheaper choice.
 */

import {
  KV_BYTES_PER_TOKEN,
  MAX_CONTEXT,
  renderPrompt,
  sharedPrefixLength,
  type Message,
  type Tool,
} from "@motifcode/protocol";

export interface SessionOptions {
  system: string;
  tools: Tool[];
  /**
   * Turns that follow the system turn when the session opens.
   *
   * For a new session this is exactly one user message: the task. It is a
   * separate turn rather than an appendix to the system prompt for two
   * reasons — folding user text into the system role erases the boundary a
   * prompt-injection defence depends on, and a per-session system turn breaks
   * the cached prefix that the frozen tool list exists to protect.
   */
  initialMessages?: Message[];
  /** Fraction of the window at which compaction is considered. */
  compactAt?: number;
  /** Rough characters-per-token, until the real tokenizer is wired in. */
  charsPerToken?: number;
}

export interface ContextUsage {
  tokens: number;
  maxTokens: number;
  kvBytes: number;
  fraction: number;
}

export class Session {
  private readonly messages: Message[] = [];
  private lastPrompt = "";
  readonly tools: Tool[];
  readonly compactAt: number;
  private readonly charsPerToken: number;

  constructor(opts: SessionOptions) {
    // The tool array is frozen for the life of the session. Rendering the same
    // tools in a different order leaves only about a quarter of the prompt
    // prefix intact, so this is a copy taken once and never re-derived.
    this.tools = [...opts.tools];
    this.compactAt = opts.compactAt ?? 0.85;
    this.charsPerToken = opts.charsPerToken ?? 3.6;
    this.messages.push({ role: "system", content: opts.system });
    for (const m of opts.initialMessages ?? []) this.messages.push(m);
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  append(msg: Message): void {
    this.messages.push(msg);
  }

  appendAll(msgs: Message[]): void {
    for (const m of msgs) this.messages.push(m);
  }

  /**
   * Record an assistant turn, keeping its reasoning.
   *
   * Dropping `reasoning_content` here is the quiet mistake: the chat template
   * renders the reasoning of intermediate assistant turns whenever tools are
   * registered, so a harness that discards it produces a history the model was
   * never trained on.
   */
  appendAssistant(opts: {
    content?: string;
    reasoning?: string;
    toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  }): void {
    const msg: Message = { role: "assistant", content: opts.content ?? "" };
    if (opts.reasoning) msg.reasoning_content = opts.reasoning;
    if (opts.toolCalls?.length) {
      msg.tool_calls = opts.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    this.messages.push(msg);
  }

  appendToolResult(id: string, content: string): void {
    this.messages.push({ role: "tool", tool_call_id: id, content });
  }

  /** Render the prompt and report how much of the previous one it shares. */
  renderWithPrefix(): { prompt: string; sharedChars: number; totalChars: number } {
    const prompt = renderPrompt({
      messages: [...this.messages],
      tools: this.tools,
      addGenerationPrompt: true,
    });
    const shared = this.lastPrompt === "" ? 0 : sharedPrefixLength(this.lastPrompt, prompt);
    const result = { prompt, sharedChars: shared, totalChars: prompt.length };
    this.lastPrompt = prompt;
    return result;
  }

  usage(): ContextUsage {
    const chars = renderPrompt({
      messages: [...this.messages],
      tools: this.tools,
      addGenerationPrompt: true,
    }).length;
    const tokens = Math.round(chars / this.charsPerToken);
    return {
      tokens,
      maxTokens: MAX_CONTEXT,
      kvBytes: tokens * KV_BYTES_PER_TOKEN,
      fraction: tokens / MAX_CONTEXT,
    };
  }

  needsCompaction(): boolean {
    return this.usage().fraction >= this.compactAt;
  }

  /**
   * Append a summary segment and drop the summarised middle.
   *
   * The system turn and the most recent exchanges are kept verbatim; everything
   * between them collapses into one user-role note. The prefix up to the system
   * turn survives, which is the part worth keeping.
   */
  compact(summary: string, keepRecent = 6): void {
    const head = this.messages[0]!;
    const tail = this.messages.slice(-keepRecent);
    this.messages.length = 0;
    this.messages.push(head, {
      role: "user",
      content: `[earlier context, compacted]\n${summary}`,
    });
    for (const m of tail) this.messages.push(m);
    // A compaction is by definition a prefix break past the system turn; make
    // the next render report it honestly rather than comparing against a
    // history that no longer exists.
    this.lastPrompt = "";
  }
}
