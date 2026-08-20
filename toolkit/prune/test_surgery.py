"""Surgery, against the real index and against a synthetic checkpoint.

Two levels. The vendored `testdata/motif3-nvfp4.index.json` is the real
checkpoint's index — small enough to commit, and it pins the tensor layout that
was discovered rather than assumed. The synthetic checkpoint is a whole, tiny,
valid one: shards, sidecar, config and all, so the transaction can be
interrupted and resumed for real rather than in principle.

The test that matters most is the sidecar one. Omitting those 102 tensors does
not crash anything — the model loads and runs with the wrong activation scales,
which is the failure nobody notices.
"""

from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path
from tempfile import mkdtemp

from _requires import require
from surgery import (
    EXPERT_DIM_SUFFIXES,
    SIDECAR_FILE,
    SIDECAR_SUFFIXES,
    SurgeryError,
    is_expert_tensor,
    is_sidecar_tensor,
    layer_of,
    preflight,
    rewrite_config,
)

HERE = Path(__file__).resolve().parent
REAL_INDEX = HERE / "testdata" / "motif3-nvfp4.index.json"


class TestNaming(unittest.TestCase):
    def test_the_ten_indexed_suffixes(self):
        for suffix in EXPERT_DIM_SUFFIXES:
            self.assertTrue(is_expert_tensor(f"model.layers.7.{suffix}"), suffix)

    def test_the_two_sidecar_suffixes(self):
        for suffix in SIDECAR_SUFFIXES:
            self.assertTrue(is_sidecar_tensor(f"model.layers.7.{suffix}"), suffix)

    def test_shared_experts_are_not_routed_experts(self):
        # Slicing `moe.shared_experts.*` would remove the one expert every token
        # uses, and nothing about the name says "routed".
        for name in (
            "model.layers.7.moe.shared_experts.up_proj.weight",
            "model.layers.7.moe.shared_experts.down_proj.weight",
            "model.layers.7.self_attn.wo.weight",
            "model.layers.7.mhc_attn.proj_pre.weight",
            "model.layers.7.input_layernorm.weight",
        ):
            self.assertFalse(is_expert_tensor(name), name)
            self.assertFalse(is_sidecar_tensor(name), name)

    def test_layer_numbers_come_from_the_name(self):
        self.assertEqual(layer_of("model.layers.42.moe.expert_bias"), 42)
        self.assertIsNone(layer_of("model.norm.weight"))


@unittest.skipUnless(REAL_INDEX.exists(), "the vendored index fixture is missing")
class TestAgainstTheRealIndex(unittest.TestCase):
    """The layout as it actually is, not as it was assumed to be."""

    def setUp(self):
        self.index = json.loads(REAL_INDEX.read_text())
        self.names = list(self.index["weight_map"])

    def test_the_index_holds_2440_tensors(self):
        self.assertEqual(len(self.names), 2440)

    def test_510_indexed_tensors_carry_the_expert_dimension(self):
        self.assertEqual(len([n for n in self.names if is_expert_tensor(n)]), 510)

    def test_ten_per_layer_across_51_moe_layers(self):
        expert = [n for n in self.names if is_expert_tensor(n)]
        layers = sorted({layer_of(n) for n in expert})
        self.assertEqual(len(layers), 51)
        self.assertEqual((layers[0], layers[-1]), (2, 52))
        for layer in layers:
            self.assertEqual(sum(1 for n in expert if layer_of(n) == layer), 10, f"layer {layer}")

    def test_510_plus_102_is_612(self):
        # The number that matters. 510 is what the index knows about; the other
        # 102 live in a sidecar the index does not mention, and a surgery that
        # stops at 510 produces a model that loads and is miscalibrated.
        expert = [n for n in self.names if is_expert_tensor(n)]
        layers = sorted({layer_of(n) for n in expert})
        sidecar = len(layers) * len(SIDECAR_SUFFIXES)
        self.assertEqual(sidecar, 102)
        self.assertEqual(len(expert) + sidecar, 612)


class TestConfigRewrite(unittest.TestCase):
    def test_num_experts_changes(self):
        out = rewrite_config({"num_experts": 384, "experts_top_k": 8}, 192)
        self.assertEqual(out["num_experts"], 192)
        self.assertEqual(out["motifcode_pruning"]["pruned_from"], 384)

    def test_top_k_does_not(self):
        # Pruning changes how many experts exist, not how many are consulted per
        # token, so activated parameters and decode speed are unchanged.
        out = rewrite_config({"num_experts": 384, "experts_top_k": 8}, 192)
        self.assertEqual(out["experts_top_k"], 8)


# ------------------------------------------------------------------ #
# a whole synthetic checkpoint                                        #
# ------------------------------------------------------------------ #

