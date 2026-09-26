import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@motifcode/agents";
import { DEFAULT_HOOKS } from "@motifcode/hooks";
import { McpSession, isResultError, listMcpPresets, type McpStatus } from "@motifcode/mcp";
import { SkillRegistry } from "@motifcode/skills";
import { CORE_TOOLS } from "@motifcode/tools";
import { Screen, displayWidth } from "@motifcode/tui";
import type { Transport } from "@motifcode/core";
import { Chat, type ChatOptions } from "../src/chat.js";
import { mcpCatalogEntries, mcpListLines, mcpLoginPanelView, mcpPanelKeys, mcpPanelView, parseMcpRequest, type McpAction } from "../src/mcp-ui.js";

const ESC = "\x1b";
const status = (server = "memory", state: McpStatus["state"] = "idle"): McpStatus => ({ server, state, transport: "stdio", enabled: state !== "disabled", toolCount: state === "ready" ? 9 : 0 });
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

class FakeTTY extends PassThrough { isTTY = true; setRawMode(): this { return this; } }

function controls(initial = [status()]) {
  let values = structuredClone(initial);
  let hold = false;
  let fail = false;
  const calls: string[] = [];
  const change = async (action: McpAction, server: string, signal?: AbortSignal): Promise<McpStatus> => {
    calls.push(`${action}:${server}`);
    if (hold) await new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => { hold = false; reject(new Error("secret-token-should-not-print")); }, { once: true });
      if (signal?.aborted) reject(new Error("secret-token-should-not-print"));
    });
    if (fail) throw new Error("https://user:secret@example.invalid?api_key=secret-token-should-not-print\x1b]52;c;pwned\x07");
    const current = values.find((s) => s.server === server)!;
    current.state = action === "disconnect" ? "paused" : "ready";
    current.toolCount = current.state === "ready" ? 9 : 0;
    return structuredClone(current);
  };
  const mcp = {
    statuses: () => structuredClone(values),
    connect: (server: string, signal?: AbortSignal) => change("connect", server, signal),
    disconnect: (server: string, signal?: AbortSignal) => change("disconnect", server, signal),
    reconnect: (server: string, signal?: AbortSignal) => change("reconnect", server, signal),
    prepare: async () => "",
    replyRecovery: () => undefined,
    clearScope: vi.fn(),
  } as unknown as McpSession;
  return { mcp, calls, hold: () => { hold = true; }, fail: () => { fail = true; }, set: (next: McpStatus[]) => { values = next; } };
}

const opened: { chat: Chat; type(s: string): void; finished: Promise<number> }[] = [];
function session(mcp?: McpSession, transport?: Transport, compactAt = 0.75, extra: Partial<ChatOptions> = {}) {
  const output: string[] = [];
  const stdin = new FakeTTY();
  const cwd = mkdtempSync(join(tmpdir(), "motif-mcp-ui-"));
  const complete = vi.fn(async () => ({ content: "", rawText: "", ms: 0 }));
  const screen = new Screen({ write: (s) => output.push(s), columns: () => 80, interactive: true });
  const chat = new Chat({
    screen, stdin: stdin as unknown as NodeJS.ReadStream,
    settings: { model: "test", endpoint: "http://localhost", channel: "toolcall", maxTurns: 4, cwd, theme: "motif", compactAt, permissions: "auto" },
    channelPolicy: "fixed", skills: new SkillRegistry(), agents: new AgentRegistry(), hooks: DEFAULT_HOOKS,
    tools: [...CORE_TOOLS], journalDir: join(cwd, "journals"), version: "test", hero: false,
    makeTransport: () => transport ?? { endpoint: "fake", model: "test", complete },
    ...(mcp ? { mcp } : {}),
    ...extra,
  });
  const finished = chat.run();
  const result = { chat, screen, type: (s: string) => { stdin.write(s); }, output: () => strip(output.join("")), finished, complete };
  opened.push(result);
  return result;
}

afterEach(async () => {
  for (const s of opened) { s.chat.stop(); await s.finished; }
  opened.length = 0;
  vi.unstubAllEnvs();
});

