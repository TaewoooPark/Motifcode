#!/usr/bin/env python3
"""Cutting the expert bank, as a transaction.

Slices the routed-expert dimension of an NVFP4 Motif-3 checkpoint down to a
keep-list, producing a smaller model that still runs through the stock NVFP4
path — no new kernels, no new quantisation format.

Roughly 98% of Motif-3's 314B parameters are routed experts: 51 MoE layers ×
384 experts. Everything else — attention, the dense first layers, the shared
experts, mHC, the MTP head — is a few billion. So the size problem is entirely
an expert-bank problem.

## What gets cut

Ten tensors per MoE layer carry the expert dimension inside
`model.safetensors.index.json`. **They are not all of them.** Two more per layer
live in `nvfp4_act_scales.safetensors`, a sidecar the index does not mention:

    model.layers.{L}.moe.experts.a13_gscale   F32 [384]
    model.layers.{L}.moe.experts.a2_gscale    F32 [384]

    indexed expert-axis tensors    510   (10 × 51 layers)
    sidecar tensors                102   ( 2 × 51 layers)
    total                          612

Missing them is not a crash. The loader falls back to a gscale of 1 when the
sidecar is absent, and — worse — copying the original `[384]` sidecar through
unsliced *looks* right and is not: a single-rank loader takes the first `K`
entries, so survivor `j` gets the activation scale of original expert `j`
rather than of `keep[j]`. The model loads, runs, and is quietly miscalibrated.

## Why a transaction

The previous version created the destination directory and started writing
shards before it had checked the keep-lists or the source schema. A failure
partway through left a directory that looks like a checkpoint, contains a
prefix of one, and has nothing to say about which. Everything here is verified
before a single byte is written, the work happens in a temporary directory on
the same filesystem, and the destination appears in one atomic rename or not at
all.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

# The ten per-layer tensors that carry the expert dimension on axis 0, inside
# the safetensors index. Shapes as read from the real checkpoint headers.
EXPERT_DIM_SUFFIXES = (
    "moe.experts.gate_up_proj",               # U8      [384, 2560, 2048]
    "moe.experts.gate_up_proj_weight_scale",  # F8_E4M3 [384, 2560,  256]
    "moe.experts.gate_up_proj_weight_scale_2",# F32     [384]
    "moe.experts.down_proj",                  # U8      [384, 4096,  640]
    "moe.experts.down_proj_weight_scale",     # F8_E4M3 [384, 4096,   80]
    "moe.experts.down_proj_weight_scale_2",   # F32     [384]
    "moe.experts.act_fn.weight",              #         [384, 3]
    "moe.experts.act_fn.bias",                #         [384, 1]
    "moe.router.gate.weight",                 #         [384, 4096]
    "moe.expert_bias",                        #         [384]
)

# The two per-layer tensors in the sidecar, which the index does not list.
SIDECAR_SUFFIXES = ("moe.experts.a13_gscale", "moe.experts.a2_gscale")
SIDECAR_FILE = "nvfp4_act_scales.safetensors"

LAYER_RE = re.compile(r"model\.layers\.(\d+)\.")

# Runtime assets copied through untouched. The index and config are rebuilt,
# and the sidecar is sliced, so none of the three appears here.
COPY_THROUGH = (
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "generation_config.json",
    "configuration_motif.py",
    "modeling_motif.py",
    "special_tokens_map.json",
    "vocab.json",
    "added_tokens.json",
    "README.md",
    "LICENSE",
)


class SurgeryError(ValueError):
    """A cut that must not happen. Never a warning."""


def is_expert_tensor(name: str) -> bool:
    """True when `name` carries the routed-expert dimension on axis 0."""
    return any(name.endswith(suffix) for suffix in EXPERT_DIM_SUFFIXES)


def is_sidecar_tensor(name: str) -> bool:
    return any(name.endswith(suffix) for suffix in SIDECAR_SUFFIXES)


def layer_of(name: str) -> int | None:
    m = LAYER_RE.search(name)
    return int(m.group(1)) if m else None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------ #
# preflight                                                           #
# ------------------------------------------------------------------ #


@dataclass
class Plan:
    """Everything the surgery will do, decided before it does any of it."""

    source: Path
    destination: Path
    keep: dict[int, list[int]]
    source_experts: int
    target_experts: int
    experts_top_k: int
    moe_layers: list[int]
    indexed_tensors: int
    indexed_sliced: int
    sidecar_sliced: int
    shards: list[str]
    expected_bytes: int
    config_sha256: str
    index_sha256: str
    sidecar_sha256: str
    copy_through: list[str] = field(default_factory=list)

    @property
    def ratio(self) -> float:
        return self.target_experts / self.source_experts

    def hash(self) -> str:
        """Identity of this plan, so a resumed run cannot continue a different one."""
        return hashlib.sha256(
            json.dumps(
                {
                    "source_sha": self.index_sha256,
                    "config_sha": self.config_sha256,
                    "sidecar_sha": self.sidecar_sha256,
                    "keep": {str(k): v for k, v in sorted(self.keep.items())},
                    "target_experts": self.target_experts,
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()

    def report(self) -> str:
        return "\n".join(
            [
                f"experts       {self.source_experts} -> {self.target_experts}  ({self.ratio:.1%} kept)",
                f"MoE layers    {len(self.moe_layers)}  ({self.moe_layers[0]}..{self.moe_layers[-1]})",
                f"indexed       {self.indexed_sliced} sliced of {self.indexed_tensors}",
                f"sidecar       {self.sidecar_sliced} sliced",
                f"total sliced  {self.indexed_sliced + self.sidecar_sliced}",
                f"shards        {len(self.shards)}",
                f"output        ~{self.expected_bytes / 1e9:.1f} GB",
                f"plan          {self.hash()[:16]}…",
            ]
        )


def _tensor_headers(path: Path) -> dict[str, dict]:
    """Read a safetensors header without touching the payload."""
    import struct  # noqa: PLC0415

    with open(path, "rb") as f:
        length = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(length))
    header.pop("__metadata__", None)
    return header


def preflight(
    source: Path,
    destination: Path,
    keep: dict[str, list[int]],
    target_experts: int | None = None,
) -> Plan:
    """Check everything, create nothing.

    Every problem is collected rather than raised at the first one: fixing a
    keep-list one error per run, when each run needs the checkpoint mounted, is
    a bad way to spend an afternoon.
    """
    source = Path(source)
    destination = Path(destination)
    problems: list[str] = []

    for required in ("config.json", "model.safetensors.index.json", SIDECAR_FILE):
        if not (source / required).exists():
            problems.append(f"{source / required} is missing")
    if problems:
        raise SurgeryError("; ".join(problems))

    config = json.loads((source / "config.json").read_text())
    index = json.loads((source / "model.safetensors.index.json").read_text())
    weight_map: dict[str, str] = index["weight_map"]

    source_experts = int(config["num_experts"])
    experts_top_k = int(config["experts_top_k"])

    expert_names = [n for n in weight_map if is_expert_tensor(n)]
    layers = sorted({l for n in expert_names if (l := layer_of(n)) is not None})

    # Exactly ten expert-axis tensors per MoE layer. A layer with nine means a
    # suffix was renamed upstream and one tensor would be copied through at full
    # size — a checkpoint that loads and routes to experts that are not there.
    per_layer: dict[int, int] = {}
    for name in expert_names:
        layer = layer_of(name)
        if layer is not None:
            per_layer[layer] = per_layer.get(layer, 0) + 1
    for layer, count in sorted(per_layer.items()):
        if count != len(EXPERT_DIM_SUFFIXES):
            problems.append(
                f"layer {layer} has {count} expert-axis tensors, expected {len(EXPERT_DIM_SUFFIXES)}"
            )

    # The sidecar: two tensors per MoE layer, F32, [source_experts].
    sidecar_header = _tensor_headers(source / SIDECAR_FILE)
    sidecar_layers = sorted({l for n in sidecar_header if (l := layer_of(n)) is not None})
    if sidecar_layers != layers:
        problems.append(
            f"the sidecar covers layers {sidecar_layers[:3]}…{sidecar_layers[-3:] if sidecar_layers else []} "
            f"but the index covers {layers[:3]}…{layers[-3:]}"
        )
    expected_sidecar = len(layers) * len(SIDECAR_SUFFIXES)
    if len(sidecar_header) != expected_sidecar:
        problems.append(
            f"the sidecar has {len(sidecar_header)} tensors, expected {expected_sidecar} "
            f"({len(SIDECAR_SUFFIXES)} per layer × {len(layers)} layers)"
        )
    for name, meta in sidecar_header.items():
        if not is_sidecar_tensor(name):
            problems.append(f"unexpected sidecar tensor {name}")
        if tuple(meta["shape"]) != (source_experts,):
            problems.append(f"{name}: shape {tuple(meta['shape'])}, expected ({source_experts},)")
        if meta["dtype"] != "F32":
            problems.append(f"{name}: dtype {meta['dtype']}, expected F32")

    # Keep-lists: one per MoE layer, sorted, unique, in range, uniform in size.
    normalised: dict[int, list[int]] = {}
    sizes: set[int] = set()
    for key, ids in keep.items():
        try:
            layer = int(key)
        except (TypeError, ValueError):
            problems.append(f"keep-list key {key!r} is not a layer number")
            continue
        normalised[layer] = list(ids)
        sizes.add(len(ids))
        if list(ids) != sorted(ids):
            problems.append(
                f"layer {layer}: keep-list is not sorted ascending. Expert order is preserved "
                "so the router's surviving logits keep their relative meaning"
            )
        if len(set(ids)) != len(ids):
            problems.append(f"layer {layer}: keep-list has duplicates")
        if ids and (min(ids) < 0 or max(ids) >= source_experts):
            problems.append(f"layer {layer}: keep-list out of range for {source_experts} experts")
        if len(ids) < experts_top_k:
            problems.append(
                f"layer {layer}: {len(ids)} experts is below top_k={experts_top_k}; "
                "a MoE layer with fewer experts than the router selects is a crash, not a smaller model"
            )

    missing = set(layers) - set(normalised)
    extra = set(normalised) - set(layers)
    if missing:
        problems.append(f"no keep-list for MoE layer(s) {sorted(missing)}")
    if extra:
        problems.append(f"keep-list for non-MoE layer(s) {sorted(extra)}")

    if len(sizes) > 1:
        problems.append(
            f"layers keep different expert counts {sorted(sizes)}. `num_experts` is a single "
            "config value that the loader, the tensor shapes, the sidecar and the fused kernels "
            "all read, so a per-layer keep-list has to be uniform in size"
        )
    resolved_target = target_experts if target_experts is not None else (sizes.pop() if len(sizes) == 1 else 0)
    if target_experts is not None and sizes and target_experts not in sizes:
        problems.append(f"--experts {target_experts} does not match the keep-list size")

    # Destination must not already hold something.
    if destination.exists() and any(destination.iterdir()):
        problems.append(f"{destination} exists and is not empty")

    if problems:
        raise SurgeryError(
            "preflight refused:\n  - " + "\n  - ".join(problems[:30])
            + (f"\n  … and {len(problems) - 30} more" if len(problems) > 30 else "")
        )

    shards = sorted(set(weight_map.values()))
    source_bytes = sum((source / s).stat().st_size for s in shards)
    # Expert tensors dominate, and they shrink by the keep ratio. Everything
    # else is carried through, so this is an estimate rather than arithmetic.
    ratio = resolved_target / source_experts
    expected_bytes = int(source_bytes * (0.02 + 0.98 * ratio))

    return Plan(
        source=source,
        destination=destination,
        keep=normalised,
        source_experts=source_experts,
        target_experts=resolved_target,
        experts_top_k=experts_top_k,
        moe_layers=layers,
        indexed_tensors=len(weight_map),
        indexed_sliced=len(expert_names),
        sidecar_sliced=len(sidecar_header),
        shards=shards,
        expected_bytes=expected_bytes,
        config_sha256=sha256_file(source / "config.json"),
        index_sha256=sha256_file(source / "model.safetensors.index.json"),
        sidecar_sha256=sha256_file(source / SIDECAR_FILE),
        copy_through=[f for f in COPY_THROUGH if (source / f).exists()],
    )


def check_disk(plan: Plan, margin: float = 1.15) -> None:
    """Refuse before writing rather than 90% of the way through."""
    parent = plan.destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(parent).free
    needed = int(plan.expected_bytes * margin)
    if free < needed:
        raise SurgeryError(
            f"{parent} has {free / 1e9:.1f} GB free; this needs about {needed / 1e9:.1f} GB "
            f"(output plus a {int((margin - 1) * 100)}% margin for the temporary directory)"
        )


# ------------------------------------------------------------------ #
# slicing                                                             #
# ------------------------------------------------------------------ #


def slice_state_dict(tensors: dict, keep: list[int]):
    """Slice every expert-dimension tensor. Torch only; imported lazily."""
    import torch  # noqa: PLC0415

    idx = torch.tensor(keep, dtype=torch.long)
    out = {}
    for name, t in tensors.items():
        if is_expert_tensor(name):
            if t.shape[0] < max(keep) + 1:
                raise SurgeryError(f"{name}: axis 0 is {t.shape[0]}, keep-list needs {max(keep) + 1}")
            out[name] = t.index_select(0, idx).contiguous()
        else:
            out[name] = t
    return out


def slice_sidecar(source: Path, destination: Path, plan: Plan) -> int:
    """Slice the activation scales with the same keep-list as the weights.

    The failure this prevents is silent. Copy the original `[384]` tensors
    through and the model loads: a single-rank loader takes the first `K`
    entries, so survivor `j` receives the activation scale belonging to
    original expert `j` instead of to `keep[j]`. Nothing errors; the numerics
    are simply wrong.
    """
    from safetensors.torch import load_file, save_file  # noqa: PLC0415
    import torch  # noqa: PLC0415

    tensors = load_file(str(source / SIDECAR_FILE))
    out: dict = {}
    for name in sorted(tensors):
        layer = layer_of(name)
        if layer is None or layer not in plan.keep:
            raise SurgeryError(f"sidecar tensor {name} belongs to no MoE layer in the keep-list")
        idx = torch.tensor(plan.keep[layer], dtype=torch.long)
        out[name] = tensors[name].index_select(0, idx).contiguous()
    save_file(out, str(destination / SIDECAR_FILE))
    return len(out)


def rewrite_config(config: dict, keep: int, plan: Plan | None = None) -> dict:
    """Point the config at the smaller expert bank.

    `experts_top_k` is deliberately unchanged: pruning changes how many experts
    exist, not how many are consulted per token, so activated parameters — and
    therefore decode speed — are the same.
    """
    out = dict(config)
    out["num_experts"] = keep
    out["motifcode_pruning"] = {
        "pruned_from": config.get("num_experts"),
        "pruned_to": keep,
        **({"plan_sha256": plan.hash()} if plan else {}),
    }
    return out


# ------------------------------------------------------------------ #
# the transaction                                                     #
# ------------------------------------------------------------------ #


class ShardJournal:
    """Which shards are finished, and what they hashed to.

    A resumed run reuses a shard only when the plan matches *and* the file on
    disk still hashes to what the journal says. Trusting the journal alone would
    accept a shard that was truncated when the process died.
    """

    def __init__(self, path: Path, plan_hash: str):
        self.path = path
        self.plan_hash = plan_hash
        self.entries: dict[str, dict] = {}
        if path.exists():
            for line in path.read_text().splitlines():
                if not line.strip():
                    continue
                record = json.loads(line)
                if record.get("plan") == plan_hash:
                    self.entries[record["shard"]] = record

    def completed(self, shard: str, directory: Path) -> bool:
        record = self.entries.get(shard)
        if not record:
            return False
        target = directory / shard
        if not target.exists() or target.stat().st_size != record["file_bytes"]:
            return False
        return sha256_file(target) == record["sha256"]

    def record(self, shard: str, directory: Path, keys: list[str], payload_bytes: int) -> dict:
        target = directory / shard
        entry = {
            "plan": self.plan_hash,
            "shard": shard,
            # Two different numbers, and conflating them put a wrong
            # `total_size` in the index of every resumed build: `file_bytes` is
            # what integrity is checked against, `payload_bytes` is the tensor
            # payload the index reports.
            "file_bytes": target.stat().st_size,
            "payload_bytes": payload_bytes,
            "sha256": sha256_file(target),
            "tensors": len(keys),
        }
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
            f.flush()
            os.fsync(f.fileno())
        self.entries[shard] = entry
        return entry


def apply_surgery(plan: Plan, progress=None) -> dict:
    """Write the pruned checkpoint, or leave nothing behind.

    Work happens in `.<destination>.tmp.<plan-hash>` on the same filesystem, so
    the final step is a rename rather than a copy. A run that dies partway
    leaves a temporary directory that is obviously temporary and a journal that
    says exactly how far it got.
    """
    from safetensors.torch import load_file, save_file  # noqa: PLC0415

    started = time.time()
    temp = plan.destination.parent / f".{plan.destination.name}.tmp.{plan.hash()[:16]}"
    temp.mkdir(parents=True, exist_ok=True)
    journal = ShardJournal(temp / "shard-journal.jsonl", plan.hash())

    weight_map_source = json.loads((plan.source / "model.safetensors.index.json").read_text())["weight_map"]
    new_map: dict[str, str] = {}
    total_bytes = 0
    sliced = 0
    reused = 0

    for i, shard in enumerate(plan.shards):
        names = [n for n, s in weight_map_source.items() if s == shard]
        for name in names:
            new_map[name] = shard

        if journal.completed(shard, temp):
            reused += 1
            total_bytes += journal.entries[shard]["payload_bytes"]
            sliced += sum(1 for n in names if is_expert_tensor(n))
            if progress:
                progress(i, len(plan.shards), shard, True)
            continue

        tensors = load_file(str(plan.source / shard))
        out: dict = {}
        for name, tensor in tensors.items():
            if is_expert_tensor(name):
                layer = layer_of(name)
                keep = plan.keep.get(layer)
                if keep is None:
                    raise SurgeryError(f"no keep-list for layer {layer} (tensor {name})")
                if tensor.shape[0] != plan.source_experts:
                    raise SurgeryError(
                        f"{name}: axis 0 is {tensor.shape[0]}, expected {plan.source_experts}. "
                        "The checkpoint layout is not what preflight measured; stop"
                    )
                import torch  # noqa: PLC0415

                out[name] = tensor.index_select(0, torch.tensor(keep, dtype=torch.long)).contiguous()
                sliced += 1
            else:
                out[name] = tensor
        save_file(out, str(temp / shard), metadata={"format": "pt"})
        payload = sum(t.numel() * t.element_size() for t in out.values())
        journal.record(shard, temp, list(out), payload)
        total_bytes += payload
        del tensors, out
        if progress:
            progress(i, len(plan.shards), shard, False)

    # The sidecar, with the same keep-list. Not optional and not a copy.
    sidecar_count = slice_sidecar(plan.source, temp, plan)

    (temp / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": {"total_size": total_bytes}, "weight_map": new_map}, indent=2)
    )
    config = json.loads((plan.source / "config.json").read_text())
    (temp / "config.json").write_text(
        json.dumps(rewrite_config(config, plan.target_experts, plan), indent=2)
    )
    for name in plan.copy_through:
        shutil.copy2(plan.source / name, temp / name)

    manifest = build_manifest(plan, temp, sliced, sidecar_count, total_bytes, time.time() - started)
    (temp / "pruning_manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    _fsync_tree(temp)
    (temp / "shard-journal.jsonl").unlink(missing_ok=True)
    # One rename. Either the destination is a whole checkpoint or it does not
    # exist; there is no state in between for anyone to mistake for one.
    temp.rename(plan.destination)
    _fsync_dir(plan.destination.parent)
    return manifest


def _fsync_tree(directory: Path) -> None:
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            fd = os.open(path, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    _fsync_dir(directory)


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def build_manifest(
    plan: Plan,
    directory: Path,
    sliced: int,
    sidecar_sliced: int,
    total_bytes: int,
    elapsed: float,
) -> dict:
    """Enough provenance to trace any output byte back to its source."""
    files = []
    for path in sorted(directory.rglob("*")):
        if path.is_file() and path.name != "shard-journal.jsonl":
            files.append(
                {
                    "path": str(path.relative_to(directory)),
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
    return {
        "schema_version": "motif-pruned-checkpoint/v1",
        "source": {
            "repo_id": "Motif-Technologies/Motif-3-NVFP4",
            "config_sha256": plan.config_sha256,
            "index_sha256": plan.index_sha256,
            "sidecar_sha256": plan.sidecar_sha256,
        },
        "architecture": {
            "source_num_experts": plan.source_experts,
            "target_num_experts": plan.target_experts,
            "experts_top_k": plan.experts_top_k,
            "moe_layers": plan.moe_layers,
        },
        "selection": {
            "plan_sha256": plan.hash(),
            "layers": {str(k): v for k, v in sorted(plan.keep.items())},
        },
        "surgery": {
            "indexed_tensors": plan.indexed_tensors,
            "indexed_sliced": sliced,
            "sidecar_sliced": sidecar_sliced,
            "total_sliced": sliced + sidecar_sliced,
            "unchanged_indexed": plan.indexed_tensors - sliced,
            "output_bytes": total_bytes,
            "elapsed_seconds": round(elapsed, 1),
        },
        "files": files,
    }


# ------------------------------------------------------------------ #
# CLI                                                                 #
# ------------------------------------------------------------------ #


def load_keep(path: Path) -> dict[str, list[int]]:
    loaded = json.loads(Path(path).read_text())
    if isinstance(loaded, dict) and "layers" in loaded:
        return {str(k): list(v) for k, v in loaded["layers"].items()}
    raise SurgeryError(
        f"{path} is not a keep-list document. Pass the output of select_experts.py, which "
        "records the criterion and its formula alongside the layers"
    )


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--src", type=Path, required=True, help="source checkpoint directory")
    ap.add_argument("--dst", type=Path, required=True, help="write the pruned checkpoint here")
    ap.add_argument("--keep", type=Path, required=True, help="select_experts.py output")
    ap.add_argument("--experts", type=int, help="expected survivor count, as a cross-check")
    ap.add_argument("--apply", action="store_true", help="actually write; default is preflight only")
    args = ap.parse_args()

    try:
        plan = preflight(args.src, args.dst, load_keep(args.keep), args.experts)
    except SurgeryError as err:
        raise SystemExit(str(err)) from err

    print(plan.report())

    if not plan.moe_layers:
        raise SystemExit("no MoE layers found; this is not a Motif checkpoint")

    if not args.apply:
        print("\npreflight only — nothing was read or written. Pass --apply to build.")
        return

    try:
        check_disk(plan)
    except SurgeryError as err:
        raise SystemExit(str(err)) from err

    def progress(i: int, total: int, shard: str, reused: bool) -> None:
        mark = "reused" if reused else "wrote"
        print(f"  [{i + 1}/{total}] {mark} {shard}", flush=True)

    manifest = apply_surgery(plan, progress)
    print(
        f"\n{manifest['surgery']['total_sliced']} tensors sliced "
        f"({manifest['surgery']['indexed_sliced']} indexed + {manifest['surgery']['sidecar_sliced']} sidecar)"
    )
    print(f"wrote {plan.destination} in {manifest['surgery']['elapsed_seconds']}s")


if __name__ == "__main__":
    main()
