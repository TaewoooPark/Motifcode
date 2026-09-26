# Skills

Skills are instructions and supporting files that Motif loads when they apply.
The system prompt contains a short index; a skill's full body enters the
conversation only when invoked. Loading a skill does not add tools, connect an
account, or change Motif's permissions.

## Use a skill

```sh
motif skills
motif -p '/code-review review the latest diff'
motif -p '@skill:explain explain this module'
```

In interactive chat, use `/skills`, `/<name> [arguments]`, or `@skill:<name>`.
The model can also select an eligible skill with the `skill` tool. Explicit
skill references work in both interactive chat and one-shot/print runs.

## Install and import

The built-in `skill-setup` skill guides source inspection, installation and
verification. Paste a skill link into the prompt with a clear installation
request, for example:

```text
https://github.com/anthropics/skills/tree/main/skills/webapp-testing 이 스킬을 이 프로젝트에 설치해줘.
Please install this skill for this project: https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md
https://github.com/anthropics/skills/tree/main/skills/theme-factory 이 스킬을 글로벌로 설치해줘. 모든 프로젝트에서 쓰고 싶어.
Install this skill globally: https://github.com/anthropics/skills/tree/main/skills/brand-guidelines
```

Motif attaches the setup guidance automatically to clear Korean or English
link-based installation requests, in interactive chat and one-shot/print runs.
It preserves the original request and session permissions. Quoted examples,
explanation-only requests and explicit refusals do not trigger this attachment.
An explicit `/skill-setup <source or request>` also works, including requests to
import an existing Claude/Codex skill without a link.

The setup flow inspects the source, selects the requested skill, installs it and
checks its receipt and registration before reporting the result. User scope is
the default. “Globally”, “all projects”, “글로벌” and “전역” also mean user scope:
the managed skill is stored under `~/.motif/` and discovered from every project
for the same user. Ask for “this project” to use the current working directory.
Restart an existing Motif session to load a newly installed skill. A
collection with no clear selection needs a skill name; it is not installed in
bulk automatically. Model-guided setup can still make mistakes; the CLI below
provides the same operations directly, without a model or API key:

```sh
# Discover existing client skills; no files are copied yet.
motif skills import claude
motif skills import codex --json

# Select a candidate selectionId returned by discovery.
motif skills import claude --skill webapp-testing --scope project

# Inspect and add a standalone directory or GitHub subdirectory.
motif skills inspect ./my-skill
motif skills add ./my-skill --scope project
motif skills add anthropics/skills --path skills/webapp-testing
motif skills add https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md --scope project

# Inspect a marketplace and install skills from one of its entries.
motif skills marketplace OWNER/CATALOG --json
motif skills inspect OWNER/CATALOG --plugin ENTRY --json
motif skills add OWNER/CATALOG --plugin ENTRY --skill SKILL_NAME

# Inspect and maintain Motif-managed copies.
motif skills installed --json
motif skills update INSTALLED_NAME
motif skills remove INSTALLED_NAME
```

`add` also accepts the alias `install`. User scope is the default; pass
`--scope project` to installation, maintenance and listing commands for a
project's managed library. `--dry-run` previews changes. A remote preview may
fetch the requested repository into temporary storage, but does not register
skills. `--ref` selects a Git branch, tag or commit. Resolved commits and content
digests are recorded with each installation. GitHub `tree` folder links, `blob`
`SKILL.md` links and `raw.githubusercontent.com` `SKILL.md` links resolve to a
Git repository, revision and containing folder; supporting files are retained.
The source receipt records that canonical repository/ref/path. Ambiguous branch
or tag boundaries require a matching explicit `--ref`; conflicting `--path` or
`--ref` options are rejected. Other web pages are not standalone skill packages.

Use repeated `--skill` options to select several candidates, or `--all` for
an intentional bulk import. Ambiguous names are reported; use the returned
qualified `selectionId` and, when needed, `--namespace` to keep different sources distinct.
Installation does not overwrite another client's files. Updates and removals
refuse to discard changes made inside managed snapshots.

