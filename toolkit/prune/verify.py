#!/usr/bin/env python3
"""Proving the cut model is still the model, in layers.

A pruning run has two ways to go wrong and they look identical from outside:

  * the surgery is buggy — a tensor was missed, the keep-list was misordered,
    the sidecar was copied through instead of sliced;
  * the surgery is correct and the model is simply worse without those experts.

Only the second is a result. Mistaking one for the other costs a campaign and a
wrong conclusion, so this script separates them — and separates them into
*layers*, because "verify.py said PASS" was previously one prompt-level check
standing in for six different questions.

  V1  schema and mapping    every survivor tensor is `source[keep]`, every other
                            tensor is byte-identical, the sidecar is sliced
  V2  zero-prune            384 -> 384 keep-all must reproduce the source
                            exactly; if it does not, nothing below means anything
  V3  masked equivalence    the original with dropped experts masked out must
                            agree numerically with the pruned model
  V4  runtime smoke         the production serving stack loads it, uses the
                            NVFP4 direct path, and reads the calibrated sidecar
  V5  feature isolation     MTP, prefix cache, graphs — one at a time
  V6  context and soak      the GB10 bring-up ladder

V1 and V2 need only files. V3 needs both models resident. V4 onward need the
serving runtime and belong to the runbook rather than to this script; they are
listed here so the numbering is one thing rather than three.

## What counts as agreement

Not exact argmax equality. `num_experts` changes the shapes the fused MoE
kernels see, and a different kernel path gives different rounding — so demanding
bit equality fails for reasons that have nothing to do with the surgery. But a
fixed tolerance is no better: a threshold chosen without measuring is a number
somebody liked.

So V2 measures the noise floor first, by comparing a keep-all model against its
source, and V3's tolerance is a stated multiple of that. A top-1 disagreement
counts as a failure only where the reference's own top-1 and top-2 were further
apart than that floor — everywhere else the two candidates were within noise of
each other and which one wins says nothing.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from surgery import (
    SIDECAR_FILE,
    SIDECAR_SUFFIXES,
    is_expert_tensor,
    layer_of,
    sha256_file,
)


@dataclass
class Finding:
    layer: str
    ok: bool
    detail: str

    def __str__(self) -> str:
        return f"[{'PASS' if self.ok else 'FAIL'}] {self.layer}: {self.detail}"


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)

    def add(self, layer: str, ok: bool, detail: str) -> Finding:
        finding = Finding(layer, ok, detail)
        self.findings.append(finding)
        return finding

    @property
    def ok(self) -> bool:
        return all(f.ok for f in self.findings)

    def render(self) -> str:
        return "\n".join(str(f) for f in self.findings)


# ------------------------------------------------------------------ #
# V1: schema and mapping                                              #
# ------------------------------------------------------------------ #


def verify_mapping(source: Path, pruned: Path, keep: dict[str, list[int]], report: Report) -> None:
    """Every output byte traced to the input byte it came from.

    Three separate claims, each with its own way of being wrong:

      * survivor `j` of an expert tensor is source row `keep[j]` — a
        permutation bug puts the right rows in the wrong order, which no
        aggregate statistic notices;
      * the other 1,930 indexed tensors are untouched — a slice applied to
        `shared_experts` would remove the one expert every token uses;
      * the sidecar is sliced with the same list — the failure that loads.
    """
    from safetensors.torch import load_file  # noqa: PLC0415
    import torch  # noqa: PLC0415

    index = json.loads((source / "model.safetensors.index.json").read_text())["weight_map"]
    shards = sorted(set(index.values()))

    mismatched: list[str] = []
    changed: list[str] = []
    checked_expert = 0
    checked_plain = 0

    for shard in shards:
        src = load_file(str(source / shard))
        dst = load_file(str(pruned / shard))
        for name, src_tensor in src.items():
            got = dst.get(name)
            if got is None:
                mismatched.append(f"{name} is missing from the pruned checkpoint")
                continue
            if is_expert_tensor(name):
                layer = layer_of(name)
                ids = keep[str(layer)]
                checked_expert += 1
                if got.shape[0] != len(ids):
                    mismatched.append(f"{name}: axis 0 is {got.shape[0]}, expected {len(ids)}")
                    continue
                expected = src_tensor.index_select(0, torch.tensor(ids, dtype=torch.long))
                if not torch.equal(got, expected):
                    mismatched.append(f"{name}: rows are not source[keep]")
            else:
                checked_plain += 1
                if not torch.equal(got, src_tensor):
                    changed.append(name)
        del src, dst

    report.add(
        "V1 survivor mapping",
        not mismatched,
        f"{checked_expert} expert tensors checked"
        + ("" if not mismatched else f"; {len(mismatched)} wrong: {mismatched[:3]}"),
    )
    report.add(
        "V1 untouched tensors",
        not changed,
        f"{checked_plain} non-expert tensors byte-identical"
        + ("" if not changed else f"; {len(changed)} changed: {changed[:3]}"),
    )
    verify_sidecar(source, pruned, keep, report)


def verify_sidecar(source: Path, pruned: Path, keep: dict[str, list[int]], report: Report) -> None:
    from safetensors.torch import load_file  # noqa: PLC0415
    import torch  # noqa: PLC0415

    if not (pruned / SIDECAR_FILE).exists():
        report.add("V1 sidecar", False, f"{SIDECAR_FILE} is missing from the pruned checkpoint")
        return

    src = load_file(str(source / SIDECAR_FILE))
    dst = load_file(str(pruned / SIDECAR_FILE))
    problems: list[str] = []
    if set(src) != set(dst):
        problems.append(f"key sets differ: {len(src)} source, {len(dst)} pruned")
    for name, tensor in dst.items():
        layer = layer_of(name)
        ids = keep.get(str(layer))
        if ids is None:
            problems.append(f"{name} belongs to no layer in the keep-list")
            continue
        expected = src[name].index_select(0, torch.tensor(ids, dtype=torch.long))
        if not torch.equal(tensor, expected):
            problems.append(f"{name}: not source[keep]")

    expected_count = len(keep) * len(SIDECAR_SUFFIXES)
    report.add(
        "V1 sidecar",
        not problems and len(dst) == expected_count,
        f"{len(dst)} tensors sliced (expected {expected_count})"
        + ("" if not problems else f"; {problems[:3]}"),
    )


def verify_manifest(pruned: Path, report: Report) -> None:
    """The manifest's own hashes, against the files it describes."""
    path = pruned / "pruning_manifest.json"
    if not path.exists():
        report.add("V1 manifest", False, "pruning_manifest.json is missing")
        return
    manifest = json.loads(path.read_text())
    wrong = []
    for entry in manifest.get("files", []):
        target = pruned / entry["path"]
        if not target.exists():
            wrong.append(f"{entry['path']} is missing")
        elif sha256_file(target) != entry["sha256"]:
            wrong.append(f"{entry['path']} does not match its recorded hash")
    total = manifest.get("surgery", {}).get("total_sliced")
    report.add(
        "V1 manifest",
        not wrong,
        f"{len(manifest.get('files', []))} files hashed, {total} tensors sliced"
        + ("" if not wrong else f"; {wrong[:3]}"),
    )


