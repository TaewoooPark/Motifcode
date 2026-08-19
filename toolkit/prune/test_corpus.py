"""The corpus contract and the leakage audit.

Profiling on the instances a model is later graded on is circular in a way no
downstream statistic can undo: the experts kept are the ones that helped on
exactly those problems, and the benchmark then reports how well that worked.
These tests make the audit a refusal rather than a report.
"""

from __future__ import annotations

import unittest

from corpus import (
    CorpusError,
    CorpusRecord,
    StabilityGate,
    audit_leakage,
    jaccard,
    keep_set_jaccard,
    normalize,
    shingles,
    stability_report,
    validate_corpus,
)

TOOLS = "a" * 64
TEMPLATE = "b" * 64


def record(**over) -> CorpusRecord:
    base = dict(
        sample_id="s1",
        source="motif-session",
        source_revision="rev1",
        split="calibration",
        messages=[
            {"role": "system", "content": "# Tools\n<tools>…</tools>\nYou are motifcode."},
            {"role": "user", "content": "fix the failing test in parse.py"},
            {"role": "assistant", "content": "<tool_call>{\"name\":\"bash\"}</tool_call>"},
            {"role": "tool", "content": "1 failed"},
        ],
        tools_sha256=TOOLS,
        template_sha256=TEMPLATE,
        rendered_sha256="c" * 64,
        license="MIT",
    )
    base.update(over)
    return CorpusRecord(**base)


class TestValidation(unittest.TestCase):
    def test_accepts_a_well_formed_record(self):
        validate_corpus([record()], TOOLS, TEMPLATE)

    def test_refuses_an_empty_corpus(self):
        with self.assertRaisesRegex(CorpusError, "empty"):
            validate_corpus([], TOOLS, TEMPLATE)

    def test_refuses_a_corpus_rendered_against_different_tool_schemas(self):
        # The tools block is emitted on every request and is a large share of
        # the structural tokens. A corpus rendered against a different one is
        # profiling a prompt this harness does not send.
        with self.assertRaisesRegex(CorpusError, "tool schemas"):
            validate_corpus([record(tools_sha256="z" * 64)], TOOLS, TEMPLATE)

    def test_refuses_a_corpus_rendered_against_a_different_template(self):
        with self.assertRaisesRegex(CorpusError, "chat template"):
            validate_corpus([record(template_sha256="z" * 64)], TOOLS, TEMPLATE)

    def test_refuses_a_conversation_with_no_system_turn(self):
        # Truncating documents from the front is exactly what the old profiler
        # did, and it removed the system prompt and the tool schemas.
        bare = record(messages=[{"role": "user", "content": "hi"}])
        with self.assertRaisesRegex(CorpusError, "system turn"):
            validate_corpus([bare], TOOLS, TEMPLATE)

    def test_refuses_duplicate_sample_ids(self):
        with self.assertRaisesRegex(CorpusError, "duplicate sample_id"):
            validate_corpus([record(), record()], TOOLS, TEMPLATE)

    def test_refuses_an_unknown_split(self):
        with self.assertRaisesRegex(CorpusError, "split"):
            validate_corpus([record(split="train-ish")], TOOLS, TEMPLATE)


