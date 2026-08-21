/**
 * The frozen tool set.
 *
 * Eight tools where a general-purpose harness would carry fifteen or more. Two
 * measured facts force that:
 *
 *   1. The repair ladder's schema oracle accepts a candidate only when the tool
 *      name is registered and its argument keys are a subset of the declared
 *      properties. Fewer tools with tighter schemas means a stronger oracle,
 *      which means more of the model's malformed output survives as a correct
 *      call rather than a dropped turn.
 *
 *   2. The tool array lands in the cached prompt prefix, ahead of the system
 *      prompt. Changing it costs cache.
 *
 * CANONICAL ORDER IS PART OF THE CONTRACT.
 *
 * Rendering the same tools in a different order leaves only ~24% of the prefix
 * intact — worse than adding a tool. So the array below is ordered by how
 * universally a tool is needed, most-universal first, and any subset a subagent
 * uses must be a *prefix* of it. That is why `done` leads: every agent needs it,
 * so every subset starts with it and shares that much of the cache.
 */

import type { Tool } from "@motifcode/protocol";

export const CORE_TOOLS: readonly Tool[] = Object.freeze([
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Finish the task. This is the only way to end a turn — a plain text reply is never treated as a final answer. You will be asked to confirm once before it takes effect.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was accomplished, in one short paragraph." },
          confirm: {
            type: "boolean",
            description: "Set true only when re-confirming after the harness asks.",
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run one shell command in a fresh subshell and return its output. Directory and environment changes do not persist; prefix them instead (`cd x && ...`). Use this for everything non-interactive.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run." },
          timeout_s: { type: "number", description: "Kill the command after this many seconds." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read a file with exact line addressing. Prefer this over `cat` when you need part of a large file, so the harness can account for the tokens it costs.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          offset: { type: "number", description: "First line to read, 1-based." },
          limit: { type: "number", description: "How many lines to read." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description:
        "Write a file, creating it or replacing it entirely. Use this to create a file and to rewrite one whose new contents you already have; use `apply_patch` to change a few lines of a file you have read. Never write a file by shelling out to `cat`, `tee` or a heredoc — the content would pass through the shell, and every backtick, `$` and quote in it becomes something you have to escape correctly.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file. Parent directories are created." },
          content: { type: "string", description: "The complete new contents. Sent verbatim; nothing in it is interpreted." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Apply a unified diff to the working tree. The whole patch is one argument on purpose: an edit tool with separate path/old/new fields has three separate escaping contexts to get wrong, and this has one.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "A unified diff, including file headers." },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "term",
      description:
        "Send keystrokes to a persistent terminal session and wait. Use this for anything interactive — vim, a REPL, a debugger, ssh, a TUI — which a fresh subshell cannot drive. Most commands need a trailing newline to run. Control keys use tmux notation (C-c, C-d). Send empty keystrokes to simply wait longer.",
      parameters: {
        type: "object",
        properties: {
          keystrokes: { type: "string", description: "Sent verbatim. Include a trailing newline to execute." },
          duration_s: {
            type: "number",
            description:
              "Seconds to wait before the next action: 0.1 for instant commands, 1.0 for compiles, more for builds. Never exceed 60; poll instead.",
          },
        },
        required: ["keystrokes", "duration_s"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill",
      description:
        "Load a skill's full instructions by name. Skills extend what you can do without adding tools — which is deliberate, because the tool list is frozen for the session.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the index." } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task",
      description:
        "Delegate a self-contained piece of work to a subagent with its own context. On a local single-GPU endpoint these run one at a time.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Subagent name." },
          prompt: { type: "string", description: "Everything the subagent needs; it sees none of this conversation." },
        },
        required: ["agent", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp",
      description:
        "Call a method on a connected MCP server. One proxy tool rather than one tool per server method, so the whole MCP ecosystem is reachable without the tool list — and therefore the prompt prefix — changing.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Server name from the connected list." },
          method: { type: "string", description: "Method to call." },
          args: { type: "string", description: "JSON object of arguments, as a string." },
        },
        required: ["server", "method"],
        additionalProperties: false,
      },
    },
  },
] as const satisfies readonly Tool[]);

export const CORE_TOOL_NAMES = CORE_TOOLS.map((t) =>
  "function" in t && t.function ? t.function.name : (t as { name: string }).name,
);

/**
 * Take a subset as a canonical-order prefix.
 *
 * Anything that needs fewer tools — a subagent, a read-only session — must go
 * through here rather than filtering the array itself, so the rendered prefix
 * stays a prefix.
 */
export function toolPrefix(count: number): Tool[] {
  return CORE_TOOLS.slice(0, Math.max(1, Math.min(count, CORE_TOOLS.length)));
}

/**
 * Select named tools while preserving canonical order.
 *
 * Note this still costs cache versus the full list — it is a prefix only when
 * the names happen to be the leading ones. `toolPrefix` is preferred.
 */
export function selectTools(names: readonly string[]): Tool[] {
  const wanted = new Set(names);
  return CORE_TOOLS.filter((t, i) => wanted.has(CORE_TOOL_NAMES[i]!));
}
