#!/bin/bash
# Rebuild the fork's CUDA extensions for an explicitly chosen architecture.
#
# Why this exists separately from build_fork.sh: that script starts with
# `git checkout FETCH_HEAD`, which discards any patch applied to the working
# tree — including toolkit/serving/patch_single_gpu_moe.py. This rebuilds the
# extensions only.
#
# MEASURED 2026-08-20 on zgx-1c3b. The first build let CMake auto-detect the
# architecture. GB10 reports SM 12.1, and the fork's NVFP4 gate reads
#
#   if(CUDA_COMPILER_VERSION >= 13.0)
#     cuda_archs_loose_intersection(FP4_ARCHS "12.0f" "${CUDA_ARCHS}")
#
# This host has CUDA 13.0, so the intersection is taken against the single
# family target "12.0f". Auto-detected "12.1" does not intersect it, FP4_ARCHS
# comes out empty, and CMake takes the `else` branch — "Not building NVFP4 as
# no compatible archs were found". Nothing warns at run time, because the
# capability test in scaled_mm_entry.cu is compile-time only: `version_num` is
# used in the error message and nowhere else. The failure surfaces much later
# as
#
#   NotImplementedError: No compiled
#   get_cutlass_moe_mm_problem_sizes_and_nvfp4_offsets: no CUTLASS MoE kernel
#   for CUDA device capability: 121. Required capability: 90, 100, or 120
#
# — which reads like the hardware is unsupported, when what happened is that
# the kernels were never compiled. Asking for "12.0f" outright is the fix: the
# `f` suffix is CUDA 13's family target, which is what makes one cubin valid
# across the 12.x family, GB10's 12.1 included.
#
# This is a build-configuration change. It makes the intended NVFP4 kernels
# exist; it does not establish that they compute the right thing on this
# device. Gate V3 — masked equivalence against the reference implementation —
# is what would.
set -eu

SRC=${SRC:-$HOME/motif-prune/vllm-fork}
VENV=${VENV:-$HOME/motif-prune/.venv-fork}
PYDEV=${PYDEV:-$HOME/local/pydev/usr}
ARCH=${TORCH_CUDA_ARCH_LIST:-12.0f}

cd "$SRC"

export TORCH_CUDA_ARCH_LIST="$ARCH"
export CMAKE_ARGS="-DPython_EXECUTABLE=$VENV/bin/python \
 -DPython_INCLUDE_DIR=$PYDEV/include/python3.12 \
 -DPython_LIBRARY=$PYDEV/lib/aarch64-linux-gnu/libpython3.12.so"
export CPATH="$PYDEV/include/python3.12:$PYDEV/include${CPATH:+:$CPATH}"
export LIBRARY_PATH="$PYDEV/lib/aarch64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
# Well under nproc: nvcc holds a lot per translation unit, this box shares one
# memory pool between GPU and host, and a compile-shaped OOM has taken the
# desktop down here before.
export MAX_JOBS=${MAX_JOBS:-8}
export NVCC_THREADS=${NVCC_THREADS:-2}
export CMAKE_BUILD_PARALLEL_LEVEL=${CMAKE_BUILD_PARALLEL_LEVEL:-8}

echo "arch : $TORCH_CUDA_ARCH_LIST"
echo "src  : $SRC"
echo

# A CMake-only change (adding a source, changing an arch) does not need the
# 35 minutes a clean build costs — ninja recompiles the new translation units
# and relinks. Set NO_CLEAN=1 for that. Clean by default, because a changed
# gencode flag on an unchanged source will not invalidate its object file.
if [ "${NO_CLEAN:-0}" = "1" ]; then
  echo "incremental (NO_CLEAN=1)"
else
  rm -rf build
fi
"$VENV/bin/python" setup.py build_ext --inplace

echo
echo "=== built $(date -Is) ==="
"$VENV/bin/python" - <<'PY'
import vllm
print("vllm", vllm.__version__)
PY
