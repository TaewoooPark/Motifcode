# Motifcode

**A coding agent built for one model.**

<p align="center">
  <img src="https://img.shields.io/github/last-commit/TaewoooPark/Motifcode?style=flat-square&labelColor=000000&color=333333" alt="Last commit">
  <img src="https://img.shields.io/github/languages/top/TaewoooPark/Motifcode?style=flat-square&labelColor=000000&color=333333" alt="Top language">
  <img src="https://img.shields.io/badge/license-Apache--2.0-000000?style=flat-square&labelColor=000000&color=333333" alt="Apache-2.0">
  &nbsp;
  <img src="https://img.shields.io/badge/TypeScript-000000?style=flat-square&logo=typescript&logoColor=white&labelColor=000000" alt="TypeScript">
  <img src="https://img.shields.io/badge/Python-000000?style=flat-square&logo=python&logoColor=white&labelColor=000000" alt="Python">
  <img src="https://img.shields.io/badge/Vitest-000000?style=flat-square&logo=vitest&logoColor=white&labelColor=000000" alt="Vitest">
  &nbsp;
  <img src="https://img.shields.io/badge/Motif--3-000000?style=flat-square&labelColor=000000&color=000000" alt="Motif-3">
  <img src="https://img.shields.io/badge/314B--A13B-000000?style=flat-square&labelColor=000000&color=000000" alt="314B-A13B">
  <img src="https://img.shields.io/badge/256K%20context-000000?style=flat-square&labelColor=000000&color=000000" alt="256K context">
  <img src="https://img.shields.io/badge/OpenAI--compatible%20endpoint-000000?style=flat-square&labelColor=000000&color=000000" alt="OpenAI-compatible endpoint">
  <img src="https://img.shields.io/badge/pre--alpha-000000?style=flat-square&labelColor=000000&color=000000" alt="pre-alpha">
</p>

