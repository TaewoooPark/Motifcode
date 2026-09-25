import type { Skill } from "@motifcode/skills";
import { inspectClientSkills, inspectSkillSource, installSkillCandidates, listInstalledSkills, listSkillMarketplace, removeInstalledSkill, SkillInstallError, updateInstalledSkill, type SkillInstallOptions } from "./skill-installer.js";

export const SKILLS_HELP = `Usage:
  motif skills [list] [--json]
  motif skills inspect SOURCE [--path PATH] [--ref REF] [--plugin NAME] [--json]
  motif skills add SOURCE [--skill NAME ... | --all] [--path PATH] [--ref REF]
                         [--plugin NAME] [--namespace NAME] [--scope user|project] [--dry-run]
  motif skills import claude|codex [--skill NAME ... | --all] [--namespace NAME]
                                 [--scope user|project] [--dry-run] [--json]
  motif skills marketplace SOURCE [--ref REF] [--json]
  motif skills installed [--scope user|project] [--json]
  motif skills update NAME [--ref REF] [--scope user|project] [--dry-run] [--json]
  motif skills remove NAME [--scope user|project] [--dry-run] [--json]

SOURCE is a local directory, GitHub owner/repo, or HTTPS Git repository URL.
--plugin selects a skills package from .agents/plugins/marketplace.json or
.claude-plugin/marketplace.json. List its entries with 'skills marketplace SOURCE'.
Import without --skill/--all lists candidates; import with a selection copies them.
Files and shared package resources are copied into Motif's managed store. Source
client settings/installations are never changed. Plugin MCP, hooks, agents, commands,
connectors and package dependency installations are not activated. Compatibility
warnings explain unmet dependencies. Motif's permissions continue to apply.
Updates/removal refuse to discard edited snapshots. Restart existing sessions to
load an installation. --dry-run leaves Motif's registrations and files unchanged.
`;

export interface SkillsCommandOptions {
  cwd?: string; home?: string; stdout?: (text: string) => void; stderr?: (text: string) => void;
  skills?: readonly Skill[]; getSkills?: (cwd: string) => readonly Skill[]; inventory?: unknown;
}
const BOOLEANS = new Set(["help", "json", "all", "dry-run"]);
const VALUES = new Set(["path", "ref", "plugin", "namespace", "scope", "skill", "cwd"]);
const ALLOWED: Record<string, string[]> = {
  list: [], installed: ["scope"], inspect: ["path", "ref", "plugin", "namespace"],
  add: ["path", "ref", "plugin", "namespace", "scope", "skill", "all", "dry-run"],
  import: ["namespace", "scope", "skill", "all", "dry-run"],
  marketplace: ["ref"], remove: ["scope", "dry-run"], update: ["ref", "scope", "dry-run"],
};

