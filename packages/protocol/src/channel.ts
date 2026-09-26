/**
 * Action channels — how the model expresses what it wants to do.
 *
 * Three of them, and none is invented here. Each is the channel through which
 * Motif-3 posted a published score, or the documented alternative to one:
 *
 *   toolcall  native `<tool_call>{json}</tool_call>`
 *             SWE-bench Verified 76.2, via mini-SWE-agent's single bash tool.
 *
 *   object    the whole response is one JSON object
 *             `{analysis, plan, commands[], task_complete}`
 *             Terminal-Bench 2.1 74.9, via Terminus 2's default parser. Note
 *             this is body parsing, not function calling.
 *
 *   raw       the whole response is XML, and command bodies are verbatim —
 *             Terminus 2's own instructions say "DO NOT XML-encode special
 *             characters, write them directly". The channel exists precisely to
 *             avoid string escaping, and string escaping is Motif's documented
 *             failure mode. Never measured on Motif. This is the experiment.
 *
 * The core loop is channel-agnostic: every channel yields the same `Action[]`.
 */

import { parseToolCalls, recoverBareToolCall, type RepairContext, type RepairInfo } from "./toolcall.js";
import { toolCallParts, unwrapTool, type Tool, type ToolCall } from "./types.js";

export type ChannelId = "toolcall" | "object" | "raw";

export type Action =
  | {
      kind: "tool";
      name: string;
      arguments: Record<string, unknown>;
      repaired: boolean;
      /** How the block was recovered; absent means it parsed as written. */
      repair?: RepairInfo;
    }
  | {
      kind: "done";
      summary: string;
      /**
       * The model's answer to the harness's confirmation challenge.
       *
       * Kept rather than discarded. Every parser used to drop it, so the second
       * `done` ended the session whatever it said — including `confirm: false`,
       * which is the model explicitly declining to finish.
       */
      confirm?: boolean;
      repair?: RepairInfo;
    };

export interface ChannelParse {
  actions: Action[];
  /** Prose to surface to the user. */
  content: string;
  /** Present on structured channels, which put planning in the response body. */
  analysis?: string;
  plan?: string;
  unrecoverable: string[];
  truncated: boolean;
  /**
   * Blocks that parsed but whose arguments were not usable — a server-extracted
   * call whose JSON did not decode, an object channel `commands` that was not
   * an array. Distinct from `unrecoverable`, which never parsed at all, because
   * the two want different repair prompts.
   */
  invalidArguments?: string[];
  /** Native wire calls, for faithful serialization of MCP's nested arguments. */
  structuredCalls?: ToolCall[];
}

export interface Channel {
  readonly id: ChannelId;
  /**
   * Instructions to append to the system prompt.
   *
   * PREFIX: this text lands in the cached prefix. It must be a pure function of
   * (channel, tool list) with no timestamps, no ids, no ordering from a hash
   * map — otherwise the prefix differs every session.
   */
  promptFragment(tools: Tool[]): string;
  /**
   * `structured` carries tool calls the server already extracted. When a server
   * runs a tool-call parser it lifts the calls out of the body, so the text
   * alone is not the whole turn — and treating it as such reports a failure
   * that never happened.
   */
  parse(text: string, ctx: RepairContext, structured?: ToolCall[]): ChannelParse;
}

/**
 * Turn a server-extracted tool call into an action.
 *
 * Returns null when the server named a tool but its arguments did not decode.
 * The tempting reading — "we still know which tool was meant, run it with no
 * arguments" — turns a `bash` call whose JSON broke into `bash` with an empty
 * command, and a `done` whose JSON broke into a completion claim. Neither is
 * what the model asked for, and both look like ordinary turns afterwards.
 */
