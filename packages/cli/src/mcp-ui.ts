import type { McpPreset, McpStatus } from "@motifcode/mcp";
import { truncateToWidth, wrapWords, type ComposerView } from "@motifcode/tui";

export type McpAction = "connect" | "disconnect" | "reconnect" | "login" | "logout";
export type McpRequest = { action: "panel" } | { action: "list" } | { action: McpAction | "install"; server: string };
export interface McpCatalogEntry { server: string; status?: McpStatus; preset?: McpPreset }

/** Catalog reads are inert: show recipes separately from registered connections. */
export function mcpCatalogEntries(servers: readonly McpStatus[], presets: readonly McpPreset[] = []): McpCatalogEntry[] {
  const configured = new Set(servers.map(server => server.server));
  return [
    ...servers.map(status => ({ server: status.server, status, preset: presets.find(preset => preset.id === status.server) })),
    ...presets.filter(preset => !configured.has(preset.id)).map(preset => ({ server: preset.id, preset })),
  ];
}

export const MCP_USAGE = "/mcp [list | install PRESET | connect NAME | disconnect NAME | reconnect NAME | login NAME | logout NAME]";

/** Server names come from validated configuration, never a command or URL. */
function identity(server: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(server) ? server : "(invalid server name)";
}

export function parseMcpRequest(args: string): McpRequest | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { action: "panel" };
  if (words.length === 1 && words[0] === "list") return { action: "list" };
  if (words.length !== 2 || !["install", "connect", "disconnect", "reconnect", "login", "logout"].includes(words[0]!)) return undefined;
  if (identity(words[1]!) !== words[1]) return undefined;
  return { action: words[0] as McpAction | "install", server: words[1]! };
}

const LABELS: Record<McpStatus["state"], string> = {
  idle: "not connected", connecting: "connecting", ready: "connected", paused: "disconnected",
  error: "failed", disabled: "disabled", closed: "closed",
};

export function mcpStatusLabel(status: McpStatus): string {
  return LABELS[status.state] ?? "unavailable";
}

export function mcpToolCount(status: McpStatus): string {
  return status.toolCount === 0 ? "0 tools discovered" : `${status.toolCount} allowed tools`;
}

export function mcpPanelKeys(width: number): string {
  return width < 68 ? "↑↓ · enter setup/toggle · l · esc" : "↑↓ select · enter setup/toggle · r reconnect · d disconnect · l login · esc";
}

/** Do not paint exception messages, server stderr, endpoint URLs or headers. */
export function mcpFailureHint(status?: McpStatus): string {
  const code = status?.error?.code;
  if (code === "cancelled" || code === "aborted") return "Connection cancelled.";
  if (code === "authentication_required") return "Login required. Press l in /mcp, or use /mcp login NAME.";
  if (code === "permission_denied") return "Access denied. Check the provider account and granted permissions.";
  if (code === "missing_env") return "Required environment variable is missing. Check motif mcp doctor.";
  if (code === "server_not_allowed" || status?.state === "disabled") return "Disabled in configuration. Check motif mcp list and project trust.";
  return "Connection failed. Check configuration and credentials with motif mcp doctor.";
}

export function mcpListLines(servers: readonly McpStatus[], presets: readonly McpPreset[] = []): string[] {
  const available = mcpCatalogEntries(servers, presets).filter(entry => !entry.status);
  if (!servers.length && !available.length) return ["No MCP servers configured.", "Add one: motif mcp add NAME -- COMMAND [ARGS...]", "Restart this session after changing configuration."];
  return [
    ...servers.flatMap((server) => [
      `${identity(server.server)} · ${mcpStatusLabel(server)} · ${server.transport} · ${mcpToolCount(server)}`,
      ...(server.state === "error" ? [`  ${mcpFailureHint(server)}`] : []),
    ]),
    ...(available.length ? ["", "Built-in presets · available to set up", ...available.map(entry => `${identity(entry.server)} · available · ${entry.preset!.config.transport}`)] : []),
    "", "Connections are controlled for this session. /mcp opens the manager.",
    "Preset setup is saved and loaded immediately; external configuration edits require a restart.",
  ];
}

