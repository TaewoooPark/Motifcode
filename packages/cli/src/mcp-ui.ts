import type { McpStatus } from "@motifcode/mcp";
import { truncateToWidth, wrapToWidth, type ComposerView } from "@motifcode/tui";

export type McpAction = "connect" | "disconnect" | "reconnect";
export type McpRequest = { action: "panel" } | { action: "list" } | { action: McpAction; server: string };

export const MCP_USAGE = "/mcp [list | connect NAME | disconnect NAME | reconnect NAME]";

/** Server names come from validated configuration, never a command or URL. */
function identity(server: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(server) ? server : "(invalid server name)";
}

export function parseMcpRequest(args: string): McpRequest | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { action: "panel" };
  if (words.length === 1 && words[0] === "list") return { action: "list" };
  if (words.length !== 2 || !["connect", "disconnect", "reconnect"].includes(words[0]!)) return undefined;
  if (identity(words[1]!) !== words[1]) return undefined;
  return { action: words[0] as McpAction, server: words[1]! };
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
  return width < 68 ? "↑↓ · enter · r · d · esc" : "↑↓ select · enter toggle · r reconnect · d disconnect · esc close";
}

/** Do not paint exception messages, server stderr, endpoint URLs or headers. */
export function mcpFailureHint(status?: McpStatus): string {
  const code = status?.error?.code;
  if (code === "cancelled" || code === "aborted") return "Connection cancelled.";
  if (code === "missing_env") return "Required environment variable is missing. Check motif mcp doctor.";
  if (code === "server_not_allowed" || status?.state === "disabled") return "Disabled in configuration. Check motif mcp list and project trust.";
  return "Connection failed. Check configuration and credentials with motif mcp doctor.";
}

export function mcpListLines(servers: readonly McpStatus[]): string[] {
  if (!servers.length) return ["No MCP servers configured.", "Add one: motif mcp add NAME -- COMMAND [ARGS...]", "Restart this session after changing configuration."];
  return [
    ...servers.flatMap((server) => [
      `${identity(server.server)} · ${mcpStatusLabel(server)} · ${server.transport} · ${mcpToolCount(server)}`,
      ...(server.state === "error" ? [`  ${mcpFailureHint(server)}`] : []),
    ]),
    "", "Connections are controlled for this session. /mcp opens the manager.",
    "Restart this session after changing MCP configuration.",
  ];
}

/** Reuse the existing themed composer box and selected-choice accent. */
export function mcpPanelView(servers: readonly McpStatus[], selected: number, width: number, notice?: string, height = 24): NonNullable<ComposerView["confirm"]> {
  const inner = Math.max(1, width - 8);
  const wrap = (line: string): string[] => wrapToWidth(line, inner);
  // Border, title, choice separator, hint and parked cursor occupy six rows.
  const budget = Math.max(2, height - 6);
  if (!servers.length) return {
    title: "MCP servers",
    lines: (height < 18 ? ["No MCP servers configured.", "Use motif mcp add NAME -- COMMAND"] : mcpListLines(servers)).flatMap(wrap).slice(0, budget - 1),
    choices: ["❯ Close"],
  };
  const index = Math.max(0, Math.min(selected, servers.length - 1));
  const current = servers[index]!;
  const idRows = wrap(identity(current.server));
  const detailBudget = Math.max(1, budget - 2);
  const compactDetails = [
    ...idRows.slice(0, detailBudget).map((row, i) => i === detailBudget - 1 && idRows.length > detailBudget ? truncateToWidth(row + "…", inner) : row),
    truncateToWidth(notice ?? `${mcpStatusLabel(current)} · ${current.transport} · ${current.toolCount} tools`, inner),
  ];
  const fullDetails = [
    ...wrap(`${servers.filter((s) => s.state === "ready").length}/${servers.length} connected`),
    ...wrap(identity(current.server)),
    ...wrap(`${current.transport} · ${mcpToolCount(current)}${current.profile ? ` · ${current.profile}` : ""}`),
    ...wrap(current.enabled ? "Config: enabled" : "Config: disabled; check project trust"),
    ...(notice ? wrap(notice) : current.state === "error" ? wrap(mcpFailureHint(current)) : []),
  ];
  const details = height < 18 || fullDetails.length > budget - 1 ? compactDetails : fullDetails;
  const pageSize = Math.min(width < 48 ? 3 : 5, Math.max(1, budget - details.length));
  const start = Math.min(Math.max(0, index - Math.floor(pageSize / 2)), Math.max(0, servers.length - pageSize));
  const visible = servers.slice(start, start + pageSize);
  return {
    title: "MCP servers",
    lines: details,
    choices: visible.map((server, offset) => {
      const prefix = start + offset === index ? "❯" : " ";
      const state = mcpStatusLabel(server);
      // Keep the state readable when a long name needs to be shortened. The
      // full selected identity is wrapped above, so similar IDs stay distinct.
      return `${prefix} ${truncateToWidth(identity(server.server), Math.max(1, inner - state.length - 5))} · ${state}`;
    }),
  };
}
