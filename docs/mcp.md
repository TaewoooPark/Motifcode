# MCP servers

Connect MCP servers to give Motifcode access to external tools, including documentation, browsers and local services. Motifcode supports stdio, Streamable HTTP and legacy SSE servers. Requires Node 20.3 or later.

## Quick start

Register a public documentation server and check its connection:

```sh
motif mcp add docs --transport http https://developers.openai.com/mcp
motif mcp doctor --connect
motif -p "Use the docs MCP to explain the Responses API, citing the source."
```

For a local server, put its command and arguments after `--`:

```sh
motif mcp add local -- node /absolute/path/to/server.mjs
```

`add` saves an enabled entry in `~/.motif/mcp.json`. It does not install or start the server. Enabled servers start when you check their connections or use them in a Motif session. Use a server's documented command, keep local installations in a durable directory and pin package versions when possible. A GitHub repository URL identifies source code; it is not an HTTP MCP endpoint.

**After adding or editing servers, exit and relaunch any running Motif process.** `/new` and `/mcp` do not reload the configuration.

## Set up a server with the built-in skill

The built-in `mcp-setup` skill guides installation, registration and connection checks. It is available without installing another skill. Give Motifcode a clear setup request with the server's URL:

```text
Connect the MCP server at https://developers.openai.com/mcp to Motifcode and check that it connects.
```

```text
https://github.com/TaewoooPark/Trendchaser-mcp 이 MCP를 motifcode에 연결해줘. 연결되는지도 확인해줘.
```

For an explicit invocation in the interactive session, use:

```text
/mcp-setup https://github.com/TaewoooPark/Trendchaser-mcp
```

The skill checks the existing configuration, reads the server's setup instructions, prefers its documented package command and verifies that the connection reaches `ready`. It guides the model to preserve existing registrations, use environment references for credentials and prepare package downloads before checking a connection. User and project skill overrides work as usual.

Clear English and Korean setup requests containing a URL select the skill automatically; informational requests and quoted examples do not. Use `/mcp-setup` if your wording is not recognized. Setup uses Motifcode's ordinary tools and permissions: missing credentials or unsupported installation requirements can still need your input. A successful connection check confirms discovery, not that every server tool works.

## CLI commands

```sh
motif mcp --help
motif mcp list
motif mcp get docs
motif mcp doctor
motif mcp doctor --connect
motif mcp disable docs
motif mcp enable docs
motif mcp remove docs
```

`list`, `get` and ordinary `doctor` are offline. `get` withholds stored commands, arguments, URLs and credential values. `doctor --connect` starts enabled trusted servers, lists their tools and closes the connections without calling business tools. Only `ready` confirms a successful check; a server can be ready with zero tools.

Names must be unique. To replace an entry, remove it and add the replacement. Invalid configuration and concurrent edits fail instead of overwriting an existing file.

For stdio servers, all Motifcode options go before `--`; the command and its arguments go after it. HTTP and SSE registrations take a URL:

```sh
motif mcp add local --env-ref TOKEN=SERVICE_TOKEN -- node /absolute/path/to/server.mjs
motif mcp add remote --transport http --header 'Authorization=Bearer ${SERVICE_TOKEN}' https://example.com/mcp
motif mcp add legacy --transport sse --header-env X-Api-Key=SERVICE_TOKEN https://example.com/sse
```

`--env KEY=VALUE`, `--env-ref NAME[=SOURCE]`, `--header NAME=VALUE` and `--header-env NAME=SOURCE` may repeat. `--env-ref NAME` uses the same environment variable name. Private and custom headers require environment references. Export the referenced variables before launching Motif; registration does not resolve them. Avoid putting secrets directly in shell arguments or history.

`--protocol legacy|modern|auto` selects protocol negotiation. The default is `legacy`; use another mode only when required by the server. `auto` can start a second stdio process during negotiation.

## Manage connections in the TUI

Enter `/mcp` to open the connection manager. It shows each server's name, transport, connection state and discovered tool count.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a server |
| `Enter` | Connect, or disconnect a connected/connecting server |
| `r` | Reconnect |
| `c` / `d` | Connect / disconnect |
| `Esc` | Close the manager, or stop waiting for a connection attempt |

The same controls are available as commands:

```text
/mcp list
/mcp connect docs
/mcp disconnect docs
/mcp reconnect docs
```

These controls affect the current session. Disconnecting pauses the server and removes its tools from subsequent discovery until you connect it again. Reconnecting refreshes the connection and tool catalog; it does not replay previous calls. `/mcp list` only reads local status. Finish the current task and queued work before changing connections.

Pressing `Esc` while connecting stops waiting, but startup may continue in the background. Use `d` or `/mcp disconnect NAME` to close the connection. A disabled entry must be enabled with `motif mcp enable NAME`, followed by a process restart. Registration changes also require a restart.

## Configuration and trust

The default user configuration is `~/.motif/mcp.json`. You can also edit it directly:

```json
{
  "version": 1,
  "servers": [
    {
      "id": "files",
      "enabled": true,
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "cwd": "/absolute/path/to/scratch",
      "env": {"TOKEN": {"env": "SERVICE_TOKEN"}},
      "allowedTools": ["read_text_file", "list_directory"],
      "startupTimeoutMs": 20000,
      "toolTimeoutMs": 30000
    }
  ]
}
```

