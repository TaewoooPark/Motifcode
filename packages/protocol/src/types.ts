/**
 * Wire types for the Motif-3 chat protocol.
 *
 * These mirror the shapes the model's `chat_template.jinja` reads, not the
 * OpenAI SDK's types. Where the two disagree the template wins — it is the
 * thing that actually runs on the server.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** Content may be a plain string or the OpenAI-style content-part array. */
export type Content = string | ContentPart[] | null | undefined;
export type ContentPart = string | { type: string; text?: string };

export interface ToolCallFunction {
  name: string;
  /**
   * Either a decoded object or the raw JSON string the model emitted.
   *
   * Keep the raw string when you have it: re-encoding an object can change key
   * order and whitespace, which shifts every byte after it in the rendered
   * prompt and costs you the prefix cache.
   */
  arguments?: Record<string, unknown> | string;
}

export interface ToolCall {
  /**
   * Synthesised by the harness. The model never emits ids — the chat template
   * deliberately omits them from the final assistant turn so the model does not
   * learn to produce them. Correlate parallel calls positionally.
   */
  id?: string;
  type?: "function";
  function?: ToolCallFunction;
  /** Flat form, as some servers return it. */
  name?: string;
  arguments?: Record<string, unknown> | string;
}

export interface Message {
  role: Role;
  content?: Content;
  /**
   * Reasoning kept separate from content. The template renders this for
   * *intermediate* assistant turns only when tools are present — verified
   * against the real template, see template.test.ts.
   */
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Rendered as `<|reference|>` before user content. Rarely used. */
  references?: string;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  items?: JsonSchema;
  enum?: unknown[];
}

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: JsonSchema;
}

/** Both the wrapped and bare forms are accepted, as the template accepts both. */
export type Tool = { type?: "function"; function: ToolFunction } | ToolFunction;

export function unwrapTool(tool: Tool): ToolFunction {
  return "function" in tool && tool.function ? tool.function : (tool as ToolFunction);
}

export function toolCallParts(tc: ToolCall): { name: string; args: ToolCallFunction["arguments"] } {
  if (tc.function) return { name: tc.function.name, args: tc.function.arguments };
  return { name: tc.name ?? "", args: tc.arguments };
}
