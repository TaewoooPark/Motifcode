---
name: browser-testing
description: Reproduce web UI bugs and verify browser workflows with Playwright MCP or the project's existing browser tests.
budget: 1100
tags: browser verify mcp
---
Choose the shortest route that proves the requested browser behavior.

- Use Playwright MCP for an unfamiliar page, iterative inspection or a flow that needs a persistent browser session.
- Use the repository's existing Playwright test runner for repeatable assertions and regressions. Prefer its locked dependency and scripts over downloading another CLI. Read [references/test-workflows.md](references/test-workflows.md) when writing a test or using an installed Playwright CLI.
- Follow an explicit MCP-only or browser choice from the user. Do not claim an HTTP request or static HTML read tested an interactive UI.

For MCP exploration:

1. Establish the intended URL, expected result and whether the target is local/test or a live account. If a local app must run, inspect its scripts and use `term` for the server; wait for its actual ready URL. Do not change ports, dependencies or settings without a concrete need.
2. Use schemas already supplied to the session. Otherwise search with `mcp` and `{"server":"__motif_host__","method":"search","args":{"query":"browser navigate snapshot click","limit":3}}`. Call tools with the returned server ID, method and argument object.
3. Navigate, then observe the page. The Motif Playwright preset can omit automatic snapshots, so request a snapshot when navigation returns no actionable references. Use exact references from the current page. Refresh after navigation or a stale-reference error; do not guess IDs or substitute a CSS selector into a reference field.
4. Perform the smallest interaction that exercises the bug. Inspect the resulting page and any relevant console/network errors. Verify a user-visible outcome: changed row, persisted value, validation message or destination URL. A successful click alone does not establish success.
5. Check the relevant edge case, such as empty input, repeated submission or narrow viewport. For visual changes capture a screenshot when supported; only claim visual inspection if an available image-capable tool actually inspected it. Otherwise report layout measurements and the saved screenshot separately.

The default browser is isolated and does not share the person's Chrome login. Stop for required human sign-in instead of reading cookies or credentials. Actions on live services stay within the user's authorization; a testing request does not authorize sending messages, purchases or deleting records. If a write times out, inspect its resulting state before considering a retry.

Summarize the URL/environment, tested steps, observed outcome and unresolved limitations. Keep reproduction evidence and any test artifact in the project; do not include session secrets.
