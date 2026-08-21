#!/usr/bin/env bash
# Serve a pruned Motif-3 checkpoint on GB10 — bring-up ladder step 5.
#
# Step 5 is the first configuration that touches the real checkpoint, so every
# performance feature is off: eager, one sequence, no prefix cache, no chunked
# prefill, no graph capture. Anything measured here is a correctness signal, not
# a throughput one, and turning a feature on before this passes makes it
# impossible to say which change caused what.
#
# Two things are not optional on this box:
#
#   LD_PRELOAD  the vendored deep_gemm is built against an older torch and is
#               missing c10::ValueError's complete-object constructor. Without
#               the shim the import fails with `undefined symbol`; with it, the
#               mHC path's tf32_hc_prenorm_gemm resolves. See the shim source
#               for what that does and does not prove.
#
#   MemoryMax   GPU memory is host memory here. gpu-memory-utilization is a vLLM
#               accounting target, not a host-wide cap, so the cgroup is what
#               actually stands between a bad flag and a dead desktop session.
#
set -euo pipefail

ROOT="${MOTIF_ROOT:-$HOME/motif-prune}"
VENV="$ROOT/.venv-fork"
TORCH="$VENV/lib/python3.12/site-packages/torch"
MODEL="${1:-$ROOT/pruned-guard96}"
PORT="${PORT:-8080}"
RESERVE_GIB="${RESERVE_GIB:-12}"

[ -x "$VENV/bin/python" ] || { echo "no fork venv at $VENV" >&2; exit 1; }
[ -d "$MODEL" ]           || { echo "no checkpoint at $MODEL" >&2; exit 1; }
[ -f "$ROOT/vllm-fork/libc10shim.so" ] || {
  echo "libc10shim.so is missing — build it with toolkit/serving/build_fork.sh" >&2
  exit 1
}

# Triton compiles a launcher per kernel and needs Python.h, which this host
# cannot install system-wide; the headers come from the extracted .deb.
export CPATH="$HOME/local/pydev/usr/include/python3.12:$HOME/local/pydev/usr/include${CPATH:+:$CPATH}"
export LIBRARY_PATH="$HOME/local/pydev/usr/lib/aarch64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"

export LD_LIBRARY_PATH="$TORCH/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_PRELOAD="$ROOT/vllm-fork/libc10shim.so"
export VLLM_LOGGING_LEVEL="${VLLM_LOGGING_LEVEL:-INFO}"

# MEASURED 2026-08-20, this host: the DeepGEMM mHC path fails on the real pruned
# checkpoint with
#
#   RuntimeError: Assertion error (…/utils/layout.hpp:15): dim == 2 or dim == 3
#
# in tf32_hc_prenorm_gemm, during the KV-cache profiling forward pass — after
# all 155 shards load. The same assertion had already fired on the tiny
# synthetic checkpoint, where it was recorded as possibly-spurious because that
# model had produced two false alarms before. It is not spurious: the real shape
# and the real quantisation reproduce it exactly.
#
# The fork ships an opt-out to the Triton mHC path, which is what this uses by
# default. That is a different kernel path and therefore different numerics, so
# it does not make the DeepGEMM path verified — it routes around it. Set
# MOTIF_MHC_TILELANG=1 to go back and re-test the DeepGEMM path.
export MOTIF_MHC_TILELANG="${MOTIF_MHC_TILELANG:-0}"

TOTAL_GIB=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
CAP_GIB=$(( TOTAL_GIB - RESERVE_GIB ))

echo "checkpoint : $MODEL"
echo "cgroup cap : ${CAP_GIB}G of ${TOTAL_GIB} GiB (reserving ${RESERVE_GIB} GiB for the desktop)"
echo "shim       : $LD_PRELOAD"
echo

exec systemd-run --user --scope --quiet \
  -p MemoryMax=${CAP_GIB}G -p MemorySwapMax=0 \
  -- choom -n 800 -- \
  "$VENV/bin/python" -m vllm.entrypoints.openai.api_server \
    --model "$MODEL" \
    --served-model-name motif-3-pruned \
    --port "$PORT" \
    --trust-remote-code \
    --max-model-len 4096 \
    --max-num-seqs 1 \
    --gpu-memory-utilization 0.82 \
    --enforce-eager \
    --no-enable-prefix-caching \
    --no-enable-chunked-prefill
