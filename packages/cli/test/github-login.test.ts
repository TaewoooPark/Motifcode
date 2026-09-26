import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<object>(), spawn }));
import { runGithubBrowserLogin } from "../src/github-login.js";
import { connectMcpServers } from "../src/mcp-connect.js";
import { McpAuthBroker, McpAuthError, type McpLoginOptions } from "@motifcode/mcp";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  spawn.mockReturnValue(child);
  const controller = new AbortController();
  const progress = vi.fn(); const browser = vi.fn(async (_url: URL) => {});
  const run = (noBrowser = false) => runGithubBrowserLogin({ signal: controller.signal, onProgress: progress, openBrowser: browser, noBrowser, humanInteractive: true, env: { PATH: "/usr/bin", HOME: "/tmp/home", GH_TOKEN: "private-token", GITHUB_TOKEN: "also-private", GH_HOST: "evil.example", GH_CONFIG_DIR: "/tmp/home/.gh" } });
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
    // The login lands in the person's own gh config, where token reads look.
    expect(options.env).toMatchObject({ HOME: "/tmp/home", GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: "/tmp/home/.gh" });
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"]) expect(options.env[key]).toBeUndefined();
  });
  it("does not open an arbitrary verification URL", async () => {
    const { child, browser, progress, run } = fixture(); const pending = run();
    child.stderr.write("First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://evil.example/private\n");
    await expect(pending).rejects.toMatchObject({ code: "github_login_failed" });
    expect(browser).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled(); child.emit("close", null);
  });
  it("waits for manual device approval without opening a browser", async () => {
    const { child, progress, browser, run } = fixture(); const pending = run(true);
    child.stderr.write("First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n");
    await Promise.resolve();
    expect(progress).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith("GitHub code: ABCD-1234 · https://github.com/login/device");
    expect(browser).not.toHaveBeenCalled();
    // Extra output must not repeat the prompt while gh waits for approval.
    child.stderr.write("waiting\n");
    expect(progress).toHaveBeenCalledOnce();
    child.emit("close", 0); await pending;
    expect(browser).not.toHaveBeenCalled();
  });
  it("forwards no-browser from the connection command into GitHub's device flow", async () => {
    const { child, controller, progress, browser } = fixture();
    const auth = new McpAuthBroker();
    // Stop after the real device-flow helper completes, before remote discovery.
    vi.spyOn(auth, "login").mockImplementation(async (_server, options: McpLoginOptions = {}) => {
      await options.onGitHubLogin!({ signal: controller.signal });
      throw new McpAuthError("cancelled", "Test stopped after authorization.");
    });
    const pending = connectMcpServers({ servers: [{ id: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", credentialProvider: "github-cli", enabled: true }] }, {
      auth, forceLogin: true, noBrowser: true, humanInteractive: true, onProgress: progress, openBrowser: browser,
    });
    child.stderr.write("First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n");
    await Promise.resolve(); child.emit("close", 0);
    expect((await pending).connections[0]?.error?.code).toBe("cancelled");
    expect(progress).toHaveBeenCalledWith("GitHub code: ABCD-1234 · https://github.com/login/device");
    expect(browser).not.toHaveBeenCalled();
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
