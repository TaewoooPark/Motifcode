#!/usr/bin/env python3
"""Attention for the profiler, and a reference to check it against.

`MotifModel.__init__` refuses to build unless `_attn_implementation` is
`flash_attention_2`, and says why: GDLA uses grouped-query attention with a
per-layer sliding window, the eager backend does not repeat KV heads, and the
sdpa backend gets the sliding-window mask wrong. That refusal is load-bearing —
an attention that is subtly wrong changes the hidden states, which changes the
routing, which makes every statistic collected downstream a confident
measurement of a model nobody is serving.

The `flash-attn` package has no wheel for this platform and building it from
source on ARM64 is hours with an uncertain outcome. But vLLM vendors a compiled
FlashAttention, and that is the same kernel. So the adapter below hands the
model's tensors to `vllm.vllm_flash_attn.flash_attn_varlen_func` and registers
itself under the name the model asks for.

`naive_attention` exists because "I used a real flash kernel" is not the same
claim as "I used it correctly". It computes the same thing with an explicit
mask and no kernel at all, and the tests require the two to agree — including
on a sliding-window layer, which is where the window arithmetic can be off by
one without anything looking wrong.
"""

from __future__ import annotations

from contextlib import contextmanager


def flash_available() -> tuple[bool, str]:
    """Whether a usable flash kernel is present, and why not when it is not."""
    try:
        from vllm.vllm_flash_attn import FA2_AVAILABLE, FA3_AVAILABLE  # noqa: PLC0415
    except ImportError as err:
        return False, f"vllm.vllm_flash_attn is not importable: {err}"
    if not (FA2_AVAILABLE or FA3_AVAILABLE):
        return False, "vLLM's flash attention is present but reports no supported version"
    return True, "vllm.vllm_flash_attn"


def flash_attention_via_vllm(
    module,
    query,
    key,
    value,
    attention_mask=None,
    dropout: float = 0.0,
    scaling: float | None = None,
    sliding_window: int | None = None,
    softcap: float | None = None,
    is_causal: bool | None = None,
    **kwargs,
):
    """The `ALL_ATTENTION_FUNCTIONS` interface, backed by vLLM's kernel.

    Inputs arrive as `(batch, heads, seq, dim)` and flash wants
    `(total_tokens, heads, dim)` with explicit sequence boundaries. The profiler
    feeds whole, unpadded sequences, so those boundaries are uniform and the
    conversion is a reshape.
    """
    import torch  # noqa: PLC0415
    from vllm.vllm_flash_attn import flash_attn_varlen_func  # noqa: PLC0415

    if attention_mask is not None:
        # Padding would need per-sequence boundaries, and silently ignoring a
        # mask means attending across a document break — which changes routing
        # for every token after the first padded one.
        raise NotImplementedError(
            "the profiler feeds unpadded sequences; a padding mask reached the attention"
        )

    q = query.transpose(1, 2).contiguous()
    k = key.transpose(1, 2).contiguous()
    v = value.transpose(1, 2).contiguous()
    batch, q_len, heads, head_dim = q.shape
    kv_len = k.shape[1]
    kv_heads = k.shape[2]

    causal = module.is_causal if is_causal is None else is_causal
    cu_q = torch.arange(0, (batch + 1) * q_len, q_len, dtype=torch.int32, device=q.device)
    cu_k = torch.arange(0, (batch + 1) * kv_len, kv_len, dtype=torch.int32, device=q.device)

    extra = {}
    if sliding_window is not None and kv_len > sliding_window:
        # `(w-1, w-1)` matches transformers' own mapping. The right half is
        # irrelevant under causal masking; keeping it identical avoids a
        # difference that would only show up if causality were ever turned off.
        extra["window_size"] = [sliding_window - 1, sliding_window - 1]

    out = flash_attn_varlen_func(
        q.reshape(-1, heads, head_dim),
        k.reshape(-1, kv_heads, head_dim),
        v.reshape(-1, kv_heads, v.shape[-1]),
        max_seqlen_q=q_len,
        cu_seqlens_q=cu_q,
        max_seqlen_k=kv_len,
        cu_seqlens_k=cu_k,
        softmax_scale=scaling,
        causal=causal,
        **extra,
    )
    if isinstance(out, tuple):
        out = out[0]
    return out.reshape(batch, q_len, heads, out.shape[-1]), None


