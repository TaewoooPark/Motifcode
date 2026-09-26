import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { configHash } from "../../mcp/src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs: string[] = [];
function fixture() { const home = mkdtempSync(join(tmpdir(), "motif-mcp-registration-")); dirs.push(home); return { home, path: join(home, ".motif", "mcp.json") }; }
async function cli(home: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "packages/cli/src/main.ts"), "mcp", ...args], {
      cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), NO_COLOR: "1", SOURCE_TOKEN: "SYNTHETIC_RESOLVED_SECRET", ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP registration CLI timed out")); }, 10000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); accept({ code, stdout, stderr }); });
  });
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("MCP registration through the actual CLI process", () => {
  it("retains the CLI's model-key withholding while allowing other explicit references and literals", async () => {
    const f = fixture(); mkdirSync(join(f.home, ".motif"));
    const audit = join(f.home, "env-audit.json"), log = join(f.home, "server.ndjson"), script = join(f.home, "server.mjs");
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(audit)}, JSON.stringify({ modelAmbient: process.env.MOTIF_API_KEY === 'SYNTHETIC_MODEL_KEY', modelLiteral: process.env.MOTIF_API_KEY === 'explicit-local-value', service: process.env.FORWARDED === 'SYNTHETIC_RESOLVED_SECRET' })); await import(${JSON.stringify(pathToFileURL(join(root, "packages/mcp/test/fixtures/client-legacy.mjs")).href)});`);
    const configure = (env: Record<string, unknown>) => writeFileSync(f.path, JSON.stringify({ servers: [{ id: "probe", enabled: true, transport: "stdio", command: process.execPath, args: [script, log], env, startupTimeoutMs: 3000 }] }));
    configure({ FORWARDED: { env: "MOTIF_API_KEY" } });
    const denied = await cli(f.home, ["doctor", "--connect"], { MOTIF_API_KEY: "SYNTHETIC_MODEL_KEY" });
    expect(denied.code).toBe(1);
    expect(existsSync(audit)).toBe(false);
    expect(denied.stdout + denied.stderr).not.toContain("SYNTHETIC_MODEL_KEY");
    for (const explicitLiteral of [false, true]) {
      configure({ FORWARDED: { env: "SOURCE_TOKEN" }, ...(explicitLiteral ? { MOTIF_API_KEY: "explicit-local-value" } : {}) });
      const allowed = await cli(f.home, ["doctor", "--connect"], { MOTIF_API_KEY: "SYNTHETIC_MODEL_KEY" });
      expect(allowed, allowed.stderr).toMatchObject({ code: 0 });
      expect(JSON.parse(readFileSync(audit, "utf8"))).toEqual({ modelAmbient: false, modelLiteral: explicitLiteral, service: true });
      expect(allowed.stdout + allowed.stderr).not.toContain("SYNTHETIC_MODEL_KEY");
      const boot = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "boot").at(-1);
      expect(() => process.kill(boot.pid, 0)).toThrow();
    }
  }, 15000);

  it("preserves child argv and repeated env options, needs no model key, and never starts the server", async () => {
    const f = fixture(); const sentinel = join(f.home, "must-not-run");
    const childArgs = ["-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`, "--listen", "--help", "--env", "CHILD=untouched", "-x", "한글 공백", "", "--", '${LITERAL}', "secret-argument"];
    const add = await cli(f.home, ["add", "local", "--env", "FIRST=SYNTHETIC_INLINE_SECRET", "--env", "SECOND=x=y", "--env-ref", "TOKEN=SOURCE_TOKEN", "--profile", "playwright", "--protocol", "auto", "--", process.execPath, ...childArgs]);
    expect(add, add.stderr).toMatchObject({ code: 0 });
    expect(existsSync(sentinel)).toBe(false);
    const saved = JSON.parse(readFileSync(f.path, "utf8")).servers[0];
    expect(saved).toMatchObject({ id: "local", enabled: true, profile: "playwright", protocol: "auto", command: process.execPath, args: childArgs, env: { FIRST: "SYNTHETIC_INLINE_SECRET", SECOND: "x=y", TOKEN: { env: "SOURCE_TOKEN" } } });
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const get = await cli(f.home, ["get", "local"]);
    expect(get.code).toBe(0);
    for (const secret of ["SYNTHETIC_INLINE_SECRET", "SYNTHETIC_RESOLVED_SECRET", "secret-argument"]) expect(add.stdout + add.stderr + get.stdout + get.stderr).not.toContain(secret);
    expect(JSON.parse(get.stdout).server.env.TOKEN).toEqual({ env: "SOURCE_TOKEN" });
    for (const action of ["disable", "enable", "remove"]) expect((await cli(f.home, [action, "local"])).code).toBe(0);
    expect(JSON.parse(readFileSync(f.path, "utf8")).servers).toEqual([]);
    expect(existsSync(sentinel)).toBe(false);
  }, 20000);

  it("registers HTTP/SSE with reference headers and retains disabled-only import behavior", async () => {
    const f = fixture();
    expect((await cli(f.home, ["add", "docs", "--transport", "http", "--header", 'Authorization=Bearer ${SOURCE_TOKEN}', "--header", "X-GitHub-Api-Version=2026-03-10", "https://example.test/mcp"])).code).toBe(0);
    expect((await cli(f.home, ["add", "old", "--transport", "sse", "--header-env", "CONTEXT7_API_KEY=SOURCE_TOKEN", "https://example.test/sse"])).code).toBe(0);
    const saved = JSON.parse(readFileSync(f.path, "utf8")).servers;
    expect(saved[0]).toMatchObject({ transport: "http", enabled: true, headers: { Authorization: 'Bearer ${SOURCE_TOKEN}' } });
    expect(saved[1]).toMatchObject({ transport: "sse", headers: { CONTEXT7_API_KEY: { env: "SOURCE_TOKEN" } } });
    const source = join(f.home, "claude.json"); const target = join(f.home, "imported.json");
    writeFileSync(source, JSON.stringify({ mcpServers: { imported: { command: "node", args: ["unused.mjs"] } } }));
    expect((await cli(f.home, ["import", "--from", "claude", "--file", source, "--write", target])).code).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8")).servers[0].enabled).toBe(false);
  }, 20000);

  it("rejects duplicates and invalid or unknown options without leaking values or changing the file", async () => {
    const f = fixture(); expect((await cli(f.home, ["add", "local", "--", "node"])).code).toBe(0);
    const before = readFileSync(f.path, "utf8");
    for (const args of [
      ["add", "local", "--", "node"], ["add", "bad", "--unknown=SYNTHETIC_SECRET", "--", "node"],
      ["add", "bad", "--env", "TOKEN=SYNTHETIC_SECRET", "--env", "TOKEN=again", "--", "node"],
      ["add", "bad", "--transport", "http", "--header", "Authorization=SYNTHETIC_SECRET", "https://example.test/mcp"],
      ["add", "bad", "--transport", "http", "--header-env", "X-Test=TOKEN", "--header-env", "x-test=OTHER", "https://example.test/mcp"],
      ["add", "bad", "--transport", "http", "https://example.test/mcp?token=SYNTHETIC_SECRET"],
      ["add", "bad", "node", "--stdio-argument"], ["get", "local", "--connect"],
    ]) {
      const result = await cli(f.home, args);
      expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_SECRET");
      expect(readFileSync(f.path, "utf8")).toBe(before);
    }
  }, 20000);

  it("preserves invalid existing files and requires a fresh hash for each explicit-file edit", async () => {
    const f = fixture(); mkdirSync(join(f.home, ".motif")); writeFileSync(f.path, "invalid secret document");
    expect((await cli(f.home, ["add", "x", "--", "node"])).code).toBe(1);
    expect(readFileSync(f.path, "utf8")).toBe("invalid secret document");
    const explicit = join(f.home, "project.json"); const text = '{"servers":[]}'; writeFileSync(explicit, text);
    const args = ["add", "docs", "--mcp-config", explicit, "--transport", "http", "https://example.test/mcp"];
    expect((await cli(f.home, args)).code).toBe(1);
    expect(readFileSync(explicit, "utf8")).toBe(text);
    const saved = await cli(f.home, [...args, "--trust-mcp", configHash(text)]); expect(saved.code).toBe(0);
    expect((await cli(f.home, ["disable", "docs", "--mcp-config", explicit, "--trust-mcp", configHash(text)])).code).toBe(1);
    expect((await cli(f.home, ["disable", "docs", "--mcp-config", explicit, "--trust-mcp", JSON.parse(saved.stdout).sha256])).code).toBe(0);
    const newPath = join(f.home, "new-project.json");
    const created = await cli(f.home, ["add", "new", "--mcp-config", newPath, "--", "node"]);
    expect(created.code).toBe(0);
    const untrusted = await cli(f.home, ["get", "new", "--mcp-config", newPath]);
    expect(JSON.parse(untrusted.stdout).server.enabled).toBe(false);
    const trusted = await cli(f.home, ["get", "new", "--mcp-config", newPath, "--trust-mcp", JSON.parse(created.stdout).sha256]);
    expect(JSON.parse(trusted.stdout).server.enabled).toBe(true);
  }, 20000);

  it("fails safely while another editor owns the lock and rejects unknown help flags", async () => {
    const f = fixture(); mkdirSync(join(f.home, ".motif")); writeFileSync(f.path + ".lock", "other editor");
    const result = await cli(f.home, ["add", "x", "--", "node"]);
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout).error.code).toBe("config_locked");
    expect(readFileSync(f.path + ".lock", "utf8")).toBe("other editor");
    expect(existsSync(f.path)).toBe(false);
    expect((await cli(f.home, ["--help", "--unknown=SYNTHETIC_SECRET"])).code).toBe(2);
  });
});
