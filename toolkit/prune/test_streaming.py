"""The streaming profiler, checked against the model's own forward pass.

The profiler reimplements the body of `MotifModel.forward` so it can run one
layer at a time over a resident shard instead of one shard at a time over every
layer — the difference between reading 173 GB once and reading it for every
chunk. That reimplementation is the risk: a forward pass that has quietly
diverged from the model's produces confident statistics about a model nobody is
serving, and nothing downstream can tell.

So the central test builds a tiny Motif with random weights, runs both paths,
and requires them to agree. Everything else here is about the statistics being
the numbers they claim to be.

These need torch. In CI `MOTIF_REQUIRE_TORCH=1` turns the skip into a failure,
because this is the file that decides whether the profiler is measuring
anything real.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from _requires import require, require_reference
from attention import naive_attention, registered_as_flash_attention_2

MODELING = Path(__file__).resolve().parent.parent / "ref"

_ATTENTION = []


def _hold_attention() -> None:
    ctx = registered_as_flash_attention_2(naive_attention)
    ctx.__enter__()
    _ATTENTION.append(ctx)


def _release_attention() -> None:
    while _ATTENTION:
        _ATTENTION.pop().__exit__(None, None, None)


def tiny_config(configuration):
    """A Motif small enough to run on a laptop and structurally identical.

    Every architectural switch the real checkpoint sets is set here: mHC on,
    GDLA attention, PolyNorm activation, sigmoid routing with normalisation and
    a route scale, a shared expert, and two dense layers before the MoE ones.
    A tiny model with the switches off would test a different program.
    """
    return configuration.MotifConfig(
        hidden_size=64,
        intermediate_size=128,
        moe_intermediate_size=32,
        num_hidden_layers=4,
        num_attention_heads=4,
        num_key_value_heads=2,
        # GDLA splits heads into signal and noise groups; with the default of
        # zero the split divides by zero. The real checkpoint uses 80 and 16.
        num_noise_heads=2,
        # The real checkpoint sets this; GDLA V1 is not implemented at all.
        diff_v2=True,
        elementwise_attn_output_gate=True,
        use_sliding_window=True,
        sliding_window=8,
        sliding_window_pattern="interleave",
        sliding_window_period=2,
        head_dim=16,
        v_head_dim=16,
        qk_rope_head_dim=8,
        q_lora_rank=32,
        kv_lora_rank=32,
        num_experts=8,
        experts_top_k=2,
        num_shared_experts=1,
        n_dense_first_layers=2,
        interleave_moe_layer_step=1,
        vocab_size=256,
        max_position_embeddings=128,
        attention_cls="gdla",
        hidden_act="poly_norm",
        score_func="sigmoid",
        route_norm=True,
        route_scale=2.0,
        mhc_enabled=True,
        mhc_expansion_rate=4,
        mhc_sinkhorn_iters=4,
        load_balance_coeff=0.0001,
        num_nextn_predict_layers=0,
        rms_norm_eps=1e-5,
        dtype="float32",
    )


def build_pair(test):
    """A reference model and a streaming one holding identical expert weights.

    Identical rather than merely similar: random NVFP4 bytes are dequantised
    once, the result is written into the reference model's dense parameters, and
    the packed bytes go to the streaming one. Any disagreement afterwards is the
    forward pass, not the quantisation.
    """
    require("torch", test)
    require_reference(MODELING, test)
    import torch

    import profile_routing as profile_mod
    from nvfp4 import GROUP_SIZE, dequantize_expert
    from streaming import LayerExpertWeights, Recorder, RoutingStats, make_streaming_experts

    modeling, configuration = profile_mod.load_modeling(MODELING)
    config = tiny_config(configuration)
    # The readable attention, registered under the name the model demands. This
    # file tests the layer-major loop, not the kernel; `test_attention.py` is
    # where flash is checked against this same reference, on a GPU.
    config._attn_implementation = "flash_attention_2"

    # Entered here and never exited: the registry entry is read on every
    # forward, not just at construction, and every test in this file runs one.
    test.addCleanup(_release_attention)
    _hold_attention()
    torch.manual_seed(11)
    reference = modeling.MotifModel(config).eval().float()

    moe_layers = [
        i
        for i in range(config.num_hidden_layers)
        if i >= config.n_dense_first_layers and (i + 1) % config.interleave_moe_layer_step == 0
    ]

    packed_by_layer: dict[int, LayerExpertWeights] = {}
    for layer_idx in moe_layers:
        experts = reference.layers[layer_idx].moe.experts
        out_gu, in_gu = experts.gate_up_proj.shape[1], experts.gate_up_proj.shape[2]
        out_dn, in_dn = experts.down_proj.shape[1], experts.down_proj.shape[2]

        gu_packed = torch.randint(0, 256, (config.num_experts, out_gu, in_gu // 2), dtype=torch.uint8)
        gu_scale = (torch.rand(config.num_experts, out_gu, in_gu // GROUP_SIZE) * 0.02 + 0.01).to(
            torch.float8_e4m3fn
        )
        gu_global = torch.full((config.num_experts,), 0.5, dtype=torch.float32)
        dn_packed = torch.randint(0, 256, (config.num_experts, out_dn, in_dn // 2), dtype=torch.uint8)
        dn_scale = (torch.rand(config.num_experts, out_dn, in_dn // GROUP_SIZE) * 0.02 + 0.01).to(
            torch.float8_e4m3fn
        )
        dn_global = torch.full((config.num_experts,), 0.5, dtype=torch.float32)

        with torch.no_grad():
            for e in range(config.num_experts):
                experts.gate_up_proj[e] = dequantize_expert(
                    gu_packed[e], gu_scale[e], gu_global[e], dtype=torch.float32
                )
                experts.down_proj[e] = dequantize_expert(
                    dn_packed[e], dn_scale[e], dn_global[e], dtype=torch.float32
                )
        packed_by_layer[layer_idx] = LayerExpertWeights(
            gu_packed, gu_scale, gu_global, dn_packed, dn_scale, dn_global
        )

    # The streaming model: same weights everywhere, expert blocks replaced.
    original = modeling.MotifExperts
    modeling.MotifExperts = make_streaming_experts(original)
    try:
        torch.manual_seed(11)
        streaming = modeling.MotifModel(config).eval().float()
    finally:
        modeling.MotifExperts = original

    ref_state = reference.state_dict()
    missing = streaming.load_state_dict(
        {k: v for k, v in ref_state.items() if k in streaming.state_dict()}, strict=False
    )
    del missing

    stats = RoutingStats(moe_layers, config.num_experts)
    Recorder(stats).instrument(streaming, moe_layers)
    for layer_idx in moe_layers:
        streaming.layers[layer_idx].moe.experts.packed = packed_by_layer[layer_idx]

    return modeling, config, reference, streaming, stats, moe_layers


def layer_major(streaming, config, sequences):
    """The profiler's loop, driven directly."""
    import torch

    model = streaming
    with torch.no_grad():
        hidden_chunks = []
        position_chunks = []
        for ids in sequences:
            embeds = model.embed_tokens(ids.unsqueeze(0))
            cache_position = torch.arange(embeds.shape[1])
            position_ids = cache_position.unsqueeze(0)
            position_embeddings = model.rotary_emb(embeds, position_ids)
            hidden = embeds.unsqueeze(2).expand(-1, -1, config.mhc_expansion_rate, -1).contiguous()
            hidden_chunks.append(hidden)
            position_chunks.append((position_ids, position_embeddings, cache_position))

        for layer in model.layers:
            for i, hidden in enumerate(hidden_chunks):
                position_ids, position_embeddings, cache_position = position_chunks[i]
                out = layer(
                    hidden,
                    attention_mask=None,
                    position_ids=position_ids,
                    past_key_value=None,
                    use_cache=False,
                    cache_position=cache_position,
                    position_embeddings=position_embeddings,
                )
                hidden_chunks[i] = out[0]
        return [h.mean(dim=2) for h in hidden_chunks]


