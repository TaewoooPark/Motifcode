#!/usr/bin/env python3
"""A routing profiler that never holds the whole checkpoint.

The problem this exists to solve: routing statistics require a real forward
pass, the checkpoint is 187 GB packed, and the machine has 121 GB of unified
memory. The previous profiler asked `AutoModelForCausalLM.from_pretrained` with
`device_map="auto"` and an offload folder to sort that out, which does not work
here for three separate reasons — the NVFP4 repository ships no
`modeling_motif.py` for `trust_remote_code` to find, packed expert tensors are
not something stock Transformers can execute, and offloading stages the whole
checkpoint rather than streaming it.

What does work follows from one observation about the arithmetic. Of the 187 GB,
173 GB is routed experts and 14 GB is everything else: attention, the mHC
blocks, layer norms, the router gates and the shared experts, all stored as
plain BF16. So the small part stays resident and the large part streams, one
layer at a time, dequantised per expert as the tokens that routed to it arrive.

That leaves the question of loop order, and it is the whole performance story.
Running the model chunk by chunk means re-reading all 173 GB for every chunk.
Running it layer by layer — hold the hidden states for a whole shard, apply one
layer to all of them, move on — reads each layer's weights exactly once. The
cost is memory for the hidden states, which with mHC is `[tokens, 4, 4096]`, and
that is what `--shard-tokens` trades against I/O.

The layer-major loop is a reimplementation of `MotifModel.forward`'s body, so
`verify_equivalence` exists: it runs both on a tiny synthetic model and requires
bit-comparable output. A profiler whose forward pass has quietly diverged from
the model's produces plausible statistics about a model nobody is serving.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from nvfp4 import dequantize_expert
from stats import STAT_NAMES

# Suffixes of the tensors that are NVFP4-packed and streamed rather than resident.
STREAMED = (
    "moe.experts.gate_up_proj",
    "moe.experts.gate_up_proj_weight_scale",
    "moe.experts.gate_up_proj_weight_scale_2",
    "moe.experts.down_proj",
    "moe.experts.down_proj_weight_scale",
    "moe.experts.down_proj_weight_scale_2",
)


def is_streamed(name: str) -> bool:
    return any(name.endswith(s) for s in STREAMED)


def is_mtp(name: str) -> bool:
    """The multi-token-prediction head plays no part in routing."""
    return name.startswith("model.mtp_layers") or name.startswith("mtp")


def is_lm_head(name: str) -> bool:
    """220,160 logits per token, needed by nothing here.

    A 4,096-token batch of BF16 logits is 1.8 GB, and the routing statistics do
    not read them. The old profiler ran a full `CausalLM` forward and paid for
    them on every batch.
    """
    return name.startswith("lm_head")


# ------------------------------------------------------------------ #
# accumulators                                                        #
# ------------------------------------------------------------------ #


class RoutingStats:
    """Per-layer, per-expert accumulators in float64.

    Float64 because the sums run to three million tokens. In float32, adding a
    contribution of 1e-3 to a running total of 1e7 is a no-op — and the experts
    whose contributions are small are exactly the ones sitting near the cut,
    so the precision loss lands precisely where the decision is made.
    """

    def __init__(self, layers: list[int], num_experts: int):
        import torch  # noqa: PLC0415

        self.layers = list(layers)
        self.index = {layer: i for i, layer in enumerate(self.layers)}
        self.num_experts = num_experts
        shape = (len(self.layers), num_experts)
        self.data = {
            "counts": torch.zeros(shape, dtype=torch.int64),
            **{
                name: torch.zeros(shape, dtype=torch.float64)
                for name in STAT_NAMES
                if name != "counts"
            },
        }
        self.total_tokens = 0

    def add(self, layer: int, name: str, values) -> None:
        row = self.index[layer]
        self.data[name][row] += values.to(self.data[name].dtype).cpu()

    def add_scalar(self, layer: int, name: str, expert: int, value: float) -> None:
        self.data[name][self.index[layer]][expert] += value

    def to_numpy(self) -> dict:
        return {name: tensor.numpy() for name, tensor in self.data.items()}


# ------------------------------------------------------------------ #
# weight streaming                                                    #
# ------------------------------------------------------------------ #


@dataclass
class LayerExpertWeights:
    """One MoE layer's packed expert weights, resident for the length of a pass."""

    gate_up: object
    gate_up_scale: object
    gate_up_global: object
    down: object
    down_scale: object
    down_global: object

    @property
    def bytes(self) -> int:
        return sum(
            t.numel() * t.element_size()
            for t in (
                self.gate_up,
                self.gate_up_scale,
                self.gate_up_global,
                self.down,
                self.down_scale,
                self.down_global,
            )
        )


