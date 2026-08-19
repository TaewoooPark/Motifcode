/**
 * The artifact people would actually install.
 *
 * `pnpm build` printed "no build step yet" and exited 0, and `pnpm exec motif`
 * answered `Command "motif" not found`. Everything that passed — typecheck,
 * tests, lint — ran against TypeScript sources through `tsx`, so nothing
 * anywhere established that the installable thing starts, let alone works.
 *
 * This builds it, packs it, installs the tarball into an empty directory with
 * no workspace and no dev dependencies, and drives it against a mock server.
 * Slow, and the only test that covers the gap between "the source is correct"
 * and "the product runs".
 */

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const BUNDLE = join(REPO, "packages/cli/dist/motif.js");

/** Vitest's default timeout is nowhere near enough for a build and an install. */
const SLOW = 300_000;

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

let installDir: string;
let motif: string;

describe("the installed CLI", () => {
  beforeAll(() => {
    run("node", ["scripts/build.mjs"], REPO);

    // Pack from the workspace, install into a directory that knows nothing
    // about it. A tarball that only works next to its own repository is not an
    // artifact.
    const packDir = mkdtempSync(join(tmpdir(), "motif-pack-"));
    run("npm", ["pack", "--pack-destination", packDir], join(REPO, "packages/cli"));
    const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    expect(tarball, "npm pack should produce a tarball").toBeDefined();

    installDir = mkdtempSync(join(tmpdir(), "motif-install-"));
    run("npm", ["init", "-y"], installDir);
    run("npm", ["install", "--no-audit", "--no-fund", join(packDir, tarball!)], installDir);
    motif = join(installDir, "node_modules", ".bin", "motif");
  }, SLOW);

  it("produces an executable bundle with a single shebang", () => {
    expect(existsSync(BUNDLE)).toBe(true);
    expect(statSync(BUNDLE).mode & 0o111).toBeGreaterThan(0);
  });

  it("installs a `motif` binary that runs", () => {
    expect(existsSync(motif)).toBe(true);
    expect(run(motif, ["version"], installDir).trim()).toBe("0.0.1");
  });

  it("prints help without a server", () => {
    expect(run(motif, ["help"], installDir)).toContain("motif \"<task>\"");
  });

  it("does not print anything before the command it was asked for", () => {
    // Bundling turned `import.meta.url === process.argv[1]` — the guard at the
    // bottom of the schema linter — permanently true, so every command printed
    // "tool schemas: clean" first. A library module should not have a main.
    expect(run(motif, ["version"], installDir).trim().split("\n")).toHaveLength(1);
  });

  it("lints its own schemas", () => {
    expect(run(motif, ["lint"], installDir)).toContain("clean");
  });

  it("carries no runtime dependencies", () => {
    // The workspace is a development convenience; nine private packages are
    // not something a registry can resolve.
    const installed = readdirSync(join(installDir, "node_modules")).filter((n) => !n.startsWith("."));
    expect(installed).toEqual(["motifcode"]);
  });

  it("runs a whole task against a server", async () => {
    const bodies: { messages: { role: string; content?: string }[] }[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as (typeof bodies)[number]);
        const done = (confirm: boolean) =>
          `</think><tool_call>${JSON.stringify({
            name: "done",
            arguments: confirm ? { summary: "installed and ran", confirm: true } : { summary: "installed and ran" },
          })}</tool_call>`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: done(bodies.length > 1) } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const work = mkdtempSync(join(tmpdir(), "motif-work-"));
    const code = await new Promise<number | null>((r) => {
      const child = spawn(
        motif,
        ["make it work", "--endpoint", `http://127.0.0.1:${port}`, "--no-hero", "--cwd", work],
        { cwd: work, stdio: ["ignore", "pipe", "pipe"] },
      );
      child.on("close", r);
    });
    await new Promise<void>((r) => server.close(() => r()));

    expect(code).toBe(0);
    expect(bodies[0]!.messages[1]).toMatchObject({ role: "user", content: "make it work" });
  }, SLOW);

  afterAll(() => {
    /* temp directories are the OS's problem */
  });
});
