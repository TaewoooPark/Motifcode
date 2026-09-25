# MCP adapter

This branch starts from the npm **0.3.4** source (`4570d635a6776c12ce281ddeed3aa607ed00a924`). The adapter is unreleased. Build this checkout to use it:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/motif.js mcp --help
```

Requires **Node 20.3 or later**. MCP cancellation uses [`AbortSignal.any`, added in Node 20.3.0](https://nodejs.org/download/release/v20.20.1/docs/api/globals.html#static-method-abortsignalanysignals). Copied-artifact stdio/HTTP connection checks passed on Node 20.3.0 and 20.20.2; Node 20.0.0 starts the CLI but cannot connect to MCP servers.

MCP servers extend Motifcode through one canonical `mcp` tool. Their original tool names and JSON Schemas stay authoritative. They do not add hundreds of native tools or change the order of Motif-3's cached tool prefix.

## Configure a server

Create `~/.motif/mcp.json` deliberately; this user-level file is trusted. For example, the public OpenAI documentation server needs no credential:

```json
{
  "version": 1,
  "servers": [
    {
      "id": "docs",
      "enabled": true,
      "transport": "http",
      "url": "https://developers.openai.com/mcp"
    }
  ]
}
```

```sh
motif mcp list
motif mcp doctor
motif mcp doctor --connect
motif -p "Use the docs MCP to explain the Responses API allowed_tools parameter, citing the source."
```

Use `node packages/cli/dist/motif.js` in place of `motif` when testing the local build. `list` and `doctor` are offline unless `--connect` is explicit. A connection check starts trusted, enabled servers and lists their tools, then closes them. It does not call business tools. Normal agent sessions connect enabled servers when preparing discovery and reuse active connections; a closed connection can be re-established for a later operation.

A stdio example using a pinned reference server:

```json
{
  "version": 1,
  "servers": [
    {
      "id": "files",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "/absolute/path/to/scratch"],
      "allowedTools": ["read_text_file", "write_file", "list_directory"],
      "startupTimeoutMs": 20000,
      "toolTimeoutMs": 30000
    }
  ]
}
```

Install/pin a server in advance and use its executable when avoiding package download startup cost matters. Commands are spawned with argument arrays, without an implicit shell. Set `cwd` explicitly if the server uses relative storage; a relative `cwd` resolves from the config file.

An explicit project config is disabled until you review and authorize its exact contents:

```sh
motif mcp list --mcp-config ./mcp.json
# Read the file, then copy the displayed sources[].sha256:
motif --mcp-config ./mcp.json --trust-mcp REVIEWED_SHA256 "your task"
```

Project `.mcp.json` and `.motif/mcp.json` files are never discovered or executed automatically. Editing an explicitly trusted file changes its hash and revokes that authorization. The default user file and the explicit file are distinct trust cases.

## Import Codex and Claude configurations

```sh
motif mcp import codex ~/.codex/config.toml
motif mcp import claude /path/to/claude-config.json
motif mcp import claude /path/to/claude-config.json --project /exact/project/key
motif mcp import codex ~/.codex/config.toml --write ./mcp.imported.json
```

Import previews mappings and diagnostics without connecting. `--write` creates a **new** file with mode `0600`; it never overwrites an existing file. Imported servers remain disabled. Review them, supply required environment variables, and set `enabled: true` before authorizing the file.

Imports cover common server commands, arguments, working directories, URLs, headers, environment references, tool filters and timeouts. Inline credentials and inline fallback values are not copied. Unsupported settings are reported; an unsupported policy cannot silently become a more permissive configuration. OAuth sessions and client-specific trust/approval stores are not transferable. Importing a config does not install skills, extensions or plugins.

## Credentials and permissions

Use environment references for credentials:

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

Native config also accepts `{"env":"VARIABLE_NAME"}` and `${VARIABLE:-fallback}` values; an unset reference without a fallback fails. Export service credentials in the launching shell. The CLI removes `MOTIF_API_KEY` from its environment before constructing MCP clients, so that variable is unavailable for inheritance or environment-reference forwarding. This is not a general detector for the same credential supplied under another name or as an explicit value. A small process-startup environment allowlist is inherited; other stdio variables require explicit `env`/`envVars`. HTTP uses only the configured endpoint/headers; redirects and cross-origin session endpoints are rejected. Browser cookies and other clients' login sessions are not imported.

`allowedTools` is an optional exact-name allowlist; `deniedTools` takes precedence. Server annotations and descriptions cannot grant permission. Interactive `ask` mode confirms the actual `server/method`, and remembered approval applies only to that pair. A tool with `_meta["anthropic/requiresUserInteraction"]: true` requires fresh human approval even in `auto` mode; headless execution cannot satisfy it. Read-only child agents cannot dispatch MCP calls.

As in existing Motifcode 0.3.4, print/one-shot execution has no interactive approval dialog. Run it only with a config whose permitted tools you intend to authorize. The adapter is not an OS sandbox: an enabled stdio server is a local program, and its own file/network access remains your responsibility.

## How Motif-3 sees tools and results

The native tool block stays `done, bash, read, write, apply_patch, term, skill, task, mcp` when MCP is enabled (the previous eight-tool prefix otherwise). Calls have this shape:

```json
{"server":"files","method":"write_file","args":{"path":"/scratch/note.txt","content":"안녕하세요\n"}}
```

`args` is a JSON object, avoiding a second layer of JSON-string escaping. The tool linter permits this one nested envelope; other core tool schemas keep their original constraints. Native MCP argument bytes and reasoning history are retained when they match the parsed invocation.

The default `prefetch` mode adds a bounded selection of three relevant original schemas **after** the user task. Stable English word normalization and Korean capability aliases help find tools without changing identifiers. A compact server tool-name index supports discovery. There is no additional model/router request.

Local controls share the reserved server `__motif_host__`:

| Method | Purpose |
| --- | --- |
| `search` | Search allowed tools; up to eight exact schema cards |
| `describe` | Retrieve a specific allowed tool's original schema |
| `read_result` | Read a stored result by JSON Pointer, line range or character range |
| `find_result` | Find an exact literal in stored text, with counts, offsets and excerpts |

The full control schemas and examples are supplied to the model. Remote `method` means the tool name, not the JSON-RPC method `tools/call`.

Small results are returned in full within a 16,000-byte model-output budget. Large results retain the original value in a conversation-local store and return an opaque handle, structural paths, explicit coverage and a concrete next call. There is no automatic semantic summary. `_meta` and binary payloads are excluded from the text projection; coverage reports that exclusion. `structuredContent`, text and business errors remain distinguishable. JSON is bounded as structured data, never cut into malformed head/tail fragments.

For large results, the host can also select up to six literal terms from the original task and include bounded exact-match excerpts. This is deterministic text matching, with partial coverage retained; it does not use another model or make a whole-result success claim.

Handles are not files. They are scoped to a conversation or child, expire after 15 minutes and can be evicted (64 entries, 32 MiB total, 8 MiB per original result). They do not survive process restart/resume. A missing handle is not permission to repeat a write. Character offsets use UTF-16 units; pagination does not split a surrogate pair. Exact-match counts establish only that literal predicate over the visible projection, not global business success.

The adapter validates the original JSON Schema locally, without coercion, injected defaults or fetching external references. Invalid arguments never reach the remote tool. Error responses distinguish `not_started`, `completed` and `unknown`. Business `isError` is a failed tool result, even when the transport succeeded. The adapter never automatically replays a remote call; identical in-flight/unknown calls are blocked across child scopes for the lifetime of the manager. This ledger is in memory, not durable across process restarts. Reconcile an unknown write with an independent read or with the service operator.

### Bounded format recovery

In the default `toolcall` channel, Motif-3 occasionally prints `{server, method, args}` as an answer instead of calling `mcp`. A strict detector recognizes complete JSON objects or JSON/bare Markdown fences for tools in the already-allowed catalog. It does not execute, repair or translate that text. Instead, the loop asks the model once to issue a proper call if the original task authorizes an unfinished action, or to explain in ordinary prose if it was only an example. The next call still passes the usual schema, policy and human-approval checks.

The one-attempt budget belongs to the task and is saved in its checkpoint. Successful tool calls, context compaction and resume do not replenish it. Existing cancellation and turn limits apply. If the model again returns invocation-shaped JSON, the task stops as `no_action_limit` with a visible explanation. Ordinary responses add no model round trip. A legitimate JSON example matching this narrow shape can incur one clarification; it is never executed by the detector. The experimental `object` and `raw` channels do not use this recovery.

This handles an unissued call, not an unknown remote outcome. Invalid arguments can already be corrected by the model using the returned schema/error. A completed business error may have partial effects, and a lost response may hide a completed write; neither authorizes a blind retry. Recovery guidance explicitly retains the earlier results and warns against repeating completed or unknown writes.

### Playwright profile

Opt into `"profile":"playwright"` on a trusted Playwright server entry to pair browser actions with one fresh `browser_snapshot({})` observation. Both arrive in the same model turn, avoiding a separate model request just to retrieve the screen. This profile does not add native tools or change remote arguments. For the tested `@playwright/mcp@0.0.82`, the recommended server configuration is:

```json
{
  "servers": [{
    "id": "playwright",
    "enabled": true,
    "transport": "stdio",
    "profile": "playwright",
    "command": "npx",
    "args": ["-y", "@playwright/mcp@0.0.82", "--headless", "--isolated", "--browser", "chrome", "--image-responses", "omit", "--snapshot-mode", "none", "--codegen", "none"]
  }]
}
```

In default `prefetch` mode, a clear browser form-filling request prioritizes the original navigate, fill_form and click schemas, within the existing three-card/byte budget. This prevents names mentioned in a prohibition (such as “do not use browser_evaluate”) from crowding out the form contract. It only selects tools already in the allowed catalog and never dispatches them. If multiple Playwright profiles exist, a single explicitly quoted server ID is required to choose one; ambiguous tasks keep ordinary search ranking. Unavailable tools are skipped, and absence of all three falls back to ordinary search. `catalog` and `search` comparison modes are unchanged. This is a narrow prefetch heuristic, not a natural-language permission interpreter.

The supported [`snapshot-mode` and `codegen` settings](https://github.com/microsoft/playwright-mcp#configuration) remove the automatic snapshot file and echoed code. An explicit `browser_snapshot({})` still supplies inline accessibility text. Motifcode does not silently change your configured server arguments. Without these flags, the profile still observes but can duplicate the server's snapshot work.

The observation re-enters the ordinary executor: allowlists, execution policy, per-method confirmation, hooks, original-schema validation and mandatory interaction approval all remain in force. The profile must be explicitly configured; a server's read-only annotation alone never enables it. If `browser_snapshot` is missing, denied, cancelled or fails, a completed action remains completed and is not replayed. Unknown/not-started actions have no automatic follow-up. The separate observation outcome is retained in the result and visible in the journal; it is not counted as another model-generated tool call.

A failing non-blocking `PostToolUse` hook cannot append plain text to a bounded MCP envelope: the original JSON, execution state and snapshot references remain intact. Hook failure still emits the existing `onHook` event for connected UI/journal consumers; callers without that callback do not receive the hook detail in model-facing MCP output.

This covers navigate/back, click, fill_form, type, press_key and select_option. A completed business error can also be followed by a snapshot to show the actual state; the original error remains an error. Snapshot reads never trigger another snapshot. The runtime guidance explains bare reference values, numeric `spinbutton` inputs using the schema's `textbox` fill type, filling related fields together, and checking actual values before submission. It does not invent selectors or rewrite field values. Oversized combined results keep bounded handles and point to the nested snapshot text for retrieval. Other MCP servers retain the generic behavior.

Validation errors include bounded field paths, missing/additional property names and expected types. A complete original input schema is included when it is at most 8,000 bytes and fits the response budget; otherwise a concrete `describe` call guides recovery. A schema-change error omits the previously fetched stale schema. No automatic corrected call is made.

Connections and catalogs are reused per server/auth context, with TTL and `tools/list_changed` invalidation. Defaults are 10 seconds for startup, 30 seconds for a tool operation and at most 30 seconds for catalog reuse. Modern server cache hints can shorten that reuse; an absent modern TTL means no catalog reuse. Pagination is limited to 64 pages, and stdio messages to 10 MiB. Cancellation closes the affected connection; simultaneous calls on that same connection can also become unknown. Shutdown gives the SDK time to close the stdio process, escalating from stdin closure to SIGTERM and SIGKILL, with a five-second outer close bound.

## Compatibility boundary

| Capability | Current support |
| --- | --- |
| stdio, Streamable HTTP, explicitly selected legacy SSE | Implemented and covered by real SDK integration tests |
| Legacy protocol negotiation | Default; tested against public/reference servers |
| Modern `2026-07-28` | Explicit `"protocol":"modern"`; local SDK integration coverage |
| `"protocol":"auto"` | Explicit opt-in; negotiation probing can start a second stdio process |
| Original JSON Schema draft-07, 2019-09, 2020-12 | Validated; unsupported/unsafe schemas fail closed |
| Tool pagination, change notifications, schema drift | Supported; a changed reviewed schema blocks dispatch |
| Static environment/header credentials | Supported |
| OAuth browser login / refresh | Not implemented |
| Resources, prompts, roots, sampling, elicitation, tasks, MCP Apps | Not exposed by this tools adapter |
| Images/audio as model multimodal input | Not implemented; binary payloads are withheld from the text view |
| Arbitrarily large individual schemas | Not simplified silently; oversize discovery fails explicitly |

A server that requires an unsupported capability is not fully compatible. This implementation does not claim parity with every proprietary Codex/Claude client extension.

Modern `input_required` responses are not automatically fulfilled or replayed. They return an interaction error with an unknown execution outcome. A tool requiring the tasks extension is rejected before dispatch; merely advertising an optional capability does not enable it.

## Reproduce evaluation

```sh
pnpm typecheck
pnpm lint:tools
pnpm test
pnpm build
pnpm exec tsx scripts/mcp-live-eval.ts --help
```

The opt-in live harness uses the actual model transport, native tool block, executor and adapter. Supply a scratch working directory, a reviewed MCP config, a task and an independent grade file. It writes usage, source/config fingerprints, response timing, tool traces and exact artifact checks. Model credentials and reasoning text are not recorded. Tool outputs can contain task data: inspect evidence before sharing.

`--mcp-mode catalog` and `--mcp-mode search` are comparison controls. `catalog` appends up to 64 KiB of full schemas; `search` starts with controls and the tool-name index. Neither changes the native tool block. Report task success separately from tool correctness, native-tool fallback, latency and tokens; cache/network variation and model nondeterminism make a single run insufficient for an optimum claim.

See [the implementation experiment report](mcp-validation.ko.md) for measured Motif-3 tasks, failures, fixes and remaining limitations.