function actionFromToolCall(tc: ToolCall): Action | null {
  const { name, args } = toolCallParts(tc);
  if (name === "") return null;
  let decoded: Record<string, unknown> | null = null;
  if (args === undefined || args === null) {
    decoded = {};
  } else if (typeof args === "string") {
    if (args.trim() === "") {
      decoded = {};
    } else {
      try {
        const v = JSON.parse(args) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) decoded = v as Record<string, unknown>;
      } catch {
        decoded = null;
      }
    }
  } else if (typeof args === "object" && !Array.isArray(args)) {
    decoded = args as Record<string, unknown>;
  }
  if (decoded === null) return null;
  return name === "done"
    ? {
        kind: "done",
        summary: String(decoded["summary"] ?? ""),
        ...(typeof decoded["confirm"] === "boolean" ? { confirm: decoded["confirm"] } : {}),
      }
    : { kind: "tool", name, arguments: decoded, repaired: false };
}

/** Map server-extracted calls, reporting any whose arguments did not decode. */
function actionsFromToolCalls(structured: ToolCall[], text: string): ChannelParse {
  const actions: Action[] = [];
  const invalidArguments: string[] = [];
  for (const tc of structured) {
    const action = actionFromToolCall(tc);
    if (action === null) invalidArguments.push(JSON.stringify(tc).slice(0, 400));
    else actions.push(action);
  }
  return {
    actions,
    structuredCalls: structured,
    content: text.trim(),
    unrecoverable: [],
    truncated: false,
    ...(invalidArguments.length > 0 ? { invalidArguments } : {}),
  };
}

/**
 * Tools are registered in the `tools` array on *every* channel, including the
 * ones that do not use native function calling.
 *
 * That looks redundant, and it is not. The chat template only renders the
 * reasoning of intermediate assistant turns when `tools` is non-empty — with an
 * empty array the model's own interleaved thinking is silently dropped from its
 * history, which is off-distribution for a model whose generation prompt always
 * opens `<think>`. Registering the tools costs prefix tokens that are cached
 * anyway, and buys reasoning continuity. Verified in template.test.ts.
 */
export const ALWAYS_REGISTER_TOOLS = true;

/* ------------------------------------------------------------------ */

class ToolCallChannel implements Channel {
  readonly id = "toolcall" as const;

  promptFragment(): string {
    return [
      "Call tools using the function-calling format described above.",
      "Emit one `<tool_call>` block per call; several may appear in one turn.",
      "Finish by calling `done` — a bare text reply is never a final answer.",
    ].join("\n");
  }

  parse(text: string, ctx: RepairContext, structured?: ToolCall[]): ChannelParse {
    // Server-extracted calls win. They have already been through the server's
    // repair ladder, which sees the raw token stream; ours only sees what is
    // left in the body afterwards.
    if (structured && structured.length > 0) {
      return actionsFromToolCalls(structured, text);
    }
    const r = parseToolCalls(text, ctx);
    const actions: Action[] = r.calls.map((c) =>
      c.name === "done"
        ? {
            kind: "done" as const,
            summary: String(c.arguments["summary"] ?? ""),
            ...(typeof c.arguments["confirm"] === "boolean"
              ? { confirm: c.arguments["confirm"] as boolean }
              : {}),
            ...(c.repair ? { repair: c.repair } : {}),
          }
        : {
            kind: "tool" as const,
            name: c.name,
            arguments: c.arguments,
            repaired: c.repaired,
            ...(c.repair ? { repair: c.repair } : {}),
          },
    );
    // No `<tool_call>` block and no server-extracted call, but the body may
    // still BE a call the model wrote without the tags. Recovering it turns a
    // silently lost turn into the action the model asked for; it then flows
    // through the same validation and permission gate as any other call.
    if (actions.length === 0) {
      const bare = recoverBareToolCall(r.content, ctx);
      if (bare) {
        const action: Action =
          bare.name === "done"
            ? {
                kind: "done",
                summary: String(bare.arguments["summary"] ?? ""),
                ...(typeof bare.arguments["confirm"] === "boolean"
                  ? { confirm: bare.arguments["confirm"] as boolean }
                  : {}),
                ...(bare.repair ? { repair: bare.repair } : {}),
              }
            : {
                kind: "tool",
                name: bare.name,
                arguments: bare.arguments,
                repaired: true,
                ...(bare.repair ? { repair: bare.repair } : {}),
              };
        return { actions: [action], content: "", unrecoverable: [], truncated: false };
      }
    }
    return {
      actions,
      content: r.content.trim(),
      unrecoverable: r.unrecoverable,
      truncated: r.truncated,
    };
  }
}

