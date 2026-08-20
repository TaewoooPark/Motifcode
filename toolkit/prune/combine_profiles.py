#!/usr/bin/env python3
"""Add independent profile slices into one, and say when they may not be added.

Routing statistics are sums over tokens, so a profile of disjoint slices of a
corpus is the sum of their profiles. That is what makes slicing free: the same
work produces both the pooled profile the selection uses and the independent
samples the stability gate compares, rather than one after the other.

"Disjoint" is the part that has to be checked rather than assumed. Two profiles
of overlapping slices add to something that looks exactly like a profile of
twice as many tokens, and every count downstream is then wrong in a direction
nothing reveals. This refuses to add profiles whose slice specifications
overlap, and refuses to add profiles taken under conditions that differ — a
different checkpoint, a different template, a different tool schema — because
the sum would describe a model and a prompt that were never run together.

    python combine_profiles.py --out pooled.stats.safetensors slice-*.stats.safetensors
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

from stats import ProfileError, comparable, load_profile, save_profile


def parse_slice(text: str) -> tuple[int, int] | None:
    """`i/n` -> (i, n). `None` for a profile that recorded no slice."""
    if not text or "/" not in text:
        return None
    try:
        index, count = (int(part) for part in text.split("/", 1))
    except ValueError:
        return None
    return index, count


def overlapping(slices: list[tuple[str, str]]) -> list[str]:
    """Why these slices cannot be treated as disjoint."""
    problems: list[str] = []
    parsed: list[tuple[str, tuple[int, int]]] = []
    for name, text in slices:
        spec = parse_slice(text)
        if spec is None:
            problems.append(
                f"{name}: no slice recorded. A profile of the whole corpus cannot be added to a "
                "slice of it — the tokens are counted twice."
            )
            continue
        parsed.append((name, spec))

    counts = {count for _, (_, count) in parsed}
    if len(counts) > 1:
        # Slices only partition the corpus when they were cut the same way.
        # `1/2` and `1/4` both contain record 0; `1/1` contains everything.
        found = ", ".join(f"{name} is {index}/{count}" for name, (index, count) in parsed)
        problems.append(
            f"slices were cut with different strides ({sorted(counts)}): {found}. "
            "Slices of different strides share records, so they do not partition the corpus."
        )
        return problems

    seen: dict[int, str] = {}
    for name, (index, _) in parsed:
        if index in seen:
            problems.append(f"{name} and {seen[index]} are both slice {index}; adding them counts it twice")
        seen[index] = name
    return problems


def combine(paths: list[Path]) -> tuple[dict, object]:
    import numpy as np  # noqa: PLC0415

    loaded = [load_profile(p) for p in paths]
    first_stats, first_manifest = loaded[0]

    problems: list[str] = []
    for path, (_, manifest) in zip(paths[1:], loaded[1:], strict=True):
        for reason in comparable(first_manifest, manifest):
            problems.append(f"{path.name}: {reason}")

    problems += overlapping(
        [(p.name, getattr(m, "corpus_slice", "")) for p, (_, m) in zip(paths, loaded, strict=True)]
    )
    if problems:
        raise ProfileError(
            "these profiles cannot be added:\n  - " + "\n  - ".join(problems)
        )

    total = {name: np.array(value, copy=True) for name, value in first_stats.items()}
    for _, (stats, _) in zip(paths[1:], loaded[1:], strict=True):
        for name, value in stats.items():
            if name not in total:
                raise ProfileError(f"a profile has an accumulator the first does not: {name}")
            if total[name].shape != value.shape:
                raise ProfileError(
                    f"{name}: shapes disagree, {total[name].shape} against {value.shape}"
                )
            total[name] += value

    manifest = replace(
        first_manifest,
        total_tokens=sum(m.total_tokens for _, m in loaded),
        total_sequences=sum(m.total_sequences for _, m in loaded),
        elapsed_seconds=round(sum(m.elapsed_seconds for _, m in loaded), 1),
        # The pooled profile is of the whole corpus, and says so. Carrying one
        # slice's spec forward would let it be added to its own siblings again.
        corpus_slice="pooled:" + ",".join(
            getattr(m, "corpus_slice", "?") for _, m in loaded
        ),
        peak_device_bytes=max(m.peak_device_bytes for _, m in loaded),
    )
    return total, manifest


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("profiles", type=Path, nargs="+")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    if len(args.profiles) < 2:
        raise SystemExit("combining needs at least two profiles")

    stats, manifest = combine(args.profiles)
    save_profile(args.out, stats, manifest)
    print(
        f"{len(args.profiles)} slice(s) -> {args.out}  "
        f"({manifest.total_tokens:,} tokens, {manifest.total_sequences} sequences)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
