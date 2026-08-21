#!/usr/bin/env python3
"""Build the Motif MoE modular kernel when there is only one GPU.

MEASURED 2026-08-20 on zgx-1c3b. Serving the pruned checkpoint on a single GB10
fails during the KV-cache profiling forward pass with

    RuntimeError: MotifNvfp4MoEMethod.apply should not be called;
                  the modular kernel dispatches through MotifNvfp4Experts.

The chain is entirely in the fork's own wiring, and no flag reaches it:

    FusedMoE.maybe_init_modular_kernel()      builds the modular kernel
      is called only by
    DeviceCommunicatorBase.prepare_communication_buffer_for_model()
      which is only reached when
    GroupCoordinator.device_communicator is not None
      which is constructed only when
    self.world_size > 1                        parallel_state.py:372

One GPU means the EP group has world_size 1, so no device communicator exists,
so the modular kernel is never built, so `apply` — which the Motif NVFP4 method
defines purely to raise — is what the runner reaches. `--enable-expert-parallel`
does not help: it does not change world_size, and a GB10 has one GPU. The
vendor verified this fork on 2xB200, where the branch is always taken.

This patch calls the same initialiser the multi-GPU path calls, for the same
modules, when the EP group exists but has no communicator. It adds no kernel and
reimplements nothing; it removes a world_size test that guards an allocation
this configuration does not need.

That is a narrower claim than "the NVFP4 path now works", and the difference
matters. Whether the kernel it builds computes the right thing on this hardware
is exactly what verification gate V3 is for — masked equivalence against the
reference implementation. Until that runs, anything served through this path is
a plausible model, not a verified one.

Idempotent: applying twice is a no-op. `--revert` restores the file.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ANCHOR = """def prepare_communication_buffer_for_model(model: torch.nn.Module):"""

MARKER = "# --- motifcode: single-GPU modular MoE ---"

PATCH = f'''

{MARKER}
def _motifcode_init_modular_moe_without_communicator(model: "torch.nn.Module") -> int:
    """Build the modular MoE kernel when no EP device communicator exists.

    Returns the number of MoE modules initialised. See
    toolkit/serving/patch_single_gpu_moe.py for why this is needed and for what
    it does not establish.
    """
    if _EP is None or _EP.device_communicator is not None:
        return 0

    from vllm.utils import is_moe_layer

    count = 0
    for module in model.modules():
        if is_moe_layer(module) and hasattr(module, "maybe_init_modular_kernel"):
            module.maybe_init_modular_kernel()
            count += 1
    if count:
        logger.info(
            "motifcode: built the modular MoE kernel for %d layers on a "
            "single-GPU EP group (world_size 1, no device communicator)",
            count,
        )
    return count
{MARKER}
'''

CALL = f"""
    {MARKER}
    _motifcode_init_modular_moe_without_communicator(model)
    {MARKER}
"""


def target_path(root: Path) -> Path:
    p = root / "vllm" / "distributed" / "parallel_state.py"
    if not p.is_file():
        sys.exit(f"not a vLLM checkout: {p} is missing")
    return p


def apply(path: Path) -> None:
    src = path.read_text()
    if MARKER in src:
        print(f"already patched: {path}")
        return
    if ANCHOR not in src:
        sys.exit(
            f"anchor not found in {path} — the fork moved; re-read "
            "prepare_communication_buffer_for_model before forcing this"
        )

    backup = path.with_suffix(".py.motifcode-orig")
    if not backup.exists():
        shutil.copy2(path, backup)

    head, _, tail = src.partition(ANCHOR)

    # The function body ends at the next top-level `def`; append the call to the
    # end of the body rather than guessing at indentation inside it.
    end = tail.find("\ndef ")
    if end == -1:
        sys.exit("could not find the end of prepare_communication_buffer_for_model")

    body, rest = tail[:end], tail[end:]
    patched = head + PATCH + ANCHOR + body + CALL + rest
    path.write_text(patched)
    print(f"patched {path}\nbackup  {backup}")


def revert(path: Path) -> None:
    backup = path.with_suffix(".py.motifcode-orig")
    if not backup.exists():
        sys.exit(f"no backup at {backup}")
    shutil.copy2(backup, path)
    print(f"reverted {path} from {backup}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root", help="path to the vLLM fork checkout")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    path = target_path(Path(args.root).expanduser())
    revert(path) if args.revert else apply(path)


if __name__ == "__main__":
    main()
