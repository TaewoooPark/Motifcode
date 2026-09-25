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

Project skills override user skills of the same name; user skills override
built-ins. Restart a running session after changing the installed library.

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
