import { spawn } from "node:child_process";
import { McpAuthError, githubCredentialEnvironment } from "@motifcode/mcp";
import { openExternalUrl } from "./browser-open.js";

export interface GitHubBrowserLoginOptions {
  signal: AbortSignal;
  /** Human terminal UI only. Never put device codes in model context or a journal. */
  onProgress?: (message: string) => void;
  openBrowser?: (url: URL) => Promise<void>;
  /** A real terminal panel owned by the host, never a model tool's output pipe. */
  humanInteractive?: boolean;
  /** Host environment; token overrides are removed before invoking gh. */
  env?: NodeJS.ProcessEnv;
}

/** Use gh's own registered OAuth application and OS credential storage. */
export async function runGithubBrowserLogin(options: GitHubBrowserLoginOptions): Promise<void> {
  const failure = (code: string, message: string) => new McpAuthError(code, message);
  if (options.signal.aborted) throw failure("cancelled", "GitHub login was cancelled.");
  if (!(options.humanInteractive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY))) {
    throw failure("interactive_login_required", "Open an interactive terminal and run motif mcp login github to complete GitHub browser sign-in.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key", "--clipboard=false"], {
      env: githubCredentialEnvironment(options.env), stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true,
    });
    let output = "";
    let settled = false;
    let opening: Promise<void> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => stop(failure("timeout", "GitHub login exceeded its deadline.")), 180_000);
    const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener("abort", aborted); };
    const stop = (error: McpAuthError) => {
      if (settled) return;
      settled = true; cleanup();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
      reject(error);
    };
    const aborted = () => stop(failure("cancelled", "GitHub login was cancelled."));
    options.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal.aborted) aborted();
    const consume = (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 32_768) { stop(failure("github_login_failed", "GitHub login returned unexpected output. Run gh auth login directly, then retry Motif login.")); return; }
      if (opening) return;
      const code = /First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?=\s|$)/.exec(output)?.[1];
      const url = /Open this URL to continue in your web browser:\s*(\S+)/.exec(output)?.[1];
      if (!code || !url) return;
      // Require a complete line before parsing a possibly split stream chunk.
      if (!output.includes(url + "\n") && !output.includes(url + "\r")) return;
      if (url !== "https://github.com/login/device") { stop(failure("github_login_failed", "GitHub login returned an unexpected verification address.")); return; }
      try { options.onProgress?.(`GitHub code: ${code} · github.com/login/device`); }
      catch { stop(failure("github_login_failed", "Could not display the GitHub verification code.")); return; }
      opening = Promise.resolve().then(() => (options.openBrowser ?? openExternalUrl)(new URL(url)));
      void opening.catch(() => stop(failure("github_browser_failed", "Could not open GitHub in the browser. Run gh auth login directly, then retry Motif login.")));
    };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    child.once("error", (error: NodeJS.ErrnoException) => stop(failure(error.code === "ENOENT" ? "github_cli_missing" : "github_login_failed", error.code === "ENOENT" ? "GitHub CLI is not installed. Install gh, then retry GitHub MCP login." : "Could not start GitHub CLI login.")));
    child.once("close", code => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) { stop(failure("github_login_failed", "GitHub login did not complete. Run gh auth login directly, then retry Motif login.")); return; }
      void (opening ?? Promise.resolve()).then(() => {
        if (settled) return;
        settled = true; cleanup(); resolve();
      }, () => stop(failure("github_browser_failed", "Could not open GitHub in the browser.")));
    });
  });
}
