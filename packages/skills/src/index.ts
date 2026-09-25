/**
 * Skills.
 *
 * A skill is instructions, not capability. It is injected into the conversation
 * as content when asked for, and it never adds a tool.
 *
 * That restriction is not a style preference. The chat template renders the
 * tools block ahead of the system prompt in the same turn, so mutating the tool
 * list mid-session invalidates the prompt prefix — measured at leaving ~24% of
 * it intact when merely reordered. A skill that registered tools would throw
 * away the cache every time it loaded. So capability grows through content and
 * subagents; the tool list stays frozen.
 *
 * Discovery is progressive. Only a one-line index sits in the system prompt;
 * bodies load on demand through the single `skill` tool. That keeps an
 * unbounded skill library compatible with a fixed prompt prefix.
 */

export * from "./parse.js";
export * from "./registry.js";
export { BUILTIN_SKILLS } from "./builtin.js";

export * from "./arguments.js";
