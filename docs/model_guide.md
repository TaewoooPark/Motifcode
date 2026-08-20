# Pruning Motif-3 for GB10

| | |
|---|---|
| document schema | `motifcode.guide/v2` |
| last verified | 2026-08-20 |
| source checkpoint | `Motif-Technologies/Motif-3-NVFP4` @ `3a4416f7b555720d36e41f93207b826003ffe327` |
| reference architecture | `Motif-Technologies/Motif-3` @ `883d5c441fe3bb994c7b57e60f49e26147f85512` |
| serving runtime | Motif vLLM fork @ `4cd9eb4129883565e69d508038d783d59ee01867` (not yet built here) |
| implementation | `toolkit/prune/`, tested by `toolkit/prune/test_*.py` |

This is the normative plan. It is tracked in git so that a change to the code
and a change to the plan land in the same review; a guide that lives outside
version control drifts from the thing it describes and nobody finds out until a
command fails.

## How to read a claim here

Every load-bearing statement carries a label. Without them a reader cannot tell
a measurement from an intention, and this document contains both.

| label | means | needs |
|---|---|---|
| `FACT` | verified against a pinned primary source | URL, revision, file, hash |
| `MEASURED` | observed on this hardware, by this code | environment and a raw log |
| `INFERENCE` | computed from a fact or a measurement | the formula and its inputs |
| `HYPOTHESIS` | expected before the experiment | what would falsify it |
| `BLOCKED` | a prerequisite is not met | the blocker and the unblock condition |

An unlabelled sentence is background, not evidence.

---

## 1. What this is for

Motif-3 is 314B parameters total, 13B activated. `FACT` — `config.json`:
`num_experts: 384`, `experts_top_k: 8`, `num_hidden_layers: 53`,
`n_dense_first_layers: 2`, `quant_method: modelopt_nvfp4`.

The NVFP4 checkpoint is 186,891,034,892 bytes across 155 shards. `MEASURED` —
`model.safetensors.index.json` `metadata.total_size`, and the shard files on
disk, 2026-08-20.