EXPERTS = 8
KEEP = [0, 2, 4, 6]
LAYERS = [2, 3]
TOP_K = 2


def build_checkpoint(root: Path) -> Path:
    """A tiny but structurally complete NVFP4-shaped checkpoint."""
    import torch
    from safetensors.torch import save_file

    root.mkdir(parents=True, exist_ok=True)
    weight_map: dict[str, str] = {}
    shapes = {
        "moe.experts.gate_up_proj": (EXPERTS, 4, 2),
        "moe.experts.gate_up_proj_weight_scale": (EXPERTS, 4, 1),
        "moe.experts.gate_up_proj_weight_scale_2": (EXPERTS,),
        "moe.experts.down_proj": (EXPERTS, 2, 2),
        "moe.experts.down_proj_weight_scale": (EXPERTS, 2, 1),
        "moe.experts.down_proj_weight_scale_2": (EXPERTS,),
        "moe.experts.act_fn.weight": (EXPERTS, 3),
        "moe.experts.act_fn.bias": (EXPERTS, 1),
        "moe.router.gate.weight": (EXPERTS, 4),
        "moe.expert_bias": (EXPERTS,),
    }
    torch.manual_seed(4)
    for i, layer in enumerate(LAYERS):
        shard = f"model-0000{i + 1}-of-0000{len(LAYERS)}.safetensors"
        tensors = {}
        for suffix, shape in shapes.items():
            name = f"model.layers.{layer}.{suffix}"
            # Values that identify their expert, so a mis-mapped slice shows up
            # as a wrong number rather than as noise.
            base = torch.arange(EXPERTS, dtype=torch.float32).reshape(
                (EXPERTS,) + (1,) * (len(shape) - 1)
            )
            tensors[name] = (base + torch.zeros(shape)).contiguous()
            weight_map[name] = shard
        untouched = f"model.layers.{layer}.self_attn.wo.weight"
        tensors[untouched] = torch.full((4, 4), float(layer))
        weight_map[untouched] = shard
        save_file(tensors, str(root / shard), metadata={"format": "pt"})

    (root / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": {"total_size": 0}, "weight_map": weight_map}, indent=2)
    )
    (root / "config.json").write_text(
        json.dumps({"num_experts": EXPERTS, "experts_top_k": TOP_K, "num_hidden_layers": 4})
    )
    sidecar = {}
    for layer in LAYERS:
        for suffix in SIDECAR_SUFFIXES:
            sidecar[f"model.layers.{layer}.{suffix}"] = (
                torch.arange(EXPERTS, dtype=torch.float32) + layer * 100
            )
    save_file(sidecar, str(root / SIDECAR_FILE))
    (root / "tokenizer_config.json").write_text("{}")
    return root


class SurgeryCase(unittest.TestCase):
    def setUp(self):
        require("torch", self)
        require("safetensors", self)
        self.root = Path(mkdtemp(prefix="motif-surgery-"))
        self.src = build_checkpoint(self.root / "src")
        self.dst = self.root / "dst"
        self.keep = {str(layer): list(KEEP) for layer in LAYERS}

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def plan(self, **over):
        keep = over.pop("keep", self.keep)
        return preflight(self.src, over.pop("dst", self.dst), keep, **over)