class TestEquivalence(unittest.TestCase):
    def test_layer_major_matches_the_models_own_forward(self):
        """The test the whole backend rests on."""
        modeling, config, reference, streaming, stats, moe_layers = build_pair(self)
        import torch

        torch.manual_seed(3)
        sequences = [torch.randint(0, config.vocab_size, (24,)) for _ in range(2)]

        with torch.no_grad():
            expected = [
                reference(input_ids=ids.unsqueeze(0), use_cache=False).last_hidden_state
                for ids in sequences
            ]
        got = layer_major(streaming, config, sequences)

        for i, (a, b) in enumerate(zip(expected, got)):
            # `MotifModel.forward` applies the final norm; the profiler stops
            # before it, since nothing downstream reads the last hidden state.
            normed = reference.norm(b)
            torch.testing.assert_close(normed, a, rtol=2e-5, atol=2e-5, msg=f"sequence {i}")

    def test_chunking_does_not_change_the_result(self):
        # The shard size is a memory-versus-IO knob, not a modelling choice.
        modeling, config, reference, streaming, stats, moe_layers = build_pair(self)
        import torch

        torch.manual_seed(5)
        sequences = [torch.randint(0, config.vocab_size, (20,)) for _ in range(3)]
        together = layer_major(streaming, config, sequences)
        apart = [layer_major(streaming, config, [s])[0] for s in sequences]
        for a, b in zip(together, apart):
            torch.testing.assert_close(a, b, rtol=0, atol=0)


