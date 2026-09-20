/**
 * Where the credential comes from, and where it must not go.
 *
 * A hosted endpoint is the first thing this harness has talked to that needs
 * a secret. The tests here are about the two ways a secret goes wrong: not
 * being found, and being found by the wrong process.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  normalizeEndpoint,
  parseDotenv,
  resolveEndpointConfig,
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
    const env: NodeJS.ProcessEnv = { MOTIF_API_KEY: "sk-secret", PATH: "/bin" };
    withholdSecrets(env);
    expect(env).toEqual({ PATH: "/bin" });
  });
});
