/** One skill invocation path for print, one-shot and interactive input. */
import type { SkillRegistry } from "@motifcode/skills";
import { mentionsIn } from "@motifcode/tui";
import { expandMentions, mcpSetupMentions, skillSetupMentions, pluginSetupMentions } from "./files.js";

export interface ExpandedSkillInput { task: string; attached: string[]; errors: string[]; }
export function expandSkillInput(text: string, opts: { cwd: string; skills: SkillRegistry; automatic?: boolean; slash?: boolean }): ExpandedSkillInput {
  const slash = opts.slash === false ? null : /^\/([^\s]+)\s*([\s\S]*)$/.exec(text.trim());
  if (slash && opts.skills.get(slash[1]!)) {
    const loaded = opts.skills.load(slash[1]!, { invocation: "user", arguments: slash[2] ?? "", cwd: opts.cwd });
    return { task: loaded.output, attached: loaded.ok ? [`skill:${slash[1]}`] : [], errors: loaded.ok ? [] : [loaded.output] };
  }
  const mentions = mentionsIn(text);
  const explicit = new Set(mentions.filter(m=>m.startsWith("skill:")).map(m=>m.slice(6)));
  // Codex-native explicit syntax. Unknown $words stay ordinary user text.
  for (const match of text.matchAll(/(?:^|\s)\$([\w][\w:-]*)\b/g)) if (opts.skills.get(match[1]!)) explicit.add(match[1]!);
  const input = text
    .replace(/(^|\s)@skill:([^\s]+)/g, (match, prefix: string, name: string) => explicit.has(name) ? prefix : match)
    .replace(/(^|\s)\$([\w][\w:-]*)(?=$|\s|[.,;!?])/g, (match, prefix: string, name: string) => explicit.has(name) ? prefix : match)
    .trim();
  const errors: string[] = [];
  const bodies = new Map<string, string>();
  for (const name of explicit) {
    const result = opts.skills.load(name, { invocation: "user", arguments: input, cwd: opts.cwd });
    if (result.ok) bodies.set(name, result.output); else errors.push(result.output);
  }
  if (opts.automatic !== false) for (const token of [...pluginSetupMentions(text), ...skillSetupMentions(text), ...mcpSetupMentions(text)]) {
    const name = token.slice(6);
    if (explicit.has(name) || bodies.has(name)) continue;
    const skill = opts.skills.get(name);
    if (!skill || skill.disableModelInvocation) continue;
    const result = opts.skills.load(name, { invocation: "model", cwd: opts.cwd });
    if (result.ok) bodies.set(name, result.output);
  }
  const expanded = expandMentions(text, [...mentions.filter(m=>!m.startsWith("skill:")), ...[...bodies.keys()].map(n=>`skill:${n}`)], {
    cwd: opts.cwd, renderSkill: name=>bodies.get(name),
  });
  return { ...expanded, errors };
}
