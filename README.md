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
  <img src="https://img.shields.io/badge/vLLM-000000?style=flat-square&labelColor=000000&color=000000" alt="vLLM">
  &nbsp;
  <img src="https://img.shields.io/badge/Motif--3-000000?style=flat-square&labelColor=000000&color=000000" alt="Motif-3">
  <img src="https://img.shields.io/badge/314B--A13B-000000?style=flat-square&labelColor=000000&color=000000" alt="314B-A13B">
  <img src="https://img.shields.io/badge/256K%20context-000000?style=flat-square&labelColor=000000&color=000000" alt="256K context">
  <img src="https://img.shields.io/badge/Local--first-000000?style=flat-square&labelColor=000000&color=000000" alt="Local-first">
  <img src="https://img.shields.io/badge/pre--alpha-000000?style=flat-square&labelColor=000000&color=000000" alt="pre-alpha">
</p>

Motifcode is a terminal coding agent whose tool set, prompt layout, parser and
failure handling are all **consequences of things that are specifically true
about [Motif-3](https://huggingface.co/Motif-Technologies/Motif-3)** — most of
them measured rather than assumed. It is not a general harness pointed at a
different base URL.

Two artifacts ship together: this harness, and a **coding-specialised checkpoint
pruned to fit a single GB10 box** — 384 routed experts cut to 192, which keeps
the full 256K context and leaves the activated parameters, and therefore the
decode speed, untouched.

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

Alpha. **It has now been run against Motif-3**, on one GB10 with 128 GB of
unified memory, serving a mixed-quant GGUF of the 314.8B/13B-activated
checkpoint through a llama.cpp-family runtime. Agent sessions complete, tests
run, and the polyglot grader scores them.

What that turned up is worth stating plainly, because none of it was visible
from the tests alone:

| Measured over one polyglot campaign | |
|---|---|
| `apply_patch` calls that applied | **1 of 12** — patches ending without a newline, hunk counts off by one, and `git apply` reporting both in the host's language |
| edit attempts routed through shell heredocs instead | **85%** |
| output tokens spent rewriting a file already written | **~30%** |
| turns that produced no action at all | **21%**, and a no-action turn was followed by another **55.7%** of the time against 20.6% after a turn that acted |
| decode throughput | 11.8 tok/s single stream, **36% of what the memory bandwidth allows** |

Every one of those is a harness or runtime defect rather than a model
limitation, and the first four are fixed in this release. The measurements are
in the journals; `toolkit/serving/report_campaign.py` reads them.

| Component | State |
|---|---|
| `protocol` — chat template | **byte-identical** to the real Jinja across 14 cases |
| `protocol` — tool-call repair | 11 golden cases from the vendor's own suite, all passing |
| `protocol` — reasoning scrubber | passing, including every split point of a marker |
| `protocol` — action channels | implemented; `toolcall` exercised against the model, the other two still only against fixtures |
| `tools` — frozen set + linter | passing; `write` added on evidence, and the tool ceiling raised to 9 with it |
| `core` — agent loop | passing, driven entirely by injected faults |
| `replay` — record / replay / fault injection | passing; a recorded session replays identically |
| `tui` — cells, two-region streaming, instruments | passing, snapshot-tested |
| `skills` — registry + 9 built-in skills | passing |
| `agents` — 5 built-in subagents + local scheduler | passing |
| `hooks` — lifecycle shell hooks | passing |
| `journal` — append-only log, resume, trajectory export | passing |
| `cli` — `motif`, `doctor`, `sessions`, `resume`, `distil` | passing; runs end to end against a mock server |
| `toolkit/prune` — surgery | unit-tested; dry-runs against the real checkpoint index |
| `toolkit/serving` — bring-up, manifest, score table | used to stand the model up and to report a campaign |
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

Needs Node 20+ and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm build         # bundles the CLI to packages/cli/dist/motif.js
pnpm test          # unit, integration, CLI end-to-end, and an install smoke
pnpm lint:tools    # schema linter — fails the build on loose schemas

./packages/cli/dist/motif.js doctor    # check a server
./packages/cli/dist/motif.js skills    # what is available
./packages/cli/dist/motif.js agents
```

The Python toolkit needs a real tensor backend for its slicing tests:

```bash
pip install -r toolkit/requirements-dev.txt
MOTIF_REQUIRE_TORCH=1 python -m unittest discover -s toolkit/prune -p 'test_*.py'
```

Built-in skills: `explore`, `code-review`, `test-fix`, `debug`, `commit`,
`pr-body`, `skill-creator`, plus `motif-serving` (server misconfiguration is the
most common cause of bad output here) and `korean`. Built-in subagents:
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
toolkit/fixtures/    golden-prompt generator (jinja2 only)
toolkit/prune/       expert-pruning surgery and its plan
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
