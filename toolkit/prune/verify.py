#!/usr/bin/env python3
"""Prove the surgery did not change the model, before asking whether it is good.

A pruning run has two ways to go wrong and they look alike from the outside:

  * the surgery is buggy — a tensor was missed, the keep-list was misordered,
    the router and its bias disagree about which expert is which;
  * the surgery is correct and the model is simply worse without those experts.

Only the second is a result. The first is a bug, and mistaking one for the other
costs a rental and a wrong conclusion. This script separates them.

The argument
------------
Patch the *original* model's router so that dropped experts score minus
infinity. It then routes only inside the keep-list. Compare it with the pruned
model on the same inputs.

The two must agree, and the reason is exact rather than approximate:

  * Selection. The pruned router's gate rows are the kept rows of the original,
    and its `expert_bias` is the kept slice of the original. So
    `topk(scores + bias)` ranges over identical values and picks the same
    experts.
  * Gate weights. `top_scores` are gathered from the raw sigmoid, then
    `route_norm` normalises over the selected k. Same k, same values, same
    normaliser.
  * Expert weights. Pruned expert j *is* original expert keep[j], byte for byte.

So any disagreement beyond floating-point noise is a bug in the surgery.

What counts as passing
----------------------
Next-token argmax must match on every position. That is not negotiable.

Logit differences must be small but need not be zero: `num_experts` changes the
shapes the fused MoE kernels see, and they may take a different path. Around
1e-2 is normal; 1e+0 means something is wrong.

Where to run it
---------------
Needs both checkpoints resident, so it wants the same machine that did the
surgery. A few hundred tokens is enough — this is a correctness check, not an
evaluation.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_PROMPTS = [
    "def binary_search(xs, target):\n    lo, hi = 0, len(xs)\n",
    "The following patch fixes a race condition in the retry loop:\n",
    "다음 함수는 역방향 스윕에서 배경 제거가 동작하지 않는다.\n",
    "$ rg -n 'ohe_subtract' backend/\n",
]


def patch_router_to_keep(model, keep_per_layer: dict[str, list[int]]) -> list:
    """Make the original model route only inside the keep-list.

    Returns hook handles so the caller can undo it. Implemented as a forward
    *pre*-hook on the gate's parent router: we cannot easily rewrite the router's
    body, so instead we mask by writing -inf into the gate weight's output via a
    wrapper on `torch.topk` inputs. The simplest reliable way is to zero the
    dropped rows of the gate and push their bias to -inf, which produces the same
    selection because sigmoid(0) = 0.5 is then always beaten by the +inf-relative
    bias of kept experts.

    That last trick is subtle enough to be worth avoiding: instead we replace the
    router's `forward` with a masked copy. Explicit, and it cannot be wrong in a
    way that hides.
    """
    import torch  # noqa: PLC0415
    import torch.nn.functional as F  # noqa: PLC0415

    handles: list = []
    for name, module in model.named_modules():
        if module.__class__.__name__ != "TokenChoiceTopKRouter":
            continue
        layer = next((int(p) for p in name.split(".") if p.isdigit()), None)
        keep = keep_per_layer.get(str(layer))
        if keep is None:
            raise ValueError(f"no keep-list for layer {layer}")

        mask = torch.full((module.gate.weight.shape[0],), float("-inf"))
        mask[torch.tensor(keep, dtype=torch.long)] = 0.0
        module._motifcode_mask = mask  # noqa: SLF001

        original_forward = module.forward

        def masked_forward(x, expert_bias=None, _m=module, _orig=original_forward):
            scores = F.linear(x.to(torch.float32), _m.gate.weight.to(torch.float32))
            scores = torch.sigmoid(scores)
            mask_ = _m._motifcode_mask.to(scores.device)  # noqa: SLF001
            biased = scores + mask_
            if expert_bias is not None:
                biased = biased + expert_bias
            _, selected = torch.topk(biased, k=_m.experts_top_k, dim=1)
            top = scores.gather(dim=1, index=selected)
            if _m.route_norm:
                top = top / (top.sum(dim=-1, keepdim=True) + 1e-20)
            top = top * _m.route_scale
            per_expert = torch.bincount(selected.reshape(-1), minlength=scores.shape[1])
            return top, selected, per_expert

        module.forward = masked_forward  # type: ignore[method-assign]
        handles.append((module, original_forward))
    return handles


def restore(handles: list) -> None:
    for module, original in handles:
        module.forward = original  # type: ignore[method-assign]


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--original", required=True, help="unpruned checkpoint")
    ap.add_argument("--pruned", required=True, help="pruned checkpoint")
    ap.add_argument("--keep", type=Path, required=True, help="keep-list used for the surgery")
    ap.add_argument("--prompts", type=Path, help="one prompt per line; defaults to a built-in set")
    ap.add_argument("--logit-tol", type=float, default=5e-2)
    ap.add_argument("--offload-folder", type=Path)
    args = ap.parse_args()

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        sys.exit("needs torch and transformers on the machine that holds the weights")

    loaded = json.loads(args.keep.read_text())
    keep_per_layer = loaded["layers"] if isinstance(loaded, dict) and "layers" in loaded else loaded
    if isinstance(keep_per_layer, list):
        sys.exit("keep-list must be per layer; pass select.py's output")

    prompts = (
        [l for l in args.prompts.read_text().splitlines() if l.strip()]
        if args.prompts
        else DEFAULT_PROMPTS
    )

    load_kwargs: dict = {"trust_remote_code": True, "dtype": torch.bfloat16, "device_map": "auto"}
    if args.offload_folder:
        args.offload_folder.mkdir(parents=True, exist_ok=True)
        load_kwargs["offload_folder"] = str(args.offload_folder)

    tok = AutoTokenizer.from_pretrained(args.pruned, trust_remote_code=True)

    print("loading pruned…", file=sys.stderr)
    pruned = AutoModelForCausalLM.from_pretrained(args.pruned, **load_kwargs).eval()
    pruned_logits = []
    with torch.no_grad():
        for p in prompts:
            ids = tok(p, return_tensors="pt")
            out = pruned(**{k: v.to(pruned.device) for k, v in ids.items()})
            pruned_logits.append(out.logits.detach().float().cpu())
    del pruned
    torch.cuda.empty_cache()

    print("loading original…", file=sys.stderr)
    original = AutoModelForCausalLM.from_pretrained(args.original, **load_kwargs).eval()
    handles = patch_router_to_keep(original, keep_per_layer)

    worst = 0.0
    mismatches = 0
    positions = 0
    with torch.no_grad():
        for p, ref in zip(prompts, pruned_logits):
            ids = tok(p, return_tensors="pt")
            out = original(**{k: v.to(original.device) for k, v in ids.items()})
            got = out.logits.detach().float().cpu()
            worst = max(worst, float((got - ref).abs().max()))
            same = (got.argmax(-1) == ref.argmax(-1)).sum().item()
            positions += got.shape[1]
            mismatches += got.shape[1] - same
    restore(handles)

    print()
    print(f"positions        {positions}")
    print(f"argmax mismatch  {mismatches}")
    print(f"max |Δlogit|     {worst:.4g}  (tolerance {args.logit_tol})")
    print()
    if mismatches > 0:
        print("FAIL — the pruned model does not reproduce the original's choices.")
        print("       This is a surgery bug, not a quality loss. Check that all ten")
        print("       expert-dimension tensors were sliced, that the keep-list is")
        print("       sorted ascending, and that expert_bias and act_fn.weight/bias")
        print("       were sliced with the same list as the projections.")
        sys.exit(1)
    if worst > args.logit_tol:
        print("WARN — argmax agrees but the logits drift more than expected.")
        print("       Likely a kernel path difference from the changed expert count;")
        print("       treat as suspicious rather than fatal, and check a longer corpus.")
        sys.exit(2)
    print("PASS — the surgery is faithful. Quality evaluation can begin.")


if __name__ == "__main__":
    main()