Standalone skills retain their supporting files. Skills extracted from plugin
packages retain the package's shared scripts, references and assets. The
managed index registers only the selected skills. Bundled services remain
inactive until the separate connection step below. Package managers and lifecycle
scripts are not run during installation; bundled hooks and agents stay inactive.

Supported catalogs include `.claude-plugin/marketplace.json` and
`.agents/plugins/marketplace.json`, with local, GitHub, Git URL and Git
subdirectory entries. Unsupported source types or unavailable catalog entries
produce diagnostics. Use the repository as the source when a catalog uses
relative paths. Claude and Codex installed-plugin discovery uses their client
inventory and exact installed versions, rather than treating every cached
version as active. Missing client tools are reported alongside any direct
skills that can still be discovered.

Managed data lives in `~/.motif/skills-installed.json` and
`~/.motif/skill-packages/`, or the equivalent project `.motif/` directories.
Hand-authored `skills/` folders remain usable. Restart an existing session to
load changes to the library.

## Built-in workflow bundles

Motif ships five plugin bundles alongside its core skills: `library-docs`,
`browser-web-testing`, `github-workflow`, `frontend-quality`, and `mcp-builder`.
They contain six skills and their focused reference files. They are available in
user and project sessions without a marketplace download or account login.
Only the skill index is included initially; bodies and references load on demand.
A bundle that works through an MCP preset joins the model's skill index only while
that server is enabled; enabling it in `/mcp` adds the skill from the next task.
Its slash command works either way. Personal or project skills of the same name
take precedence.

Use `motif plugins list` or `motif plugins inspect NAME --json` to inspect the
bundles offline. `motif plugins connect NAME --dry-run` previews service setup;
`motif plugins connect NAME` asks before registration and connection. A reviewed
noninteractive setup requires `--yes`. No setup runs merely because a plugin is
listed or its skills are loaded. The MCP builder has no default external service.

The browser bundle uses Playwright MCP for stateful exploration and existing
Playwright CLI/tests for repeatable checks. Its isolated MCP browser does not
inherit a user's logged-in browser tabs. The frontend bundle combines original
Motif guidance on design, accessibility, React data flow and composition with
references to upstream projects; it does not activate another host's hooks.

The GitHub bundle supports the official GitHub MCP and an already authenticated
`gh` CLI. Its default preset delegates to GitHub CLI’s saved account after
`motif mcp login github` (also available in `/mcp`). Motif persists a delegation
grant and resolves credentials from `gh` on later requests, including after
restart. An explicit `--token-env` registration remains available. A missing
credential is not a successful connection. Never expose a token to the model or
copy one into a committed file.

Built-in bundle assets belong to the Motif installation; replacing the binary
and its packaged assets updates them together. They are not managed marketplace
receipts. Use user/project skills to customize their behavior.

## Connect a skill package or plugin

The built-in `plugin-setup` skill handles clear English or Korean link-based
plugin installation and connection requests. `/plugin-setup <source or request>`
also works explicitly. Clear requests to connect, activate or sign in to an
already installed plugin do not need a link; Motif first looks up its managed
registration. It installs selected skills, inspects their package's
services, reviews the connection plan and checks approved connections. The
`skill-setup` skill uses the same flow when a skill needs a bundled service.

```sh
motif plugins add OWNER/REPO --skill SKILL_NAME --scope user
motif plugins inspect INSTALLED_NAME --scope user --json
motif plugins connect INSTALLED_NAME --scope user --login
# For a reviewed plan in a noninteractive shell:
motif skills connect INSTALLED_NAME --scope user --server SERVER_NAME --yes --login
```

