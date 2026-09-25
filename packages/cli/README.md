# motifcode

**An unofficial coding agent harness built for one model: [Motif-3](https://huggingface.co/Motif-Technologies/Motif-3).**
A Claude Code-style terminal session — transcript above, prompt below, `/` commands, `@` mentions,
a permission prompt, a `.motif/` directory behind it — whose tool set, prompt layout, parser and
failure handling follow from what is measurably true about Motif-3.

> **Free through September 2026.** Motif-3 is served by [Infron](https://infron.ai) at $0 per
> million tokens, with free access announced through the end of September 2026. Terms can change;
> the [model page](https://infron.ai/models/motif/motif-3) is the source of truth.

> **Not an official Motif project.** Not certified, endorsed, sponsored or maintained by Motif
> Technologies or by Infron. *Motif* and *Motif-3* are their names; this package is a client of the model.

```bash
cd your-project
npx motifcode                # asks for your Infron API key once, then offers to install the `motif` command
```

Or `npm install -g motifcode` directly; either way `motif` (or `motifcode`) opens the session
from any folder afterwards, with the key saved in `~/.motif/.env`.

1. Sign in at [infron.ai/login](https://infron.ai/login), open [Dashboard → API Keys](https://infron.ai/dashboard/apiKeys), click **Add new key**.
2. Run `motif` and paste the key when asked. It is checked against the endpoint, saved to
   `~/.motif/.env` (readable only by you), and never shown to the model. `motif login` does the
   same outside a session; `/login` and `/logout` inside one.
3. `motif doctor` reports what the endpoint returns: structured tool calls, reasoning, prefix caching.

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
```

Built-in presets cover Context7, Playwright, Filesystem, Hugging Face, OpenAI Docs,
Tauri and Gmail. `install ID` registers offline and defaults to disabled. Local
packages download on first connection. Filesystem requires `--root`; Tauri needs
an app bridge and Gmail needs separately supplied OAuth credentials.
Register a custom local stdio server with `motif mcp add NAME -- COMMAND [ARGS...]`.
Inside a session, `/mcp` manages connections. The built-in `mcp-setup` skill
also handles clear natural-language MCP setup requests containing a URL;
`/mcp-setup <URL>` invokes it explicitly. Relaunch Motif after adding or editing
a registration. `motif skills` lists all 17 built-in skills and any custom ones.
See the [MCP guide](https://github.com/TaewoooPark/Motifcode/blob/main/docs/mcp.md)
for credentials, configuration import and supported features.

Import skills from existing clients or add a local/Git source:

```bash
motif skills import claude
motif skills import codex --json
motif skills add anthropics/skills --path skills/webapp-testing
motif skills --help
```

Use `/skill-setup <source or request>` for guided inspection, selection and
verification. Marketplace imports preserve skill resources without activating
plugin hooks, MCP servers or connectors. See the
[skills guide](https://github.com/TaewoooPark/Motifcode/blob/main/docs/skills.md)
for selection, scope, updates and compatibility limits.

Needs Node 20.3+. The bundle is a single file with no runtime dependencies.

Full documentation, the design notes on why this harness is shaped the way it is, and the Korean
edition are in the repository: **https://github.com/TaewoooPark/Motifcode**.

Apache-2.0.
