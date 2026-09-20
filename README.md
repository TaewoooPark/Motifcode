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
session checked feature by feature against Claude Code's.

---

## What it looks like

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/screen-large.jpg" alt="motif in a wide terminal" width="100%"><br>
      <sub><b>Wide window.</b> The hero, the welcome card and the prompt.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/screen-small.jpg" alt="motif in a narrow terminal" width="100%"><br>
      <sub><b>Narrow window.</b> The hero picks the size that fits; the session is the same.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/screen-login.jpg" alt="the first run asks for the API key" width="100%"><br>
      <sub><b>First run.</b> The Infron API key is asked for in place of the prompt, checked, and saved once.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/screen-skills.jpg" alt="the /skills list" width="100%"><br>
      <sub><b><code>/skills</code>.</b> The fifteen built-in skills, each of them also a command: <code>/commit fix the parser</code>.</sub>
    </td>
  </tr>
</table>

The hero fits the window; the welcome card says what to type; the first run
asks for the key in place of the prompt. In a session, your line follows `>`,
the model's prose and each tool call sit behind a `⏺`, results under a `⎿`,
reasoning stays hidden unless you ask for it, and the status line shows the
context used and how much of the prompt the server served from cache.

---

## Install and use

Needs **Node 20+**. The package is one file with no runtime dependencies.

```bash
cd your-project
npx motifcode          # first run: asks for your key, then offers to install the `motif` command
```

The first session asks for your Infron API key, once, and saves it to
`~/.motif/.env`. Because `npx` leaves no command behind, it then offers to run
`npm install -g motifcode` for you; say yes and `motif` (or `motifcode`) opens
the session from any folder from then on. `npm install -g motifcode` directly
does the same without the question.

| command | what it does |
|---|---|
| `motif` | open the interactive session in the current directory |
| `motif --continue` | the same, with the latest conversation here loaded |
| `motif "<task>"` | run one task and exit; `--interactive` stays in the session afterwards |
| `motif -p "<question>"` | print only the final reply, for scripts and pipes |
| `motif login` · `motif logout` | paste a key outside a session; remove the saved key |
| `motif doctor` | probe the endpoint: auth, tool-call and reasoning parsers, prefix cache, channels |
| `motif sessions` · `motif resume <file>` | list recorded sessions; resume an interrupted one |
| `motif skills` · `agents` · `plugins` · `config` | what is loaded, and the effective settings with their sources |
| `motif trust` | approve this repository's `.motif/settings.json` hooks |

Flags: `--model`, `--endpoint`, `--env-file`, `--theme`, `--thinking`,
`--verbose`, `--permissions ask|auto`, `--cwd`, `--channel`, `--max-turns`,
`--max-output-tokens`, `--seed`, `--no-hero`. `motif --help` has the full list.

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
4. `motif doctor` confirms the connection and reports how the server returns
   tool calls and reasoning and whether prefix caching is on.

