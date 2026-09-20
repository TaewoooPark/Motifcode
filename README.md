<p align="center">
  <img src="docs/logo.svg" alt="motifcode" width="912">
</p>

<p align="center">
  <strong>A coding agent harness built for one model: Motif-3.</strong>
</p>

<p align="center">
  English &nbsp;·&nbsp; <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/motifcode?style=flat-square&labelColor=000000&color=333333" alt="npm">
  <img src="https://img.shields.io/github/last-commit/TaewoooPark/Motifcode?style=flat-square&labelColor=000000&color=333333" alt="Last commit">
  <img src="https://img.shields.io/github/actions/workflow/status/TaewoooPark/Motifcode/ci.yml?branch=main&style=flat-square&labelColor=000000&color=333333" alt="CI">
  <img src="https://img.shields.io/badge/license-Apache--2.0-000000?style=flat-square&labelColor=000000&color=333333" alt="Apache-2.0">
  &nbsp;
  <img src="https://img.shields.io/badge/TypeScript-000000?style=flat-square&logo=typescript&logoColor=white&labelColor=000000" alt="TypeScript">
  <img src="https://img.shields.io/badge/Python-000000?style=flat-square&logo=python&logoColor=white&labelColor=000000" alt="Python">
  <img src="https://img.shields.io/badge/Vitest-000000?style=flat-square&logo=vitest&logoColor=white&labelColor=000000" alt="Vitest">
  &nbsp;
  <img src="https://img.shields.io/badge/Motif--3-000000?style=flat-square&labelColor=000000&color=000000" alt="Motif-3">
  <img src="https://img.shields.io/badge/314B--A13B-000000?style=flat-square&labelColor=000000&color=000000" alt="314B-A13B">
  <img src="https://img.shields.io/badge/256K%20context-000000?style=flat-square&labelColor=000000&color=000000" alt="256K context">
  <img src="https://img.shields.io/badge/alpha-000000?style=flat-square&labelColor=000000&color=000000" alt="alpha">
</p>