def naive_attention(
    module,
    query,
    key,
    value,
    attention_mask=None,
    dropout: float = 0.0,
    scaling: float | None = None,
    sliding_window: int | None = None,
    softcap: float | None = None,
    is_causal: bool | None = None,
    **kwargs,
):
    """The same attention, written out.

    O(n^2) in memory and useless above a few hundred tokens. Its entire purpose
    is to be obviously correct: grouped-query heads are repeated explicitly, the
    causal and sliding-window masks are built from index arithmetic that can be
    read, and the softmax is a softmax. When this and the flash path disagree,
    the flash path is wrong.
    """
    import torch  # noqa: PLC0415

    if attention_mask is not None:
        raise NotImplementedError("naive_attention does not take a padding mask")

    q, k, v = query, key, value
    heads, kv_heads = q.shape[1], k.shape[1]
    if heads != kv_heads:
        repeat = heads // kv_heads
        k = k.repeat_interleave(repeat, dim=1)
        v = v.repeat_interleave(repeat, dim=1)

    q_len, kv_len = q.shape[2], k.shape[2]
    scale = scaling if scaling is not None else q.shape[-1] ** -0.5
    scores = (q.float() @ k.float().transpose(-1, -2)) * scale

    causal = module.is_causal if is_causal is None else is_causal
    qi = torch.arange(q_len, device=q.device).unsqueeze(-1)
    ki = torch.arange(kv_len, device=q.device).unsqueeze(0)
    allowed = torch.ones(q_len, kv_len, dtype=torch.bool, device=q.device)
    if causal:
        # A query at position i may attend to keys at j <= i. With q_len == kv_len
        # the offset is zero; a shorter query window sits at the end.
        allowed &= ki <= qi + (kv_len - q_len)
    if sliding_window is not None and kv_len > sliding_window:
        allowed &= ki > qi + (kv_len - q_len) - sliding_window

    scores = scores.masked_fill(~allowed, float("-inf"))
    weights = torch.softmax(scores, dim=-1)
    out = weights.to(v.dtype) @ v
    return out.transpose(1, 2), None


@contextmanager
def registered_as_flash_attention_2(implementation=None):
    """Make `flash_attention_2` dispatch to a kernel we have, for a while.

    Two things stand between this profiler and the vendor's own attention.

    Motif's model refuses to build unless `_attn_implementation` is exactly
    `"flash_attention_2"` — a guard that exists for a good reason, since the
    alternatives get GQA or the sliding window wrong.

    Transformers, before that guard runs, checks whether a *distribution* named
    `flash-attn` is installed. It is not, and cannot be: there is no wheel for
    aarch64 with this CUDA and torch. What is installed is vLLM, which vendors
    a compiled FlashAttention — the same kernel, reached by a different import.
    That check has no way to see it.

    So the registry entry is replaced for the duration of construction and the
    distribution check is suspended. The property the guard is protecting —
    that attention is a real flash kernel rather than eager or sdpa — holds;
    only the means of establishing it differs. `test_attention.py` is the part
    that actually earns the claim, by requiring this implementation to agree
    with a readable reference on causal, grouped-query and sliding-window
    attention.

    Scoped to a context manager so nothing outside it inherits a transformers
    that lies about what it has.
    """
    from transformers import modeling_flash_attention_utils as fa_utils  # noqa: PLC0415
    from transformers import modeling_utils as mu  # noqa: PLC0415
    from transformers.modeling_utils import ALL_ATTENTION_FUNCTIONS, PreTrainedModel  # noqa: PLC0415

    name = "flash_attention_2"
    had = name in ALL_ATTENTION_FUNCTIONS.valid_keys()
    previous = ALL_ATTENTION_FUNCTIONS[name] if had else None
    original_check = PreTrainedModel._flash_attn_can_dispatch

    ALL_ATTENTION_FUNCTIONS[name] = implementation or flash_attention_via_vllm
    # Two separate gates, both looking for the same absent distribution: one
    # asks whether it could be dispatched to, the other tries to import its
    # symbols. Neither can see the kernel vLLM vendors, and the registry entry
    # above means neither is consulted for the actual call.
    PreTrainedModel._flash_attn_can_dispatch = lambda self, **kwargs: None

    # Patched in every namespace that holds a reference. `modeling_utils` did
    # `from ..modeling_flash_attention_utils import lazy_import_flash_attention`
    # at import time, so replacing it only in its home module leaves the
    # imported alias untouched — and the alias is the one that gets called.
    noop = lambda *args, **kwargs: None  # noqa: E731
    patched: list[tuple[object, str, object]] = []
    for module in (fa_utils, mu):
        if hasattr(module, "lazy_import_flash_attention"):
            patched.append((module, "lazy_import_flash_attention", module.lazy_import_flash_attention))
            module.lazy_import_flash_attention = noop
    try:
        yield name
    finally:
        PreTrainedModel._flash_attn_can_dispatch = original_check
        for module, attr, original in patched:
            setattr(module, attr, original)
        if had:
            ALL_ATTENTION_FUNCTIONS[name] = previous