describe("MCP authorization UI", () => {
  it("routes explicit login and local logout without model requests", async () => {
    const c = controls(); const login = vi.fn(async () => {}); const logout = vi.fn(async () => {});
    const s = session(c.mcp, undefined, 0.75, { mcpLogin: login, mcpLogout: logout });
    s.type("/mcp login memory\r");
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(c.calls).toContain("reconnect:memory"));
    s.type("/mcp logout memory\r");
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(c.calls).toContain("disconnect:memory"); expect(s.complete).not.toHaveBeenCalled();
  });
  it("offers browser login after a thrown authentication failure", async () => {
    const errorStatus = { ...status("memory", "error"), error: { code: "authentication_required", message: "Login required" } };
    const c = controls([errorStatus]); const login = vi.fn(async () => {});
    c.mcp.connect = async () => { throw new Error("provider secret must not print"); };
    const s = session(c.mcp, undefined, 0.75, { mcpLogin: login });
    s.type("/mcp connect memory\r");
    await vi.waitFor(() => expect(s.output()).toContain("MCP login required"));
    s.type("1");
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce());
    expect(c.calls).toContain("reconnect:memory"); expect(s.output()).not.toContain("provider secret");
  });
  it("does not launch when browser approval is declined", async () => {
    const s = session(); const browser = vi.fn(async () => {});
    const withBrowser = session(undefined, undefined, 0.75, { openBrowser: browser });
    const result = withBrowser.chat.handleMcpElicitation({ server: "fixture", mode: "url", message: "Approve login", url: "https://example.com/authorize", elicitationId: "id", signal: new AbortController().signal });
    await vi.waitFor(() => expect(withBrowser.output()).toContain("Open browser"));
    withBrowser.type("2");
    expect(await result).toEqual({ action: "decline" }); expect(browser).not.toHaveBeenCalled();
    s.chat.stop();
  });
  it("waits for browser completion and cancels pending UI on abort", async () => {
    const browser = vi.fn(async () => {}); const s = session(undefined, undefined, 0.75, { openBrowser: browser });
    const abort = new AbortController();
    const result = s.chat.handleMcpElicitation({ server: "fixture", mode: "url", message: "Approve login", url: "https://example.com/authorize?state=hidden", elicitationId: "id", signal: abort.signal });
    await vi.waitFor(() => expect(s.output()).toContain("Open browser")); s.type("1");
    await vi.waitFor(() => expect(s.output()).toContain("Authorization completed"));
    expect(browser).toHaveBeenCalledOnce(); expect(s.output()).not.toContain("state=hidden");
    abort.abort(); expect(await result).toEqual({ action: "cancel" });
    s.type("/mcp list\r"); await vi.waitFor(() => expect(s.output()).toContain("No MCP servers configured"));
  });
  it("submits empty optional form fields while keeping API key input nonempty", async () => {
    const s = session();
    const result = s.chat.handleMcpElicitation({ server: "fixture", mode: "form", message: "Preferences", signal: new AbortController().signal,
      requestedSchema: { type: "object", properties: { note: { type: "string" }, count: { type: "integer" }, tags: { type: "array", items: { type: "string", enum: ["one"] } } } } });
    await vi.waitFor(() => expect(s.output()).toContain("Continue")); s.type("1");
    for (const field of ["note", "count", "tags"]) {
      await vi.waitFor(() => expect(s.output()).toContain(field)); s.type("\r");
    }
    expect(await result).toEqual({ action: "accept", content: {} });
    const verifyKey = vi.fn(async () => ({ ok: true as const }));
    const login = session(undefined, undefined, 0.75, { requireKey: true, verifyKey });
    await vi.waitFor(() => expect(login.output()).toContain("Paste your Infron API key")); login.type("\r");
    expect(verifyKey).not.toHaveBeenCalled();
    login.type(ESC);
  });
  it("shows constrained form answers while typing but keeps free text hidden", async () => {
    const s = session();
    const result = s.chat.handleMcpElicitation({ server: "fixture", mode: "form", message: "Order", signal: new AbortController().signal,
      requestedSchema: { type: "object", properties: { count: { type: "integer" }, note: { type: "string" } }, required: ["count"] } });
    await vi.waitFor(() => expect(s.output()).toContain("Continue")); s.type("1");
    await vi.waitFor(() => expect(s.output()).toContain("count")); s.type("7391");
    await vi.waitFor(() => expect(s.output()).toContain("7391")); s.type("\r");
    await vi.waitFor(() => expect(s.output()).toContain("note")); s.type("PRIVATE_NOTE_VALUE");
    expect(s.output()).not.toContain("PRIVATE_NOTE_VALUE"); s.type("\r");
    expect(await result).toEqual({ action: "accept", content: { count: 7391, note: "PRIVATE_NOTE_VALUE" } });
  });
  it("clears hidden form input before stopping an active task can redraw it", async () => {
    const c = controls();
    const s = session(c.mcp);
    c.mcp.prepare = async (_task, signal) => {
      await s.chat.handleMcpElicitation({ server: "fixture", mode: "form", message: "Private response", signal: signal!,
        requestedSchema: { type: "object", properties: { note: { type: "string" } } } });
      return "";
    };
    s.type("Run fixture task\r");
    await vi.waitFor(() => expect(s.output()).toContain("Continue")); s.type("1");
    await vi.waitFor(() => expect(s.output()).toContain("Optional: leave empty to skip"));
    s.type("SYNTHETIC_FORM_PRIVATE_VALUE");
    expect(s.output()).not.toContain("SYNTHETIC_FORM_PRIVATE_VALUE");
    s.chat.stop(); await s.finished;
    expect(s.output()).not.toContain("SYNTHETIC_FORM_PRIVATE_VALUE");
    expect(s.complete).not.toHaveBeenCalled();
  });
});

