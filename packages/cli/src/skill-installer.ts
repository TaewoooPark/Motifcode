/** Skills-only package snapshots. Discovery never executes package-provided code. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkill, type Skill } from "@motifcode/skills";

export type SkillScope = "user" | "project";
export type SkillClient = "claude" | "codex";
export interface SkillInstallOptions {
  cwd?: string; home?: string; scope?: SkillScope; ref?: string; path?: string;
  plugin?: string; namespace?: string; skills?: string[]; all?: boolean; dryRun?: boolean;
  client?: SkillClient; inventory?: unknown;
}
export interface InstallDiagnostic { code: string; message: string; source?: string }
export interface SkillOrigin { kind: "local" | "git" | "client"; source: string; ref?: string; commit?: string; subpath?: string; client?: SkillClient; plugin?: string; marketplace?: string; clientPluginId?: string; catalog?: { source: string; ref?: string; path?: string; entry: string } }
export interface SkillCandidate {
  id: string; selectionId: string; name: string; description: string; filePath: string; packageRoot: string;
  relativeFile: string; sourceRelativeFile: string; origin: SkillOrigin; namespace?: string; diagnostics: InstallDiagnostic[];
}
export interface SkillInspection { candidates: SkillCandidate[]; diagnostics: InstallDiagnostic[]; cleanup: () => void }
export interface SkillReceipt {
  id: string; name: string; originalName: string; description: string; scope: SkillScope;
  origin: SkillOrigin; snapshot: string; digest: string; relativeFile: string; sourceRelativeFile: string; installedAt: string; namespace?: string;
  diagnostics: InstallDiagnostic[];
}
interface SkillIndex { version: 1; skills: SkillReceipt[] }
export interface MarketplaceEntry { name: string; description: string; source: unknown; blocked: boolean }
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", ".DS_Store", ".env", "auth.json", "credentials.json", ".npmrc", ".netrc"]);
const obj = (x: unknown): Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const str = (x: unknown): string | undefined => typeof x === "string" && x !== "" ? x : undefined;
const sha = (x: string | Buffer): string => createHash("sha256").update(x).digest("hex");
const normalized = (x: string): string => x.split(sep).join("/");

export class SkillInstallError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = "SkillInstallError"; } }
function fail(code: string, message: string): never { throw new SkillInstallError(code, message); }
function segment(value: string, label = "name"): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value) || value.includes("..")) fail("invalid_name", `${label} contains unsafe characters.`);
  return value;
}
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); }
function contained(root: string, path: string): string {
  const realRoot = realpathSync(root); const lexicalRoot = resolve(root); const absolute = resolve(lexicalRoot, path);
  if (!inside(lexicalRoot, absolute) || !existsSync(absolute)) fail("invalid_path", "A package path is missing or escapes its root.");
  const real = realpathSync(absolute);
  if (!inside(realRoot, real)) fail("invalid_path", "A package symlink escapes its root.");
  return real;
}
function packagePath(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || /^[A-Za-z]:/.test(path)) fail("invalid_path", "Package paths must remain relative to the package root.");
  return contained(root, path);
}
function readJson(path: string): unknown {
  if (statSync(path).size > MAX_METADATA) fail("metadata_limit", "A skill metadata file exceeds the 2 MiB limit.");
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fail("invalid_json", `Invalid JSON in ${basename(path)}.`); }
}
function readManifest(root: string, path: string): Record<string, unknown> | undefined { return existsSync(join(root, path)) ? obj(readJson(packagePath(root, path))) : undefined; }
function issue(code: string, message: string, source?: string): InstallDiagnostic { return { code, message, ...(source ? { source } : {}) }; }
function settings(options: SkillInstallOptions): { cwd: string; home: string; scope: SkillScope; root: string } {
  const cwd = resolve(options.cwd ?? process.cwd()); const home = resolve(options.home ?? homedir()); const scope = options.scope ?? "user";
  return { cwd, home, scope, root: join(scope === "project" ? cwd : home, ".motif") };
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", ...args], {
      cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { return fail("git_failed", "Git could not acquire the skill source; check the URL, ref and repository access."); }
}
interface GitSource { remote: string; ref?: string; path?: string }
function gitRefs(remote: string, cwd: string): string[] {
  return [...new Set(git(["ls-remote", "--heads", "--tags", "--", remote], cwd).split("\n").map(line => line.split("\t")[1]).filter((value): value is string => !!value && /^refs\/(heads|tags)\//.test(value) && !value.endsWith("^{}")))];
}
function linkPath(value: string): string {
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) fail("invalid_path", "GitHub link paths must remain inside the repository.");
  return value.split("/").filter(part => part !== "" && part !== ".").join("/");
}
function gitSource(input: string, options: SkillInstallOptions, cwd: string): GitSource {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) return gitSource(`https://github.com/${input}.git`, options, cwd);
  let url: URL; try { url = new URL(input); } catch { return fail("invalid_source", "Use a local directory, GitHub owner/repo, or HTTPS Git URL."); }
  if (url.protocol !== "https:" || url.username || url.password) fail("invalid_source", "Git sources require HTTPS without embedded credentials.");
  const github = url.hostname === "github.com"; const raw = url.hostname === "raw.githubusercontent.com";
  if (!github && !raw) {
    if (url.search || url.hash) fail("invalid_source", "Git repository URLs cannot contain a query or fragment.");
    if (/\/tree\/|\/blob\//.test(url.pathname)) fail("invalid_source", "Page links are supported only for github.com repositories.");
    return { remote: url.toString(), ref: options.ref, path: options.path };
  }
  if (url.port) fail("invalid_source", "GitHub sources must use the standard HTTPS port.");
  // Only presentation and tracking parameters may be dropped; a revision-like query is never guessed.
  for (const [key, value] of url.searchParams) if (!/^utm_[a-z_]+$/i.test(key) && !["gclid", "fbclid"].includes(key) && !(["plain", "raw"].includes(key) && ["0", "1", "true", "false"].includes(value))) fail("invalid_source", `Unsupported GitHub link query '${key}'. Use a clean repository or skill link.`);
  // Read the original path: URL() would erase dot segments before we can reject them.
  const encodedPath = input.match(/^https:\/\/[^/?#]+(\/[^?#]*)?/i)?.[1] ?? "";
  if (encodedPath.split("/").slice(1, 3).some(part => /%2f|%5c/i.test(part))) fail("invalid_source", "GitHub owner and repository names cannot contain encoded separators.");
  let decoded: string; try { decoded = decodeURIComponent(encodedPath); } catch { return fail("invalid_source", "The GitHub link contains invalid URL encoding."); }
  if (decoded.split("/").includes("..") || decoded.split("/").includes(".")) fail("invalid_path", "GitHub link paths cannot contain dot segments.");
  const parts = linkPath(decoded.replace(/^\//, "")).split("/");
  const owner = parts.shift(); const repository = parts.shift()?.replace(/\.git$/, "");
  if (!owner || !repository || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository) || repository === "." || repository === "..") fail("invalid_source", "A GitHub source needs an owner and repository.");
  const remote = `https://github.com/${owner}/${repository}.git`;
  if (github && !parts.length) return { remote, ref: options.ref, path: options.path };
  const kind = raw ? "blob" : parts.shift();
  if (kind !== "tree" && kind !== "blob") fail("invalid_source", "Use a GitHub repository, tree folder, or SKILL.md file link.");
  const tail = parts.join("/");
  if (!tail || (kind === "blob" && parts.at(-1) !== "SKILL.md")) fail("invalid_source", "GitHub file links must point to SKILL.md; its containing folder will be installed.");
  let ref: string; let prefix: string;
  if (options.ref) {
    const short = options.ref.replace(/^refs\/(heads|tags)\//, "");
    const choices = options.ref === short ? [short, `refs/heads/${short}`, `refs/tags/${short}`] : [options.ref, short];
    prefix = choices.find(value => tail === value || tail.startsWith(`${value}/`)) ?? fail("conflicting_ref", "--ref conflicts with the revision in the GitHub link. Use a repository URL to select a different revision.");
    ref = prefix.startsWith("refs/") ? prefix : options.ref;
    if (!/^refs\/(heads|tags)\//.test(ref) && !/^[a-f0-9]{40}$/i.test(ref)) {
      const matches = gitRefs(remote, cwd).filter(value => value.replace(/^refs\/(heads|tags)\//, "") === ref);
      if (matches.length !== 1) fail(matches.length ? "ambiguous_link_ref" : "unresolved_link_ref", matches.length ? "--ref matches both a branch and tag. Use the full refs/heads/... or refs/tags/... name." : "The GitHub link revision could not be resolved. Use a full 40-character commit SHA or the repository URL with --ref and --path.");
      ref = matches[0]!;
    }
  } else if (/^[a-f0-9]{40}(?:\/|$)/i.test(tail)) {
    ref = prefix = parts[0]!;
  } else {
    const fullRefLink = /^refs\/(heads|tags)\//.test(tail);
    const matches = gitRefs(remote, cwd).map(value => ({ ref: value, prefix: fullRefLink ? value : value.replace(/^refs\/(heads|tags)\//, "") })).filter(value => tail === value.prefix || tail.startsWith(`${value.prefix}/`));
    if (matches.length !== 1) fail(matches.length ? "ambiguous_link_ref" : "unresolved_link_ref", matches.length ? "The GitHub link matches multiple branch/tag boundaries. Add --ref with the exact branch or full refs/heads/... or refs/tags/... name." : "The GitHub link revision could not be resolved. Add a matching --ref, or use the repository URL with --ref and --path (commit links need a full 40-character SHA).");
    ({ ref, prefix } = matches[0]!);
  }
  let path = tail.slice(prefix.length).replace(/^\//, "");
  if (kind === "blob") {
    if (!path || path.split("/").at(-1) !== "SKILL.md") fail("invalid_source", "The GitHub link must identify SKILL.md below its revision.");
    path = path.split("/").slice(0, -1).join("/");
  }
  path = linkPath(path);
  if (options.path !== undefined && linkPath(options.path) !== path) fail("conflicting_path", "--path conflicts with the folder in the GitHub link. Use a repository URL to select a different folder.");
  return { remote, ref, ...(path ? { path } : {}) };
}
function acquire(input: string, options: SkillInstallOptions, sourceKind: "explicit" | "remote" = "explicit"): { root: string; boundary: string; origin: SkillOrigin; cleanup: () => void } {
  // Saved Git remotes are canonical HTTPS URLs; updates must preserve that
  // identity even when the cwd contains a directory with a URL-shaped name.
  const cwd = settings(options).cwd; const local = sourceKind === "explicit" && !/^https:\/\//i.test(input) ? resolve(cwd, input) : undefined;
  const localExists = local !== undefined && existsSync(local);
  if (localExists && !options.ref) {
    const root = realpathSync(local);
    if (!statSync(root).isDirectory()) fail("invalid_source", "The skill source must be a directory.");
    const selected = options.path ? packagePath(root, options.path) : root;
    return { root: selected, boundary: root, origin: { kind: "local", source: root, ...(options.path ? { subpath: options.path } : {}) }, cleanup() {} };
  }
  if (options.ref?.startsWith("-") || options.ref?.includes("\0")) fail("invalid_ref", "Invalid Git reference.");
  const { remote, ref, path } = localExists ? { remote: realpathSync(local), ref: options.ref, path: options.path } : gitSource(input, options, cwd);
  const temp = mkdtempSync(join(tmpdir(), "motif-skills-git-"));
  try {
    git(["init", "--quiet"], temp);
    // Local refs are explicit user-selected repositories, not package-defined transports.
    const localArgs = isAbsolute(remote) ? ["-c", "protocol.file.allow=always"] : [];
    git([...localArgs, "fetch", "--quiet", "--depth=1", "--no-tags", "--", remote, ref ?? "HEAD"], temp);
    const commit = git(["rev-parse", "FETCH_HEAD"], temp);
    git(["-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", "--force", commit], temp);
    const root = path ? packagePath(temp, path) : realpathSync(temp);
    return { root, boundary: realpathSync(temp), origin: { kind: "git", source: remote, ref: ref ?? "HEAD", commit, ...(path ? { subpath: path } : {}) }, cleanup() { rmSync(temp, { recursive: true, force: true }); } };
  } catch (err) { rmSync(temp, { recursive: true, force: true }); throw err; }
}

function dependencyDiagnostics(root: string, manifest: Record<string, unknown>): InstallDiagnostic[] {
  const extension = obj(obj(manifest.extensions)["com.openai"]);
  const keys = ["mcpServers", "apps", "hooks", "agents", "commands", "settings", "userConfig", "channels", "workflows", "dependencies"];
  const present = keys.filter(key => manifest[key] !== undefined || extension[key] !== undefined);
  for (const [file, kind] of [["mcp.json", "MCP"], [".mcp.json", "MCP"], [".app.json", "connectors"], ["hooks/hooks.json", "hooks"], ["agents", "agents"], ["commands", "commands"], ["bin", "executables"]]) {
    if (existsSync(join(root, file!))) present.push(kind!);
  }
  return present.length ? [issue("package_dependencies", `Package components are not activated by a skill import: ${[...new Set(present)].join(", ")}.`)] : [];
}
function skillRoots(root: string, manifest: Record<string, unknown>, flavor: "portable" | "claude" | "codex" | "motif", extra?: unknown): string[] {
  if (flavor === "portable") return existsSync(join(root, "skills")) ? [packagePath(root, "skills")] : [];
  const declared = manifest.skills;
  const values = (value: unknown): string[] => value === undefined ? [] : typeof value === "string" ? [value] : Array.isArray(value) && value.every(v => typeof v === "string") ? value as string[] : fail("invalid_manifest", "Manifest skills must be a path or path array.");
  const defaults = (flavor !== "codex" || declared === undefined) && existsSync(join(root, "skills")) ? ["skills"] : [];
  const roots = [...defaults, ...values(declared), ...values(extra)].map(path => packagePath(root, path));
  if (!roots.length && existsSync(join(root, "SKILL.md"))) roots.push(root);
  return [...new Set(roots)];
}
function enumerate(root: string): string[] {
  if (!statSync(root).isDirectory()) fail("invalid_path", "A skills path must be a directory.");
  if (existsSync(join(root, "SKILL.md"))) return [join(root, "SKILL.md")];
  return readdirSync(root).sort().flatMap(name => {
    if (name.startsWith(".")) return [];
    const file = join(root, name, "SKILL.md"); return existsSync(file) ? [file] : [];
  });
}
function discover(root: string, origin: SkillOrigin, options: SkillInstallOptions, entry?: Record<string, unknown>, selectiveRoot = false, selectedFolder?: string): SkillInspection {
  const diagnostics: InstallDiagnostic[] = []; const candidates: SkillCandidate[] = [];
  const portable = readManifest(root, "plugin.json"); const claude = readManifest(root, ".claude-plugin/plugin.json"); const codex = readManifest(root, ".codex-plugin/plugin.json");
  let manifest: Record<string, unknown> | undefined; let flavor: "portable" | "claude" | "codex" | "motif" = "motif";
  if (portable?.$schema !== undefined) {
    if (portable.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") fail("unsupported_schema", "Unsupported portable plugin schema.");
    manifest = portable; flavor = "portable";
  } else if (options.client === "claude" && claude) { manifest = claude; flavor = "claude"; }
  else if (codex) { manifest = codex; flavor = "codex"; }
  else if (claude) { manifest = claude; flavor = "claude"; }
  else if (portable) { manifest = portable; }
  else if (entry) { manifest = entry; flavor = options.client ?? "claude"; }
  const pluginName = manifest ? str(manifest.name) ?? str(entry?.name) ?? basename(root) : undefined;
  if (pluginName) segment(pluginName, "Plugin name");
  let roots: string[];
  if (manifest) {
    diagnostics.push(...dependencyDiagnostics(root, manifest));
    if (entry && entry !== manifest && entry.strict === false && ["skills", "commands", "agents", "hooks", "outputStyles", "themes"].some(key => entry[key] !== undefined)) fail("conflicting_manifest", "Marketplace entry and plugin manifest conflict under strict:false.");
    const extra = entry && entry !== manifest ? entry.skills : undefined;
    if (selectiveRoot) {
      const paths = typeof entry?.skills === "string" ? [entry.skills] : Array.isArray(entry?.skills) && entry.skills.every(path => typeof path === "string") ? entry.skills as string[] : fail("invalid_manifest", "Marketplace skill selection must be a path or path array.");
      roots = paths.map(path => packagePath(root, path));
    } else roots = skillRoots(root, manifest, flavor, extra);
  } else if (existsSync(join(root, "SKILL.md"))) roots = [root];
  else {
    const known = ["skills", ".agents/skills", ".claude/skills", ".codex/skills"].filter(path => existsSync(join(root, path)));
    roots = known.length ? known.map(path => packagePath(root, path)) : [root];
  }
  const files = [...new Set(roots.flatMap(enumerate))].filter(file => !selectedFolder || inside(selectedFolder, file));
  for (const file of files) {
    try {
      // Only explicit local/client selection may follow a skill folder outside
      // its source. Git-provided links must stay inside the selected package.
      if (origin.kind === "git") contained(root, file);
      // A SKILL.md symlink still must stay within its selected skill folder.
      const directRoot = manifest ? root : realpathSync(dirname(file));
      const checked = contained(directRoot, manifest ? file : "SKILL.md"); if (statSync(checked).size > MAX_METADATA) fail("metadata_limit", "SKILL.md exceeds the 2 MiB metadata limit."); const skill = loadSkill(checked, options.scope ?? "user", manifest ? { packageRoot: root } : {});
      const namespace = options.namespace ?? pluginName;
      if (namespace) segment(namespace, "Namespace");
      const name = namespace ? `${namespace}:${skill.name}` : skill.name;
      const packageRoot = manifest ? root : dirname(checked);
      const own = (skill.diagnostics ?? []).map(d => issue(d.code, d.message));
      const sourceRelativeFile = normalized(relative(root, file));
      const selectionId = `${pluginName ? `${pluginName}:` : ""}${skill.name}@${sha(JSON.stringify([origin, sourceRelativeFile])).slice(0, 12)}`;
      candidates.push({ id: name, selectionId, name: skill.name, description: skill.description, filePath: checked, packageRoot, sourceRelativeFile, relativeFile: normalized(relative(packageRoot, checked)), origin: { ...origin, ...(pluginName ? { plugin: pluginName } : {}) }, ...(namespace ? { namespace } : {}), diagnostics: [...diagnostics, ...own] });
    } catch (err) { diagnostics.push(issue("invalid_skill", err instanceof Error ? err.message : "Invalid skill.", normalized(relative(root, file)))); }
  }
  if (!candidates.length) diagnostics.push(issue("no_skills", "No compatible SKILL.md folders were found in this source."));
  return { candidates, diagnostics, cleanup() {} };
}

function catalogPath(root: string): { file: string; client: SkillClient } | undefined {
  for (const [path, client] of [[".agents/plugins/marketplace.json", "codex"], [".claude-plugin/marketplace.json", "claude"]] as const) if (existsSync(join(root, path))) return { file: packagePath(root, path), client };
  return undefined;
}
function catalogEntries(root: string): { name: string; entries: Record<string, unknown>[]; client: SkillClient; metadata: Record<string, unknown> } {
  const located = catalogPath(root); if (!located) fail("no_marketplace", "No .agents/plugins/marketplace.json or .claude-plugin/marketplace.json was found.");
  const catalog = obj(readJson(located.file));
  if (!str(catalog.name) || !Array.isArray(catalog.plugins)) fail("invalid_marketplace", "A marketplace needs a name and plugins array.");
  return { name: segment(catalog.name as string, "Marketplace name"), entries: catalog.plugins.map(obj), client: located.client, metadata: obj(catalog.metadata) };
}
export function listSkillMarketplace(input: string, options: SkillInstallOptions = {}): { name: string; entries: MarketplaceEntry[]; origin: SkillOrigin } {
  const source = acquire(input, options);
  try {
    const catalog = catalogEntries(source.root);
    return { name: catalog.name, origin: source.origin, entries: catalog.entries.map(entry => ({ name: str(entry.name) ?? "(invalid)", description: str(entry.description) ?? "", source: publicSource(entry.source), blocked: obj(entry.policy).installation === "NOT_AVAILABLE" })) };
  } finally { source.cleanup(); }
}
function publicSource(source: unknown): unknown {
  if (typeof source === "string") return source;
  const value = obj(source); const result: Record<string, unknown> = {};
  for (const key of ["source", "repo", "path", "ref", "sha", "package", "version"]) if (typeof value[key] === "string") result[key] = value[key];
  if (str(value.url)) { try { const url = new URL(value.url as string); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; result.url = url.toString(); } catch { result.url = "(invalid URL)"; } }
  return result;
}
export function inspectSkillSource(input: string, options: SkillInstallOptions = {}): SkillInspection {
  const source = acquire(input, options); let childCleanup = () => {};
  try {
    if (!options.plugin) {
      let packageRoot = source.root;
      // A Git skill link may sit below a plugin manifest. Keep that bounded package's
      // shared resources, while registering only skills under the requested folder.
      // Local directories never cause an upward scan outside the user-selected source.
      const hasManifest = (directory: string) => ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].some(path => existsSync(join(directory, path)));
      if (source.origin.kind === "git" && source.root !== source.boundary && !hasManifest(source.root)) {
        for (let parent = dirname(source.root); inside(source.boundary, parent); parent = dirname(parent)) {
          if (hasManifest(parent)) { packageRoot = parent; break; }
          if (parent === source.boundary) break;
        }
      }
      const result = discover(packageRoot, source.origin, options, undefined, false, packageRoot !== source.root ? source.root : undefined);
      return { ...result, cleanup: source.cleanup };
    }
    const catalog = catalogEntries(source.root); const matches = catalog.entries.filter(entry => entry.name === options.plugin);
    if (matches.length !== 1) fail("unknown_plugin", "Marketplace plugin name is missing or ambiguous.");
    const entry = matches[0]!; if (obj(entry.policy).installation === "NOT_AVAILABLE") fail("unavailable_plugin", "The marketplace marks this plugin unavailable for installation.");
    const spec = entry.source; const record = obj(spec); let root: string; let origin: SkillOrigin;
    if (typeof spec === "string" || record.source === "local") {
      let path = typeof spec === "string" ? spec : str(record.path) ?? fail("invalid_source", "Local marketplace source needs a path.");
      if (!path.includes("/") && path !== "." && str(catalog.metadata.pluginRoot)) path = `${catalog.metadata.pluginRoot}/${path}`;
      root = packagePath(source.root, path);
      origin = { ...source.origin, ...(source.origin.subpath || path !== "." ? { subpath: normalized(join(source.origin.subpath ?? "", path)) } : {}), marketplace: catalog.name };
    } else if (["github", "url", "git-subdir"].includes(String(record.source))) {
      const remote = record.source === "github" ? str(record.repo) : str(record.url);
      if (!remote) fail("invalid_source", "Remote marketplace source needs a repository.");
      const ref = str(record.sha) ?? str(record.ref); if (record.sha !== undefined && !/^[a-f0-9]{40}$/.test(String(record.sha))) fail("invalid_ref", "Marketplace sha must be a full lowercase Git commit SHA.");
      const childPath = record.source === "git-subdir" ? str(record.path) ?? fail("invalid_source", "git-subdir requires a path.") : undefined;
      // Package-declared remotes must never select a host path, even if a valid
      // owner/repo or URL happens to name an existing directory in the cwd.
      const child = acquire(remote, { ...options, plugin: undefined, path: childPath, ref }, "remote");
      root = child.root; origin = { ...child.origin, marketplace: catalog.name }; childCleanup = child.cleanup;
    } else fail("unsupported_source", `Marketplace source ${String(record.source ?? "unknown")} is not supported. Use a local folder or Git source; package commands and lifecycle scripts are never run.`);
    origin = { ...origin, catalog: { source: source.origin.source, ...(source.origin.ref ? { ref: source.origin.ref } : {}), ...(source.origin.subpath ? { path: source.origin.subpath } : {}), entry: options.plugin } };
    const selectiveRoot = catalog.client === "claude" && realpathSync(root) === realpathSync(source.root) && entry.skills !== undefined;
    const result = discover(root, origin, { ...options, client: catalog.client }, entry, selectiveRoot);
    return { ...result, cleanup() { childCleanup(); source.cleanup(); } };
  } catch (err) { childCleanup(); source.cleanup(); throw err; }
}

function inventory(client: SkillClient, cwd: string): unknown {
  try { return JSON.parse(execFileSync(client, ["plugin", "list", "--json"], { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })); }
  catch { return undefined; }
}
export function inspectClientSkills(client: SkillClient, options: SkillInstallOptions = {}): SkillInspection {
  const { cwd, home } = settings(options); const candidates: SkillCandidate[] = []; const diagnostics: InstallDiagnostic[] = [];
  const roots = new Set<string>(); const direct = client === "claude" ? [join(home, ".claude", "skills"), join(cwd, ".claude", "skills")] : [join(home, ".agents", "skills"), join(home, ".codex", "skills"), join(cwd, ".agents", "skills")];
  if (client === "codex") {
    let repo: string | undefined; try { repo = git(["rev-parse", "--show-toplevel"], cwd); } catch { /* A non-Git working directory has only its own skills. */ }
    if (repo && inside(repo, cwd)) { let at = dirname(cwd); while (inside(repo, at)) { direct.push(join(at, ".agents", "skills")); if (at === repo) break; at = dirname(at); } }
  }
  for (const root of direct) if (existsSync(root)) {
    const real = realpathSync(root); if (roots.has(real)) continue; roots.add(real);
    const found = discover(real, { kind: "client", source: real, client }, { ...options, client }); candidates.push(...found.candidates); diagnostics.push(...found.diagnostics);
  }
  const data = options.inventory ?? inventory(client, cwd);
  const rows: unknown[] = Array.isArray(data) ? data : Array.isArray(obj(data).installed) ? obj(data).installed as unknown[] : [];
  if (data === undefined) diagnostics.push(issue("inventory_unavailable", `${client} active plugin inventory is unavailable; cached plugin versions were not imported.`));
  for (const item of rows) {
    const row = obj(item); if (row.enabled !== true || row.installed === false) continue;
    if (str(row.projectPath) && resolve(row.projectPath as string) !== cwd) continue;
    let path = str(row.installPath) ?? (obj(row.source).source === "local" ? str(obj(row.source).path) : undefined);
    if (!path && client === "codex" && str(row.marketplaceName) && str(row.name) && str(row.version)) {
      try { path = join(home, ".codex", "plugins", "cache", segment(row.marketplaceName as string), segment(row.name as string), segment(row.version as string)); } catch { diagnostics.push(issue("invalid_inventory", "An installed plugin has unsafe cache identity fields.")); continue; }
    }
    if (!path || !isAbsolute(path) || !existsSync(path)) { diagnostics.push(issue("missing_installed_plugin", "An active plugin has no readable installed directory.")); continue; }
    const real = realpathSync(path); if (roots.has(real)) continue; roots.add(real);
    try {
      const clientPluginId = str(row.pluginId) ?? str(row.id) ?? (str(row.name) && str(row.marketplaceName) ? `${row.name}@${row.marketplaceName}` : undefined);
      const found = discover(real, { kind: "client", source: real, client, ...(clientPluginId ? { clientPluginId } : {}), ...(str(row.marketplaceName) ? { marketplace: row.marketplaceName as string } : {}) }, { ...options, client });
      candidates.push(...found.candidates); diagnostics.push(...found.diagnostics);
    } catch (err) { diagnostics.push(issue("invalid_plugin", err instanceof Error ? err.message : "Invalid installed plugin.")); }
  }
  return { candidates, diagnostics, cleanup() {} };
}

