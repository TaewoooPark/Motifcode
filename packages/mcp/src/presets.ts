import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServerConfig } from "./config.js";

export interface McpPreset {
  id: string;
  title: string;
  description: string;
  publisher: "official" | "community";
  sourceUrl: string;
  prerequisites: string[];
  authentication: string;
  options: ("root" | "token-env")[];
  config: McpServerConfig;
}

// Built-in recipes are inert metadata. Local packages are pinned; installing a
// recipe registers its command and does not download, spawn, or connect to it.
const PRESETS: McpPreset[] = [
  {
    id: "context7", title: "Context7", publisher: "official",
    description: "Current library documentation and code examples.",
    sourceUrl: "https://github.com/upstash/context7",
    prerequisites: ["Network access to mcp.context7.com."],
    authentication: "Optional API key: --token-env CONTEXT7_API_KEY stores a Bearer reference. Anonymous access has service limits.",
    options: ["token-env"],
    config: { id: "context7", enabled: false, transport: "http", url: "https://mcp.context7.com/mcp" },
  },
  {
    id: "github", title: "GitHub", publisher: "official",
    description: "GitHub repository, issue, pull request and workflow tools.",
    sourceUrl: "https://github.com/github/github-mcp-server",
    prerequisites: ["Network access to api.githubcopilot.com and an authorized GitHub account.", "GitHub CLI (gh) installed for browser login and durable system credential storage."],
    authentication: "Run motif mcp login github to authorize the existing GitHub CLI account or sign in. Credentials stay in gh storage and are resolved privately on each request. Optional --token-env GITHUB_PERSONAL_ACCESS_TOKEN replaces this provider with a Bearer environment reference.",
    options: ["token-env"],
    config: { id: "github", enabled: false, transport: "http", url: "https://api.githubcopilot.com/mcp/", credentialProvider: "github-cli" },
  },
  {
    id: "hugging-face", title: "Hugging Face", publisher: "official",
    description: "Search Hugging Face models, datasets, Spaces, and papers.",
    sourceUrl: "https://huggingface.co/docs/hub/agents-mcp",
    prerequisites: ["Network access to huggingface.co."],
    authentication: "Optional Hugging Face token: --token-env HF_TOKEN stores a Bearer reference. Available tools and access depend on the account and service settings.",
    options: ["token-env"],
    config: { id: "hugging-face", enabled: false, transport: "http", url: "https://huggingface.co/mcp" },
  },
  {
    id: "openai-docs", title: "OpenAI developer documentation", publisher: "official",
    description: "Search and read OpenAI developer documentation.",
    sourceUrl: "https://developers.openai.com/learn/docs-mcp",
    prerequisites: ["Network access to developers.openai.com."],
    authentication: "No authentication required.", options: [],
    config: { id: "openai-docs", enabled: false, transport: "http", url: "https://developers.openai.com/mcp" },
  },
  {
    id: "playwright", title: "Playwright", publisher: "official",
    description: "Browser automation with Motif's Playwright profile and bounded text responses.",
    sourceUrl: "https://github.com/microsoft/playwright-mcp",
    prerequisites: ["Node.js and npx on PATH; first connection may download the pinned npm package.", "Google Chrome installed. Uses a headless, isolated browser session."],
    authentication: "No account required. The isolated browser does not reuse your browser login.", options: [],
    config: { id: "playwright", enabled: false, transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@0.0.82", "--headless", "--isolated", "--browser", "chrome", "--image-responses", "omit", "--snapshot-mode", "none", "--codegen", "none"], profile: "playwright", startupTimeoutMs: 60_000 },
  },
  {
    id: "filesystem", title: "Filesystem reference server", publisher: "official",
    description: "Filesystem tools scoped to one explicitly selected directory; overlaps Motif's native file tools.",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    prerequisites: ["Node.js and npx on PATH; first connection may download the pinned npm package.", "Required --root PATH must select an existing directory. Tools can read and write within this directory."],
    authentication: "No authentication required. The selected root defines filesystem access.", options: ["root"],
    config: { id: "filesystem", enabled: false, transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31"], startupTimeoutMs: 60_000 },
  },
  {
    id: "tauri", title: "Tauri MCP (Hypothesi)", publisher: "community",
    description: "Inspect and automate a running Tauri 2 application with the community MCP bridge.",
    sourceUrl: "https://github.com/hypothesi/mcp-server-tauri",
    prerequisites: ["Node.js and npx on PATH; first connection may download the pinned npm package.", "A running Tauri 2 app configured with the matching tauri-plugin-mcp-bridge Rust plugin. Installing this recipe does not instrument an app."],
    authentication: "Local development bridge; follow the project's setup and access guidance.", options: [],
    config: { id: "tauri", enabled: false, transport: "stdio", command: "npx", args: ["-y", "@hypothesi/tauri-mcp-server@0.13.0"], startupTimeoutMs: 60_000 },
  },
  {
    id: "gmail", title: "Gmail MCP (preview)", publisher: "official",
    description: "Conditional preview integration for an authorized Gmail account.",
    sourceUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
    prerequisites: ["Google Workspace Developer Preview access, your own Google Cloud project/OAuth client, and enabled gmail.googleapis.com and gmailmcp.googleapis.com APIs.", "Supply your own OAuth access token in an environment variable. Motif does not log in, refresh tokens, or configure OAuth clients.", "A successful tools/list or doctor --connect does not verify account authentication; Gmail tools still require an authorized token."],
    authentication: "Required --token-env GOOGLE_ACCESS_TOKEN stores a Bearer reference. Token scopes and preview access must permit the requested tools.",
    options: ["token-env"],
    config: { id: "gmail", enabled: false, transport: "http", url: "https://gmailmcp.googleapis.com/mcp/v1" },
  },
];

/** Return detached metadata so callers cannot modify future installations. */
export function listMcpPresets(): McpPreset[] { return structuredClone(PRESETS); }
export function getMcpPreset(id: string): McpPreset | undefined {
  const preset = PRESETS.find((entry) => entry.id === id);
  return preset && structuredClone(preset);
}

export class McpPresetError extends Error {
  constructor(readonly code: "unknown_preset" | "invalid_option", message: string) { super(message); this.name = "McpPresetError"; }
}
export interface McpPresetOptions { cwd?: string; root?: string; tokenEnv?: string; enabled?: boolean }

/** Build configuration without reading credentials or making a connection. */
export function createMcpPresetConfig(id: string, options: McpPresetOptions = {}): McpServerConfig {
  const preset = getMcpPreset(id);
  if (!preset) throw new McpPresetError("unknown_preset", "Unknown built-in MCP preset. Use motif mcp presets to list available IDs.");
  if (options.root !== undefined && !preset.options.includes("root")) throw new McpPresetError("invalid_option", "--root is supported only by the filesystem preset.");
  if (options.tokenEnv !== undefined && !preset.options.includes("token-env")) throw new McpPresetError("invalid_option", "--token-env is not supported by this preset.");
  if (options.tokenEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenEnv)) throw new McpPresetError("invalid_option", "--token-env requires an environment variable name, not a credential value.");
  if (id === "gmail" && !options.tokenEnv) throw new McpPresetError("invalid_option", "The Gmail preview requires --token-env with your OAuth access token's environment variable name.");
  const server = preset.config;
  server.enabled = options.enabled === true;
  if (id === "filesystem") {
    if (!options.root) throw new McpPresetError("invalid_option", "The filesystem preset requires an explicit --root PATH.");
    let root: string;
    try {
      root = realpathSync(resolve(options.cwd ?? process.cwd(), options.root));
      if (!statSync(root).isDirectory() || root.includes("${")) throw new Error("Invalid root");
    } catch { throw new McpPresetError("invalid_option", "--root must resolve to an existing directory without environment expressions."); }
    server.args!.push(root);
  }
  if (options.tokenEnv) { delete server.credentialProvider; server.headers = { Authorization: `Bearer \${${options.tokenEnv}}` }; }
  return server;
}
