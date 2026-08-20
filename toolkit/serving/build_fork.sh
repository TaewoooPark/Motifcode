#!/bin/bash
# Build the vendor's vLLM fork for this GPU.
#
# `build_plugin.py` — registering the fork's Motif files into an unforked vLLM
# — got as far as the quantization registry and then kept finding the next
# drift. Each fix risked being subtly wrong rather than loudly broken, and a
# MoE that computes almost the right thing produces a plausible bad model
# rather than an error. The fork is a self-consistent vLLM that has all of it.
#
# Three things this handles that are not obvious:
#
#   * `VLLM_USE_PRECOMPILED=1` fetches an x86_64 wheel. Only the
#     architecture-neutral `cumem_allocator` lands and `vllm._C` is absent.
#     The installed vLLM 0.26's `_C_stable_libtorch` is a different extension
#     under a different name, so its objects are not a substitute.
#
#   * `pip install -e .` returns in four seconds once the editable install
#     exists, having compiled nothing. The extension build has to be asked for.
#
#   * CMake's FindPython needs development headers, and this host has no
#     `python3.12-dev` and no way to install one. The `.deb` extracted under
#     ~/local/pydev serves, but CMake does not read CPATH — the paths have to
#     be passed outright.
set -eu

REV=${REV:-4cd9eb4129883565e69d508038d783d59ee01867}
SRC=${SRC:-$HOME/motif-prune/vllm-fork}
VENV=${VENV:-$HOME/motif-prune/.venv-fork}
PYDEV=${PYDEV:-$HOME/local/pydev/usr}

git clone -q --depth 1 https://github.com/MotifTechnologies/vllm.git "$SRC" 2>/dev/null || true
cd "$SRC"
git fetch -q --depth 1 origin "$REV"
git checkout -q FETCH_HEAD

python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip setuptools setuptools_scm wheel ninja cmake packaging numpy
"$VENV/bin/pip" install -q torch==2.11.0 --index-url https://download.pytorch.org/whl/cu130
"$VENV/bin/python" use_existing_torch.py || true

# The checkpoint's tokenizer is transformers 5.x (`TokenizersBackend`); pip
# resolves 4.57 on its own, which the fork allows but the checkpoint does not.
"$VENV/bin/pip" install -q --no-deps "transformers==5.14.1"
VLLM_USE_PRECOMPILED=1 "$VENV/bin/pip" install -e . --no-build-isolation

export CMAKE_ARGS="-DPython_EXECUTABLE=$VENV/bin/python \
 -DPython_INCLUDE_DIR=$PYDEV/include/python3.12 \
 -DPython_LIBRARY=$PYDEV/lib/aarch64-linux-gnu/libpython3.12.so"
export CPATH="$PYDEV/include/python3.12:$PYDEV/include${CPATH:+:$CPATH}"
export LIBRARY_PATH="$PYDEV/lib/aarch64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
# Well under nproc: nvcc holds a lot per translation unit, this box shares one
# pool between GPU and host, and a compile-shaped OOM has taken the desktop
# down here before.
export MAX_JOBS=8 NVCC_THREADS=2 CMAKE_BUILD_PARALLEL_LEVEL=8
rm -rf build
"$VENV/bin/python" setup.py build_ext --inplace

# The one symbol the fork's prebuilt deep_gemm needs and torch 2.11 stopped
# exporting. See the shim's own header for what it does and does not prove.
TORCH="$VENV/lib/python3.12/site-packages/torch"
g++ -shared -fPIC -std=c++17 -O2 -o "$SRC/libc10shim.so" \
  "$(dirname "$0")/c10_valueerror_shim.cpp" \
  -I"$TORCH/include" -I"$TORCH/include/torch/csrc/api/include" \
  -L"$TORCH/lib" -ltorch_cpu -lc10

cat <<NOTE

Built. Every invocation needs both, because the shim has to be resolved before
the prebuilt deep_gemm binds:

  export LD_LIBRARY_PATH=$TORCH/lib
  export LD_PRELOAD=$SRC/libc10shim.so
  $VENV/bin/python -m vllm.entrypoints.openai.api_server --model <checkpoint>
NOTE
