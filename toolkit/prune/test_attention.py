"""The flash-attention adapter, checked against an implementation you can read.

"I used a real flash kernel" and "I used it correctly" are different claims. The
layout conversion is a reshape that can transpose the wrong pair of axes, the
grouped-query repeat can be interleaved the wrong way round, and the
sliding-window bound can be off by one — none of which raises anything. So the
adapter is checked against `naive_attention`, which builds the mask from index
arithmetic and takes an ordinary softmax.

The sliding-window case is the one that matters. Get the window off by one and
every layer on the interleaved schedule attends to one token too few or too
many, which is a small, plausible, entirely wrong hidden state.
"""

from __future__ import annotations

import unittest

from _requires import require
from attention import flash_available, naive_attention


class Module:
    """The only attribute the interface reads off the module."""

    is_causal = True


class TestNaiveReference(unittest.TestCase):
    """The reference has to be right, or checking against it proves nothing."""

    def setUp(self):
        require("torch", self)

    def test_causal_masking_hides_the_future(self):
        import torch

        torch.manual_seed(1)
        q = torch.randn(1, 2, 4, 8)
        k = torch.randn(1, 2, 4, 8)
        # Values that make each position identifiable.
        v = torch.arange(4, dtype=torch.float32).reshape(1, 1, 4, 1).expand(1, 2, 4, 1).contiguous()
        out, _ = naive_attention(Module(), q, k, v, scaling=1.0)
        # Position 0 can only see position 0, so its output must be exactly v[0].
        self.assertAlmostEqual(float(out[0, 0, 0, 0]), 0.0, places=5)
        # Every output is a convex combination of the values it can see, so no
        # position can exceed the largest value available to it.
        for i in range(4):
            self.assertLessEqual(float(out[0, i, 0, 0]), i + 1e-5)

    def test_the_sliding_window_includes_exactly_w_positions(self):
        import torch

        # One-hot values: the output at position i is the mean of the positions
        # it attended to, so the count is directly readable.
        n = 8
        q = torch.zeros(1, 1, n, 4)
        k = torch.zeros(1, 1, n, 4)
        v = torch.eye(n).reshape(1, 1, n, n)
        out, _ = naive_attention(Module(), q, k, v, scaling=1.0, sliding_window=3)
        # With identical q and k every allowed position gets equal weight, so a
        # position attending to `m` keys has `m` entries of 1/m.
        for i in range(n):
            attended = int((out[0, i, 0] > 1e-6).sum())
            self.assertEqual(attended, min(i + 1, 3), f"position {i}")

    def test_grouped_query_repeats_kv_heads(self):
        import torch

        torch.manual_seed(2)
        q = torch.randn(1, 4, 3, 8)
        k = torch.randn(1, 2, 3, 8)
        v = torch.randn(1, 2, 3, 8)
        out, _ = naive_attention(Module(), q, k, v, scaling=0.5)
        self.assertEqual(tuple(out.shape), (1, 3, 4, 8))


class TestFlashMatchesNaive(unittest.TestCase):
    def setUp(self):
        require("torch", self)
        import torch

        ok, why = flash_available()
        if not ok:
            self.skipTest(f"no flash kernel: {why}")
        if not torch.cuda.is_available():
            self.skipTest("flash attention needs a GPU")

    def run_pair(self, heads, kv_heads, seq, head_dim, sliding_window=None):
        import torch

        from attention import flash_attention_via_vllm

        torch.manual_seed(19)
        q = torch.randn(1, heads, seq, head_dim, dtype=torch.bfloat16, device="cuda")
        k = torch.randn(1, kv_heads, seq, head_dim, dtype=torch.bfloat16, device="cuda")
        v = torch.randn(1, kv_heads, seq, head_dim, dtype=torch.bfloat16, device="cuda")
        scaling = head_dim**-0.5

        fast, _ = flash_attention_via_vllm(
            Module(), q, k, v, scaling=scaling, sliding_window=sliding_window
        )
        slow, _ = naive_attention(Module(), q, k, v, scaling=scaling, sliding_window=sliding_window)
        return fast.float(), slow.float()

    def test_plain_causal_attention(self):
        import torch

        fast, slow = self.run_pair(heads=8, kv_heads=8, seq=64, head_dim=64)
        torch.testing.assert_close(fast, slow, rtol=2e-2, atol=2e-2)

    def test_grouped_query_attention(self):
        import torch

        # GDLA is GQA, and the eager backend's failure to repeat KV heads is one
        # of the two reasons the model refuses it.
        fast, slow = self.run_pair(heads=8, kv_heads=2, seq=64, head_dim=64)
        torch.testing.assert_close(fast, slow, rtol=2e-2, atol=2e-2)

    def test_sliding_window(self):
        import torch

        # The other reason. Off by one here and every interleaved layer sees a
        # slightly wrong context.
        fast, slow = self.run_pair(heads=8, kv_heads=2, seq=256, head_dim=64, sliding_window=129)
        torch.testing.assert_close(fast, slow, rtol=2e-2, atol=2e-2)

    def test_a_window_larger_than_the_sequence_is_a_no_op(self):
        import torch

        windowed, _ = self.run_pair(heads=4, kv_heads=4, seq=32, head_dim=64, sliding_window=129)
        plain, _ = self.run_pair(heads=4, kv_heads=4, seq=32, head_dim=64)
        torch.testing.assert_close(windowed, plain, rtol=0, atol=0)

    def test_refuses_a_padding_mask_rather_than_ignoring_it(self):
        import torch

        from attention import flash_attention_via_vllm

        q = torch.randn(1, 2, 8, 64, dtype=torch.bfloat16, device="cuda")
        with self.assertRaises(NotImplementedError):
            flash_attention_via_vllm(Module(), q, q, q, attention_mask=torch.ones(1, 8))


if __name__ == "__main__":
    unittest.main()
