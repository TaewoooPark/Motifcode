#!/usr/bin/env python3
"""What a routing profile contains, and what makes one usable.

The first version of this pipeline collected two statistics — how often each
expert was selected, and the summed gate weight it received — and every
selection criterion was a *ratio* of one corpus to another. That was one family
of methods wearing three names, and it shares a failure mode: an expert that is
heavily used by both corpora scores near 1.0 and gets dropped, even though every
token in both corpora depends on it. The pruning literature found exactly that
collapse when pure contrast was pushed to 50% on Qwen.

So a profile now carries the statistics an *absolute* criterion needs as well.
`reap_sum` is the one that matters most: the summed product of the gate weight
an expert received and the norm of what it produced, which is a direct estimate
of how much that expert contributed to the residual stream. Removing an expert
with a large value changes the model's output by a lot, whatever the other
corpus did.

Every statistic is accumulated in float64 and counts in int64. A float32
accumulator over three million tokens loses the small contributions entirely —
adding 1e-3 to 1e7 in float32 is a no-op — and the small contributions are
precisely the ones that decide which experts sit near the cut.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

# The names, in one place, so the profiler, the selector and the tests cannot
# drift. Each is per (layer, expert).
STAT_NAMES = (
    "counts",       # I64: routed token-expert pairs
    "gate_sum",     # F64: sum of the final routing weight actually applied
    "prob_mass",    # F64: sum of sigmoid(router_logit) over every token
    "norm_sum",     # F64: sum of ||f_e(x)||2 over routed tokens
    "norm_sq_sum",  # F64: sum of ||f_e(x)||2^2, for a variance estimate
    "reap_sum",     # F64: sum of g_e(x) * ||f_e(x)||2 — the REAP saliency
)

COUNT_STATS = ("counts",)


@dataclass
class ProfileManifest:
    """Everything needed to decide whether two profiles are comparable.

    Recorded rather than assumed, because the failure it prevents is silent: a
    profile collected against a different revision, tokenizer or chat template
    still produces 384 plausible numbers per layer, and the selection built on
    it is wrong in a way nothing downstream can detect.
    """

    source_repo: str
    source_revision: str
    config_sha256: str
    index_sha256: str
    sidecar_sha256: str
    corpus_manifest_sha256: str
    template_sha256: str
    tool_schema_sha256: str
    backend: str
    backend_version: str
    num_experts: int
    experts_top_k: int
    moe_layers: list[int]
    total_tokens: int
    total_sequences: int
    sequence_length: int
    packing: str
    seed: int
    dtype: str
    # Motif applies `route_norm` then multiplies by `route_scale`, and the
    # expert-selection bias participates in *which* experts are chosen without
    # entering the returned weight. Which of those `gate_sum` includes decides
    # what the number means, so it is written down rather than inferred.
    route_norm: bool
    route_scale: float
    gate_sum_includes_route_scale: bool
    selection_bias_applied: bool
    peak_host_bytes: int = 0
    peak_device_bytes: int = 0
    elapsed_seconds: float = 0.0
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "schema_version": "motifcode.profile/v1",
            **self.__dict__,
        }

    @staticmethod
    def from_json(data: dict) -> "ProfileManifest":
        known = {k: v for k, v in data.items() if k in ProfileManifest.__dataclass_fields__}
        return ProfileManifest(**known)


class ProfileError(ValueError):
    """A profile that cannot be trusted. Never a warning."""


def validate_stats(stats: dict, manifest: ProfileManifest) -> None:
    """Refuse a profile that cannot be what it claims to be.

    Every check here corresponds to a way a profile can look complete and be
    unusable. They run before selection rather than after, because a keep-list
    built from a broken profile is indistinguishable from a good one until the
    surgery is done and the model is worse.
    """
    problems: list[str] = []
    n_layers = len(manifest.moe_layers)
    n_experts = manifest.num_experts

    for name in STAT_NAMES:
        if name not in stats:
            problems.append(f"missing statistic {name!r}")
            continue
        arr = stats[name]
        shape = tuple(arr.shape)
        if shape != (n_layers, n_experts):
            problems.append(f"{name}: shape {shape}, expected {(n_layers, n_experts)}")

    if problems:
        raise ProfileError("; ".join(problems))

    import numpy as np  # noqa: PLC0415

    for name in STAT_NAMES:
        arr = np.asarray(stats[name])
        if not np.all(np.isfinite(arr)):
            bad = int(np.count_nonzero(~np.isfinite(arr)))
            problems.append(f"{name}: {bad} non-finite value(s)")
        if np.any(arr < 0):
            problems.append(f"{name}: negative values, which no statistic here can take")

    # The invariant that catches a dropped hook or a double-counted batch: every
    # token routes to exactly top_k experts, so a layer's counts must sum to
    # tokens x k. A profiler that missed a layer, or ran one twice, fails here
    # rather than producing a plausible ranking.
    counts = np.asarray(stats["counts"], dtype=np.int64)
    expected = manifest.total_tokens * manifest.experts_top_k
    for i, layer in enumerate(manifest.moe_layers):
        got = int(counts[i].sum())
        if got != expected:
            problems.append(
                f"layer {layer}: counts sum to {got}, expected tokens x top_k = {expected}"
            )

    if problems:
        raise ProfileError("; ".join(problems))


def load_profile(path: Path) -> tuple[dict, ProfileManifest]:
    """Read a profile and its manifest, validating before returning either."""
    from safetensors.numpy import load_file  # noqa: PLC0415

    stats_path = Path(path)
    manifest_path = stats_path.with_suffix("").with_suffix(".manifest.json")
    if not manifest_path.exists():
        manifest_path = stats_path.parent / "profile.manifest.json"
    if not manifest_path.exists():
        raise ProfileError(f"no manifest beside {stats_path}; a profile without one is not usable")

    manifest = ProfileManifest.from_json(json.loads(manifest_path.read_text()))
    stats = load_file(str(stats_path))
    validate_stats(stats, manifest)
    return stats, manifest


def save_profile(path: Path, stats: dict, manifest: ProfileManifest) -> None:
    from safetensors.numpy import save_file  # noqa: PLC0415

    validate_stats(stats, manifest)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    save_file(stats, str(path))
    (path.parent / "profile.manifest.json").write_text(
        json.dumps(manifest.to_json(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def comparable(a: ProfileManifest, b: ProfileManifest) -> list[str]:
    """Why two profiles cannot be compared, or an empty list.

    A contrast between profiles collected under different conditions measures
    the conditions.
    """
    problems: list[str] = []
    for field_name in (
        "source_revision",
        "config_sha256",
        "template_sha256",
        "tool_schema_sha256",
        "num_experts",
        "experts_top_k",
        "backend",
    ):
        if getattr(a, field_name) != getattr(b, field_name):
            problems.append(
                f"{field_name} differs: {getattr(a, field_name)!r} vs {getattr(b, field_name)!r}"
            )
    if a.moe_layers != b.moe_layers:
        problems.append("different MoE layer sets")
    if a.gate_sum_includes_route_scale != b.gate_sum_includes_route_scale:
        problems.append("gate_sum means different things in the two profiles")
    return problems
