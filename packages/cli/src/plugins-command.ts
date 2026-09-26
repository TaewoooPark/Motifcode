import { homedir } from "node:os";
import { resolve } from "node:path";
import { runSkillsArgv, type SkillsCommandOptions } from "./skills-command.js";
import { describePlugins, loadPlugins } from "./plugins.js";
import { builtinPlugin, connectBuiltinPlugin } from "./builtin-plugin-connections.js";
import { listInstalledSkills, SkillInstallError } from "./skill-installer.js";
import { McpConfigEditError } from "./mcp-config-edit.js";

export const PLUGINS_HELP = `Usage:
  motif plugins list|installed [--scope user|project] [--json]
  motif plugins add SOURCE [--skill NAME ... | --all] [--plugin NAME]
                           [--scope user|project] [--dry-run] [--json]
  motif plugins inspect NAME [--scope user|project] [--json]
  motif plugins connect NAME [--scope user|project]
                            [--server NAME ... | --all] [--yes] [--login] [--dry-run] [--json]

Bundled plugins and their skills are available offline in every project. Listing or
loading them never registers, starts or connects MCP servers. inspect describes the
connection plan. connect explicitly registers missing presets, preserving existing
settings; disabled or conflicting entries require separate review with motif mcp.

External plugins are managed skill packages. add/install uses the skills installer
and supports its source, ref, path, namespace and marketplace selection options.
inspect/connect accepts a bundled plugin, installed skill name or unambiguous namespace.
Connect reviews and approves selected MCP registrations before starting them;
noninteractive startup requires --yes and browser login --login. Restart existing
sessions to load new connections. Project scope prints the explicit config/trust flags.
App IDs alone require their original host. Hooks/agents/commands and MCP-only external
package installation are not supported here. Source client settings are never modified.
`;

/** A deterministic package command; unsupported verbs never fall through to the model. */
export async function runPluginsArgv(argv: string[], initialFlags: Record<string, string | boolean> = {}, options: SkillsCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  if (argv.includes("--help") || argv.includes("-h") || initialFlags.help) { stdout(PLUGINS_HELP); return 0; }
  const [command = "list", ...rest] = argv;
  const bundled = (command === "inspect" || command === "connect") && rest[0] !== undefined && builtinPlugin(rest[0]);
  if (command === "list" || command === "installed" || bundled) {
    const flags: Record<string, string | boolean | string[]> = { ...initialFlags };
    const positional: string[] = [];
    const usage = (message: string) => { stderr(message + "\n" + PLUGINS_HELP); return 2; };
    const booleans = new Set(["json", "all", "yes", "login", "dry-run"]);
    const values = new Set(["scope", "cwd", "server"]);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (!arg.startsWith("-")) { positional.push(arg); continue; }
      if (!arg.startsWith("--")) return usage("Unknown plugin option.");
      const equal = arg.indexOf("="); const key = arg.slice(2, equal < 0 ? undefined : equal);
      if (booleans.has(key)) {
        if (equal >= 0 || flags[key] !== undefined) return usage("Boolean plugin options take no value and cannot repeat.");
        flags[key] = true; continue;
      }
      if (!values.has(key)) return usage("Unknown plugin option.");
      const value = equal >= 0 ? arg.slice(equal + 1) : rest[++i];
      if (!value || (equal < 0 && value.startsWith("--"))) return usage("A plugin option requires a value.");
      if (key === "server") flags[key] = [...(Array.isArray(flags[key]) ? flags[key] : []), value];
      else { if (flags[key] !== undefined) return usage("A plugin option cannot repeat."); flags[key] = value; }
    }
    const allowed = new Set(["json", "cwd", "scope", ...(command === "connect" ? ["all", "yes", "login", "dry-run", "server"] : [])]);
    if (Object.keys(flags).some(key => !allowed.has(key))) return usage("This plugin option does not apply to the command.");
    if (positional.length !== (bundled ? 1 : 0)) return usage("Unexpected or missing plugin argument.");
    if (flags.scope !== undefined && flags.scope !== "user" && flags.scope !== "project") return usage("--scope must be user or project.");
    if (flags.all && flags.server !== undefined) return usage("Choose --all or --server, not both.");
    const cwd = typeof flags.cwd === "string" ? resolve(options.cwd ?? process.cwd(), flags.cwd) : options.cwd ?? process.cwd();
    const home = options.home ?? homedir(); const scope = flags.scope === "project" ? "project" : "user";
    const emit = (data: unknown, lines: string[]) => stdout(flags.json ? JSON.stringify(data, null, 2) + "\n" : lines.join("\n") + "\n");
    try {
      if (command === "list" || command === "installed") {
        const loaded = loadPlugins({ cwd, home });
        if (flags.scope !== undefined || command === "installed") loaded.plugins = loaded.plugins.filter(row => row.source === "builtin" || row.source === scope);
        const scopes: ("user" | "project")[] = flags.scope !== undefined || command === "installed" ? [scope] : ["user", "project"];
        const managed = scopes.flatMap(scope => listInstalledSkills({ cwd, home, scope }));
        emit({ plugins: loaded.plugins, managedSkills: managed, problems: loaded.problems }, [
          ...describePlugins(loaded), ...managed.map(row => `${row.name}  ·  managed ${row.scope}  ·  ${row.origin.kind}`),
        ]); return 0;
      }
      const result = await connectBuiltinPlugin(positional[0]!, { ...options.connectionOptions, cwd, home, scope,
        servers: Array.isArray(flags.server) ? flags.server : undefined, all: flags.all === true, dryRun: command === "inspect" || flags["dry-run"] === true,
        yes: flags.yes === true, login: flags.login === true,
      });
      emit(result, [`Bundled plugin: ${result.plan.name}`, `Configuration: ${result.plan.configPath}`,
        ...result.plan.candidates.flatMap(row => [`${row.id}: ${row.status}${row.operation ? ` (${row.operation})` : ""}`, ...(row.config ? [`  preset: ${JSON.stringify(row.config)}`] : []), ...row.diagnostics.map(item => `  ${item.code}: ${item.message}`)]),
        ...result.plan.diagnostics.map(row => `${row.code}: ${row.message}`), `Result: ${result.status}${result.status === "registered" && result.selected.length ? " (connection not checked)" : ""}`,
        ...(result.activation ? [`Connection check: ${JSON.stringify(result.activation)}`] : []),
        ...(result.configHash && scope === "project" ? [`Future sessions: --mcp-config ${JSON.stringify(result.configPath)} --trust-mcp ${result.configHash}`] : []),
        ...(result.configHash ? ["Restart existing sessions to load the connection configuration."] : []),
      ]);
      return result.status === "cancelled" || result.status === "activation_failed" || (result.activation && typeof result.activation === "object" && "ready" in result.activation && result.activation.ready === false) ? 1 : 0;
    } catch (cause) {
      if (cause instanceof SkillInstallError || cause instanceof McpConfigEditError) {
        if (flags.json) stdout(JSON.stringify({ error: { code: cause.code, message: cause.message } }) + "\n");
        else stderr(`${cause.code}: ${cause.message}\n`);
      } else stderr("Plugin operation failed; check configuration and file access.\n");
      return 1;
    }
  }
  if (command === "inspect") return runSkillsArgv(["connect", ...rest, "--dry-run"], initialFlags, options);
  if (command === "add" || command === "install" || command === "connect" || command === "remove" || command === "update" || command === "marketplace") return runSkillsArgv([command, ...rest], initialFlags, options);
  stderr("Unknown plugins subcommand.\n" + PLUGINS_HELP); return 2;
}
