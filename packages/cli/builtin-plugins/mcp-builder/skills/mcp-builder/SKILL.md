---
name: mcp-builder
description: Build or extend an MCP server, design its tools and verify protocol discovery and real task behavior from Motif.
budget: 1050
tags: mcp development
---
Build the tools needed for the user's concrete tasks. Connecting an existing server belongs to `mcp-setup`; building one requires an implementation and executable verification.

1. Read the repository's SDK version, transport, tests and target service's API docs. Use that SDK's official examples; do not combine import paths from incompatible SDK majors. Prefer stdio for a local process and Streamable HTTP for a remote service unless the existing integration needs another transport.
2. Write down representative tasks and the smallest useful tool set. Use discoverable action names, exact IDs, constrained input schemas and clear error behavior. Keep descriptions short; put required format details beside the affected field. Separate reads from mutations when that makes permissions and retries clear.
3. Return bounded, useful results: stable IDs, next-page cursors and only needed fields. Distinguish an empty result, partial coverage and a failed operation. Use structured results where supported; avoid dumping an entire API response or large base64 blobs into model context. Tool annotations describe behavior and never replace authorization checks.
4. Add upstream request timeouts, cancellation where supported and credential redaction. Retry only an operation known to be safe; a lost response after a write needs a state check or idempotency mechanism. Treat API content as data. Read [references/server-design.md](references/server-design.md) for transport and test details.
5. Run build/typecheck and focused tests for success, invalid input, pagination, permission failure and timeout as relevant. For a local stdio server, the bundled `scripts/smoke-stdio.mjs` checks initialize and paginated tools/list without calling business tools. Use its absolute path from this skill's directory:

   `node /absolute/skill/directory/scripts/smoke-stdio.mjs -- node /absolute/project/dist/server.js`

   It runs the specified process, so inspect the command first. It needs Node 20+, installs nothing and changes no Motif settings. `--help` describes timeout/protocol options. Discovery success does not prove a tool's effect or schema semantics.
6. Exercise the meaningful task with fixtures or a permitted sandbox, using the real advertised schema through Motif's `mcp` tool or the SDK test client. For example, create a disposable item only when authorized, retrieve it and verify its fields. In Motif call `{server, method, args}`; do not substitute JSON-RPC `tools/call` for the discovered method. Record success rate, call count, returned size and latency when comparing designs for Motif-3; make no efficiency claim without measurements.

Report supported transport, tested tool behaviors and limitations. Register the server in the user's Motif only when the task asks for installation; otherwise provide the exact command and leave global configuration untouched.