class TestStatistics(unittest.TestCase):
    def setUp(self):
        self.modeling, self.config, self.reference, self.streaming, self.stats, self.moe_layers = (
            build_pair(self)
        )

    def test_counts_satisfy_the_top_k_invariant(self):
        # Every token routes to exactly top_k experts, so a layer's counts must
        # sum to tokens x k. This is the check that catches a dropped hook or a
        # double-counted batch before it becomes a plausible ranking.
        import torch

        torch.manual_seed(7)
        sequences = [torch.randint(0, self.config.vocab_size, (16,)) for _ in range(2)]
        layer_major(self.streaming, self.config, sequences)

        tokens = sum(int(s.numel()) for s in sequences)
        counts = self.stats.data["counts"]
        for row, layer in enumerate(self.moe_layers):
            self.assertEqual(
                int(counts[row].sum()),
                tokens * self.config.experts_top_k,
                f"layer {layer}",
            )

    def test_every_statistic_is_finite_and_non_negative(self):
        import torch

        torch.manual_seed(9)
        layer_major(self.streaming, self.config, [torch.randint(0, self.config.vocab_size, (16,))])
        for name, tensor in self.stats.data.items():
            self.assertTrue(bool(torch.isfinite(tensor.double()).all()), name)
            self.assertTrue(bool((tensor >= 0).all()), name)

    def test_prob_mass_covers_every_expert(self):
        # The only statistic that sees experts a token did *not* route to, which
        # is what makes it a different signal from the other five.
        import torch

        torch.manual_seed(13)
        layer_major(self.streaming, self.config, [torch.randint(0, self.config.vocab_size, (16,))])
        prob_mass = self.stats.data["prob_mass"]
        self.assertTrue(bool((prob_mass > 0).all()), "sigmoid is strictly positive everywhere")

    def test_reap_is_bounded_by_gate_times_norm(self):
        # `reap_sum = sum(g * ||f||)`, so by Cauchy-Schwarz it cannot exceed
        # `sqrt(sum(g^2) * sum(||f||^2))`. A statistic collected off the wrong
        # tensor — after the gate multiply, say — breaks this.
        import torch

        torch.manual_seed(17)
        layer_major(self.streaming, self.config, [torch.randint(0, self.config.vocab_size, (24,))])
        reap = self.stats.data["reap_sum"].double()
        norm_sq = self.stats.data["norm_sq_sum"].double()
        norm = self.stats.data["norm_sum"].double()
        counts = self.stats.data["counts"].double().clamp(min=1)
        # A looser but sufficient bound: mean gate weight is at most route_scale.
        self.assertTrue(bool((reap <= norm * self.config.route_scale + 1e-6).all()))
        self.assertTrue(bool((norm * norm <= norm_sq * counts + 1e-6).all()))

    def test_accumulators_are_float64(self):
        # Three million tokens in float32 loses every small contribution, and
        # the small contributions are the experts near the cut.
        import torch

        self.assertEqual(self.stats.data["counts"].dtype, torch.int64)
        for name, tensor in self.stats.data.items():
            if name != "counts":
                self.assertEqual(tensor.dtype, torch.float64, name)


class TestWhatIsNotLoaded(unittest.TestCase):
    def test_the_lm_head_and_mtp_head_are_excluded(self):
        from streaming import is_lm_head, is_mtp, is_streamed

        self.assertTrue(is_lm_head("lm_head.weight"))
        self.assertTrue(is_mtp("model.mtp_layers.0.self_attn.wo.weight"))
        self.assertFalse(is_mtp("model.layers.3.self_attn.wo.weight"))

    def test_only_the_packed_expert_tensors_stream(self):
        from streaming import is_streamed

        for name in (
            "model.layers.3.moe.experts.gate_up_proj",
            "model.layers.3.moe.experts.gate_up_proj_weight_scale",
            "model.layers.3.moe.experts.down_proj_weight_scale_2",
        ):
            self.assertTrue(is_streamed(name), name)
        for name in (
            "model.layers.3.moe.router.gate.weight",
            "model.layers.3.moe.expert_bias",
            "model.layers.3.moe.experts.act_fn.weight",
            "model.layers.3.moe.shared_experts.up_proj.weight",
            "model.layers.3.self_attn.wo.weight",
        ):
            self.assertFalse(is_streamed(name), name)


if __name__ == "__main__":
    unittest.main()