**Free through September 2026.** At the time of writing Infron lists the model
as *Motif: Motif 3 (Free)* at $0 per million tokens for input and output, and
has announced free access through the end of September 2026. Check the
[model page](https://infron.ai/models/motif/motif-3) and Infron's
[free-model terms](https://infron.ai/docs/overview/free-models) for the current
conditions.

Only `MOTIF_*` keys are read from a `.env` file, none of them are exported, and
the key is removed from the harness's own environment before anything is
spawned — the agent's `bash` cannot see it, and neither can a project hook.

---

## Commands and keys

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

```
enter send · \ + enter newline · esc interrupt or clear · ctrl-c twice quit · ctrl-d quit
↑ ↓ history · tab show or hide reasoning · ctrl-o full tool output · ctrl-l redraw · shift-tab permissions
@ attach a file · ! run a shell line · # add a project note · / commands · ? hide this
```

---

## Features

| area | what you get |
|---|---|
| Session | Replies stream in as the model writes; reasoning stays out of the transcript unless `--thinking` or `/thinking` asks for it; tool calls behind `⏺`, results under `⎿`; a status line with context used and the prefix-cache ratio |
| Input | `@path` attaches a file or a directory listing, with a picker as you type; `@skill:name` attaches a skill's instructions; `!command` runs a shell line and shows the model its output; `#note` appends to `.motif/NOTES.md`; `\` + Enter for a newline; long pastes collapsed; Hangul and other wide text handled by display width; ↑↓ history |
| Commands | `/` opens a menu of every setting; a change made at the prompt is saved to `~/.motif/settings.json`; skills run as commands (`/commit fix the parser`); `?` lists the keys |
| Permissions | A numbered prompt before a command, a write, a patch or the terminal runs; "don't ask again for this tool"; a refusal the model is told about; Shift-Tab or `/permissions auto` runs everything |
| Conversation | Each task sees the ones before it; `--continue` and `/resume` bring a recorded conversation back; messages sent while a task runs are queued; Esc interrupts; Codex-style compaction past `compactAt` of the window — the model writes a handoff summary and your own messages are kept verbatim — and `/compact <focus>` on demand |
| Backend | `.motif/` laid out like Claude Code's `.claude/`: user and project settings, skills, agents, plugins, notes, one journal per task, history; project hooks applied once `motif trust` approves them |
| Skills and agents | 15 built-in skills (`explore`, `plan`, `explain`, `code-review`, `security-review`, `test-fix`, `debug`, `refactor`, `commit`, `pr-body`, `docs`, `init`, `skill-creator`, `motif-endpoint`, `korean`); 5 built-in subagents (`explorer`, `reviewer`, `tester`, `planner`, `patcher`) with prefix tool sets and a local scheduler; plugins in Claude Code's layout |
| Endpoint | The key asked for once and saved to `~/.motif/.env`, withheld from every command the agent runs; a 401 that says which side of the key it is on; a 429 retried after the server's `Retry-After`; `motif doctor` reports what the server actually returns |
| Screen | Shrinking the window mid-session leaves no stale rows; five themes (`motif`, `claude`, `mono`, `solarized`, `dracula`) swapped in place |
| Scripts | `motif -p "question"` prints only the reply; `motif "task"` runs one task and exits |

A skill is a `SKILL.md` with frontmatter (`name`, `description`) and the
instructions as the body; `$ARGUMENTS` is replaced by what follows the command.
A subagent is Markdown with frontmatter — `name`, `description`, `tools` (a
count, or a prefix of the canonical list), `readOnly`, `maxTurns`. A plugin is
a directory with `plugin.json` and its own `skills/` and `agents/`.

```
~/.motif/settings.json      your defaults: model, endpoint, channel, budgets, theme, thinking, compactAt, permissions
~/.motif/.env               the credential
~/.motif/skills/<n>/SKILL.md, ~/.motif/agents/<n>.md      yours, on every project
<repo>/.motif/settings.json the project's settings and hooks — applied once `motif trust` approves it
<repo>/.motif/skills/, agents/, NOTES.md                    the project's
~/.motif/plugins/<n>/, <repo>/.motif/plugins/<n>/          plugin.json + skills/ + agents/
<repo>/.motif/sessions/*.jsonl                              one journal per task
<repo>/.motif/history.jsonl                                 what you typed, for ↑
```

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

How the model expresses an action is a runtime switch, each option borrowed
from a harness in which Motif-3 posted a published score:

| channel | endpoint | assistant turn | provenance |
|---|---|---|---|
| `toolcall` | `/v1/chat/completions` | native `content` + `tool_calls` | SWE-bench Verified **76.2** — mini-SWE-agent |
| `object` | `/v1/completions`, prompt rendered here | the model's JSON verbatim | Terminal-Bench 2.1 **74.9** — Terminus 2, default parser |
| `raw` | `/v1/completions`, prompt rendered here | the model's XML verbatim | Terminus 2's alternative parser — never measured on Motif |

The model's own body is kept verbatim in the transcript, whatever the channel:
parse a JSON response into actions and write them back as native `tool_calls`,
and from turn two the model reads a format it was told not to use. The hosted
endpoint has no `/v1/completions`, so only `toolcall` runs there; the other two
need `--experimental-channel` and a server with a completions route.

Moving from a local server to the hosted one exposed a defect the fault-injected
suite had never reached — with a server that extracts tool calls, the native
channel wrote the assistant turn back without its `tool_calls` — which is now
what the end-to-end test checks on the wire. The loop is still tested by
injecting the misbehaviour: invalid escapes, truncated tool calls, unparseable
bodies, empty turns and a dead server are all faults the suite produces on
purpose, and the ones the real model produced are in it because it did.

### Measured against the hosted endpoint

Checked directly against `llm.onerouter.pro`, 2026-09-20, and what each finding
forced:

| What the endpoint does | What it means here |
|---|---|
| Returns `tool_calls`, `reasoning` and `usage.prompt_tokens_details.cached_tokens` as their own fields | The native `toolcall` channel is the one that runs; the client repair ladder is a second line of defence behind the server's own |
| Renders an assistant turn's `reasoning_content` back into the prompt, and reuses the frozen tools-and-system prefix from the second identical request onward | Reasoning continuity and the frozen tool order are load-bearing, not decoration — real sessions run 90–98% of each prompt from cache |
| Has no `/v1/completions` | The `object` and `raw` channels, the adaptive downgrade and `toolkit/prune/` need a local completions-capable server; they do not run here |
| Occasionally writes a tool call as a bare object with no `<tool_call>` tags | Recovered and run rather than shown as an answer — the same job the ladder does for malformed JSON *inside* the tags |

The three protocols the router exposes — `/v1/chat/completions`,
`/v1/responses` and Anthropic-style `/v1/messages` — mean Motif-3 is reachable
from Codex, Claude Code and other harnesses too; what this one adds is a prompt
laid out for the model's own template, a much smaller per-request context, and
handling for the turn the model drops.

### Motif-3 links

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
packages/cli/        the `motif` command, the interactive session, login, doctor, plugins
packages/eval/       polyglot suite, campaign runner, worktree grader
toolkit/             prompt goldens (jinja2), expert-pruning surgery, campaign score table
corpus/              vendored template + generated goldens
docs/                logo, screenshots, model guide
```

```bash
pnpm install && pnpm typecheck && pnpm build
pnpm test          # unit, integration, CLI end-to-end, and an install smoke
pnpm lint:tools    # schema linter — fails the build on loose schemas
```

To release, bump `version` in both `package.json` files and `VERSION` in
`packages/cli/src/main.ts`, commit, and push a tag (`git tag v0.3.0 && git push
origin v0.3.0`); the release workflow runs the suite and publishes to npm through
trusted publishing, with provenance and no stored token.

Prior art read closely: [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
for the session's shape; [Codex](https://github.com/openai/codex) for typed history
cells, two-region streaming and the compaction handoff;
[gemini-cli](https://github.com/google-gemini/gemini-cli) for approval queues and loop
detection; [hermes-agent](https://github.com/NousResearch/hermes-agent) for the
streaming think-scrubber; [Terminus 2](https://github.com/harbor-framework/terminal-bench-1)
for the persistent-terminal contract; [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent)
for proof that a thin tool set is enough.

---

## Developer

**Taewoo Park** — physics and spintronics at KAIST, building harnesses for
science and code. [taewoopark.com](https://taewoopark.com) ·
[GitHub](https://github.com/TaewoooPark) · [X](https://x.com/theoverstrcture) ·
[LinkedIn](https://www.linkedin.com/in/taewoo-park-427a05352)

---

## Licence

Apache-2.0. The Motif-3 weights and chat template are MIT, from
[Motif-Technologies/Motif-3](https://huggingface.co/Motif-Technologies/Motif-3);
any derived checkpoint inherits that licence and credits the original.
Motifcode is not affiliated with Motif Technologies or Infron.
