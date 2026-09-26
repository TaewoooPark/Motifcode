import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Skill } from "./parse.js";
import type { Message } from "@motifcode/protocol";
import { substituteSkillArguments } from "./arguments.js";

export function estimateTokens(text: string): number { return Math.ceil(text.length / 3.6); }
export const MAX_SKILL_BYTES = 128 * 1024;
export interface SkillLoadOptions { invocation: "user" | "model"; arguments?: string; cwd?: string; }
export interface SkillLoadResult { ok: boolean; output: string; }
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly loadedRoots = new Set<string>();
  private enabledMcp?: () => Iterable<string>;
  register(skill: Skill): void { this.skills.set(skill.name, skill); }
  /** Live enabled MCP server IDs; skills tied to presets are indexed only when one is on. */
  setMcpServers(enabled: () => Iterable<string>): void { this.enabledMcp = enabled; }
  private mcpReady(skill: Skill): boolean {
    if (!skill.mcpPresets?.length || !this.enabledMcp) return true;
    const enabled = new Set(this.enabledMcp());
    return skill.mcpPresets.some(id => enabled.has(id));
  }
  registerAll(skills: readonly Skill[]): void { for (const s of skills) this.register(s); }
  get(name: string): Skill | undefined { return this.skills.get(name); }
  list(): Skill[] { return [...this.skills.values()].sort((a,b) => a.name.localeCompare(b.name)); }
  listFor(invocation: SkillLoadOptions["invocation"]): Skill[] {
    return this.list().filter(s => invocation === "user" ? s.userInvocable : !s.disableModelInvocation && !s.diagnostics.some(d=>d.severity === "error") && this.mcpReady(s));
  }
  index(): string {
    const rows = this.listFor("model").map(s => `  ${xml(s.name)} — ${xml(clean(s.description))}`);
    return rows.length ? ["# Skills", "", "Load one with the `skill` tool when it applies. If the person names an available skill, load it before following its instructions. Do not search the filesystem for installed skill paths; the tool supplies its complete instructions and resource directory.", ...rows].join("\n") : "";
  }
  /** Read-only bundle access becomes available only after successful invocation. */
  resourceRoots(): string[] { return [...this.loadedRoots]; }
  canReadResource(path: string, cwd: string): boolean {
    let target: string;
    try { target = realpathSync(isAbsolute(path) ? path : resolve(cwd, path)); } catch { return false; }
    return this.resourceRoots().some(root => {
      // root is canonicalized at load time, not re-resolved after a symlink swap.
      const rel = relative(root, target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  }
  /**
   * A resumed transcript already contains host-rendered skill payloads. Restore
   * only complete payloads whose name AND canonical source/directory match a
   * currently registered bundle. Ordinary names, summaries, failed loads and
   * arbitrary paths do not grant resource access.
   */
  restoreResourceAccess(messages: readonly Message[]): void {
    const calls = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
        if ((call.function?.name ?? call.name) !== "skill" || !call.id) continue;
        try {
          const raw = call.function?.arguments ?? call.arguments;
          const args = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (typeof args?.name === "string") calls.set(call.id, args.name);
        } catch { /* Malformed calls never loaded a skill. */ }
      }
      if ((message.role !== "user" && message.role !== "tool") || typeof message.content !== "string") continue;
      // Consume complete outer frames once. A body cannot restore another
      // bundle's access by embedding a nested, fabricated skill wrapper.
      for (const frame of message.content.matchAll(/<skill name="([^"\n]+)">\n([\s\S]*?)\n<\/skill>/g)) {
        const skill = this.list().find(s => xml(s.name) === frame[1]);
        if (!skill?.filePath || !skill.baseDir || skill.diagnostics.some(d => d.severity === "error")) continue;
        if (message.role === "tool" && calls.get(message.tool_call_id ?? "") !== skill.name) continue;
        const prefix = `Skill source: ${JSON.stringify(skill.filePath)}\nSkill directory: ${JSON.stringify(skill.baseDir)}.`;
        if (!frame[2]!.startsWith(prefix) || Buffer.byteLength(frame[0], "utf8") > MAX_SKILL_BYTES) continue;
        if (skill.packageRoot && !frame[2]!.includes(`\nSkill package root: ${JSON.stringify(skill.packageRoot)}\n`)) continue;
        const root = skill.packageRoot ?? skill.baseDir;
        try {
          const canonical = realpathSync(root);
          // Do not follow a replaced root into a different package on resume.
          if (canonical === root) this.loadedRoots.add(canonical);
        } catch { /* Deleted bundles must be installed again. */ }
      }
    }
  }

  load(name: string, options: SkillLoadOptions = { invocation: "user" }): SkillLoadResult {
    const skill = this.get(name);
    if (!skill) return { ok: false, output: `No skill named "${name}". Available: ${this.listFor(options.invocation).map(s=>s.name).join(", ") || "(none)"}.` };
    if (options.invocation === "model" && skill.disableModelInvocation) return { ok: false, output: `The "${name}" skill requires explicit user invocation. Do not load or reproduce its instructions automatically; ask the person to invoke /${name}.` };
    if (options.invocation === "user" && !skill.userInvocable) return { ok: false, output: `The "${name}" skill has user-invocable: false and is available only for model selection.` };
    const errors = skill.diagnostics.filter(d=>d.severity === "error");
    if (errors.length) return { ok: false, output: `The "${name}" skill needs compatibility changes before it can run:\n${errors.map(d=>`- ${d.message}`).join("\n")}` };
    let body = skill.body.trim();
    if (skill.budget !== undefined && estimateTokens(body) > skill.budget) return { ok: false, output: `The "${name}" skill is about ${estimateTokens(body)} tokens (estimated from ${body.length} characters), over its declared budget of ${skill.budget}. It was not injected. Either raise the budget in its frontmatter or split the skill.` };
    // Expand host variables before argument insertion, so arguments stay literal.
    body = body.replace(/\$\{(CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, (match, key: string) => {
      return (key === "CLAUDE_SKILL_DIR" ? skill.baseDir : key === "CLAUDE_PROJECT_DIR" ? options.cwd : skill.packageRoot) ?? match;
    });
    {
      try { body = substituteSkillArguments(body, options.arguments ?? "", skill.argumentNames); }
      catch (err) { return { ok: false, output: err instanceof Error ? err.message : String(err) }; }
    }
    const context: string[] = [];
    if (skill.filePath) context.push(`Skill source: ${JSON.stringify(skill.filePath)}`);
    if (skill.baseDir) context.push(`Skill directory: ${JSON.stringify(skill.baseDir)}. Resolve this skill's relative scripts, references and assets from this directory, not the working directory. Use absolute paths; quote them in shell commands.`);
    if (skill.packageRoot) context.push(`Skill package root: ${JSON.stringify(skill.packageRoot)}`);
    if (skill.diagnostics.length) context.push(`Compatibility notes:\n${skill.diagnostics.map(d=>`- ${d.message}`).join("\n")}`);
    if (context.length) body = `${context.join("\n")}\n\n${body}`;
    const output = [`<skill name="${xml(skill.name)}">`, body, "</skill>"].join("\n");
    if (Buffer.byteLength(output, "utf8") > MAX_SKILL_BYTES) return { ok: false, output: `The "${name}" skill exceeds the ${MAX_SKILL_BYTES}-byte injection limit after argument expansion. It was not injected; split it into supporting references.` };
    const root = skill.packageRoot ?? skill.baseDir;
    if (root) { try { this.loadedRoots.add(realpathSync(root)); } catch { return { ok: false, output: `The "${name}" skill directory no longer exists: ${root}` }; } }
    return { ok: true, output };
  }
  render(name: string): string { return this.load(name, { invocation: "user" }).output; }
}
