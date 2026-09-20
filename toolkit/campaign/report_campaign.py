#!/usr/bin/env python3
"""Turn a campaign's rows and journals into a score table.

Three things are reported, and keeping them apart is the point.

**Score** is computed over the manifest's planned denominator, not over the rows
that happened to finish. A row that crashed, timed out or never ran scores zero
and stays in. Reporting over survivors flatters exactly the configuration that
falls over on its hardest instances.

**How the agent stopped** is reported beside the score, because at a few tokens
per second the turn budget binds often enough that a pass rate alone would be
partly a measurement of the budget. `turn_limit` and `done` are different
failures to distinguish from each other.

**Protocol health** — malformed tool calls, repairs, tool errors — is the part
no published Motif number covers. The vendor's own vLLM parser comments say the
model emits tool-call JSON that does not parse; this counts how often, and how
often one repair turn recovers it. That is a usability measurement, and it is
the axis the model is usually criticised on.

Nothing here estimates. Every number is read from a row or a journal record.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def read_jsonl(path: Path):
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # A truncated tail is what a killed process leaves. It is
                # evidence about the row, not a reason to stop reading.
                continue


def journal_stats(path: Path) -> dict:
    """Per-row protocol and throughput counters, from the agent's own record."""
    s = {
        "turns": 0,
        "requests": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "request_ms": 0,
        "max_context_tokens": 0,
        "tool_calls": 0,
        "tool_failures": 0,
        "repairs": Counter(),
    }
    if not path.is_file():
        return s
    for rec in read_jsonl(path):
        r = rec.get("record") or {}
        if r.get("t") != "event":
            continue
        ev = r.get("event") or {}
        t = ev.get("type")
        if t == "turn_start":
            s["turns"] += 1
        elif t == "usage":
            s["requests"] += 1
            s["prompt_tokens"] += ev.get("promptTokens") or 0
            s["completion_tokens"] += ev.get("completionTokens") or 0
            s["request_ms"] += ev.get("requestMs") or 0
            s["max_context_tokens"] = max(s["max_context_tokens"], ev.get("contextTokens") or 0)
        elif t == "tool_end":
            s["tool_calls"] += 1
            if ev.get("ok") is False:
                s["tool_failures"] += 1
        elif t == "repair":
            s["repairs"][f"{ev.get('kind')}/{ev.get('reason')}"] += 1
    return s


def bar(n: int, d: int, width: int = 18) -> str:
    if d <= 0:
        return " " * width
    filled = round(width * n / d)
    return "█" * filled + "·" * (width - filled)


