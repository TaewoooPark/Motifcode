import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { createMcpPresetConfig, defaultMcpConfigPath, getMcpPreset, McpClientError, resolveServerConfig, type McpConfig, type McpSession, type McpStatus } from "@motifcode/mcp";
import { McpConfigEditError, updateMcpConfig, type McpConfigEditOptions } from "./mcp-config-edit.js";

export interface McpCatalogInstallOptions { root?: string; tokenEnv?: string }

/** Human-approved catalog actions, separate from the model-facing MCP tool. */
export class McpCatalogRuntime {
  private trustHash?: string;
  readonly configLabel: string;

  constructor(
    private readonly session: McpSession,
    private readonly snapshot: McpConfig,
    private readonly options: McpConfigEditOptions & { env?: NodeJS.ProcessEnv } = {},
  ) {
    this.trustHash = options.trustHash;
    this.configLabel = options.path
      ? `Selected configuration: ${resolve(options.cwd ?? process.cwd(), options.path)}`
      : `User configuration: ${defaultMcpConfigPath(options.home)}`;
  }

  /** Consent is collected by the TUI before invoking this callback. */
  async install(id: string, options: McpCatalogInstallOptions, signal: AbortSignal): Promise<McpStatus> {
    if (signal.aborted) throw new McpClientError("cancelled", "MCP installation was cancelled.");
    if (!getMcpPreset(id)) throw new McpConfigEditError("unknown_preset", "Unknown built-in MCP preset.");
    const previous = this.snapshot.servers.find((entry) => entry.id === id);
    if (previous && (options.root !== undefined || options.tokenEnv !== undefined)) {
      throw new McpConfigEditError("config_conflict", "The existing configuration is preserved. Change its options explicitly before restarting Motif.");
    }
    const candidate = previous
      ? { ...structuredClone(previous), enabled: true }
      : createMcpPresetConfig(id, { ...options, cwd: this.options.cwd, enabled: true });
    // Validate prerequisites before persistence, without making network calls or
    // resolving GitHub CLI credentials. Never serialize expanded credentials.
    try { resolveServerConfig(candidate, this.options.env ?? process.env); }
    catch { throw new McpConfigEditError("invalid_environment", "MCP prerequisites are incomplete. Check the configured environment references before installing; no changes were saved."); }
    this.session.manager.assertCanRegisterTrustedServer(candidate);
    const edited = updateMcpConfig({ ...this.options, trustHash: this.trustHash }, (current) => {
      const existing = current.servers.find((entry) => entry.id === id);
      if (!isDeepStrictEqual(previous, existing)) {
        throw new McpConfigEditError("config_changed", "This server's configuration changed outside the current session. Restart Motif to review it before enabling or installing.");
      }
      if (existing) existing.enabled = true;
      else current.servers.push(candidate);
      return current;
    });
    // Only our exact successful edits advance project trust. A later external
    // change still requires a new SHA approval; unrelated user edits survive.
    this.trustHash = edited.sha256;
    const installed = edited.config.servers.find((entry) => entry.id === id)!;
    this.session.registerTrustedServer(installed);
    try { return await this.session.connect(id, signal); }
    catch (cause) {
      const status = this.session.statuses().find((entry) => entry.server === id);
      // Authentication-required is a recoverable UI state: the catalog can
      // offer explicit login and reconnect the already registered server.
      if (status?.state === "error") return status;
      throw cause;
    }
  }
}