Motifcode is a terminal coding agent whose tool set, prompt layout, parser and
failure handling are all **consequences of things that are specifically true
about [Motif-3](https://huggingface.co/Motif-Technologies/Motif-3)** — most of
them measured rather than assumed. It is not a general harness pointed at a
different base URL.

The model is reached over a **hosted OpenAI-compatible endpoint** with an API
key — the harness is the client, and nothing here serves weights any more. The
pruning toolkit that once targeted a single GB10 box (384 routed experts cut to
192, full 256K context, activated parameters untouched) is kept because the
surgery is hardware-independent; the bring-up scripts that stood the model up
locally are gone.

> *"A harness earns its keep by being a consequence of the model, not a wrapper around it."*

---

## Why a dedicated harness

Generic harnesses assume the model's tool calls parse, that the tool list is
free to change, and that reasoning is optional. None of those hold here — and
each one, checked, turns into a design constraint.

| Fact about Motif-3 | Source | What it forces |
|---|---|---|
| Frequently emits malformed JSON inside `<tool_call>`, failing on shell `\$` and regex `\s` | the vendor's own vLLM parser comments | A client-side repair ladder, a breakage budget, and channels that avoid string escaping altogether |
| The repair oracle validates candidates against tool schemas | same | Few tools, few parameters, closed schemas — enforced by a linter that fails the build |
| The tools block renders **before** the system prompt, in the same turn | `chat_template.jinja` | The tool list is frozen *and canonically ordered* for a session |
| Reordering two tools drops prefix reuse to **~24%** | **measured — `template.test.ts`** | Subsets are taken as prefixes, never as filters. Hence `done` leads the list |
| Intermediate reasoning renders **only** when tools are registered | **measured — `template.test.ts`** | Tools are registered on every channel, including those that never call them |
| Terminal-Bench 74.9 came from a persistent tmux session, not stateless subshells | Terminus 2 source | A `term` tool beside `bash` |
| SWE-bench 76.2 came from a single `bash` tool | mini-SWE-agent config | The thin tool set is the baseline, not a compromise |
| One repair turn erases a 2-bit quantisation penalty | *Half the Experts, All the Code* | The repair loop is core, not a nicety — we ship a pruned model |

---

## The three action channels

How the model expresses what it wants to do is a **runtime switch**, and none of
the three options was invented here. Each is borrowed from a harness in which
Motif-3 posted a published score.

A channel is not a parser. It picks the endpoint, the request body, the stop
sequences, and how the transcript is written down for the next turn:

| channel | endpoint | assistant turn | observation | provenance |
|---|---|---|---|---|
| `toolcall` | `/v1/chat/completions` | native `content` + `tool_calls` | `role: "tool"` | SWE-bench Verified **76.2** — mini-SWE-agent |
| `object` | `/v1/completions`, prompt rendered here | the model's JSON verbatim | a user turn | Terminal-Bench 2.1 **74.9** — Terminus 2, default parser |
| `raw` | `/v1/completions`, prompt rendered here | the model's XML verbatim | a user turn | Terminus 2's alternative parser — never measured on Motif |

Keeping the model's own body verbatim is the part that is easy to get wrong.
Parse a JSON response into actions, write those actions back as native
`tool_calls`, and from turn two the model is reading a transcript in the format
it was told not to use.

`raw` is the experiment. Terminus 2's own instructions for it read *"DO NOT
XML-encode special characters — write them directly"*: the channel exists to
avoid string escaping, and string escaping is exactly what this model is
documented to get wrong. **The 74.9 was scored while paying that tax.**

Neither `object` nor `raw` has been run against Motif-3, so both need
`--experimental-channel`. The default policy is `fixed`: the channel never
changes mid-session, which is what any comparable measurement requires.
`--channel-policy adaptive` moves toward a simpler channel after repeated parse
failures, and that move restarts the conversation with a new system turn — the
transcript formats are not interchangeable, and pretending otherwise would show
the model a conversation it never had.

---

## Status

Alpha. **It runs against Motif-3 over the hosted endpoint**, on the `toolcall`
channel: `motif doctor` confirms the server returns structured `tool_calls`,
separates reasoning into its own field, reports cached prompt tokens, and
advertises the full 262,144-token window; agent sessions complete and the
tests they write pass. The hosted endpoint has no `/v1/completions`, so the
`object` and `raw` channels cannot run there — `doctor` says so.

The interactive session has been checked against Claude Code's, feature by
feature, under a pseudo-terminal against the real endpoint: a streamed reply,
a file attached with `@`, a `!` shell line, a `#` note, `/commit` as a skill
command producing a real commit, `/compact` producing a real summary, the
permission prompt declining one command and allowing the next, `--continue`
picking a conversation back up, and a window shrunk mid-session without
leaving a row behind. What it does not have: image input, a rewind, and
vim keys.

Moving from a local server to a hosted one exposed a defect the fault-injected
suite had never reached: with a server that extracts tool calls, the native
channel wrote the assistant turn back **without its `tool_calls`**, so from turn
two the model saw an empty turn followed by a tool response to a call that was
not there. Fixed, and now the thing the end-to-end test checks on the wire. The
same move added what a hosted endpoint needs and a local one never did: a
credential that is read from `MOTIF_API_KEY` or `.env`, sent as a bearer token,
and **withheld from every command the agent runs**; a 401 that says which side
of the key it is on; a 429 retried after the server's own `Retry-After`.

Before that, the harness was run on one GB10 with 128 GB of unified memory,
serving a mixed-quant GGUF of the 314.8B/13B-activated checkpoint through a
llama.cpp-family runtime. What that campaign turned up is worth keeping,
because none of it was visible from the tests alone:

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
| `protocol` — action channels | implemented; `toolcall` exercised against the model, the other two only against fixtures — and unavailable on the hosted endpoint, which has no completions route |
| `tools` — frozen set + linter | passing; `write` added on evidence, and the tool ceiling raised to 9 with it |
| `core` — agent loop | passing, driven entirely by injected faults |
| `replay` — record / replay / fault injection | passing; a recorded session replays identically |
| `tui` — cells, two-region streaming, instruments, composer, slash menu | passing, snapshot-tested; the interactive session is driven end to end through a fake terminal |
| `skills` — registry + 9 built-in skills | passing |
| `agents` — 5 built-in subagents + local scheduler | passing |
| `hooks` — lifecycle shell hooks | passing |
| `journal` — append-only log, resume, trajectory export | passing |
| `cli` — `motif`, the interactive session, `doctor`, `sessions`, `resume`, `distil` | passing; runs end to end against a mock server, and against the hosted endpoint |
| `core` — endpoint config | `MOTIF_*` from flags, environment, `./.env`, `~/.motif/.env`; the key never enters the environment |
| `toolkit/prune` — surgery | unit-tested; dry-runs against the real checkpoint index |
| `toolkit/campaign` — manifest, score table | reports a campaign over the manifest's denominator |
| `eval` — polyglot runner, worktree grader | run end to end against the model |

Six errors were caught by testing rather than by reading: the pruning surgery
touches **ten** tensors per MoE layer, not six — the NVFP4 scale tensors were
missed; reordering tools costs more prefix than adding one; the breakage counter
scored a repair as a clean parse, which would have stopped the channel downgrade
from ever firing; a hook's output cap let a whole 64 KB chunk through; a circular
import left the skill parser uninitialised at load; and tool cells were being
committed to scrollback before their output arrived, so every command appeared
to produce nothing. The last two only surfaced when the CLI was run for real.

The loop is still tested by **injecting the misbehaviour** — invalid escapes,
truncated tool calls, unparseable bodies, empty turns and a dead server are all
faults the suite produces on purpose — and that remains the only way to test
most of it on a laptop. What running against the real model changed is which
faults are worth injecting: the announce-then-stop turn and the miscounted
patch are now in the suite because the model produced them, not because they
seemed plausible.

---

## Quickstart

Needs Node 20+ and pnpm, and an API key for the hosted endpoint.

```bash
cp .env.example .env               # then put the key in MOTIF_API_KEY
pnpm install
pnpm typecheck
pnpm build         # bundles the CLI to packages/cli/dist/motif.js
pnpm test          # unit, integration, CLI end-to-end, and an install smoke
pnpm lint:tools    # schema linter — fails the build on loose schemas

./packages/cli/dist/motif.js doctor    # probes the endpoint: auth, parsers, cache, channels
./packages/cli/dist/motif.js "fix the failing test in tests/" --cwd /path/to/repo
./packages/cli/dist/motif.js skills    # what is available
./packages/cli/dist/motif.js agents
```

`motif` on its own opens the interactive session: the transcript above, a
bordered prompt below, a hint line under it. It reads the way Claude Code
reads — your line after `>`, the model's prose and each tool call behind a
`⏺`, results under a `⎿`, reasoning hidden unless you ask for it. A reply
with no tool call ends the turn; a task that ends in work ends with `done`.
The conversation carries across tasks — the second sees the first and
everything the model did about it — and is compacted the way Codex does it
when it grows past `compactAt` of the window: the model writes a handoff
summary, your own messages are kept verbatim ahead of it, and the rest goes.

`@` opens a file picker as you type; `@path` attaches the file (or a
directory's listing) to the message, `@skill:name` attaches a skill's
instructions. `!command` runs a shell command right there and shows the model
its output. `#note` appends a line to `.motif/NOTES.md`, which every task
reads. `/` opens the command menu: `/help`, `/status`, `/config`, `/doctor`, `/model`,
`/endpoint`, `/channel`, `/max-turns`, `/max-tokens`, `/seed`, `/theme`,
`/thinking`, `/compact`, `/compact-at`, `/cwd`, `/skills`, `/agents`,
`/plugins`, `/new`, `/sessions`, `/resume` (a numbered list, or a number, or a file), `/quit`;
`motif --continue` opens the prompt with the latest conversation here loaded.
By default the session asks before a command, a write, a patch or the
terminal runs — `y` once, `a` for that tool all session, `n` to decline, and
the model is told about a refusal; Shift-Tab or `/permissions auto` runs
everything without asking, as `--dangerously-skip-permissions` does in Claude
Code, and the choice is remembered.
The reply streams in as the model writes it; Ctrl-O shows tool output in
full; Ctrl-L redraws. Skills are commands too:
`/commit fix the parser` runs the `commit` skill with that input. A setting changed at the
prompt is saved to `~/.motif/settings.json`. Esc interrupts a running task; a
message sent while one runs is queued; `?` lists the keys; Ctrl-C twice quits.
Each task writes its own journal, and each journal's last checkpoint holds the
whole conversation so far, which is what `/resume` reads back.

The `.motif` directory is the backend, laid out the way Claude Code lays out
`.claude`:

```
~/.motif/settings.json      your defaults: model, endpoint, channel, budgets, theme, thinking, compactAt
~/.motif/.env               the credential (see below)
~/.motif/skills/<n>/SKILL.md, ~/.motif/agents/<n>.md      yours, on every project
<repo>/.motif/settings.json the project's settings and hooks — applied once `motif trust` approves it
<repo>/.motif/skills/, agents/, NOTES.md                    the project's
~/.motif/plugins/<n>/, <repo>/.motif/plugins/<n>/          plugin.json + skills/ + agents/, Claude Code's layout
<repo>/.motif/sessions/*.jsonl                              one journal per task
<repo>/.motif/history.jsonl                                 what you typed, for ↑
```

A subagent file is Markdown with frontmatter — `name`, `description`,
`tools` (a count, or a prefix of the canonical list), `readOnly`, `maxTurns`
— and the instructions as the body. Themes: `motif`, `claude`, `mono`,
`solarized`, `dracula`, via `/theme`, `--theme`, or the settings file.

`MOTIF_API_KEY`, `MOTIF_ENDPOINT` and `MOTIF_MODEL` are read from the
environment, then `./.env`, then `~/.motif/.env` (`--env-file` puts a file
first); flags outrank all of them. Only `MOTIF_*` keys are read, none of them
are exported, and the key is removed from the harness's own environment before
anything is spawned — the agent's `bash` cannot see it, and neither can a
project hook. The defaults are `https://llm.onerouter.pro` and `motif/motif-3`;
a base URL pasted with its `/v1` works too.

The Python toolkit needs a real tensor backend for its slicing tests:

```bash
pip install -r toolkit/requirements-dev.txt
MOTIF_REQUIRE_TORCH=1 python -m unittest discover -s toolkit/prune -p 'test_*.py'
```

Built-in skills: `explore`, `plan`, `explain`, `code-review`,
`security-review`, `test-fix`, `debug`, `refactor`, `commit`, `pr-body`,
`docs`, `init` (writes the project notes), `skill-creator`, plus
`motif-endpoint` (the endpoint is the most common cause of bad output here,
and `doctor` measures it) and `korean`. Built-in subagents:
`explorer`, `reviewer`, `tester`, `planner`, `patcher` — each taking a
canonical-order **prefix** of the tool list, which is also why none of them can
spawn another.

Python side (jinja2 only — no weights, no GPU):

```bash
python3 toolkit/fixtures/gen_template_golden.py     # regenerate prompt goldens
cd toolkit/prune && python3 -m unittest test_surgery
```

Plan the pruning surgery against the real checkpoint index, on any laptop:

```bash
python3 toolkit/prune/surgery.py \
  --index toolkit/prune/testdata/motif3-nvfp4.index.json --keep-count 192
```

---

## Repository

```
packages/protocol/   chat template · tool-call repair · reasoning scrubber · channels
packages/tools/      the frozen tool set and its linter
packages/core/       agent loop · context ledger · breakage budget · loop guard
packages/replay/     record, replay and deliberately break the transport
packages/tui/        typed cells · two-region streaming · local instruments
packages/skills/     skill registry and the built-in skills
packages/agents/     subagent definitions and the local scheduler
packages/hooks/      lifecycle shell hooks
packages/journal/    append-only session log, resume, trajectory export
packages/cli/        the `motif` command
packages/eval/       polyglot suite, campaign runner, worktree grader
toolkit/fixtures/    golden-prompt generator (jinja2 only)
toolkit/prune/       expert-pruning surgery and its plan
toolkit/campaign/    eval manifest writer and campaign score table
corpus/              vendored template + generated goldens
```

---

## Prior art read closely

[Codex](https://github.com/openai/codex) — typed history cells, two-region
streaming, snapshot-tested rendering.
[gemini-cli](https://github.com/google-gemini/gemini-cli) — approval queues, loop
detection, context-usage display.
[hermes-agent](https://github.com/NousResearch/hermes-agent) — the streaming
think-scrubber, whose lesson this repo inherits directly.
[Terminus 2](https://github.com/harbor-framework/terminal-bench-1) — the
persistent-terminal contract and the dual parser.
[mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) — proof that a thin
tool set is enough.

---

## Licence

Apache-2.0. The Motif-3 weights and chat template are MIT, from
[Motif-Technologies/Motif-3](https://huggingface.co/Motif-Technologies/Motif-3);
any derived checkpoint inherits that licence and credits the original.
