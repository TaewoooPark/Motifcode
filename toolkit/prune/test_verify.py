"""Verification, and the ways a verifier can pass a broken checkpoint.

The old `verify.py` asked one question — do four prompts give the same argmax —
and printed PASS. That single check was both too weak and too strong: too weak
because it never looked at the bytes, so a permuted keep-list or an unsliced
sidecar sailed through; too strong because exact argmax equality fails on
near-ties for reasons that have nothing to do with the surgery.

These tests inject each failure deliberately and require the verifier to notice.
"""

from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path
from tempfile import mkdtemp

from _requires import require
from test_surgery import KEEP, LAYERS, SIDECAR_SUFFIXES, build_checkpoint
from verify import Report, compare, judge, verify_manifest, verify_mapping
from surgery import SIDECAR_FILE, preflight


class VerifyCase(unittest.TestCase):
    def setUp(self):
        require("torch", self)
        require("safetensors", self)
        from surgery import apply_surgery

        self.root = Path(mkdtemp(prefix="motif-verify-"))
        self.src = build_checkpoint(self.root / "src")
        self.dst = self.root / "dst"
        self.keep = {str(layer): list(KEEP) for layer in LAYERS}
        apply_surgery(preflight(self.src, self.dst, self.keep))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_v1(self) -> Report:
        report = Report()
        verify_mapping(self.src, self.dst, self.keep, report)
        verify_manifest(self.dst, report)
        return report


class TestV1(VerifyCase):
    def test_a_correct_surgery_passes(self):
        report = self.run_v1()
        self.assertTrue(report.ok, report.render())

    def test_catches_a_permuted_keep_list(self):
        # The rows are all present and in the wrong order. Every aggregate
        # statistic about the checkpoint is unchanged.
        import torch
        from safetensors.torch import load_file, save_file

        shard = sorted(p.name for p in self.dst.glob("model-*.safetensors"))[0]
        tensors = load_file(str(self.dst / shard))
        name = f"model.layers.{LAYERS[0]}.moe.expert_bias"
        tensors[name] = tensors[name].flip(0).contiguous()
        save_file(tensors, str(self.dst / shard), metadata={"format": "pt"})

        report = self.run_v1()
        self.assertFalse(report.ok)
        self.assertIn("not source[keep]", report.render())
        del torch

    def test_catches_a_flipped_bit_in_an_untouched_tensor(self):
        from safetensors.torch import load_file, save_file

        shard = sorted(p.name for p in self.dst.glob("model-*.safetensors"))[0]
        tensors = load_file(str(self.dst / shard))
        name = f"model.layers.{LAYERS[0]}.self_attn.wo.weight"
        tensors[name] = tensors[name] + 1
        save_file(tensors, str(self.dst / shard), metadata={"format": "pt"})

        report = self.run_v1()
        self.assertFalse(report.ok)
        self.assertIn("changed", report.render())

    def test_catches_a_missing_sidecar(self):
        (self.dst / SIDECAR_FILE).unlink()
        report = self.run_v1()
        self.assertFalse(report.ok)
        self.assertIn("missing", report.render())

    def test_catches_a_sidecar_copied_through_instead_of_sliced(self):
        # The failure that loads: the model runs with survivor j holding the
        # activation scale of original expert j.
        shutil.copy2(self.src / SIDECAR_FILE, self.dst / SIDECAR_FILE)
        report = self.run_v1()
        self.assertFalse(report.ok)
        self.assertIn("sidecar", report.render())

    def test_catches_a_sidecar_sliced_with_the_wrong_list(self):
        import torch
        from safetensors.torch import load_file, save_file

        src = load_file(str(self.src / SIDECAR_FILE))
        wrong = {
            name: tensor.index_select(0, torch.tensor([1, 3, 5, 7], dtype=torch.long)).contiguous()
            for name, tensor in src.items()
        }
        save_file(wrong, str(self.dst / SIDECAR_FILE))
        report = self.run_v1()
        self.assertFalse(report.ok)
        self.assertIn("not source[keep]", report.render())

    def test_catches_a_manifest_that_no_longer_describes_the_files(self):
        shard = sorted(p.name for p in self.dst.glob("model-*.safetensors"))[0]
        target = self.dst / shard
        target.write_bytes(target.read_bytes()[:-8])
        report = Report()
        verify_manifest(self.dst, report)
        self.assertFalse(report.ok)

    def test_catches_a_missing_manifest(self):
        (self.dst / "pruning_manifest.json").unlink()
        report = Report()
        verify_manifest(self.dst, report)
        self.assertFalse(report.ok)

    def test_the_sidecar_count_is_checked_not_just_its_contents(self):
        import torch
        from safetensors.torch import load_file, save_file

        src = load_file(str(self.dst / SIDECAR_FILE))
        one_short = dict(list(src.items())[:-1])
        save_file(one_short, str(self.dst / SIDECAR_FILE))
        report = Report()
        verify_mapping(self.src, self.dst, self.keep, report)
        self.assertFalse(report.ok)
        del torch


