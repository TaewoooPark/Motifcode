/**
 * Files for the `@` picker, and what a mention attaches.
 *
 * The list comes from git when there is a repository — tracked and untracked
 * files, ignored ones left out, which is the list a person means when they
 * type `@` — and from a bounded walk otherwise. It is cached for a few
 * seconds: a picker that re-lists the tree on every keystroke is slow in a
 * large repository, and a list a few seconds old is not wrong.
 *
 * A mentioned file goes into the message whole, up to a cap; past the cap
 * its head goes, with a line saying so. A model handed a truncated file that
 * is not marked as truncated will reason about a file that ends early.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface FileEntry {
  /** Relative to the working directory, with forward slashes. */
  path: string;
  kind: "file" | "dir";
}

const SKIP_DIRS = new Set([".git", "node_modules", ".motif", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache"]);
const WALK_LIMIT = 5000;
const WALK_DEPTH = 8;
const CACHE_MS = 5000;

let cache: { cwd: string; at: number; entries: FileEntry[] } | null = null;

function fromGit(cwd: string): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walk(cwd: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (out.length >= WALK_LIMIT || depth > WALK_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= WALK_LIMIT) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(full, depth + 1);
      } else {
        out.push(relative(cwd, full).split(sep).join("/"));
      }
    }
  };
  visit(cwd, 0);
  return out;
}

/** Files and the directories that contain them, for the picker. */
export function listFiles(cwd: string, now = Date.now()): FileEntry[] {
  if (cache && cache.cwd === cwd && now - cache.at < CACHE_MS) return cache.entries;
  const files = fromGit(cwd) ?? walk(cwd);
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  const entries: FileEntry[] = [
    ...files.map((path): FileEntry => ({ path, kind: "file" })),
    ...[...dirs].map((path): FileEntry => ({ path, kind: "dir" })),
  ];
  cache = { cwd, at: now, entries };
  return entries;
}

/** Forget the cached list — after a task that may have created files. */
export function forgetFiles(): void {
  cache = null;
}

/**
 * Score a path against what was typed.
 *
 * A prefix of the file name beats a prefix of the path, which beats a
 * substring, which beats characters in order. Zero means no match. Ties are
 * broken by path length, so `src/a.ts` comes before `src/deep/a.ts`.
 */
export function scorePath(path: string, query: string): number {
  if (query === "") return 1;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/", p.length - 2) + 1);
  if (base.startsWith(q)) return 400;
  if (p.startsWith(q)) return 300;
  if (p.includes(q)) return 200;
  let i = 0;
  for (const ch of p) if (ch === q[i]) i++;
  return i === q.length ? 100 : 0;
}

