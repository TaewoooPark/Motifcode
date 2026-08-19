"""NVFP4 unpacking, checked against values computed by hand.

A dequantiser is the kind of code where every mistake produces output of the
right shape and a plausible magnitude: swap the nibble order and adjacent
weights trade places, invert the global scale and everything is uniformly wrong
by a constant. Neither looks like a bug downstream — the model simply becomes
worse, which is indistinguishable from the pruning having been a bad idea.

So the reference implementation here is deliberately slow and obvious, the
numbers below were worked out by hand, and the torch path is checked against
both.
"""

from __future__ import annotations

import unittest

from _requires import require
from nvfp4 import (
    E2M1_MAGNITUDES,
    GROUP_SIZE,
    dequantize_reference,
    nibble_to_float,
    unpack_nibbles,
)


class TestCodes(unittest.TestCase):
    def test_the_eight_magnitudes(self):
        # E2M1: one sign, two exponent, one mantissa bit. No infinities, no NaN.
        self.assertEqual(E2M1_MAGNITUDES, (0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0))

    def test_sign_bit_is_bit_three(self):
        self.assertEqual(nibble_to_float(0b0011), 1.5)
        self.assertEqual(nibble_to_float(0b1011), -1.5)
        self.assertEqual(nibble_to_float(0b0111), 6.0)
        self.assertEqual(nibble_to_float(0b1111), -6.0)

    def test_every_code_round_trips(self):
        for code in range(16):
            value = nibble_to_float(code)
            self.assertEqual(abs(value), E2M1_MAGNITUDES[code & 0x07])

    def test_low_nibble_comes_first(self):
        # Not guessable, and reversing it gives a matrix of the right shape
        # whose every adjacent pair of weights is swapped — which reads as
        # noise rather than as a bug.
        self.assertEqual(unpack_nibbles(bytes([0x21])), [0x1, 0x2])
        self.assertEqual(unpack_nibbles(bytes([0x21, 0x43])), [0x1, 0x2, 0x3, 0x4])


class TestReferenceDequantisation(unittest.TestCase):
    def test_one_group_by_hand(self):
        # 16 values in one group: codes 1..8 twice, i.e. magnitudes
        # 0.5 1.0 1.5 2.0 3.0 4.0 6.0 -0.0, repeated.
        codes = [0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8] * 2
        packed = bytes(
            (codes[i + 1] << 4) | codes[i] for i in range(0, len(codes), 2)
        )
        rows = dequantize_reference(packed, [2.0], 3.0, out_features=1, in_features=16)
        expected = [v * 2.0 * 3.0 for v in (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, -0.0)] * 2
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], expected)

    def test_each_group_uses_its_own_scale(self):
        # Two groups on one row, scales 1 and 10: the second half is ten times
        # the first. Getting this wrong is how a whole matrix ends up uniformly
        # mis-scaled while still looking like weights.
        codes = [0x2] * 32  # magnitude 1.0 everywhere
        packed = bytes((codes[i + 1] << 4) | codes[i] for i in range(0, 32, 2))
        rows = dequantize_reference(packed, [1.0, 10.0], 1.0, out_features=1, in_features=32)
        self.assertEqual(rows[0][:GROUP_SIZE], [1.0] * GROUP_SIZE)
        self.assertEqual(rows[0][GROUP_SIZE:], [10.0] * GROUP_SIZE)

    def test_rows_are_independent(self):
        codes = [0x2] * 32
        packed = bytes((codes[i + 1] << 4) | codes[i] for i in range(0, 32, 2))
        rows = dequantize_reference(packed, [1.0, 5.0], 1.0, out_features=2, in_features=16)
        self.assertEqual(rows[0], [1.0] * 16)
        self.assertEqual(rows[1], [5.0] * 16)

    def test_the_global_scale_multiplies_everything(self):
        codes = [0x2] * 16
        packed = bytes((codes[i + 1] << 4) | codes[i] for i in range(0, 16, 2))
        a = dequantize_reference(packed, [1.0], 1.0, 1, 16)
        b = dequantize_reference(packed, [1.0], 7.0, 1, 16)
        self.assertEqual([v * 7.0 for v in a[0]], b[0])

    def test_refuses_a_width_that_is_not_a_multiple_of_the_group(self):
        with self.assertRaisesRegex(ValueError, "multiple of"):
            dequantize_reference(bytes(4), [1.0], 1.0, 1, 8)

    def test_refuses_the_wrong_number_of_block_scales(self):
        codes = [0x2] * 32
        packed = bytes((codes[i + 1] << 4) | codes[i] for i in range(0, 32, 2))
        with self.assertRaisesRegex(ValueError, "block scales"):
            dequantize_reference(packed, [1.0], 1.0, 1, 32)


class TestTorchMatchesReference(unittest.TestCase):
    def test_the_fast_path_agrees_with_the_obvious_one(self):
        require("torch", self)
        import torch

        from nvfp4 import dequantize_expert

        torch.manual_seed(7)
        out_features, in_features = 4, 64
        packed_np = torch.randint(0, 256, (out_features, in_features // 2), dtype=torch.uint8)
        block = torch.rand(out_features, in_features // GROUP_SIZE) + 0.5
        block_f8 = block.to(torch.float8_e4m3fn)
        global_scale = torch.tensor(0.037, dtype=torch.float32)

        got = dequantize_expert(packed_np, block_f8, global_scale, dtype=torch.float32)

        want = dequantize_reference(
            bytes(packed_np.reshape(-1).tolist()),
            [float(v) for v in block_f8.to(torch.float32).reshape(-1)],
            float(global_scale),
            out_features,
            in_features,
        )
        for r in range(out_features):
            for c in range(in_features):
                self.assertAlmostEqual(float(got[r][c]), want[r][c], places=4, msg=f"({r},{c})")

    def test_indexing_one_expert_out_of_a_stack(self):
        require("torch", self)
        import torch

        from nvfp4 import dequantize_expert, dequantize_layer

        experts, out_features, in_features = 3, 2, 32
        packed = torch.randint(0, 256, (experts, out_features, in_features // 2), dtype=torch.uint8)
        block = (torch.rand(experts, out_features, in_features // GROUP_SIZE) + 0.5).to(
            torch.float8_e4m3fn
        )
        global_scale = torch.tensor([0.1, 0.2, 0.3], dtype=torch.float32)

        for e in range(experts):
            got = dequantize_layer(packed, block, global_scale, e, dtype=torch.float32)
            want = dequantize_expert(packed[e], block[e], global_scale[e], dtype=torch.float32)
            self.assertTrue(torch.equal(got, want))

    def test_a_zero_code_stays_zero_whatever_the_scales(self):
        require("torch", self)
        import torch

        from nvfp4 import dequantize_expert

        packed = torch.zeros(1, 8, dtype=torch.uint8)
        block = torch.full((1, 1), 12.0).to(torch.float8_e4m3fn)
        got = dequantize_expert(packed, block, torch.tensor(5.0), dtype=torch.float32)
        self.assertTrue(torch.all(got == 0))

    def test_refuses_a_non_uint8_weight(self):
        require("torch", self)
        import torch

        from nvfp4 import dequantize_expert

        with self.assertRaisesRegex(ValueError, "uint8"):
            dequantize_expert(
                torch.zeros(1, 8, dtype=torch.int8),
                torch.ones(1, 1).to(torch.float8_e4m3fn),
                torch.tensor(1.0),
            )


if __name__ == "__main__":
    unittest.main()
