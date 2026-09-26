/** Exercise the dashboard through the same raw keys and persistence path as an interactive session. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { saveUserSetting, userSettingsPath, type StoredSettings } from "../src/settings.js";

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
  const makeTransport = vi.fn((_settings: ChatOptions["settings"]) => transport);
  const chat = new Chat({
    screen: terminal,
    stdin: stdin as unknown as NodeJS.ReadStream,
    settings: { model: "motif/motif-3", endpoint: "https://llm.onerouter.pro", channel: "toolcall", maxTurns: 20, cwd, theme: "motif", compactAt: 0.75, permissions: "auto" },
    channelPolicy: "fixed",
    skills, agents, hooks: DEFAULT_HOOKS, tools: toolPrefix(CORE_TOOLS.length - 1),
    journalDir: join(cwd, ".motif", "sessions"), version: "test", hero: false,
    envPath: join(cwd, ".motif", ".env"),
    balanceFetch: async () => new Response(JSON.stringify({ credit_balance: 0 })),
    persist, makeTransport, ...extra,
  });
  const compose = vi.spyOn(terminal, "setComposer");
  const finished = chat.run();
  const type = (value: string): void => { stdin.write(value); };
  const current = (): ComposerView => compose.mock.calls.at(-1)![0]!;
  const panel = () => current().panel!;
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