def main() -> int:
    ap = argparse.ArgumentParser()
    # Repeatable, because a campaign is not always one file. This one ran in
    # three pieces: rows completed before the box rebooted, rows completed
    # after it, and rows re-run once a client-side timeout bug was fixed. They
    # share a manifest, so they are one campaign; they are separate files
    # because they were separate invocations.
    ap.add_argument("--results", required=True, action="append")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--instances", required=True)
    ap.add_argument("--work-root", default=[], action="append")
    ap.add_argument("--json-out", default="")
    a = ap.parse_args()

    manifest = json.loads(Path(a.manifest).read_text())
    instances = json.loads(Path(a.instances).read_text())

    # Later file wins on a collision, and the collision is reported rather than
    # absorbed: a row appearing twice means it was run twice, and which of the
    # two counted is exactly the kind of thing a score table must not hide.
    segments = []
    rows_by_key: dict[tuple[str, int], dict] = {}
    superseded = []
    for path in a.results:
        seg = list(read_jsonl(Path(path)))
        contributed = 0
        for r in seg:
            key = (r["instanceId"], r["seed"])
            if key in rows_by_key:
                superseded.append((r["instanceId"], r["seed"]))
            rows_by_key[key] = r
            contributed += 1
        segments.append((path, len(seg), contributed))
    rows = list(rows_by_key.values())

    lang_of = {i["id"]: i["language"] for i in instances}
    seeds = manifest["sampling"]["seeds"]
    planned_ids = [(i["id"], s) for i in instances for s in seeds]
    by_key = rows_by_key

    def is_pass(r) -> bool:
        return bool(r) and (r.get("grade") or {}).get("status") == "passed"

    # ---- score, over the planned denominator -------------------------------
    per_lang_n = Counter()
    per_lang_pass = Counter()
    per_lang_ran = Counter()
    for iid, seed in planned_ids:
        lang = lang_of.get(iid, "?")
        per_lang_n[lang] += 1
        r = by_key.get((iid, seed))
        if r is not None:
            per_lang_ran[lang] += 1
        if is_pass(r):
            per_lang_pass[lang] += 1

    total_n = sum(per_lang_n.values())
    total_pass = sum(per_lang_pass.values())
    total_ran = sum(per_lang_ran.values())

    out = []
    w = out.append
    w("=" * 72)
    w(f"  {manifest['candidate']['model_id']}  ·  {manifest['suite']['name']}"
      f"  ·  manifest {manifest['manifest_id']}")
    serving = manifest.get("serving", {})
    w(f"  {serving.get('engine', '?')} on {serving.get('hardware', {}).get('name', '?')}"
      + (f"  ·  {serving['quantization']}" if serving.get("quantization") else ""))
    w(f"  budget: {manifest['budgets']['max_turns']} turns,"
      f" {manifest['budgets']['task_wall_timeout_seconds']}s wall"
      f"  ·  channel {manifest['harness']['initial_channel']}")
    w("=" * 72)
    w("")
    if len(segments) > 1 or superseded:
        w("SEGMENTS  (one manifest, several invocations)")
        w("")
        for path, n, _ in segments:
            w(f"  {Path(path).name:<28} {n:>3} row(s)")
        if superseded:
            w(f"  superseded by a later file  {len(superseded)}:"
              f" {', '.join(f'{i}#{s}' for i, s in superseded)}")
        w("")
    w("SCORE  (over planned rows; missing and crashed score zero)")
    w("")
    w(f"  {'track':<12} {'pass':>5} {'/':^3} {'planned':>7}   {'rate':>6}   ran")
    for lang in sorted(per_lang_n):
        n, p, ran = per_lang_n[lang], per_lang_pass[lang], per_lang_ran[lang]
        w(f"  {lang:<12} {p:>5} {'/':^3} {n:>7}   {p/n*100:>5.1f}%   {bar(p, n)}  {ran}/{n}")
    w("  " + "-" * 60)
    w(f"  {'TOTAL':<12} {total_pass:>5} {'/':^3} {total_n:>7}   "
      f"{(total_pass/total_n*100 if total_n else 0):>5.1f}%   {bar(total_pass, total_n)}  {total_ran}/{total_n}")
    w("")

    # ---- how the agent stopped ---------------------------------------------
    ends = Counter()
    statuses = Counter()
    for iid, seed in planned_ids:
        r = by_key.get((iid, seed))
        if r is None:
            statuses["not_run"] += 1
            ends["not_run"] += 1
            continue
        statuses[r.get("status", "?")] += 1
        ends[r.get("agentEndReason") or r.get("status") or "?"] += 1
    w("HOW THE AGENT STOPPED")
    w("")
    for k, v in ends.most_common():
        w(f"  {k:<22} {v:>3}   {v/total_n*100:>5.1f}%")
    w("")

    # ---- protocol health, from the journals --------------------------------
    def find_journal(iid: str, seed: int) -> Path | None:
        """Newest-given root first, matching later-results-wins above."""
        lang, ex = iid.split("/", 1)
        cfg = manifest["candidate"]["config_id"]
        for root in reversed(a.work_root):
            p = Path(root) / f"{cfg}--{lang}" / f"{ex}--{seed}--1" / "session.jsonl"
            if p.is_file():
                return p
        return None

    if a.work_root:
        agg = {
            "turns": 0, "requests": 0, "prompt_tokens": 0, "completion_tokens": 0,
            "request_ms": 0, "tool_calls": 0, "tool_failures": 0,
        }
        repairs = Counter()
        rows_with_journal = 0
        ctx_peaks = []
        for iid, seed in planned_ids:
            p = find_journal(iid, seed)
            if p is None:
                continue
            rows_with_journal += 1
            s = journal_stats(p)
            for k in agg:
                agg[k] += s[k]
            repairs.update(s["repairs"])
            ctx_peaks.append(s["max_context_tokens"])

        if rows_with_journal:
            w("PROTOCOL HEALTH  (from the agent's own journals)")
            w("")
            w(f"  rows with a journal      {rows_with_journal}")
            w(f"  model requests           {agg['requests']}")
            w(f"  turns                    {agg['turns']}")
            w(f"  tool calls               {agg['tool_calls']}"
              f"   ({agg['tool_failures']} returned an error"
              f", {agg['tool_failures']/max(1,agg['tool_calls'])*100:.1f}%)")
            total_repairs = sum(repairs.values())
            w(f"  repairs                  {total_repairs}"
              f"   ({total_repairs/max(1,agg['requests'])*100:.1f}% of requests)")
            for k, v in repairs.most_common():
                w(f"      {k:<28} {v:>4}")
            if ctx_peaks:
                ctx_peaks.sort()
                w(f"  peak context (median)    {ctx_peaks[len(ctx_peaks)//2]:,} tokens")
                w(f"  peak context (max)       {ctx_peaks[-1]:,} tokens")
            w("")
            # Both numbers below are sums over requests, and at concurrency > 1
            # requests overlap, so neither is a wall-clock figure. The rate is
            # completion tokens over *request* time, which includes prefill —
            # it is not a decode rate and must not be read as one. With a
            # prompt:completion ratio in the thirties, prefill is most of it.
            w("THROUGHPUT  (summed over requests; prefill and decode together)")
            w("")
            secs = agg["request_ms"] / 1000
            ratio = agg["prompt_tokens"] / max(1, agg["completion_tokens"])
            w(f"  prompt tokens            {agg['prompt_tokens']:,}")
            w(f"  completion tokens        {agg['completion_tokens']:,}")
            w(f"  prompt:completion        {ratio:.1f} : 1")
            w(f"  time in requests         {secs/3600:.2f} h"
              f"   (summed; overlaps at concurrency > 1)")
            if secs > 0:
                w(f"  completion tok/s         {agg['completion_tokens']/secs:.2f}"
                  f"   (per second of request time, prefill included)")
            w("")

    walls = [r.get("wallMs", 0) / 60000 for r in rows if r.get("wallMs")]
    if walls:
        walls.sort()
        w("ROW WALL TIME")
        w("")
        w(f"  median                   {walls[len(walls)//2]:.1f} min")
        w(f"  max                      {walls[-1]:.1f} min")
        w(f"  total                    {sum(walls)/60:.2f} h"
          f"   (summed; rows overlap, so this is not elapsed time)")
        w("")

    text = "\n".join(out)
    print(text)

    if a.json_out:
        Path(a.json_out).write_text(json.dumps({
            "manifest_id": manifest["manifest_id"],
            "planned": total_n,
            "ran": total_ran,
            "passed": total_pass,
            "rate": (total_pass / total_n) if total_n else 0.0,
            "per_language": {
                k: {"passed": per_lang_pass[k], "planned": per_lang_n[k], "ran": per_lang_ran[k]}
                for k in sorted(per_lang_n)
            },
            "end_reasons": dict(ends),
            "statuses": dict(statuses),
            "segments": [{"file": p, "rows": n} for p, n, _ in segments],
            "superseded": [{"instanceId": i, "seed": s} for i, s in superseded],
        }, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