/* ------------------------------------------------------------------ */

interface ObjectResponse {
  analysis?: string;
  plan?: string;
  commands?: { keystrokes?: string; duration?: number }[];
  task_complete?: boolean;
  /** Answer to the harness's confirmation challenge; see the `done` contract. */
  confirm?: boolean;
  summary?: string;
}

class ObjectChannel implements Channel {
  readonly id = "object" as const;

  promptFragment(): string {
    return [
      "Respond with a single JSON object and nothing else:",
      "",
      "{",
      '  "analysis": "what the terminal currently shows and what remains",',
      '  "plan": "what you will run next and why",',
      '  "commands": [ { "keystrokes": "ls -la\\n", "duration": 0.1 } ],',
      '  "task_complete": false',
      "}",
      "",
      "`keystrokes` is sent to a persistent terminal verbatim, so most shell",
      "commands need a trailing newline to run. Use tmux notation for control",
      "keys (`C-c`, `C-d`). `duration` is seconds to wait before the next",
      "command: 0.1 for instant things, 1.0 for compiles, longer for builds.",
      'To simply wait, send { "keystrokes": "", "duration": 10 }. Never wait',
      "more than 60 seconds at a time; poll instead.",
      "",
      'Set "task_complete": true only when finished. The harness will challenge',
      'it once; answer by repeating the same "summary" with "confirm": true.',
      'Only that second, confirmed object ends the session.',
    ].join("\n");
  }

  parse(text: string, ctx: RepairContext, structured?: ToolCall[]): ChannelParse {
    void ctx;
    // A model may answer with native tool calls even when asked for an object;
    // honour them rather than calling the turn empty.
    if (structured && structured.length > 0) {
      return actionsFromToolCalls(structured, text);
    }
    const obj = extractJsonObject(text);
    if (!obj) {
      return { actions: [], content: text.trim(), unrecoverable: [text.trim()], truncated: false };
    }
    const r = obj as ObjectResponse;
    const actions: Action[] = [];
    const invalidArguments: string[] = [];

    // `commands` arriving as an object, a string or null is a shape error, not
    // a crash. Iterating it directly used to throw a TypeError out of the
    // parser, which the loop had no way to read as a parse failure.
    if (r.commands !== undefined && !Array.isArray(r.commands)) {
      invalidArguments.push(
        `"commands" must be an array, got ${r.commands === null ? "null" : typeof r.commands}`,
      );
    } else {
      for (const c of r.commands ?? []) {
        if (c === null || typeof c !== "object" || Array.isArray(c)) {
          invalidArguments.push(`each command must be an object, got ${JSON.stringify(c).slice(0, 120)}`);
          continue;
        }
        actions.push({
          kind: "tool",
          name: "term",
          // Deliberately not coerced. A `duration` the model sent as a string
          // is a schema violation the validator should reject, not something
          // this parser should quietly turn into a number.
          arguments: {
            keystrokes: c.keystrokes ?? "",
            duration_s: c.duration === undefined ? 1.0 : c.duration,
          },
          repaired: false,
        });
      }
    }

    if (r.task_complete === true) {
      actions.push({
        kind: "done",
        summary: r.summary ?? r.analysis ?? "",
        ...(typeof r.confirm === "boolean" ? { confirm: r.confirm } : {}),
      });
    }
    return {
      actions,
      content: "",
      analysis: r.analysis,
      plan: r.plan,
      unrecoverable: [],
      truncated: false,
      ...(invalidArguments.length > 0 ? { invalidArguments } : {}),
    };
  }
}

/**
 * Pull the outermost JSON object out of a response that may be wrapped in
 * prose or a code fence. Terminus tolerates surrounding text; so do we.
 */
export function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((s): s is string => typeof s === "string");
  for (const c of candidates) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    const slice = c.slice(start, end + 1);
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      /* try next */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */

class RawChannel implements Channel {
  readonly id = "raw" as const;