export function matchFiles(entries: readonly FileEntry[], query: string, limit = 8): FileEntry[] {
  return entries
    .map((e) => ({ e, s: scorePath(e.path, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.path.length - b.e.path.length || a.e.path.localeCompare(b.e.path))
    .slice(0, limit)
    .map((x) => x.e);
}

/** Bytes of a mentioned file included whole; beyond this the head goes, marked. */
export const ATTACH_CAP_BYTES = 100_000;

export interface Attachment {
  mention: string;
  block: string;
}

/**
 * What an `@token` puts into the message.
 *
 * A path inside the working directory attaches the file; a directory attaches
 * its listing; `skill:name` attaches that skill's instructions. Anything else
 * is left as typed — the model reads `@user` as a word.
 */
export function attachMention(
  token: string,
  opts: { cwd: string; renderSkill?: (name: string) => string | undefined },
): Attachment | null {
  if (token.startsWith("skill:")) {
    const body = opts.renderSkill?.(token.slice("skill:".length));
    return body ? { mention: token, block: body } : null;
  }
  const clean = token.replace(/[.,;:!?)]+$/, "");
  const target = resolve(opts.cwd, clean);
  const rel = relative(opts.cwd, target);
  if (rel.startsWith("..") || !existsSync(target)) return null;
  const st = statSync(target);
  if (st.isDirectory()) {
    const names = readdirSync(target).filter((n) => !SKIP_DIRS.has(n)).sort().slice(0, 200);
    return { mention: clean, block: `<directory path="${clean}">\n${names.join("\n")}\n</directory>` };
  }
  const buf = readFileSync(target);
  const truncated = buf.length > ATTACH_CAP_BYTES;
  const text = (truncated ? buf.subarray(0, ATTACH_CAP_BYTES) : buf).toString("utf8");
  const note = truncated ? `\n… truncated: ${buf.length.toLocaleString("en-US")} bytes in total, the first ${ATTACH_CAP_BYTES.toLocaleString("en-US")} shown` : "";
  return { mention: clean, block: `<file path="${clean}">\n${text}${note}\n</file>` };
}

/** The message with its mentions attached after it. The text itself is kept as typed. */
export function expandMentions(
  text: string,
  mentions: readonly string[],
  opts: { cwd: string; renderSkill?: (name: string) => string | undefined },
): { task: string; attached: string[] } {
  const attached: string[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const a = attachMention(m, opts);
    if (!a || seen.has(a.mention)) continue;
    seen.add(a.mention);
    attached.push(a.mention);
    blocks.push(a.block);
  }
  if (blocks.length === 0) return { task: text, attached };
  return { task: `${text}\n\n${blocks.join("\n\n")}`, attached };
}

/** Setup routing considers the bounded original message, before file attachments.
 * It selects guidance only; execution still follows the user's request and policy.
 */
const SETUP_LINK = /\uFFFC(\d+)\uFFFC/g;
const SETUP_ACTION = "(?:globally\\s+)?(?:add|install|import|connect|register|configure|set\\s+up)\\b";

interface SetupClause { text: string; links: URL[]; }
function setupProse(text: string): SetupClause[] | null {
  if (text.length > 16_384) return null;
  let prose = text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/^\s*>[^\n]*$/gm, " ")
    .replace(/<(file|directory|skill)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/`[^`]*(?:`|$)|"[^"\n]*"|(?<!\w)'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’/g, quoted => {
      // Quoting just a URL is ordinary prose; quoting instructions is not.
      const inner = quoted.slice(1, -1);
      return /^https?:\/\/[^\s<>"'`]+$/i.test(inner) ? inner : " ";
    });
  const urls: URL[] = [];
  prose = prose.replace(/https?:\/\/[^\s<>"'`]+/gi, raw => {
    const clean = raw.replace(/[),.;!?]+$/, "");
    try { urls.push(new URL(clean)); } catch { return " "; }
    return ` \uFFFC${urls.length - 1}\uFFFC ${raw.slice(clean.length)}`;
  });
  if (!urls.length) return null;
  const clauses = prose.split(new RegExp(`[.!?;\\n]+|\\b(?:and|then)\\s+(?=(?:please\\s+)?${SETUP_ACTION})|그리고\\s*`, "i")).map(text => ({
    text, links: [...text.matchAll(SETUP_LINK)].flatMap(match => urls[Number(match[1])] ?? []),
  }));
  // A URL on its own line can belong to the adjacent request. A URL in another
  // prose clause ("Read this link. Install this package ...") cannot.
  return clauses.map((clause, index) => {
    if (clause.links.length) return clause;
    const adjacent = [clauses[index - 1], clauses[index + 1]];
    return { ...clause, links: adjacent.flatMap(other => other?.links.length && /^[\s:,*-]*$/.test(setupIntent(other.text)) ? other.links : []) };
  });
}

function setupIntent(clause: string): string {
  return clause.replace(SETUP_LINK, " ").replace(/[()[\]]/g, " ").trim();
}

function isSkillLink(url: URL): boolean {
  if (!["github.com", "raw.githubusercontent.com"].includes(url.hostname.toLowerCase())) return false;
  const parts = url.pathname.toLowerCase().split("/").filter(Boolean);
  return parts.length >= 2 && parts.some((part, index) => index > 0 && /^(?:skills?|skill\.md|[\w.-]+-skills?)$/.test(part));
}

function installsDependencies(intent: string): boolean {
  const object = /\b(?:install|add|configure|set\s+up)\s+([^.;!?]{0,160})/i.exec(intent)?.[1];
  if (object) {
    const dependency = object.search(/\b(?:dependenc(?:y|ies)|prerequisites?|requirements?)\b/i);
    const skill = object.search(/\bskills?\b/i);
    if (dependency >= 0 && (skill < 0 || dependency < skill)) return true;
  }
  const dependency = intent.search(/의존성|의존\s*패키지|필수\s*패키지/);
  const action = intent.search(/설치|추가|설정/);
  return dependency >= 0 && dependency < action && !/(?:스킬|skills?)(?:과|와|\s*및)\s*/i.test(intent.slice(0, dependency));
}