`plugins` uses the existing managed skill installer. An installed skill name or
unambiguous plugin namespace identifies the package. `inspect` is offline and
shows available MCP servers, unresolved environment variables and unsupported
components. With multiple servers, select `--server NAME` or explicitly `--all`.
`connect` asks before registration and startup; noninteractive runs require
`--yes`. Browser sign-in requires `--login` and uses the same [MCP OAuth flow](mcp.md#browser-login-and-human-approval).
Approval of registration is separate from provider consent and later tool use.

User scope registers services in `~/.motif/mcp.json`; project scope writes
`.motif/mcp.json` and returns the exact trust hash needed at the next launch.
Restart an existing Motif session after adding registrations. Connection checks
only initialize servers and list tools; they do not prove account access or call
business tools. Missing credentials, denied login and unsupported host services
are reported as partial or failed setup, never as successful account activation.

Supported package MCP definitions are translated without changing the original
Claude/Codex installation. Local servers run from a verified runtime copy under
`.motif/plugin-runtimes/`, preserving the immutable installation snapshot. A
modified original file in that runtime blocks reuse. User-edited MCP registrations
are not overwritten. Update/remove manage skill receipts; existing MCP
registrations and runtime copies must be maintained separately.

App IDs from `.app.json` do not identify portable MCP endpoints. Most require
their original host; the known Hugging Face public adapter is offered with an
explicit limited-capability notice. Provider allowlists still apply. This flow
does not activate Claude/Codex hooks, agents, commands or private host connectors,
and MCP-only packages without skills use the direct `motif mcp` workflow.

## Author a local skill

Create `~/.motif/skills/<name>/SKILL.md` for all projects, or
`<project>/.motif/skills/<name>/SKILL.md` for one project:

```markdown
---
name: explain-widget
description: >
  Explain this project's widget lifecycle and inspect its invariants.
metadata:
  version: "1"
---

Read references/lifecycle.md relative to this skill's base directory.
Explain the widget named in $ARGUMENTS, citing the relevant source.
```

Keep supporting scripts, references, templates and assets beside `SKILL.md`.
Motif supplies the skill's source and base directory when loading it, so paths
do not accidentally resolve against the current project. The `read` tool may
read resources inside a successfully loaded skill's registered resource root;
this does not grant writes outside the workspace or permit symlink escapes.
Scripts still use the ordinary command tools and their permissions.

When names collide, precedence rises from built-ins to legacy plugin skills,
then managed imports, then handwritten `skills/` folders. Within each category,
project skills override user skills. A user handwritten skill can therefore
override a project managed import. Installation rejects a same-scope handwritten
collision; other handwritten overrides produce a warning with the source paths.
Use `--namespace` to keep both skills available. Restart a running session after
changing the installed library.

## Compatibility

Motif parses YAML frontmatter, including folded descriptions, quoted strings,
lists, nested metadata, UTF-8 BOM and CRLF. Invalid YAML is reported rather than
silently treated as a different skill. The original body and unknown metadata
are preserved.

| Source feature | Motif behavior |
| --- | --- |
| `name`, `description`, references, scripts, assets | Loaded with source directory context |
| `budget`, `tags` | Motif's existing budget and tagging metadata |
| `allowed-tools` | Preserved with a compatibility notice; source preapprovals do not grant Motif permissions |
| `disable-model-invocation: true` | Explicit user invocation only; omitted from the model's index |
| `user-invocable: false` | Hidden from user invocation; may remain available to the model |
| `agents/openai.yaml` with `policy.allow_implicit_invocation: false` | Explicit user invocation only |
| `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` | Arguments expanded at invocation; quoted arguments remain grouped |
| `${CLAUDE_SKILL_DIR}` | Resolved to the loaded skill directory |
| `${CLAUDE_PLUGIN_ROOT}` | Resolved only when a package root is registered |
| Host-specific fork, model, hooks or dynamic shell preprocessing | Diagnosed as unsupported; invocation is blocked rather than approximated |
| Bundled MCP servers and login | Explicit `skills connect` / `plugins connect` step for supported package definitions |
| Host-only connectors, executables and credentials | Diagnosed individually; app IDs and another client's login are not portable |

Descriptions are used for discovery; instructions are loaded progressively.
Skill bodies are checked against their declared budget and a finite maximum
size. Accepted bodies are passed whole, including the middle of a long skill.
An oversized or unsupported skill returns a failure with an explanation;
Motif does not present a truncated instruction sheet as successful loading.

See the [Agent Skills specification](https://agentskills.io/specification),
[Claude skill documentation](https://code.claude.com/docs/en/skills), and
[Codex skills documentation](https://developers.openai.com/codex/skills/)
for the source formats. Support for these files does not imply support for
their hosts' complete plugin runtimes.
