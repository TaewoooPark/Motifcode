#!/usr/bin/env python3
"""Compile Motif's fused PolyNorm+NVFP4 quant kernel on SM12x as well as SM100.

MEASURED 2026-08-20 on zgx-1c3b. With the NVFP4 kernels built for `12.0f`, the
CUTLASS MoE gate opens and startup gets one step further before

    AttributeError: '_OpNamespace' '_C' object has no attribute
                    'grouped_poly_norm_nvfp4_quant'

`grouped_poly_norm_nvfp4_quant` is not an upstream vLLM kernel. It is Motif's
own fused per-expert PolyNorm + NVFP4 quantisation, declared in csrc/ops.h,
bound in csrc/torch_bindings.cpp, and implemented in
csrc/grouped_poly_norm_nvfp4_quant_kernel.cu. CMakeLists.txt has two NVFP4
blocks — one for SM100, one for SM12x — and adds that source to `_C` in the
SM100 block only. On any SM12x device the binding exists and the implementation
does not, so it resolves at import and fails at the first call.

The kernel itself is ordinary CUDA: a hand-written `__global__` with no arch
guards, no CUTLASS dependency, and no `__CUDA_ARCH__` branches. Its one comment
about sm_100 concerns portable PTX for E2M1 conversion, not a hardware
requirement. So this adds the source to the SM12x block, compiled against the
same FP4_ARCHS the neighbouring NVFP4 sources already use.

This is the vendor building for the hardware they ship on. It is not a claim
that the kernel is correct here — that is gate V3's job.

Idempotent; `--revert` restores the file. A rebuild is required afterwards:
toolkit/serving/rebuild_kernels.sh (incremental is enough — NO_CLEAN=1).
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

# Unique to the SM12x block: the SM100 block defines ENABLE_NVFP4_SM100.
ANCHOR = "    target_compile_definitions(_C PRIVATE ENABLE_NVFP4_SM120=1)"

MARKER = "# motifcode: PolyNorm+NVFP4 on SM12x"

INSERT = f"""    {MARKER}
    # Motif's own fused PolyNorm+NVFP4 quant kernel. Upstream adds this to
    # `_C` in the SM100 block only, so on SM12x the torch binding exists with
    # no implementation behind it. Plain CUDA, no arch guards.
    set(GROUPED_POLY_NORM_NVFP4_SRC
      "csrc/grouped_poly_norm_nvfp4_quant_kernel.cu")
    set_gencode_flags_for_srcs(
      SRCS "${{GROUPED_POLY_NORM_NVFP4_SRC}}"
      CUDA_ARCHS "${{FP4_ARCHS}}")
    target_sources(_C PRIVATE ${{GROUPED_POLY_NORM_NVFP4_SRC}})
    {MARKER}
"""


# Compiling the kernel is only half of it: the torch binding that exposes it is
# itself guarded on ENABLE_NVFP4_SM100, so on SM12x the op is never registered
# and the failure is identical whether or not the source was built.
#
# Widening that guard is what the fork already does for the same macro pair in
# csrc/cache_kernels.cu:739 — `#if defined(ENABLE_NVFP4_SM100) ||
# defined(ENABLE_NVFP4_SM120)`. Defining ENABLE_NVFP4_SM100=1 on SM12x instead
# would be wrong: it also gates genuinely SM100-only CUTLASS entry points in
# csrc/libtorch_stable/quantization/fp4/, which have no kernels here.
BIND_ANCHOR = "#if defined(ENABLE_NVFP4_SM100) && ENABLE_NVFP4_SM100"
BIND_PATCHED = (
    "#if (defined(ENABLE_NVFP4_SM100) && ENABLE_NVFP4_SM100) || \\\n"
    "    (defined(ENABLE_NVFP4_SM120) && ENABLE_NVFP4_SM120)  "
    "// motifcode: SM12x too"
)
BIND_MARKER = "// motifcode: SM12x too"


def _patch_file(path: Path, marker: str, transform, backup_suffix: str) -> None:
    src = path.read_text()
    if marker in src:
        print(f"already patched: {path}")
        return
    backup = path.with_suffix(backup_suffix)
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(transform(src))
    print(f"patched {path}\n  backup {backup}")


def apply(root: Path) -> None:
    cmake = root / "CMakeLists.txt"
    bindings = root / "csrc" / "torch_bindings.cpp"
    for p in (cmake, bindings):
        if not p.is_file():
            sys.exit(f"not a vLLM checkout: {p} is missing")

    def cmake_tf(src: str) -> str:
        if src.count(ANCHOR) != 1:
            sys.exit(
                f"expected exactly one {ANCHOR!r} in {cmake}, found "
                f"{src.count(ANCHOR)} — the fork moved; re-read the NVFP4 blocks"
            )
        return src.replace(ANCHOR, INSERT + ANCHOR)

    def bind_tf(src: str) -> str:
        n = src.count(BIND_ANCHOR)
        if n != 1:
            sys.exit(
                f"expected exactly one {BIND_ANCHOR!r} in {bindings}, found {n}"
            )
        return src.replace(BIND_ANCHOR, BIND_PATCHED)

    _patch_file(cmake, MARKER, cmake_tf, ".txt.motifcode-orig")
    _patch_file(bindings, BIND_MARKER, bind_tf, ".cpp.motifcode-orig")


def revert(root: Path) -> None:
    for path, suffix in (
        (root / "CMakeLists.txt", ".txt.motifcode-orig"),
        (root / "csrc" / "torch_bindings.cpp", ".cpp.motifcode-orig"),
    ):
        backup = path.with_suffix(suffix)
        if backup.exists():
            shutil.copy2(backup, path)
            print(f"reverted {path}")
        else:
            print(f"no backup for {path}, left alone")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root", help="path to the vLLM fork checkout")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).expanduser()
    revert(root) if args.revert else apply(root)


if __name__ == "__main__":
    main()