class TestDivergence(unittest.TestCase):
    def setUp(self):
        require("torch", self)

    def test_identical_logits_diverge_by_nothing(self):
        import torch

        ref = torch.randn(4, 16)
        d = compare(ref, ref.clone())
        self.assertEqual(d.abs_max, 0.0)
        self.assertEqual(d.top1_mismatches, 0)

    def test_a_near_tie_flip_is_not_counted_against_the_surgery(self):
        # The reference could not decide between two candidates; rounding picked
        # the other one. Counting that as a failure makes a correct surgery look
        # broken precisely where the model was undecided.
        import torch

        ref = torch.tensor([[1.0, 1.0 + 1e-6, 0.0, 0.0]])
        cand = torch.tensor([[1.0 + 1e-5, 1.0, 0.0, 0.0]])
        d = compare(ref, cand, error_bound=1e-3)
        self.assertEqual(d.top1_mismatches, 1)
        self.assertEqual(d.top1_mismatches_beyond_margin, 0)

    def test_a_decided_flip_is_counted(self):
        # The reference preferred its top choice by 4.0 and the noise floor is
        # 0.01, so nothing about rounding explains the candidate disagreeing.
        import torch

        ref = torch.tensor([[5.0, 1.0, 0.0, 0.0]])
        cand = torch.tensor([[1.0, 5.0, 0.0, 0.0]])
        d = compare(ref, cand, error_bound=0.01)
        self.assertEqual(d.top1_mismatches_beyond_margin, 1)

    def test_the_bound_comes_from_outside_the_row(self):
        # Comparing a row's margin against that row's own error can never fire:
        # swapping the top two requires an error at least as large as the gap.
        import torch

        ref = torch.zeros(100, 4)
        ref[:, 0] = 5.0
        cand = ref.clone()
        cand[0] = torch.tensor([1.0, 5.0, 0.0, 0.0])  # one decided flip
        d = compare(ref, cand)
        self.assertEqual(d.top1_mismatches, 1)
        self.assertEqual(d.top1_mismatches_beyond_margin, 1)

    def test_reports_a_distribution_rather_than_one_number(self):
        import torch

        ref = torch.zeros(100, 8)
        cand = ref.clone()
        cand[0, 0] = 10.0  # one big outlier
        d = compare(ref, cand)
        self.assertEqual(d.abs_max, 10.0)
        # A single outlier must not drag the p50, or "max error" becomes the
        # only number anyone looks at.
        self.assertEqual(d.abs_p50, 0.0)


class TestJudgement(unittest.TestCase):
    def setUp(self):
        require("torch", self)

    def divergence(self, **over):
        base = dict(
            positions=10,
            abs_p50=0.0,
            abs_p99=0.01,
            abs_max=0.02,
            rel_p99=0.001,
            top1_mismatches=0,
            top1_mismatches_beyond_margin=0,
        )
        base.update(over)
        from verify import Divergence

        return Divergence(**base)

    def test_a_decided_flip_fails_whatever_the_tolerance(self):
        report = Report()
        judge(self.divergence(top1_mismatches_beyond_margin=3), None, 4.0, report, "V3")
        self.assertFalse(report.ok)
        self.assertIn("surgery bug", report.render())

    def test_without_a_measured_floor_it_reports_rather_than_grades(self):
        # A tolerance chosen without measuring is a number somebody liked.
        report = Report()
        judge(self.divergence(), None, 4.0, report, "V3")
        self.assertTrue(report.ok)
        self.assertIn("reported rather than graded", report.render())

    def test_drift_within_the_measured_floor_passes(self):
        report = Report()
        judge(self.divergence(abs_p99=0.03), self.divergence(abs_p99=0.01), 4.0, report, "V3")
        self.assertTrue(report.ok)

    def test_drift_beyond_the_measured_floor_fails(self):
        report = Report()
        judge(self.divergence(abs_p99=0.05), self.divergence(abs_p99=0.01), 4.0, report, "V3")
        self.assertFalse(report.ok)
        self.assertIn("zero-prune floor", report.render())


if __name__ == "__main__":
    unittest.main()
