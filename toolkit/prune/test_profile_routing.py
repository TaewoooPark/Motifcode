"""What the profiler refuses to load, and why each refusal exists.

Every case here is a failure that was reached for real while bringing the
pipeline up on a GB10, and each one is silent by default:

  * `AutoTokenizer` resolves the model config first, and this repository's
    `auto_map` names a `modeling_motif.py` it does not ship.
  * A corpus of raw `messages` renders through a second chat template, not the
    harness's, so the tokens profiled are not the tokens sent.
  * `Tensor.copy_` widens bf16 to fp32 without a word, which builds the whole
    model at a precision the served model never runs at.

None of the three raises on its own. They surface as a routing profile that
looks entirely reasonable and describes a different model.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import mkdtemp

from _requires import require
from profile_routing import load_spec, read_corpus


class FakeTokenizer:
    """Counts tokens without pulling a real vocabulary into the test."""

    def __call__(self, text, add_special_tokens=False):
        assert add_special_tokens is False, "the rendered text already carries its own BOS"
        return {"input_ids": list(range(len(text.split())))}

    def apply_chat_template(self, *a, **k):  # pragma: no cover - must never be reached
        raise AssertionError(
            "the profiler applied a chat template; the corpus is meant to arrive rendered"
        )


class TestCorpusContract(unittest.TestCase):
    def setUp(self):
        require("torch", self)
        self.root = Path(mkdtemp(prefix="motif-profile-"))

    def write(self, name: str, records: list[dict]) -> Path:
        path = self.root / name
        path.write_text("\n".join(json.dumps(r) for r in records), encoding="utf-8")
        return path

    def test_reads_pre_rendered_text(self):
        corpus = self.write("c.jsonl", [{"sample_id": "a", "text": "one two three four " * 8}])
        sequences, total = read_corpus(corpus, FakeTokenizer(), 2048, 10_000)
        self.assertEqual(len(sequences), 1)
        self.assertEqual(total, 32)

    def test_refuses_a_corpus_that_was_never_rendered(self):
        # The shape `motif distil` emits. Accepting it means applying a second
        # chat template and profiling a prompt the harness does not send.
        corpus = self.write("c.jsonl", [{"sample_id": "a", "messages": [{"role": "user"}]}])
        with self.assertRaises(SystemExit) as caught:
            read_corpus(corpus, FakeTokenizer(), 2048, 10_000)
        self.assertIn("corpus-render", str(caught.exception))

    def test_windows_rather_than_packing_across_documents(self):
        # A window spanning two conversations makes the model attend across a
        # break it never sees, and every token after the boundary is measured
        # under conditions that do not occur.
        corpus = self.write(
            "c.jsonl",
            [{"sample_id": "a", "text": "w " * 24}, {"sample_id": "b", "text": "w " * 24}],
        )
        sequences, _ = read_corpus(corpus, FakeTokenizer(), 16, 10_000)
        self.assertEqual([len(s) for s in sequences], [16, 16])

    def test_drops_a_window_too_short_to_route_meaningfully(self):
        corpus = self.write("c.jsonl", [{"sample_id": "a", "text": "w " * 20}])
        sequences, total = read_corpus(corpus, FakeTokenizer(), 16, 10_000)
        self.assertEqual([len(s) for s in sequences], [16])
        self.assertEqual(total, 16)

    def test_stops_at_the_token_budget(self):
        corpus = self.write("c.jsonl", [{"sample_id": str(i), "text": "w " * 64} for i in range(9)])
        _, total = read_corpus(corpus, FakeTokenizer(), 32, 100)
        self.assertLessEqual(total, 128)
        self.assertGreaterEqual(total, 100)


class TestSpecAgreement(unittest.TestCase):
    def setUp(self):
        self.root = Path(mkdtemp(prefix="motif-spec-"))

    def write(self, name: str, payload) -> Path:
        path = self.root / name
        if isinstance(payload, list):
            path.write_text("\n".join(json.dumps(r) for r in payload), encoding="utf-8")
        else:
            path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_returns_the_tools_and_hashes(self):
        spec = self.write(
            "spec.json",
            {"tools": [{"name": "bash"}], "toolSchemaSha256": "a" * 64, "systemPromptSha256": "b" * 64},
        )
        corpus = self.write("c.jsonl", [{"sample_id": "x", "tools_sha256": "a" * 64}])
        tools, tools_sha, system_sha = load_spec(spec, corpus)
        self.assertEqual([t["name"] for t in tools], ["bash"])
        self.assertEqual(tools_sha, "a" * 64)
        self.assertEqual(system_sha, "b" * 64)

    def test_refuses_a_corpus_built_against_other_tool_schemas(self):
        # The tools block is the first thing in the prompt and the longest
        # single constant in it. Profiling against a different one measures a
        # prefix the harness never sends.
        spec = self.write("spec.json", {"tools": [], "toolSchemaSha256": "a" * 64})
        corpus = self.write("c.jsonl", [{"sample_id": "x", "tools_sha256": "c" * 64}])
        with self.assertRaises(SystemExit) as caught:
            load_spec(spec, corpus)
        self.assertIn("Rebuild the corpus", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
