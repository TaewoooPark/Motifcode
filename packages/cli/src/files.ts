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
