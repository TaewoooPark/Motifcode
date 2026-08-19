"""Tests for keep-list selection, on synthetic profiles.

No weights needed: the selection is arithmetic over routing statistics, so it
can be settled entirely on a laptop — which is the point of doing it here
before spending a rental on the profiling run.
"""

from __future__ import annotations

import unittest

from select import score_layer, select_global, select_per_layer, summarise

NUM = 12


def profile(name: str, tokens: int, counts: list[float], masses: list[float] | None = None) -> dict:
    return {
        "corpus": name,
        "tokens": tokens,
        "num_experts": NUM,
        "layers": {"0": {"count": counts, "mass": masses or counts}},
    }


class TestContrastive(unittest.TestCase):
    def test_ranks_by_target_over_reference_not_by_raw_usage(self):
        # Expert 0 is used most in absolute terms by both corpora, but expert 5
        # is the one the target leans on *relative to* the reference. Load
        # balancing makes absolute usage near-uniform, so only the ratio carries
        # signal.
        target = profile("t", 100, [50, 1, 1, 1, 1, 20, 1, 1, 1, 1, 1, 1])
        reference = profile("r", 100, [50, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
        keep = select_per_layer(target, reference, "count", keep_ratio=1 / 12)
        self.assertEqual(keep["0"], [5])

    def test_normalises_by_corpus_size(self):
        # The same shape at ten times the tokens must rank identically.
        small = profile("t", 100, [10, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
        large = profile("t", 1000, [100, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10])
        reference = profile("r", 100, [1] * NUM)
        a = select_per_layer(small, reference, "count", 0.25)
        b = select_per_layer(large, reference, "count", 0.25)
        self.assertEqual(a, b)

    def test_count_and_mass_can_disagree(self):
        # Selection frequency carries the load-balancing bias; gate mass does
        # not. When they point different ways that is information, not noise.
        target = profile("t", 100, counts=[9, 1] + [1] * 10, masses=[1, 9] + [1] * 10)
        reference = profile("r", 100, counts=[1] * NUM, masses=[1] * NUM)
        by_count = select_per_layer(target, reference, "count", 1 / 12)
        by_mass = select_per_layer(target, reference, "mass", 1 / 12)
        self.assertEqual(by_count["0"], [0])
        self.assertEqual(by_mass["0"], [1])

    def test_blend_penalises_a_single_strong_axis(self):
        # A geometric mean: strong on one axis and absent on the other should
        # lose to something decent on both.
        target = profile("t", 100, counts=[100, 5] + [1] * 10, masses=[0, 5] + [1] * 10)
        reference = profile("r", 100, counts=[1] * NUM, masses=[1] * NUM)
        keep = select_per_layer(target, reference, "blend", 1 / 12)
        self.assertEqual(keep["0"], [1])

    def test_handles_an_expert_the_reference_never_used(self):
        target = profile("t", 100, [1] * 11 + [5])
        reference = profile("r", 100, [1] * 11 + [0])
        scores = score_layer(target, reference, "0", "count", NUM)
        self.assertTrue(all(s == s for s in scores), "no NaN")
        self.assertGreater(scores[11], scores[0])


class TestOrdering(unittest.TestCase):
    def test_keep_lists_are_sorted_ascending(self):
        # Order is preserved so the surviving router logits keep their relative
        # meaning; a shuffled list silently permutes experts.
        target = profile("t", 100, list(reversed(range(NUM))))
        reference = profile("r", 100, [1] * NUM)
        keep = select_per_layer(target, reference, "count", 0.5)
        self.assertEqual(keep["0"], sorted(keep["0"]))

    def test_keep_ratio_sets_the_size(self):
        target = profile("t", 100, list(range(NUM)))
        reference = profile("r", 100, [1] * NUM)
        self.assertEqual(len(select_per_layer(target, reference, "count", 0.5)["0"]), 6)
        self.assertEqual(len(select_per_layer(target, reference, "count", 0.25)["0"]), 3)

    def test_never_returns_an_empty_layer(self):
        target = profile("t", 100, [1] * NUM)
        reference = profile("r", 100, [1] * NUM)
        self.assertGreaterEqual(len(select_per_layer(target, reference, "count", 0.0)["0"]), 1)


class TestAllocation(unittest.TestCase):
    def _two_layers(self) -> tuple[dict, dict]:
        target = {
            "corpus": "t",
            "tokens": 100,
            "num_experts": NUM,
            "layers": {
                "0": {"count": [100] * NUM, "mass": [100] * NUM},
                "1": {"count": [1] * NUM, "mass": [1] * NUM},
            },
        }
        reference = {
            "corpus": "r",
            "tokens": 100,
            "num_experts": NUM,
            "layers": {
                "0": {"count": [1] * NUM, "mass": [1] * NUM},
                "1": {"count": [1] * NUM, "mass": [1] * NUM},
            },
        }
        return target, reference

    def test_per_layer_keeps_every_layer_the_same_size(self):
        target, reference = self._two_layers()
        keep = select_per_layer(target, reference, "count", 0.5)
        self.assertEqual(len(keep["0"]), len(keep["1"]))

    def test_global_never_starves_a_layer_below_top_k(self):
        # A layer with fewer than top-k experts cannot route at all. Global
        # allocation would happily do that to the quiet layer here.
        target, reference = self._two_layers()
        keep = select_global(target, reference, "count", 0.5)
        for layer, ids in keep.items():
            self.assertGreaterEqual(len(ids), 8, f"layer {layer} fell below top-k")


class TestSummary(unittest.TestCase):
    def test_reports_range_and_shared_experts(self):
        keep = {"0": [1, 2, 3], "1": [2, 3, 4]}
        text = summarise(keep, NUM)
        self.assertIn("layers 2", text)
        self.assertIn("shared across every layer 2", text)


if __name__ == "__main__":
    unittest.main()
