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

| channel | shape | provenance |
|---|---|---|
| `toolcall` | native `<tool_call>{json}</tool_call>` | SWE-bench Verified **76.2** — mini-SWE-agent |
| `object` | the whole response is `{analysis, plan, commands[], task_complete}` | Terminal-Bench 2.1 **74.9** — Terminus 2, default parser |
| `raw` | the whole response is XML, command bodies **verbatim and unescaped** | Terminus 2's alternative parser — never measured on Motif |

`raw` is the experiment. Terminus 2's own instructions for it read *"DO NOT
XML-encode special characters — write them directly"*: the channel exists to
avoid string escaping, and string escaping is exactly what this model is
documented to get wrong. **The 74.9 was scored while paying that tax.**

When the breakage budget is exceeded the session downgrades on its own,
`toolcall → object → raw`, toward the channel that cannot suffer the failure
being observed.

---

## Status

Pre-alpha. **Nothing here has been run against Motif-3 yet** — no machine on hand
holds 187 GB of weights. Everything verifiable without the model has been
verified, and that turns out to cover most of the hard parts.

| Component | State |
|---|---|
| `protocol` — chat template | **byte-identical** to the real Jinja across 14 cases |
| `protocol` — tool-call repair | 11 golden cases from the vendor's own suite, all passing |
| `protocol` — reasoning scrubber | passing, including every split point of a marker |
| `protocol` — action channels | implemented; the comparison that matters needs the model |
| `tools` — frozen set + linter | passing |
| `core` — agent loop | passing, driven entirely by injected faults |
| `replay` — record / replay / fault injection | passing; a recorded session replays identically |
| `tui` — cells, two-region streaming, instruments | passing, snapshot-tested |
| `toolkit/prune` — surgery | unit-tested; dry-runs against the real checkpoint index |
| skills, hooks, subagents, session journal | not started |

Three errors were caught by writing the tests rather than the code: the pruning
surgery touches **ten** tensors per MoE layer, not six — the NVFP4 scale tensors
were missed; reordering tools costs more prefix than adding one; and the
breakage counter was under-reporting because a repair inside the JSON loader was
being scored as a clean parse, which would have kept the channel downgrade from
ever firing.

Because there is no model to misbehave, the loop is tested by **injecting the
misbehaviour**: invalid escapes, truncated tool calls, unparseable bodies, empty
turns and a dead server are all faults the suite produces on purpose.

---

## Quickstart

Needs Node 20+ and pnpm.

```bash
pnpm install
pnpm test          # 107 TypeScript tests
pnpm lint:tools    # schema linter — fails the build on loose schemas
pnpm typecheck
```

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
