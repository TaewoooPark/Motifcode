/**
 * Signing in: an API key typed once, checked, and kept.
 *
 * The hosted endpoint needs a credential, and "put MOTIF_API_KEY in a .env
 * file" is the kind of instruction that ends a first run before it starts.
 * Claude Code and Codex both open with a login the first time; this is the
 * same shape without a browser — Infron hands out a key on its dashboard,
 * the person pastes it here, and it is verified against the endpoint before
 * anything is written. A key that would only fail at the first task is not a
 * login, it is a delayed error.
 *
 * Nothing here touches the environment. The key goes to `~/.motif/.env`,
 * which the next start reads the way it reads any other `.env`, and it is
 * given to the running session as a value.
 */

import { homedir } from "node:os";
import { ENV_API_KEY, normalizeEndpoint } from "@motifcode/core";

/** Where a key comes from, for the prompt. */
export const KEY_PAGE = "https://infron.ai/dashboard/apiKeys";

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyOptions {
  endpoint: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask the endpoint whether it accepts the key.
 *
 * A one-token completion against the configured model, not the model
 * listing: on a router the listing is public, so a wrong key reads it as
 * well as a right one, and a login that said "signed in" to a bad key
 * would be worse than no login. The completion is the smallest request that
 * proves the key opens the door and the model is behind it.
 */
export async function verifyApiKey(opts: VerifyOptions): Promise<VerifyResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const endpoint = normalizeEndpoint(opts.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetchImpl(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const message = await serverMessage(res);
      return { ok: false, reason: `the endpoint rejected this key (${res.status}${message ? `: ${message}` : ""})` };
    }
    if (!res.ok) {
      const message = await serverMessage(res);
      return { ok: false, reason: `${endpoint} answered ${res.status} for ${opts.model}${message ? `: ${message}` : ""} — the key may be fine; check the model id` };
    }
    return { ok: true };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? `${endpoint} did not answer in time` : `${endpoint} could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function serverMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    const message = typeof body.error?.message === "string" ? body.error.message : "";
    // The router appends a request id; it is for their logs, not this prompt.
    return message.replace(/\s*\(request id: [^)]*\)/, "").trim();
  } catch {
    return "";
  }
}

/**
 * What was pasted, as a key.
 *
 * People paste the whole line from a dashboard or a `.env`: quotes, a
 * `MOTIF_API_KEY=` prefix, an `export`, a trailing newline. All of that is
 * the key's packaging, not the key.
 */
export function normaliseKeyInput(raw: string): string {
  let s = raw.trim();
  s = s.replace(new RegExp(`^(?:export\\s+)?${ENV_API_KEY}\\s*=\\s*`), "");
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.trim();
}

/** The lines the login prompt shows above the input. */
export function loginLines(envPath: string, home = homedir()): string[] {
  const shown = envPath.startsWith(home + "/") ? `~${envPath.slice(home.length)}` : envPath;
  // Short lines: the box hard-wraps at its width, and a URL or a path cut
  // mid-word cannot be copied.
  return [
    `Get one at ${KEY_PAGE}`,
    "Motif-3 is free there through September 2026.",
    `The key is checked with the endpoint and saved to ${shown},`,
    "readable only by you and never shown to the model.",
  ];
}

/**
 * Read a secret from a terminal without echoing it.
 *
 * Raw mode, one character at a time, a `•` per character so the person can
 * see that typing lands, Backspace to correct, Enter to finish, Esc or
 * Ctrl-C to give up (null). Without a terminal the line is read from the
 * pipe instead, so `printf '%s\n' "$KEY" | motif login` works in a script.
 */
export function readSecret(
  prompt: string,
  io: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } = { stdin: process.stdin, stdout: process.stdout },
): Promise<string | null> {
  const { stdin, stdout } = io;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        buf += chunk;
      });
      stdin.on("end", () => resolve(buf.split("\n")[0] ?? ""));
      stdin.on("error", () => resolve(null));
    });
  }
  return new Promise((resolve) => {
    const chars: string[] = [];
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (value: string | null): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish(chars.join(""));
          return;
        }
        if (ch === "\x03" || ch === "\x1b" || ch === "\x04") {
          finish(null);
          return;
        }
        if (ch === "\x7f" || ch === "\b") {
          if (chars.length > 0) {
            chars.pop();
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch === "\x15") {
          stdout.write("\b \b".repeat(chars.length));
          chars.length = 0;
          continue;
        }
        if (ch < " ") continue;
        chars.push(ch);
        stdout.write("•");
      }
    };
    stdin.on("data", onData);
  });
}
