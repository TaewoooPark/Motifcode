import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<object>(), spawn }));
import { runGithubBrowserLogin } from "../src/github-login.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  spawn.mockReturnValue(child);
  const controller = new AbortController();
  const progress = vi.fn(); const browser = vi.fn(async (_url: URL) => {});
  const run = () => runGithubBrowserLogin({ signal: controller.signal, onProgress: progress, openBrowser: browser, humanInteractive: true, env: { PATH: "/usr/bin", HOME: "/tmp/home", GH_TOKEN: "private-token", GITHUB_TOKEN: "also-private", GH_HOST: "evil.example", GH_CONFIG_DIR: "/untrusted" } });
  return { child, controller, progress, browser, run };
}
describe("GitHub browser login host UI", () => {
  it("never emits device codes or starts browser login through a noninteractive tool pipe", async () => {
    const browser = vi.fn(); const progress = vi.fn(); const before = spawn.mock.calls.length;
    await expect(runGithubBrowserLogin({ signal: new AbortController().signal, openBrowser: browser, onProgress: progress, humanInteractive: false })).rejects.toMatchObject({ code: "interactive_login_required" });
    expect(browser).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled(); expect(spawn.mock.calls).toHaveLength(before);
  });
  it("parses split device prompts and reveals only the human code and fixed URL", async () => {
    const { child, progress, browser, run } = fixture(); const pending = run();
    child.stderr.write("untrusted secret output\n! First copy your one-time code: ABCD-");
    child.stderr.write("1234\nOpen this URL to continue in your web browser: https://github.com/login/");
    expect(browser).not.toHaveBeenCalled();
    child.stderr.write("device\n"); await Promise.resolve();
    expect(progress).toHaveBeenCalledOnce(); expect(progress).toHaveBeenCalledWith("GitHub code: ABCD-1234 · github.com/login/device");
    expect(browser).toHaveBeenCalledOnce(); expect(browser.mock.calls[0]![0].href).toBe("https://github.com/login/device");
    child.emit("close", 0); await pending;
    const [command, args, options] = spawn.mock.calls.at(-1)!;
    expect(command).toBe("gh"); expect(args).toContain("--clipboard=false"); expect(options.shell).toBe(false);
    expect(options.env).toMatchObject({ HOME: "/tmp/home", GH_PROMPT_DISABLED: "1" });
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR"]) expect(options.env[key]).toBeUndefined();
  });
  it("does not open an arbitrary verification URL", async () => {
    const { child, browser, progress, run } = fixture(); const pending = run();
    child.stderr.write("First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://evil.example/private\n");
    await expect(pending).rejects.toMatchObject({ code: "github_login_failed" });
    expect(browser).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled(); child.emit("close", null);
  });
  it("cancels the child and does not forward process output", async () => {
    const { child, controller, progress, run } = fixture(); const pending = run();
    child.stderr.write("private-provider-error"); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM"); expect(progress).not.toHaveBeenCalled(); child.emit("close", null);
  });
  it("bounds output and withholds failed process diagnostics", async () => {
    const { child, run } = fixture(); const pending = run(); child.stderr.write("secret".repeat(6000));
    await expect(pending).rejects.toMatchObject({ code: "github_login_failed" }); child.emit("close", null);
  });
  it("reports missing gh without leaking the spawn error", async () => {
    const { child, run } = fixture(); const pending = run(); child.emit("error", Object.assign(new Error("private-value"), { code: "ENOENT" }));
    await expect(pending).rejects.toMatchObject({ code: "github_cli_missing", message: "GitHub CLI is not installed. Install gh, then retry GitHub MCP login." }); child.emit("close", null);
  });
});
