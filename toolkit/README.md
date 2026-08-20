# toolkit

Profiling, selection, surgery and verification for pruning Motif-3's routed
expert bank.

Python, and deliberately apart from the TypeScript harness: it runs where the
weights are, which is not where the agent runs.

## The reference architecture

`profile_routing.py` needs Motif's own `modeling_motif.py`, and it is not in
this repository. Two reasons: it is somebody else's code, and a copy would drift
from upstream the moment it was made. Fetch it, pinned:

```bash
hf download Motif-Technologies/Motif-3 modeling_motif.py configuration_motif.py \
  --revision 883d5c441fe3bb994c7b57e60f49e26147f85512 \
  --local-dir toolkit/ref
```

It lives in the **BF16** repository rather than the NVFP4 one. That is a trap
for anyone reading `config.json`: the quantised repository's `auto_map` names
`modeling_motif.MotifForCausalLM`, and the file it names is not there, so
`trust_remote_code=True` cannot help.

Importing it rather than reimplementing it is deliberate. GDLA attention, the
mHC residual path and the per-expert PolyNorm are all non-standard, and a
reimplementation that is subtly wrong changes the hidden states, which changes
the routing, which makes every statistic a confident measurement of a different
model.

## Running the tests

```bash
pip install -r toolkit/requirements-dev.txt
cd toolkit/prune
MOTIF_REQUIRE_TORCH=1 MOTIF_REQUIRE_REFERENCE=1 python -m unittest discover -p 'test_*.py' -v
```

Those two variables turn skips into failures. Without them a machine missing
torch or the reference architecture reports `OK (skipped=20)` — and the tests
that skip are precisely the ones deciding whether the NVFP4 unpacking, the
forward pass and the tensor slicing are correct.

`test_attention.py`'s flash comparisons need a GPU and skip elsewhere; the
readable reference they are compared against runs anywhere.

## What each module decides

| module | what it decides |
|---|---|
| `nvfp4.py` | unpacking 4-bit expert weights; checked against a hand-computed reference and against vLLM's kernel |
| `attention.py` | GDLA's attention, and a naive implementation to check it against |
| `streaming.py` | how 187 GB of checkpoint fits in 121 GB of memory |
| `profile_routing.py` | the layer-major forward pass and the six routing statistics |
| `stats.py` | what a profile must contain to be usable at all |
| `select_experts.py` | which experts to keep — and why that is not one question |
| `corpus.py` | what the model is shown, and proving it is not what it will be graded on |
| `surgery.py` | cutting the checkpoint |
| `verify.py` | proving the cut model is still the model |

`profile_routing` and `select_experts` are named the long way round because
Python ships a stdlib `profile` and a stdlib `select`, and this directory goes
on `sys.path`. Shadowing the first breaks `cProfile`, which `torch._dynamo`
imports; shadowing the second breaks `subprocess` and `asyncio`.

## Why the profiler is shaped the way it is

The checkpoint is 187 GB packed and the target machine has 121 GB of unified
memory, so nothing can hold it. But 173 GB of that is routed experts and the
remaining 14 GB — attention, mHC, norms, router gates, shared experts — is
plain BF16. So the small part stays resident and the large part streams, one
layer at a time, dequantised per expert as the tokens that routed to it arrive.

The loop runs layer-major rather than chunk-major: hold the hidden states for a
whole shard, apply one layer to all of them, move on. Chunk-major would re-read
all 173 GB for every chunk. That reordering means reimplementing the body of
`MotifModel.forward`, which is why `test_streaming.py` builds a tiny Motif and
requires both paths to produce the same output.

## Serving

`serving/build_plugin.py` makes an unforked vLLM able to load Motif-3. The
vendor ships a fork and an amd64-only container; on aarch64 neither is usable,
and the fork's Motif support turns out to be five Python files that import
nothing the installed vLLM lacks. See `docs/model_guide.md` §9.

```bash
python toolkit/serving/build_plugin.py --out ~/motif-prune/vllm_motif
PYTHONPATH=~/motif-prune/vllm_motif vllm serve <checkpoint>
```

The copied files are the vendor's, under their repository's licence; the script
records the fork revision it took them from in `motif_vllm/SOURCE`.

## Benchmark toolchains

`motif-suite` builds instances from a checkout of
[Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark).
All six tracks run without root; the toolchains install under `$HOME`.

```bash
# Go
curl -sSL https://go.dev/dl/go1.24.0.linux-arm64.tar.gz | tar xz -C ~/toolchains
# Rust
curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
# JDK, for the Gradle wrapper the Java exercises ship
curl -sSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/aarch64/jdk/hotspot/normal/eclipse" \
  | tar xz -C ~/toolchains
# Boost headers, for the two C++ exercises that include boost/date_time
curl -sSL https://archives.boost.io/release/1.86.0/source/boost_1_86_0.tar.gz \
  | tar xz -C ~/toolchains boost_1_86_0/boost
# jest, shared by every JavaScript exercise
mkdir -p ~/js-deps && cp <any javascript exercise>/package.json ~/js-deps/ \
  && (cd ~/js-deps && npm install)
```

```bash
export PATH=$HOME/toolchains/go/bin:$HOME/.cargo/bin:$HOME/toolchains/jdk-21*/bin:$PATH
export JAVA_HOME=$HOME/toolchains/jdk-21.0.12+8
export CXX_EXTRA_INCLUDE=$HOME/toolchains/boost_1_86_0

motif-suite verify --benchmark <checkout> --out <dir> \
  --languages python,javascript,go,rust,cpp,java \
  --node-path ~/js-deps/node_modules
```

Run `verify` before any campaign. It separates "the tests cannot run here"
from "the exercise's own reference does not build", which need opposite
responses — see `docs/model_guide.md` §8.
