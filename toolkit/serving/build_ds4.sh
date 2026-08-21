#!/usr/bin/env bash
# Build the ds4-dfm runtime for GB10.
#
# Motif-3 is not a Llama-family graph. A runtime has to implement the 384-expert
# sigmoid router with route normalisation, the shared expert, Expert-Specific
# PolyNorm, modified mHC, GDLA with differential heads and the output gate,
# interleaved 128-token SWA against full attention every fourth layer, YaRN, and
# latent-KV semantics. Parsing the GGUF container is not the same as executing
# the architecture, and a runtime that does the first will produce plausible
# output while computing something else.
#
# ds4-dfm is the runtime the mixed-quant artifact was measured on. `v0.6.0-dfm`
# (2026-08-17) is the release base and already contains the Spark long-context
# commit 593d251 (2026-08-14).
#
# `make cuda-spark` targets sm_121 directly — the same architecture that took a
# separate patch to reach in the vLLM fork.
set -euo pipefail

SRC=${SRC:-$HOME/motif-serve/ds4}
REF=${REF:-v0.6.0-dfm}
REPO=${REPO:-https://github.com/Baekpica/ds4.git}
TARGET=${TARGET:-cuda-spark}

if [ ! -d "$SRC/.git" ]; then
  git clone -q "$REPO" "$SRC"
fi
cd "$SRC"
git fetch -q --tags origin
git checkout -q "$REF"
echo "ds4 @ $(git rev-parse --short HEAD)  ($REF)"
echo "target: $TARGET"
echo

command -v nvcc >/dev/null || { echo "nvcc not on PATH" >&2; exit 1; }
nvcc --version | tail -2

# Well under nproc: this box shares one memory pool between GPU and host, and a
# compile-shaped OOM has taken the desktop down here before.
JOBS=${JOBS:-8}

echo
make "$TARGET" -j"$JOBS"

echo
echo "=== built $(date -Is) ==="
ls -la ds4 ds4-server ds4-bench ds4-eval ds4_weight_server 2>/dev/null || true
