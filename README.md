```
 ██████   ██████    ███████    ███████████ █████ ███████████   █████████     ███████    ██████████   ██████████
▒▒██████ ██████   ███▒▒▒▒▒███ ▒█▒▒▒███▒▒▒█▒▒███ ▒▒███▒▒▒▒▒▒█  ███▒▒▒▒▒███  ███▒▒▒▒▒███ ▒▒███▒▒▒▒███ ▒▒███▒▒▒▒▒█
 ▒███▒█████▒███  ███     ▒▒███▒   ▒███  ▒  ▒███  ▒███   █ ▒  ███     ▒▒▒  ███     ▒▒███ ▒███   ▒▒███ ▒███  █ ▒ 
 ▒███▒▒███ ▒███ ▒███      ▒███    ▒███     ▒███  ▒███████   ▒███         ▒███      ▒███ ▒███    ▒███ ▒██████   
 ▒███ ▒▒▒  ▒███ ▒███      ▒███    ▒███     ▒███  ▒███▒▒▒█   ▒███         ▒███      ▒███ ▒███    ▒███ ▒███▒▒█   
 ▒███      ▒███ ▒▒███     ███     ▒███     ▒███  ▒███  ▒    ▒▒███     ███▒▒███     ███  ▒███    ███  ▒███ ▒   █
 █████     █████ ▒▒▒███████▒      █████    █████ █████       ▒▒█████████  ▒▒▒███████▒   ██████████   ██████████
▒▒▒▒▒     ▒▒▒▒▒    ▒▒▒▒▒▒▒       ▒▒▒▒▒    ▒▒▒▒▒ ▒▒▒▒▒         ▒▒▒▒▒▒▒▒▒     ▒▒▒▒▒▒▒    ▒▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒ 
```

A coding agent built for one model.

Not a general harness with a different base URL — a harness whose tool set,
prompt layout, parser and failure handling are all consequences of things that
are specifically true about **Motif-3**, most of them measured rather than
assumed.

Two artifacts ship together: this harness, and a coding-specialised checkpoint
pruned to run on a single GB10 box.

---

## Why a dedicated harness

| Fact about Motif-3 | Source | What it forces |
|---|---|---|
| Frequently emits malformed JSON inside `<tool_call>`, failing on shell `\$` and regex `\s` | the vendor's own vLLM parser comments | A client-side repair ladder, a breakage budget, and channels that avoid string escaping altogether |
| The repair oracle validates candidates against tool schemas | same | Few tools, few parameters, closed schemas — enforced by a linter that fails the build |
| The tools block renders **before** the system prompt, in the same turn | `chat_template.jinja` | The tool list is frozen *and canonically ordered* for a session |
| Reordering two tools drops prefix reuse to ~24% | **measured, `template.test.ts`** | Subsets are taken as prefixes, never as filters |
| Intermediate reasoning renders only when tools are registered | **measured, `template.test.ts`** | At least one tool is always registered, even on channels that do not use function calling |
| Terminal-Bench 74.9 came from a persistent tmux session, not stateless subshells | Terminus 2 source | A `term` tool alongside `bash` |
| SWE-bench 76.2 came from a single `bash` tool | mini-SWE-agent config | The thin tool set is the baseline, not a compromise |
| One repair turn erases a 2-bit quantisation penalty | *Half the Experts, All the Code* | The repair loop is core, not a nicety — we ship a pruned model |

## Status

Pre-alpha. **Nothing here has been run against Motif-3 yet** — no machine on hand
holds 187 GB of weights. Everything that can be verified without the model has
been, and that turns out to be most of the hard parts.

| Component | State |
|---|---|
| `@motifcode/protocol` — chat template | **byte-identical** to the real Jinja across 14 cases |
| `@motifcode/protocol` — tool-call repair | 11 golden cases from the vendor's own test suite, all passing |
| `@motifcode/protocol` — reasoning scrubber | passing, including every split point of a marker |
| `@motifcode/protocol` — action channels | implemented; the interesting comparison needs the model |
| `@motifcode/tools` — frozen set + linter | passing |
| `toolkit/prune` — surgery | planned and unit-tested; dry-runs against the real checkpoint index |
| core loop, TUI, skills, hooks, subagents | not started |

```bash
pnpm install
pnpm test          # 59 TypeScript tests
pnpm lint:tools    # schema linter
cd toolkit/prune && python3 -m unittest test_surgery   # 14 Python tests
```

## The three action channels

The model can express what it wants to do in three ways, and each one is
borrowed from a harness in which Motif-3 posted a published score:

| channel | shape | provenance |
|---|---|---|
| `toolcall` | native `<tool_call>{json}</tool_call>` | SWE-bench Verified 76.2 (mini-SWE-agent) |
| `object` | the whole response is `{analysis, plan, commands[], task_complete}` | Terminal-Bench 2.1 74.9 (Terminus 2, default parser) |
| `raw` | the whole response is XML, command bodies **verbatim and unescaped** | Terminus 2's alternative parser — never measured on Motif |

`raw` is the experiment. Terminus 2's own instructions for it read *"DO NOT
XML-encode special characters — write them directly"*: the channel exists to
avoid string escaping, and string escaping is precisely what Motif is documented
to get wrong. The 74.9 was scored while paying that tax.

## Repository

```
packages/protocol/   chat template · tool-call repair · reasoning scrubber · channels
packages/tools/      the frozen tool set and its linter
toolkit/fixtures/    golden-prompt generator (jinja2 only — no weights, no GPU)
toolkit/prune/       expert-pruning surgery and its plan
corpus/              vendored template + generated goldens
```

## Prior art read closely

Codex (typed history cells, two-region streaming, snapshot-tested rendering),
gemini-cli (approval queues, loop detection), hermes-agent (the streaming
think-scrubber, whose lesson this repo inherits directly), Terminus 2 (the
persistent-terminal contract and the dual parser), mini-SWE-agent (proof that a
thin tool set is enough).

## Licence

Apache-2.0. The Motif-3 weights and chat template are MIT, from
[Motif-Technologies/Motif-3](https://huggingface.co/Motif-Technologies/Motif-3);
any derived checkpoint inherits that licence and credits the original.
