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

**Edits made outside the running chat require a relaunch.** The `/mcp` catalog can register or enable a preset and connect it immediately in that chat. `/new` does not reload external configuration edits.

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
motif mcp connect docs --login
motif mcp login docs
motif mcp auth-status docs
motif mcp logout docs
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

Enter `/mcp` to open the connection manager. It shows registered servers with their connection state and tool count, followed by available built-in presets. Viewing the catalog never starts services or reads credentials. Select an available preset to review prerequisites and the destination configuration, then register and connect it in the same session. Filesystem asks for an explicit directory; Gmail remains a conditional preview with setup guidance. Existing disabled preset entries offer an explicit enable action. Enable other disabled servers with `motif mcp enable NAME`, then restart the session.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a server |
| `Enter` | Set up an available preset, enable a disabled preset entry, or connect/disconnect a registered server |
| `r` | Reconnect |
| `c` / `d` | Connect / disconnect |
| `l` | Set up an available preset, or sign in and reconnect |
| `Esc` | Close the manager, or stop waiting for a connection attempt |

The same controls are available as commands:

```text
/mcp list
/mcp connect docs
/mcp disconnect docs
/mcp reconnect docs
/mcp login docs
/mcp logout docs
```

These controls affect the current session. Disconnecting pauses the server and removes its tools from subsequent discovery until you connect it again. Reconnecting refreshes the connection and tool catalog; it does not replay previous calls. `/mcp list` only reads local status. Finish the current task and queued work before changing connections.

Pressing `Esc` while connecting stops waiting, but startup may continue in the background. Use `d` or `/mcp disconnect NAME` to close the connection. The manager can enable a disabled preset entry and register a preset without restarting. Changes made from another terminal or file editor still require a restart. If another process changes the selected registration, the manager refuses to overwrite it; relaunch and review the new configuration.

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

## Browser login and human approval

For an HTTP/SSE server supporting standard MCP OAuth, use `motif mcp connect NAME
--login`. Motif checks the connection, opens the provider's authorization page if
authentication is required, receives the loopback callback and checks the server
again. `motif mcp login NAME` starts a fresh login directly. In interactive chat,
an authentication failure offers **Sign in**; `/mcp login NAME` works explicitly.
The provider's page handles account selection and consent. Motif does not copy
Claude/Codex sessions or submit account consent on the user's behalf.

Discovery supports protected-resource metadata, authorization-server metadata,
PKCE and servers using dynamic registration or client metadata documents. If a
provider requires a pre-registered public client, use its supported client ID and
callback port:

```sh
motif mcp login service --client-id YOUR_PUBLIC_CLIENT_ID --callback-port 8765 --scope "read"
# For a provider supporting client metadata documents:
motif mcp login service --client-metadata-url https://your.example/client.json
```

These public OAuth options are saved in the server's `oauth` configuration. An
explicit config edit changes its trust hash. HTTPS is required except for local
loopback endpoints. A server with an explicit `Authorization` header continues to
use that credential; remove that header deliberately before switching to OAuth.
Provider allowlists and proprietary host connectors may still prevent login.
Generic OAuth support does not supply a provider's required client registration.

Tokens are stored in a private, atomic file under `~/.motif/` (mode `0600`), not
in MCP config, model messages or a Keychain. Refresh happens before connection or
tool dispatch, without silently opening a browser. `auth-status` reports local
credential state; it does not verify provider access. `logout` deletes local
credentials; `/mcp logout` also disconnects the current session. Neither revokes
the provider's account grant. Cancelled, denied and timed-out login attempts do
not count as successful connections.

Interactive MCP elicitation can ask for non-secret form fields or present a
provider URL. Motif asks before opening the URL and asks separately whether the
user completed the action. Password fields and noninteractive requests are
declined. Human interaction pauses the active network timeout, with a separate
three-minute ceiling; the original timeout resumes afterward. Concurrent calls
whose interaction cannot be attributed safely are declined. An elicitation
error after a tool call does not automatically repeat that call: verify the
service's state before retrying a potentially completed write.

