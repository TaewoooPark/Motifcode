---
name: github-workflow
description: Investigate GitHub issues and pull requests, check the exact diff and CI, and carry out explicitly requested GitHub follow-up.
budget: 1000
tags: github review
---
Identify the repository and issue/PR from the user's URL or the checkout's remote. Keep review, local patching, posting and merging within the user's requested scope; prior explicit authorization still applies.

An explicit `OWNER/REPO` or GitHub URL already identifies the repository. Use it directly for metadata requests; a local checkout, `git remote` lookup or directory scan is unnecessary. Inspect the checkout's remote only when the repository was not supplied.

Use connected GitHub MCP schemas when available. The default GitHub preset uses the human’s saved GitHub CLI account after one explicit `/mcp` login; authorization survives restarts. If login is required, ask the human to sign in through `/mcp` or `motif mcp login github`. Never retrieve, display or copy a token, or handle the human device verification code. If missing, search with `mcp` and `{"server":"__motif_host__","method":"search","args":{"query":"GitHub pull request issue read files checks","limit":3}}`. Dispatch the returned server, exact method and argument object. Restrict searches by repository and page only until the requested evidence is covered.

An authenticated `gh` CLI is an alternative when MCP is unavailable and the task permits it. Check `command -v gh` and `gh auth status` without printing tokens. Read [references/gh-workflows.md](references/gh-workflows.md) for concrete commands. A missing MCP OAuth client registration is not fixed by copying another application's tokens.

For PR identity/status use `gh pr view NUMBER --repo OWNER/REPO --json title,state,headRefOid`; the head SHA field is `headRefOid`, not `headCommit`. Choose JSON fields from the command's documented schema before adding more.

For a PR review:

1. Read the description, linked issue, comments and diff. Record the head SHA. Read nearby code and callers for changed behavior. Distinguish the contributor's intended fix from claims actually demonstrated by tests.
2. Reproduce in an isolated checkout or preserve the existing checkout's changes before switching. Review install/build scripts before executing code from an external contribution. Use the existing `code-review` skill for findings and `test-fix` when investigation needs it.
3. Run the relevant tests, including one case that would fail without the fix. Inspect CI for the recorded head SHA; pending/skipped/missing checks are not passing checks. Recheck the head before a final recommendation or an authorized merge.
4. Report concrete findings with file/line, failing input and severity. Separate blockers from optional improvements. State the tests run and any unverified behavior.

For authorized follow-up, prepare an exact comment/body and link the relevant issue or commit. Reuse the existing `pr-body` skill for PR descriptions. Never post a draft or merge merely because review is finished. Conversely, do not ask again if the user already authorized that action and its stated conditions are satisfied.

Check the resulting GitHub URL and state after a write. If the request times out, read the resource before retrying to avoid duplicate issues/comments or an uncertain merge. Closing an issue is appropriate only when the requested work is actually resolved and that follow-up is authorized.