/** Owns skills argv so repeatable selections and unknown subcommands cannot become model tasks. */
export async function runSkillsArgv(argv: string[], initialFlags: Record<string, string | boolean> = {}, options: SkillsCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const flags: Record<string, string | boolean | string[]> = { ...initialFlags }; const rest: string[] = [];
  const usage = (message: string) => { stderr(message + "\n" + SKILLS_HELP); return 2; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] === "-h" ? "--help" : argv[i]!;
    if (!arg.startsWith("-")) { rest.push(arg); continue; }
    if (!arg.startsWith("--")) return usage("Unknown skill option.");
    const equal = arg.indexOf("="); const key = arg.slice(2, equal < 0 ? undefined : equal);
    if (BOOLEANS.has(key)) { if (equal >= 0 || flags[key] !== undefined) return usage("Boolean skill flags take no value and cannot repeat."); flags[key] = true; continue; }
    if (!VALUES.has(key)) return usage("Unknown skill option.");
    const value = equal >= 0 ? arg.slice(equal + 1) : argv[++i];
    if (!value || (equal < 0 && value.startsWith("--"))) return usage("A skill option requires a value.");
    if (key === "skill") flags[key] = [...(Array.isArray(flags[key]) ? flags[key] as string[] : []), value];
    else { if (flags[key] !== undefined) return usage("A skill option was specified more than once."); flags[key] = value; }
  }
  if (flags.help) { stdout(SKILLS_HELP); return 0; }
  const command = rest[0] === "install" ? "add" : rest[0] ?? "list";
  if (!ALLOWED[command]) return usage("Unknown skills subcommand.");
  const allowed = new Set(["cwd", "json", "help", ...ALLOWED[command]!]);
  if (Object.keys(flags).some(key => !allowed.has(key))) return usage("A skill option does not apply to this subcommand.");
  if (flags.scope !== undefined && flags.scope !== "user" && flags.scope !== "project") return usage("--scope must be user or project.");
  if (flags.all && flags.skill !== undefined) return usage("Choose either --all or --skill selections.");
  const requiresSource = !["list", "installed"].includes(command);
  if (rest.length !== (requiresSource ? 2 : rest.length === 0 ? 0 : 1)) return usage("Unexpected or missing skills argument.");
  const string = (key: string): string | undefined => typeof flags[key] === "string" ? flags[key] as string : undefined;
  const installOptions: SkillInstallOptions = {
    cwd: string("cwd") ?? options.cwd, home: options.home, scope: flags.scope === "project" ? "project" : "user",
    path: string("path"), ref: string("ref"), plugin: string("plugin"), namespace: string("namespace"),
    skills: Array.isArray(flags.skill) ? flags.skill : undefined, all: flags.all === true, dryRun: flags["dry-run"] === true, inventory: options.inventory,
  };
  const emit = (value: unknown, lines: string[]) => stdout(flags.json ? JSON.stringify(value, null, 2) + "\n" : lines.join("\n") + "\n");
  try {
    if (command === "list") {
      const rows = options.getSkills?.(installOptions.cwd ?? process.cwd()) ?? options.skills ?? [];
      emit(rows.map(skill => ({ name: skill.name, originalName: skill.originalName, description: skill.description, source: skill.source, filePath: skill.filePath, disableModelInvocation: skill.disableModelInvocation, userInvocable: skill.userInvocable, diagnostics: skill.diagnostics })), rows.flatMap(skill => [`${skill.name.padEnd(24)} ${skill.description.replace(/\s+/g, " ")} (${skill.source})${skill.disableModelInvocation ? " [explicit only]" : ""}${!skill.userInvocable ? " [model only]" : ""}`, ...(skill.filePath ? [`  file: ${skill.filePath}`] : []), ...skill.diagnostics.map(d => `  ${d.severity}: ${d.message}`)])); return 0;
    }
    if (command === "installed") {
      const rows = listInstalledSkills(installOptions); emit(rows, rows.length ? rows.map(row => `${row.name}  ${row.id}  ${row.scope}  ${row.origin.kind}  ${row.origin.commit?.slice(0, 12) ?? row.digest.slice(0, 12)}`) : ["No managed skills installed."]); return 0;
    }
    if (command === "marketplace") {
      const result = listSkillMarketplace(rest[1]!, installOptions); emit(result, [`Marketplace: ${result.name}`, ...result.entries.map(entry => `${entry.name}  ${entry.description}${entry.blocked ? " [unavailable]" : ""}`)]); return 0;
    }
    if (command === "remove") { const row = removeInstalledSkill(rest[1]!, installOptions); emit({ mode: installOptions.dryRun ? "dry-run" : "removed", skill: row }, [`${installOptions.dryRun ? "Would remove" : "Removed"} ${row.name}.`]); return 0; }
    if (command === "update") { const rows = updateInstalledSkill(rest[1]!, installOptions); emit({ mode: installOptions.dryRun ? "dry-run" : "updated", skills: rows }, rows.map(row => `${installOptions.dryRun ? "Would update" : "Updated"} ${row.name} (${row.digest.slice(0, 12)}).`)); return 0; }
    if (command === "import" && rest[1] !== "claude" && rest[1] !== "codex") return usage("Import source must be claude or codex.");
    const inspection = command === "import" ? inspectClientSkills(rest[1] as "claude" | "codex", installOptions) : inspectSkillSource(rest[1]!, installOptions);
    try {
      if (command === "inspect" || (command === "import" && !installOptions.all && !installOptions.skills?.length)) {
        const candidates = inspection.candidates.map(({ id, selectionId, name, description, origin, filePath, relativeFile, diagnostics }) => ({ id, selectionId, name, description, origin, filePath, relativeFile, diagnostics }));
        emit({ candidates, diagnostics: inspection.diagnostics }, [...candidates.map(row => `${row.id}  ${row.description}\n  select: ${row.selectionId}\n  file: ${row.filePath}\n  ${row.origin.kind}: ${row.origin.source}${row.origin.commit ? ` @ ${row.origin.commit.slice(0, 12)}` : ""}${row.diagnostics.length ? `\n  ${row.diagnostics.map(d => d.message).join("\n  ")}` : ""}`), ...inspection.diagnostics.map(d => `! ${d.message}`)]);
        return candidates.length ? 0 : 1;
      }
      const rows = installSkillCandidates(inspection, installOptions);
      emit({ mode: installOptions.dryRun ? "dry-run" : "installed", skills: rows, diagnostics: inspection.diagnostics }, [...rows.map(row => `${installOptions.dryRun ? "Would install" : "Installed"} ${row.name} (${row.id})\n${row.diagnostics.map(d => `  ! ${d.message}`).join("\n")}`), ...inspection.diagnostics.map(d => `! ${d.message}`)]); return 0;
    } finally { inspection.cleanup(); }
  } catch (err) {
    const message = err instanceof SkillInstallError ? `${err.code}: ${err.message}` : "Skill operation failed; check file access and source validity.";
    stderr(message + "\n"); return 1;
  }
}
