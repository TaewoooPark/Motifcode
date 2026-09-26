# Repeatable browser verification

Inspect `package.json`, Playwright config and nearby tests first. Run the project's existing test script against the relevant test file. Avoid `npx` commands that silently download an unrelated test runner; use the repository's package manager and installed binary.

For a new regression, express the user-visible result with web-first assertions. Prefer accessible roles and labels over class chains. Isolate test data and browser state. Wait for a particular UI condition rather than fixed sleeps; a permanently active network connection makes “network idle” an unreliable universal ready signal.

If the project already uses `@playwright/test`, a small pattern is:

```ts
import { test, expect } from '@playwright/test';

test('required title is explained before save', async ({ page }) => {
  await page.goto('/new'); // Requires the project's configured baseURL.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Title is required');
});
```

Replace the route and strings with observations from the actual app. Include a successful submission when it materially verifies the fix; do not assert private component implementation details.

If `playwright-cli` is already installed and appropriate for the task, run its `--help` before choosing commands. Its browser state is separate from the MCP server's. Never mix a reference from one session into another. CLI is useful for scripted flows; MCP remains useful for exploratory stateful inspection. Neither path is automatically faster for every Motif-3 task.

Capture focused traces/screenshots on failure. Keep authenticated storage files out of commits. A reference screenshot is not a reason to replace baselines when a test finds an unintended change.

Official references:

- https://playwright.dev/docs/best-practices
- https://github.com/microsoft/playwright-mcp
- https://github.com/microsoft/playwright-cli

This is an original Motif workflow. It does not install the upstream CLI or test runner.
