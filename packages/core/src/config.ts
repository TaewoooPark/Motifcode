/**
 * Where the endpoint, the model id and the API key come from.
 *
 * Motif-3 is reached through a hosted OpenAI-compatible endpoint now, and a
 * hosted endpoint has a credential. That changes two things a local server
 * never had to think about.
 *
 * The key must not leak. It is read here and handed to the transport as a
 * value; it is never written into `process.env`, because everything the agent
 * runs — `bash`, `term`, `git apply`, project hooks — inherits that
 * environment, and a model that runs `env` to look around would otherwise put
 * the credential into a tool result, and from there into the journal. The CLI
 * goes one step further and removes `MOTIF_API_KEY` from its own environment
 * once it has been read; see `withholdSecrets`.
 *
 * It has to be findable. A `.env` file next to where the command is typed, or
 * under `~/.motif/`, is read for `MOTIF_*` keys only — never for anything
 * else that file might hold, and never into the environment. Precedence is
 * the usual one: an explicit flag, then the process environment, then the
 * files in order.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The hosted endpoint Motif-3 is served from. The `/v1` is added per request. */
export const DEFAULT_ENDPOINT = "https://llm.onerouter.pro";
/** The model id the hosted endpoint routes to Motif-3. */
export const DEFAULT_MODEL = "motif/motif-3";

export const ENV_ENDPOINT = "MOTIF_ENDPOINT";
export const ENV_MODEL = "MOTIF_MODEL";
export const ENV_API_KEY = "MOTIF_API_KEY";

export interface EndpointConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Where each value came from, so a wrong file is findable from the output. */
  sources: { endpoint: string; model: string; apiKey?: string };
}

export interface ResolveOptions {
  flags?: { endpoint?: string; model?: string };
  env?: NodeJS.ProcessEnv;
  /**
   * What to fall back to when nothing else names a value — a settings file's
   * choice, below the environment and the flags. Absent, the built-in
   * defaults apply.
   */
  defaults?: { endpoint?: string; model?: string };
  /**
   * `.env` files to read, in order of precedence. Defaults to `.env` in the
   * current directory and then `~/.motif/.env`. A path that does not exist is
   * skipped; one that exists but does not parse is an error, because a key
   * that silently fails to load surfaces later as a 401 with no explanation.
   */
  dotenvPaths?: string[];
}

/**
 * Parse a dotenv file.
 *
 * `KEY=value`, `export KEY=value`, single or double quotes, `#` comments, and
 * a trailing ` # comment` on an unquoted value. Anything else — a stray line
 * of Python, say — is ignored rather than rejected, so a file that carries
 * notes alongside the keys still loads.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * The base URL a request is built on.
 *
 * Trailing slashes go, and so does a trailing `/v1`: the OpenAI SDKs take the
 * base URL *with* `/v1`, so that is the form people copy out of a vendor's
 * example, and the transport appends `/v1/chat/completions` itself. Accepting
 * both means the pasted value works instead of producing `/v1/v1/...` and a
 * 404 that reads as the endpoint being down.
 */
export function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function defaultDotenvPaths(cwd = process.cwd()): string[] {
  return [join(cwd, ".env"), join(homedir(), ".motif", ".env")];
}

function readDotenv(path: string): Record<string, string> | undefined {
  if (!existsSync(path)) return undefined;
  return parseDotenv(readFileSync(path, "utf8"));
}

export function resolveEndpointConfig(opts: ResolveOptions = {}): EndpointConfig {
  const env = opts.env ?? process.env;
  const files: { path: string; values: Record<string, string> }[] = [];
  for (const path of opts.dotenvPaths ?? defaultDotenvPaths()) {
    const values = readDotenv(path);
    if (values) files.push({ path, values });
  }

  const pick = (
    flag: string | undefined,
    key: string,
    fallback: string | undefined,
  ): { value: string | undefined; source: string } => {
    if (flag !== undefined && flag !== "") return { value: flag, source: "flag" };
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv !== "") return { value: fromEnv, source: `environment ${key}` };
    for (const f of files) {
      const v = f.values[key];
      if (v !== undefined && v !== "") return { value: v, source: `${f.path} (${key})` };
    }
    return { value: fallback, source: fallback !== undefined && fallback !== (key === ENV_ENDPOINT ? DEFAULT_ENDPOINT : DEFAULT_MODEL) ? "settings" : "default" };
  };

  const endpoint = pick(opts.flags?.endpoint, ENV_ENDPOINT, opts.defaults?.endpoint ?? DEFAULT_ENDPOINT);
  const model = pick(opts.flags?.model, ENV_MODEL, opts.defaults?.model ?? DEFAULT_MODEL);
  const apiKey = pick(undefined, ENV_API_KEY, undefined);

  return {
    endpoint: normalizeEndpoint(endpoint.value!),
    model: model.value!,
    ...(apiKey.value !== undefined ? { apiKey: apiKey.value } : {}),
    sources: {
      endpoint: endpoint.source,
      model: model.source,
      ...(apiKey.value !== undefined ? { apiKey: apiKey.source } : {}),
    },
  };
}

/**
 * Remove the credential from an environment that child processes will inherit.
 *
 * Called by the CLI once the key has been read. The tools the model drives run
 * with the harness's environment, and so does `git apply`; a key left in it is
 * one `env` away from a tool result, and tool results are journalled.
 */
export function withholdSecrets(env: NodeJS.ProcessEnv): void {
  delete env[ENV_API_KEY];
}
