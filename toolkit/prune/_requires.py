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
