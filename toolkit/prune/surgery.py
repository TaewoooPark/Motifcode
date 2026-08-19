#!/usr/bin/env python3
"""Expert pruning surgery for Motif-3.

Slices the routed-expert dimension of an NVFP4 Motif-3 checkpoint down to a
chosen keep-list, producing a smaller model that still runs through the stock
NVFP4 path — no new kernels, no new quantisation format.

Why this works
--------------
Roughly 98% of Motif-3's 314B parameters are routed experts: 51 MoE layers x 384
experts x (3 x 4096 x 1280). Everything else — attention, the dense first
layers, shared experts, mHC, the MTP head — is a few billion parameters. So the
size problem is entirely an expert-bank problem, and dropping experts is the
only lever that moves it without inventing a new numeric format.

Ten tensors per MoE layer carry the expert dimension. Their real shapes were
read from the checkpoint's safetensors headers:

    moe.experts.gate_up_proj                U8       [384, 4096, 1280]
    moe.experts.gate_up_proj_weight_scale   F8_E4M3  [384, 4096,  160]
    moe.experts.gate_up_proj_weight_scale_2 F32      [384]
    moe.experts.down_proj                   U8       [384, 4096,  640]
    moe.experts.down_proj_weight_scale      F8_E4M3  [384, 4096,   80]
    moe.experts.down_proj_weight_scale_2    F32      [384]
    moe.experts.act_fn.weight                        [384, 3]
    moe.experts.act_fn.bias                          [384, 1]
    moe.router.gate.weight                           [384, 4096]
    moe.expert_bias                                  [384]

All ten lead with 384, including the per-expert global scale, so a single
keep-list slices every one of them along axis 0. Shared experts, attention, mHC,
layernorms and the MTP head are untouched.

Status
------
Written and unit-tested against a synthetic checkpoint; not yet run against the
real weights, which needs a machine that can hold them. The keep-list itself
comes from `profile.py` and is chosen by domain-contrastive routing statistics —
frequency alone will not do, because Motif-3 was trained with explicit load
balancing and therefore has no rarely-used experts to find.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path

EXPERT_DIM_SUFFIXES = (
    "moe.experts.gate_up_proj",
    "moe.experts.gate_up_proj_weight_scale",
    "moe.experts.gate_up_proj_weight_scale_2",
    "moe.experts.down_proj",
    "moe.experts.down_proj_weight_scale",
    "moe.experts.down_proj_weight_scale_2",
    "moe.experts.act_fn.weight",
    "moe.experts.act_fn.bias",
    "moe.router.gate.weight",
    "moe.expert_bias",
)

LAYER_RE = re.compile(r"model\.layers\.(\d+)\.")


def is_expert_tensor(name: str) -> bool:
    """True when `name` carries the routed-expert dimension on axis 0."""
    return any(name.endswith(suffix) for suffix in EXPERT_DIM_SUFFIXES)


def layer_of(name: str) -> int | None:
    m = LAYER_RE.search(name)
    return int(m.group(1)) if m else None


@dataclass
class Plan:
    """What surgery would do, without doing it."""

    total_tensors: int
    expert_tensors: int
    layers: list[int]
    keep: int
    original: int

    @property
    def ratio(self) -> float:
        return self.keep / self.original

    def report(self) -> str:
        lines = [
            f"experts      {self.original} -> {self.keep}  ({self.ratio:.1%} kept)",
            f"MoE layers   {len(self.layers)}",
            f"tensors      {self.expert_tensors} sliced of {self.total_tensors} total",
            f"slices       {self.expert_tensors} (axis 0, one shared keep-list)",
        ]
        per_layer = self.expert_tensors / len(self.layers) if self.layers else 0
        lines.append(f"per layer    {per_layer:.0f} tensors")
        if per_layer and abs(per_layer - len(EXPERT_DIM_SUFFIXES)) > 1e-9:
            lines.append(
                f"WARNING      expected {len(EXPERT_DIM_SUFFIXES)} per layer; "
                "the checkpoint layout may have changed"
            )
        return "\n".join(lines)


def plan_from_index(index_path: Path, keep: list[int], original: int) -> Plan:
    """Build a plan from `model.safetensors.index.json` alone.

    Runs anywhere — the index is a few hundred kilobytes — which is the point:
    the surgery can be designed and reviewed long before there is a machine that
    can load the weights.
    """
    index = json.loads(index_path.read_text())
    names = list(index["weight_map"].keys())
    expert_names = [n for n in names if is_expert_tensor(n)]
    layers = sorted({l for n in expert_names if (l := layer_of(n)) is not None})
    return Plan(
        total_tensors=len(names),
        expert_tensors=len(expert_names),
        layers=layers,
        keep=len(keep),
        original=original,
    )


def validate_keep(keep: list[int], original: int) -> None:
    if not keep:
        raise ValueError("keep-list is empty")
    if len(set(keep)) != len(keep):
        raise ValueError("keep-list has duplicates")
    if min(keep) < 0 or max(keep) >= original:
        raise ValueError(f"keep-list out of range for {original} experts")
    if keep != sorted(keep):
        raise ValueError(
            "keep-list must be sorted ascending: expert order is preserved so the "
            "router's remaining logits keep their relative meaning"
        )


def slice_state_dict(tensors: dict, keep: list[int]):
    """Slice every expert-dimension tensor. Torch only; imported lazily."""
    import torch  # noqa: PLC0415

    idx = torch.tensor(keep, dtype=torch.long)
    out = {}
    for name, t in tensors.items():
        if is_expert_tensor(name):
            if t.shape[0] < max(keep) + 1:
                raise ValueError(f"{name}: axis 0 is {t.shape[0]}, keep-list needs {max(keep)+1}")
            out[name] = t.index_select(0, idx).contiguous()
        else:
            out[name] = t
    return out


def rewrite_config(config: dict, keep: int) -> dict:
    """Point the model config at the smaller expert bank.

    `experts_top_k` is deliberately left alone: pruning changes how many experts
    exist, not how many are consulted per token, so activated parameters and
    therefore decode speed are unchanged.
    """
    out = dict(config)
    out["num_experts"] = keep
    out.setdefault("motifcode", {})
    out["motifcode"] = {
        **out.get("motifcode", {}),
        "pruned_from": config.get("num_experts"),
        "pruned_to": keep,
    }
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--index", type=Path, required=True, help="model.safetensors.index.json")
    ap.add_argument("--keep", type=Path, help="JSON array of expert indices to keep")
    ap.add_argument("--keep-count", type=int, help="dry-run with the first N experts instead of a real list")
    ap.add_argument("--experts", type=int, default=384, help="expert count in the source checkpoint")
    ap.add_argument("--dry-run", action="store_true", default=True)
    args = ap.parse_args()

    if args.keep:
        keep = json.loads(args.keep.read_text())
    elif args.keep_count:
        keep = list(range(args.keep_count))
    else:
        ap.error("one of --keep or --keep-count is required")

    validate_keep(keep, args.experts)
    plan = plan_from_index(args.index, keep, args.experts)
    print(plan.report())
    print("\ndry run only — no weights were read or written")


if __name__ == "__main__":
    main()
