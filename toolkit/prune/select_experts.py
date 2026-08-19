#!/usr/bin/env python3
"""Choosing which experts to keep.

Named `select_experts` rather than `select` because stdlib `select` is imported
by `asyncio`, `subprocess` and `selectors`, and this directory goes on
`sys.path`.

The previous version offered three criteria — `count`, `mass` and `blend` — and
described them as three independent methods to be compared. They were not. All
three were a ratio of a target corpus to a reference corpus, so all three shared
the same failure: an expert that both corpora lean on heavily scores near 1.0
and gets dropped, even though every token depends on it. The pruning literature
saw exactly that collapse pushing pure contrast to 50% on Qwen. Three criteria
agreeing is not corroboration when they are the same criterion.

What replaces them is a family with an actual spread of assumptions:

  `reap`          absolute saliency: the gate weight an expert received times
                  the norm of what it produced, summed. A direct estimate of how
                  much the residual stream changes if the expert disappears.
                  The production default.
  `gate_mass`     absolute routing flow on the target corpus, ignoring output
                  magnitude. Cheaper, and disagrees with REAP where an expert is
                  chosen often but contributes little.
  `man`           mean activation norm: output magnitude, ignoring gate weight.
                  The other half of REAP, useful for telling which half is
                  carrying the ranking.
  `guard_reap`    protect the experts the *reference* corpus most depends on,
                  then spend the remaining budget on target REAP. This is the
                  one that directly answers the contrast failure: general
                  capability is preserved by construction rather than by hope.
  `hybrid_share`  F_T^2 / (F_T + F_R + eps): rewards target flow while refusing
                  to drop an expert with large absolute flow anywhere.
  `random`        the control. Multi-seed, same per-layer budget.
  `contrastive`   the old default, kept as a *negative* control so its failure
                  can be measured instead of assumed.

The exact formula for each is written into the output, because "REAP" means
several things in the wild and a keep-list whose definition is implicit cannot
be reproduced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Callable

import numpy as np

from stats import ProfileError, ProfileManifest, comparable, load_profile

EPS = 1e-12

# The formula, verbatim, for the manifest. A name is not a definition.
FORMULAS: dict[str, str] = {
    "reap": "sum_over_routed_tokens(g_e(x) * ||f_e(x)||_2), target corpus",
    "gate_mass": "sum_over_routed_tokens(g_e(x)), target corpus",
    "man": "norm_sum[e] / max(counts[e], 1), target corpus",
    "guard_reap": "reference gate_mass top-N protected, remainder ranked by target reap",
    "hybrid_share": "F_T^2 / (F_T + F_R + eps) where F = gate_sum",
    "random": "uniform sample of the same per-layer size, seeded",
    "contrastive": "(target_rate / reference_rate) — NEGATIVE CONTROL, see module docstring",
}

CRITERIA = tuple(FORMULAS)

# Which criteria need a reference profile at all. Asking for one when it is not
# used invites the belief that it was.
NEEDS_REFERENCE = {"guard_reap", "hybrid_share", "contrastive"}


class SelectionError(ValueError):
    """A selection that must not be written. Never a warning."""


def _layer_index(manifest: ProfileManifest, layer: int) -> int:
    return manifest.moe_layers.index(layer)


def _rate(values: np.ndarray, tokens: int) -> np.ndarray:
    """Per-token rate, so corpora of different sizes can be compared at all."""
    return values / max(tokens, 1)


def score_layer(
    criterion: str,
    layer: int,
    target: tuple[dict, ProfileManifest],
    reference: tuple[dict, ProfileManifest] | None,
) -> np.ndarray:
    stats_t, man_t = target
    i = _layer_index(man_t, layer)

    if criterion == "reap":
        return np.asarray(stats_t["reap_sum"][i], dtype=np.float64)

    if criterion == "gate_mass":
        return np.asarray(stats_t["gate_sum"][i], dtype=np.float64)

    if criterion == "man":
        counts = np.maximum(np.asarray(stats_t["counts"][i], dtype=np.float64), 1.0)
        return np.asarray(stats_t["norm_sum"][i], dtype=np.float64) / counts

    if reference is None:
        raise SelectionError(f"criterion {criterion!r} needs a reference profile")
    stats_r, man_r = reference
    j = _layer_index(man_r, layer)

    if criterion == "hybrid_share":
        ft = _rate(np.asarray(stats_t["gate_sum"][i], dtype=np.float64), man_t.total_tokens)
        fr = _rate(np.asarray(stats_r["gate_sum"][j], dtype=np.float64), man_r.total_tokens)
        # Squaring the numerator is what keeps this from collapsing to a ratio:
        # an expert with large absolute target flow stays high even when the
        # reference uses it just as much.
        return (ft * ft) / (ft + fr + EPS)

    if criterion == "contrastive":
        ft = _rate(np.asarray(stats_t["gate_sum"][i], dtype=np.float64), man_t.total_tokens)
        fr = _rate(np.asarray(stats_r["gate_sum"][j], dtype=np.float64), man_r.total_tokens)
        return ft / (fr + EPS)

    raise SelectionError(f"unknown criterion {criterion!r}")


def keep_for_layer(
    criterion: str,
    layer: int,
    keep_n: int,
    target: tuple[dict, ProfileManifest],
    reference: tuple[dict, ProfileManifest] | None,
    seed: int,
    guard_n: int,
) -> list[int]:
    stats_t, man_t = target
    n_experts = man_t.num_experts

    if criterion == "random":
        # Its own generator, seeded from (seed, layer), so a random control is
        # reproducible and two layers do not receive the same "random" set.
        rng = np.random.default_rng(abs(hash((seed, layer, "random"))) % (2**63))
        return sorted(int(e) for e in rng.choice(n_experts, size=keep_n, replace=False))

    if criterion == "guard_reap":
        if reference is None:
            raise SelectionError("guard_reap needs a reference profile")
        stats_r, man_r = reference
        j = _layer_index(man_r, layer)
        # Protect what general use depends on most, then spend what is left on
        # the target. The guard is the whole point: it makes preservation of
        # off-domain capability a property of the construction rather than
        # something to be discovered afterwards on a benchmark.
        ref_flow = np.asarray(stats_r["gate_sum"][j], dtype=np.float64)
        guarded = set(int(e) for e in _rank(ref_flow, layer, seed)[: min(guard_n, keep_n)])
        target_scores = score_layer("reap", layer, target, None)
        chosen = list(guarded)
        for e in _rank(target_scores, layer, seed):
            if len(chosen) >= keep_n:
                break
            if int(e) not in guarded:
                chosen.append(int(e))
        return sorted(chosen[:keep_n])

    scores = score_layer(criterion, layer, target, reference)
    return sorted(int(e) for e in _rank(scores, layer, seed)[:keep_n])


def _rank(scores: np.ndarray, layer: int, seed: int) -> np.ndarray:
    """Rank descending, breaking ties deterministically but not by index.

    `argsort` breaks ties by expert id, which is a real bias: with a
    load-balanced router many experts score identically, and preferring low ids
    means the surviving bank is skewed toward one end of the original ordering
    for no reason anyone chose. A seeded hash per (layer, expert) breaks them
    arbitrarily and reproducibly instead.
    """
    n = scores.shape[0]
    jitter = np.empty(n, dtype=np.float64)
    for e in range(n):
        digest = hashlib.sha256(f"{seed}:{layer}:{e}".encode()).digest()
        jitter[e] = int.from_bytes(digest[:8], "big") / 2**64
    order = np.lexsort((jitter, -scores))
    return order


def select(
    criterion: str,
    keep_ratio: float,
    target: tuple[dict, ProfileManifest],
    reference: tuple[dict, ProfileManifest] | None,
    seed: int,
    guard_n: int,
) -> dict[str, list[int]]:
    stats_t, man_t = target
    keep_n = round(man_t.num_experts * keep_ratio)
    _check_inputs(criterion, keep_ratio, keep_n, target, reference)
    return {
        str(layer): keep_for_layer(criterion, layer, keep_n, target, reference, seed, guard_n)
        for layer in man_t.moe_layers
    }


def _check_inputs(
    criterion: str,
    keep_ratio: float,
    keep_n: int,
    target: tuple[dict, ProfileManifest],
    reference: tuple[dict, ProfileManifest] | None,
) -> None:
    """Fail before writing anything, not after."""
    problems: list[str] = []
    _, man_t = target

    if criterion not in CRITERIA:
        problems.append(f"unknown criterion {criterion!r}; known: {', '.join(CRITERIA)}")
    if not 0 < keep_ratio <= 1:
        problems.append(f"keep_ratio must be in (0, 1]; got {keep_ratio}")
    if keep_n < man_t.experts_top_k:
        # A layer with fewer experts than the router selects per token is not a
        # smaller model, it is a crash.
        problems.append(
            f"keep_ratio {keep_ratio} leaves {keep_n} experts, below top_k={man_t.experts_top_k}"
        )
    if criterion in NEEDS_REFERENCE and reference is None:
        problems.append(f"criterion {criterion!r} needs --reference")
    if criterion not in NEEDS_REFERENCE and reference is not None:
        # Silently ignoring it would let someone believe the reference corpus
        # influenced a selection that never looked at it.
        problems.append(
            f"criterion {criterion!r} does not use a reference profile; passing one is misleading"
        )
    if reference is not None:
        problems.extend(comparable(man_t, reference[1]))

    if problems:
        raise SelectionError("; ".join(problems))


def summarise(keep: dict[str, list[int]], num_experts: int) -> str:
    sizes = {len(v) for v in keep.values()}
    shared: set[int] | None = None
    for ids in keep.values():
        shared = set(ids) if shared is None else shared & set(ids)
    return (
        f"layers {len(keep)} · keep {sorted(sizes)} of {num_experts} · "
        f"shared by every layer {len(shared or set())}"
    )


def keep_list_document(
    keep: dict[str, list[int]],
    criterion: str,
    keep_ratio: float,
    seed: int,
    guard_n: int,
    target: ProfileManifest,
    reference: ProfileManifest | None,
) -> dict:
    payload = {
        "schema_version": "motifcode.keeplist/v1",
        "criterion": criterion,
        "formula": FORMULAS[criterion],
        "keep_ratio": keep_ratio,
        "allocation": "per-layer",
        "seed": seed,
        "guard_n": guard_n if criterion == "guard_reap" else None,
        "num_experts": target.num_experts,
        "experts_top_k": target.experts_top_k,
        "source_revision": target.source_revision,
        "target_corpus_sha256": target.corpus_manifest_sha256,
        "reference_corpus_sha256": reference.corpus_manifest_sha256 if reference else None,
        "layers": keep,
    }
    payload["keep_list_sha256"] = hashlib.sha256(
        json.dumps(payload["layers"], sort_keys=True).encode()
    ).hexdigest()
    return payload


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--target", type=Path, required=True, help="profile.stats.safetensors")
    ap.add_argument("--reference", type=Path, help="a second profile, for guard/hybrid/contrast")
    ap.add_argument("--criterion", default="reap", choices=CRITERIA)
    ap.add_argument("--keep-ratio", type=float, default=0.5)
    ap.add_argument("--seed", type=int, default=17, help="tie-breaks and the random control")
    ap.add_argument(
        "--guard-n",
        type=int,
        default=96,
        help="guard_reap: how many reference-critical experts to protect per layer",
    )
    ap.add_argument(
        "--global-alloc",
        action="store_true",
        help="unsupported; see the error it produces",
    )
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    if args.global_alloc:
        # Refused here, before anything is read or written. Global allocation
        # gives layers different survivor counts, and `num_experts` is a single
        # value in config.json that every loader and every fused kernel reads.
        # A keep-list this tool cannot turn into a loadable checkpoint should
        # not be produced at all.
        raise SystemExit(
            "--global-alloc is not supported: it produces a different expert count per layer, "
            "and config.json, the checkpoint tensor shapes, the activation-scale sidecar and the "
            "fused MoE kernels all assume one `num_experts` for the whole model. Making it work "
            "is a redesign of all four, not a flag."
        )

    target = load_profile(args.target)
    reference = load_profile(args.reference) if args.reference else None

    try:
        keep = select(
            args.criterion, args.keep_ratio, target, reference, args.seed, args.guard_n
        )
    except (SelectionError, ProfileError) as err:
        raise SystemExit(f"selection refused: {err}") from err

    doc = keep_list_document(
        keep,
        args.criterion,
        args.keep_ratio,
        args.seed,
        args.guard_n,
        target[1],
        reference[1] if reference else None,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(summarise(keep, target[1].num_experts))
    print(f"criterion {args.criterion}: {FORMULAS[args.criterion]}")
    print(f"wrote {args.out}  (keep-list sha256 {doc['keep_list_sha256'][:16]}…)")


if __name__ == "__main__":
    main()