class CheckpointReader:
    """Reads tensors out of a sharded safetensors checkpoint, by name."""

    def __init__(self, root: Path):
        self.root = Path(root)
        index = json.loads((self.root / "model.safetensors.index.json").read_text())
        self.weight_map: dict[str, str] = index["weight_map"]
        self.metadata = index.get("metadata", {})
        self._open: dict[tuple[str, str], object] = {}

    def _handle(self, shard: str, device: str):
        from safetensors import safe_open  # noqa: PLC0415

        key = (shard, device)
        if key not in self._open:
            self._open[key] = safe_open(str(self.root / shard), framework="pt", device=device)
        return self._open[key]

    def get(self, name: str, device="cpu"):
        """Read one tensor, landing it on `device` without a host round-trip.

        The obvious spelling — `get_tensor(name).to(device)` — is 13x slower
        here, and the reason is not obvious at all. `get_tensor` returns a view
        onto the mmap'd file, so it costs nothing and looks free; the `.to()`
        then copies out of a pageable, not-yet-resident buffer, and every page
        faults in on demand. Measured on this checkpoint: 0.12 GB/s that way
        against 1.53 GB/s when safetensors is told the destination up front.

        Across 51 layers of streamed experts that is the difference between a
        four-minute pass and a half-hour one, and it never shows up as an
        error — only as a profiler that seems inexplicably slow.
        """
        shard = self.weight_map[name]
        return self._handle(shard, str(device)).get_tensor(name)

    def names(self) -> list[str]:
        return list(self.weight_map)

    def close(self) -> None:
        self._open.clear()

    def layer_experts(self, layer: int, device) -> LayerExpertWeights:
        base = f"model.layers.{layer}.moe.experts"
        return LayerExpertWeights(
            gate_up=self.get(f"{base}.gate_up_proj", device),
            gate_up_scale=self.get(f"{base}.gate_up_proj_weight_scale", device),
            gate_up_global=self.get(f"{base}.gate_up_proj_weight_scale_2", device),
            down=self.get(f"{base}.down_proj", device),
            down_scale=self.get(f"{base}.down_proj_weight_scale", device),
            down_global=self.get(f"{base}.down_proj_weight_scale_2", device),
        )


# ------------------------------------------------------------------ #
# the expert block                                                    #
# ------------------------------------------------------------------ #


def make_streaming_experts(base_class):
    """Build a `MotifExperts` subclass that dequantises on demand and records.

    Subclassing the vendor's own class rather than reimplementing it: the
    activation is a per-expert `GroupedPolyNorm`, the output is weighted *after*
    the expert rather than before, and both details decide what `reap_sum`
    means. Rewriting either from the paper would be a different model.
    """
    import torch  # noqa: PLC0415
    import torch.nn.functional as F  # noqa: PLC0415

    class StreamingExperts(base_class):
        def __init__(self, config):
            # Skip the parent's allocation: `gate_up_proj` alone is 8 GB per
            # layer dequantised, and there are 51 layers. Everything else the
            # parent builds — crucially the per-expert activation — is kept.
            torch.nn.Module.__init__(self)
            self.num_experts = config.num_experts
            self.hidden_size = config.hidden_size
            self.intermediate_dim = getattr(
                config, "moe_intermediate_size", config.intermediate_size
            )
            self.act_fn = _build_act_fn(base_class, config)

            # Empty tensors rather than `None`, and plain attributes rather
            # than parameters. `post_init` runs `nn.init.trunc_normal_` over
            # whatever is here, which needs a tensor; and keeping them out of
            # `state_dict` means a checkpoint load neither expects them nor
            # fails on their shape.
            self.gate_up_proj = torch.empty(0)
            self.down_proj = torch.empty(0)
            # Filled in by the profiler before each layer runs.
            self.packed: LayerExpertWeights | None = None
            self.recorder = None
            self.layer_idx: int | None = None

        def forward(self, hidden_states, top_k_index, top_k_weights):
            if self.packed is None:
                raise RuntimeError("expert weights were not staged for this layer")
            final = torch.zeros_like(hidden_states, dtype=torch.float32)
            expert_mask = F.one_hot(top_k_index, num_classes=self.num_experts).permute(2, 1, 0)

            for expert_idx in range(self.num_experts):
                top_k_pos, token_idx = torch.where(expert_mask[expert_idx])
                if token_idx.shape[0] == 0:
                    continue

                gate_up_w = dequantize_expert(
                    self.packed.gate_up[expert_idx],
                    self.packed.gate_up_scale[expert_idx],
                    self.packed.gate_up_global[expert_idx],
                    dtype=hidden_states.dtype,
                )
                down_w = dequantize_expert(
                    self.packed.down[expert_idx],
                    self.packed.down_scale[expert_idx],
                    self.packed.down_global[expert_idx],
                    dtype=hidden_states.dtype,
                )

                current_state = hidden_states[token_idx]
                gate_up = current_state @ gate_up_w.T
                # `f_e(x)`: the expert's output *before* the routing weight is
                # applied. REAP is `g_e(x) * ||f_e(x)||`, so measuring after the
                # multiply would square the gate weight into the statistic.
                expert_out = self._apply_gate(gate_up, expert_idx) @ down_w.T

                weights = top_k_weights[token_idx, top_k_pos]
                if self.recorder is not None:
                    self.recorder.observe(self.layer_idx, expert_idx, expert_out, weights)

                final.index_add_(0, token_idx, expert_out.float() * weights.float().unsqueeze(-1))
                del gate_up_w, down_w, gate_up, expert_out

            return final

    return StreamingExperts


