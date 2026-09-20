/**
 * Plugins: a directory that ships skills and subagents together.
 *
 * The layout Claude Code uses, because a plugin written for it should drop
 * in here unchanged where the pieces overlap:
 *
 *     <root>/plugins/<name>/plugin.json       { "name", "description", "version" }
 *     <root>/plugins/<name>/skills/<s>/SKILL.md
 *     <root>/plugins/<name>/agents/<a>.md
 *
 * with `<root>` being `~/.motif` for the person's plugins and `<repo>/.motif`
 * for the project's. A plugin's skills and agents register under their own
 * names; a plugin that ships a `commit` skill shadows the built-in one, and
 * a project plugin shadows a user plugin, the precedence everything else
 * here already uses.
 *
 * What a plugin cannot do is add tools or hooks: the tool list is frozen for
 * the prompt cache, and hooks run code, which stays behind `motif trust` in
 * the project's own settings file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgent, type AgentDef } from "@motifcode/agents";
import { parseSkill, type Skill } from "@motifcode/skills";

export interface PluginInfo {
  name: string;
  description: string;
  version?: string;
  path: string;
  source: "user" | "project";
  skills: string[];
  agents: string[];
}

export interface LoadedPlugins {
  plugins: PluginInfo[];
  skills: Skill[];
  agents: AgentDef[];
  problems: string[];
}

function readManifest(dir: string): { name: string; description: string; version?: string } | null {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : null;
  if (!name) throw new Error(`${file}: plugin.json needs a name`);
  return {
    name,
    description: typeof raw["description"] === "string" ? raw["description"] : "",
    ...(typeof raw["version"] === "string" ? { version: raw["version"] } : {}),
  };
}

/** Load every plugin under `<root>/plugins`, in directory order. */
export function loadPluginsFrom(root: string, source: PluginInfo["source"]): LoadedPlugins {
  const out: LoadedPlugins = { plugins: [], skills: [], agents: [], problems: [] };
  const dir = join(root, "plugins");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let manifest;
    try {
      manifest = readManifest(path);
    } catch (err) {
      out.problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!manifest) continue;
    const info: PluginInfo = { ...manifest, path, source, skills: [], agents: [] };

    const skillsDir = join(path, "skills");
    if (existsSync(skillsDir)) {
      for (const s of readdirSync(skillsDir).sort()) {
        const file = join(skillsDir, s, "SKILL.md");
        if (!existsSync(file)) continue;
        try {
          const skill = parseSkill(readFileSync(file, "utf8"), source);
          out.skills.push(skill);
          info.skills.push(skill.name);
        } catch (err) {
          out.problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const agentsDir = join(path, "agents");
    if (existsSync(agentsDir)) {
      for (const a of readdirSync(agentsDir).sort()) {
        if (!a.endsWith(".md")) continue;
        const file = join(agentsDir, a);
        try {
          const agent = parseAgent(readFileSync(file, "utf8"), source);
          out.agents.push(agent);
          info.agents.push(agent.name);
        } catch (err) {
          out.problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    out.plugins.push(info);
  }
  return out;
}

/** User plugins, then the project's; a later plugin shadows an earlier one. */
export function loadPlugins(opts: { cwd: string; home: string }): LoadedPlugins {
  const user = loadPluginsFrom(join(opts.home, ".motif"), "user");
  const project = loadPluginsFrom(join(opts.cwd, ".motif"), "project");
  return {
    plugins: [...user.plugins, ...project.plugins],
    skills: [...user.skills, ...project.skills],
    agents: [...user.agents, ...project.agents],
    problems: [...user.problems, ...project.problems],
  };
}

export function describePlugins(loaded: LoadedPlugins): string[] {
  if (loaded.plugins.length === 0) return ["no plugins; add one under ~/.motif/plugins/<name>/ or .motif/plugins/<name>/ with a plugin.json"];
  const lines = loaded.plugins.map(
    (p) =>
      `${p.name.padEnd(16)} ${p.description}${p.version ? ` (${p.version})` : ""}  ·  ${p.source}  ·  ` +
      `${p.skills.length} skill(s)${p.skills.length ? `: ${p.skills.join(", ")}` : ""}` +
      `${p.agents.length ? `  ·  ${p.agents.length} agent(s): ${p.agents.join(", ")}` : ""}`,
  );
  for (const p of loaded.problems) lines.push(`! ${p}`);
  return lines;
}