describe("MCP manager presentation", () => {
  it("parses only explicit connection commands and valid configured identities", () => {
    expect(parseMcpRequest("")).toEqual({ action: "panel" });
    expect(parseMcpRequest("list")).toEqual({ action: "list" });
    expect(parseMcpRequest("connect browser.one")).toEqual({ action: "connect", server: "browser.one" });
    for (const command of ["add memory -- npx server", "connect", "list extra", "connect https://user:token@host", "reconnect a b"]) expect(parseMcpRequest(command)).toBeUndefined();
  });

  it("keeps full selected identities, CJK notices and status within narrow display columns", () => {
    const id = "server-" + "x".repeat(121);
    const servers = Array.from({ length: 12 }, (_, i) => status(i === 9 ? id : `server-${i}`, "ready"));
    for (const width of [28, 40, 80, 120]) {
      const view = mcpPanelView(servers, 9, width, "연결 상태를 확인했습니다. 도구를 사용할 수 있습니다.");
      expect(view.choices).toHaveLength(width < 48 ? 3 : 5);
      expect(view.choices.filter((row) => row.startsWith("❯"))).toHaveLength(1);
      for (const row of [...view.lines, ...view.choices]) expect(displayWidth(row)).toBeLessThanOrEqual(width - 4);
      expect(view.lines.join("")).toContain(id);
      expect(view.lines.join("")).toContain("연결 상태를 확인했습니다.");
      expect(view.choices.join("\n")).toContain("connected");
    }
  });

  it("never renders raw server errors or invalid identities", () => {
    const secret = "https://user:secret@host?key=token\x1b]52;c;pwned\x07";
    const server = { ...status(secret, "error"), error: { code: "transport_error", message: secret } };
    const shown = JSON.stringify(mcpPanelView([server], 0, 80)) + mcpListLines([server]).join("\n");
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain("user:secret");
    expect(shown).not.toContain("pwned");
    expect(shown).toContain("motif mcp doctor");
  });

  it("recalculates the panel on terminal resize using the current width", () => {
    let columns = 100;
    const widths: number[] = [];
    const screen = new Screen({ write: () => {}, columns: () => columns, interactive: true });
    screen.setComposer({ draft: { text: "", cursor: 0 }, panel: (width) => {
      widths.push(width);
      return mcpPanelView([status("a-very-long-server-name-for-resizing")], 0, width);
    } });
    columns = 32;
    screen.setHint("redraw");
    expect(widths).toContain(100);
    expect(widths).toContain(32);
    screen.finish();
  });

  it("keeps title, a full 128-character identity, state and Esc visible at 40 by 12", () => {
    const id = "server-" + "x".repeat(121);
    const view = mcpPanelView([status("one"), status(id, "ready"), status("three")], 1, 40, undefined, 12);
    expect(view.title).toBe("MCP servers");
    expect(view.lines.join("")).toContain(id);
    expect(view.choices.join("\n")).toContain("connected");
    expect(view.choices).toHaveLength(1);
    // Title, separator, borders, footer hint, and parked cursor use six rows.
    expect(view.lines.length + view.choices.length + 6).toBeLessThanOrEqual(12);
    expect(mcpPanelKeys(40)).toContain("esc");
    expect(displayWidth(mcpPanelKeys(40)) + 2).toBeLessThanOrEqual(40);
  });
});