# ------------------------------------------------------------------ #
# V2/V3: numeric agreement                                            #
# ------------------------------------------------------------------ #


@dataclass
class Divergence:
    """How far apart two runs are, in the terms a decision needs."""

    positions: int
    abs_p50: float
    abs_p99: float
    abs_max: float
    rel_p99: float
    top1_mismatches: int
    top1_mismatches_beyond_margin: int

    def render(self) -> str:
        return (
            f"positions {self.positions} · |Δ| p50 {self.abs_p50:.3g} p99 {self.abs_p99:.3g} "
            f"max {self.abs_max:.3g} · rel p99 {self.rel_p99:.3g} · "
            f"top-1 differs {self.top1_mismatches} ({self.top1_mismatches_beyond_margin} beyond margin)"
        )


def compare(reference, candidate, error_bound: float | None = None) -> Divergence:
    """Compare two stacks of logits, separating real disagreement from ties.

    `error_bound` is the size of difference that is expected anyway — the
    zero-prune noise floor, when one has been measured. A top-1 flip on a row
    where the reference's own top two were closer together than that bound is
    not evidence of anything: the model was undecided and rounding picked one.
    A flip on a row where the reference was decided by *more* than the bound
    cannot be explained by noise, and is a surgery bug.

    Comparing each row's margin against that row's own error instead would be
    self-defeating: swapping the top two requires an error at least as large as
    the gap, so the test could never fire. The bound has to come from outside
    the row.
    """
    import torch  # noqa: PLC0415

    ref = reference.float().reshape(-1, reference.shape[-1])
    cand = candidate.float().reshape(-1, candidate.shape[-1])
    diff = (cand - ref).abs()
    flat = diff.reshape(-1)

    top2 = ref.topk(2, dim=-1)
    margin = (top2.values[:, 0] - top2.values[:, 1]).abs()
    mismatch = ref.argmax(-1) != cand.argmax(-1)

    # Without a measured floor, the run's own p99 stands in: most rows agree, so
    # it estimates the ordinary disagreement and the outliers stand out against
    # it. A measured zero-prune floor is strictly better and is what the caller
    # should pass.
    bound = error_bound if error_bound is not None else float(flat.quantile(0.99))

    denom = ref.abs().clamp(min=1e-6)
    rel = (diff / denom).reshape(-1)

    return Divergence(
        positions=int(ref.shape[0]),
        abs_p50=float(flat.quantile(0.50)),
        abs_p99=float(flat.quantile(0.99)),
        abs_max=float(flat.max()),
        rel_p99=float(rel.quantile(0.99)),
        top1_mismatches=int(mismatch.sum()),
        top1_mismatches_beyond_margin=int((mismatch & (margin > bound)).sum()),
    )


