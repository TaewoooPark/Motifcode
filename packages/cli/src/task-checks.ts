import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LoopOptions, ToolResult } from "@motifcode/core";

interface DeclaredCheck { id: string; command: string; files: string[] }
interface Progress { file: string; milestones: string[] }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a task-checks object.");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing task-checks " + field);
  return value;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Expected a non-empty " + field + " list.");
  return value.map(v => text(v, field));
}

function within(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

/** A task owner explicitly supplies the manifest. It is never discovered in a project. */
export async function loadTaskChecks(cwd: string, manifest: string) {
  const root = await realpath(cwd);
  const raw = await readFile(resolve(root, manifest), "utf8");
  const spec = object(JSON.parse(raw));
  function relativeFile(value: unknown): string {
    const name = text(value, "relative file path");
    if (isAbsolute(name) || !within(root, resolve(root, name))) throw new Error("Task check file outside workspace: " + name);
    return name;
  }
  if (spec.checks !== undefined && !Array.isArray(spec.checks)) throw new Error("Expected a checks array.");
  const checks: DeclaredCheck[] = (spec.checks ?? []).map((value: unknown) => {
    const c = object(value);
    return { id: text(c.id, "id"), command: text(c.command, "command"), files: strings(c.files, "files").map(relativeFile) };
  });
  const byId = new Map(checks.map(c => [c.id, c]));
  const byCommand = new Map(checks.map(c => [c.command, c]));
  if (byId.size !== checks.length || byCommand.size !== checks.length) throw new Error("Check IDs and commands must be unique.");
  let progress: Progress | undefined;
  if (spec.progress !== undefined) {
    const p = object(spec.progress);
    const milestones = strings(p.milestones, "milestones");
    if (milestones.some(m => /[\r\n]/.test(m))) throw new Error("A milestone must be a single line.");
    progress = { file: relativeFile(p.file), milestones };
  }
  if (!checks.length && !progress) throw new Error("Declare at least one check or a progress file.");
  async function checkedPath(name: string): Promise<string> {
    const dest = await realpath(resolve(root, name));
    if (!within(root, dest) || !(await stat(dest)).isFile()) throw new Error("Expected an in-workspace regular file");
    return dest;
  }
  async function digest(id: string): Promise<string | undefined> {
    const check = byId.get(id);
    if (!check) return undefined;
    try {
      const hashes = [];
      for (const file of check.files) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(await checkedPath(file))) hash.update(chunk);
        hashes.push(hash.digest("hex"));
      }
      return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
    } catch { return undefined; }
  }
  const key = createHash("sha256").update(JSON.stringify({ root, checks, progress })).digest("hex");
  async function verifyBash(command: string, dispatch: () => Promise<ToolResult>): Promise<ToolResult> {
    const check = byCommand.get(command);
    if (!check) return dispatch();
    const before = await digest(check.id);
    const result = await dispatch();
    const after = await digest(check.id);
    const status = !before || before !== after ? "unavailable" : result.ok ? "pass" : "fail";
    return { ...result, requiredOutputReceipt: { id: check.id, digest: after ?? "", status } };
  }
  async function readProgress(): Promise<number | undefined> {
    if (!progress) return undefined;
    try {
      const fp = await checkedPath(progress.file);
      const longest = Buffer.byteLength(progress.milestones.join("\r\n")) + 2;
      if ((await stat(fp)).size > longest) return undefined;
      const contents = await readFile(fp, "utf8");
      if (contents === "") return 0;
      const rows = contents.replace(/\r?\n$/, "").split(/\r?\n/);
      return rows.every((line, i) => line === progress!.milestones[i]) ? rows.length : undefined;
    } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? 0 : undefined; }
  }
  const options: Pick<LoopOptions, "taskChecksKey" | "requiredOutputVerifier" | "readProgress"> = {
    taskChecksKey: key,
    ...(checks.length ? { requiredOutputVerifier: { ids: checks.map(c => c.id), digest } } : {}),
    ...(progress ? { readProgress } : {}),
  };
  const instructions = checks.map(c => "Before completion, run this exact bash verification command for " + c.id + ": " + c.command).join("\n");
  return { key, verifyBash, options, instructions };
}