Use the actual tool names advertised by your server in `allowedTools`. `deniedTools` takes precedence. A relative `cwd` resolves from the configuration file. Commands run with argument arrays, without an implicit shell. Startup defaults to 10 seconds and tool operations to 30 seconds; prepare package downloads in advance or adjust `startupTimeoutMs` for slower servers.

The user configuration is trusted. Project `.mcp.json` and `.motif/mcp.json` files are not discovered automatically. To use another file, review its contents and authorize its exact SHA-256:

```sh
motif mcp list --mcp-config ./mcp.json
# Review the file and copy the displayed sources[].sha256.
motif --mcp-config ./mcp.json --trust-mcp REVIEWED_SHA256 "your task"
```

Use `--mcp-config` with management commands to edit another file. Creating a new file does not require a hash; editing an existing one does:

```sh
motif mcp add docs --mcp-config ./mcp.json --transport http https://developers.openai.com/mcp
motif mcp disable docs --mcp-config ./mcp.json --trust-mcp REVIEWED_SHA256
```

Each edit prints the new hash. Review and authorize that new hash before connecting; approval of earlier contents does not carry over.

## Import Codex or Claude configurations

```sh
motif mcp import codex ~/.codex/config.toml
motif mcp import claude /path/to/claude-config.json
motif mcp import claude /path/to/claude-config.json --project /exact/project/key
motif mcp import codex ~/.codex/config.toml --write ./mcp.imported.json
```

Import previews mappings and diagnostics without connecting. `--write` creates a new private file and never overwrites an existing file. Imported entries remain disabled. Review them, provide required environment variables, enable the desired entries and authorize the resulting file before use.

Imports cover common commands, arguments, working directories, URLs, headers, environment references, tool filters and timeouts. Inline credentials and fallback values are not copied. Unsupported settings are reported. OAuth sessions, client-specific approval stores, skills and plugins are not imported.

## Credentials and permissions

Use environment references in JSON configuration as well as CLI commands:

```json
{
  "version": 1,
  "servers": [{
    "id": "remote",
    "enabled": true,
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": {"Authorization": "Bearer ${SERVICE_TOKEN}"}
  }]
}
```

References accept `${VARIABLE}`, `${VARIABLE:-fallback}` or `{"env":"VARIABLE"}`. An unset reference without a fallback fails. Stdio servers inherit a small process-startup environment; pass other variables explicitly through `env` or `envVars`. `MOTIF_API_KEY` is removed before MCP clients are constructed, so it cannot be forwarded by that variable name. Do not supply model credentials under other names or as literal values. Browser cookies and other clients' login sessions are not imported.

Interactive `ask` mode confirms the actual server and tool. Remembered approvals apply to that pair only. Tools marked as requiring user interaction need fresh human approval, including in `auto` mode. Print and one-shot execution have no interactive approval dialog, so use configurations whose permitted tools you intend to authorize. An enabled stdio server is a local program; Motifcode does not provide an OS sandbox for it.

## Playwright browser tools

Use the Playwright profile to get a fresh page observation after browser actions:

```sh
motif mcp add playwright --profile playwright -- npx -y @playwright/mcp@0.0.82 --headless --isolated --browser chrome --image-responses omit --snapshot-mode none --codegen none
motif mcp doctor --connect
```

The profile pairs supported navigation and form actions with `browser_snapshot`. It uses the same permissions and tool filters as other calls; allow `browser_snapshot` if you use an allowlist. The snapshot flags avoid duplicate automatic snapshots. Motifcode does not change the server arguments you registered. If the observation fails after an action, the action is not repeated automatically.

## Troubleshooting and compatibility

| Symptom | Check |
| --- | --- |
| Server stays `connecting` or times out | Run its documented installation first; check the executable path and `startupTimeoutMs`. |
| Credential reference cannot be resolved | Export the named variable before launching Motif. |
| Explicit configuration is disabled | Review the file and pass its current hash with `--trust-mcp`. |
| A newly registered server is missing from `/mcp` | Exit and relaunch the Motif process. |
| A connected server has no available tools | Check its advertised tools, `allowedTools` and `deniedTools`. |
| A write has an unknown outcome | Check the service's actual state before retrying; reconnecting does not make a repeat safe. |

Large tool results can be retrieved in portions during the same conversation. Stored result handles expire and do not survive process restart or resume. Motifcode validates tool arguments against the server's schema and does not automatically repeat remote tool calls after failures.

| Capability | Support |
| --- | --- |
| stdio, Streamable HTTP, explicitly selected legacy SSE | Supported |
| Legacy and modern protocol negotiation | Supported; legacy is the default |
| Original JSON Schema, tool pagination and catalog changes | Supported |
| Static environment/header credentials | Supported |
| OAuth browser login and token refresh | Not supported |
| Resources, prompts, roots, sampling, elicitation, tasks and MCP Apps | Not exposed |
| Images/audio as model multimodal input | Not supported |

A server requiring an unsupported capability may not work with Motifcode. Client-specific Codex and Claude extensions are separate from standard MCP tool support.
