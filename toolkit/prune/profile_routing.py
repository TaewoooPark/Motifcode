#!/usr/bin/env python3
"""Collect routing statistics from Motif-3, layer by layer, without holding it.

Named `profile_routing` rather than `profile` because Python ships a stdlib
`profile`, and this directory goes on `sys.path`. Shadowing it breaks
`cProfile`, which `torch._dynamo` imports — an import error thousands of frames
away from anything to do with pruning. `select_experts` is named the same way
round, and for a worse reason: stdlib `select` is imported by `asyncio` and
`subprocess`.

Run it like this:

    python profile.py \
        --checkpoint ~/motif-prune/checkpoints/Motif-3-NVFP4 \
        --modeling ~/motif-prune/ref \
        --corpus corpus/target.jsonl \
        --out prune-work/target/profile.stats.safetensors

`--modeling` points at a directory holding `modeling_motif.py` and
`configuration_motif.py`. Those live in the BF16 `Motif-Technologies/Motif-3`
repository rather than the NVFP4 one, which is the whole reason
`trust_remote_code` cannot find them — `auto_map` in the quantised repository
names a file that repository does not contain.

What the profiler does, in order:

  1. Build the model with the vendor's own classes, on the meta device, with the
     routed-expert parameters left unallocated.
  2. Load every resident tensor: embeddings, attention, mHC, norms, router
     gates, shared experts. About 14 GB.
  3. Embed the corpus, expand for mHC, and keep the hidden states for a whole
     shard.
  4. For each layer: read its packed experts once, apply it to every chunk in
     the shard, record, free.

The lm_head is never built and the MTP head is never loaded. A full `CausalLM`
forward produces 220,160 logits per token — 1.8 GB per 4,096-token batch — that
no routing statistic reads.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.machinery
import importlib.util
import json
import sys
import time
from pathlib import Path

from attention import flash_available, registered_as_flash_attention_2
from stats import ProfileManifest, save_profile
from streaming import (
    CheckpointReader,
    Recorder,
    RoutingStats,
    is_lm_head,
    is_mtp,
    is_streamed,
    make_streaming_experts,
)


def load_tokenizer(checkpoint: Path):
    """The tokenizer and the chat template, without going through AutoConfig.

    `AutoTokenizer.from_pretrained` resolves the model config first, which means
    honouring `auto_map` — and this repository's `auto_map` names a
    `modeling_motif.py` it does not contain. Even with `trust_remote_code`, the
    shipped `configuration_motif.py` and the installed transformers disagree
    about where RoPE parameters live, and the failure surfaces as a missing
    `max_position_embeddings` five frames from anything to do with tokenising.

    None of that is needed here. A tokenizer is `tokenizer.json` plus its
    special tokens, and the chat template is a file. Reading them directly is
    both simpler and immune to a config incompatibility that has nothing to do
    with the profiler.
    """
    from transformers import PreTrainedTokenizerFast  # noqa: PLC0415

    config = json.loads((checkpoint / "tokenizer_config.json").read_text())
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_file=str(checkpoint / "tokenizer.json"),
        bos_token=config.get("bos_token"),
        eos_token=config.get("eos_token"),
        pad_token=config.get("pad_token"),
        additional_special_tokens=config.get("extra_special_tokens", []),
    )
    template_path = checkpoint / "chat_template.jinja"
    if not template_path.exists():
        raise SystemExit(
            f"{template_path} is missing. The corpus has to be rendered with the model's own "
            "template, or the profile describes a prompt nobody sends."
        )
    tokenizer.chat_template = template_path.read_text(encoding="utf-8")
    return tokenizer


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


PACKAGE = "motif_reference"


def load_modeling(modeling_dir: Path):
    """Import the vendor's `modeling_motif` from a directory.

    Imported rather than reimplemented. GDLA attention, the mHC blocks and the
    per-expert PolyNorm are all non-standard, and a reimplementation that is
    subtly wrong changes the hidden states, which changes the routing, which
    makes every statistic here a confident measurement of a different model.

    Loaded as a package, not as two loose modules: `modeling_motif.py` opens
    with `from .configuration_motif import MotifConfig`, and a relative import
    needs a parent package to be relative to. Adding the directory to
    `sys.path` is not enough and fails with an error that names neither file.
    """
    modeling_dir = Path(modeling_dir).resolve()
    for name in ("configuration_motif", "modeling_motif"):
        if not (modeling_dir / f"{name}.py").exists():
            raise SystemExit(
                f"{modeling_dir / (name + '.py')} is missing. It lives in the BF16 repository, "
                f"not the quantised one:\n"
                f"  hf download Motif-Technologies/Motif-3 {name}.py --local-dir {modeling_dir}"
            )

    if PACKAGE not in sys.modules:
        spec = importlib.machinery.ModuleSpec(PACKAGE, None, is_package=True)
        package = importlib.util.module_from_spec(spec)
        package.__path__ = [str(modeling_dir)]
        sys.modules[PACKAGE] = package

    configuration = importlib.import_module(f"{PACKAGE}.configuration_motif")
    modeling = importlib.import_module(f"{PACKAGE}.modeling_motif")
    return modeling, configuration


class LayerMajorProfiler:
    """The forward pass, run one layer at a time over a resident shard."""

    def __init__(self, checkpoint: Path, modeling_dir: Path, device: str = "cuda"):
        import torch  # noqa: PLC0415

        self.torch = torch
        self.device = torch.device(device)
        self.checkpoint = Path(checkpoint)
        self.reader = CheckpointReader(self.checkpoint)
        self.modeling, self.configuration = load_modeling(modeling_dir)

        self.config = self.configuration.MotifConfig(
            **json.loads((self.checkpoint / "config.json").read_text())
        )
        # The model refuses to build under anything but flash attention, and
        # is right to: GDLA is grouped-query with a per-layer sliding window,
        # and both other backends get one of those wrong. The `flash-attn`
        # package has no wheel here, so the registered implementation calls
        # vLLM's vendored kernel — which is the same kernel — and
        # `test_attention.py` checks it against a readable reference.
        ok, source = flash_available()
        if not ok:
            raise SystemExit(
                f"no flash attention kernel is available: {source}\n"
                "GDLA attention needs one; sdpa and eager produce hidden states that are "
                "subtly wrong, which would make every routing statistic here a measurement "
                "of a different model."
            )
        self.attention_source = source
        self.config._attn_implementation = "flash_attention_2"
        # Held open for the profiler's lifetime, not just for construction:
        # the registry entry is what the attention dispatch reads on every
        # forward, and closing it after `__init__` would send the first token
        # through transformers' own path — which looks for a package that is
        # not installed.
        self._attention_ctx = registered_as_flash_attention_2()
        self._attention_ctx.__enter__()

        self.moe_layers = [
            i
            for i in range(self.config.num_hidden_layers)
            if i >= getattr(self.config, "n_dense_first_layers", 0)
            and (i + 1) % self.config.interleave_moe_layer_step == 0
        ]
        self.stats = RoutingStats(self.moe_layers, self.config.num_experts)
        self.recorder = Recorder(self.stats)
        self._build()

    def _build(self) -> None:
        torch = self.torch
        # The checkpoint's dtype, not torch's default.
        #
        # `MotifModel(config)` takes no dtype and builds at the process default,
        # which is float32. Loading bf16 weights into it then upcasts silently:
        # the resident half doubles to ~28 GB, flash attention refuses fp32
        # outright, and — worst of the three — the routing measured is routing
        # at a precision the served model never runs at.
        dtype = getattr(torch, str(self.config.dtype).split(".")[-1])
        self.dtype = dtype

        # Replace the expert block before construction, so the 8 GB-per-layer
        # parameters are never allocated in the first place.
        original = self.modeling.MotifExperts
        self.modeling.MotifExperts = make_streaming_experts(original)
        previous = torch.get_default_dtype()
        torch.set_default_dtype(dtype)
        try:
            with torch.device("meta"):
                self.model = self.modeling.MotifModel(self.config)
        finally:
            torch.set_default_dtype(previous)
            self.modeling.MotifExperts = original

        self.model = self.model.to_empty(device=self.device)
        # One unambiguous witness that the construction above took. The
        # embedding is the model's compute dtype by definition, so if it is not
        # what the checkpoint declares, everything downstream — including every
        # routing decision this profiler exists to measure — is at the wrong
        # precision, and the per-tensor check below would read the discrepancy
        # as deliberate rather than as the build error it is.
        built = self.model.embed_tokens.weight.dtype
        if built != dtype:
            raise SystemExit(
                f"model built at {built}, checkpoint declares {dtype}. Routing measured at a "
                "precision the served model never runs at is not a measurement of it."
            )
        self.model.eval()
        self.promotions: list[str] = []
        self._load_resident()

        self.recorder.instrument(self.model, self.moe_layers)

    def _load_resident(self) -> None:
        """Everything that is not a packed expert, an lm_head or the MTP head."""
        torch = self.torch
        loaded = 0
        resident_bytes = 0
        state = dict(self.model.named_parameters())
        state.update(dict(self.model.named_buffers()))

        for name in self.reader.names():
            if is_streamed(name) or is_mtp(name) or is_lm_head(name):
                continue
            key = name[len("model.") :] if name.startswith("model.") else name
            target = state.get(key)
            if target is None:
                continue
            tensor = self.reader.get(name, self.device)
            if tuple(tensor.shape) != tuple(target.shape):
                raise SystemExit(
                    f"{name}: checkpoint has {tuple(tensor.shape)}, model expects {tuple(target.shape)}"
                )
            # `copy_` casts silently, so a dtype disagreement has to be
            # adjudicated rather than absorbed.
            #
            # There is one legitimate case: the vendor's model declares a
            # parameter at a dtype other than the model's own — `expert_bias`
            # is `torch.float32` in `modeling_motif.py` while the checkpoint
            # ships it bf16 — and widening bf16 to fp32 is exact. Everything
            # else is a discrepancy the profile would hide.
            if tensor.dtype != target.dtype:
                exact = target.dtype == torch.float32 and tensor.dtype in (
                    torch.bfloat16,
                    torch.float16,
                )
                declared = target.dtype != self.dtype
                if not (exact and declared):
                    raise SystemExit(
                        f"{name}: checkpoint is {tensor.dtype}, model expects {target.dtype}. "
                        "Copying would cast silently and profile a different model."
                    )
                self.promotions.append(f"{name}: {tensor.dtype} -> {target.dtype}")
            with torch.no_grad():
                target.copy_(tensor)
            loaded += 1
            resident_bytes += tensor.numel() * tensor.element_size()
            del tensor
        self.resident_bytes = resident_bytes
        self.resident_tensors = loaded
        if self.promotions:
            # Reported, not buried. A lossless widening is still a place where
            # the checkpoint and the architecture disagree.
            kinds = sorted({p.split(": ", 1)[1] for p in self.promotions})
            print(
                f"widened {len(self.promotions)} tensor(s) the model declares at a different "
                f"dtype than the checkpoint ships ({'; '.join(kinds)}), losslessly",
                flush=True,
            )

    # -------------------------------------------------------------- #

    def close(self) -> None:
        """Give transformers back its own attention registry."""
        ctx = getattr(self, "_attention_ctx", None)
        if ctx is not None:
            ctx.__exit__(None, None, None)
            self._attention_ctx = None
        self.reader.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def embed_shard(self, sequences) -> tuple:
        """Steps 1-5 of `MotifModel.forward`, up to the first decoder layer."""
        torch = self.torch
        model = self.model
        hidden_chunks = []
        position_chunks = []
        for input_ids in sequences:
            ids = input_ids.to(self.device).unsqueeze(0)
            embeds = model.embed_tokens(ids)
            cache_position = torch.arange(embeds.shape[1], device=self.device)
            position_ids = cache_position.unsqueeze(0)
            position_embeddings = model.rotary_emb(embeds, position_ids)
            hidden = embeds
            if getattr(model, "mhc_enabled", False):
                hidden = (
                    hidden.unsqueeze(2)
                    .expand(-1, -1, model.mhc_expansion_rate, -1)
                    .contiguous()
                )
            hidden_chunks.append(hidden)
            position_chunks.append((position_ids, position_embeddings, cache_position))
        return hidden_chunks, position_chunks

    def run_shard(self, sequences, progress=None) -> int:
        """Apply every layer to every sequence, one layer at a time."""
        torch = self.torch
        tokens = int(sum(int(s.numel()) for s in sequences))
        with torch.no_grad():
            hidden_chunks, position_chunks = self.embed_shard(sequences)

            for layer_idx, layer in enumerate(self.model.layers):
                staged = None
                if layer_idx in self.stats.index:
                    staged = self.reader.layer_experts(layer_idx, self.device)
                    layer.moe.experts.packed = staged

                for i, hidden in enumerate(hidden_chunks):
                    position_ids, position_embeddings, cache_position = position_chunks[i]
                    out = layer(
                        hidden,
                        attention_mask=None,
                        position_ids=position_ids,
                        past_key_value=None,
                        use_cache=False,
                        cache_position=cache_position,
                        position_embeddings=position_embeddings,
                    )
                    hidden_chunks[i] = out[0]

                if staged is not None:
                    layer.moe.experts.packed = None
                    del staged
                    if self.device.type == "cuda":
                        torch.cuda.empty_cache()
                if progress:
                    progress(layer_idx)

            del hidden_chunks, position_chunks
            if self.device.type == "cuda":
                torch.cuda.empty_cache()
        self.stats.total_tokens += tokens
        return tokens


def read_corpus(path: Path, tokenizer, sequence_length: int, max_tokens: int):
    """Tokenise conversations the harness already rendered.

    The profiler does not apply a chat template. `motif corpus-render` does,
    using the same `renderPrompt` the agent loop calls, so the tokens measured
    here are the tokens the harness puts on the wire — not a second renderer's
    reading of the same messages. Two templates that agree today can drift
    tomorrow, and the drift would show up as a routing profile for a prompt
    nobody sends.
    """
    import torch  # noqa: PLC0415

    sequences = []
    total = 0
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        text = record.get("text")
        if text is None:
            raise SystemExit(
                f"{path}: record {record.get('sample_id', '?')} has no `text`. Render the "
                "corpus first:\n"
                "    motif corpus-render --spec spec.json corpus.jsonl > corpus.rendered.jsonl"
            )
        ids = tokenizer(text, add_special_tokens=False)["input_ids"]
        # Windowed rather than packed across documents: a sequence that spans a
        # document boundary makes the model attend across a break it would
        # never see, and the routing for every token after the boundary is
        # measured under conditions that do not occur.
        for start in range(0, len(ids), sequence_length):
            window = ids[start : start + sequence_length]
            if len(window) < 16:
                continue
            sequences.append(torch.tensor(window, dtype=torch.long))
            total += len(window)
            if total >= max_tokens:
                return sequences, total
    return sequences, total


def load_spec(path: Path, corpus: Path) -> tuple[list, str, str]:
    """The harness's tools and prompt hashes, checked against the corpus.

    A corpus rendered against one tool list and profiled against another is
    measuring a prompt that was never sent, and nothing downstream can see it.
    """
    spec = json.loads(Path(path).read_text())
    tools = spec["tools"]
    tools_sha = spec["toolSchemaSha256"]

    for line in Path(corpus).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("tools_sha256") not in (tools_sha, None):
            raise SystemExit(
                f"{corpus}: record {record.get('sample_id', '?')} was rendered against tool "
                f"schemas {str(record.get('tools_sha256'))[:12]}, but the spec is "
                f"{tools_sha[:12]}. Rebuild the corpus, or profile with the spec it was built from."
            )
    return tools, tools_sha, spec.get("systemPromptSha256", "unrecorded")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument(
        "--modeling",
        type=Path,
        required=True,
        help="directory holding modeling_motif.py and configuration_motif.py",
    )
    ap.add_argument("--corpus", type=Path, required=True, help="rendered conversations, JSONL")
    ap.add_argument(
        "--spec",
        type=Path,
        required=True,
        help="`motif corpus-spec` output: the tool schemas the corpus was rendered against",
    )
    ap.add_argument("--name", default="target", help="corpus label: target | reference")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--max-tokens", type=int, default=50_000)
    ap.add_argument("--seq-len", type=int, default=4096)
    ap.add_argument(
        "--shard-sequences",
        type=int,
        default=8,
        help="sequences held in memory at once; more means fewer passes over the weights",
    )
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--corpus-manifest-sha256", default="")
    ap.add_argument("--tool-schema-sha256", default="")
    args = ap.parse_args()

    started = time.time()
    tokenizer = load_tokenizer(args.checkpoint)
    _tools, tools_sha, _system_sha = load_spec(args.spec, args.corpus)
    sequences, tokens = read_corpus(args.corpus, tokenizer, args.seq_len, args.max_tokens)
    if not sequences:
        raise SystemExit(f"{args.corpus} produced no sequences")
    print(f"{len(sequences)} sequence(s), {tokens} tokens", file=sys.stderr, flush=True)

    profiler = LayerMajorProfiler(args.checkpoint, args.modeling, args.device)
    print(
        f"resident: {profiler.resident_tensors} tensors, "
        f"{profiler.resident_bytes / 1e9:.1f} GB",
        file=sys.stderr,
        flush=True,
    )

    # A shard is 51 layers deep and each layer stages gigabytes of experts, so
    # a run that reports only per-shard is silent for tens of minutes at a
    # time. Without per-layer progress there is no way to tell a slow machine
    # from a hung one, and no throughput number to size the real run from.
    done = 0
    layers = len(profiler.model.layers)
    for start in range(0, len(sequences), args.shard_sequences):
        shard = sequences[start : start + args.shard_sequences]
        shard_started = time.time()
        marks: list[float] = [shard_started]

        def progress(layer_idx: int, _marks=marks, _t0=shard_started) -> None:
            now = time.time()
            fraction = (layer_idx + 1) / layers
            elapsed = now - _t0
            print(
                f"    layer {layer_idx + 1}/{layers}  "
                f"{now - _marks[-1]:5.1f}s  "
                f"({elapsed / 60:.1f}m elapsed, ~{elapsed * (1 - fraction) / fraction / 60:.1f}m left)",
                file=sys.stderr,
                flush=True,
            )
            _marks.append(now)

        profiler.run_shard(shard, progress=progress)
        done += len(shard)
        print(
            f"  {done}/{len(sequences)} sequences  ({(time.time() - shard_started) / 60:.1f}m)",
            file=sys.stderr,
            flush=True,
        )

    import torch  # noqa: PLC0415

    peak_device = (
        int(torch.cuda.max_memory_allocated()) if args.device.startswith("cuda") else 0
    )
    template_path = args.checkpoint / "chat_template.jinja"
    manifest = ProfileManifest(
        source_repo="Motif-Technologies/Motif-3-NVFP4",
        source_revision=(args.checkpoint / ".git-revision").read_text().strip()
        if (args.checkpoint / ".git-revision").exists()
        else "unrecorded",
        config_sha256=sha256_file(args.checkpoint / "config.json"),
        index_sha256=sha256_file(args.checkpoint / "model.safetensors.index.json"),
        sidecar_sha256=sha256_file(args.checkpoint / "nvfp4_act_scales.safetensors"),
        corpus_manifest_sha256=args.corpus_manifest_sha256 or "unrecorded",
        template_sha256=sha256_file(template_path) if template_path.exists() else "unrecorded",
        tool_schema_sha256=args.tool_schema_sha256 or tools_sha,
        backend="layer-major-streaming",
        backend_version=f"1+{profiler.attention_source}",
        num_experts=profiler.config.num_experts,
        experts_top_k=profiler.config.experts_top_k,
        moe_layers=profiler.moe_layers,
        total_tokens=profiler.stats.total_tokens,
        total_sequences=len(sequences),
        sequence_length=args.seq_len,
        packing="per-conversation windows, no cross-document packing",
        seed=0,
        dtype=str(profiler.config.dtype),
        # Recorded because they decide what `gate_sum` means. Motif normalises
        # the selected weights and multiplies by `route_scale`, and the
        # selection bias participates in *which* experts are chosen without
        # entering the returned weight.
        route_norm=bool(profiler.config.route_norm),
        route_scale=float(profiler.config.route_scale),
        gate_sum_includes_route_scale=True,
        selection_bias_applied=True,
        peak_device_bytes=peak_device,
        elapsed_seconds=round(time.time() - started, 1),
    )
    save_profile(args.out, profiler.stats.to_numpy(), manifest)
    print(
        f"wrote {args.out} — {profiler.stats.total_tokens} tokens, "
        f"peak device {peak_device / 1e9:.1f} GB, {manifest.elapsed_seconds}s",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