## Import Codex or Claude configurations

```sh
motif mcp import codex ~/.codex/config.toml
motif mcp import claude /path/to/claude-config.json
motif mcp import claude /path/to/claude-config.json --project /exact/project/key
motif mcp import codex ~/.codex/config.toml --write ./mcp.imported.json
```

Import previews mappings and diagnostics without connecting. `--write` creates a new private file and never overwrites an existing file. Imported entries remain disabled. Review them, provide required environment variables, enable the desired entries and authorize the resulting file before use.

MCP imports cover common commands, arguments, working directories, URLs, headers, environment references, tool filters and timeouts. Inline credentials and fallback values are not copied. Unsupported settings are reported. OAuth sessions and client-specific approval stores are not imported. Skills use the separate [`motif skills import` workflow](skills.md); full plugin runtimes are not imported.

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

## Persistent GitHub MCP login

```sh
motif mcp install github --enable
motif mcp login github
motif mcp auth-status github
# A later process uses the same saved account:
motif mcp connect github
```

The preset uses `credentialProvider: "github-cli"` with the exact official HTTP
endpoint `https://api.githubcopilot.com/mcp/`. An explicit login validates the
account already saved by GitHub CLI; if missing or revoked, Motif offers GitHub's
browser device flow through `gh auth login`. The verification code appears only
in the human terminal panel, never in model context or session journals.

Motif saves a private delegation grant under `~/.motif/auth`, not a token copy.
Each new authenticated request resolves the current credential from GitHub CLI,
so restarting Motif needs no new login. On macOS, GitHub CLI normally uses Keychain;
its own credential storage policy applies. Ambient `GH_TOKEN`, `GITHUB_TOKEN`,
`GH_HOST` and `GH_CONFIG_DIR` overrides are not used for this provider.

`motif mcp logout github` clears Motif's grant and `/mcp logout github` also closes
the current connection. It does not run `gh auth logout` or revoke the GitHub
account. `auth-status` reports the saved local grant; successful connection or tool
use verifies current remote access. A revoked credential requires login again;
failed business calls are not automatically replayed. Existing token-reference
registrations are preserved, and `--token-env` opts out of GitHub CLI delegation.
This provider cannot be combined with OAuth options or an Authorization header,
and credentials cannot be delegated to an arbitrary endpoint.

## Built-in server presets

Browse the included catalog without network access or credentials:

```sh
motif mcp presets
motif mcp presets playwright
motif mcp install context7
motif mcp enable context7
motif mcp doctor --connect
```

`install` registers a reviewed preset in your MCP configuration. It does not download
packages, start a server, sign in, or modify an existing registration. New entries
are disabled unless you pass `--enable`. For stdio presets, the first connection
lets `npx` download and run the pinned package. The catalog ships with Motifcode;
the server programs and browsers are separate installations.

| Preset | Intended use | Prerequisites |
| --- | --- | --- |
| `context7` | Library documentation; recommended for general development | Public HTTP endpoint; optional API key for account limits |
| `github` | Repository, issue, PR and workflow tools | GitHub CLI (`gh`) installed; sign in once through `/mcp` or `motif mcp login github`. Optional `--token-env` uses a supplied token instead. |
| `playwright` | Browser navigation and inspection | Node/npm and Chrome; runs headless with an isolated browser profile |
| `filesystem` | Filesystem MCP compatibility | An explicit existing directory via `--root`; Motifcode also has native file tools |
| `hugging-face` | Public model, dataset and repository information | Public HTTP endpoint; optional HF token for authenticated capabilities |
| `openai-docs` | OpenAI developer documentation | Public read-only HTTP endpoint |
| `tauri` | Tauri application inspection | Community server; a running Tauri 2 application with its Rust MCP bridge plugin |
| `gmail` | Gmail integration, conditional preview | Google's preview/API prerequisites and your own OAuth access token; no built-in login or refresh |

