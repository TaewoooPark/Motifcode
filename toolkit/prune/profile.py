#!/usr/bin/env python3
"""Collect routing statistics from Motif-3, per layer and per expert.

This is step one of pruning. You cannot choose which experts to keep until you
know what each one is used for, and "used" has to be measured on the workload
the pruned model will actually serve.

Why frequency alone is not enough
---------------------------------
Motif-3 was trained with explicit load balancing — an auxiliary-loss-free
expert-selection bias plus a sequence-wise balancing loss — so expert usage is
deliberately close to uniform. There are no rarely-used experts to find. Ranking
by raw frequency will hand you noise.

The signal is *contrastive*: an expert that fires more on agentic coding than on
general chat is one this model needs for coding, even if both rates are near
1/384. So every statistic here is collected per corpus, and selection (in
`select.py`) works on the ratio between them.

Two statistics, and they differ
-------------------------------
Reading `modeling_motif.py`, selection is `topk(scores + expert_bias)` while the
gate weights returned are `scores.gather(...)` — the raw sigmoid, without the
bias. So:

  * **count** — how often an expert is selected. Includes the load-balancing
    bias, which is exactly the thing that flattens the distribution.
  * **mass** — the summed gate weight an expert receives. The bias does not
    enter it, so this is closer to how much the model actually leans on the
    expert once it has been chosen.

Collect both. They disagree, and which one predicts quality is one of the
things this exercise is meant to find out.

Where to run it
---------------
This needs a full forward pass through the 187 GB checkpoint, so it does not fit
in a GB10's 121.6 GiB. Two options:

  * **Rented GPUs.** Fast, and you want the machine anyway for the SWE-bench
    baseline. Batch both into one session.

  * **GB10 with disk offload.** `modeling_motif.py` declares
    `_no_split_modules = ["MotifDecoderLayer"]`, so accelerate can stream layers
    from NVMe. Profiling is offline and throughput-insensitive — a few tokens
    per second is fine when you only need tens of thousands of tokens total and
    nobody is waiting. Try this first: it costs an evening instead of a rental.

Output
------
A JSON file per corpus:

    {"corpus": "target", "tokens": 51234,
     "layers": {"3": {"count": [...384 ints...], "mass": [...384 floats...]}, ...}}

`select.py` consumes two of these.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def iter_documents(path: Path) -> list[str]:
    """Read a corpus.

    JSONL with a `text` field, or plain text split on blank lines. Deliberately
    dumb: the corpus content matters, the format does not.
    """
    raw = path.read_text(encoding="utf-8")
    if path.suffix == ".jsonl":
        docs = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            text = obj.get("text") or obj.get("content") or ""
            if text:
                docs.append(text)
        return docs
    return [d.strip() for d in raw.split("\n\n") if d.strip()]


class RoutingCollector:
    """Accumulates per-layer, per-expert counts and gate mass.

    Hooks `MoE.forward`, which returns `(top_scores, selected_experts_indices,
    num_tokens_per_expert)` — the counts are already computed by the model, so
    the hook is cheap and cannot drift from what routing actually did.
    """

    def __init__(self, num_experts: int):
        self.num_experts = num_experts
        self.count: dict[int, list[int]] = defaultdict(lambda: [0] * num_experts)
        self.mass: dict[int, list[float]] = defaultdict(lambda: [0.0] * num_experts)
        self.tokens = 0
        self._handles: list = []

    def attach(self, model) -> None:
        """Register a forward hook on every MoE block."""
        import torch  # noqa: PLC0415

        layer_of: dict[int, int] = {}
        for name, module in model.named_modules():
            if module.__class__.__name__ != "MoE":
                continue
            # `model.layers.<n>.moe` -> n
            parts = name.split(".")
            idx = next((int(p) for p in parts if p.isdigit()), -1)
            layer_of[id(module)] = idx

        def hook(module, _inputs, output):  # noqa: ANN001
            del output  # the useful values come from the router, called inside
            return None

        # The MoE block's own return value is the mixed hidden state, not the
        # routing. Hook the router instead: it returns exactly what we need.
        for name, module in model.named_modules():
            if module.__class__.__name__ != "TokenChoiceTopKRouter":
                continue
            parts = name.split(".")
            idx = next((int(p) for p in parts if p.isdigit()), -1)

            def make_hook(layer_idx: int):
                def router_hook(_module, _inputs, output):  # noqa: ANN001
                    top_scores, selected, _per_expert = output
                    sel = selected.detach().to("cpu").reshape(-1)
                    sco = top_scores.detach().to(torch.float32).to("cpu").reshape(-1)
                    counts = self.count[layer_idx]
                    masses = self.mass[layer_idx]
                    for e, s in zip(sel.tolist(), sco.tolist()):
                        counts[e] += 1
                        masses[e] += s
                    return None

                return router_hook

            self._handles.append(module.register_forward_hook(make_hook(idx)))
        del hook, layer_of

    def detach(self) -> None:
        for h in self._handles:
            h.remove()
        self._handles.clear()

    def to_json(self, corpus: str) -> dict:
        return {
            "corpus": corpus,
            "tokens": self.tokens,
            "num_experts": self.num_experts,
            "layers": {
                str(layer): {"count": self.count[layer], "mass": self.mass[layer]}
                for layer in sorted(self.count)
            },
        }


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--model", required=True, help="checkpoint path or HF id")
    ap.add_argument("--corpus", type=Path, required=True, help=".jsonl or .txt")
    ap.add_argument("--name", required=True, help="corpus label: target | reference")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--max-tokens", type=int, default=50_000, help="stop after this many")
    ap.add_argument("--seq-len", type=int, default=2048)
    ap.add_argument(
        "--offload-folder",
        type=Path,
        help="stream layers from here; needed on a box that cannot hold the model",
    )
    args = ap.parse_args()

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        sys.exit("needs torch and transformers on the machine that holds the weights")

    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    load_kwargs: dict = {"trust_remote_code": True, "dtype": torch.bfloat16, "device_map": "auto"}
    if args.offload_folder:
        args.offload_folder.mkdir(parents=True, exist_ok=True)
        load_kwargs["offload_folder"] = str(args.offload_folder)
    model = AutoModelForCausalLM.from_pretrained(args.model, **load_kwargs)
    model.eval()

    collector = RoutingCollector(num_experts=model.config.num_experts)
    collector.attach(model)

    docs = iter_documents(args.corpus)
    print(f"{len(docs)} documents, target {args.max_tokens} tokens", file=sys.stderr)

    with torch.no_grad():
        for i, doc in enumerate(docs):
            if collector.tokens >= args.max_tokens:
                break
            ids = tok(doc, return_tensors="pt", truncation=True, max_length=args.seq_len)
            n = int(ids["input_ids"].shape[-1])
            model(**{k: v.to(model.device) for k, v in ids.items()})
            collector.tokens += n
            if i % 10 == 0:
                print(f"  {i} docs, {collector.tokens} tokens", file=sys.stderr)

    collector.detach()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(collector.to_json(args.name)), encoding="utf-8")
    print(f"wrote {args.out} ({collector.tokens} tokens)", file=sys.stderr)


if __name__ == "__main__":
    main()
