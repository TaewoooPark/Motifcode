import { runSkillsArgv, type SkillsCommandOptions } from "./skills-command.js";

export const PLUGINS_HELP = `Usage:
  motif plugins add SOURCE [--skill NAME ... | --all] [--plugin NAME]
                           [--scope user|project] [--dry-run] [--json]
  motif plugins installed [--scope user|project] [--json]
  motif plugins inspect INSTALLED_NAME [--scope user|project] [--json]
  motif plugins connect INSTALLED_NAME [--scope user|project]
                                      [--server NAME ... | --all] [--yes] [--login] [--json]

Plugins are managed skill packages. add/install uses the skills installer and
supports its source, ref, path, namespace and marketplace selection options.
inspect/connect accepts an installed skill name or an unambiguous plugin namespace.
Inspect is offline. Connect reviews and approves selected MCP registrations before
starting them; noninteractive startup requires --yes and browser login --login.
App IDs alone require their original host. A documented limited adapter may be
offered separately. Hooks/agents/commands and MCP-only package installation are
not supported by this command. Source Claude/Codex settings are never modified.
`;

/** A deterministic package command; unsupported verbs never fall through to the model. */
export async function runPluginsArgv(argv: string[], initialFlags: Record<string, string | boolean> = {}, options: SkillsCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  if (!argv.length || argv.includes("--help") || argv.includes("-h") || initialFlags.help) { stdout(PLUGINS_HELP); return 0; }
  const [command, ...rest] = argv;
  if (command === "inspect") return runSkillsArgv(["connect", ...rest, "--dry-run"], initialFlags, options);
  if (command === "add" || command === "install" || command === "installed" || command === "connect" || command === "remove" || command === "update" || command === "marketplace") return runSkillsArgv([command, ...rest], initialFlags, options);
  stderr("Unknown plugins subcommand.\n" + PLUGINS_HELP); return 2;
}
