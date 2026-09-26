# MCP server design and verification

## Transport details

For stdio, stdout contains newline-delimited JSON-RPC only. Send diagnostics to stderr, handle EOF and release resources. Do not print a startup banner into the protocol stream. The client initializes, checks the negotiated version, then sends `notifications/initialized` before normal operations.

For Streamable HTTP, use the SDK transport matching the installed version. Validate authorization and Origin as required by the service; bind a local service to loopback unless remote access is intended. Return authentication failures distinctly from lack of resource permission. Do not write a homegrown OAuth flow merely to make a demo connect.

## Test the task as well as the transport

The bundled discovery helper intentionally does not call arbitrary business tools. It supports the basic initialize/tools-list exchange, refuses unsupported client requests, bounds time/output/pages and fails on malformed stdout or duplicate tool names. It does not test HTTP, roots, sampling, elicitation, notifications, complete JSON Schema validity or authentication UX. Use the actual SDK or Inspector for those capabilities.

Useful behavioral cases:

- A paginated query returns every expected fixture once, with a cursor that eventually ends.
- A constrained input fails before contacting the upstream API.
- Missing authentication and denied resource access remain distinguishable.
- An upstream timeout cancels work; a mutation is not automatically repeated.
- Large data reports partial coverage or a retrievable reference instead of claiming completeness after truncation.
- Unicode text and file paths survive without double JSON encoding.

For a Motif comparison, hold the task, fixtures, model settings and endpoint constant. Count discovery and business calls separately. Include failed runs and cold-start costs rather than reporting only the fastest successful example.

Official references:

- Protocol lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Python SDK: https://github.com/modelcontextprotocol/python-sdk
- Inspector: https://github.com/modelcontextprotocol/inspector
- Upstream skill reference: https://github.com/anthropics/skills/tree/main/skills/mcp-builder

This bundle is an original Motif implementation; no upstream skill runtime or copied helper is required.
