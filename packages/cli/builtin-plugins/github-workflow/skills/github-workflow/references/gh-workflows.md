# GitHub CLI fallback

Use exact values from the user's URL or `git remote -v`; `OWNER/REPO` and `NUMBER` below are placeholders. Prefer explicit repository arguments so another checkout cannot redirect a command.

```sh
gh pr view NUMBER --repo OWNER/REPO --json number,url,title,body,headRefOid,baseRefName,headRefName,files,comments,statusCheckRollup
gh pr diff NUMBER --repo OWNER/REPO
gh pr checks NUMBER --repo OWNER/REPO
gh issue view NUMBER --repo OWNER/REPO --json number,url,title,body,state,labels,comments
```

CI exit status alone needs interpretation: read pending, skipped and failing checks and compare their commit with the recorded PR head. Check the repository's required workflows rather than inventing a universal CI command.

For local reproduction, use a separate checkout when the current tree has unrelated work. Do not force checkout, reset or clean the person's tree. Check repository instructions before installing or testing an external branch.

When the user authorized a comment or PR, write its exact text into a local UTF-8 file and use `--body-file` with the applicable `gh` command. Avoid shell interpolation of Markdown, backticks or dollar signs. After a timeout inspect comments/PR state before retrying. Keep write operations out of a review-only request.

Official references:

- https://cli.github.com/manual/gh_pr_view
- https://cli.github.com/manual/gh_pr_checks
- https://cli.github.com/manual/gh_issue_view
- https://github.com/github/github-mcp-server

MCP tool names and availability vary with configured toolsets and permissions. The current discovered schema takes precedence over examples remembered from another host.
