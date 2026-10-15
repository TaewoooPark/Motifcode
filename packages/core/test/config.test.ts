/**
 * Where the credential comes from, and where it must not go.
 *
 * A hosted endpoint is the first thing this harness has talked to that needs
 * a secret. The tests here are about the two ways a secret goes wrong: not
 * being found, and being found by the wrong process.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  ENV_MORPHFACTORY_API_KEY,
  PROVIDERS,
  apiKeyEnvForEndpoint,
  forgetApiKey,
  normalizeEndpoint,
  parseDotenv,
  providerForEndpoint,
  removeDotenvKey,
  resolveEndpointConfig,
  saveApiKey,
  upsertDotenv,
  withholdSecrets,
} from "../src/config.js";

describe("dotenv parsing", () => {
  it("reads the usual shapes and ignores the rest", () => {
    const parsed = parseDotenv(
      [
        "# comment",
        "",
        "MOTIF_API_KEY=sk-plain",
        'export MOTIF_ENDPOINT="https://llm.example/v1"',
        "MOTIF_MODEL='motif/motif-3'",
        "TRAILING=value # a note",
        "from openai import OpenAI",
        "print(completion.choices[0].message.content)",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      MOTIF_API_KEY: "sk-plain",
      MOTIF_ENDPOINT: "https://llm.example/v1",
      MOTIF_MODEL: "motif/motif-3",
      TRAILING: "value",
    });
  });
});

describe("endpoint normalisation", () => {
  it("accepts the base URL with or without /v1", () => {
    // The OpenAI SDKs take the base URL with `/v1`, so that is what people
    // paste; the transport appends `/v1/...` itself.
    expect(normalizeEndpoint("https://llm.example/v1")).toBe("https://llm.example");
    expect(normalizeEndpoint("https://llm.example/v1/")).toBe("https://llm.example");
    expect(normalizeEndpoint("https://llm.example/")).toBe("https://llm.example");
    expect(normalizeEndpoint("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });
});

describe("resolution", () => {
  function dir(files: Record<string, string>): string {
    const d = mkdtempSync(join(tmpdir(), "motif-config-"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content, "utf8");
    return d;
  }

  it("defaults to the hosted endpoint and model", () => {
    const c = resolveEndpointConfig({ env: {}, dotenvPaths: [] });
    expect(c.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(c.model).toBe(DEFAULT_MODEL);
    expect(c.apiKey).toBeUndefined();
    expect(c.sources).toEqual({ endpoint: "default", model: "default" });
  });

  it("reads the key from a .env file, and says which one", () => {
    const d = dir({ ".env": "MOTIF_API_KEY=sk-from-file\n" });
    const c = resolveEndpointConfig({ env: {}, dotenvPaths: [join(d, ".env")] });
    expect(c.apiKey).toBe("sk-from-file");
    expect(c.sources.apiKey).toContain(join(d, ".env"));
  });

  it("selects the credential for the resolved endpoint without crossing providers", () => {
    const path = join(dir({ ".env": "MOTIF_API_KEY=sk-infron\nMOTIF_MORPHFACTORY_API_KEY=sk-morph\n" }), ".env");
    const options = { env: {}, dotenvPaths: [path] };
    expect(resolveEndpointConfig(options).apiKey).toBe("sk-infron");
    const morph = resolveEndpointConfig({ ...options, flags: { endpoint: `${PROVIDERS.morphfactory.endpoint}/v1/` } });
    expect(morph.endpoint).toBe(PROVIDERS.morphfactory.endpoint);
    expect(morph.model).toBe(DEFAULT_MODEL);
    expect(morph.apiKey).toBe("sk-morph");
    expect(morph.sources.apiKey).toBe(`${path} (${ENV_MORPHFACTORY_API_KEY})`);
    expect(providerForEndpoint("https://api-cbt.morphfactory.io:443/v1")).toBe("morphfactory");
    expect(resolveEndpointConfig({ ...options, flags: { endpoint: "https://api-cbt.morphfactory.io:443/v1" } }).apiKey).toBe("sk-morph");
    expect(resolveEndpointConfig({ ...options, flags: { endpoint: "http://localhost:8080" } }).apiKey).toBe("sk-infron");
    expect(resolveEndpointConfig({
      env: { MOTIF_API_KEY: "sk-infron" }, dotenvPaths: [], defaults: { endpoint: PROVIDERS.morphfactory.endpoint },
    }).apiKey).toBeUndefined();
  });

  it("keeps environment and file precedence within the Morphfactory credential slot", () => {
    const first = join(dir({ ".env": "MOTIF_API_KEY=sk-infron-first\n" }), ".env");
    const second = join(dir({ ".env": "MOTIF_MORPHFACTORY_API_KEY=sk-morph-file\n" }), ".env");
    const options = { dotenvPaths: [first, second], defaults: { endpoint: PROVIDERS.morphfactory.endpoint } };
    expect(resolveEndpointConfig({ ...options, env: {} }).apiKey).toBe("sk-morph-file");
    const fromEnv = resolveEndpointConfig({ ...options, env: { MOTIF_MORPHFACTORY_API_KEY: "sk-morph-env" } });
    expect(fromEnv.apiKey).toBe("sk-morph-env");
    expect(fromEnv.sources.apiKey).toBe(`environment ${ENV_MORPHFACTORY_API_KEY}`);
    const overridden = resolveEndpointConfig({ ...options, env: { MOTIF_ENDPOINT: DEFAULT_ENDPOINT } });
    expect(overridden.apiKey).toBe("sk-infron-first");
  });

  it("prefers a flag over the environment over the file", () => {
    const d = dir({ ".env": "MOTIF_ENDPOINT=http://file\nMOTIF_MODEL=file-model\n" });
    const env = { MOTIF_ENDPOINT: "http://env", MOTIF_MODEL: "env-model" };
    const paths = [join(d, ".env")];
    expect(resolveEndpointConfig({ env, dotenvPaths: paths, flags: { endpoint: "http://flag" } }).endpoint).toBe("http://flag");
    expect(resolveEndpointConfig({ env, dotenvPaths: paths }).endpoint).toBe("http://env");
    expect(resolveEndpointConfig({ env: {}, dotenvPaths: paths }).endpoint).toBe("http://file");
    expect(resolveEndpointConfig({ env: {}, dotenvPaths: paths }).model).toBe("file-model");
  });

  it("takes the first file that has the key", () => {
    const a = dir({ ".env": "MOTIF_MODEL=a-model\n" });
    const b = dir({ ".env": "MOTIF_API_KEY=sk-b\nMOTIF_MODEL=b-model\n" });
    const c = resolveEndpointConfig({ env: {}, dotenvPaths: [join(a, ".env"), join(b, ".env")] });
    expect(c.model).toBe("a-model");
    expect(c.apiKey).toBe("sk-b");
  });

  it("skips a file that is not there", () => {
    const c = resolveEndpointConfig({ env: {}, dotenvPaths: [join(tmpdir(), "does-not-exist", ".env")] });
    expect(c.endpoint).toBe(DEFAULT_ENDPOINT);
  });

  it("never writes what it read into the environment", () => {
    // Everything the agent runs inherits the environment; a key in it is one
    // `env` away from a tool result, and tool results are journalled.
    const d = dir({ ".env": "MOTIF_API_KEY=sk-secret\nOTHER_SECRET=x\n" });
    const env: NodeJS.ProcessEnv = {};
    resolveEndpointConfig({ env, dotenvPaths: [join(d, ".env")] });
    expect(env).toEqual({});
  });

  it("withholds the key from an environment children will inherit", () => {
    const env: NodeJS.ProcessEnv = { MOTIF_API_KEY: "sk-secret", MOTIF_MORPHFACTORY_API_KEY: "sk-morph-secret", PATH: "/bin" };
    withholdSecrets(env);
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("provider endpoints", () => {
  it("accepts the documented base URLs with optional /v1 and trailing slash", () => {
    for (const provider of ["infron", "morphfactory"] as const) {
      for (const suffix of ["", "/", "/v1", "/v1/"]) {
        const endpoint = `  ${PROVIDERS[provider].endpoint}${suffix}  `;
        expect(providerForEndpoint(endpoint)).toBe(provider);
        expect(apiKeyEnvForEndpoint(endpoint)).toBe(PROVIDERS[provider].apiKeyEnv);
      }
    }
    expect(providerForEndpoint("https://API-CBT.MORPHFACTORY.IO/v1")).toBe("morphfactory");
  });

  it("does not recognize lookalike hosts or custom paths as a provider", () => {
    for (const endpoint of [
      "https://api-cbt.morphfactory.io.example.com", "https://api-cbt.morphfactory.io@evil.example",
      "http://api-cbt.morphfactory.io", "https://api-cbt.morphfactory.io/proxy",
      "https://api-cbt.morphfactory.io/v1?target=other", "http://localhost:8080",
    ]) expect(providerForEndpoint(endpoint)).toBeUndefined();
  });
});

describe("writing the key", () => {
  it("replaces the key line in place and keeps the rest of the file", () => {
    const text = "# my notes\nMOTIF_ENDPOINT=https://x\nexport MOTIF_API_KEY=old\nOTHER=1\n";
    expect(upsertDotenv(text, "MOTIF_API_KEY", "sk-new")).toBe("# my notes\nMOTIF_ENDPOINT=https://x\nMOTIF_API_KEY=sk-new\nOTHER=1\n");
    expect(upsertDotenv("", "MOTIF_API_KEY", "sk-new")).toBe("MOTIF_API_KEY=sk-new\n");
    expect(upsertDotenv("A=1", "MOTIF_API_KEY", "sk-new")).toBe("A=1\nMOTIF_API_KEY=sk-new\n");
    // A commented-out line is a note, not the setting.
    expect(upsertDotenv("# MOTIF_API_KEY=commented\n", "MOTIF_API_KEY", "sk-new")).toBe("# MOTIF_API_KEY=commented\nMOTIF_API_KEY=sk-new\n");
  });

  it("quotes a value that needs it, in a form parseDotenv reads back", () => {
    const out = upsertDotenv("", "MOTIF_API_KEY", "has space#hash");
    expect(parseDotenv(out)["MOTIF_API_KEY"]).toBe("has space#hash");
  });

  it("removes only the key", () => {
    expect(removeDotenvKey("A=1\nMOTIF_API_KEY=x\nB=2\n", "MOTIF_API_KEY")).toBe("A=1\nB=2\n");
    expect(removeDotenvKey("MOTIF_API_KEY=x\n", "MOTIF_API_KEY")).toBe("");
    expect(removeDotenvKey("A=1\n", "MOTIF_API_KEY")).toBe("A=1\n");
  });

  it("saves the key to a file only its owner can read, and forgets it again", () => {
    const home = mkdtempSync(join(tmpdir(), "motif-home-"));
    const path = join(home, ".motif", ".env");
    expect(saveApiKey("sk-1", path)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("MOTIF_API_KEY=sk-1\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".motif")).mode & 0o777).toBe(0o700);
    expect(resolveEndpointConfig({ env: {}, dotenvPaths: [path] }).apiKey).toBe("sk-1");
    expect(forgetApiKey(path)).toBe(true);
    expect(forgetApiKey(path)).toBe(false);
    expect(resolveEndpointConfig({ env: {}, dotenvPaths: [path] }).apiKey).toBeUndefined();
  });

  it("saves and forgets one provider without replacing the other provider's key", () => {
    const path = join(mkdtempSync(join(tmpdir(), "motif-providers-")), ".env");
    writeFileSync(path, "# keep my settings\nOTHER=1\n");
    saveApiKey("sk-infron", path);
    saveApiKey("sk-morph", path, "morphfactory");
    expect(parseDotenv(readFileSync(path, "utf8"))).toEqual({ OTHER: "1", MOTIF_API_KEY: "sk-infron", MOTIF_MORPHFACTORY_API_KEY: "sk-morph" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(forgetApiKey(path, "morphfactory")).toBe(true);
    expect(forgetApiKey(path, "morphfactory")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("# keep my settings\nOTHER=1\nMOTIF_API_KEY=sk-infron\n");
    saveApiKey("sk-morph-new", path, "morphfactory");
    expect(forgetApiKey(path)).toBe(true);
    expect(parseDotenv(readFileSync(path, "utf8"))).toEqual({ OTHER: "1", MOTIF_MORPHFACTORY_API_KEY: "sk-morph-new" });
  });
});