class TestPreflight(SurgeryCase):
    def test_counts_both_kinds_of_tensor(self):
        plan = self.plan()
        self.assertEqual(plan.indexed_sliced, 10 * len(LAYERS))
        self.assertEqual(plan.sidecar_sliced, 2 * len(LAYERS))
        self.assertEqual(plan.target_experts, len(KEEP))

    def test_creates_nothing(self):
        self.plan()
        self.assertFalse(self.dst.exists())

    def test_refuses_an_unsorted_keep_list(self):
        with self.assertRaisesRegex(SurgeryError, "sorted ascending"):
            self.plan(keep={str(l): [6, 0, 2, 4] for l in LAYERS})

    def test_refuses_duplicates(self):
        with self.assertRaisesRegex(SurgeryError, "duplicates"):
            self.plan(keep={str(l): [0, 0, 2, 4] for l in LAYERS})

    def test_refuses_an_out_of_range_expert(self):
        with self.assertRaisesRegex(SurgeryError, "out of range"):
            self.plan(keep={str(l): [0, 2, 4, 99] for l in LAYERS})

    def test_refuses_fewer_experts_than_top_k(self):
        with self.assertRaisesRegex(SurgeryError, "below top_k"):
            self.plan(keep={str(l): [0] for l in LAYERS})

    def test_refuses_layers_with_different_survivor_counts(self):
        # `num_experts` is one value that the loader, the tensor shapes, the
        # sidecar and the fused kernels all read.
        with self.assertRaisesRegex(SurgeryError, "uniform in size"):
            self.plan(keep={str(LAYERS[0]): [0, 2, 4, 6], str(LAYERS[1]): [0, 2, 4]})

    def test_refuses_a_missing_layer(self):
        with self.assertRaisesRegex(SurgeryError, "no keep-list for MoE layer"):
            self.plan(keep={str(LAYERS[0]): list(KEEP)})

    def test_refuses_a_missing_sidecar(self):
        (self.src / SIDECAR_FILE).unlink()
        with self.assertRaisesRegex(SurgeryError, SIDECAR_FILE):
            self.plan()

    def test_refuses_a_sidecar_with_the_wrong_shape(self):
        import torch
        from safetensors.torch import save_file

        save_file(
            {
                f"model.layers.{l}.{s}": torch.zeros(EXPERTS + 1)
                for l in LAYERS
                for s in SIDECAR_SUFFIXES
            },
            str(self.src / SIDECAR_FILE),
        )
        with self.assertRaisesRegex(SurgeryError, "shape"):
            self.plan()

    def test_refuses_a_non_empty_destination(self):
        self.dst.mkdir(parents=True)
        (self.dst / "something").write_text("x")
        with self.assertRaisesRegex(SurgeryError, "not empty"):
            self.plan()

    def test_reports_every_problem_at_once(self):
        # Fixing a keep-list one error per run, when each run needs the
        # checkpoint mounted, is a bad way to spend an afternoon.
        try:
            self.plan(keep={str(LAYERS[0]): [6, 0, 0, 99]})
            self.fail("expected a refusal")
        except SurgeryError as err:
            self.assertGreaterEqual(str(err).count("\n  - "), 3)


class TestApply(SurgeryCase):
    def test_slices_both_the_shards_and_the_sidecar(self):
        from safetensors.torch import load_file
        from surgery import apply_surgery

        manifest = apply_surgery(self.plan())
        self.assertEqual(manifest["surgery"]["indexed_sliced"], 10 * len(LAYERS))
        self.assertEqual(manifest["surgery"]["sidecar_sliced"], 2 * len(LAYERS))

        sidecar = load_file(str(self.dst / SIDECAR_FILE))
        for layer in LAYERS:
            for suffix in SIDECAR_SUFFIXES:
                got = sidecar[f"model.layers.{layer}.{suffix}"]
                self.assertEqual([float(x) for x in got], [float(e + layer * 100) for e in KEEP])

    def test_a_non_contiguous_keep_list_is_not_the_first_k(self):
        # The bug this exists for: copying the sidecar through, or taking the
        # first K entries, gives survivor j the scale of expert j rather than of
        # keep[j]. Both load. Neither is right.
        from safetensors.torch import load_file
        from surgery import apply_surgery

        apply_surgery(self.plan())
        sidecar = load_file(str(self.dst / SIDECAR_FILE))
        got = [float(x) for x in sidecar[f"model.layers.{LAYERS[0]}.{SIDECAR_SUFFIXES[0]}"]]
        first_k = [float(e + LAYERS[0] * 100) for e in range(len(KEEP))]
        self.assertNotEqual(got, first_k)

    def test_every_survivor_maps_to_its_source_row(self):
        from safetensors.torch import load_file
        from surgery import apply_surgery

        plan = self.plan()
        apply_surgery(plan)
        for shard in plan.shards:
            out = load_file(str(self.dst / shard))
            src = load_file(str(self.src / shard))
            for name, tensor in out.items():
                if is_expert_tensor(name):
                    for j, e in enumerate(KEEP):
                        self.assertTrue(bool((tensor[j] == src[name][e]).all()), f"{name}[{j}]")

    def test_untouched_tensors_are_byte_identical(self):
        from safetensors.torch import load_file
        from surgery import apply_surgery

        plan = self.plan()
        apply_surgery(plan)
        for shard in plan.shards:
            out = load_file(str(self.dst / shard))
            src = load_file(str(self.src / shard))
            for name in out:
                if not is_expert_tensor(name):
                    self.assertTrue(bool((out[name] == src[name]).all()), name)

    def test_the_source_is_not_modified(self):
        from surgery import apply_surgery, sha256_file

        before = {p.name: sha256_file(p) for p in sorted(self.src.iterdir()) if p.is_file()}
        apply_surgery(self.plan())
        after = {p.name: sha256_file(p) for p in sorted(self.src.iterdir()) if p.is_file()}
        self.assertEqual(before, after)

    def test_the_index_keeps_every_key(self):
        from surgery import apply_surgery

        apply_surgery(self.plan())
        src = json.loads((self.src / "model.safetensors.index.json").read_text())["weight_map"]
        dst = json.loads((self.dst / "model.safetensors.index.json").read_text())["weight_map"]
        self.assertEqual(set(src), set(dst))

    def test_the_config_records_the_new_expert_count(self):
        from surgery import apply_surgery

        apply_surgery(self.plan())
        config = json.loads((self.dst / "config.json").read_text())
        self.assertEqual(config["num_experts"], len(KEEP))
        self.assertEqual(config["experts_top_k"], TOP_K)

    def test_runtime_assets_come_along(self):
        from surgery import apply_surgery

        apply_surgery(self.plan())
        self.assertTrue((self.dst / "tokenizer_config.json").exists())

    def test_the_manifest_hashes_every_output_file(self):
        from surgery import apply_surgery, sha256_file

        manifest = apply_surgery(self.plan())
        for entry in manifest["files"]:
            path = self.dst / entry["path"]
            self.assertTrue(path.exists(), entry["path"])
            self.assertEqual(sha256_file(path), entry["sha256"])
        self.assertEqual(manifest["surgery"]["total_sliced"], 12 * len(LAYERS))