def _build_act_fn(base_class, config):
    """The same activation the vendor's class would have built."""
    import importlib  # noqa: PLC0415

    module = importlib.import_module(base_class.__module__)
    if config.hidden_act == "poly_norm":
        return module.GroupedPolyNorm(
            config.num_experts,
            sigmoid_weight=getattr(config, "polynorm_sigmoid_weight", True),
            bias_clamp=getattr(config, "polynorm_bias_clamp", None),
            output_scale=float(getattr(config, "polynorm_output_scale", 1.0)),
            hidden_clamp=getattr(config, "hidden_clamp", None),
        )
    from transformers.activations import ACT2FN  # noqa: PLC0415

    return ACT2FN[config.hidden_act]


class Recorder:
    """Turns one expert's output into the six statistics."""

    def __init__(self, stats: RoutingStats):
        self.stats = stats

    def observe(self, layer: int, expert: int, expert_out, weights) -> None:
        import torch  # noqa: PLC0415

        with torch.no_grad():
            norms = expert_out.float().norm(dim=-1)
            w = weights.float()
            self.stats.add_scalar(layer, "counts", expert, int(norms.numel()))
            self.stats.add_scalar(layer, "gate_sum", expert, float(w.sum()))
            self.stats.add_scalar(layer, "norm_sum", expert, float(norms.sum()))
            self.stats.add_scalar(layer, "norm_sq_sum", expert, float((norms * norms).sum()))
            self.stats.add_scalar(layer, "reap_sum", expert, float((w * norms).sum()))

    def instrument(self, model, moe_layers) -> None:
        """Attach the router hook and the expert recorder to every MoE layer.

        One function, used by the profiler and by the equivalence test, so a
        statistic cannot be collected in one and silently absent in the other —
        which is how a test ends up asserting something nothing produced.
        """
        import torch  # noqa: PLC0415

        for layer_idx in moe_layers:
            moe = model.layers[layer_idx].moe
            moe.experts.recorder = self
            moe.experts.layer_idx = layer_idx

            def hook(_module, args, _output, layer=layer_idx, router=moe.router, rec=self):
                with torch.no_grad():
                    scores = torch.sigmoid(
                        torch.nn.functional.linear(
                            args[0].to(torch.float32), router.gate.weight.to(torch.float32)
                        )
                    )
                    rec.observe_router(layer, scores)

            moe.router.register_forward_hook(hook)

    def observe_router(self, layer: int, scores) -> None:
        """`prob_mass`: sigmoid over every expert, not just the selected ones.

        The only statistic here that sees the experts a token did *not* route
        to, which is what makes it a different signal from the rest.
        """
        import torch  # noqa: PLC0415

        with torch.no_grad():
            self.stats.add(layer, "prob_mass", scores.sum(dim=0).double())
