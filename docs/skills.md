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
managed index registers only the selected skills; bundled MCP definitions,
hooks, agents and connectors remain inactive. Package managers and lifecycle
scripts are not run during installation.

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
| External tools, connectors, executables and credentials | Must be configured separately; installing instructions does not provide them |

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