function requestsSetup(intent: string): boolean {
  // Informational questions, refusals and reported instructions are not actions.
  if (/^(?:please\s+)?(?:how|why|what|explain|describe|example|inspect|review|compare|read|summarize|documentation|translate|quote|tell\s+me|show\s+me)\b|\b(?:README|document(?:ation)?)\s+(?:says?|reads?)\b|\b(?:do\s+not|don['’]t|never|not\s+yet)\b|\bwithout\s+(?:installing|adding|importing|connecting|registering|configuring)\b|어떻게|방법|설명|예시|검토|번역|인용|가능한지|(?:설치|추가|등록|연결|설정|임포트)(?:은|는|을|를)?\s*(?:하지|안\s*해|없이|말고)/i.test(intent)) return false;
  const english = new RegExp(`^(?:please\\s+)?${SETUP_ACTION}|^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${SETUP_ACTION}|^(?:I|we)\\s+(?:want|need|would\\s+like)\\s+(?:you\\s+)?to\\s+${SETUP_ACTION}`, "i").test(intent);
  const korean = /(?:등록|추가|연결|설치|설정|임포트)(?:을|를)?\s*(?:좀\s*)?(?:해\s*(?:줘(?:요)?|주세요|주십시오|줄래(?:요)?)|하(?:자|세요|고\s*싶(?:어(?:요)?|다)?)|부탁(?:해(?:요)?|드립니다)?)(?=$|[\s,:.!?])/.test(intent)
    || /(?:등록|추가|연결|설치|설정|임포트)하고[^.!?\n]{0,80}(?:확인|검증)해\s*(?:줘(?:요)?|주세요|줄래(?:요)?)(?=$|[\s,:.!?])/.test(intent)
    || /가져(?:와\s*(?:줘(?:요)?|주세요)|오(?:고\s*싶(?:어(?:요)?|다)?|세요))(?=$|[\s,:.!?])/.test(intent);
  return english || korean;
}

function explicitlySelected(text: string, name: string): boolean {
  return new RegExp(`(?:@skill:|\\$)${name}\\b|^\\s*\\/${name}\\b|<skill\\s+name=["']${name}["']`, "i").test(text);
}

function namesSkill(intent: string): boolean { return /\bskills?\b|스킬/i.test(intent); }

/** Link-based skill installation, including unmistakable GitHub skill paths. */
export function skillSetupMentions(text: string): string[] {
  if (explicitlySelected(text, "skill-setup")) return [];
  const prose = setupProse(text);
  if (!prose) return [];
  const selected = prose.some(clause => {
    const intent = setupIntent(clause.text);
    if (!clause.links.length || !requestsSetup(intent) || installsDependencies(intent)) return false;
    if (namesSkill(intent)) return true;
    if (!clause.links.some(isSkillLink) || /\bmcp\b/i.test(intent)) return false;
    // An explicit skill URL can stand for "this", but not for another named
    // target such as "install its dependencies" or "install Node.js".
    return /^(?:(?:please\s+)?|(?:can|could|would|will)\s+you\s+(?:please\s+)?)(?:globally\s+)?(?:install|add|import)[\s:]*(?:(?:this|that|it)(?:\s+(?:link|repo(?:sitory)?))?(?=\s+(?:from|at|in|into|for|to|globally|system-wide|and|then)\b|[\s:]*$)|the\s+(?:link|repo(?:sitory)?)\b|from\b|(?:for|in|into|to|globally|system-wide)\b|$)/i.test(intent)
      || /(?:이거|이것|이걸|이\s*링크|여기)/.test(intent)
      || /^(?:설치|추가|등록|임포트)해/.test(intent);
  });
  return selected ? ["skill:skill-setup"] : [];
}

export function mcpSetupMentions(text: string): string[] {
  if (explicitlySelected(text, "mcp-setup")) return [];
  const prose = setupProse(text);
  if (!prose) return [];
  const selected = prose.some(clause => {
    const intent = setupIntent(clause.text);
    if (!clause.links.length || !requestsSetup(intent) || !/\bmcp\b(?![-_])/i.test(intent)) return false;
    // "mcp-builder skill" or "MCP skill" installs instructions, not a server.
    // Separate clear clauses can still select both setup skills.
    return !namesSkill(intent)
      || /\b(?:and|plus)\s+(?:(?:the|this)\s+)?mcp\s+(?:server|service|endpoint)\b|\bmcp\s+(?:server|service|endpoint)\s+(?:and|plus)\s+(?:(?:the|this)\s+)?(?:[\w-]+\s+)?skills?\b/i.test(intent)
      || /(?:및|와|과)\s*mcp(?:\s*서버)?|\bmcp\s*서버(?:와|과)\s*(?:[가-힣]+\s+)?스킬|\bmcp(?:\s*서버)?(?:를|을|도)?\s*(?:연결|등록|설정)(?:해|하)/i.test(intent);
  });
  return selected ? ["skill:mcp-setup"] : [];
}
