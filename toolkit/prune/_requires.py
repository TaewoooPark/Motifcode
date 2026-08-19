"""Whether a missing dependency is a skip or a failure.

A test that skips when torch is absent is reasonable on a laptop and dishonest
in CI: the slicing path decides whether a pruned checkpoint is correct, and it
was skipped on every commit because nothing installed torch. `MOTIF_REQUIRE_TORCH=1`
turns the skip into a failure, and CI sets it — so "24 passed, 1 skipped" can
no longer be read as coverage.
"""

from __future__ import annotations

import os
import unittest


def require_reference(path, test: unittest.TestCase) -> None:
    """The vendor's modelling code, or a skip — unless skipping is forbidden.

    `modeling_motif.py` is not vendored into this repository. It is 73 KB of
    somebody else's MIT-licensed code that would drift from upstream the moment
    it was copied, and pinning it by download keeps the provenance exact. CI
    fetches it and sets `MOTIF_REQUIRE_REFERENCE=1`, which turns this skip into
    a failure — because the equivalence test it guards is the one that decides
    whether the profiler's forward pass is the model's.
    """
    from pathlib import Path

    if (Path(path) / "modeling_motif.py").exists():
        return
    if os.environ.get("MOTIF_REQUIRE_REFERENCE") == "1":
        test.fail(
            f"{path}/modeling_motif.py is absent and MOTIF_REQUIRE_REFERENCE=1 forbids skipping. "
            f"Fetch it with: hf download Motif-Technologies/Motif-3 modeling_motif.py "
            f"configuration_motif.py --local-dir {path}"
        )
    test.skipTest(f"{path}/modeling_motif.py is absent; see toolkit/README for how to fetch it")


def require(module: str, test: unittest.TestCase) -> object:
    """Import a module, or skip — unless skipping has been forbidden."""
    try:
        return __import__(module)
    except ImportError:
        if os.environ.get("MOTIF_REQUIRE_TORCH") == "1":
            test.fail(
                f"{module} is not installed, and MOTIF_REQUIRE_TORCH=1 forbids skipping. "
                f"Install toolkit/requirements-dev.txt."
            )
        test.skipTest(f"{module} not installed; this path is exercised where the weights are")
        raise  # unreachable; keeps type checkers happy