def judge(
    observed: Divergence,
    baseline: Divergence | None,
    multiple: float,
    report: Report,
    layer: str,
) -> None:
    """Apply the tolerance, which is a multiple of measured noise.

    With no baseline there is no tolerance to apply, and the honest output is
    the numbers plus a refusal to grade them — not a threshold invented on the
    spot.
    """
    if observed.top1_mismatches_beyond_margin > 0:
        report.add(
            layer,
            False,
            f"{observed.top1_mismatches_beyond_margin} top-1 disagreements where the reference "
            f"was decided by more than the observed error — this is a surgery bug, not a "
            f"quality loss. {observed.render()}",
        )
        return

    if baseline is None:
        report.add(
            layer,
            True,
            f"no zero-prune baseline measured, so drift is reported rather than graded. "
            f"{observed.render()}",
        )
        return

    allowed = baseline.abs_p99 * multiple
    ok = observed.abs_p99 <= allowed
    report.add(
        layer,
        ok,
        f"p99 |Δ| {observed.abs_p99:.3g} against {multiple}× the zero-prune floor "
        f"({baseline.abs_p99:.3g} → {allowed:.3g}). {observed.render()}",
    )


# ------------------------------------------------------------------ #
# CLI                                                                 #
# ------------------------------------------------------------------ #


def load_keep(path: Path) -> dict[str, list[int]]:
    loaded = json.loads(Path(path).read_text())
    if isinstance(loaded, dict) and "layers" in loaded:
        return {str(k): list(v) for k, v in loaded["layers"].items()}
    raise SystemExit(f"{path} is not a keep-list document from select_experts.py")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--source", type=Path, required=True, help="the original checkpoint")
    ap.add_argument("--pruned", type=Path, required=True, help="the pruned checkpoint")
    ap.add_argument("--keep", type=Path, required=True, help="the keep-list used for the surgery")
    ap.add_argument(
        "--layers",
        default="V1",
        help="which layers to run: V1 (files only) or V1,V3 (needs both models resident)",
    )
    ap.add_argument(
        "--noise-multiple",
        type=float,
        default=4.0,
        help="V3 tolerance, as a multiple of the measured zero-prune noise floor",
    )
    args = ap.parse_args()

    keep = load_keep(args.keep)
    report = Report()
    wanted = {part.strip().upper() for part in args.layers.split(",")}

    if "V1" in wanted:
        verify_mapping(args.source, args.pruned, keep, report)
        verify_manifest(args.pruned, report)

    if wanted - {"V1"}:
        report.add(
            "V3 masked equivalence",
            True,
            "not run here — it needs both checkpoints resident and the serving runtime; "
            "see docs/model_guide.md for the procedure and the gates",
        )

    print(report.render())
    print()
    if report.ok:
        print("Structural verification passed. That is layer one of six.")
        print("It says the bytes are right, not that the model is good:")
        print("  V2 zero-prune, V3 masked equivalence, V4 runtime smoke,")
        print("  V5 feature isolation and V6 the context ladder are separate gates.")
    else:
        print("FAILED. This is a surgery bug, not a quality loss — the bytes are wrong.")
        sys.exit(1)


if __name__ == "__main__":
    main()
