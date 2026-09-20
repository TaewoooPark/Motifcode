#!/bin/bash
# Campaign status: per harness pass/fail/status counts over every chunk so far, plus 429 sightings.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
cd "$BENCH"
python3 - <<'PY'
import json,glob,collections,os,re
for h in ["motifcode","codex","opencode"]:
    rows=[]
    for f in sorted(glob.glob(f"results/{h}/chunk*.jsonl")):
        rows+= [json.loads(l) for l in open(f) if l.strip()]
    if not rows: print(f"{h:10s} no rows yet"); continue
    st=collections.Counter(r["status"] for r in rows); g=collections.Counter((r.get("grade") or {}).get("status","-") for r in rows)
    p=sum(1 for r in rows if (r.get("grade") or {}).get("status")=="passed")
    walls=sorted(r.get("wallMs",0) for r in rows); med=walls[len(walls)//2]/1000 if walls else 0
    print(f"{h:10s} rows {len(rows):3d}  passed {p:3d} ({p/len(rows)*100:5.1f}%)  status {dict(st)}  grade {dict(g)}  median wall {med:.0f}s")
hits=0
for f in glob.glob("logs/*/*/*/agent.err")+glob.glob("results/*/*.err"):
    try:
        if re.search(r"HTTP.{0,20}\b429\b|status.{0,10}\b429\b|Too Many Requests|rate.?limit", open(f,errors="ignore").read()): hits+=1
    except Exception: pass
print("files mentioning 429/rate limit:", hits)
PY
tail -5 results/campaign.log 2>/dev/null
