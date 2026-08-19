#!/usr/bin/env python3
"""Unpacking NVFP4 expert weights.

Only the routed experts in this checkpoint are quantised; attention, the mHC
blocks, the layer norms, the router gate and the shared experts are all stored
as plain BF16. So this module has exactly one job: turn

    weight          U8       [E, out, in/2]   two 4-bit values per byte
    weight_scale    F8_E4M3  [E, out, in/16]  one per group of 16
    weight_scale_2  F32      [E]              one per expert

back into a dense `[out, in]` matrix.

Written here rather than imported from a serving runtime because the profiler
has to run without one, and because a dequantiser is exactly the kind of thing
that is easy to get subtly wrong — a swapped nibble order or an inverted global
scale produces weights that are the right shape, the right order of magnitude
and completely wrong. The tests check it against values computed by hand, and
`--cross-check` compares it against vLLM's implementation where that is
installed.

NVFP4 is E2M1: one sign bit, two exponent bits, one mantissa bit, so eight
magnitudes and no infinities or NaNs. The block scale is E4M3 and the per-expert
scale is FP32, which together restore the dynamic range 4 bits cannot hold.
"""

from __future__ import annotations

# The eight magnitudes E2M1 can represent, indexed by the low three bits.
E2M1_MAGNITUDES = (0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0)

# ModelOpt quantises in groups of 16 along the input dimension.
GROUP_SIZE = 16


def unpack_nibbles(packed: bytes) -> list[int]:
    """Two 4-bit values per byte, low nibble first.

    The order matters and is not guessable: reversing it gives a matrix of the
    right shape whose every pair of adjacent weights is swapped, which reads as
    noise rather than as a bug.
    """
    out: list[int] = []
    for byte in packed:
        out.append(byte & 0x0F)
        out.append((byte & 0xF0) >> 4)
    return out


def nibble_to_float(nibble: int) -> float:
    """One E2M1 code to its value. Sign is bit 3; magnitude is the low three."""
    magnitude = E2M1_MAGNITUDES[nibble & 0x07]
    return -magnitude if nibble & 0x08 else magnitude


def dequantize_reference(
    packed: bytes,
    block_scales: list[float],
    global_scale: float,
    out_features: int,
    in_features: int,
) -> list[list[float]]:
    """A pure-Python dequantiser, for tests to check the fast one against.

    Deliberately slow and obvious. Its only purpose is to be so simple that when
    it and the torch path disagree, the torch path is wrong.
    """
    if in_features % GROUP_SIZE != 0:
        raise ValueError(f"in_features {in_features} is not a multiple of {GROUP_SIZE}")
    values = [nibble_to_float(n) for n in unpack_nibbles(packed)]
    expected = out_features * in_features
    if len(values) != expected:
        raise ValueError(f"unpacked {len(values)} values, expected {expected}")

    groups_per_row = in_features // GROUP_SIZE
    if len(block_scales) != out_features * groups_per_row:
        raise ValueError(
            f"got {len(block_scales)} block scales, expected {out_features * groups_per_row}"
        )

    rows: list[list[float]] = []
    for r in range(out_features):
        row: list[float] = []
        for g in range(groups_per_row):
            scale = block_scales[r * groups_per_row + g] * global_scale
            base = r * in_features + g * GROUP_SIZE
            row.extend(values[base + i] * scale for i in range(GROUP_SIZE))
        rows.append(row)
    return rows


# ------------------------------------------------------------------ #
# torch                                                               #
# ------------------------------------------------------------------ #


def dequantize_expert(packed, block_scale, global_scale, dtype=None):
    """Dequantise one expert's weight matrix.

    Args:
        packed: uint8 `[out, in/2]`
        block_scale: float8_e4m3fn `[out, in/16]`
        global_scale: 0-d or 1-element float32
        dtype: output dtype, defaulting to bfloat16

    Returns:
        `[out, in]` in `dtype`.
    """
    import torch  # noqa: PLC0415

    dtype = dtype or torch.bfloat16
    if packed.dtype != torch.uint8:
        raise ValueError(f"packed weights must be uint8, got {packed.dtype}")

    out_features, packed_in = packed.shape
    in_features = packed_in * 2

    lut = torch.tensor(E2M1_MAGNITUDES, dtype=torch.float32, device=packed.device)
    flat = packed.reshape(-1)
    low = flat & 0x0F
    high = (flat >> 4) & 0x0F
    # Interleaved low-then-high, matching how the values were packed.
    codes = torch.stack((low, high), dim=1).reshape(out_features, in_features)
    magnitudes = lut[(codes & 0x07).long()]
    signed = torch.where((codes & 0x08).bool(), -magnitudes, magnitudes)

    scales = block_scale.to(torch.float32) * global_scale.to(torch.float32).reshape(())
    # One scale per group of 16, broadcast across the group.
    grouped = signed.reshape(out_features, in_features // GROUP_SIZE, GROUP_SIZE)
    return (grouped * scales.unsqueeze(-1)).reshape(out_features, in_features).to(dtype)


def dequantize_layer(packed, block_scale, global_scale, expert: int, dtype=None):
    """One expert out of a `[E, out, in/2]` stack, without materialising the rest.

    Indexing first is the whole point: the stack for a single layer is 2 GB
    packed and 12 GB dequantised, and the loop that uses this touches one expert
    at a time.
    """
    return dequantize_expert(
        packed[expert], block_scale[expert], global_scale[expert], dtype=dtype
    )


def cross_check(packed, block_scale, global_scale) -> float:
    """Largest absolute disagreement with vLLM's dequantiser, where available.

    Returns -1.0 when vLLM is not installed. A second implementation is the only
    practical check on a format whose errors all look like plausible weights.
    """
    try:
        import torch  # noqa: PLC0415
        from vllm.model_executor.layers.quantization.utils.nvfp4_emulation_utils import (  # noqa: PLC0415
            dequantize_to_dtype,
        )
    except ImportError:
        return -1.0

    mine = dequantize_expert(packed, block_scale, global_scale, dtype=torch.float32)
    theirs = dequantize_to_dtype(
        packed.unsqueeze(0),
        block_scale.unsqueeze(0),
        global_scale.reshape(1),
        torch.float32,
        block_size=GROUP_SIZE,
        # The serving path stores block scales in a swizzled layout for the
        # tensor cores. On disk they are linear, so this must be off — with it
        # on, the comparison silently reorders one side and reports a huge
        # difference that says nothing about either implementation.
        swizzle=False,
    ).squeeze(0)
    return float((mine - theirs).abs().max())