interface TreeFile { path: string; data: Buffer; mode: number }
function tree(root: string, excludeSourceFiles = true): { files: TreeFile[]; digest: string; excluded: string[] } {
  const realRoot = realpathSync(root); const files: TreeFile[] = []; const excluded: string[] = []; let bytes = 0;
  function walk(at: string, rel: string, ancestors: Set<string>, depth: number): void {
    if (depth > 32) fail("package_limit", "Package nesting exceeds 32 directories.");
    const real = realpathSync(at); if (!inside(realRoot, real)) fail("package_escape", "Package contains a symlink outside its root.");
    const stat = statSync(real);
    if (stat.isDirectory()) {
      if (ancestors.has(real)) fail("package_cycle", "Package contains a directory symlink cycle.");
      const seen = new Set(ancestors); seen.add(real); const names = readdirSync(real).sort(); const folded = new Set<string>();
      for (const name of names) {
        const destination = normalized(join(rel, name));
        if (name.includes("\\") || name.includes("\0")) fail("invalid_path", "Package contains an unsupported filename.");
        if (excludeSourceFiles && (SKIP.has(name) || name.startsWith(".env."))) { excluded.push(destination); continue; }
        const lower = name.toLowerCase(); if (folded.has(lower)) fail("case_collision", "Package has filenames that collide on case-insensitive filesystems."); folded.add(lower);
        walk(join(real, name), destination, seen, depth + 1);
      }
    } else if (stat.isFile()) {
      if (stat.size > MAX_FILE || (bytes += stat.size) > MAX_BYTES || files.length >= MAX_FILES) fail("package_limit", "Package exceeds the file count or byte limit.");
      files.push({ path: rel, data: readFileSync(real), mode: stat.mode & 0o777 });
    } else fail("special_file", "Package contains a device, socket, or other unsupported file.");
  }
  walk(realRoot, "", new Set(), 0);
  // Hash framed metadata and per-file hashes: arbitrary binary bytes may contain
  // separators, so concatenating raw data with NULs would make tree identity ambiguous.
  const digest = sha(JSON.stringify(files.map(file => ({ path: file.path, mode: file.mode, size: file.data.length, sha256: sha(file.data) }))));
  return { files, digest, excluded };
}
function indexPath(root: string): string { return join(root, "skills-installed.json"); }
function readIndex(root: string): SkillIndex {
  if (!existsSync(indexPath(root))) return { version: 1, skills: [] };
  const value = obj(readJson(indexPath(root))); if (value.version !== 1 || !Array.isArray(value.skills)) fail("invalid_index", "The managed skill index is invalid.");
  const skills = value.skills as SkillReceipt[];
  for (const receipt of skills) if (!receipt || typeof receipt.id !== "string" || !/^[a-f0-9]{24}$/.test(receipt.id) || typeof receipt.name !== "string" || typeof receipt.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest) || typeof receipt.relativeFile !== "string") fail("invalid_index", "The managed skill index contains an invalid receipt.");
  return { version: 1, skills };
}
function writeIndex(root: string, index: SkillIndex): void {
  const temp = join(root, `.skills-index-${process.pid}-${Date.now()}.tmp`);
  try { writeFileSync(temp, JSON.stringify(index, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temp, indexPath(root)); }
  finally { rmSync(temp, { force: true }); }
}
function withLock<T>(root: string, run: () => T): T {
  mkdirSync(root, { recursive: true }); const path = join(root, ".skills-install.lock"); let fd: number;
  try { fd = openSync(path, "wx", 0o600); } catch { return fail("install_locked", "Another skill install is in progress; retry after it completes."); }
  try { return run(); } finally { closeSync(fd); rmSync(path, { force: true }); }
}
function snapshotPath(root: string, receipt: SkillReceipt): string {
  if (receipt.snapshot !== normalized(join("skill-packages", receipt.digest))) fail("invalid_index", "A managed snapshot path is invalid.");
  const store = join(root, "skill-packages"); const path = join(root, receipt.snapshot);
  if (!inside(resolve(store), resolve(path))) fail("invalid_index", "A managed snapshot escapes its store.");
  if (existsSync(path) && (!inside(realpathSync(root), realpathSync(path)) || lstatSync(path).isSymbolicLink())) fail("invalid_index", "A managed snapshot was replaced by a symlink.");
  return path;
}
export function listInstalledSkills(options: SkillInstallOptions = {}): SkillReceipt[] { return readIndex(settings(options).root).skills; }
export function loadInstalledSkills(options: SkillInstallOptions = {}): { skills: Skill[]; problems: string[] } {
  const { cwd, home } = settings(options); const skills: Skill[] = []; const problems: string[] = []; const seenRoots = new Set<string>();
  for (const scope of ["user", "project"] as const) {
    const root = settings({ cwd, home, scope }).root;
    if (seenRoots.has(root)) continue; seenRoots.add(root);
    try { for (const receipt of readIndex(root).skills) {
      try {
        const packageRoot = snapshotPath(root, receipt); const file = packagePath(packageRoot, receipt.relativeFile);
        const skill = loadSkill(file, scope, { packageRoot, registrationName: receipt.name });
        skills.push(skill);
      } catch (err) { problems.push(`${receipt.name}: ${err instanceof Error ? err.message : "Invalid installed skill"}`); }
    } } catch (err) { problems.push(err instanceof Error ? err.message : "Invalid managed skill index"); }
  }
  return { skills, problems };
}
export function installSkillCandidates(inspection: SkillInspection, options: SkillInstallOptions = {}, replacing?: string): SkillReceipt[] {
  const { root, scope } = settings(options); const selection = options.skills ?? [];
  let candidates = inspection.candidates;
  if (selection.length) {
    const selected = new Set<SkillCandidate>();
    for (const name of selection) { const found = candidates.filter(c => c.selectionId === name || c.id === name || c.name === name); if (found.length !== 1) fail("ambiguous_skill", `Skill selection ${name} is missing or ambiguous; use the unique selectionId shown by inspect/import.`); selected.add(found[0]!); }
    candidates = [...selected];
  } else if (candidates.length > 1 && !options.all) fail("selection_required", "Source contains several skills. Select --skill NAME or explicitly use --all.");
  if (!candidates.length) fail("no_skills", "No skills were selected for installation.");
  const names = new Set<string>(); for (const candidate of candidates) { if (names.has(candidate.id)) fail("name_collision", `Multiple candidates use ${candidate.id}; install separately with --namespace.`); names.add(candidate.id); }
  const bundles = new Map<string, ReturnType<typeof tree>>();
  const receipts = candidates.map(candidate => {
    let bundle = bundles.get(candidate.packageRoot); if (!bundle) { bundle = tree(candidate.packageRoot); bundles.set(candidate.packageRoot, bundle); }
    if (!bundle.files.some(file => file.path === candidate.relativeFile)) fail("excluded_skill", "The selected SKILL.md was excluded from its package.");
    const diagnostics = [...candidate.diagnostics, ...(bundle.excluded.length ? [issue("excluded_files", `${bundle.excluded.length} generated or credential file(s) were excluded.`)] : [])];
    const identity = JSON.stringify([candidate.origin.kind, candidate.origin.source, candidate.origin.subpath ?? "", candidate.sourceRelativeFile, candidate.id]);
    return { id: replacing ?? sha(identity).slice(0, 24), name: candidate.id, originalName: candidate.name, description: candidate.description, scope, origin: candidate.origin, ...(candidate.namespace ? { namespace: candidate.namespace } : {}), snapshot: `skill-packages/${bundle.digest}`, digest: bundle.digest, relativeFile: candidate.relativeFile, sourceRelativeFile: candidate.sourceRelativeFile, installedAt: new Date().toISOString(), diagnostics } satisfies SkillReceipt;
  });
  if (replacing && receipts.length !== 1) fail("invalid_update", "A managed skill update must select exactly one skill.");
  const verify = (index: SkillIndex) => {
    const handwritten = new Set<string>(); const direct = join(root, "skills");
    if (existsSync(direct)) for (const file of enumerate(direct)) { try { handwritten.add(loadSkill(file, scope).name); } catch { /* Existing invalid hand-authored skills are already diagnosed by the loader. */ } }
    const otherScope = scope === "user" ? "project" : "user"; const otherDirect = join(settings({ ...options, scope: otherScope }).root, "skills"); const otherNames = new Map<string, string>();
    if (otherDirect !== direct && existsSync(otherDirect)) for (const file of enumerate(otherDirect)) { try { otherNames.set(loadSkill(file, otherScope).name, file); } catch { /* Report invalid handwritten skills in the ordinary loader. */ } }
    for (const receipt of receipts) {
      if (handwritten.has(receipt.name)) fail("name_collision", `${receipt.name} collides with a handwritten skill in this scope; choose --namespace.`);
      const shadow = otherNames.get(receipt.name);
      if (shadow) receipt.diagnostics.push(issue("skill_shadowed", `The handwritten ${otherScope} skill at ${shadow} takes precedence in this working directory. Choose --namespace to make both skills available.`));
      const collision = index.skills.find(old => old.name === receipt.name && old.id !== receipt.id); if (collision) fail("name_collision", `${receipt.name} is already installed from another source; choose --namespace.`);
      const old = index.skills.find(old => old.id === receipt.id); if (old && existsSync(snapshotPath(root, old)) && tree(snapshotPath(root, old), false).digest !== old.digest) fail("modified_snapshot", `${old.name} has local changes; preserve or move them before replacing it.`);
    }
  };
  if (options.dryRun) { verify(readIndex(root)); return receipts; }
  return withLock(root, () => {
    const index = readIndex(root); verify(index); const store = join(root, "skill-packages");
    if (existsSync(store) && (lstatSync(store).isSymbolicLink() || !inside(realpathSync(root), realpathSync(store)))) fail("invalid_store", "The managed package store cannot be a symlink outside its configuration root.");
    mkdirSync(store, { recursive: true });
    for (const bundle of bundles.values()) {
      const final = join(store, bundle.digest);
      if (existsSync(final)) { if (lstatSync(final).isSymbolicLink() || tree(final, false).digest !== bundle.digest) fail("modified_snapshot", "An existing package snapshot was modified."); continue; }
      const staging = mkdtempSync(join(store, ".stage-"));
      try { for (const file of bundle.files) { const path = join(staging, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.data, { flag: "wx", mode: file.mode }); chmodSync(path, file.mode); } if (tree(staging).digest !== bundle.digest) fail("copy_changed", "Package changed during copying."); renameSync(staging, final); }
      finally { rmSync(staging, { recursive: true, force: true }); }
    }
    const ids = new Set(receipts.map(r => r.id)); const updated = [...index.skills.filter(old => !ids.has(old.id)), ...receipts]; writeIndex(root, { version: 1, skills: updated });
    for (const old of index.skills.filter(old => ids.has(old.id) && !updated.some(row => row.snapshot === old.snapshot))) {
      const path = snapshotPath(root, old); if (existsSync(path) && tree(path, false).digest === old.digest) rmSync(path, { recursive: true, force: true });
    }
    return receipts;
  });
}
export function removeInstalledSkill(id: string, options: SkillInstallOptions = {}): SkillReceipt {
  const { root } = settings(options);
  const action = () => {
    const index = readIndex(root); const found = index.skills.filter(r => r.id === id || r.name === id); if (found.length !== 1) fail("unknown_skill", "Installed skill ID is missing or ambiguous.");
    const receipt = found[0]!; const remaining = index.skills.filter(r => r.id !== receipt.id); const path = snapshotPath(root, receipt); const shared = remaining.some(r => r.snapshot === receipt.snapshot);
    if (!shared && existsSync(path) && tree(path, false).digest !== receipt.digest) fail("modified_snapshot", "Installed files have local changes; removal would discard them.");
    if (!options.dryRun) { writeIndex(root, { version: 1, skills: remaining }); if (!shared) rmSync(path, { recursive: true, force: true }); }
    return receipt;
  };
  return options.dryRun ? action() : withLock(root, action);
}
export function updateInstalledSkill(id: string, options: SkillInstallOptions = {}): SkillReceipt[] {
  const found = listInstalledSkills(options).filter(r => r.id === id || r.name === id); if (found.length !== 1) fail("unknown_skill", "Installed skill ID is missing or ambiguous.");
  const receipt = found[0]!; const sourceOptions: SkillInstallOptions = { ...options, path: receipt.origin.catalog ? receipt.origin.catalog.path : receipt.origin.subpath, ref: options.ref ?? (receipt.origin.catalog ? receipt.origin.catalog.ref : receipt.origin.ref), client: receipt.origin.client, namespace: receipt.namespace, skills: [receipt.name], all: false, plugin: receipt.origin.catalog?.entry };
  const inspection = receipt.origin.clientPluginId && receipt.origin.client ? inspectClientSkills(receipt.origin.client, sourceOptions) : inspectSkillSource(receipt.origin.catalog?.source ?? receipt.origin.source, sourceOptions);
  if (receipt.origin.clientPluginId) inspection.candidates = inspection.candidates.filter(candidate => candidate.origin.clientPluginId === receipt.origin.clientPluginId);
  inspection.candidates = inspection.candidates.filter(candidate => candidate.sourceRelativeFile === receipt.sourceRelativeFile);
  try { return installSkillCandidates(inspection, sourceOptions, receipt.id); } finally { inspection.cleanup(); }
}
