/** Exercise the dashboard through the same raw keys and persistence path as an interactive session. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry, BUILTIN_AGENTS } from "@motifcode/agents";
import { TransportError, type CompletionRequest, type CompletionResponse, type Transport } from "@motifcode/core";
import { DEFAULT_HOOKS } from "@motifcode/hooks";
import { doneBody } from "@motifcode/replay";
import { BUILTIN_SKILLS, SkillRegistry } from "@motifcode/skills";
import { CORE_TOOLS, toolPrefix } from "@motifcode/tools";
import { Screen, applyTheme, type ComposerView } from "@motifcode/tui";
import { Chat, type ChatOptions } from "../src/chat.js";
import { saveUserSetting, saveUserSettings, userSettingsPath, type StoredSettings } from "../src/settings.js";

const ESC = "\x1b";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const SHIFT_TAB = "\x1b[Z";
const CLEAR = "\x15";

class FakeTTY extends PassThrough {
  isTTY = true;
  setRawMode(): this { return this; }
}

class DashboardTransport implements Transport {
  readonly endpoint = "fake://dashboard";
  readonly model = "fake";
  readonly seen: CompletionRequest[] = [];
  gated = false;
  response = doneBody("done");
  private release: (() => void) | undefined;

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(req);
    if (this.gated) {
      this.gated = false;
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        req.signal?.addEventListener("abort", () => reject(new TransportError("aborted", { kind: "aborted" })), { once: true });
      });
    }
    const content = this.response;
    return { content, rawText: content, ms: 1, usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 80 } };
  }

  open(): void { this.release?.(); }
}

const sessions: { type: (value: string) => void; finished: Promise<number>; cwd: string }[] = [];
function session(extra: Partial<ChatOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "motif-dashboard-"));
  const out: string[] = [];
  const stdin = new FakeTTY();
  const transport = new DashboardTransport();
  const skills = new SkillRegistry();
  skills.registerAll(BUILTIN_SKILLS);
  const agents = new AgentRegistry();
  agents.registerAll(BUILTIN_AGENTS);
  const terminal = new Screen({ write: (text) => out.push(text), columns: () => 100, rows: () => 30, interactive: true, cwd });
  const persist = vi.fn((key: keyof StoredSettings, value: unknown) => saveUserSetting(key, value as StoredSettings[typeof key], cwd));
  const makeTransport = vi.fn((_settings: ChatOptions["settings"], _apiKey?: string) => transport);
  const chat = new Chat({
    screen: terminal,
    stdin: stdin as unknown as NodeJS.ReadStream,
    settings: { model: "motif/motif-3", endpoint: "https://llm.onerouter.pro", channel: "toolcall", maxTurns: 20, cwd, theme: "motif", compactAt: 0.75, permissions: "auto" },
    channelPolicy: "fixed",
    skills, agents, hooks: DEFAULT_HOOKS, tools: toolPrefix(CORE_TOOLS.length - 1),
    journalDir: join(cwd, ".motif", "sessions"), version: "test", hero: false,
    envPath: join(cwd, ".motif", ".env"),
    balanceFetch: async () => new Response(JSON.stringify({ credit_balance: 0 })),
    persist, persistConnection: (endpoint, model) => saveUserSettings({ endpoint, model }, cwd), makeTransport, ...extra,
  });
  const compose = vi.spyOn(terminal, "setComposer");
  const finished = chat.run();
  const type = (value: string): void => { stdin.write(value); };
  const current = (): ComposerView => compose.mock.calls.at(-1)![0]!;
  const panel = () => {
    const value = current().panel;
    if (!value || typeof value === "function") throw new Error("Expected the settings dashboard");
    return value;
  };
  const value = (label: string) => panel().rows.find((row) => row.label === label)?.value;
  const saved = (): StoredSettings => JSON.parse(readFileSync(userSettingsPath(cwd), "utf8")) as StoredSettings;
  const screen = () => out.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  sessions.push({ type, finished, cwd });
  return { chat, type, current, panel, value, saved, screen, terminal, transport, persist, makeTransport, cwd };
}

afterEach(async () => {
  for (const s of sessions) {
    for (let i = 0; i < 4; i++) s.type(ESC);
    s.type("\x04");
    await s.finished;
    rmSync(s.cwd, { recursive: true, force: true });
  }
  sessions.length = 0;
  applyTheme("motif");
});

describe("interactive settings dashboard", () => {
  it("opens /config without a model request, toggles real display settings, and persists both boolean values", () => {
    const s = session();
    s.type("/config\r");
    expect(s.panel()).toMatchObject({ activeTab: 0, selected: 0 });
    expect(s.value("Show reasoning")).toBe("false");
    s.type("\r");
    expect(s.terminal.thinkingShown).toBe(true);
    expect(s.saved().thinking).toBe(true);
    expect(s.panel().rows[0]!.detail).toContain("session + user file");
    s.type(DOWN + RIGHT);
    expect(s.terminal.verboseOutput).toBe(true);
    expect(s.saved().verbose).toBe(true);
    s.type(LEFT);
    expect(s.terminal.verboseOutput).toBe(false);
    expect(s.saved().verbose).toBe(false);
    s.type(ESC);
    expect(s.current().panel).toBeUndefined();
    expect(s.transport.seen).toHaveLength(0);
    expect(s.makeTransport).not.toHaveBeenCalled();
  });

  it("keeps an invalid numeric edit open and cancels it without applying or saving", () => {
    const s = session();
    s.type("/config\r" + DOWN.repeat(6) + "\r");
    expect(s.panel().editing).toMatchObject({ label: "Max turns / task", draft: { text: "20" } });
    s.type(CLEAR + "0\r");
    expect(s.panel().error).toBe(true);
    expect(s.panel().editing?.draft.text).toBe("0");
    expect(s.value("Max turns / task")).toBe("20");
    expect(s.persist).not.toHaveBeenCalled();
    s.type(ESC);
    expect(s.panel().editing).toBeUndefined();
    expect(s.value("Max turns / task")).toBe("20");
    s.type("\r" + CLEAR + "40");
    s.type(ESC);
    expect(s.value("Max turns / task")).toBe("20");
    expect(s.persist).not.toHaveBeenCalled();
    expect(s.transport.seen).toHaveLength(0);
  });

  it("saves a numeric edit and applies it to the next request", async () => {
    const s = session();
    s.type("/config\r" + DOWN.repeat(7) + "\r" + CLEAR + "512\r");
    expect(s.panel().editing).toBeUndefined();
    expect(s.value("Max output tokens")).toBe("512");
    expect(s.saved().maxOutputTokens).toBe(512);
    s.type(ESC);
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.transport.seen[0]!.maxTokens).toBe(512);
  });

  it("leaves runtime values unchanged when persistence fails", () => {
    const persist = vi.fn(() => { throw new Error("settings path is read-only"); });
    const s = session({ persist });
    s.type("/config\r\r");
    expect(s.panel().error).toBe(true);
    expect(s.panel().message).toBe("settings path is read-only");
    expect(s.terminal.thinkingShown).toBe(false);
    expect(s.value("Show reasoning")).toBe("false");
    expect(s.panel().rows[0]!.detail).toContain("Source: default");
    s.type(DOWN.repeat(3) + "\r" + CLEAR + "other/model\r");
    expect(s.value("Model")).toBe("motif/motif-3");
    expect(s.panel().editing?.draft.text).toBe("other/model");
    expect(s.panel().error).toBe(true);
  });

  it("supports direct values, zero seed, removing output caps, and rejects invalid values before saving", async () => {
    const s = session();
    s.type("/config model other/model\r");
    await vi.waitFor(() => expect(s.screen()).toContain("model = other/model"));
    s.type("/config seed 0\r");
    await vi.waitFor(() => expect(s.screen()).toContain("seed = 0"));
    s.type("/config max-tokens 123\r");
    await vi.waitFor(() => expect(s.saved().maxOutputTokens).toBe(123));
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls[0]![0].model).toBe("other/model");
    expect(s.transport.seen[0]).toMatchObject({ seed: 0, maxTokens: 123 });
    s.type("/config seed -1\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Enter an integer >= 0"));
    expect(s.saved().seed).toBe(0);
    expect(s.persist).not.toHaveBeenCalledWith("seed", -1);
    s.type("/config max-tokens off\r");
    await vi.waitFor(() => expect(s.saved().maxOutputTokens).toBeUndefined());
    s.type("again\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    expect(s.transport.seen[1]!.maxTokens).toBeUndefined();
    expect(s.transport.seen[1]!.seed).toBe(0);
  });

  it("allows display changes while a task is running but blocks changes to its execution settings", async () => {
    const s = session();
    s.transport.gated = true;
    s.type("go\r");
    await vi.waitFor(() => expect(s.transport.seen).toHaveLength(1));
    s.type("/config\r");
    expect(s.panel().activeTab).toBe(0);
    s.type("\r");
    expect(s.terminal.thinkingShown).toBe(true);
    s.type(DOWN.repeat(2) + "\r");
    expect(s.panel().error).toBe(true);
    expect(s.panel().message).toContain("Wait for the running task");
    expect(s.value("Tool permissions")).toBe("auto");
    expect(s.persist).not.toHaveBeenCalledWith("permissions", expect.anything());
    s.type(ESC);
    expect(s.chat.running).toBe(true);
    s.transport.open();
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
  });

  it("cycles all tabs and refreshes local statistics without sending model requests", async () => {
    const s = session();
    s.type("/config\r\t");
    expect(s.panel().activeTab).toBe(1);
    expect(s.value("State")).toBe("Ready");
    s.type("\t");
    expect(s.panel().activeTab).toBe(2);
    expect(s.value("Saved runs")).toBe("0");
    s.type("r\t");
    expect(s.panel().activeTab).toBe(3);
    expect(s.value("Infron balance")).toBe("Sign in with /login");
    s.type("r\t");
    expect(s.panel().activeTab).toBe(0);
    s.type(SHIFT_TAB);
    expect(s.panel().activeTab).toBe(3);
    s.type(LEFT);
    expect(s.panel().activeTab).toBe(2);
    s.type(ESC);
    expect(s.transport.seen).toHaveLength(0);
    expect(s.persist).not.toHaveBeenCalled();
    for (const [command, tab] of [["status", 1], ["stats", 2], ["usage", 3]] as const) {
      s.type(`/${command}\r`);
      expect(s.panel().activeTab).toBe(tab);
      s.type(ESC);
    }
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    s.type("/stats\r");
    expect(s.value("Saved runs")).toBe("1");
    expect(s.value("Completed")).toBe("1");
    s.type("\t");
    expect(s.value("Prompt tokens")).toBe("100");
    expect(s.value("Completion tokens")).toBe("10");
    expect(s.value("Cached prompt tokens")).toBe("80");
    expect(s.value("Cache ratio")).toBe("80.0%");
    expect(s.transport.seen).toHaveLength(1);
  });

  it("preserves the conversation when a channel change is attempted during manual compaction", async () => {
    const s = session();
    s.type("keep this task\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    const before = [...s.chat.transcript];
    s.transport.gated = true;
    s.transport.response = "</think>HANDOFF: the original task is complete";
    s.type("/compact\r");
    try {
      await vi.waitFor(() => expect(s.transport.seen).toHaveLength(2));
      expect(String(s.transport.seen[1]!.messages.at(-1)!.content)).toContain("CONTEXT CHECKPOINT COMPACTION");
      s.type("/config channel raw\r");
      await vi.waitFor(() => expect(s.screen()).toContain("Wait for the running task to finish"));
      expect(s.persist).not.toHaveBeenCalled();
      expect(s.chat.transcript).toEqual(before);
      s.type("/status\r");
      expect(s.value("State")).toBe("Compacting");
      expect(s.value("Channel / policy")).toBe("toolcall / fixed");
    } finally {
      s.transport.open();
    }
    await vi.waitFor(() => expect(s.screen()).toContain("Context compacted"));
    expect(s.chat.transcript[0]!.content).toBe("keep this task");
    expect(s.chat.transcript.at(-1)!.content).toContain("HANDOFF: the original task is complete");
    expect(s.value("State")).toBe("Ready");
    s.type(ESC);
    s.type("/config channel raw\r");
    await vi.waitFor(() => expect(s.saved().channel).toBe("raw"));
    expect(s.chat.transcript).toEqual([]);
    expect(s.transport.seen).toHaveLength(2);
  });

  it("refreshes statistics for an in-flight task after the task completes", async () => {
    const s = session();
    s.transport.gated = true;
    s.type("go\r");
    await vi.waitFor(() => expect(s.transport.seen).toHaveLength(1));
    s.type("/stats\r");
    expect(s.value("Active")).toBe("1");
    expect(s.value("Completed")).toBe("0");
    s.transport.open();
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    s.type("r");
    expect(s.value("Active")).toBe("0");
    expect(s.value("Completed")).toBe("1");
    expect(s.transport.seen).toHaveLength(1);
  });
});

describe("account balance integration", () => {
  it.each(["/logout", "/endpoint http://127.0.0.1:9000"])("does not reactivate a key after %s invalidates an in-flight login", async (command) => {
    let completeVerification!: (result: { ok: true }) => void;
    const verification = new Promise<{ ok: true }>((resolve) => { completeVerification = resolve; });
    const verifyKey = vi.fn(() => verification);
    const balanceFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ credit_balance: 77 })));
    const s = session({ requireKey: true, verifyKey, balanceFetch });
    s.type("fixture-pending-key\r");
    await vi.waitFor(() => expect(verifyKey).toHaveBeenCalledWith("fixture-pending-key"));
    s.type(`${command}\r`);
    await vi.waitFor(() => expect(s.screen()).toContain(command === "/logout" ? "no key is set" : "endpoint set to http://127.0.0.1:9000"));
    completeVerification({ ok: true });
    // Drain the verifier and its awaiting login continuation before checking state.
    await new Promise<void>((resolve) => setImmediate(resolve));
    s.type("/status\r");
    expect(s.value("Authentication")).toBe("No API key · /login");
    expect(existsSync(join(s.cwd, ".motif", ".env"))).toBe(false);
    expect(balanceFetch).not.toHaveBeenCalled();
    expect(s.screen()).not.toContain("fixture-pending-key");
    s.type("\t\t");
    expect(s.value(command === "/logout" ? "Infron balance" : "Account balance"))
      .toBe(command === "/logout" ? "Sign in with /login" : "Not supported for this endpoint");
  });

  it("automatically queries a loaded API key and shows its account balance separately from local usage", async () => {
    const balanceFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ credit_balance: 12.5 })));
    const verifyKey = vi.fn(async () => ({ ok: true as const }));
    const s = session({ apiKey: "fixture-loaded-key", balanceFetch, verifyKey });
    await vi.waitFor(() => expect(balanceFetch).toHaveBeenCalledTimes(1));
    expect(balanceFetch.mock.calls[0]).toEqual(["https://api.onerouter.pro/v1/balance", {
      method: "GET", headers: { Authorization: "Bearer fixture-loaded-key", Accept: "application/json" },
      redirect: "error", signal: expect.any(AbortSignal),
    }]);
    s.type("/usage\r");
    await vi.waitFor(() => expect(s.value("Infron balance")).toBe("12.5 credits"));
    expect(s.value("Prompt tokens")).toBe("Not reported");
    expect(s.value("Balance checked")).toBeDefined();
    expect(s.panel().rows.find((row) => row.label === "Infron balance")?.detail).toContain("Account-wide");
    expect(s.panel().rows.find((row) => row.label === "Infron balance")?.detail).toContain("local recorded task costs");
    s.type(SHIFT_TAB + SHIFT_TAB);
    expect(s.value("Authentication")).toBe("API key loaded");
    expect(verifyKey).not.toHaveBeenCalled();
    expect(s.transport.seen).toHaveLength(0);
    expect(s.screen()).not.toContain("fixture-loaded-key");
  });

  it("removes the account balance on logout, including an in-flight refresh from the previous key", async () => {
    let now = 100_000;
    let finishRefresh!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishRefresh = resolve; });
    const balanceFetch = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ credit_balance: 99 })))
      .mockImplementationOnce(() => pending);
    const s = session({ apiKey: "fixture-old-key", balanceFetch, now: () => now });
    s.type("/usage\r");
    await vi.waitFor(() => expect(s.value("Infron balance")).toBe("99 credits"));
    now += 5_000;
    s.type("r");
    await vi.waitFor(() => expect(balanceFetch).toHaveBeenCalledTimes(2));
    expect(s.value("Infron balance")).toBe("99 credits (last known)");
    s.type(ESC);
    s.type("/logout\r");
    await vi.waitFor(() => expect(s.screen()).toContain("the session no longer sends a key"));
    expect(balanceFetch.mock.calls[1]![1]?.signal?.aborted).toBe(true);
    s.type("/usage\r");
    expect(s.value("Infron balance")).toBe("Sign in with /login");
    finishRefresh(new Response(JSON.stringify({ credit_balance: 88 })));
    await Promise.resolve();
    await Promise.resolve();
    s.type("r");
    expect(s.value("Infron balance")).toBe("Sign in with /login");
    expect(s.value("Balance checked")).toBeUndefined();
    expect(balanceFetch).toHaveBeenCalledTimes(2);
  });

  it("stops account requests and clears the displayed balance when the endpoint changes inside /config", async () => {
    const balanceFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ credit_balance: 15 })));
    const s = session({ apiKey: "fixture-key", balanceFetch });
    s.type("/usage\r");
    await vi.waitFor(() => expect(s.value("Infron balance")).toBe("15 credits"));
    s.type(ESC);
    s.type("/config\r" + DOWN.repeat(4) + "\r" + CLEAR + "http://127.0.0.1:9000\r");
    expect(s.value("Endpoint")).toBe("http://127.0.0.1:9000");
    expect(s.saved().endpoint).toBe("http://127.0.0.1:9000");
    s.type(SHIFT_TAB);
    expect(s.value("Account balance")).toBe("Not supported for this endpoint");
    expect(s.value("Infron balance")).toBeUndefined();
    expect(s.value("Balance checked")).toBeUndefined();
    s.type("r");
    expect(balanceFetch).toHaveBeenCalledTimes(1);
    s.type(ESC);
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls[0]![0].endpoint).toBe("http://127.0.0.1:9000");
    expect(balanceFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps model tasks working when the balance service fails and displays a sanitized error", async () => {
    const balanceFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("fixture-sensitive-key from server"));
    const s = session({ apiKey: "fixture-sensitive-key", balanceFetch });
    s.type("/usage\r");
    await vi.waitFor(() => expect(s.value("Balance status")).toBe("Could not reach the balance service."));
    expect(s.value("Infron balance")).toBe("Could not refresh");
    expect(s.screen()).not.toContain("fixture-sensitive-key");
    s.type(ESC);
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.transport.seen).toHaveLength(1);
    s.type("/usage\r");
    expect(s.value("Completion tokens")).toBe("10");
    expect(s.value("Balance status")).toBe("Could not reach the balance service.");
  });
});

describe("provider selection", () => {
  const openRouter = "https://openrouter.ai/api";
  const morph = "https://api-cbt.morphfactory.io";
  const infron = "https://llm.onerouter.pro";

  it("offers a first-run choice, masks the selected provider key and persists the connection", async () => {
    const verifyKey = vi.fn(async () => ({ ok: true as const }));
    const s = session({ chooseProvider: true, requireKey: true, verifyKey });
    expect(s.screen()).toContain("Choose a provider");
    expect(s.screen()).toContain("1. OpenRouter");
    expect(s.screen()).toContain("2. Infron");
    expect(s.screen()).toContain("3. Morphfactory (BETA)");
    s.type("3");
    await vi.waitFor(() => expect(s.screen()).toContain("Paste your Morphfactory (BETA) API key to get started"));
    expect(s.screen()).toContain("https://cbt.morphfactory.io/console?view=keys");
    s.type("mak-first\r");
    await vi.waitFor(() => expect(s.screen()).toContain("signed in"));
    expect(s.screen()).not.toContain("mak-first");
    expect(s.saved()).toMatchObject({ endpoint: morph, model: "motif/motif-3" });
    expect(readFileSync(join(s.cwd, ".motif", ".env"), "utf8")).toBe("MOTIF_MORPHFACTORY_API_KEY=mak-first\n");
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: morph }), "mak-first"]);
  });

  it("selects OpenRouter by pressing Enter and stores its key in the dedicated slot", async () => {
    const verifyKey = vi.fn(async () => ({ ok: true as const }));
    const s = session({ chooseProvider: true, requireKey: true, verifyKey });
    s.type("\r");
    await vi.waitFor(() => expect(s.current().secret?.title).toContain("OpenRouter"));
    s.type("MOTIF_API_KEY=legacy-secret\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Use OPENROUTER_API_KEY"));
    expect(verifyKey).not.toHaveBeenCalled();
    expect(s.screen()).not.toContain("legacy-secret");
    s.type("OPENROUTER_API_KEY=or-dummy\r");
    await vi.waitFor(() => expect(s.screen()).toContain("signed in"));
    expect(s.saved()).toMatchObject({ endpoint: openRouter, model: "motif-technologies/motif-3" });
    expect(readFileSync(join(s.cwd, ".motif", ".env"), "utf8")).toBe("OPENROUTER_API_KEY=or-dummy\n");
    expect(s.screen()).not.toContain("or-dummy");
  });

  it("round-trips separate keys through /provider, /config and /endpoint without crossing credentials", async () => {
    const s = session({ apiKey: "infron-key", requireKey: true, providerCredentials: { morphfactory: { apiKey: "morph-key", source: "test" }, openrouter: { apiKey: "or-key" } } });
    expect(s.screen()).not.toContain("Choose a provider");
    const run = async (command: string, endpoint: string, key: string | undefined, task: number) => {
      s.type(command + "\r");
      await vi.waitFor(() => expect(s.screen()).toContain(command.startsWith("/endpoint") ? "endpoint set" : "Provider:"));
      s.type("go\r");
      await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(task));
      // ChatSettings is mutable; assert each request before the next switch.
      expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint }), key]);
    };
    await run("/provider morphfactory", morph, "morph-key", 1);
    await run("/config provider infron", infron, "infron-key", 2);
    await run("/endpoint " + morph + "/v1", morph, "morph-key", 3);
    await run("/provider infron", infron, "infron-key", 4);
    await run("/config endpoint " + morph, morph, "morph-key", 5);
    await run("/provider infron", infron, "infron-key", 6);
    await run("/config endpoint " + openRouter + "/v1", openRouter, "or-key", 7);
    expect(s.saved().model).toBe("motif-technologies/motif-3");
    await run("/endpoint http://127.0.0.1:9999", "http://127.0.0.1:9999", "infron-key", 8);
    expect(s.saved().model).toBe("motif/motif-3");
    await run("/provider openrouter", openRouter, "or-key", 9);
  });

  it("preserves an explicit model when changing endpoint by hand", async () => {
    const s = session({ explicitModel: "motif/motif-3", apiKey: "infron-key", providerCredentials: { openrouter: { apiKey: "or-key" } } });
    s.type(`/endpoint ${openRouter}\r`);
    await vi.waitFor(() => expect(s.saved().endpoint).toBe(openRouter));
    s.type("/config\r");
    expect(s.value("Model")).toBe("motif/motif-3");
    s.type(ESC);
    s.type("/config model local-model\r");
    s.type(`/config endpoint ${infron}\r`);
    await vi.waitFor(() => expect(s.saved()).toMatchObject({ endpoint: infron, model: "local-model" }));
  });

  it("keeps endpoint and credentials together when multiple commands arrive in one input event", async () => {
    const s = session({ apiKey: "infron-key", requireKey: true, providerCredentials: { morphfactory: { apiKey: "morph-key" } } });
    s.type(`/endpoint ${morph}\r/provider infron\r/provider morphfactory\rgo\r`);
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: morph }), "morph-key"]);
    s.type("/provider infron\rgo\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: infron }), "infron-key"]);
  });

  it("does not verify a submitted key against a provider selected in the same input event", async () => {
    const verifyKey = vi.fn(async () => ({ ok: true as const }));
    const s = session({ apiKey: "infron-key", requireKey: true, verifyKey, providerCredentials: { morphfactory: { apiKey: "morph-key" } } });
    s.type("/login\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Paste your Infron API key"));
    s.type("infron-new\r/provider morphfactory\r");
    await vi.waitFor(() => expect(s.screen()).toContain("login cancelled because the session or endpoint changed"));
    expect(verifyKey).not.toHaveBeenCalled();
    expect(existsSync(join(s.cwd, ".motif", ".env"))).toBe(false);
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: morph }), "morph-key"]);
  });

  it.each(["/provider openrouter", "/config provider openrouter", "/endpoint " + openRouter, "/config endpoint " + openRouter])(
    "%s preserves the old session and defaults after a rejected key and Escape", async command => {
      const verifyKey = vi.fn(async () => ({ ok: false as const, reason: "401 Unauthorized" }));
      const s = session({ apiKey: "infron-key", requireKey: true, verifyKey });
      saveUserSettings({ endpoint: infron, model: "motif/motif-3", maxTurns: 27 }, s.cwd);
      s.type(command + "\r");
      expect(s.current().secret?.title).toContain("OpenRouter");
      s.type("\x1b[200~OPENROUTER_API_KEY=or-invalid\n\x1b[201~\r");
      await vi.waitFor(() => expect(s.screen()).toContain("401 Unauthorized"));
      s.type(ESC);
      await vi.waitFor(() => expect(s.screen()).toContain("login cancelled"));
      expect(s.saved()).toMatchObject({ endpoint: infron, model: "motif/motif-3", maxTurns: 27 });
      expect(s.screen()).not.toContain("or-invalid");
      expect(existsSync(join(s.cwd, ".motif", ".env"))).toBe(false);
      s.type("continue\r");
      await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
      expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: infron }), "infron-key"]);
    },
  );

  it("ignores a late key verification after a second provider is selected", async () => {
    let accept!: (value: { ok: true }) => void;
    const verifyKey = vi.fn(() => new Promise<{ ok: true }>(resolve => { accept = resolve; }));
    const s = session({ apiKey: "infron-key", requireKey: true, verifyKey, providerCredentials: { morphfactory: { apiKey: "morph-key" } } });
    s.type("/provider\r");
    expect(s.screen()).toContain("Infron (current)");
    s.type("\r");
    await vi.waitFor(() => expect(s.current().panel).toBeUndefined());
    // Key and selection delivered together. Only the masked input sees the key.
    s.type("/provider\r1or-pending\r");
    await vi.waitFor(() => expect(verifyKey).toHaveBeenCalledWith("or-pending"));
    s.type("unverified task\r");
    expect(s.makeTransport).not.toHaveBeenCalled();
    s.type("/endpoint " + morph + "\r");
    await vi.waitFor(() => expect(s.saved().endpoint).toBe(morph));
    accept({ ok: true });
    await vi.waitFor(() => expect(s.screen()).toContain("login cancelled because"));
    expect(s.screen()).not.toContain("or-pending");
    expect(existsSync(join(s.cwd, ".motif", ".env"))).toBe(false);
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: morph }), "morph-key"]);
  });

  it("verifies the candidate on its official endpoint before switching from the Config panel", async () => {
    const verify = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: {} }));
    const s = session({ apiKey: "infron-key", settingSources: { endpoint: "/trusted/.env (MOTIF_ENDPOINT)", model: "environment MOTIF_MODEL" } });
    try {
      s.type("/config\r");
      const row = s.panel().rows.findIndex(r => r.label === "Provider");
      s.type(DOWN.repeat(row) + LEFT);
      expect(s.current().secret?.title).toContain("OpenRouter");
      expect(existsSync(userSettingsPath(s.cwd))).toBe(false);
      s.type("\x1b[200~OPENROUTER_API_KEY=or-saved\n\x1b[201~\r");
      await vi.waitFor(() => expect(s.saved()).toMatchObject({ endpoint: openRouter, model: "motif-technologies/motif-3" }));
      expect(verify).toHaveBeenCalledWith(openRouter + "/v1/key", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer or-saved" }) }));
      expect(s.panel().message).toContain("/trusted/.env (MOTIF_ENDPOINT)");
      expect(s.panel().message).toContain("environment MOTIF_MODEL");
      expect(s.panel().message).toContain("/config show");
      expect(s.screen()).not.toContain("or-saved");
      s.type(ESC + "go\r");
      await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
      expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: openRouter }), "or-saved"]);
    } finally { verify.mockRestore(); }
  });

  it("restores only the candidate key when writing provider defaults fails", async () => {
    const s = session({
      apiKey: "infron-key", requireKey: true, verifyKey: async () => ({ ok: true }),
      persistConnection: () => {
        const env = join(s.cwd, ".motif", ".env");
        writeFileSync(env, readFileSync(env, "utf8") + "OTHER_APP_KEY=concurrent\n");
        throw new Error("settings read-only");
      },
    });
    saveUserSettings({ endpoint: infron, model: "motif/motif-3" }, s.cwd);
    const env = join(s.cwd, ".motif", ".env");
    writeFileSync(env, "MOTIF_API_KEY=existing\nOPENROUTER_API_KEY=previous\n");
    s.type("/provider openrouter\ror-candidate\r");
    await vi.waitFor(() => expect(s.screen()).toContain("settings read-only"));
    expect(readFileSync(env, "utf8")).toBe("MOTIF_API_KEY=existing\nOPENROUTER_API_KEY=previous\nOTHER_APP_KEY=concurrent\n");
    expect(s.saved().endpoint).toBe(infron);
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls.at(-1)?.[1]).toBe("infron-key");
  });

  it("treats Escape from either picker as a normal cancellation and does not start an initial task", async () => {
    const startup = session({ chooseProvider: true, requireKey: true, initialTask: "must wait" });
    startup.type(ESC);
    await vi.waitFor(() => expect(startup.screen()).toContain("Provider selection cancelled."));
    expect(startup.current().secret).toBeUndefined();
    expect(startup.makeTransport).not.toHaveBeenCalled();
    expect(existsSync(userSettingsPath(startup.cwd))).toBe(false);

    const s = session({ apiKey: "infron-key" });
    const appended = vi.spyOn(s.terminal, "append");
    s.type("/provider\r");
    s.type(ESC);
    await vi.waitFor(() => expect(appended).toHaveBeenCalledWith(expect.objectContaining({ kind: "system", lines: ["Provider selection cancelled."] })));
    s.type("/provider openrouter\r");
    s.type(ESC);
    await vi.waitFor(() => expect(appended).toHaveBeenCalledWith(expect.objectContaining({ kind: "system", lines: ["login cancelled"] })));
  });

  it("returns control to the old session when verification itself is cancelled", async () => {
    let finish!: (value: { ok: true }) => void;
    const verifyKey = vi.fn(() => new Promise<{ ok: true }>(resolve => { finish = resolve; }));
    const s = session({ apiKey: "infron-key", requireKey: true, verifyKey });
    saveUserSettings({ endpoint: infron }, s.cwd);
    s.type("/config endpoint " + openRouter + "\ror-late\r");
    await vi.waitFor(() => expect(verifyKey).toHaveBeenCalledOnce());
    s.type(ESC);
    s.type("use current session\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: infron }), "infron-key"]);
    finish({ ok: true });
    await vi.waitFor(() => expect(s.screen()).toContain("login cancelled"));
    expect(s.saved().endpoint).toBe(infron);
    expect(existsSync(join(s.cwd, ".motif", ".env"))).toBe(false);
  });

  it("keeps the previous defaults and active key if the verified key cannot be saved", async () => {
    const s = session({ apiKey: "infron-key", envPath: tmpdir(), verifyKey: async () => ({ ok: true }) });
    saveUserSettings({ endpoint: infron, model: "motif/motif-3" }, s.cwd);
    s.type("/provider openrouter\ror-cannot-save\r");
    await vi.waitFor(() => expect(s.current().secret).toBeUndefined());
    await new Promise(resolve => setImmediate(resolve));
    s.type("go\r");
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
    expect(s.makeTransport.mock.calls.at(-1)).toEqual([expect.objectContaining({ endpoint: infron }), "infron-key"]);
    expect(s.saved().endpoint).toBe(infron);
    expect(s.screen()).not.toContain("or-cannot-save");
  });

  it("does not send a task after Escape skips its login", async () => {
    const s = session({ requireKey: true });
    s.type(ESC);
    await vi.waitFor(() => expect(s.screen()).toContain("no key entered"));
    s.type("go\r");
    expect(s.current().secret?.title).toContain("before the task can run");
    s.type(ESC);
    await vi.waitFor(() => expect(s.current().secret).toBeUndefined());
    await new Promise(resolve => setImmediate(resolve));
    expect(s.makeTransport).not.toHaveBeenCalled();
    expect(s.chat.tasksCompleted).toBe(0);
  });

  it("changes provider from the Config panel and refuses a change while a task is running", async () => {
    const s = session({ apiKey: "infron-key", providerCredentials: { morphfactory: { apiKey: "morph-key" } } });
    s.type("/config\r");
    const row = s.panel().rows.findIndex((r) => r.label === "Provider");
    expect(row).toBeGreaterThanOrEqual(0);
    s.type(DOWN.repeat(row) + RIGHT);
    expect(s.value("Provider")).toBe("Morphfactory (BETA)");
    expect(s.saved().endpoint).toBe(morph);
    s.type(ESC);
    s.transport.gated = true;
    s.type("go\r");
    await vi.waitFor(() => expect(s.transport.seen).toHaveLength(1));
    s.type("/provider infron\r");
    await vi.waitFor(() => expect(s.screen()).toContain("wait for the running task"));
    s.type("/config provider infron\r");
    await vi.waitFor(() => expect(s.screen()).toContain("Wait for the running task"));
    expect(s.saved().endpoint).toBe(morph);
    s.transport.open();
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(1));
  });
});
