#!/bin/bash
# Campaign status per replicate and harness: pass@1 under the official and the strict rules, pass@2 after the
# feedback round, statuses, invalid rows, rows to re-run (safety cap), and 429 sightings.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
cd "$BENCH"
python3 - <<'PY'
import json, glob, collections, os, re
def ok(g): return (g or {}).get("status") == "passed"
for rdir in sorted(glob.glob("results/r*")):
    for h in os.environ["HARNESSES"].split():
        rows = []
        for f in sorted(glob.glob(f"{rdir}/{h}/chunk*.jsonl")):
            rows += [json.loads(l) for l in open(f) if l.strip()]
        if not rows: continue
        n = len(rows); valid = [r for r in rows if not r.get("invalid")]
        p1 = sum(ok(r.get("grade")) for r in valid); ps = sum(ok(r.get("gradeStrict") or r.get("grade")) for r in valid)
        p2 = sum(ok(r.get("grade")) or ok((r.get("feedback") or {}).get("grade")) for r in valid)
        st = collections.Counter(r["status"] for r in rows)
        walls = sorted(r.get("wallMs", 0) for r in rows); med = walls[len(walls)//2] / 1000 if walls else 0
        print(f"{rdir[8:]:3s} {h:10s} rows {n:3d}  pass@1 {p1:3d} ({p1/n*100:5.1f}%)  strict {ps:3d}  pass@2 {p2:3d}  "
              f"invalid {n-len(valid)}  status {dict(st)}  median wall {med:.0f}s")
        for r in rows:
            if r["status"] == "safety_cap": print(f"      re-run once (safety cap): {h} {r['instanceId']}")
            if r.get("invalid"): print(f"      invalid: {h} {r['instanceId']}: {r['invalid']}")
hits = 0
for f in glob.glob("logs/*/*/*/agent*.err") + glob.glob("results/r*/*/*.err"):
    try:
        if re.search(r"HTTP.{0,20}\b429\b|status.{0,10}\b429\b|Too Many Requests|rate.?limit", open(f, errors="ignore").read()): hits += 1
    except Exception: pass
print("files mentioning 429/rate limit:", hits)
PY
tail -5 results/campaign.log 2>/dev/null
