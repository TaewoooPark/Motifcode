/**
 * Where the credential comes from, and where it must not go.
 *
 * A hosted endpoint is the first thing this harness has talked to that needs
 * a secret. The tests here are about the two ways a secret goes wrong: not
 * being found, and being found by the wrong process.
 */

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { updatePrivateFile } from "../src/private-file.js";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  ENV_MORPHFACTORY_API_KEY,
  ENV_OPENROUTER_API_KEY,
  PROVIDERS,
  apiKeyEnvForEndpoint,
  forgetApiKey,
  normalizeEndpoint,
  parseDotenv,
  providerForEndpoint,
  removeDotenvKey,
  resolveEndpointConfig,
  saveApiKey,
  saveApiKeyWithRollback,
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
    expect(c.endpoint).toBe("https://openrouter.ai/api");
    expect(c.model).toBe("motif-technologies/motif-3");
    expect(c.apiKey).toBeUndefined();
    expect(c.sources).toEqual({ endpoint: "default", model: "default" });
  });

  it("reads the key from a .env file, and says which one", () => {
    const d = dir({ ".env": "MOTIF_API_KEY=sk-from-file\n" });
    const c = resolveEndpointConfig({ env: {}, dotenvPaths: [join(d, ".env")] });
    expect(c.endpoint).toBe(PROVIDERS.infron.endpoint);
    expect(c.model).toBe("motif/motif-3");
    expect(c.apiKey).toBe("sk-from-file");
    expect(c.sources.apiKey).toContain(join(d, ".env"));
  });

  it("selects the credential for the resolved endpoint without crossing providers", () => {
    const path = join(dir({ ".env": "MOTIF_API_KEY=sk-infron\nMOTIF_MORPHFACTORY_API_KEY=sk-morph\n" }), ".env");
    const options = { env: {}, dotenvPaths: [path] };
    expect(resolveEndpointConfig(options).apiKey).toBe("sk-infron");
    const morph = resolveEndpointConfig({ ...options, flags: { endpoint: `${PROVIDERS.morphfactory.endpoint}/v1/` } });
    expect(morph.endpoint).toBe(PROVIDERS.morphfactory.endpoint);
    expect(morph.model).toBe("motif/motif-3");
    expect(morph.apiKey).toBe("sk-morph");
    expect(morph.sources.apiKey).toBe(`${path} (${ENV_MORPHFACTORY_API_KEY})`);
    expect(providerForEndpoint("https://api-cbt.morphfactory.io:443/v1")).toBe("morphfactory");
    expect(resolveEndpointConfig({ ...options, flags: { endpoint: "https://api-cbt.morphfactory.io:443/v1" } }).apiKey).toBe("sk-morph");
    expect(resolveEndpointConfig({ ...options, flags: { endpoint: "http://localhost:8080" } }).apiKey).toBe("sk-infron");
    expect(resolveEndpointConfig({
      env: { MOTIF_API_KEY: "sk-infron" }, dotenvPaths: [], defaults: { endpoint: PROVIDERS.morphfactory.endpoint },
    }).apiKey).toBeUndefined();
  });

  it("keeps a key-only Morphfactory installation and respects an explicit endpoint", () => {
    const path = join(dir({ ".env": "MOTIF_MORPHFACTORY_API_KEY=old-morph-key\n" }), ".env");
    const options = { env: {}, dotenvPaths: [path] };
    expect(resolveEndpointConfig(options)).toMatchObject({
      endpoint: PROVIDERS.morphfactory.endpoint, model: PROVIDERS.morphfactory.model, apiKey: "old-morph-key",
    });
    expect(resolveEndpointConfig({ ...options, flags: { endpoint: PROVIDERS.openrouter.endpoint } }).apiKey).toBeUndefined();
    expect(resolveEndpointConfig({ ...options, env: { MOTIF_API_KEY: "old-infron-key" } }).endpoint).toBe(PROVIDERS.infron.endpoint);
  });

  it("keeps environment and file precedence within the Morphfactory credential slot", () => {
    const first = join(dir({ ".env": "MOTIF_API_KEY=sk-infron-first\n" }), ".env");
    const second = join(dir({ ".env": "MOTIF_MORPHFACTORY_API_KEY=sk-morph-file\n" }), ".env");
    const options = { dotenvPaths: [first, second], defaults: { endpoint: PROVIDERS.morphfactory.endpoint } };
    expect(resolveEndpointConfig({ ...options, env: {} }).apiKey).toBe("sk-morph-file");
    const fromEnv = resolveEndpointConfig({ ...options, env: { MOTIF_MORPHFACTORY_API_KEY: "sk-morph-env" } });
    expect(fromEnv.apiKey).toBe("sk-morph-env");
    expect(fromEnv.sources.apiKey).toBe(`environment ${ENV_MORPHFACTORY_API_KEY}`);
    const overridden = resolveEndpointConfig({ ...options, env: { MOTIF_ENDPOINT: PROVIDERS.infron.endpoint } });
    expect(overridden.apiKey).toBe("sk-infron-first");
  });

  it("uses the OpenRouter key from the environment or file and keeps it at the official endpoint", () => {
    const path = join(dir({ ".env": "OPENROUTER_API_KEY=sk-or-file\nMOTIF_API_KEY=sk-infron\n" }), ".env");
    const options = { env: {}, dotenvPaths: [path] };
    expect(resolveEndpointConfig(options)).toMatchObject({
      endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, apiKey: "sk-or-file", sources: { apiKey: `${path} (${ENV_OPENROUTER_API_KEY})` },
    });
    expect(resolveEndpointConfig({ ...options, env: { OPENROUTER_API_KEY: "sk-or-env" } }).apiKey).toBe("sk-or-env");
    const onlyOpenRouter = { env: { OPENROUTER_API_KEY: "sk-or-env" }, dotenvPaths: [] };
    for (const endpoint of [PROVIDERS.infron.endpoint, PROVIDERS.morphfactory.endpoint, "http://localhost:8080", "https://openrouter.ai.example/api"]) {
      const connection = resolveEndpointConfig({ ...onlyOpenRouter, defaults: { endpoint } });
      expect(connection.apiKey).toBeUndefined();
      expect(connection.model).toBe("motif/motif-3");
    }
    expect(resolveEndpointConfig({
      env: { MOTIF_API_KEY: "sk-infron" }, dotenvPaths: [], flags: { endpoint: DEFAULT_ENDPOINT },
    }).apiKey).toBeUndefined();
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

  it("translates a saved provider preset on endpoint override and preserves explicit models", () => {
    const infron = PROVIDERS.infron;
    const openRouter = PROVIDERS.openrouter;
    const previous = { endpoint: infron.endpoint, model: infron.model };
    const options = { defaults: previous, env: {}, dotenvPaths: [], flags: { endpoint: openRouter.endpoint } };
    expect(resolveEndpointConfig(options)).toMatchObject({ endpoint: openRouter.endpoint, model: openRouter.model, sources: { model: "default" } });
    expect(resolveEndpointConfig({ ...options, defaults: { ...previous, model: "my-model" } }).model).toBe("my-model");
    expect(resolveEndpointConfig({ ...options, env: { MOTIF_MODEL: infron.model } }).model).toBe(infron.model);
    expect(resolveEndpointConfig({ ...options, flags: { endpoint: openRouter.endpoint, model: infron.model } }).model).toBe(infron.model);
    expect(resolveEndpointConfig({ ...options, defaults: openRouter, flags: { endpoint: "http://localhost:8080" } }).model).toBe(infron.model);
  });

  it("translates a dotenv model only if paired with the superseded endpoint in that file", () => {
    const infron = PROVIDERS.infron;
    const openRouter = PROVIDERS.openrouter;
    const file = join(dir({ ".env": `MOTIF_ENDPOINT=${infron.endpoint}\nMOTIF_MODEL=${infron.model}\n` }), ".env");
    const options = { dotenvPaths: [file], env: { MOTIF_ENDPOINT: openRouter.endpoint } };
    expect(resolveEndpointConfig(options).model).toBe(openRouter.model);
    writeFileSync(file, `MOTIF_MODEL=${infron.model}\n`);
    expect(resolveEndpointConfig(options).model).toBe(infron.model);
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
    const env: NodeJS.ProcessEnv = { MOTIF_API_KEY: "sk-secret", MOTIF_MORPHFACTORY_API_KEY: "sk-morph-secret", OPENROUTER_API_KEY: "sk-or-secret", PATH: "/bin" };
    withholdSecrets(env);
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("provider endpoints", () => {
  it("accepts the documented base URLs with optional /v1 and trailing slash", () => {
    for (const provider of ["openrouter", "infron", "morphfactory"] as const) {
      for (const suffix of ["", "/", "/v1", "/v1/"]) {
        const endpoint = `  ${PROVIDERS[provider].endpoint}${suffix}  `;
        expect(providerForEndpoint(endpoint)).toBe(provider);
        expect(apiKeyEnvForEndpoint(endpoint)).toBe(PROVIDERS[provider].apiKeyEnv);
      }
    }
    expect(providerForEndpoint("https://API-CBT.MORPHFACTORY.IO/v1")).toBe("morphfactory");
    expect(providerForEndpoint("https://OPENROUTER.AI:443/api/v1")).toBe("openrouter");
  });

  it("does not recognize lookalike hosts or custom paths as a provider", () => {
    for (const endpoint of [
      "https://api-cbt.morphfactory.io.example.com", "https://api-cbt.morphfactory.io@evil.example",
      "http://api-cbt.morphfactory.io", "https://api-cbt.morphfactory.io/proxy",
      "https://api-cbt.morphfactory.io/v1?target=other", "http://localhost:8080",
      "https://openrouter.ai.evil.example/api", "https://openrouter.ai@evil.example/api",
      "https://other@openrouter.ai/api", "http://openrouter.ai/api", "https://openrouter.ai/v1",
      "https://openrouter.ai/api/custom", "https://openrouter.ai/api/v1?other=1",
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

  it("updates duplicate provider assignments once and preserves unrelated bytes", () => {
    const before = "# note\r\nOTHER=7\r\nexport OPENROUTER_API_KEY=old\r\n# keep\r\nOPENROUTER_API_KEY=stale\r\nTAIL=unchanged";
    const after = upsertDotenv(before, "OPENROUTER_API_KEY", "new");
    expect(after).toBe("# note\r\nOTHER=7\r\nOPENROUTER_API_KEY=new\r\n# keep\r\nTAIL=unchanged");
    expect(parseDotenv(after)["OPENROUTER_API_KEY"]).toBe("new");
    expect(removeDotenvKey(before, "MOTIF_API_KEY")).toBe(before);
  });

  it("undoes a candidate only while it is still current and only in its own provider slot", () => {
    const path = join(mkdtempSync(join(tmpdir(), "motif-rollback-")), ".env");
    const undoNew = saveApiKeyWithRollback("first", path, "openrouter");
    saveApiKey("keep", path, "infron");
    expect(undoNew()).toBe(true);
    expect(parseDotenv(readFileSync(path, "utf8"))).toEqual({ MOTIF_API_KEY: "keep" });
    saveApiKey("prior", path, "openrouter");
    const undoReplacement = saveApiKeyWithRollback("candidate", path, "openrouter");
    expect(undoReplacement()).toBe(true);
    expect(parseDotenv(readFileSync(path, "utf8")).OPENROUTER_API_KEY).toBe("prior");
    const staleUndo = saveApiKeyWithRollback("candidate", path, "openrouter");
    saveApiKey("newer", path, "openrouter");
    expect(staleUndo()).toBe(false);
    expect(parseDotenv(readFileSync(path, "utf8"))).toEqual({ MOTIF_API_KEY: "keep", OPENROUTER_API_KEY: "newer" });
  });

  it("rejects overlapping updates and cleans a marker from an exited writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "motif-writer-"));
    const path = join(dir, ".env");
    const stoppedPid = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(join(dir, "..env.motif-write-" + stoppedPid + "-" + randomUUID()), "");
    updatePrivateFile(path, () => {
      expect(() => saveApiKey("other-fixture", path, "openrouter")).toThrow("Another Motif process");
      return "OTHER=1\n";
    });
    saveApiKey("retry-fixture", path, "openrouter");
    expect(parseDotenv(readFileSync(path, "utf8"))).toEqual({ OTHER: "1", OPENROUTER_API_KEY: "retry-fixture" });
    expect(readdirSync(dir)).toEqual([".env"]);
  });

  it.skipIf(process.platform === "win32")("tightens an unchanged saved key and leaves an absent-key forget untouched", () => {
    const path = join(mkdtempSync(join(tmpdir(), "motif-mode-")), ".env");
    writeFileSync(path, "MOTIF_API_KEY=fixture\n");
    chmodSync(path, 0o644);
    expect(forgetApiKey(path, "openrouter")).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    saveApiKey("fixture", path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform !== "win32")("creates a private DACL and preserves explicit ACLs on save and forget", () => {
    const path = join(mkdtempSync(join(tmpdir(), "motif-dacl-")), ".env");
    const ps = (script: string): string => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, MOTIF_FIXTURE: path }, encoding: "utf8", windowsHide: true,
    }).trim();
    const describe = [
      "$a=[IO.File]::GetAccessControl($env:MOTIF_FIXTURE);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$a.AreAccessRulesProtected",
      "$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {",
      "  if ($_.IdentityReference -eq $user) {$who='user'} else {$who=$_.IdentityReference.Value}",
      "  $who + '/' + $_.FileSystemRights + '/' + $_.AccessControlType + '/' + $_.IsInherited",
      "}",
    ].join("\n");
    saveApiKey("fixture", path);
    expect(ps(describe).split(/\r?\n/)).toEqual(["True", "user/FullControl/Allow/False"]);
    ps([
      "$a=[IO.File]::GetAccessControl($env:MOTIF_FIXTURE)",
      "$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
      "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,'Read','Allow'))",
      "[IO.File]::SetAccessControl($env:MOTIF_FIXTURE,$a)",
    ].join("\n"));
    const before = ps(describe);
    expect(before).toContain("S-1-5-18/");
    saveApiKey("other-fixture", path, "openrouter");
    expect(ps(describe)).toBe(before);
    expect(forgetApiKey(path, "openrouter")).toBe(true);
    expect(ps(describe)).toBe(before);
    expect(parseDotenv(readFileSync(path, "utf8"))).toEqual({ MOTIF_API_KEY: "fixture" });
  });

  it.skipIf(process.platform !== "win32")("preserves the file and cleans up staging after a failed replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motif-sharing-"));
    const path = join(dir, ".env");
    const original = "MOTIF_API_KEY=fixture\nOTHER=retain\n";
    writeFileSync(path, original);
    const lock = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      "$ErrorActionPreference='Stop'",
      "$f=[IO.File]::Open($env:MOTIF_FIXTURE,'Open','Read','Read')",
      "try { [Console]::WriteLine('ready'); [void][Console]::ReadLine() } finally { $f.Dispose() }",
    ].join("\n")], { env: { ...process.env, MOTIF_FIXTURE: path }, windowsHide: true });
    const closed = once(lock, "close");
    try {
      const [ready] = await Promise.race([once(lock.stdout, "data"), closed]);
      expect(String(ready).trim()).toBe("ready");
      expect(() => saveApiKey("new-fixture", path)).toThrow();
      expect(() => forgetApiKey(path)).toThrow();
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(dir)).toEqual([".env"]);
    } finally {
      lock.stdin.end("\n");
      await closed;
    }
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
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect(statSync(join(home, ".motif")).mode & 0o777).toBe(0o700);
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
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(forgetApiKey(path, "morphfactory")).toBe(true);
    expect(forgetApiKey(path, "morphfactory")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("# keep my settings\nOTHER=1\nMOTIF_API_KEY=sk-infron\n");
    saveApiKey("sk-morph-new", path, "morphfactory");
    saveApiKey("sk-or-user", path, "openrouter");
    expect(forgetApiKey(path)).toBe(true);
    expect(resolveEndpointConfig({ env: {}, dotenvPaths: [path] }).apiKey).toBe("sk-or-user");
    expect(forgetApiKey(path, "openrouter")).toBe(true);
    expect(parseDotenv(readFileSync(path, "utf8"))).toEqual({ OTHER: "1", MOTIF_MORPHFACTORY_API_KEY: "sk-morph-new" });
  });
});
