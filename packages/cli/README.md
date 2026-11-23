# motifcode

**An unofficial coding agent harness built for one model: [Motif-3](https://huggingface.co/Motif-Technologies/Motif-3).**
A Claude Code-style terminal session — transcript above, prompt below, `/` commands, `@` mentions,
a permission prompt, a `.motif/` directory behind it — whose tool set, prompt layout, parser and
failure handling follow from what is measurably true about Motif-3.

> **Choose your provider.** New installations default to [OpenRouter](https://openrouter.ai/settings/keys). You can also choose [Infron](https://infron.ai) or
> [Morphfactory (BETA)](https://cbt.morphfactory.io/console?view=keys).
> Switch later with `/provider` or `/config`; each provider keeps its own API key.

> **Not an official Motif project.** Not certified, endorsed, sponsored or maintained by Motif
> Technologies or by Infron. *Motif* and *Motif-3* are their names; this package is a client of the model.

```bash
cd your-project
npx motifcode                # choose a provider and enter its API key once, then offers to install the `motif` command
```

Or `npm install -g motifcode` directly; either way `motif` (or `motifcode`) opens the session
from any folder afterwards, with the key saved in `~/.motif/.env`.

1. Create a key for your provider. [OpenRouter keys](https://openrouter.ai/settings/keys) · [Infron keys](https://infron.ai/dashboard/apiKeys) · [Morphfactory keys](https://cbt.morphfactory.io/console?view=keys)
2. Run `motif`, choose the provider, and paste its key. Use `/provider` to switch or `/login` and `/logout` to manage the selected provider's key.
3. For a script, use `motif login --provider openrouter`, then `motif --provider openrouter -p "your question"`. To probe the model connection, run `motif doctor --provider openrouter`.

OpenRouter uses `OPENROUTER_API_KEY` with model `motif-technologies/motif-3`.
Infron uses `MOTIF_API_KEY`, and Morphfactory uses `MOTIF_MORPHFACTORY_API_KEY`.
Select either with `--provider infron` or `--provider morphfactory`. Explicit
`--endpoint` and `--model` flags override the preset.

```bash
motif                                   # interactive session in the current directory
motif --continue                        # with the latest conversation here loaded
motif "fix the failing test in tests/"  # one task, then exit
motif -p "what does src/loop.ts do?"    # print only the reply, for pipes
```

Connect MCP servers and check them from the CLI:

```bash
motif mcp presets
motif mcp install context7 --enable
motif mcp list
motif mcp doctor --connect
motif mcp connect SERVER_NAME --login
```

Built-in presets cover Context7, Playwright, Filesystem, Hugging Face, OpenAI Docs,
Tauri and Gmail. `install ID` registers offline and defaults to disabled. Local
packages download on first connection. Filesystem requires `--root`; Tauri needs
an app bridge and Gmail needs separately supplied OAuth credentials.
Register a custom local stdio server with `motif mcp add NAME -- COMMAND [ARGS...]`.
Inside a session, `/mcp` manages connections. The built-in `mcp-setup` skill
also handles clear natural-language MCP setup requests containing a URL;
`/mcp-setup <URL>` invokes it explicitly. Relaunch Motif after adding or editing
a registration. `motif skills` lists all 18 built-in skills and any custom ones.
See the [MCP guide](https://github.com/TaewoooPark/Motifcode/blob/main/docs/mcp.md)
for credentials, configuration import and supported features.

Import skills from existing clients or add a local/Git source:

```bash
motif skills import claude
motif skills import codex --json
motif skills add anthropics/skills --path skills/webapp-testing
motif skills --help
```

Paste a skill link with a clear installation request to automatically load
`skill-setup`, or use `/skill-setup <source or request>` explicitly. The guide
inspects, selects, installs and verifies the registration. “Install globally”
uses the user library under `~/.motif/` for all projects; “for this project”
uses the current project's library. Restart Motif after installation. GitHub folder,
`SKILL.md` and raw-file links retain supporting files. Marketplace imports preserve skill resources without activating
plugin hooks or connectors. Use `motif plugins inspect INSTALLED_NAME` then
`motif plugins connect INSTALLED_NAME --login` to review, approve and check bundled
MCP connections. Standard OAuth opens the provider’s browser page; private host
connectors still require their original host. Clear plugin setup requests load
`plugin-setup` automatically. See the
[skills guide](https://github.com/TaewoooPark/Motifcode/blob/main/docs/skills.md)
for selection, scope, updates and compatibility limits.

Needs Node 20.3+. The bundle is a single file with no runtime dependencies.

Full documentation, the design notes on why this harness is shaped the way it is, and the Korean
edition are in the repository: **https://github.com/TaewoooPark/Motifcode**.

Apache-2.0.