> **Free through September 2026.** Motif-3 is served by [Infron](https://infron.ai) as
> **Motif: Motif 3 (Free)** — $0 per million tokens in and out, the full 262,144-token
> window — and free access has been announced through the end of September 2026.
> An account and an API key are all it takes: `npx motifcode` asks for the key, then installs the `motif` command.
> See [Get an API key](#get-an-api-key-from-infron).
> Terms can change, and the [model page](https://infron.ai/models/motif/motif-3) is the source of truth.

> **Not an official Motif project.** Motifcode is an independent open-source project.
> It is not certified, endorsed, sponsored or maintained by Motif Technologies or by
> Infron. *Motif* and *Motif-3* are their names; this repository is only a client of the model.

Motifcode is a terminal coding agent in the shape of Claude Code — a transcript
above, a bordered prompt below, `/` commands, `@` mentions, a permission prompt,
a `.motif/` directory behind it — whose tool set, prompt layout, parser and
failure handling are **consequences of things that are specifically true about
[Motif-3](https://huggingface.co/Motif-Technologies/Motif-3)**, most of them
measured rather than assumed. It is not a general harness pointed at a
different base URL.

> *"A harness earns its keep by being a consequence of the model, not a wrapper around it."*

---

## Contents

- [Why this exists](#why-this-exists)
- [What it looks like](#what-it-looks-like)
- [Features](#features)
- [Built around Motif-3](#built-around-motif-3)
- [Install](#install)
- [Get an API key from Infron](#get-an-api-key-from-infron)
- [Usage](#usage)
- [Motif-3 links](#motif-3-links)
- [Status](#status)
- [Repository](#repository)
- [Development](#development)
- [Prior art read closely](#prior-art-read-closely)
- [Developer](#developer)
- [Licence](#licence)

---

## Why this exists

On 18 August 2026 Korea's Ministry of Science and ICT announced the second-stage
result of its **Independent AI Foundation Model** programme (독자 AI 파운데이션
모델, the national sovereign-model project). Four teams were evaluated; LG AI
Research, SK Telecom and Upstage went on to the next round, and **Motif
Technologies was eliminated** — with the highest benchmark score of the four.
The vice minister's explanation was that the technology was excellent but that
the model *"received a somewhat lower evaluation than the other companies on
usability and applicability"* (사용성·활용성). A week earlier Motif-3 had been
released as open weights, scoring 47 on the Artificial Analysis Intelligence
Index — first among Korean models.
([THE ELEC](https://www.thelec.kr/news/articleView.html?idxno=61033),
[Biz Hankook](https://bizhankook.com/articles/motif-eliminated-doks-round-3-change.html),
[HelloT](https://www.hellot.net/news/article.html?no=114379))

*Usability*, for a coding model, is mostly not a property of the weights. It is
whether the model's tool calls parse; whether the prompt is laid out the way its
own chat template expects; whether one malformed turn is repaired or ends the
session; whether the tools it is given are the ones it scored with; and whether
the terminal in front of the person behaves like the tools they already use.
Every one of those is a property of the harness — and a harness can be written
by anyone.

**Motifcode was built to prove that the usability an open-weight model was
marked down on can be raised far enough with open source.** The harness is
written for this one model, measured against it, and given an interactive
session checked feature by feature against Claude Code's. The
[Status](#status) section is the evidence so far, including what is still
missing, in the same tone.

---

## What it looks like

```
╭────────────────────────────────────────────────────────────╮
│ ✻ Welcome to motif 0.1.0                                   │
│                                                            │
│   /help for commands · /status for your setup              │
│   esc interrupts a task · ctrl-c twice quits               │
│                                                            │
│   model  motif/motif-3                                     │
│   cwd    ~/projects/tally                                  │
╰────────────────────────────────────────────────────────────╯

> add a Usage section to README.md and tell me what you changed

⏺ Read(README.md)
  ⎿  Read 8 lines

⏺ The file only has 8 lines. Let me create a patch that matches
  the actual content.

⏺ Patch(diff --git a/README.md b/README.md…)
  ⎿  applied
     hook true ✓

⏺ Added a **Usage** section to `README.md`:
  - a three-line example: `from tally import Counter`, increment, print
  - placed after **Install**, at the end of the file

╭────────────────────────────────────────────────────────────╮
│ > type a task, / for commands                              │
╰────────────────────────────────────────────────────────────╯
  ? for shortcuts                motif/motif-3 · ctx 3K/262K · cached 88%
```

Your line after `>`, the model's prose and each tool call behind a `⏺`,
results under a `⎿`, reasoning hidden unless you ask for it, and a status
line that shows the context used and how much of the prompt the server served
from cache. The reply streams in as the model writes it.

---

## Features

**The session**

- **Streaming replies** over SSE, with the model's reasoning kept out of the
  transcript unless `--thinking` or `/thinking` asks for it.
- **`@` mentions** — `@path` attaches a file or a directory listing, with a
  picker that opens as you type; `@skill:name` attaches a skill's instructions.
- **`!command`** runs a shell line right there and shows the model its output;
  **`#note`** appends a line to `.motif/NOTES.md`, which every task reads.
- **Slash commands** for every setting, with a menu that opens on `/`; a change
  made at the prompt is saved to `~/.motif/settings.json`.
- **Skills are commands**: `/commit fix the parser` runs the `commit` skill
  with that input. Fifteen ship built in; yours go under `.motif/skills/`.
- **Permission prompt** before a command, a write, a patch or the terminal
  runs — numbered answers, "don't ask again for this tool", and a refusal the
  model is told about. Shift-Tab or `/permissions auto` runs everything.
- **Conversation continuity**: the second task sees the first and everything
  the model did about it; `--continue` and `/resume` bring a recorded
  conversation back.
- **Codex-style compaction** when the context grows past `compactAt` of the
  window: the model writes a handoff summary, your own messages are kept
  verbatim ahead of it, and the rest goes. `/compact <focus>` does it on demand.
- **Queued messages** while a task runs, Esc to interrupt, paste collapsing,
  Hangul and other wide text handled by display width, and a window that can be
  shrunk mid-session without leaving a row behind.
- **Themes** — `motif`, `claude`, `mono`, `solarized`, `dracula`.
- **Print mode** (`motif -p "question"`) for scripts and pipes.

**The backend — `.motif/`, laid out like Claude Code's `.claude/`**

- user settings, skills, agents and plugins under `~/.motif/`; the project's
  under `<repo>/.motif/`, applied once `motif trust` approves its hooks;
- one append-only journal per task, resumable from its last checkpoint;
- five built-in subagents (`explorer`, `reviewer`, `tester`, `planner`,
  `patcher`) and a local scheduler; plugins in Claude Code's layout.

**The endpoint**

- `MOTIF_API_KEY`, `MOTIF_ENDPOINT` and `MOTIF_MODEL` from flags, the
  environment, `./.env`, then `~/.motif/.env`; a base URL pasted with its
  `/v1` works.
- The key is sent as a bearer token and **withheld from every command the
  agent runs** — the model's `bash` cannot see it, and neither can a project hook.
- A 401 that says which side of the key it is on; a 429 retried after the
  server's own `Retry-After`; `motif doctor` reports what the server actually
  produces.

---

## Built around Motif-3

Generic harnesses assume the model's tool calls parse, that the tool list is
free to change, and that reasoning is optional. None of those hold here — and
each one, checked, turned into a design constraint.

| Fact about Motif-3 | Source | What it forces |
|---|---|---|
| Frequently emits malformed JSON inside `<tool_call>`, failing on shell `\$` and regex `\s` | the vendor's own vLLM parser comments | A client-side repair ladder, a breakage budget, and channels that avoid string escaping altogether |
| The repair oracle validates candidates against tool schemas | same | Few tools, few parameters, closed schemas — enforced by a linter that fails the build |
| The tools block renders **before** the system prompt, in the same turn | `chat_template.jinja` | The tool list is frozen *and canonically ordered* for a session |
| Reordering two tools drops prefix reuse to **~24%** | **measured — `template.test.ts`** | Subsets are taken as prefixes, never as filters. Hence `done` leads the list |
| Intermediate reasoning renders **only** when tools are registered | **measured — `template.test.ts`** | Tools are registered on every channel, including those that never call them |
| Terminal-Bench 74.9 came from a persistent tmux session, not stateless subshells | Terminus 2 source | A `term` tool beside `bash` |
| SWE-bench 76.2 came from a single `bash` tool | mini-SWE-agent config | The thin tool set is the baseline, not a compromise |
| One repair turn erases a 2-bit quantisation penalty | *Half the Experts, All the Code* | The repair loop is core, not a nicety |

The tool set is nine tools in a fixed order — `done, bash, read, write,
apply_patch, term, skill, task, mcp` — and a subagent takes a *prefix* of it,
which keeps the server's prefix cache warm and is also why no subagent can
spawn another.

### The three action channels

How the model expresses what it wants to do is a **runtime switch**, and none of
the three options was invented here. Each is borrowed from a harness in which
Motif-3 posted a published score. A channel is not a parser: it picks the
endpoint, the request body, the stop sequences, and how the transcript is
written down for the next turn.

| channel | endpoint | assistant turn | observation | provenance |
|---|---|---|---|---|
| `toolcall` | `/v1/chat/completions` | native `content` + `tool_calls` | `role: "tool"` | SWE-bench Verified **76.2** — mini-SWE-agent |
| `object` | `/v1/completions`, prompt rendered here | the model's JSON verbatim | a user turn | Terminal-Bench 2.1 **74.9** — Terminus 2, default parser |
| `raw` | `/v1/completions`, prompt rendered here | the model's XML verbatim | a user turn | Terminus 2's alternative parser — never measured on Motif |

Keeping the model's own body verbatim is the part that is easy to get wrong.
Parse a JSON response into actions, write those actions back as native
`tool_calls`, and from turn two the model is reading a transcript in the format
it was told not to use. The hosted endpoint has no `/v1/completions`, so only
`toolcall` runs there; the other two need `--experimental-channel` and a server
with a completions route.

### What the hosted endpoint changed

Moving from a local server to a hosted one exposed a defect the fault-injected
suite had never reached: with a server that extracts tool calls, the native
channel wrote the assistant turn back **without its `tool_calls`**, so from
turn two the model saw an empty turn followed by a tool response to a call that
was not there. Fixed, and now the thing the end-to-end test checks on the wire.
`motif doctor` confirms the rest of what the endpoint does: structured
`tool_calls`, reasoning in its own field, cached prompt tokens reported, the
full 262,144-token window advertised.

---

## Install

Needs **Node 20+**. The package is one file with no runtime dependencies.

```bash
cd your-project
npx motifcode                 # first run: asks for your key, then installs the `motif` command
```

The first session asks for your Infron API key, once, and saves it to
`~/.motif/.env`. Because `npx` leaves no command behind, it then offers to
run `npm install -g motifcode` for you; say yes and `motif` (or `motifcode`)
opens the session from any folder from then on. `npm install -g motifcode`
directly does the same without the question.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ Paste your Infron API key to get started                                     │
│ Get one at https://infron.ai/dashboard/apiKeys                               │
│ Motif-3 is free there through September 2026.                                │
│ The key is checked with the endpoint and saved to ~/.motif/.env,             │
│ readable only by you and never shown to the model.                           │
│                                                                              │
│ key › •••••••••••••••••••••••••••••••••••••••••••••••••••                    │
╰──────────────────────────────────────────────────────────────────────────────╯
  enter to check and save · esc to skip for now
```

Enter checks the key with a one-token request to the endpoint and saves it;
a rejected key is asked for again with the server's reason, and Esc skips for
now. From source instead:

```bash
git clone https://github.com/TaewoooPark/Motifcode.git && cd Motifcode
pnpm install && pnpm build    # bundles the CLI to packages/cli/dist/motif.js
cd packages/cli && npm link   # puts `motif` (and `motifcode`) on your PATH
```

---

## Get an API key from Infron

Motif-3 is reached over Infron's OpenAI-compatible endpoint. The whole
configuration is a base URL, a model id and a key:

| | |
|---|---|
| base URL | `https://llm.onerouter.pro/v1` |
| model | `motif/motif-3` |
| key | `MOTIF_API_KEY` |

1. Sign in at **[infron.ai/login](https://infron.ai/login)** (email or Google).
2. Open **[Dashboard → API Keys](https://infron.ai/dashboard/apiKeys)** and click **Add new key**.
3. Run `motif` and paste the key when asked. It is checked against the
   endpoint with a one-token request, saved to `~/.motif/.env` (readable only
   by you), and never shown to the model. `motif login` does the same outside
   a session, and `/login` and `/logout` inside one. A `MOTIF_API_KEY` in the
   environment or in a `.env` next to the project works too; `--env-file
   <path>` puts a file first.
4. Check the connection:

   ```bash
   motif doctor
   ```

   It authenticates, finds the model in the listing, and runs a live probe that
   reports how the server returns tool calls and reasoning and whether prefix
   caching is on.

**Free through September 2026.** At the time of writing Infron lists the model
as *Motif: Motif 3 (Free)* at $0 per million tokens for input and output, and
has announced free access through the end of September 2026. Check the
[model page](https://infron.ai/models/motif/motif-3) and Infron's
[free-model terms](https://infron.ai/docs/overview/free-models) for the current
conditions.

Only `MOTIF_*` keys are read from a `.env` file, none of them are exported, and
the key is removed from the harness's own environment before anything is
spawned.

---

## Usage

### The interactive session

```bash
cd /path/to/repo
motif                          # open the session here
motif --continue               # …with the latest conversation in this repo loaded
motif --theme dracula --thinking
```

Type a task and press Enter. A reply with no tool call ends the turn; a task
that ends in work ends with `done`. Esc interrupts a running task; a message
sent while one runs is queued; `?` on an empty prompt lists the keys; Ctrl-C
twice quits.

### One task, or a pipe

```bash
motif "fix the failing test in tests/" --cwd /path/to/repo
motif "fix the failing test" --interactive       # stay in the session afterwards
motif login                                       # paste a key outside a session; motif logout removes it
motif -p "what does packages/core/src/loop.ts do?" # print only the final reply
motif sessions                                    # recorded sessions
motif resume <file>                               # resume an interrupted one
motif skills · motif agents · motif plugins · motif config · motif trust
```

### Slash commands

| command | what it does |
|---|---|
| `/help` | commands and keys |
| `/status` (`/cost`) | connection, settings and session totals |
| `/config` | effective settings, where each came from, and the files |
| `/doctor` | probe the endpoint: auth, parsers, cache, channels |
| `/login`, `/logout` | paste an Infron API key, checked and saved to `~/.motif/.env`; remove the saved key |
| `/model [id]`, `/endpoint [url]` | show or set the model id or endpoint for the next task |
| `/channel [toolcall\|object\|raw]` | show or set the action channel; changing it restarts the conversation |
| `/max-turns [n]`, `/max-tokens [n\|off]`, `/seed [n\|off]` | per-task ceilings and the sampling seed |
| `/theme [name]` | show, list or set the colour theme |
| `/thinking` | show or hide the model's reasoning |
| `/compact [focus]` | replace the transcript with the model's summary of it; words after it say what to keep |
| `/compact-at [0.5-1]` | the context fraction at which compaction runs (default 0.75) |
| `/permissions [ask\|auto]` | ask before commands, writes and patches run, or run everything |
| `/cwd [path]` | show or change the working directory |
| `/notes` (`/memory`), `/hooks` | the project notes every task reads; the hooks around tools |
| `/skills`, `/agents`, `/plugins` | what is loaded; each skill also runs as `/<skill> [input]` |
| `/new` (`/clear`) | start a new conversation; the working tree is untouched |
| `/sessions`, `/resume [n\|file]` | recorded sessions; continue from one |
| `/quit` (`/exit`, `/q`) | leave |

### Keys

```
enter send · \ + enter newline · esc interrupt or clear · ctrl-c twice quit · ctrl-d quit
↑ ↓ history · tab show or hide reasoning · ctrl-o full tool output · ctrl-l redraw · shift-tab permissions
@ attach a file · ! run a shell line · # add a project note · / commands · ? hide this
```

### The `.motif` directory

```
~/.motif/settings.json      your defaults: model, endpoint, channel, budgets, theme, thinking, compactAt, permissions
~/.motif/.env               the credential
~/.motif/skills/<n>/SKILL.md, ~/.motif/agents/<n>.md      yours, on every project
<repo>/.motif/settings.json the project's settings and hooks — applied once `motif trust` approves it
<repo>/.motif/skills/, agents/, NOTES.md                    the project's
~/.motif/plugins/<n>/, <repo>/.motif/plugins/<n>/          plugin.json + skills/ + agents/, Claude Code's layout
<repo>/.motif/sessions/*.jsonl                              one journal per task
<repo>/.motif/history.jsonl                                 what you typed, for ↑
```

### Skills, subagents, plugins

A skill is a `SKILL.md` with frontmatter (`name`, `description`) and
instructions as the body; `$ARGUMENTS` is replaced by what follows the command.
Built in: `explore`, `plan`, `explain`, `code-review`, `security-review`,
`test-fix`, `debug`, `refactor`, `commit`, `pr-body`, `docs`, `init` (writes
the project notes), `skill-creator`, `motif-endpoint` (the endpoint is the most
common cause of bad output here, and `doctor` measures it) and `korean`.

A subagent is Markdown with frontmatter — `name`, `description`, `tools` (a
count, or a prefix of the canonical list), `readOnly`, `maxTurns` — and the
instructions as the body. Built in: `explorer`, `reviewer`, `tester`,
`planner`, `patcher`.

A plugin is a directory with `plugin.json` and its own `skills/` and
`agents/`, under `~/.motif/plugins/` or `<repo>/.motif/plugins/`.

### Themes

`motif`, `claude`, `mono`, `solarized`, `dracula` — via `/theme`, `--theme`,
or `theme` in the settings file. The palette is swapped in place, so the
transcript already on screen keeps its layout.

---

## Motif-3 links

| | |
|---|---|
| Motif Technologies | [motiftech.io](https://motiftech.io) |
| Model weights (MIT) | [huggingface.co/Motif-Technologies/Motif-3](https://huggingface.co/Motif-Technologies/Motif-3) |
| Technical report | [arXiv:2608.09119](https://arxiv.org/abs/2608.09119) |
| Serving fork (vLLM, with the `motif` tool-call parser) | [github.com/MotifTechnologies/vllm](https://github.com/MotifTechnologies/vllm) |
| Hosted chat | [chat.motiftech.io](https://chat.motiftech.io/chat) |
| Hosted API used here | [infron.ai/models/motif/motif-3](https://infron.ai/models/motif/motif-3) |

Motif-3 is a 314B-parameter mixture-of-experts model with 13.2B activated per
token, 384 routed experts, and a native 256K context; Terminal-Bench 2.1 74.9
and SWE-bench Verified 76.2 are the vendor's published agentic scores.

---

## Status

Alpha. **It runs against Motif-3 over the hosted endpoint**, on the `toolcall`
channel. Agent sessions complete and the tests they write pass.

The interactive session has been checked against Claude Code's, feature by
feature, under a pseudo-terminal against the real endpoint: a streamed reply,
a file attached with `@`, a `!` shell line, a `#` note, `/commit` as a skill
command producing a real commit, `/compact` producing a real summary, the
permission prompt declining one command and allowing the next, `--continue`
picking a conversation back up, and a window shrunk mid-session — idle, with a
long draft, with the menu open, with a dialog open, while streaming — without
leaving a row behind. What it does not have: image input, a rewind, and vim
keys.

Before the hosted endpoint, the harness was run on one GB10 with 128 GB of
unified memory, serving a mixed-quant GGUF of the checkpoint. What that
campaign turned up is worth keeping, because none of it was visible from the
tests alone:

| Measured over one polyglot campaign, local serving, 2026-08 | |
|---|---|
| `apply_patch` calls that applied | **1 of 12** — patches ending without a newline, hunk counts off by one, and `git apply` reporting both in the host's language |
| edit attempts routed through shell heredocs instead | **85%** |
| output tokens spent rewriting a file already written | **~30%** |
| turns that produced no action at all | **21%**, and a no-action turn was followed by another **55.7%** of the time against 20.6% after a turn that acted |
| decode throughput | 11.8 tok/s single stream, **36% of what the memory bandwidth allows** |

Every one of those is a harness or runtime defect rather than a model
limitation, and the first four are fixed. The measurements are in the
journals; `toolkit/campaign/report_campaign.py` reads them. The fifth was the
local runtime's, and went with it.

| Component | State |
|---|---|
| `protocol` — chat template | **byte-identical** to the real Jinja across 14 cases |
| `protocol` — tool-call repair | 11 golden cases from the vendor's own suite, all passing |
| `protocol` — reasoning scrubber | passing, including every split point of a marker |
| `protocol` — action channels | `toolcall` exercised against the model; the other two only against fixtures |
| `tools` — frozen set + linter | passing; `write` added on evidence, and the tool ceiling raised to 9 with it |
| `core` — agent loop, compaction, streaming, endpoint config | passing, driven by injected faults; the key never enters the environment |
| `replay` — record / replay / fault injection | passing; a recorded session replays identically |
| `tui` — cells, two-region streaming, composer, menus, themes | passing, snapshot-tested; the session is driven end to end through a fake terminal |
| `skills` — registry + 15 built-in skills | passing |
| `agents` — 5 built-in subagents + local scheduler | passing |
| `hooks` — lifecycle shell hooks | passing |
| `journal` — append-only log, resume, trajectory export | passing |
| `cli` — `motif`, the session, `doctor`, `sessions`, `resume`, `distil`, plugins | passing; end to end against a mock server, and against the hosted endpoint |
| `toolkit/prune` — expert-pruning surgery | unit-tested; dry-runs against the real checkpoint index |
| `toolkit/campaign` — manifest, score table | reports a campaign over the manifest's denominator |
| `eval` — polyglot runner, worktree grader | run end to end against the model |

The loop is tested by **injecting the misbehaviour** — invalid escapes,
truncated tool calls, unparseable bodies, empty turns and a dead server are all
faults the suite produces on purpose. What running against the real model
changed is which faults are worth injecting: the announce-then-stop turn and
the miscounted patch are in the suite because the model produced them, not
because they seemed plausible.

---

## Repository

```
packages/protocol/   chat template · tool-call repair · reasoning scrubber · channels
packages/tools/      the frozen tool set and its linter
packages/core/       agent loop · endpoint config · compaction · breakage budget · loop guard
packages/replay/     record, replay and deliberately break the transport
packages/tui/        typed cells · two-region streaming · composer · menus · themes
packages/skills/     skill registry and the built-in skills
packages/agents/     subagent definitions and the local scheduler
packages/hooks/      lifecycle shell hooks
packages/journal/    append-only session log, resume, trajectory export
packages/cli/        the `motif` command, the interactive session, doctor, plugins
packages/eval/       polyglot suite, campaign runner, worktree grader
toolkit/fixtures/    golden-prompt generator (jinja2 only)
toolkit/prune/       expert-pruning surgery and its plan
toolkit/campaign/    eval manifest writer and campaign score table
corpus/              vendored template + generated goldens
docs/                logo, model guide
```

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test          # unit, integration, CLI end-to-end, and an install smoke
pnpm lint:tools    # schema linter — fails the build on loose schemas
```

**Releasing.** Bump `version` in both `package.json` files and `VERSION` in
`packages/cli/src/main.ts` (the install test checks the binary reports the
packed version), commit, then tag: `git tag v0.3.0 && git push origin v0.3.0`.
The release workflow runs the suite and publishes to npm with provenance
through npm's trusted publishing, so no token is stored anywhere; the
package's settings on npmjs.com name this repository and `release.yml` as the
trusted publisher.

The Python side needs only jinja2 for the prompt goldens, and a real tensor
backend for the pruning toolkit's slicing tests:

```bash
python3 toolkit/fixtures/gen_template_golden.py     # regenerate prompt goldens
pip install -r toolkit/requirements-dev.txt
MOTIF_REQUIRE_TORCH=1 python -m unittest discover -s toolkit/prune -p 'test_*.py'
python3 toolkit/prune/surgery.py --index toolkit/prune/testdata/motif3-nvfp4.index.json --keep-count 192
```

The pruning toolkit is kept from the local-serving days: the surgery (384
routed experts cut to 192, full context, activated parameters untouched) is
hardware-independent, and one repair turn was measured to erase the
quantisation penalty it introduces.

---

## Prior art read closely

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) — the session's
shape: the transcript, the prompt box, `/` and `@`, the permission prompt, the
`.claude/` layout.
[Codex](https://github.com/openai/codex) — typed history cells, two-region
streaming, snapshot-tested rendering, and the compaction handoff.
[gemini-cli](https://github.com/google-gemini/gemini-cli) — approval queues, loop
detection, context-usage display.
[hermes-agent](https://github.com/NousResearch/hermes-agent) — the streaming
think-scrubber, whose lesson this repo inherits directly.
[Terminus 2](https://github.com/harbor-framework/terminal-bench-1) — the
persistent-terminal contract and the dual parser.
[mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) — proof that a thin
tool set is enough.

---

## Developer

**Taewoo Park** — physics and spintronics at KAIST, building harnesses for
science and code. [taewoopark.com](https://taewoopark.com) ·
[GitHub](https://github.com/TaewoooPark) · [X](https://x.com/theoverstrcture) ·
[LinkedIn](https://www.linkedin.com/in/taewoo-park-427a05352)

Other repositories:

- [Agent-Blackbox](https://github.com/TaewoooPark/Agent-Blackbox) — a local-first flight recorder for coding agents: replay every run as a live session map, score the context bill, and write the fix back into `AGENTS.md`.
- [scholar-megasearch](https://github.com/TaewoooPark/scholar-megasearch) — one Claude Code skill that fans out subagents across 20+ scholarly databases and returns a deduplicated, ranked corpus with the PDFs.
- [MagLab](https://github.com/TaewoooPark/MagLab) — an AI-for-science harness for magnetism and spintronics research: literature, physics, simulation, fitting, figures, instruments and provenance in one CLI.
- [mumax3-ultrafast](https://github.com/TaewoooPark/mumax3-ultrafast) — a native Metal port of mumax³; the fastest micromagnetic simulator on a Mac.
- [spinloop](https://github.com/TaewoooPark/spinloop) — a Claude Code plugin that writes, runs, tunes and mesh-checks mumax3 simulations, and reproduces a paper figure from its PDF.
- [instrument-control-skills](https://github.com/TaewoooPark/instrument-control-skills) — nine agent skills for laboratory instrument-control code that is safe, accurate and complete in one shot.
- [OSICBench](https://github.com/TaewoooPark/OSICBench) — a benchmark for AI agents operating scientific instruments via code, scored on what physically happened.
- [UIForge](https://github.com/TaewoooPark/UIForge) — clone a website so it actually works, then restore it as pixel-identical, editable React.
- [Trendchaser](https://github.com/TaewoooPark/Trendchaser) — three short AI briefs a day, delivered to KakaoTalk.
- [personal-humanizer-maker](https://github.com/TaewoooPark/personal-humanizer-maker) — one sample of your writing becomes a Claude Code skill that rewrites any text in your own voice.
- [Sound-Code-Cube](https://github.com/TaewoooPark/Sound-Code-Cube) — an audiovisual instrument mapping music into code, sound and space.
- [Super-Crazy-Club](https://github.com/TaewoooPark/Super-Crazy-Club) — a terminal nightclub: an ASCII crowd dances to the record while a Codex agent shouts about the track.
- [Three.hangul](https://github.com/TaewoooPark/Three.hangul) — Hangul's initial, medial and final letters as three-dimensional vectors, interactive.

---

## Licence

Apache-2.0. The Motif-3 weights and chat template are MIT, from
[Motif-Technologies/Motif-3](https://huggingface.co/Motif-Technologies/Motif-3);
any derived checkpoint inherits that licence and credits the original.
Motifcode is not affiliated with Motif Technologies or Infron.
