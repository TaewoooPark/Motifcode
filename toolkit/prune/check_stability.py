#!/usr/bin/env python3
"""Do independent slices of the corpus choose the same experts?

The gate that decides whether the corpus is large enough. It is not a size
chosen by copying a number from a paper: if four disjoint quarters of the
corpus disagree about which experts to keep, the profile is measuring the
slice rather than the workload, and no amount of evaluation downstream
separates the two. If they agree, more tokens buy nothing.

The thresholds live in `corpus.py` as constants, not as flags here, so they
cannot be chosen after seeing the report.

    python check_stability.py --keep-ratio 0.5 --criterion reap profiles/target-s*.stats.safetensors

Selection is re-run per slice rather than compared on raw scores, because the
keep-set is what the surgery uses. Two slices can disagree about an expert's
exact saliency and still cut in the same place, and it is the cut that matters.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from corpus import StabilityGate, stability_report
from select_experts import CRITERIA, select
from stats import load_profile


def keep_sets(
    paths: list[Path],
    criterion: str,
    keep_ratio: float,
    seed: int,
    guard_n: int,
    reference: Path | None,
) -> list[dict[str, list[int]]]:
    """One keep-list per slice, chosen exactly as the real selection would be."""
    shared_reference = load_profile(reference) if reference else None
    return [
        select(
            criterion=criterion,
            keep_ratio=keep_ratio,
            target=load_profile(path),
            reference=shared_reference,
            seed=seed,
            guard_n=guard_n,
        )
        for path in paths
    ]


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("profiles", type=Path, nargs="+", help="one profile per independent slice")
    ap.add_argument("--criterion", default="reap", choices=CRITERIA)
    ap.add_argument("--keep-ratio", type=float, default=0.5)
    ap.add_argument("--seed", type=int, default=17)
    ap.add_argument("--guard-n", type=int, default=96)
    ap.add_argument(
        "--reference",
        type=Path,
        help=(
            "one reference profile, shared by every slice. The gate asks whether the *target* "
            "slices agree, so varying the reference alongside them would mix two sources of "
            "disagreement into one number"
        ),
    )
    ap.add_argument("--out", type=Path, help="write the report as JSON")
    args = ap.parse_args()

    if len(args.profiles) < 2:
        raise SystemExit("stability needs at least two independent slices")

    slices = keep_sets(
        args.profiles, args.criterion, args.keep_ratio, args.seed, args.guard_n, args.reference
    )
    report = stability_report(slices, StabilityGate())
    report["profiles"] = [p.name for p in args.profiles]
    report["criterion"] = args.criterion
    report["keep_ratio"] = args.keep_ratio

    text = json.dumps(report, indent=2)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)

    verdict = "PASS" if report["passed"] else "FAIL"
    print(
        f"\n{verdict}  median layer Jaccard {report['median_layer_jaccard']:.4f} "
        f"(gate {report['gate']['median_layer_jaccard']}), "
        f"p5 {report['p5_layer_jaccard']:.4f} (gate {report['gate']['p5_layer_jaccard']})",
        file=sys.stderr,
    )
    if not report["passed"]:
        print(
            "The slices do not agree on what to keep. More tokens, not a lower gate — "
            "a threshold moved after seeing the number is not a threshold.",
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
