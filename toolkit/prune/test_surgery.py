"""Tests for the pruning surgery, runnable on any laptop.

Two levels:

  * against the real checkpoint index, vendored in `testdata/`, which is small
    enough to commit and pins the tensor layout we discovered;
  * against a synthetic state dict, which exercises the actual slicing without
    needing 187 GB of weights.

Run with:  python3 -m unittest discover -s toolkit/prune -p 'test_*.py'
"""

from __future__ import annotations

import json
import unittest

from _requires import require
from pathlib import Path

from surgery import (
    EXPERT_DIM_SUFFIXES,
    is_expert_tensor,
    layer_of,
    plan_from_index,
    rewrite_config,
    validate_keep,
)

HERE = Path(__file__).parent
INDEX = HERE / "testdata" / "motif3-nvfp4.index.json"


class TestTensorSelection(unittest.TestCase):
    def test_recognises_every_expert_tensor(self):
        for suffix in EXPERT_DIM_SUFFIXES:
            self.assertTrue(is_expert_tensor(f"model.layers.7.{suffix}"), suffix)

    def test_leaves_shared_experts_alone(self):
        # Shared experts run for every token, so they are not part of the
        # routed bank and must survive pruning untouched.
        for name in (
            "model.layers.7.moe.shared_experts.down_proj.weight",
            "model.layers.7.moe.shared_experts.gate_proj.weight",
            "model.layers.7.moe.shared_experts.act_fn.weight",
        ):
            self.assertFalse(is_expert_tensor(name), name)

    def test_leaves_attention_and_mhc_alone(self):
        for name in (
            "model.layers.7.self_attn.wq_b.weight",
            "model.layers.7.mhc_ffn.proj_res.weight",
            "model.layers.7.input_layernorm.weight",
            "model.mtp_layers.0.mlp.down_proj.weight",
        ):
            self.assertFalse(is_expert_tensor(name), name)

    def test_layer_extraction(self):
        self.assertEqual(layer_of("model.layers.42.moe.expert_bias"), 42)
        self.assertIsNone(layer_of("model.embed_tokens.weight"))


@unittest.skipUnless(INDEX.exists(), "checkpoint index not vendored")
class TestAgainstRealIndex(unittest.TestCase):
    def test_plan_matches_the_documented_layout(self):
        plan = plan_from_index(INDEX, keep=list(range(192)), original=384)
        self.assertEqual(len(plan.layers), 51, "Motif-3 has 51 MoE layers (2 dense + 51)")
        self.assertEqual(
            plan.expert_tensors,
            51 * len(EXPERT_DIM_SUFFIXES),
            "ten expert-dimension tensors per MoE layer",
        )
        self.assertEqual(plan.expert_tensors, 510)
        self.assertAlmostEqual(plan.ratio, 0.5)

    def test_every_moe_layer_has_the_full_tensor_set(self):
        names = json.loads(INDEX.read_text())["weight_map"].keys()
        by_layer: dict[int, set[str]] = {}
        for n in names:
            if not is_expert_tensor(n):
                continue
            layer = layer_of(n)
            assert layer is not None
            by_layer.setdefault(layer, set()).add(n.split(f"layers.{layer}.", 1)[1])
        expected = set(EXPERT_DIM_SUFFIXES)
        for layer, got in by_layer.items():
            self.assertEqual(got, expected, f"layer {layer} has an unexpected tensor set")


class TestKeepListValidation(unittest.TestCase):
    def test_rejects_empty(self):
        with self.assertRaises(ValueError):
            validate_keep([], 384)

    def test_rejects_duplicates(self):
        with self.assertRaises(ValueError):
            validate_keep([1, 1, 2], 384)

    def test_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            validate_keep([0, 384], 384)

    def test_requires_ascending_order(self):
        # Order is preserved so the surviving router logits keep their relative
        # positions; a shuffled keep-list would silently permute experts.
        with self.assertRaises(ValueError):
            validate_keep([5, 3, 1], 384)

    def test_accepts_a_sane_list(self):
        validate_keep(list(range(0, 384, 2)), 384)


class TestConfigRewrite(unittest.TestCase):
    def test_updates_expert_count_and_records_provenance(self):
        out = rewrite_config({"num_experts": 384, "experts_top_k": 8}, 192)
        self.assertEqual(out["num_experts"], 192)
        self.assertEqual(out["motifcode"]["pruned_from"], 384)
        self.assertEqual(out["motifcode"]["pruned_to"], 192)

    def test_leaves_top_k_alone(self):
        # Pruning changes how many experts exist, not how many are consulted:
        # activated parameters, and therefore decode speed, are unchanged.
        out = rewrite_config({"num_experts": 384, "experts_top_k": 8}, 192)
        self.assertEqual(out["experts_top_k"], 8)


class TestSlicing(unittest.TestCase):
    def test_slices_axis_zero_only(self):
        require("torch", self)
        import torch

        from surgery import slice_state_dict

        tensors = {
            "model.layers.0.moe.experts.gate_up_proj": torch.arange(8 * 3).reshape(8, 3),
            "model.layers.0.moe.expert_bias": torch.arange(8),
            "model.layers.0.self_attn.wo.weight": torch.arange(4 * 4).reshape(4, 4),
        }
        out = slice_state_dict(tensors, [0, 2, 4, 6])
        self.assertEqual(tuple(out["model.layers.0.moe.experts.gate_up_proj"].shape), (4, 3))
        self.assertEqual(tuple(out["model.layers.0.moe.expert_bias"].shape), (4,))
        self.assertEqual(tuple(out["model.layers.0.self_attn.wo.weight"].shape), (4, 4))
        self.assertTrue(torch.equal(out["model.layers.0.moe.expert_bias"], torch.tensor([0, 2, 4, 6])))


if __name__ == "__main__":
    unittest.main()