  promptFragment(): string {
    return [
      "Respond with XML in exactly this shape:",
      "",
      "<response>",
      "<analysis>what the terminal shows and what remains</analysis>",
      "<plan>what you will run next and why</plan>",
      "<commands>",
      '<keystrokes duration="0.1">ls -la',
      "</keystrokes>",
      "</commands>",
      "<task_complete>false</task_complete>",
      "</response>",
      "",
      "To finish, set <task_complete>true</task_complete> and add a <summary>.",
      "The harness will challenge it once; answer by repeating the same summary",
      "with <confirm>true</confirm>. Only that second response ends the session.",
      "",
      "IMPORTANT: text inside <keystrokes> is used completely verbatim. Do NOT",
      "XML-encode anything — write <, >, &, quotes and backslashes directly.",
      "Nothing inside those tags is escaped or unescaped by the harness.",
      "",
      "Most shell commands need a trailing newline to run. Use tmux notation",
      "for control keys (C-c, C-d). `duration` is seconds to wait before the",
      "next command. To wait only, send an empty <keystrokes duration=\"10\"/>.",
    ].join("\n");
  }

  parse(text: string, ctx: RepairContext, structured?: ToolCall[]): ChannelParse {
    void ctx;
    if (structured && structured.length > 0) {
      return actionsFromToolCalls(structured, text);
    }
    const actions: Action[] = [];
    const analysis = tagText(text, "analysis");
    const plan = tagText(text, "plan");

    // Deliberately hand-rolled rather than an XML parser: the contract is that
    // keystroke bodies are raw text, so a conforming parser would corrupt the
    // very thing this channel exists to protect.
    const re = /<keystrokes([^>]*)>([\s\S]*?)<\/keystrokes>/g;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const attrs = m[1] ?? "";
      const dur = /duration\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
      actions.push({
        kind: "tool",
        name: "term",
        arguments: { keystrokes: m[2] ?? "", duration_s: dur ? Number(dur) : 1.0 },
        repaired: false,
      });
    }
    const selfClosing = /<keystrokes([^>]*)\/>/g;
    for (let m = selfClosing.exec(text); m !== null; m = selfClosing.exec(text)) {
      const dur = /duration\s*=\s*"([^"]*)"/.exec(m[1] ?? "")?.[1];
      actions.push({
        kind: "tool",
        name: "term",
        arguments: { keystrokes: "", duration_s: dur ? Number(dur) : 1.0 },
        repaired: false,
      });
    }

    const complete = tagText(text, "task_complete");
    if (complete !== undefined && complete.trim() === "true") {
      const confirm = tagText(text, "confirm");
      actions.push({
        kind: "done",
        summary: tagText(text, "summary") ?? analysis ?? "",
        ...(confirm !== undefined ? { confirm: confirm.trim() === "true" } : {}),
      });
    }

    const unrecoverable =
      actions.length === 0 && !/<response>/.test(text) ? [text.trim()] : [];

    return {
      actions,
      content: "",
      analysis,
      plan,
      unrecoverable,
      truncated: /<keystrokes[^>]*>(?![\s\S]*<\/keystrokes>)/.test(text),
    };
  }
}

function tagText(text: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? (m[1] ?? "").trim() : undefined;
}

/* ------------------------------------------------------------------ */

const CHANNELS: Record<ChannelId, Channel> = {
  toolcall: new ToolCallChannel(),
  object: new ObjectChannel(),
  raw: new RawChannel(),
};

export function getChannel(id: ChannelId): Channel {
  return CHANNELS[id];
}

/**
 * Downgrade order used when the breakage budget is exceeded.
 *
 * `toolcall` carries the most structure and the most escaping; `raw` carries
 * the least of both. Degrade toward the channel that cannot suffer the failure
 * being observed.
 */
export const DOWNGRADE: Record<ChannelId, ChannelId | null> = {
  toolcall: "object",
  object: "raw",
  raw: null,
};

export function describeChannels(tools: Tool[]): string {
  return tools.map((t) => unwrapTool(t).name).join(", ");
}
