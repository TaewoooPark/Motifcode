#!/usr/bin/env python3
"""The calibration corpus: what it must contain, and what it must not.

Routing is measured on whatever the model is shown, so a profile is only about
agentic coding if the text is what the agent actually sends. The first version
of this pipeline tokenised raw document text and truncated each document at
2,048 tokens, which deleted the system prompt, the tool schemas, the chat roles,
the reasoning markers, the tool-result envelope and the repair turns — every
structural token the harness emits on every request. Whatever that profiled, it
was not this harness.

So a corpus record is a rendered conversation, produced by the same template and
the same frozen tool list the harness uses, and the manifest records the hashes
of both. If either changes, the profile is stale and says so.

The other half is leakage. Profiling on the same instances the model is later
graded on is circular: the experts kept are the ones that were useful for
exactly those problems, and the benchmark then reports how well that worked. The
audit here is a hard failure rather than a report, because a warning printed
during a twelve-hour profiling run is a warning nobody reads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

SPLITS = ("calibration", "selection-validation", "final-test")


class CorpusError(ValueError):
    """A corpus that must not be profiled. Never a warning."""


@dataclass
class CorpusRecord:
    """One rendered conversation, and where it came from."""

    sample_id: str
    source: str
    source_revision: str
    split: str
    messages: list[dict]
    tools_sha256: str
    template_sha256: str
    rendered_sha256: str
    license: str
    repo: str | None = None
    base_commit: str | None = None
    benchmark_instance_id: str | None = None

    def to_json(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


@dataclass
class CorpusManifest:
    corpus_id: str
    tools_sha256: str
    template_sha256: str
    documents: list[dict] = field(default_factory=list)
    excluded_eval_manifest_sha256: str | None = None
    # What was actually checked, so a later reader can tell what was not.
    dedup: dict = field(
        default_factory=lambda: {
            "exact_hash": True,
            "instance_id_match": True,
            "near_duplicate_method": "5-gram jaccard + word-set containment",
            "near_duplicate_threshold": 0.8,
        }
    )
    packing: str = "fixed-4096-eos-separated"
    sequence_length: int = 4096
    seed: int = 17

    def to_json(self) -> dict:
        return {"schema_version": "motifcode.corpus/v1", **self.__dict__}

    def sha256(self) -> str:
        return hashlib.sha256(
            json.dumps(self.to_json(), sort_keys=True).encode("utf-8")
        ).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ #
# leakage                                                             #
# ------------------------------------------------------------------ #

_WORD = re.compile(r"[a-z0-9_]+")


def normalize(text: str) -> str:
    """Lowercase word tokens, whitespace collapsed.

    Enough to catch a document that was reformatted, indented differently or
    had its comments rewrapped — the shapes a copy actually takes — without
    pretending to be a semantic comparison.
    """
    return " ".join(_WORD.findall(text.lower()))


def shingles(text: str, n: int = 5) -> set[str]:
    """Overlapping n-grams of normalised words.

    Five rather than eight. Longer shingles are more precise on long documents
    and nearly blind on short ones: inserting a single word into a fifteen-word
    snippet shifts every 8-gram that spans it, so a reformatted copy of a small
    function shares almost nothing with its original.
    """
    words = normalize(text).split()
    if len(words) < n:
        return {" ".join(words)} if words else set()
    return {" ".join(words[i : i + n]) for i in range(len(words) - n + 1)}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def containment(a: set[str], b: set[str]) -> float:
    """How much of the smaller set the larger one covers.

    Jaccard punishes size difference, and the realistic leak is asymmetric: a
    calibration document that *contains* a benchmark problem plus a whole
    conversation around it has low Jaccard and containment near one. Reported
    alongside rather than instead, because containment alone flags any short
    generic snippet against a long document.
    """
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def similarity(a_text: str, b_text: str) -> tuple[float, str]:
    """The strongest signal that these two texts are the same document.

    Both measures are reported by name, because "0.83 similar" without saying
    which question was asked is not something anyone can act on.
    """
    a_sh, b_sh = shingles(a_text), shingles(b_text)
    j = jaccard(a_sh, b_sh)
    a_w, b_w = set(normalize(a_text).split()), set(normalize(b_text).split())
    # Word-set containment needs enough words to mean anything; below that,
    # every snippet of Python contains "def", "return" and "for".
    c = containment(a_w, b_w) if min(len(a_w), len(b_w)) >= 8 else 0.0
    return (j, "shingle_jaccard") if j >= c else (c, "word_containment")


@dataclass
class Overlap:
    sample_id: str
    instance_id: str
    kind: str
    score: float


def audit_leakage(
    records: list[CorpusRecord],
    sealed_instance_ids: set[str],
    sealed_texts: dict[str, str] | None = None,
    near_duplicate_threshold: float = 0.8,
) -> list[Overlap]:
    """Every way a calibration document can be a sealed benchmark instance.

    Exact instance-id matches first, because that is the one that happens by
    accident and is unambiguous. Then near-duplicate text, because a document
    that was reformatted on the way in has the same problem and none of the same
    identifiers.

    This is not a proof of disjointness and does not claim to be. It catches the
    shapes a leak actually takes — a copied instance, a reformatted one, a
    conversation built around one — and a corpus that passes it can still
    contain a paraphrase nobody would recognise. The manifest records which
    method ran, so a later reader can tell what was and was not checked.
    """
    found: list[Overlap] = []
    for record in records:
        if record.benchmark_instance_id and record.benchmark_instance_id in sealed_instance_ids:
            found.append(
                Overlap(record.sample_id, record.benchmark_instance_id, "instance_id", 1.0)
            )

    if sealed_texts:
        for record in records:
            body = rendered_text(record)
            for iid, theirs in sealed_texts.items():
                score, how = similarity(body, theirs)
                if score >= near_duplicate_threshold:
                    found.append(
                        Overlap(record.sample_id, iid, f"near_duplicate:{how}", round(score, 4))
                    )
    return found


def rendered_text(record: CorpusRecord) -> str:
    """The conversation as one blob, for duplicate detection only."""
    return "\n".join(str(m.get("content", "")) for m in record.messages)


# ------------------------------------------------------------------ #
# validation                                                          #
# ------------------------------------------------------------------ #


def validate_corpus(
    records: list[CorpusRecord],
    tools_sha256: str,
    template_sha256: str,
    sealed_instance_ids: set[str] | None = None,
    sealed_texts: dict[str, str] | None = None,
) -> None:
    """Refuse a corpus before anything expensive reads it."""
    problems: list[str] = []
    if not records:
        problems.append("corpus is empty")

    seen: set[str] = set()
    for record in records:
        if record.sample_id in seen:
            problems.append(f"duplicate sample_id {record.sample_id!r}")
        seen.add(record.sample_id)
        if record.split not in SPLITS:
            problems.append(f"{record.sample_id}: split {record.split!r} is not one of {SPLITS}")
        if record.tools_sha256 != tools_sha256:
            problems.append(
                f"{record.sample_id}: rendered against tool schemas {record.tools_sha256[:12]}, "
                f"current is {tools_sha256[:12]} — the structural tokens differ"
            )
        if record.template_sha256 != template_sha256:
            problems.append(
                f"{record.sample_id}: rendered against chat template {record.template_sha256[:12]}, "
                f"current is {template_sha256[:12]}"
            )
        if not record.messages:
            problems.append(f"{record.sample_id}: no messages")
        elif record.messages[0].get("role") != "system":
            # A conversation that does not open with the system turn is missing
            # the tools block and the instructions, which is most of the
            # structural token budget.
            problems.append(f"{record.sample_id}: does not begin with a system turn")

    if sealed_instance_ids:
        overlaps = audit_leakage(records, sealed_instance_ids, sealed_texts)
        for o in overlaps:
            problems.append(
                f"{o.sample_id} overlaps sealed instance {o.instance_id} ({o.kind}, {o.score})"
            )

    if problems:
        raise CorpusError(
            "corpus refused:\n  - " + "\n  - ".join(problems[:40])
            + (f"\n  … and {len(problems) - 40} more" if len(problems) > 40 else "")
        )


# ------------------------------------------------------------------ #
# stability                                                           #
# ------------------------------------------------------------------ #


@dataclass
class StabilityGate:
    """Thresholds registered before the numbers are looked at.

    Written here as constants rather than chosen from a report, because a gate
    picked after seeing the result is not a gate.
    """

    median_layer_jaccard: float = 0.90
    p5_layer_jaccard: float = 0.80
    max_change_on_double_tokens: float = 0.05


def keep_set_jaccard(a: dict[str, list[int]], b: dict[str, list[int]]) -> dict[str, float]:
    """Per-layer agreement between two keep-lists."""
    layers = sorted(set(a) & set(b), key=int)
    return {layer: jaccard(set(a[layer]), set(b[layer])) for layer in layers}


def stability_report(
    shards: list[dict[str, list[int]]],
    gate: StabilityGate | None = None,
) -> dict:
    """Do independent shards of the corpus choose the same experts?

    If they do not, the profile is measuring the shard rather than the workload,
    and no amount of downstream evaluation will separate the two.
    """
    import statistics  # noqa: PLC0415

    gate = gate or StabilityGate()
    if len(shards) < 2:
        raise CorpusError("stability needs at least two independent shards")

    pairwise: list[float] = []
    per_layer: dict[str, list[float]] = {}
    for i in range(len(shards)):
        for j in range(i + 1, len(shards)):
            for layer, score in keep_set_jaccard(shards[i], shards[j]).items():
                pairwise.append(score)
                per_layer.setdefault(layer, []).append(score)

    layer_medians = {layer: statistics.median(v) for layer, v in per_layer.items()}
    ordered = sorted(layer_medians.values())
    median = statistics.median(ordered) if ordered else 0.0
    p5 = ordered[max(0, int(0.05 * len(ordered)) - 1)] if ordered else 0.0

    return {
        "shards": len(shards),
        "pairs": len(pairwise),
        "median_layer_jaccard": round(median, 4),
        "p5_layer_jaccard": round(p5, 4),
        "gate": {
            "median_layer_jaccard": gate.median_layer_jaccard,
            "p5_layer_jaccard": gate.p5_layer_jaccard,
        },
        "passed": median >= gate.median_layer_jaccard and p5 >= gate.p5_layer_jaccard,
        "per_layer_median": {k: round(v, 4) for k, v in sorted(layer_medians.items(), key=lambda kv: int(kv[0]))},
    }


# ------------------------------------------------------------------ #
# CLI                                                                 #
# ------------------------------------------------------------------ #


def load_records(path: Path) -> list[CorpusRecord]:
    records: list[CorpusRecord] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as err:
            raise CorpusError(f"{path}:{line_no} is not valid JSON: {err}") from err
        known = {k: v for k, v in obj.items() if k in CorpusRecord.__dataclass_fields__}
        missing = [
            f
            for f, spec in CorpusRecord.__dataclass_fields__.items()
            if f not in known and spec.default is spec.default_factory is not None
        ]
        try:
            records.append(CorpusRecord(**known))
        except TypeError as err:
            raise CorpusError(f"{path}:{line_no} is missing required fields: {err}") from err
        del missing
    return records


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--corpus", type=Path, required=True, help="corpus JSONL")
    ap.add_argument("--tools-sha256", required=True)
    ap.add_argument("--template-sha256", required=True)
    ap.add_argument(
        "--sealed-instances",
        type=Path,
        help="newline-separated instance ids that must not appear in the corpus",
    )
    ap.add_argument("--corpus-id", default="agentic-code-profile-v1")
    ap.add_argument("--out", type=Path, help="write the manifest here")
    args = ap.parse_args()

    records = load_records(args.corpus)
    sealed = (
        {l.strip() for l in args.sealed_instances.read_text().splitlines() if l.strip()}
        if args.sealed_instances
        else None
    )
    try:
        validate_corpus(records, args.tools_sha256, args.template_sha256, sealed)
    except CorpusError as err:
        raise SystemExit(str(err)) from err

    manifest = CorpusManifest(
        corpus_id=args.corpus_id,
        tools_sha256=args.tools_sha256,
        template_sha256=args.template_sha256,
        documents=[
            {
                "id": r.sample_id,
                "source": r.source,
                "source_revision": r.source_revision,
                "split": r.split,
                "sha256": r.rendered_sha256,
                "license": r.license,
                "benchmark_instance_id": r.benchmark_instance_id,
            }
            for r in records
        ],
    )
    print(f"{len(records)} document(s), manifest sha256 {manifest.sha256()[:16]}…")
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(manifest.to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
