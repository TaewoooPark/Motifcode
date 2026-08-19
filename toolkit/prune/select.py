#!/usr/bin/env python3
"""Choose which experts to keep, from two routing profiles.

Takes a target profile (agentic coding) and a reference profile (general chat,
reasoning, Korean) and ranks experts by how much more the target needs them.

Why contrastive
---------------
Motif-3 was trained with explicit load balancing, so raw usage is close to
uniform by construction and ranking by it finds nothing. What survives that
flattening is the *difference* between corpora: an expert that fires
disproportionately on coding is one the coding model needs, even when both
absolute rates sit near 1/384.

Three criteria, deliberately
----------------------------
The literature is blunt about this: the winning selection strategy flipped
between the two model families that have been studied, so a recipe validated
elsewhere cannot be assumed to transfer. Produce all three, prune all three,
measure all three. Picking one on taste is how you spend a rental on a wrong
answer.

  `count`   contrastive selection frequency. Includes the load-balancing bias,
            since selection is `topk(scores + expert_bias)`.
  `mass`    contrastive gate weight. The bias does not enter the returned
            scores, so this reflects how hard the model leans on an expert once
            it has picked it.
  `blend`   geometric mean of the two, for when they disagree and neither is
            obviously right.

Per-layer, not global
---------------------
Allocation is per layer by default. A global ranking can empty one layer's
expert bank while leaving another untouched, and a layer with two surviving
experts is a different model, not a smaller one. `--global-alloc` exists so the
alternative can be measured rather than assumed away.

Output
------
`{"criterion": ..., "keep_ratio": ..., "layers": {"3": [sorted expert ids], ...}}`

`surgery.py` consumes it. Ids are sorted ascending within each layer so the
surviving router logits keep their relative order.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

# A floor for the reference rate, so an expert the reference corpus never
# touched does not produce a division by zero and an infinite score. Set it
# below any plausible real rate: with 384 experts and top-8, uniform usage is
# about 2e-2, so 1e-9 is far under the noise.
EPS = 1e-9


def load_profile(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("layers", "num_experts", "tokens"):
        if key not in data:
            raise ValueError(f"{path}: profile is missing '{key}'")
    return data


def _normalise(values: list[float], total: float) -> list[float]:
    """Rate per token, so corpora of different sizes compare."""
    if total <= 0:
        return [0.0] * len(values)
    return [v / total for v in values]


def score_layer(
    target: dict, reference: dict, layer: str, criterion: str, num_experts: int
) -> list[float]:
    t = target["layers"].get(layer)
    r = reference["layers"].get(layer)
    if t is None:
        raise ValueError(f"target profile has no layer {layer}")
    if r is None:
        # A layer the reference never reached tells us nothing contrastive;
        # fall back to raw target usage rather than inventing a ratio.
        r = {"count": [0.0] * num_experts, "mass": [0.0] * num_experts}

    def ratio(field: str) -> list[float]:
        tv = _normalise([float(x) for x in t[field]], float(target["tokens"]))
        rv = _normalise([float(x) for x in r[field]], float(reference["tokens"]))
        return [tvi / (rvi + EPS) for tvi, rvi in zip(tv, rv)]

    if criterion == "count":
        return ratio("count")
    if criterion == "mass":
        return ratio("mass")
    if criterion == "blend":
        c = ratio("count")
        m = ratio("mass")
        # Geometric mean: a criterion that is high on one axis and near zero on
        # the other should not win on the average of the two.
        return [math.sqrt(max(a, 0.0) * max(b, 0.0)) for a, b in zip(c, m)]
    raise ValueError(f"unknown criterion: {criterion}")


def select_per_layer(
    target: dict, reference: dict, criterion: str, keep_ratio: float
) -> dict[str, list[int]]:
    num_experts = int(target["num_experts"])
    keep_n = max(1, round(num_experts * keep_ratio))
    out: dict[str, list[int]] = {}
    for layer in sorted(target["layers"], key=int):
        scores = score_layer(target, reference, layer, criterion, num_experts)
        ranked = sorted(range(num_experts), key=lambda e: scores[e], reverse=True)
        # Ascending ids: the router's surviving logits must keep their relative
        # order, or the slice silently permutes experts.
        out[layer] = sorted(ranked[:keep_n])
    return out


def select_global(
    target: dict, reference: dict, criterion: str, keep_ratio: float
) -> dict[str, list[int]]:
    """Rank across all layers at once, then allocate what falls out.

    Kept so the per-layer default can be compared against something rather than
    merely asserted. Watch the per-layer counts it produces: an emptied layer is
    a broken model, not a smaller one.
    """
    num_experts = int(target["num_experts"])
    layers = sorted(target["layers"], key=int)
    flat: list[tuple[float, str, int]] = []
    for layer in layers:
        scores = score_layer(target, reference, layer, criterion, num_experts)
        flat.extend((scores[e], layer, e) for e in range(num_experts))
    total_keep = max(len(layers), round(len(flat) * keep_ratio))
    flat.sort(key=lambda x: x[0], reverse=True)
    chosen: dict[str, list[int]] = {layer: [] for layer in layers}
    for _score, layer, e in flat[:total_keep]:
        chosen[layer].append(e)
    for layer in layers:
        # Never leave a layer with nothing: a MoE layer needs at least top-k
        # experts to route to, and a layer below that is a crash, not a result.
        if len(chosen[layer]) < 8:
            scores = score_layer(target, reference, layer, criterion, num_experts)
            ranked = sorted(range(num_experts), key=lambda e: scores[e], reverse=True)
            for e in ranked:
                if e not in chosen[layer]:
                    chosen[layer].append(e)
                if len(chosen[layer]) >= 8:
                    break
        chosen[layer] = sorted(chosen[layer])
    return chosen


def summarise(keep: dict[str, list[int]], num_experts: int) -> str:
    sizes = [len(v) for v in keep.values()]
    overlap: set[int] | None = None
    for ids in keep.values():
        overlap = set(ids) if overlap is None else (overlap & set(ids))
    return (
        f"layers {len(keep)} · keep {min(sizes)}–{max(sizes)} of {num_experts} · "
        f"shared across every layer {len(overlap or set())}"
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--target", type=Path, required=True, help="agentic coding profile")
    ap.add_argument("--reference", type=Path, required=True, help="general profile")
    ap.add_argument(
        "--criterion", default="blend", choices=["count", "mass", "blend"], help="ranking"
    )
    ap.add_argument("--keep-ratio", type=float, default=0.5)
    ap.add_argument("--global-alloc", action="store_true", help="rank across layers, not within")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    target = load_profile(args.target)
    reference = load_profile(args.reference)
    if target["num_experts"] != reference["num_experts"]:
        raise SystemExit("profiles disagree on num_experts")

    keep = (
        select_global(target, reference, args.criterion, args.keep_ratio)
        if args.global_alloc
        else select_per_layer(target, reference, args.criterion, args.keep_ratio)
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "criterion": args.criterion,
                "keep_ratio": args.keep_ratio,
                "allocation": "global" if args.global_alloc else "per-layer",
                "num_experts": target["num_experts"],
                "layers": keep,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(summarise(keep, int(target["num_experts"])))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