class TestFailureAndResume(SurgeryCase):
    def interrupt(self, plan):
        """Run the surgery with the sidecar step failing, as a disk-full would."""
        import surgery as surgery_mod

        original = surgery_mod.slice_sidecar
        surgery_mod.slice_sidecar = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk full"))
        try:
            with self.assertRaises(RuntimeError):
                surgery_mod.apply_surgery(plan)
        finally:
            surgery_mod.slice_sidecar = original

    def test_a_failure_partway_leaves_no_destination(self):
        # The old version created the destination and wrote into it directly, so
        # an interruption left a directory that looks like a checkpoint and is a
        # prefix of one.
        plan = self.plan()
        self.interrupt(plan)
        self.assertFalse(self.dst.exists())
        leftovers = [
            p for p in self.dst.parent.iterdir() if p.name.startswith(f".{self.dst.name}.tmp.")
        ]
        self.assertEqual(len(leftovers), 1, "the temporary directory should be obviously temporary")

    def test_resuming_matches_a_clean_build_file_for_file(self):
        from surgery import apply_surgery

        plan = self.plan()
        self.interrupt(plan)
        resumed = {e["path"]: e["sha256"] for e in apply_surgery(plan)["files"]}

        clean = preflight(self.src, self.root / "clean", self.keep)
        fresh = {e["path"]: e["sha256"] for e in apply_surgery(clean)["files"]}

        # Every file the manifest lists, hashed. The manifest itself is not in
        # its own list — a file cannot contain its own hash — which is also why
        # the elapsed time it records cannot make two builds differ.
        self.assertNotIn("pruning_manifest.json", fresh)
        self.assertEqual(resumed, fresh)
        self.assertGreater(len(fresh), len(plan.shards))

    def test_a_changed_plan_does_not_reuse_the_old_shards(self):
        from safetensors.torch import load_file
        from surgery import apply_surgery

        plan = self.plan()
        self.interrupt(plan)

        other = preflight(self.src, self.dst, {str(l): [1, 3, 5, 7] for l in LAYERS})
        self.assertNotEqual(plan.hash(), other.hash())
        manifest = apply_surgery(other)

        sidecar = load_file(str(self.dst / SIDECAR_FILE))
        got = [float(x) for x in sidecar[f"model.layers.{LAYERS[0]}.{SIDECAR_SUFFIXES[0]}"]]
        self.assertEqual(got, [float(e + LAYERS[0] * 100) for e in [1, 3, 5, 7]])
        self.assertEqual(manifest["selection"]["layers"][str(LAYERS[0])], [1, 3, 5, 7])

    def test_a_truncated_shard_is_rebuilt_rather_than_trusted(self):
        # Trusting the journal alone would accept a shard that was half-written
        # when the process died.
        from surgery import ShardJournal, apply_surgery

        plan = self.plan()
        self.interrupt(plan)
        temp = next(p for p in self.dst.parent.iterdir() if p.name.startswith(f".{self.dst.name}.tmp."))
        victim = temp / plan.shards[0]
        victim.write_bytes(victim.read_bytes()[:-32])

        journal = ShardJournal(temp / "shard-journal.jsonl", plan.hash())
        self.assertFalse(journal.completed(plan.shards[0], temp))

        apply_surgery(plan)
        from safetensors.torch import load_file

        out = load_file(str(self.dst / plan.shards[0]))
        self.assertEqual(out[f"model.layers.{LAYERS[0]}.moe.expert_bias"].shape[0], len(KEEP))


if __name__ == "__main__":
    unittest.main()
