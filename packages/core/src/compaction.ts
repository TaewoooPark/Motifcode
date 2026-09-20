/**
 * Context compaction, the way Codex does it.
 *
 * When a conversation outgrows its window, the choice is between losing the
 * oldest turns wholesale and asking the model to write a handoff. Codex asks
 * for the handoff: one request with the whole transcript and a summarisation
 * prompt, whose reply becomes the history — after the person's own messages,
 * kept verbatim, so what was asked is never a paraphrase. The next turn reads
 * a summary written by the model that did the work, addressed to the model
 * that will continue it.
 *
 * What is deliberately not kept: tool results, reasoning, the harness's own
 * repair prompts. The summary is asked to carry the state those established —
 * which files changed, what was decided, what remains — and the working tree
 * carries the rest. A compaction that kept "the important tool results"
 * would have to decide which ones, and the model is better placed to say.
 */

import { splitThinking, type Message, type Tool } from "@motifcode/protocol";
import type { Transport } from "./transport.js";

/** Asked of the model when the context is being compacted. */
export const SUMMARIZATION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Your job is to write a",
  "handoff summary that lets a fresh model continue this conversation without",
  "the transcript. Write it for a reader who has the same tools and the same",
  "working tree but none of your memory.",
  "",
  "Include, in this order:",
  "1. TASK STATE — what was asked, in the person's own terms; what is finished;",
  "   what is still open.",
  "2. DECISIONS AND CONTEXT — choices made and why, constraints discovered,",
  "   anything the person said that changes how the work should be done.",
  "3. FILES AND CODE — paths, functions and commands that matter, with the",
  "   state they were left in. Quote exact identifiers; never paraphrase a path.",
  "4. NEXT STEPS — what to do next, concretely, and what to verify.",
  "5. OPEN QUESTIONS — anything unresolved, and any tool output that surprised you.",
  "",
  "Be complete rather than brief: this replaces the transcript. Do not call any",
  "tool and do not address the person; reply with the summary and nothing else.",
].join("\n");

/** Put before the summary in the compacted history. */
export const SUMMARY_PREFIX = [
  "The earlier part of this conversation was compacted to save context. A",
  "summary written by the model that did that work follows. The working tree",
  "reflects everything it describes; build on it rather than redoing it. The",
  "person's earlier messages are kept above, verbatim.",
  "",
].join("\n");

/** Bytes of the person's own messages kept verbatim; the oldest go first when over. */
export const USER_TURNS_BUDGET_BYTES = 20_000;

export interface CompactionEvent {
  /** Server-reported prompt tokens of the request that crossed the limit. */
  beforeTokens: number;
  /** Characters in the summary, as a size the reader can compare against. */
  summaryChars: number;
  summary: string;
}

/**
 * The person's messages, verbatim, newest kept when over budget.
 *
 * The budget is in bytes because that is what the context is made of; the
 * newest messages win because they are the ones the summary is least likely
 * to have absorbed fully.
 */
export function keepUserTurns(turns: readonly string[], budgetBytes = USER_TURNS_BUDGET_BYTES): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(turns[i]!, "utf8");
    if (used + size > budgetBytes && kept.length > 0) break;
    kept.unshift(turns[i]!);
    used += size;
  }
  return kept;
}

/** The history that replaces the transcript: the person's turns, then the summary. */
export function buildCompactedHistory(userTurns: readonly string[], summary: string): Message[] {
  const out: Message[] = keepUserTurns(userTurns).map((t) => ({ role: "user", content: t }));
  out.push({ role: "user", content: `${SUMMARY_PREFIX}${summary.trim()}` });
  return out;
}

export interface SummarizeOptions {
  transport: Transport;
  /** The transcript to compact, system turn first. */
  messages: readonly Message[];
  /** Registered as on every request; the template drops reasoning otherwise. */
  tools: Tool[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Ask the model for the handoff.
 *
 * The transcript goes as is, with the prompt as one more user turn. No tool
 * may be called — the prompt says so and the reply is read as text; a model
 * that answers with a tool call has produced an empty summary, and the caller
 * treats that as a failed compaction rather than as a history of nothing.
 */
export async function summarizeTranscript(opts: SummarizeOptions): Promise<string> {
  const response = await opts.transport.complete({
    messages: [...opts.messages, { role: "user", content: SUMMARIZATION_PROMPT }],
    tools: opts.tools,
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  // Reasoning is separated the way the loop separates it: by the server when
  // it does, and by the scrubber when the body carries the think block itself.
  const body = response.reasoningContent !== undefined ? response.content : splitThinking(response.rawText).content;
  const text = body.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
  if (text === "") throw new Error("the model returned no summary; the context was left as it was");
  return text;
}