/** Reuse the existing themed composer box and selected-choice accent. */
export function mcpPanelView(servers: readonly McpStatus[], selected: number, width: number, notice?: string, height = 24, presets: readonly McpPreset[] = []): NonNullable<ComposerView["confirm"]> {
  const inner = Math.max(1, width - 8);
  const wrap = (line: string): string[] => wrapWords(line, inner);
  // Border, title, choice separator, hint and parked cursor occupy six rows.
  const budget = Math.max(2, height - 6);
  const entries = mcpCatalogEntries(servers, presets);
  if (!entries.length) return {
    title: "MCP servers",
    lines: (height < 18 ? ["No MCP servers configured.", "Use motif mcp add NAME -- COMMAND"] : mcpListLines(servers)).flatMap(wrap).slice(0, budget - 1),
    choices: ["❯ Close"],
  };
  const index = Math.max(0, Math.min(selected, entries.length - 1));
  const entry = entries[index]!;
  const current = entry.status;
  const preset = entry.preset;
  const label = current ? mcpStatusLabel(current) : "available";
  const transport = current?.transport ?? preset!.config.transport;
  const idRows = wrap(identity(entry.server));
  const detailBudget = Math.max(1, budget - 2);
  const compactDetails = [
    ...idRows.slice(0, detailBudget).map((row, i) => i === detailBudget - 1 && idRows.length > detailBudget ? truncateToWidth(row + "…", inner) : row),
    truncateToWidth(notice ?? `${label} · ${transport}${current ? ` · ${current.toolCount} tools` : " · enter to set up"}`, inner),
  ];
  const fullDetails = [
    ...wrap(presets.length ? `${servers.filter((s) => s.state === "ready").length} connected · ${servers.length} registered · ${entries.length - servers.length} available` : `${servers.filter((s) => s.state === "ready").length}/${servers.length} connected`),
    ...wrap(identity(entry.server)),
    ...wrap(current ? `${transport} · ${mcpToolCount(current)}${current.profile ? ` · ${current.profile}` : ""}` : `${transport} · built-in preset · ${preset!.publisher}`),
    ...wrap(current ? (current.enabled ? "Config: enabled" : preset ? "Config: disabled; enter to enable or check project trust" : "Config: disabled; enable via motif mcp enable, then restart") : "Available to set up; no connection or download yet."),
    ...(notice ? wrap(notice) : current?.state === "error" ? wrap(mcpFailureHint(current)) : !current ? wrap(preset!.description) : []),
  ];
  const details = height < 18 || fullDetails.length > budget - 1 ? compactDetails : fullDetails;
  const pageSize = Math.min(width < 48 ? 3 : 5, Math.max(1, budget - details.length));
  const start = Math.min(Math.max(0, index - Math.floor(pageSize / 2)), Math.max(0, entries.length - pageSize));
  const visible = entries.slice(start, start + pageSize);
  return {
    title: "MCP servers",
    lines: details,
    choices: visible.map((server, offset) => {
      const prefix = start + offset === index ? "❯" : " ";
      const state = server.status ? mcpStatusLabel(server.status) : "available";
      // Keep the state readable when a long name needs to be shortened. The
      // full selected identity is wrapped above, so similar IDs stay distinct.
      return `${prefix} ${truncateToWidth(identity(server.server), Math.max(1, inner - state.length - 5))} · ${state}`;
    }),
  };
}

/** Provider device codes stay in a temporary human-only panel, with wrapping. */
export function mcpLoginPanelView(message: string, width: number, height = 24): NonNullable<ComposerView["confirm"]> {
  const inner = Math.max(1, width - 8);
  return { title: "MCP account authorization", lines: wrapWords(message, inner).slice(0, Math.max(1, height - 7)), choices: [truncateToWidth("Waiting for browser authorization…", inner)] };
}