A GB10 has 128 GB of coherent unified memory at 273 GB/s. `FACT` —
[NVIDIA DGX Spark hardware](https://docs.nvidia.com/dgx/dgx-spark/hardware.html).
On this particular machine the OS reports 121 GiB total and about 118 GiB
available at rest. `MEASURED` — `free -g` on `zgx-1c3b`, 2026-08-20. The 121.6
GiB figure that appeared in earlier drafts of this guide is that
machine-specific observation, not a general specification, and the two should
not be interchanged.

So the checkpoint does not fit, and the gap is not marginal. About 98% of the
parameters are routed experts, which makes the size problem an expert-bank
problem and dropping experts the only lever that moves it without inventing a
new numeric format.

### What is not the point

Pruning does not make decode faster. `experts_top_k` stays at 8, so the same
number of experts is consulted per token and activated parameters are unchanged.
`INFERENCE` — from `experts_top_k` being unmodified by the surgery, which
`toolkit/prune/test_surgery.py::test_top_k_does_not` pins. What changes is
whether the model fits at all, and how much memory is left for KV cache.

---

## 2. The checkpoint, as it actually is

All `MEASURED` against the pinned revision on 2026-08-20, by reading the
safetensors headers — no weights loaded.

```text
source revision       3a4416f7b555720d36e41f93207b826003ffe327
indexed tensors       2440
shards                155
total_size            186891034892
MoE layers            51  (2..52 inclusive)
num_experts           384
experts_top_k         8

expert-axis tensors inside the index      510   (10 per layer)
expert-axis tensors in the sidecar        102   ( 2 per layer)
tensors a surgery must slice              612
```

### The sidecar is the part that gets missed

`nvfp4_act_scales.safetensors` is 166,872 bytes, SHA-256
`c7cbea201c128079fdbe6b106a11c49499e65d07b963619900544d14b670c24b`. `MEASURED`.
It holds 102 F32 `[384]` tensors — `a13_gscale` and `a2_gscale` for each of
layers 2 through 52 — and **the safetensors index does not mention it**.

Slicing only the 510 indexed tensors leaves this file untouched, and that does
not crash. Motif's loader falls back to a gscale of 1 when the sidecar is
absent; worse, if the original `[384]` file is copied through, a single-rank
loader takes the first `K` entries, so survivor `j` receives the activation
scale belonging to original expert `j` rather than to `keep[j]`. The model
loads, runs, and is quietly miscalibrated. `FACT` —
[the loader's sidecar handling](https://github.com/MotifTechnologies/vllm/blob/4cd9eb4129883565e69d508038d783d59ee01867/vllm/model_executor/layers/fused_moe/motif_nvfp4_experts.py#L112-L143)
and [its single-rank scale selection](https://github.com/MotifTechnologies/vllm/blob/4cd9eb4129883565e69d508038d783d59ee01867/vllm/model_executor/layers/fused_moe/motif_nvfp4_experts.py#L275-L302).

`toolkit/prune/test_surgery.py` slices the sidecar with a deliberately
non-contiguous keep-list, so first-K and `keep[j]` cannot coincide by accident.

### Only the routed experts are quantised

`MEASURED` — from the shard headers. Attention, the mHC blocks, layer norms,
router gates and shared experts are all plain BF16. The packed tensors are only:

```text
moe.experts.gate_up_proj              U8       [384, 2560, 2048]
moe.experts.gate_up_proj_weight_scale F8_E4M3  [384, 2560,  256]
moe.experts.down_proj                 U8       [384, 4096,  640]
moe.experts.down_proj_weight_scale    F8_E4M3  [384, 4096,   80]
```

with a per-expert F32 `weight_scale_2`. Group size is 16 along the input
dimension: 4096/256 and 1280/80. `INFERENCE` from those shapes.

This split is what makes the profiler possible: 173 GB of experts to stream, 14
GB of everything else to hold.

### Routing, precisely

`FACT` — `TokenChoiceTopKRouter.forward` in the reference `modeling_motif.py`.
Selection is `topk(sigmoid(logits) + expert_bias)`; the returned weights are
gathered from the raw sigmoid *without* the bias, then normalised over the
selected k and multiplied by `route_scale = 2.0`.

So the bias decides *which* experts are chosen but does not enter the weight.
Any statistic called "gate mass" has to say which of those it includes, and the
profile manifest records it (`gate_sum_includes_route_scale`,
`selection_bias_applied`).

Motif-3 was trained with explicit load balancing — an auxiliary-loss-free
selection bias plus a sequence-wise balancing loss. `FACT` — `load_balance_coeff`
in `config.json` and §5 of the [technical report](https://arxiv.org/html/2608.09119v1).
Usage is therefore close to uniform by construction, which is why ranking
experts by raw frequency finds nothing.

---

## 3. Choosing what to keep

### Why the earlier plan was one method wearing three names

The first version of this pipeline offered `count`, `mass` and `blend` and
called them three criteria to compare. All three were a ratio of a target corpus
to a reference corpus, so all three shared one failure: an expert that both
corpora lean on heavily scores near 1.0 and is cut, even though every token
depends on it.

The pruning literature found exactly that collapse pushing pure contrast to 50%
on Qwen. `FACT` — [Half the Experts, All the Code](https://arxiv.org/html/2607.16721v1).
Three criteria agreeing is not corroboration when they are the same criterion.

### The family that replaces them

Implemented in `toolkit/prune/select_experts.py`; each writes its exact formula
into the keep-list document, because "REAP" means several things in the wild.

| criterion | what it ranks by | role |
|---|---|---|
| `reap` | `Σ g_e(x)·‖f_e(x)‖₂` over routed tokens | production default |
| `gate_mass` | `Σ g_e(x)` | REAP's first half |
| `man` | mean output norm | REAP's second half |
| `guard_reap` | protect the reference corpus's top-N, then target REAP | preserves off-domain capability by construction |
| `hybrid_share` | `F_T² / (F_T + F_R + ε)` | target-weighted, cannot ratio away absolute flow |
| `random` | uniform, multi-seed | control |
| `contrastive` | the old default | **negative** control |

`HYPOTHESIS` — REAP or `guard_reap` will beat the others on Motif-3 at 50%.
Falsified if the random control is statistically indistinguishable from them on
the dev split, which would mean the profile carries no usable signal rather
than that pruning is impossible.

### Keep ratio

`HYPOTHESIS` — 50% is achievable. It is not a target handed down from anywhere;
it is the ratio that makes the checkpoint fit with room for KV cache.
`INFERENCE` — 50% of the expert bytes plus the unchanged remainder is about 95
GB, against 121 GiB of unified memory.

Treat 75%, 66% and 50% as points on a memory-versus-quality curve rather than
one goal. If 50% fails a quality gate, the response is to re-examine ratio,
context length, KV budget and quantisation together — not to conclude the
project failed.

The literature's 50% result is more specific than "no loss on code". On Qwen,
HumanEval+ held but MBPP+ lost about 4.5 percentage points. `FACT` — the pruning
paper. That is a different model family; it is a reason to measure, not a
prediction.

### Perplexity

Useful as a diagnostic and not usable as an acceptance gate. It catches
structural corruption early, helps rank candidates cheaply, and shows whether
recovery training is converging or overfitting. It does not substitute for a
coding benchmark, and a pruned model can hold perplexity while losing the
ability to finish a task.

---

## 4. Profiling

### Why the obvious approach does not work

`BLOCKED` — permanently, for the path this guide used to recommend.
`AutoModelForCausalLM.from_pretrained(..., trust_remote_code=True,
device_map="auto", offload_folder=...)` fails three separate ways:

1. The NVFP4 repository's `auto_map` names `modeling_motif.MotifForCausalLM`,
   and that file is **not in that repository**. `MEASURED` — its file listing.
   `trust_remote_code` has nothing to find.
2. Packed `modelopt_nvfp4` expert tensors are not something stock Transformers
   executes.
3. `device_map="auto"` with an offload folder stages the checkpoint rather than
   streaming it, which does not help when it is 187 GB.

### What is implemented instead

`toolkit/prune/profile_routing.py`, a layer-major streaming profiler.

The architecture is Motif's own `modeling_motif.py`, fetched from the BF16
repository. Imported rather than reimplemented: GDLA attention, the mHC residual
path and the per-expert PolyNorm are all non-standard, and a reimplementation
that is subtly wrong changes the hidden states, which changes the routing, which
makes every statistic a confident measurement of a different model.

The loop runs layer-major — hold a shard's hidden states, apply one layer to all
of them, move on — so each layer's 3.4 GB of packed weights is read once rather
than once per chunk. `test_streaming.py` builds a tiny Motif with every
architectural switch the real one sets and requires the layer-major path and
`MotifModel.forward` to agree.

`MEASURED`, 2026-08-20 on `zgx-1c3b`: 2,114 resident tensors, 11.3 GB; 22.6 GB
device allocated; model built in 93 s.

Three things had to be established rather than assumed.

**NVFP4 unpacking.** Every mistake produces output of the right shape and a
plausible magnitude. `toolkit/prune/nvfp4.py` has a pure-Python reference
checked against hand-computed values; on real checkpoint weights it agrees with
vLLM's Triton dequantiser to **zero** absolute difference for both
`gate_up_proj` and `down_proj`. `MEASURED`.

**Attention.** The model refuses to build under anything but
`flash_attention_2`, and explains why: GDLA is grouped-query with a per-layer
sliding window, eager does not repeat KV heads, and sdpa gets the window wrong.
`FACT` — the guard in `MotifModel.__init__`. There is no `flash-attn` wheel for
aarch64 with this CUDA and torch, but vLLM vendors the same compiled kernel, so
`toolkit/prune/attention.py` calls that — and is checked against a readable
naive implementation on causal, grouped-query and sliding-window attention.
`MEASURED`.

**Precision.** Statistics accumulate in float64 with int64 counts. In float32,
adding 1e-3 to a running total of 1e7 is a no-op, and the experts contributing
small amounts are exactly the ones near the cut.

### What a profile contains

```text
counts        I64 [51, 384]   routed token-expert pairs
gate_sum      F64 [51, 384]   Σ of the final applied routing weight
prob_mass     F64 [51, 384]   Σ sigmoid(router logit), all tokens, all experts
norm_sum      F64 [51, 384]   Σ ‖f_e(x)‖₂
norm_sq_sum   F64 [51, 384]   Σ ‖f_e(x)‖₂²
reap_sum      F64 [51, 384]   Σ g_e(x)·‖f_e(x)‖₂
```

Every layer's counts must sum to `tokens × top_k`. That invariant is what
catches a dropped hook or a double-counted batch before it becomes a plausible
ranking, and `stats.py` refuses a profile that violates it.

---

## 5. The corpus

Routing is measured on whatever the model is shown, so a profile is about
agentic coding only if the text is what the agent actually sends.

The earlier plan tokenised raw document text and truncated each document at
2,048 tokens. That deletes the system prompt, the tool schemas, the chat roles,
the reasoning markers, the tool-result envelope and the repair turns — every
structural token this harness emits on every request. Whatever it measured, it
was not this harness.

A corpus record is a rendered conversation carrying the SHA-256 of the chat
template and of the tool schemas it was rendered against. A mismatch is a
refusal, not a warning.

### Leakage

Profiling on the instances the model will later be graded on is circular: the
experts kept are the ones that helped on exactly those problems, and the
benchmark then reports how well that worked.

`toolkit/prune/corpus.py` audits three ways — exact instance ids, 5-gram
overlap, and word-set containment — and **fails** rather than reporting, because
a warning printed during a twelve-hour profiling run is a warning nobody reads.
Containment matters because the realistic leak is a calibration document that
*contains* a benchmark problem inside a longer conversation, which has low
Jaccard and containment near one.

This is not a proof of disjointness and does not claim to be. The corpus
manifest records which methods ran, so a later reader can tell what was not
checked.

### Size and stability

`HYPOTHESIS` — around 3.15M target-mix tokens, the scale the pruning paper used,
is a reasonable starting point. It is a starting point and not an answer: the
size is decided by stability, not by copying a number.

Pre-registered gates, written as constants in `corpus.py` so they cannot be
chosen after seeing the report:

- median per-layer keep-set Jaccard across independent shards ≥ 0.90
- 5th-percentile per-layer Jaccard ≥ 0.80
- doubling the token budget changes the final keep-set by ≤ 5%

50k tokens is a pilot for the loader and the accumulators, not a corpus.

---

## 6. Surgery

`toolkit/prune/surgery.py`. Preflight verifies everything and creates nothing;
work happens in a temporary directory on the same filesystem; the destination
appears in one atomic rename or not at all.

`MEASURED` — preflight against the real checkpoint, 2026-08-20:

```text
experts       384 -> 192  (50.0% kept)
MoE layers    51  (2..52)
indexed       510 sliced of 2440
sidecar       102 sliced
total sliced  612
shards        155
output        ~95.3 GB
```

Preflight refuses, before anything is read: an unsorted keep-list (expert order
carries the router's meaning), duplicates, out-of-range ids, any layer below
`top_k`, layers with different survivor counts, a missing or wrong-shaped
sidecar, a non-empty destination, or insufficient disk. It collects every
problem rather than stopping at the first.

`--global-alloc` is refused outright. It produces a different expert count per
layer, and `num_experts` is a single value that `config.json`, the tensor
shapes, the sidecar and the fused MoE kernels all read. Making it work is a
redesign of four things, not a flag.

### Two artifacts, kept apart

1. `pruned-sliced-scales` — the sidecar is an exact slice of the original.
   This is what masked-equivalence verification compares against.
2. `pruned-recalibrated-scales` — activation calibration re-run on the pruned
   runtime. `BLOCKED` until the runtime is up; a production candidate, and not
   a substitute for the first.

Separate paths and separate hashes, so a recalibrated artifact cannot
accidentally be the one that "passed" structural verification.

---

## 7. Verification, in layers

"`verify.py` said PASS" used to mean one prompt-level check. It is six gates.

| gate | question | needs |
|---|---|---|
| V1 | is every output byte `source[keep]`, is everything else untouched, is the sidecar sliced | files only |
| V2 | does a 384→384 keep-all surgery reproduce the source, and what is the noise floor | files, one runtime |
| V3 | does the original with dropped experts masked agree numerically with the pruned model | both models resident |
| V4 | does the production runtime load it, take the NVFP4 direct path, and read the calibrated sidecar | serving stack |
| V5 | MTP, prefix cache, graphs, chunked prefill — one at a time | serving stack |
| V6 | the context ladder and the soak | GB10 |

V2 before V3 is not optional. If keep-all does not reproduce the source, nothing
measured afterwards means anything.

### What counts as agreement

Not exact argmax equality: `num_experts` changes the shapes the fused kernels
see, so a different kernel path gives different rounding. Not a fixed tolerance
either — the old `5e-2` was a number somebody liked.

V2 measures the noise floor; V3's tolerance is a stated multiple of it. A top-1
disagreement is a **failure** only where the reference's own top two were
further apart than that floor. Elsewhere the model was undecided and rounding
picked one, and counting those makes a correct surgery look broken precisely
where nothing was at stake.

Drift is reported as p50, p99, max and relative p99, because one outlier turns
"max error" into the only number anyone reads.

---

## 8. Evaluation

### Keep the four questions apart

`FACT` — the Motif technical report gives SWE-bench Verified 76.2 and
Terminal-Bench 2.0 74.9 for the unpruned model on a pinned evaluation setup
described in its appendix (mini-SWE-agent, 16K output per step, 250 steps, 4h
timeout). Those are **not** results for this harness and have not been
reproduced here.

Four separate rows, never merged:

1. original + the official setup → reproduction of published numbers
2. pruned + the official setup → what pruning cost
3. original + motifcode → what this harness costs
4. pruned + motifcode → the integrated system

Rows 1→2 isolate pruning; 3→4 isolate it under this harness; 1→3 isolate the
harness. A difference between any other pair is not attributable to one cause.

"Same setup as official" may be claimed only when the dataset release, evaluator
commit, mini-SWE-agent version, prompt, tool interface, budgets, sampling,
seeds, checkpoint revision and sandbox provisioning are all pinned and equal.

### The acceptance rule

Not "no statistically significant loss". Failing to reject a difference proves
nothing about equivalence, and with a small sample it is the *expected* outcome
even when the loss is large — so that phrasing passes most readily exactly when
the evidence is weakest.

Instead, paired non-inferiority against a margin registered in advance:

```text
d_i = pass(candidate_i) - pass(baseline_i)   per paired instance
Δ   = mean(d_i)
pass  iff  the one-sided 95% CI lower bound on Δ  >  -δ
```

δ is an input, never a default. `packages/eval` reports the difference and its
interval and explicitly declines to say "quality retained" when no margin was
registered. Equality at the boundary is a failure.

The denominator is the manifest's planned rows — instance × seed × config —
materialised before anything runs. Missing, crashed and timed-out rows stay in
and score zero. Scoring over surviving journals instead means the configuration
that crashes on its hardest instances outscores the one that struggles through.

### The suite, and what it can and cannot say

`MEASURED` on the GB10, 2026-08-20. The Exercism polyglot exercises
([Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark)),
built into one single-commit repository each by `motif-suite build`, and
checked by `motif-suite verify` before any campaign:

| track | confirmed | reference broken | already passing |
|---|---|---|---|
| cpp | 26 | 0 | 0 |
| go | 36 | 0 | 3 |
| java | 45 | 0 | 2 |
| javascript | 48 | 0 | 1 |
| python | 34 | 0 | 0 |
| rust | 24 | 6 | 0 |
| **total** | **213** | **6** | **6** |

225 checked, none unrunnable. Toolchains installed under `$HOME` with no root:
Go 1.24, Rust 1.97, JDK 21, boost headers for the two C++ exercises that
include `boost/date_time`.

`verify` asks two questions and keeps the answers apart, because they call for
opposite responses.

*Can the tests run here?* Graded from the untouched stub, which must come back
`failed` — tests that executed and reported a failure. Nothing failed this.

*Is the exercise solvable as shipped?* The exercise's own reference solution
must pass. Six Rust exercises ship a `.meta/example.rs` importing crates their
own `Cargo.toml` does not declare — `regex`, `rand`, `itertools`,
`num_bigint`, `thiserror`, `counter`. The reference cannot build; the stub and
the tests are consistent, and a model that solves the exercise without those
crates passes. Those six are runnable instances with unconfirmed references,
which is a different thing from a broken instance, and merging the two would
have discarded them.

Six exercises pass with the stub untouched: `ledger` on three tracks,
`go/counter`, `go/markdown`, `java/tree-building`. They are refactoring
exercises — the code works and the task is to clean it up — and "do the tests
pass" cannot grade that. Left in they are a free point for every configuration
alike, which raises every absolute rate and separates nothing. They are
excluded by name.

What this suite cannot say: these are self-contained exercises with a stub and
a test file, not repository work. They exercise reading a specification,
writing code, running tests and reading the failure — not search across an
unfamiliar codebase, not a patch against code somebody else wrote. A number
here is evidence about the first thing and silent about the second.

### Candidate selection is not the final test

Comparing several criteria and ratios on the sealed set and reporting the best
is a selection effect with a headline number attached. Criteria, ratios,
recalibration and recovery are chosen on a dev split; one primary candidate goes
to the sealed set.

Random controls are reported as a distribution over at least three seeds, not as
one number. The keep-list seed and the sampling seed are separate and both
recorded.

---

## 9. GB10 bring-up

The fork is verified by its authors on 2×B200. `FACT` — the model card. GB10 is
a different architecture and a different memory model, and results there are
evidence about GB10 only.

### Getting a vLLM that knows what a Motif is

`MEASURED`, 2026-08-20. Neither of the vendor's two distribution routes runs
here: the container `ghcr.io/motiftechnologies/vllm:v0.20.2-motif3.rc3`
publishes a single `linux/amd64` manifest and this host is aarch64, and the
image tag's version is misleading — the fork's HEAD requires torch 2.11.0 and
is nine days old, not a year.

The first attempt was to register the fork's five Motif files into the
installed vLLM 0.26 from outside (`toolkit/serving/build_plugin.py`). Their
module-level imports all resolve, which is what made it look cheap. That test
was too weak: the imports that matter are inside `__init__`, and running the
model found the next drift each time — two quantization config classes upstream
does not have, then `MoERunner.local_num_experts`, and no reason to think that
was the last. Each patch risks being subtly wrong rather than loudly broken,
and a MoE that computes almost the right thing yields a plausible bad model
rather than an error. The plugin script is kept because its extraction and
import-rewriting are useful reading, but it is not the supported path.

`toolkit/serving/build_fork.sh` builds the fork itself. `MEASURED` — 28 minutes
of nvcc on 20 cores, and afterwards `MotifForCausalLM`, `MotifMTPModel` and
`modelopt_nvfp4` are all native. Four things it handles that are not obvious:

- `VLLM_USE_PRECOMPILED=1` fetches an x86_64 wheel, so only the
  architecture-neutral `cumem_allocator` lands and `vllm._C` is absent. The
  installed vLLM 0.26's `_C_stable_libtorch` is a different extension under a
  different name and is not a substitute.
- `pip install -e .` returns in four seconds once the editable install exists,
  having compiled nothing.
- CMake's FindPython needs development headers this host cannot install, and
  does not read `CPATH`; the extracted `.deb` under `~/local/pydev` has to be
  passed as CMake arguments.
- pip resolves transformers 4.57 on its own. The checkpoint's tokenizer is
  `TokenizersBackend`, which is transformers 5.x, and the fork's own
  constraint allows 5.6+.

### The deep_gemm shim, and what it does not prove

`MEASURED` — the fork's mHC path calls `tf32_hc_prenorm_gemm` with no fallback,
so DeepGEMM is required whatever the quantization. The fork vendors a prebuilt
`deep_gemm/_C...so` and no source for it; the kernel headers ship alongside,
including an `sm120` variant, because DeepGEMM compiles kernels at runtime.

That binary was built against an older torch than the fork's own requirements
demand. Of the 428 symbols it imports, **427 resolve against torch 2.11.0**.
The one that does not is
`c10::ValueError::ValueError(SourceLocation, std::string)` — and
`c10::Error::Error(SourceLocation, std::string)`, its base, is exported. The
subclass gained `using Error::Error`, which makes the inherited constructor
implicit and inline, so nothing is emitted. That is a source change, not an ABI
break.

`toolkit/serving/c10_valueerror_shim.cpp` emits that one symbol.
`LD_PRELOAD`ed, deep_gemm imports and its hyperconnection kernel resolves.

The shim asserts that the only difference between the two torches, as far as
this binary is concerned, is where that constructor lives. 427 of 428 resolving
is evidence for that and not proof: a struct whose layout changed silently
would corrupt rather than fail. **Nothing computed through this path is
believable until V3 has compared it against the reference implementation**, and
that gate is not optional here in the way it might be elsewhere.

`BLOCKED` — the tiny synthetic checkpoint now reaches the DeepGEMM kernel and
fails an internal `dim == 2 or dim == 3` assertion. The tiny model has already
produced two false alarms of this kind — MLA head dimensions no kernel
implements, and a bf16 path the real checkpoint never takes — so this is
recorded rather than chased. The decisive test is the pruned checkpoint, which
is the real shape and the real quantization.

### Host guardrails come first### Host guardrails come first

Before any large allocation: a cgroup memory cap, a watchdog that can kill the
server on `MemAvailable` crossing a pre-registered reserve, and health logging.
Unified memory means the model weights, CUDA workspaces, KV cache, the engine's
own RSS, page cache and every other process share one pool —
`gpu_memory_utilization` is not a host-wide hard cap, and treating it as one is
how a machine becomes unreachable.

`vllm serve` may support `--kv-cache-memory-bytes` for an explicit KV budget.
`FACT` for [upstream](https://docs.vllm.ai/en/latest/cli/serve/); parity in the
Motif fork is unverified and must be checked at startup rather than assumed.

### The ladder

One variable at a time. Each step has to pass before the next begins.

| step | configuration | acceptance |
|---|---|---|
| 1 | host guardrails only | watchdog kills a synthetic hog; host stays reachable |
| 2 | tiny dense model | base vLLM works on ARM64 |
| 3 | tiny synthetic Motif, BF16 | architecture, attention, router, PolyNorm |
| 4 | tiny synthetic Motif, NVFP4 + sidecar | custom loader, calibrated scales, a known numeric fixture |
| 5 | real pruned model, 4K, eager, `--max-num-seqs 1`, MTP off, prefix cache off, no graph capture | near-full prefill, fixed output tokens, correctness smoke, memory recorded |
| 6 | 32K → 64K → 128K → 256K | each: near-full prefill, fixed output, correctness, memory, zero engine errors |
| 7 | prefix cache, then MTP, then graphs, then chunked prefill | one at a time, each against step 6's baseline |
| 8 | 1h smoke, then a pre-registered long soak | request success, latency and memory drift recorded, not just crash-free time |

A server that starts is not a passed step. "256K works" requires a near-full
prefill and a fixed number of output tokens actually generated at that length.

### The backend gate

Confirm from the startup and request logs that the Motif NVFP4 direct-load path
is in use and that the sidecar was read. An unintended Marlin fallback is a
different model with different numerics, and a memory or latency figure measured
there says nothing about the intended configuration.

### Known upstream issues

To be re-checked immediately before the campaign; a closed issue is not
necessarily a fixed one.

| issue | symptom | why it matters here |
|---|---|---|
| [vLLM #50925](https://github.com/vllm-project/vllm/issues/50925) | GB10 NVFP4 MoE: published build falls back to Marlin | the backend gate above |
| [vLLM #46307](https://github.com/vllm-project/vllm/issues/46307) | UMA startup peak; `gpu_memory_utilization` is not a host cap | the watchdog |
| [vLLM #50011](https://github.com/vllm-project/vllm/issues/50011) | sleep/wake EngineCore failures | keep sleep mode off |
| [vLLM #49926](https://github.com/vllm-project/vllm/issues/49926) | GB10 NVFP4/Marlin long-run instability | the soak step |
| [vLLM #50067](https://github.com/vllm-project/vllm/issues/50067) | related EngineCore path | record the disposition; closed ≠ fixed |

These are upstream vLLM issues. None is evidence about Motif's fork, whose
custom PolyNorm and NVFP4 paths differ; each needs a local reproducer and a
backend log.

### Performance

`HYPOTHESIS` and nothing more: the "13 → 21 tok/s from dense FP8" figure in
earlier drafts had no measurement behind it and has been removed. The fork's own
source keeps dense FP8 off by default and notes roughly +2% observed throughput.

Report TTFT, prefill tok/s, decode tok/s, inter-token latency, p50 and p95, and
raw samples. `completion_tokens / request wall time` is request-effective
throughput and must be labelled as such — it includes prefill and queueing,
which on a long context is most of it.

---

## 10. Stages

`status` is one of `not_started`, `blocked`, `in_progress`, `passed`, `failed`.

| id | stage | status | prerequisite | tool | artifact | acceptance |
|---|---|---|---|---|---|---|
| S0 | environment and schema preflight | passed | — | `surgery.py` preflight | plan hash | 612 slice targets, hashes match §2 |
| S1 | harness evidence path | passed | S0 | `motif distil` | graded trajectories | round-trips into the profiler |
| S2 | corpus and leakage audit | not_started | S1 | `corpus.py` | corpus manifest | audit clean, splits disjoint |
| S3 | profiler feasibility | passed | S0 | `profile_routing.py` | 50k pilot profile | invariants hold, memory recorded |
| S4 | full profile and stability | not_started | S2, S3 | `profile_routing.py` | profile + manifest | stability gates in §5 |
| S5 | criterion and ratio selection | not_started | S4 | `select_experts.py` | keep-lists | dev comparison, controls included |
| S6 | surgery | not_started | S5 | `surgery.py --apply` | pruned checkpoint | 612 sliced, manifest hashes |
| S7 | structural verification | not_started | S6 | `verify.py` | V1 report | V1 and V2 pass |
| S8 | runtime bring-up | blocked | S6 | Motif vLLM | serving logs | §9 ladder |
| S9 | dev evaluation | blocked | S7, S8 | `packages/eval` | dev results | candidate chosen |
| S10 | sealed evaluation | blocked | S9 | `packages/eval` | paired stats | non-inferiority in §8 |
| S11 | recovery tuning | blocked | S10 | — | — | see below |
| S12 | mixed dense FP8 | blocked | S10 | — | — | see below |

S8's blocker is that the Motif vLLM fork has not been built here. S11 and S12
are blocked on S10 deliberately: both are ways to make a pruned model better,
and running either before the unhealed baseline is measured makes it impossible
to say what the pruning itself cost.

### S11: recovery, when it is unblocked

Two priors conflict and neither is settled for post-pruning healing. Motif's own
teacher recipe freezes the router and the selection bias (`FACT` — technical
report §5.2.3); the nearest pruning work trains the router (`FACT` — pruning
paper §5.7). Those are different problems, and the answer has to be measured:

- Arm A: router and selection bias frozen, LoRA on attention/shared/dense paths
- Arm B: router trained, selection-bias policy stated, same dense LoRA

with routed expert weights frozen in both, identical teacher outputs, optimizer,
steps, seed and data, and a held-out recovery validation set disjoint from the
sealed test. Routed expert tensors must be bit-identical afterwards, and the
unhealed candidate is the paired comparison.

Feasibility first: NVFP4 direct-load kernels are not an autograd training
backend, and the official training example is a B200 multi-GPU path. Either a
BF16/MXFP8 training checkpoint or a training runtime that passes gradients
through frozen quantised experts has to exist before this is a step rather than
an intention.

### S12: mixed dense FP8, when it is unblocked

`--quantization modelopt_blockfp8` is not "keep NVFP4 experts, make dense FP8".
It is a *different* quantisation config that changes the MoE method itself:
`modelopt_blockfp8` converts a BF16 checkpoint at load time, while this
checkpoint's `modelopt_nvfp4` direct-loads packed expert tensors. `FACT` — the
two configs in the fork's
[modelopt.py](https://github.com/MotifTechnologies/vllm/blob/4cd9eb4129883565e69d508038d783d59ee01867/vllm/model_executor/layers/quantization/modelopt.py).

What is actually wanted is a mixed loader: experts stay NVFP4 direct-load, dense
`LinearBase` modules go block-FP8, the router stays FP32, shared experts stay
BF16 to begin with. That does not exist yet. Until it does, and until a backend
log confirms the experts are still on the NVFP4 path, this is not a flag anyone
can pass.

---

## 11. Licence and release

`FACT` — Motif-3 and Motif-3-NVFP4 are MIT-licensed on the Hub. That permits a
derivative, and permission is not the whole checklist.

Before publishing anything:

- [ ] record the source `LICENSE` text and its hash in the artifact manifest
- [ ] read the model card for usage restrictions beyond the licence
- [ ] check the tokenizer and any runtime code for separate terms
- [ ] carry the licence and attribution into the derivative's own files
- [ ] confirm the derivative's name does not imply endorsement
- [ ] review the keep-list, profile and benchmark artifacts separately — the
      corpus may carry terms the checkpoint does not
- [ ] state the corpus's provenance and licence in the model card

Telling the upstream authors is good practice and is not a substitute for any of
the above.

The model card must record: source revision and attribution; pruning criterion,
ratio and sidecar handling; runtime requirements; the benchmark manifests behind
every number; off-domain regressions; the GB10 limits actually verified; and
known failure modes. Every score carries its manifest id and config id, and raw
per-instance outcomes are published alongside aggregates.

---

## 12. Sources

| source | revision or date | what it supports | verified |
|---|---|---|---|
| [Motif-3-NVFP4](https://huggingface.co/Motif-Technologies/Motif-3-NVFP4/tree/3a4416f7b555720d36e41f93207b826003ffe327) | `3a4416f7` | every number in §2 | 2026-08-20, by reading headers |
| [Motif-3](https://huggingface.co/Motif-Technologies/Motif-3) | `883d5c44` | `modeling_motif.py`, routing semantics | 2026-08-20 |
| [Motif vLLM fork](https://github.com/MotifTechnologies/vllm/tree/4cd9eb4129883565e69d508038d783d59ee01867) | `4cd9eb41` | sidecar loader, quantisation configs | 2026-08-20, source read |
| [Motif-3 technical report](https://arxiv.org/html/2608.09119v1) | v1 | 76.2 / 74.9 and their setup; teacher recipe §5.2.3 | 2026-08-20 |
| [Half the Experts, All the Code](https://arxiv.org/html/2607.16721v1) | v1 | contrast collapse, REAP, MBPP+ −4.5pp, §5.7 | 2026-08-20 |
| [DGX Spark hardware](https://docs.nvidia.com/dgx/dgx-spark/hardware.html) | — | 128 GB, 273 GB/s | 2026-08-20 |
| [DGX Spark release notes](https://docs.nvidia.com/dgx/dgx-spark/release-notes.html) | — | UMA OOM handling | 2026-08-20 |
| [vLLM serve CLI](https://docs.vllm.ai/en/latest/cli/serve/) | — | `--kv-cache-memory-bytes` upstream | 2026-08-20 |
| `toolkit/prune/` | this repository | everything labelled `MEASURED` | continuously, by CI |

Commit permalinks rather than branch names throughout: a mutable reference
turns a reproducible claim into a claim about whatever is there today. Where a
source does not directly support a statement, the statement is `INFERENCE` and
says so.
