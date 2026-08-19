/**
 * A byte-faithful port of Motif-3's `chat_template.jinja`.
 *
 * Why port it at all, when the server applies the template itself on
 * `/v1/chat/completions`? Two reasons:
 *
 *   1. Prefix accounting. The harness needs to know exactly what the prompt
 *      looks like to reason about cache reuse and context budget. Guessing is
 *      not good enough — see `PREFIX` notes below.
 *   2. The `raw` and `object` action channels drive `/v1/completions`, where
 *      the harness owns templating outright.
 *
 * Correctness is defined as: byte-identical to
 * `AutoTokenizer.apply_chat_template`. `toolkit/fixtures/gen_template_golden.py`
 * produces the reference strings and `test/template.test.ts` diffs against them.
 */

import { pyJson } from "./pyjson.js";
import {
  BOS,
  EOS,
  REFERENCE,
  ROLE_ASSISTANT,
  ROLE_SYSTEM,
  ROLE_TOOL,
  ROLE_USER,
  THINK_CLOSE,
  THINK_OPEN,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  TOOL_RESPONSE_CLOSE,
  TOOL_RESPONSE_OPEN,
  TURN_END,
  TURN_START,
} from "./tokens.js";
import { toolCallParts, unwrapTool, type Content, type Message, type Tool } from "./types.js";

export interface RenderOptions {
  messages: Message[];
  tools?: Tool[];
  addGenerationPrompt?: boolean;
  /**
   * `false` closes the thinking block in the prompt itself, so the model
   * answers directly. Anything else leaves `<think>` open — which is the
   * normal mode for this model.
   */
  enableThinking?: boolean;
}

/** Jinja's `visible_text` macro. */
function visibleText(content: Content): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const item of content) {
      if (typeof item === "string") out += item;
      else if (item && typeof item === "object" && item.type === "text") out += item.text ?? "";
    }
    return out;
  }
  return String(content);
}

/** Python `str.strip()` over ASCII whitespace, which is what the template uses. */
function pyStrip(s: string): string {
  return s.replace(/^[\s﻿ ]+|[\s﻿ ]+$/g, "");
}

function lstripNewlines(s: string): string {
  return s.replace(/^\n+/, "");
}

/**
 * The tools block, rendered exactly as the template does.
 *
 * PREFIX: this block is emitted *before* the system prompt and both live in the
 * same first turn. Measured against the real template, changing the tool list
 * costs you the cache:
 *
 *     append one tool     -> 62.9% of the prefix survives
 *     reorder two tools   -> 23.7%
 *     reverse the list    -> 23.7%
 *
 * So the tool array must be frozen *and* canonically ordered for a session.
 * Building it from a Set or a hash map means a different order per process and
 * a cold cache every run.
 */
function renderToolsBlock(tools: Tool[], systemContent: string | null): string {
  let out = TURN_START + ROLE_SYSTEM;
  out += "# Tools\n\nYou may call one or more functions to assist with the user query.\n\n";
  out += "You are provided with function signatures within <tools></tools> XML tags:\n\n<tools>";
  for (const tool of tools) {
    out += "\n" + pyJson(unwrapTool(tool));
  }
  out += "\n</tools>";
  out += "\n\nFor each function call, output in JSON within <tool_call> tags:\n";
  for (const tool of tools) {
    const fn = unwrapTool(tool);
    const props = fn.parameters?.properties ?? {};
    out += `\n${TOOL_CALL_OPEN}{"name": "${fn.name}", "arguments": {`;
    const keys = Object.keys(props);
    keys.forEach((k, i) => {
      out += `"${k}": <${k}>`;
      if (i < keys.length - 1) out += ", ";
    });
    out += `}}${TOOL_CALL_CLOSE}`;
  }
  if (systemContent !== null) out += "\n\n" + systemContent;
  out += TURN_END;
  return out;
}

function renderToolCalls(msg: Message, isLastAssistant: boolean): string {
  let out = "";
  for (const tc of msg.tool_calls ?? []) {
    const id = tc.id !== undefined && !isLastAssistant ? tc.id : null;
    const { name, args } = toolCallParts(tc);
    const idSuffix = id !== null ? `, "id": ${pyJson(id)}` : "";

    // The template's three-way branch on `arguments`, reproduced exactly.
    //
    // The first branch is a bug in the shipped template: `~ null ~` renders as
    // the empty string, so empty arguments produce `{"name": "x", "arguments": }`
    // — invalid JSON in the prompt. We reproduce it because the goal is byte
    // fidelity, and we avoid ever reaching it: see `assertRenderableToolCall`.
    let argPart: string;
    if (args === undefined || args === null || args === "" || isEmptyObject(args)) {
      argPart = "";
    } else if (typeof args === "string") {
      argPart = args;
    } else {
      argPart = pyJson(args);
    }
    out += `\n${TOOL_CALL_OPEN}{"name": "${name}", "arguments": ${argPart}${idSuffix}}${TOOL_CALL_CLOSE}`;
  }
  return out;
}

function isEmptyObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
}

/**
 * Guard against the empty-arguments template bug.
 *
 * A tool with no parameters still has to send *something*. Give such tools a
 * single no-op property rather than letting `{}` through.
 */
export function assertRenderableToolCall(name: string, args: unknown): void {
  if (args === undefined || args === null || args === "" || isEmptyObject(args)) {
    throw new Error(
      `tool_call "${name}" has empty arguments; the Motif chat template renders ` +
        `that as invalid JSON (\`"arguments": ,\`). Give the tool at least one property.`,
    );
  }
}

export function renderPrompt(opts: RenderOptions): string {
  const { messages, tools, addGenerationPrompt = false, enableThinking } = opts;
  const hasTools = Array.isArray(tools) && tools.length > 0;

  const first = messages[0];
  const hasSystem = first !== undefined && first.role === "system";

  let lastAssistantIndex = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistantIndex = i;
  });

  let out = BOS;

  if (hasTools) {
    out += renderToolsBlock(tools, hasSystem ? visibleText(first!.content) : null);
  } else if (hasSystem) {
    out += TURN_START + ROLE_SYSTEM + visibleText(first!.content) + TURN_END;
  }

  messages.forEach((m, i) => {
    const prev = i > 0 ? messages[i - 1] : undefined;
    const next = i < messages.length - 1 ? messages[i + 1] : undefined;

    if (i === 0 && m.role === "system") {
      // already rendered above
      return;
    }

    if (m.role === "system") {
      out += TURN_START + ROLE_SYSTEM + visibleText(m.content) + TURN_END;
      return;
    }

    if (m.role === "user") {
      out += TURN_START + ROLE_USER;
      if (m.references) out += REFERENCE + m.references + "\n";
      out += visibleText(m.content) + TURN_END;
      return;
    }

    if (m.role === "assistant") {
      out += TURN_START + ROLE_ASSISTANT;

      let content = visibleText(m.content);
      let reasoning = "";
      if (typeof m.reasoning_content === "string") {
        reasoning = m.reasoning_content;
      } else if (content.includes(THINK_CLOSE)) {
        const head = content.split(THINK_CLOSE)[0] ?? "";
        const parts = head.split(THINK_OPEN);
        reasoning = pyStrip(parts[parts.length - 1] ?? "");
        const idx = content.indexOf(THINK_CLOSE);
        content = lstripNewlines(content.slice(idx + THINK_CLOSE.length));
      }

      // Intermediate turns keep their reasoning only when tools are present.
      // Verified against the shipped template — with no tools registered, the
      // reasoning of every non-final assistant turn is silently dropped, which
      // takes the conversation off the distribution the model was trained on.
      const emitThink = reasoning !== "" && (hasTools || i === lastAssistantIndex);
      if (emitThink) out += THINK_OPEN + pyStrip(reasoning) + THINK_CLOSE;

      if (pyStrip(content) !== "") out += pyStrip(content);

      if (m.tool_calls && m.tool_calls.length > 0) {
        const isLastAssistant = i === lastAssistantIndex && !addGenerationPrompt;
        out += renderToolCalls(m, isLastAssistant);
      }

      out += TURN_END;
      return;
    }

    if (m.role === "tool") {
      if (prev === undefined || prev.role !== "tool") out += TURN_START + ROLE_TOOL;
      out +=
        TOOL_RESPONSE_OPEN +
        pyJson({ tool_call_id: m.tool_call_id, content: m.content }) +
        TOOL_RESPONSE_CLOSE;
      if (next === undefined || next.role !== "tool") out += TURN_END;
      return;
    }
  });

  if (addGenerationPrompt) {
    out += TURN_START + ROLE_ASSISTANT;
    out += enableThinking === false ? THINK_OPEN + THINK_CLOSE : THINK_OPEN;
  } else {
    out += EOS;
  }

  return out;
}

/**
 * Length of the shared prefix between two rendered prompts, in characters.
 *
 * Used by the status line to report cache health and by tests to assert that a
 * change which should be append-only really is.
 */
export function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
