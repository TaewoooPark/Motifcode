/** Agent Skills frontmatter, with explicit host compatibility diagnostics. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path";
import { parseDocument } from "yaml";

export interface SkillDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
}
export interface SkillMeta {
  name: string;
  description: string;
  budget?: number;
  tags?: string[];
}
export interface Skill extends SkillMeta {
  body: string;
  source: "builtin" | "project" | "user";
  filePath?: string;
  baseDir?: string;
  packageRoot?: string;
  originalName?: string;
  metadata: Record<string, unknown>;
  openai?: Record<string, unknown>;
  diagnostics: SkillDiagnostic[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  argumentNames: string[];
  argumentHint?: string;
  /** MCP servers this bundled skill works through; indexed only while one is enabled. */
  mcpPresets?: string[];
}
export interface ParseSkillOptions {
  filePath?: string;
  fallbackName?: string;
  openaiYaml?: string;
  packageRoot?: string;
  registrationName?: string;
}
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a YAML mapping`);
  return value as Record<string, unknown>;
}
function yaml(text: string, label: string): Record<string, unknown> {
  const doc = parseDocument(text, { schema: "core", uniqueKeys: true });
  const problem = [...doc.errors, ...doc.warnings][0];
  if (problem) throw new Error(`${label}: ${problem.message}`);
  return record(doc.toJS({ maxAliasCount: 50 }) ?? {}, label);
}
function string(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`skill ${field} must be a string`);
  return value.trim();
}
function boolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  // Claude accepts these spellings, while YAML 1.2 correctly leaves them strings.
  if (value === 1 || (typeof value === "string" && /^(true|yes|on|1)$/i.test(value))) return true;
  if (value === 0 || (typeof value === "string" && /^(false|no|off|0)$/i.test(value))) return false;
  throw new Error(`skill ${field} must be a boolean`);
}
function strings(value: unknown, field: string, split = false): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return split ? value.split(/[,\s]+/).filter(Boolean) : [value];
  if (Array.isArray(value) && value.every(v => typeof v === "string")) return value;
  throw new Error(`skill ${field} must be a string or a list of strings`);
}

export function parseSkill(text: string, source: Skill["source"] = "project", options: ParseSkillOptions = {}): Skill {
  const clean = text.replace(/^\uFEFF/, "");
  const match = FRONTMATTER.exec(clean);
  if (!match && !options.fallbackName) throw new Error("skill is missing its --- frontmatter --- block");
  // A malformed opening delimiter is not a plain Markdown skill.
  if (!match && /^---[ \t]*\r?\n/.test(clean)) throw new Error("skill frontmatter is missing its closing --- delimiter");
  const metadata = match ? yaml(match[1] ?? "", "skill frontmatter") : {};
  const body = match ? clean.slice(match[0].length) : clean;
  const originalName = string(metadata.name, "name") || options.fallbackName;
  const name = options.registrationName || originalName;
  if (!name) throw new Error("skill frontmatter needs a name");
  if (/[\s<>"'\\/\x00-\x1f]/.test(name)) throw new Error("skill name cannot contain whitespace, path separators, quotes or markup");
  const description = string(metadata.description, "description") || (options.fallbackName ? body.split(/\r?\n/).map(l=>l.replace(/^#+\s*/, "").trim()).find(Boolean)?.slice(0, 200) || `Use the ${name} skill` : undefined);
  if (!description) throw new Error(`skill "${name}" needs a description`);
  const diagnostics: SkillDiagnostic[] = [];
  const warn = (code: string, message: string) => diagnostics.push({ code, severity: "warning", message });
  const block = (code: string, message: string) => diagnostics.push({ code, severity: "error", message });
  let budget: number | undefined;
  if (metadata.budget !== undefined) {
    if (typeof metadata.budget !== "number" || !Number.isFinite(metadata.budget) || metadata.budget <= 0) throw new Error(`skill "${name}" budget must be a positive number`);
    budget = metadata.budget;
  }
  const tags = strings(metadata.tags, "tags", true);
  const allowedTools = strings(metadata["allowed-tools"] ?? metadata.tools, "allowed-tools");
  if (allowedTools.length) warn("tool-preapproval", "Requested allowed-tools are preserved as metadata only. Motif does not grant permissions, restrict tools, or change the session tool list from a skill.");
  for (const field of ["context", "agent", "model", "hooks", "disallowed-tools"] as const) {
    if (metadata[field] !== undefined) block(`unsupported-${field}`, `${field} is an upstream runtime extension that Motif does not implement. This skill cannot run until that behavior is adapted explicitly.`);
  }
  for (const field of ["paths", "effort"] as const) {
    if (metadata[field] !== undefined) warn(`unsupported-${field}`, `${field} is preserved but Motif does not apply it.`);
  }
  if (/(?:^|\s)!`|^\s*```!/m.test(body)) block("dynamic-shell", "Claude shell preprocessing is not supported. Commands embedded as !`...` or executable fences are never run while loading; adapt this skill to explicit tool calls.");
  const unresolved = new Set([...body.matchAll(/\$\{((?:CLAUDE|PLUGIN)_[A-Z_]+)\}/g)].map(m => m[1]!).filter(key =>
    key === "CLAUDE_SKILL_DIR" ? !options.filePath :
    key === "CLAUDE_PLUGIN_ROOT" || key === "PLUGIN_ROOT" ? !options.packageRoot :
    key !== "CLAUDE_PROJECT_DIR"));
  if (unresolved.size) warn("upstream-variables", `Unresolved host variables remain literal: ${[...unresolved].join(", ")}. Configure equivalent Motif paths explicitly.`);
  const rawHint = metadata["argument-hint"];
  const argumentHint = Array.isArray(rawHint) && rawHint.every(v => typeof v === "string")
    ? `[${rawHint.join(", ")}]` : string(rawHint, "argument-hint");
  if (Array.isArray(rawHint)) warn("argument-hint-sequence", "argument-hint was a YAML list; normalized it as a display hint.");
  const openai = options.openaiYaml === undefined ? undefined : yaml(options.openaiYaml, "agents/openai.yaml");
  const policy = openai?.policy === undefined ? undefined : record(openai.policy, "agents/openai.yaml policy");
  if (openai?.dependencies !== undefined) warn("tool-dependencies", "agents/openai.yaml tool dependencies are preserved, not installed or authorized automatically. Configure required MCP servers separately.");
  const disableModelInvocation = boolean(metadata["disable-model-invocation"], "disable-model-invocation", false) || !boolean(policy?.allow_implicit_invocation, "policy.allow_implicit_invocation", true) || metadata.paths !== undefined;
  const filePath = options.filePath ? resolve(options.filePath) : undefined;
  return {
    name, description, body, source, metadata, diagnostics,
    disableModelInvocation, userInvocable: boolean(metadata["user-invocable"], "user-invocable", true),
    allowedTools, argumentNames: strings(metadata.arguments, "arguments", true),
    ...(argumentHint ? { argumentHint } : {}),
    ...(budget !== undefined ? { budget } : {}), ...(tags.length ? { tags } : {}),
    ...(filePath ? { filePath, baseDir: dirname(filePath) } : {}), ...(openai ? { openai } : {}),
    ...(options.packageRoot ? { packageRoot: resolve(options.packageRoot) } : {}),
    ...(originalName && originalName !== name ? { originalName } : {}),
  };
}

/** Read the complete skill entry point plus its optional Codex policy metadata. */
export function loadSkill(file: string, source: Skill["source"] = "project", options: Pick<ParseSkillOptions, "packageRoot" | "registrationName"> = {}): Skill {
  const filePath = realpathSync(file);
  const baseDir = dirname(filePath);
  const packageRoot = options.packageRoot ? realpathSync(options.packageRoot) : undefined;
  const rel = packageRoot ? relative(packageRoot, filePath) : "";
  if (packageRoot && (rel.startsWith("..") || isAbsolute(rel))) throw new Error("skill entry point escapes its package root");
  const agentFile = join(baseDir, "agents", "openai.yaml");
  if (existsSync(agentFile)) {
    const metadataRel = relative(packageRoot ?? baseDir, realpathSync(agentFile));
    if (metadataRel.startsWith("..") || isAbsolute(metadataRel)) throw new Error("agents/openai.yaml escapes its skill package root");
  }
  return parseSkill(readFileSync(filePath, "utf8"), source, {
    filePath, fallbackName: basename(baseDir), ...options, ...(packageRoot ? { packageRoot } : {}),
    ...(existsSync(agentFile) ? { openaiYaml: readFileSync(agentFile, "utf8") } : {}),
  });
}
