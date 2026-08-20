"""Adding profile slices, and the additions that must be refused.

Two profiles of overlapping slices add to something indistinguishable from a
profile of twice as many tokens. Nothing downstream can detect it: the counts
are larger, the ratios are plausible, and the selection is confidently wrong.
So the refusals are the point of this module, and these are their tests.
"""

from __future__ import annotations

import shutil
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import mkdtemp

from _requires import require
from stats import ProfileError, ProfileManifest


def manifest(**over) -> ProfileManifest:
    base = dict(
        source_repo="r",
        source_revision="a" * 40,
        config_sha256="b" * 64,
        index_sha256="c" * 64,
        sidecar_sha256="d" * 64,
        corpus_manifest_sha256="e" * 64,
        template_sha256="f" * 64,
        tool_schema_sha256="0" * 64,
        backend="layer-major-streaming",
        backend_version="1",
        num_experts=8,
        experts_top_k=2,
        moe_layers=[0, 1],
        total_tokens=100,
        total_sequences=4,
        sequence_length=64,
        packing="windows",
        seed=0,
        dtype="torch.bfloat16",
        route_norm=True,
        route_scale=2.0,
        gate_sum_includes_route_scale=True,
        selection_bias_applied=True,
        corpus_slice="1/4",
    )
    base.update(over)
    return ProfileManifest(**base)


class CombineCase(unittest.TestCase):
    def setUp(self):
        require("numpy", self)
        require("safetensors", self)
        self.root = Path(mkdtemp(prefix="motif-combine-"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, name: str, tokens: int, **over) -> Path:
        """A profile whose counts are consistent with its token total.

        `validate_stats` checks that each layer's counts sum to
        `tokens x top_k`, and it is right to: a profile where they do not is
        one where the router and the accumulator disagree. Fixtures have to
        satisfy the same invariant as real profiles, or the tests below pass
        against data the pipeline would reject.
        """
        import numpy as np
        from stats import STAT_NAMES, save_profile

        m = manifest(total_tokens=tokens, **over)
        per_expert = tokens * m.experts_top_k // m.num_experts
        stats = {
            n: (
                np.full((2, 8), per_expert, dtype=np.int64)
                if n == "counts"
                else np.full((2, 8), float(per_expert), dtype=np.float64)
            )
            for n in STAT_NAMES
        }
        path = self.root / f"{name}.stats.safetensors"
        save_profile(path, stats, m)
        return path


class TestCombine(CombineCase):
    def test_sums_disjoint_slices(self):
        from combine_profiles import combine

        a = self.write("a", 100, corpus_slice="1/2")
        b = self.write("b", 140, corpus_slice="2/2")
        stats, m = combine([a, b])
        self.assertEqual(stats["counts"][0][0], 25 + 35)
        self.assertEqual(m.total_tokens, 240)
        self.assertTrue(m.corpus_slice.startswith("pooled:"))

    def test_refuses_the_same_slice_twice(self):
        # The one that matters. Re-running slice 2 after a crash and adding
        # both copies doubles a quarter of the corpus, and every count still
        # looks reasonable.
        from combine_profiles import combine

        a = self.write("a", 100, corpus_slice="2/4")
        b = self.write("b", 140, corpus_slice="2/4")
        with self.assertRaises(ProfileError) as caught:
            combine([a, b])
        self.assertIn("counts it twice", str(caught.exception))

    def test_refuses_slices_taken_with_different_strides(self):
        from combine_profiles import combine

        a = self.write("a", 100, corpus_slice="2/4")
        b = self.write("b", 140, corpus_slice="2/8")
        with self.assertRaises(ProfileError) as caught:
            combine([a, b])
        self.assertIn("do not partition the corpus", str(caught.exception))

    def test_refuses_a_whole_corpus_profile_added_to_a_slice(self):
        # `1/1` is the whole corpus, so it contains every record `2/4` does.
        # Adding them counts a quarter of the corpus twice.
        from combine_profiles import combine

        a = self.write("a", 100, corpus_slice="1/1")
        b = self.write("b", 140, corpus_slice="2/4")
        with self.assertRaises(ProfileError) as caught:
            combine([a, b])
        self.assertIn("do not partition the corpus", str(caught.exception))

    def test_refuses_profiles_of_different_checkpoints(self):
        from combine_profiles import combine

        a = self.write("a", 100, corpus_slice="1/2")
        b = self.write("b", 140, corpus_slice="2/2", source_revision="9" * 40)
        with self.assertRaises(ProfileError) as caught:
            combine([a, b])
        self.assertIn("cannot be added", str(caught.exception))

    def test_each_profile_keeps_its_own_manifest_in_one_directory(self):
        # `save_profile` used to write a fixed `profile.manifest.json`, so the
        # second profile in a directory overwrote the first one's provenance
        # and every later comparison read one profile's numbers against
        # another's conditions.
        from stats import load_profile

        a = self.write("a", 100, corpus_slice="1/2")
        b = self.write("b", 140, corpus_slice="2/2")
        _, ma = load_profile(a)
        _, mb = load_profile(b)
        self.assertEqual(ma.total_tokens, 100)
        self.assertEqual(mb.total_tokens, 140)
        self.assertEqual(ma.corpus_slice, "1/2")
        self.assertEqual(mb.corpus_slice, "2/2")


if __name__ == "__main__":
    unittest.main()
