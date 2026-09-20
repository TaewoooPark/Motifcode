/**
 * The `@` picker's list, its matching, and what a mention attaches.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTACH_CAP_BYTES, attachMention, expandMentions, forgetFiles, listFiles, matchFiles, scorePath } from "../src/files.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "motif-files-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "deep", "app.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "node_modules", "x", "index.js"), "ignored\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "i"], { cwd: dir });
  writeFileSync(join(dir, "untracked.txt"), "new\n");
  forgetFiles();
  return dir;
}

describe("listing", () => {
  it("lists tracked and untracked files and their directories, not ignored ones", () => {
    const dir = repo();
    const paths = listFiles(dir).map((e) => e.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("untracked.txt");
    expect(paths).toContain("src/");
    expect(paths).toContain("src/deep/");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("walks a directory that is not a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "motif-norepo-"));
    writeFileSync(join(dir, "a.txt"), "a");
    forgetFiles();
    expect(listFiles(dir).map((e) => e.path)).toEqual(["a.txt"]);
  });
});

describe("matching", () => {
  it("ranks a file-name prefix over a path prefix over a substring over a subsequence", () => {
    expect(scorePath("src/app.ts", "app")).toBe(400);
    expect(scorePath("src/app.ts", "src/a")).toBe(300);
    expect(scorePath("src/app.ts", "pp.t")).toBe(200);
    expect(scorePath("src/app.ts", "sat")).toBe(100);
    expect(scorePath("src/app.ts", "zzz")).toBe(0);
  });

  it("puts the shallower of two equal matches first", () => {
    const dir = repo();
    const hits = matchFiles(listFiles(dir), "app").map((e) => e.path);
    expect(hits[0]).toBe("src/app.ts");
    expect(hits[1]).toBe("src/deep/app.ts");
  });
});

describe("attaching", () => {
  it("attaches a file whole, a directory as a listing, and nothing outside the tree", () => {
    const dir = repo();
    expect(attachMention("src/app.ts", { cwd: dir })?.block).toBe('<file path="src/app.ts">\nexport const a = 1;\n\n</file>');
    expect(attachMention("src/", { cwd: dir })?.block).toContain("<directory path=\"src/\">\napp.ts\ndeep");
    expect(attachMention("../etc/passwd", { cwd: dir })).toBeNull();
    expect(attachMention("nope.txt", { cwd: dir })).toBeNull();
  });

  it("drops trailing punctuation from a mention written into a sentence", () => {
    const dir = repo();
    expect(attachMention("README.md,", { cwd: dir })?.mention).toBe("README.md");
  });

  it("attaches a skill's instructions for @skill:name", () => {
    const a = attachMention("skill:commit", { cwd: "/", renderSkill: (n) => `<skill name="${n}">body</skill>` });
    expect(a?.block).toBe('<skill name="commit">body</skill>');
    expect(attachMention("skill:missing", { cwd: "/", renderSkill: () => undefined })).toBeNull();
  });

  it("marks a file it had to cut", () => {
    const dir = repo();
    writeFileSync(join(dir, "big.txt"), "x".repeat(ATTACH_CAP_BYTES + 10));
    const a = attachMention("big.txt", { cwd: dir })!;
    expect(a.block).toContain("truncated");
    expect(a.block.length).toBeLessThan(ATTACH_CAP_BYTES + 300);
  });

  it("keeps the text as typed and appends the attachments once each", () => {
    const dir = repo();
    const { task, attached } = expandMentions("read @README.md and @README.md again, @nothing", ["README.md", "README.md", "nothing"], { cwd: dir });
    expect(attached).toEqual(["README.md"]);
    expect(task.startsWith("read @README.md and @README.md again, @nothing\n\n<file path=\"README.md\">")).toBe(true);
    expect(task.split("<file path=").length).toBe(2);
  });
});