class TestLeakage(unittest.TestCase):
    def test_catches_an_exact_instance_id(self):
        r = record(benchmark_instance_id="django__django-11099")
        found = audit_leakage([r], {"django__django-11099"})
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].kind, "instance_id")

    def test_refuses_the_corpus_rather_than_reporting(self):
        # A warning printed during a twelve-hour profiling run is a warning
        # nobody reads.
        r = record(benchmark_instance_id="django__django-11099")
        with self.assertRaisesRegex(CorpusError, "overlaps sealed instance"):
            validate_corpus([r], TOOLS, TEMPLATE, {"django__django-11099"})

    def test_catches_a_reformatted_copy_with_no_shared_identifier(self):
        # The document was reindented and its comments rewrapped on the way in,
        # so nothing about its metadata says where it came from.
        original = (
            "def solve(items):\n"
            "    total = 0\n"
            "    for item in items:\n"
            "        total += item.value\n"
            "    return total\n"
        )
        reformatted = (
            "def solve( items ):\n"
            "        total = 0\n"
            "        # accumulate\n"
            "        for item in items:\n"
            "                total += item.value\n"
            "        return total\n"
        )
        r = record(messages=[{"role": "system", "content": "s"}, {"role": "user", "content": reformatted}])
        found = audit_leakage([r], set(), {"inst-1": original})
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0].kind.startswith("near_duplicate"))

    def test_does_not_flag_unrelated_text(self):
        r = record()
        found = audit_leakage([r], set(), {"inst-1": "a completely different program about matrices"})
        self.assertEqual(found, [])

    def test_normalisation_ignores_whitespace_and_case(self):
        self.assertEqual(normalize("Foo   BAR\n\tbaz"), "foo bar baz")

    def test_jaccard_edges(self):
        self.assertEqual(jaccard(set(), set()), 1.0)
        self.assertEqual(jaccard({"a"}, set()), 0.0)
        self.assertEqual(jaccard({"a", "b"}, {"b", "c"}), 1 / 3)

    def test_shingles_handle_short_text(self):
        self.assertEqual(shingles("one two", n=8), {"one two"})
        self.assertEqual(shingles("", n=8), set())

    def test_containment_catches_a_problem_embedded_in_a_conversation(self):
        # The realistic leak: the benchmark problem is in there, surrounded by
        # a whole agent session. Jaccard is low because the sizes differ;
        # containment is what notices.
        problem = "the retry loop drops the last attempt when the backoff overflows the counter"
        conversation = (
            "user asked about a bug. "
            + problem
            + " I looked at retry.py and found the counter wraps at 32 bits, then wrote a test, "
            "ran the suite, and confirmed the fix holds under load."
        )
        r = record(messages=[{"role": "system", "content": "s"}, {"role": "user", "content": conversation}])
        found = audit_leakage([r], set(), {"inst-1": problem})
        self.assertEqual(len(found), 1)
        self.assertIn("containment", found[0].kind)


class TestStability(unittest.TestCase):
    def test_identical_shards_agree_completely(self):
        keep = {"2": [0, 1, 2, 3], "3": [0, 1, 2, 3]}
        report = stability_report([keep, keep, keep])
        self.assertEqual(report["median_layer_jaccard"], 1.0)
        self.assertTrue(report["passed"])

    def test_disagreeing_shards_fail_the_gate(self):
        # If independent shards choose different experts, the profile is
        # measuring the shard rather than the workload.
        a = {"2": [0, 1, 2, 3], "3": [0, 1, 2, 3]}
        b = {"2": [4, 5, 6, 7], "3": [4, 5, 6, 7]}
        report = stability_report([a, b])
        self.assertEqual(report["median_layer_jaccard"], 0.0)
        self.assertFalse(report["passed"])

    def test_jaccard_is_computed_per_layer(self):
        a = {"2": [0, 1, 2, 3]}
        b = {"2": [0, 1, 2, 9]}
        self.assertAlmostEqual(keep_set_jaccard(a, b)["2"], 3 / 5)

    def test_needs_at_least_two_shards(self):
        with self.assertRaisesRegex(CorpusError, "two independent shards"):
            stability_report([{"2": [0]}])

    def test_the_gate_is_a_constant_not_a_choice(self):
        # A threshold picked after seeing the report is not a threshold.
        gate = StabilityGate()
        self.assertEqual(gate.median_layer_jaccard, 0.90)
        self.assertEqual(gate.p5_layer_jaccard, 0.80)

    def test_hand_computed_median(self):
        # Two shards, two layers: layer 2 agrees on 3 of 5, layer 3 on 1 of 7.
        a = {"2": [0, 1, 2, 3], "3": [0, 1, 2, 3]}
        b = {"2": [0, 1, 2, 9], "3": [3, 8, 9, 10]}
        report = stability_report([a, b])
        self.assertAlmostEqual(report["per_layer_median"]["2"], round(3 / 5, 4))
        self.assertAlmostEqual(report["per_layer_median"]["3"], round(1 / 7, 4))


if __name__ == "__main__":
    unittest.main()