describe("MCP controls through real chat keystrokes", () => {
  it("opens without connecting, then connects, reconnects and disconnects with keys", async () => {
    const c = controls();
    const s = session(c.mcp);
    s.type("/mcp\r");
    await vi.waitFor(() => expect(s.output()).toContain("MCP servers"));
    expect(c.calls).toEqual([]);
    s.type("\r");
    await vi.waitFor(() => expect(s.output()).toContain("memory: connected"));
    s.type("r");
    await vi.waitFor(() => expect(c.calls).toContain("reconnect:memory"));
    await vi.waitFor(() => expect(s.output()).toContain("memory: connected"));
    s.type("\r");
    await vi.waitFor(() => expect(s.output()).toContain("memory: disconnected"));
    expect(c.calls).toEqual(["connect:memory", "reconnect:memory", "disconnect:memory"]);
    expect(s.complete).not.toHaveBeenCalled();
    s.type(ESC);
    s.type("/mcp list\r");
    await vi.waitFor(() => expect(s.output()).toContain("session. /mcp opens the manager"));
  });

  it("selects a server with arrows and refuses disabled configuration", async () => {
    const c = controls([status("one"), status("two", "disabled")]);
    const s = session(c.mcp);
    s.type("/mcp\r");
    s.type("\x1b[B\r");
    await vi.waitFor(() => expect(s.output()).toContain("Disabled in configuration"));
    expect(c.calls).toEqual([]);
    s.type("\x1b[A\r");
    await vi.waitFor(() => expect(c.calls).toEqual(["connect:one"]));
  });

  it("shows empty setup guidance without introducing an unsupported login flow", async () => {
    const s = session();
    s.type("/mcp\r");
    await vi.waitFor(() => expect(s.output()).toContain("No MCP servers configured"));
    expect(s.output()).toContain("motif mcp add NAME");
    expect(s.output()).not.toContain("OAuth");
    s.type("\r");
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("supports explicit slash actions and hides exception secrets", async () => {
    const c = controls();
    const s = session(c.mcp);
    s.type("/mcp connect memory\r");
    await vi.waitFor(() => expect(s.output()).toContain("memory: connected"));
    c.fail();
    s.type("/mcp reconnect memory\r");
    await vi.waitFor(() => expect(s.output()).toContain("Connection failed"));
    expect(s.output()).not.toContain("secret-token-should-not-print");
    expect(s.output()).not.toContain("pwned");
    expect(s.output()).not.toContain("user:secret");
  });

  it("keeps operations exclusive and stops waiting for an in-flight connect with Esc", async () => {
    const c = controls();
    c.hold();
    const s = session(c.mcp);
    s.type("/mcp connect memory\r");
    await vi.waitFor(() => expect(c.calls).toEqual(["connect:memory"]));
    s.type("write a file\r");
    expect(s.complete).not.toHaveBeenCalled();
    s.type(ESC);
    await vi.waitFor(() => expect(s.output()).toContain("Stopped waiting"));
    expect(s.output()).toContain("connection may still finish");
    s.type("/mcp connect memory\r");
    await vi.waitFor(() => expect(s.output()).toContain("memory: connected"));
    expect(c.calls).toEqual(["connect:memory", "connect:memory"]);
  });

  it("allows a status list during a model task but blocks all connection mutations", async () => {
    const c = controls();
    const transport: Transport = { endpoint: "fake", model: "test", complete: (request) => new Promise((resolve) => {
      request.signal?.addEventListener("abort", () => resolve({ content: "", rawText: "", ms: 0 }), { once: true });
    }) };
    const s = session(c.mcp, transport);
    s.type("stay active\r");
    await vi.waitFor(() => expect(s.chat.running).toBe(true));
    s.type("/mcp list\r");
    await vi.waitFor(() => expect(s.output()).toContain("memory · not connected"));
    for (const action of ["connect", "disconnect", "reconnect"]) s.type(`/mcp ${action} memory\r`);
    await vi.waitFor(() => expect(s.output()).toContain("Wait for the running task"));
    expect(c.calls).toEqual([]);
    s.type("/mcp\r");
    await vi.waitFor(() => expect(s.output()).toContain("Wait for the task to finish"));
    s.type(ESC);
    await vi.waitFor(() => expect(s.chat.running).toBe(false));
  });

  it("does not open connection controls between a completed task's compaction and its queued task", async () => {
    const c = controls();
    let firstDone!: () => void;
    let compactDone!: () => void;
    let calls = 0;
    const transport: Transport = { endpoint: "fake", model: "test", complete: async () => {
      const call = ++calls;
      if (call === 1) await new Promise<void>((resolve) => { firstDone = resolve; });
      if (call === 2) await new Promise<void>((resolve) => { compactDone = resolve; });
      return { content: call === 2 ? "summary" : "finished", reasoningContent: "", rawText: "", ms: 0, usage: { promptTokens: call === 1 ? 100 : 1, completionTokens: 1, cachedTokens: 0 } };
    } };
    const s = session(c.mcp, transport, 0.0001);
    s.type("first task\r");
    await vi.waitFor(() => expect(calls).toBe(1));
    s.type("second task\r");
    firstDone();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(s.chat.running).toBe(false); // The loop ended; its compaction did not.
    s.type("/mcp\r");
    await vi.waitFor(() => expect(s.output()).toContain("Wait for the task to finish"));
    s.type("/mcp connect memory\r");
    await vi.waitFor(() => expect(s.output()).toContain("queued work to finish"));
    expect(c.calls).toEqual([]);
    expect(s.output()).not.toContain("MCP servers");
    compactDone();
    await vi.waitFor(() => expect(s.chat.tasksCompleted).toBe(2));
    await s.chat.whenIdle();
    expect(calls).toBe(3);
    s.type("/mcp connect memory\r");
    await vi.waitFor(() => expect(c.calls).toEqual(["connect:memory"]));
  });

  it("forgets previous conversation result handles on new/channel without replacing the manager", async () => {
    const mcp = new McpSession({ servers: [] }, { maxOutputBytes: 1600 });
    const manager = mcp.manager;
    const s = session(mcp);
    const store = () => {
      const view = mcp.results.present("root", { text: "private-context-".repeat(400) }) as { handle: string };
      expect(view.handle).toMatch(/^mcp_result_/);
      expect(isResultError(mcp.results.read("root", { handle: view.handle, pointer: "/text", charCount: 20 }))).toBe(false);
      return view.handle;
    };
    const first = store();
    s.type("/new\r");
    await vi.waitFor(() => expect(isResultError(mcp.results.read("root", { handle: first }))).toBe(true));
    const second = store();
    s.type("/channel object\r");
    await vi.waitFor(() => expect(isResultError(mcp.results.read("root", { handle: second }))).toBe(true));
    expect(mcp.manager).toBe(manager);
    await mcp.close();
  });
});


describe("Built-in MCP catalog setup", () => {
  it("shows all presets without connecting or duplicating configured names", async () => {
    const presets = listMcpPresets();
    const c = controls([status("playwright", "ready"), status("context7", "disabled")]);
    const install = vi.fn(); const login = vi.fn();
    const s = session(c.mcp, undefined, 0.75, { mcpPresets: () => presets, mcpInstall: install, mcpLogin: login });
    s.type("/mcp list\r");
    await vi.waitFor(() => expect(s.output()).toContain("github · available"));
    for (const preset of presets) expect(s.output()).toContain(preset.id);
    const rows = mcpCatalogEntries(c.mcp.statuses(), presets);
    expect(rows).toHaveLength(presets.length);
    expect(rows.filter(row => row.server === "context7")).toHaveLength(1);
    expect(rows.find(row => row.server === "context7")?.status?.state).toBe("disabled");
    expect(rows.find(row => row.server === "github")?.status).toBeUndefined();
    s.type("/mcp\r");
    await vi.waitFor(() => expect(s.output()).toContain("6 available"));
    expect(c.calls).toEqual([]); expect(install).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });

  it("requires human consent, then registers and loads a preset without restarting", async () => {
    const c = controls([]);
    const install = vi.fn(async (id: string) => { const row = status(id, "ready"); c.set([row]); return row; });
    const s = session(c.mcp, undefined, 0.75, { mcpPresets: listMcpPresets, mcpInstall: install, mcpConfigLabel: "User configuration" });
    s.type("/mcp\r"); s.type("\r");
    await vi.waitFor(() => expect(s.output()).toContain("Set up Context7?"));
    expect(s.output()).toContain("Save to: User configuration"); expect(install).not.toHaveBeenCalled();
    s.type("1");
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(install).toHaveBeenCalledWith("context7", {}, expect.any(AbortSignal));
    await vi.waitFor(() => expect(s.output()).toContain("context7: registered · connected"));
    s.type("d"); await vi.waitFor(() => expect(c.calls).toContain("disconnect:context7"));
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("cancels setup without saving config or consuming later task text", async () => {
    const install = vi.fn(); const s = session(controls([]).mcp, undefined, 0.75, { mcpPresets: listMcpPresets, mcpInstall: install });
    s.type("/mcp install context7\r");
    await vi.waitFor(() => expect(s.output()).toContain("Set up Context7?"));
    s.type("2");
    await vi.waitFor(() => expect(s.output()).toContain("no configuration changed"));
    expect(install).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });

  it("enables an existing disabled preset only after consent", async () => {
    const c = controls([status("context7", "disabled")]);
    const install = vi.fn(async () => { const row = status("context7", "ready"); c.set([row]); return row; });
    const s = session(c.mcp, undefined, 0.75, { mcpPresets: listMcpPresets, mcpInstall: install });
    s.type("/mcp\r"); s.type("\r");
    await vi.waitFor(() => expect(s.output()).toContain("Enable Context7?"));
    expect(install).not.toHaveBeenCalled(); s.type("1");
    await vi.waitFor(() => expect(install).toHaveBeenCalledWith("context7", {}, expect.any(AbortSignal)));
  });

  it("requires an explicitly reviewed filesystem root and supports visible path input", async () => {
    const c = controls([]); const install = vi.fn(async () => status("filesystem", "ready"));
    const s = session(c.mcp, undefined, 0.75, { mcpPresets: listMcpPresets, mcpInstall: install });
    // A short path keeps the typed value and the review line on one row.
    const project = mkdtempSync("/tmp/mfs-"); mkdirSync(join(project, "data"));
    const alias = join(project, "a"); symlinkSync(join(project, "data"), alias);
    const canonical = realpathSync(join(project, "data"));
    s.type("/mcp install filesystem\r");
    await vi.waitFor(() => expect(s.output()).toContain("Choose filesystem access")); s.type("2");
    await vi.waitFor(() => expect(s.output()).toContain("Filesystem directory"));
    s.type(alias);
    expect(s.output()).toContain(alias); expect(install).not.toHaveBeenCalled(); s.type("\r");
    // The review names the directory that will be granted, not the typed alias.
    await vi.waitFor(() => expect(s.output()).toContain(`Read/write root: ${canonical}`));
    expect(install).not.toHaveBeenCalled(); s.type("1");
    await vi.waitFor(() => expect(install).toHaveBeenCalledWith("filesystem", { root: canonical }, expect.any(AbortSignal)));
  });

  it("expands ~ and refuses a missing filesystem root before review", async () => {
    // A short home keeps the review line on one row wherever the suite runs.
    const home = mkdtempSync("/tmp/mfh-"); vi.stubEnv("HOME", home);
    const c = controls([]); const install = vi.fn(async () => status("filesystem", "ready"));
    const s = session(c.mcp, undefined, 0.75, { mcpPresets: listMcpPresets, mcpInstall: install });
    s.type("/mcp install filesystem\r");
    await vi.waitFor(() => expect(s.output()).toContain("Choose filesystem access")); s.type("2");
    await vi.waitFor(() => expect(s.output()).toContain("Filesystem directory")); s.type("~\r");
    await vi.waitFor(() => expect(s.output()).toContain(`Read/write root: ${realpathSync(home)}`)); s.type("2");
    await vi.waitFor(() => expect(s.output()).toContain("MCP setup cancelled"));
    const mark = s.output().length; s.type("/mcp install filesystem\r");
    await vi.waitFor(() => expect(s.output().slice(mark)).toContain("Choose filesystem access")); s.type("2");
    await vi.waitFor(() => expect(s.output().slice(mark)).toContain("Filesystem directory")); s.type("/definitely/missing/root\r");
    await vi.waitFor(() => expect(s.output()).toContain("is not an existing directory"));
    expect(install).not.toHaveBeenCalled();
  });

  it("keeps Gmail preview prerequisites actionable without soliciting a token", async () => {
    const install = vi.fn(); const s = session(controls([]).mcp, undefined, 0.75, { mcpPresets: listMcpPresets, mcpInstall: install });
    s.type("/mcp install gmail\r");
    await vi.waitFor(() => expect(s.output()).toContain("--token-env GOOGLE_ACCESS_TOKEN"));
    expect(install).not.toHaveBeenCalled(); expect(s.complete).not.toHaveBeenCalled();
  });

  it("offers persistent GitHub login after registration and keeps device progress human-only", async () => {
    const c = controls([]);
    const install = vi.fn(async () => { const row = { ...status("github", "error"), error: { code: "authentication_required", message: "Missing login" } }; c.set([row]); return row; });
    let finish!: () => void;
    const login = vi.fn(async (_server: string, _signal: AbortSignal, progress?: (message: string) => void) => {
      progress?.("GitHub code: ABCD-1234 · github.com/login/device"); await new Promise<void>(resolve => { finish = resolve; });
    });
    const s = session(c.mcp, undefined, 0.75, { mcpPresets: listMcpPresets, mcpInstall: install, mcpLogin: login });
    s.type("/mcp connect github\r");
    await vi.waitFor(() => expect(s.output()).toContain("Set up GitHub?")); s.type("1");
    await vi.waitFor(() => expect(s.output()).toContain("MCP login required")); s.type("1");
    await vi.waitFor(() => expect(s.output()).toContain("GitHub code: ABCD-1234"));
    expect(login).toHaveBeenCalledOnce(); finish();
    await vi.waitFor(() => expect(c.calls).toContain("reconnect:github"));
    expect(s.complete).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(s.output()).toContain("github: registered · connected"));
    c.set([status("github", "ready")]);
    s.type("inspect project\r");
    await vi.waitFor(() => expect(s.complete).toHaveBeenCalledOnce());
    expect(JSON.stringify(s.complete.mock.calls)).not.toContain("ABCD-1234");
  });

  it("blocks preset mutation during a task but still exposes the catalog", async () => {
    const install = vi.fn();
    const transport: Transport = { endpoint: "fake", model: "test", complete: request => new Promise(resolve => { request.signal?.addEventListener("abort", () => resolve({ content: "", rawText: "", ms: 0 }), { once: true }); }) };
    const s = session(controls([]).mcp, transport, 0.75, { mcpPresets: listMcpPresets, mcpInstall: install });
    s.type("stay active\r"); await vi.waitFor(() => expect(s.chat.running).toBe(true));
    s.type("/mcp install github\r"); await vi.waitFor(() => expect(s.output()).toContain("Wait for the running task"));
    s.type("/mcp list\r"); await vi.waitFor(() => expect(s.output()).toContain("github · available"));
    expect(install).not.toHaveBeenCalled(); s.type(ESC);
  });

  it("keeps preset states and browser device codes readable in small terminals", () => {
    for (const [width, height] of [[28, 12], [40, 12], [80, 24]]) {
      const view = mcpPanelView([], 1, width!, undefined, height!, listMcpPresets());
      expect(view.lines.join(" ")).toContain("github");
      expect(view.choices.join(" ")).toContain("available");
      expect(view.lines.length + view.choices.length + 6).toBeLessThanOrEqual(height!);
      const login = mcpLoginPanelView("GitHub code: ABCD-1234 · github.com/login/device", width!, height!);
      expect(login.lines.join("")).toContain("ABCD-1234");
      for (const row of [...view.lines, ...view.choices, ...login.lines, ...login.choices]) expect(displayWidth(row)).toBeLessThanOrEqual(width! - 4);
    }
  });
});
