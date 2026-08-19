"""Selection, checked against hand-computed numbers and against its own failure.

The tests that matter here are the ones about the *family* of criteria rather
than the arithmetic. The previous pipeline offered three criteria that were all
the same ratio, so three of them agreeing meant nothing; the fixture below
builds the exact situation that exposes it — an expert both corpora depend on
heavily — and asserts that the absolute criteria keep it and the contrast
criterion throws it away.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import numpy as np

from select_experts import (
    CRITERIA,
    FORMULAS,
    SelectionError,
    keep_list_document,
    score_layer,
    select,
    summarise,
)
from stats import ProfileError, ProfileManifest, STAT_NAMES, validate_stats

N_EXPERTS = 8
TOP_K = 2
LAYERS = [2, 3]


def manifest(tokens: int = 100, **over) -> ProfileManifest:
    base = dict(
        source_repo="Motif-Technologies/Motif-3-NVFP4",
        source_revision="3a4416f7b555720d36e41f93207b826003ffe327",
        config_sha256="c" * 64,
        index_sha256="i" * 64,
        sidecar_sha256="s" * 64,
        corpus_manifest_sha256="m" * 64,
        template_sha256="t" * 64,
        tool_schema_sha256="x" * 64,
        backend="test",
        backend_version="0",
        num_experts=N_EXPERTS,
        experts_top_k=TOP_K,
        moe_layers=list(LAYERS),
        total_tokens=tokens,
        total_sequences=1,
        sequence_length=tokens,
        packing="none",
        seed=1,
        dtype="float32",
        route_norm=True,
        route_scale=2.0,
        gate_sum_includes_route_scale=True,
        selection_bias_applied=False,
    )
    base.update(over)
    return ProfileManifest(**base)


def stats_from(per_layer: dict[str, list[list[float]]], tokens: int) -> dict:
    """Build a stats dict, filling `counts` so the invariant holds."""
    out = {}
    for name in STAT_NAMES:
        rows = per_layer.get(name)
        if rows is None:
            rows = [[0.0] * N_EXPERTS for _ in LAYERS]
        arr = np.asarray(rows, dtype=np.int64 if name == "counts" else np.float64)
        out[name] = arr
    return out


def balanced_counts(tokens: int) -> np.ndarray:
    """Counts that satisfy `sum == tokens * top_k` on every layer."""
    total = tokens * TOP_K
    per = total // N_EXPERTS
    row = [per] * N_EXPERTS
    row[0] += total - per * N_EXPERTS
    return np.asarray([row for _ in LAYERS], dtype=np.int64)


def profile(gate: list[float], reap: list[float] | None = None, tokens: int = 100):
    stats = stats_from({}, tokens)
    stats["counts"] = balanced_counts(tokens)
    stats["gate_sum"] = np.asarray([gate, gate], dtype=np.float64)
    stats["reap_sum"] = np.asarray([reap or gate, reap or gate], dtype=np.float64)
    stats["norm_sum"] = np.asarray([reap or gate, reap or gate], dtype=np.float64)
    return stats, manifest(tokens)


class TestValidation(unittest.TestCase):
    def test_accepts_a_well_formed_profile(self):
        stats, man = profile([1.0] * N_EXPERTS)
        validate_stats(stats, man)

    def test_rejects_a_layer_whose_counts_do_not_add_up(self):
        # The invariant that catches a dropped hook or a double-counted batch.
        stats, man = profile([1.0] * N_EXPERTS)
        stats["counts"][0][0] += 1
        with self.assertRaisesRegex(ProfileError, "expected tokens x top_k"):
            validate_stats(stats, man)

    def test_rejects_non_finite_values(self):
        stats, man = profile([1.0] * N_EXPERTS)
        stats["reap_sum"][0][3] = np.inf
        with self.assertRaisesRegex(ProfileError, "non-finite"):
            validate_stats(stats, man)

    def test_rejects_negative_values(self):
        stats, man = profile([1.0] * N_EXPERTS)
        stats["gate_sum"][1][2] = -0.5
        with self.assertRaisesRegex(ProfileError, "negative"):
            validate_stats(stats, man)

    def test_rejects_the_wrong_shape(self):
        stats, man = profile([1.0] * N_EXPERTS)
        stats["gate_sum"] = np.zeros((len(LAYERS), N_EXPERTS + 1))
        with self.assertRaisesRegex(ProfileError, "shape"):
            validate_stats(stats, man)


class TestCriteriaAreDistinct(unittest.TestCase):
    """The point of the rewrite: these are not three names for one method."""

    def setUp(self):
        # Expert 0 is the one both corpora lean on hardest — the case pure
        # contrast gets wrong, because 100/100 ranks it below anything with a
        # lopsided ratio. Experts 1 and 2 are target-specific. Expert 7 is
        # reference-only, and is what a guard exists to protect.
        self.target = profile(
            gate=[100.0, 40.0, 20.0, 5.0, 5.0, 5.0, 5.0, 1.0],
            reap=[100.0, 40.0, 20.0, 5.0, 5.0, 5.0, 5.0, 1.0],
        )
        self.reference = profile(
            gate=[100.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 60.0],
            reap=[100.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 60.0],
        )

    def keep(self, criterion: str, keep_ratio: float = 0.25, **kw):
        reference = self.reference if criterion in {"guard_reap", "hybrid_share", "contrastive"} else None
        return select(criterion, keep_ratio, self.target, reference, seed=17, guard_n=kw.get("guard_n", 1))

    def test_contrastive_drops_the_expert_both_corpora_depend_on(self):
        # 100/100 = 1.0 ranks below 40/1 and 20/1, so the expert carrying the
        # most flow in the whole layer is the first one cut. This is the
        # documented Qwen collapse, reproduced in eight experts.
        keep = self.keep("contrastive")["2"]
        self.assertEqual(keep, [1, 2])
        self.assertNotIn(0, keep, "pure contrast is expected to drop the shared expert")

    def test_reap_keeps_it(self):
        self.assertIn(0, self.keep("reap")["2"])

    def test_gate_mass_keeps_it(self):
        self.assertIn(0, self.keep("gate_mass")["2"])

    def test_hybrid_share_keeps_it(self):
        # Per-token rates: expert 0 scores 1.0^2/(1.0+1.0) = 0.5, expert 1
        # scores 0.4^2/(0.4+0.01) = 0.39. Squaring the numerator is what stops
        # this collapsing back into a ratio.
        self.assertIn(0, self.keep("hybrid_share")["2"])

    def test_guard_reap_protects_reference_critical_experts(self):
        # Expert 7 is near-useless to the target and central to the reference.
        # With a guard it survives; under every target-only criterion it does
        # not. That is the difference between preserving general capability by
        # construction and hoping a benchmark notices its absence.
        guarded = self.keep("guard_reap", guard_n=2)["2"]
        self.assertIn(7, guarded)
        self.assertNotIn(7, self.keep("reap")["2"])

    def test_the_criteria_do_not_all_agree(self):
        # If they did, comparing them would be theatre.
        sets = {c: tuple(self.keep(c)["2"]) for c in ("reap", "contrastive", "hybrid_share")}
        self.assertGreater(len(set(sets.values())), 1, sets)

    def test_every_criterion_has_a_written_formula(self):
        for criterion in CRITERIA:
            self.assertIn(criterion, FORMULAS)
            self.assertTrue(FORMULAS[criterion].strip())


class TestScores(unittest.TestCase):
    def test_reap_is_the_recorded_sum(self):
        target = profile(gate=[1.0] * N_EXPERTS, reap=[3.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        scores = score_layer("reap", 2, target, None)
        self.assertEqual(list(scores[:2]), [3.0, 1.0])

    def test_man_divides_by_the_routed_count(self):
        stats, man = profile(gate=[1.0] * N_EXPERTS)
        stats["norm_sum"] = np.asarray([[100.0] + [0.0] * 7] * 2, dtype=np.float64)
        counts = stats["counts"][0][0]
        scores = score_layer("man", 2, (stats, man), None)
        self.assertAlmostEqual(scores[0], 100.0 / counts)

    def test_contrast_normalises_by_corpus_size(self):
        # Otherwise a bigger reference corpus alone changes every ranking.
        target = profile(gate=[10.0] * N_EXPERTS, tokens=100)
        small = profile(gate=[10.0] * N_EXPERTS, tokens=100)
        large = profile(gate=[100.0] * N_EXPERTS, tokens=1000)
        a = score_layer("contrastive", 2, target, small)
        b = score_layer("contrastive", 2, target, large)
        np.testing.assert_allclose(a, b, rtol=1e-9)


class TestDeterminism(unittest.TestCase):
    def test_the_same_seed_gives_the_same_random_control(self):
        target = profile(gate=[1.0] * N_EXPERTS)
        a = select("random", 0.5, target, None, seed=17, guard_n=0)
        b = select("random", 0.5, target, None, seed=17, guard_n=0)
        self.assertEqual(a, b)

    def test_a_different_seed_gives_a_different_one(self):
        target = profile(gate=[1.0] * N_EXPERTS)
        a = select("random", 0.5, target, None, seed=17, guard_n=0)
        b = select("random", 0.5, target, None, seed=18, guard_n=0)
        self.assertNotEqual(a, b)

    def test_random_uses_a_different_set_per_layer(self):
        target = profile(gate=[1.0] * N_EXPERTS)
        keep = select("random", 0.5, target, None, seed=17, guard_n=0)
        self.assertNotEqual(keep["2"], keep["3"])

    def test_ties_do_not_favour_low_expert_ids(self):
        # With a load-balanced router many experts score identically. `argsort`
        # breaks those ties by index, which skews the surviving bank toward one
        # end of the original ordering for no reason anyone chose.
        target = profile(gate=[1.0] * N_EXPERTS)
        keep = select("gate_mass", 0.5, target, None, seed=17, guard_n=0)["2"]
        self.assertNotEqual(keep, list(range(N_EXPERTS // 2)))

    def test_keep_lists_are_sorted_ascending(self):
        # The surviving router logits must keep their relative order, or the
        # slice permutes experts silently.
        target = profile(gate=list(np.arange(N_EXPERTS, dtype=float)))
        for ids in select("reap", 0.5, target, None, seed=17, guard_n=0).values():
            self.assertEqual(ids, sorted(ids))
            self.assertEqual(len(set(ids)), len(ids))


class TestRefusals(unittest.TestCase):
    def setUp(self):
        self.target = profile(gate=[1.0] * N_EXPERTS)
        self.reference = profile(gate=[1.0] * N_EXPERTS)

    def test_refuses_a_ratio_that_leaves_fewer_experts_than_top_k(self):
        with self.assertRaisesRegex(SelectionError, "below top_k"):
            select("reap", 0.1, self.target, None, seed=1, guard_n=0)

    def test_refuses_a_ratio_outside_the_unit_interval(self):
        for ratio in (0.0, -0.5, 1.5):
            with self.assertRaises(SelectionError):
                select("reap", ratio, self.target, None, seed=1, guard_n=0)

    def test_refuses_a_criterion_that_needs_a_reference_without_one(self):
        with self.assertRaisesRegex(SelectionError, "needs --reference"):
            select("guard_reap", 0.5, self.target, None, seed=1, guard_n=1)

    def test_refuses_a_reference_a_criterion_would_ignore(self):
        # Accepting it silently lets someone believe the reference corpus
        # influenced a selection that never looked at it.
        with self.assertRaisesRegex(SelectionError, "does not use a reference"):
            select("reap", 0.5, self.target, self.reference, seed=1, guard_n=0)

    def test_refuses_profiles_from_different_revisions(self):
        other = (self.reference[0], manifest(source_revision="deadbeef"))
        with self.assertRaisesRegex(SelectionError, "source_revision"):
            select("hybrid_share", 0.5, self.target, other, seed=1, guard_n=0)

    def test_refuses_profiles_whose_gate_sum_means_different_things(self):
        other = (self.reference[0], manifest(gate_sum_includes_route_scale=False))
        with self.assertRaisesRegex(SelectionError, "gate_sum"):
            select("hybrid_share", 0.5, self.target, other, seed=1, guard_n=0)

    def test_refuses_an_unknown_criterion(self):
        with self.assertRaisesRegex(SelectionError, "unknown criterion"):
            select("vibes", 0.5, self.target, None, seed=1, guard_n=0)


class TestDocument(unittest.TestCase):
    def test_records_the_formula_and_a_hash_of_the_keep_list(self):
        target = profile(gate=list(np.arange(N_EXPERTS, dtype=float)))
        keep = select("reap", 0.5, target, None, seed=17, guard_n=0)
        doc = keep_list_document(keep, "reap", 0.5, 17, 0, target[1], None)
        self.assertEqual(doc["formula"], FORMULAS["reap"])
        self.assertRegex(doc["keep_list_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(doc["source_revision"], target[1].source_revision)

    def test_the_hash_changes_with_the_keep_list(self):
        target = profile(gate=list(np.arange(N_EXPERTS, dtype=float)))
        a = keep_list_document(
            select("reap", 0.5, target, None, seed=17, guard_n=0), "reap", 0.5, 17, 0, target[1], None
        )
        b = keep_list_document(
            select("random", 0.5, target, None, seed=17, guard_n=0), "random", 0.5, 17, 0, target[1], None
        )
        self.assertNotEqual(a["keep_list_sha256"], b["keep_list_sha256"])

    def test_summary_reports_uniform_sizes(self):
        target = profile(gate=[1.0] * N_EXPERTS)
        keep = select("reap", 0.5, target, None, seed=17, guard_n=0)
        self.assertIn(f"of {N_EXPERTS}", summarise(keep, N_EXPERTS))


if __name__ == "__main__":
    unittest.main()