```sh
motif mcp install playwright --enable
motif mcp install filesystem --root /absolute/project/path --enable
motif mcp install hugging-face --enable
motif mcp install openai-docs --enable
# Reference a token already supplied through your environment; never paste its value here.
motif mcp install context7 --token-env CONTEXT7_API_KEY --enable
motif mcp install gmail --token-env GMAIL_ACCESS_TOKEN
```

Each example is an alternative registration; installing an existing ID fails without
changing it. Token options store variable references only. Filesystem paths are fixed
to the selected directory rather than following future working directories. Review
the chosen directory before enabling access. Use the canonical paths reported by
`list_allowed_directories`; aliases such as macOS `/var` versus `/private/var` can
be rejected by the server. With `--mcp-config`, installation uses
the same current-hash trust checks as `add`; each edit returns a new hash.

Preset setup in `/mcp` applies immediately; CLI or file edits require relaunching
an existing session. `/new` does not reload external edits. A `ready` connection only proves initialization and tool
discovery: Gmail may advertise tools before rejecting an unauthenticated call, and
the Tauri server can be ready without an application bridge. Neither means that
account access or application control has been verified. Codex/Claude login sessions
are not transferred.

Maintainers can run an opt-in live smoke check from a source checkout:

```sh
pnpm exec tsx scripts/mcp-candidates-probe.ts /tmp/mcp-candidates.json
pnpm exec tsx scripts/mcp-tauri-gmail-smoke.ts /tmp/mcp-conditional.json
```

The first check uses the actual MCP manager to read a generated scratch file,
navigate a local test page, and query public documentation/model data. It needs
network access, npm and Chrome. The conditional check only asks Tauri for session
status and tries unauthenticated Gmail label discovery; it does not sign in, read
mail content, or send mail. Neither check uses a language model or tests model
tool selection. Remote catalogs and availability can change independently of the
pinned local server versions.

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
| `authentication_required` (HTTP 401) | Use `/mcp login NAME` or `motif mcp connect NAME --login` for standard OAuth, or supply the configured credential reference. |
| `permission_denied` (HTTP 403) | Check the credential's scopes, service eligibility and API enablement. |
| Explicit configuration is disabled | Review the file and pass its current hash with `--trust-mcp`. |
| A server added from another terminal is missing from `/mcp` | Relaunch Motif. Preset setup inside `/mcp` applies immediately. |
| A connected server has no available tools | Check its advertised tools, `allowedTools` and `deniedTools`. |
| A write has an unknown outcome | Check the service's actual state first. In an interactive session Motif asks you before running the identical call again; one-shot runs keep refusing it. Reconnecting does not make a repeat safe. Read-only tools can be called again. |

Large tool results can be retrieved in portions during the same conversation. Stored result handles expire and do not survive process restart or resume. Motifcode validates tool arguments against the server's schema and does not automatically repeat remote tool calls after failures.

| Capability | Support |
| --- | --- |
| stdio, Streamable HTTP, explicitly selected legacy SSE | Supported |
| Legacy and modern protocol negotiation | Supported; legacy is the default |
| Original JSON Schema, tool pagination and catalog changes | Supported |
| Static environment/header credentials | Supported |
| OAuth browser login and token refresh | Supported for compatible HTTP/SSE providers; provider registration may be required |
| Legacy form and URL elicitation | Interactive human approval; no automatic business-call replay |
| Modern multi-round `input_required` | Diagnosed; automatic continuation not supported |
| Resources, prompts, roots, sampling, tasks and MCP Apps | Not exposed |
| Images/audio as model multimodal input | Not supported |

A server requiring an unsupported capability may not work with Motifcode. Client-specific Codex and Claude extensions are separate from standard MCP tool support.
