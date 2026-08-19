/**
 * The system prompt.
 *
 * Everything here lands in the cached prefix, immediately after the tools block
 * and inside the same turn. So it has to be a pure function of (channel, skills,
 * agents, project) — no timestamps, no session ids, no ordering that comes out
 * of a hash map. One stray varying byte and every request pays a cold prefix.
 *
 * It is also deliberately short. The model already has each tool's description;
 * restating them here would cost tokens on every single request forever.
 */

import { getChannel, type ChannelId, type Tool } from "@motifcode/protocol";
import type { AgentRegistry } from "@motifcode/agents";
import type { SkillRegistry } from "@motifcode/skills";

export interface PromptOptions {
  channel: ChannelId;
  tools: Tool[];
  skills?: SkillRegistry;
  agents?: AgentRegistry;
  /** Contents of AGENTS.md or similar. Project rules outrank ours. */
  projectNotes?: string;
  cwd?: string;
}

const CORE = [
  "You are motifcode, a coding agent working in a real repository.",
  "",
  "Work like an engineer, not a search engine. Read before you write. Run the",
  "thing rather than assuming it works. Match the code that is already there.",
  "",
  "Every turn must contain at least one action. A turn with none is not an",
  "answer — it is a lost turn, and the harness will hand it back to you.",
  "Finish by calling `done`; you will be asked to confirm once.",
  "",
  "Prefer fewer, larger actions. One `rg -n` beats five file reads. Every call",
  "is a chance for a malformed argument, so batching is safer as well as faster.",
  "",
  "Say what you actually did. If a test still fails, say so and show the output.",
  "If you skipped part of the task, say which part and why.",
].join("\n");

export function buildSystemPrompt(opts: PromptOptions): string {
  const parts: string[] = [CORE];

  const channelText = getChannel(opts.channel).promptFragment(opts.tools).trim();
  if (channelText) parts.push(channelText);

  const skillIndex = opts.skills?.index().trim();
  if (skillIndex) parts.push(skillIndex);

  const agentIndex = opts.agents?.index().trim();
  if (agentIndex) parts.push(agentIndex);

  if (opts.cwd) parts.push(`Working directory: ${opts.cwd}`);

  if (opts.projectNotes?.trim()) {
    parts.push(["# Project notes", "", opts.projectNotes.trim()].join("\n"));
  }

  return parts.join("\n\n");
}

/**
 * The prompt a subagent gets.
 *
 * No skill index and no agent index: a subagent cannot spawn further agents,
 * and giving it the full skill catalogue would spend its context on options it
 * was not delegated.
 */
export function buildAgentPrompt(opts: {
  name: string;
  instructions: string;
  tools: Tool[];
  channel: ChannelId;
  cwd?: string;
}): string {
  const parts = [
    `You are the "${opts.name}" subagent inside motifcode.`,
    "",
    "You were given one self-contained task. You cannot see the parent",
    "conversation and the parent cannot see your work, so your final summary is",
    "the only thing that survives — write it for someone who was not here.",
    "",
    opts.instructions.trim(),
    "",
    "Every turn must contain at least one action. Finish with `done`.",
  ].join("\n");

  const channelText = getChannel(opts.channel).promptFragment(opts.tools).trim();
  const tail = opts.cwd ? `Working directory: ${opts.cwd}` : "";
  return [parts, channelText, tail].filter(Boolean).join("\n\n");
}
