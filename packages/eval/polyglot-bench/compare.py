#!/usr/bin/env python3
"""Paired comparison of the three harnesses on the same Motif-3 polyglot rows.

Reads results/<harness>/chunk*.jsonl (the runner's rows) and logs/<harness>/... (the adapters' evidence).
Only rows present for every harness being compared are paired; the rest are listed as pending.
Statistics: pass rate per harness, per-language rates, discordant pairs, McNemar exact p, and a paired
bootstrap CI on the difference (candidate minus baseline), deterministic seed.
"""
import json, glob, math, random, sys, collections, pathlib, statistics, os
B = pathlib.Path(os.environ.get("BENCH") or pathlib.Path(__file__).resolve().parent)
H = ["motifcode", "codex", "opencode"]

SUBSTITUTED = {}
def rows(h):
    out = {}
    for f in sorted(glob.glob(str(B / f"results/{h}/chunk*.jsonl"))):
        for l in open(f):
            if l.strip():
                r = json.loads(l); out[(r["instanceId"], r["seed"])] = r
    # Rows re-run after an infrastructure failure or an adapter fix replace the originals; the originals are kept for the record.
    rr = B / f"results/{h}/rerun.jsonl"
    if rr.exists():
        for l in open(rr):
            if l.strip():
                r = json.loads(l); k = (r["instanceId"], r["seed"])
                SUBSTITUTED.setdefault(h, []).append((r["instanceId"], out.get(k, {}).get("agentEndReason") or out.get(k, {}).get("status"), (r.get("grade") or {}).get("status")))
                out[k] = r
    return out

def passed(r): return (r.get("grade") or {}).get("status") == "passed"

def meta(h, r):
    inst, seed = r["instanceId"], r["seed"]
    lang, ex = inst.split("/")
    d = B / f"logs/{h}/{h}--{lang}/{ex}--{seed}--1"
    m = {}
    try: m = json.load(open(d / "meta.json"))
    except Exception: pass
    reqs = None; ptoks = None; ctoks = None
    try:
        if h == "motifcode":
            n = 0; p = 0; c = 0
            for l in open(d / "session.jsonl"):
                e = json.loads(l); ev = (e.get("record") or {}).get("event") or {}
                if ev.get("type") == "usage": n += 1; p += ev.get("promptTokens") or 0; c += ev.get("completionTokens") or 0
            reqs, ptoks, ctoks = n, p, c
        elif h == "codex":
            n = 0
            for l in open(d / "agent.log"):
                if not l.startswith("{"): continue
                e = json.loads(l)
                if e.get("type") == "item.completed" and (e.get("item") or {}).get("type") in ("agent_message", "reasoning"): n += 1
                if e.get("type") == "turn.completed":
                    u = e.get("usage") or {}; ptoks = u.get("input_tokens"); ctoks = u.get("output_tokens")
            reqs = None  # codex --json does not expose request count; steps are counted from command items instead
        elif h == "opencode":
            n = 0; p = 0; c = 0
            for l in open(d / "agent.log"):
                if not l.startswith("{"): continue
                e = json.loads(l)
                if e.get("type") == "step_finish":
                    n += 1; t = (e.get("part") or {}).get("tokens") or {}
                    p += (t.get("input") or 0) + ((t.get("cache") or {}).get("read") or 0); c += t.get("output") or 0
            reqs, ptoks, ctoks = n, (p or None), (c or None)
    except Exception: pass
    return {"wallMs": r.get("wallMs") or m.get("wallMs"), "requests": reqs, "promptTokens": ptoks, "completionTokens": ctoks}

def mcnemar_exact(b, c):
    n = b + c
    if n == 0: return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n
    return min(1.0, 2 * p)

def boot_ci(diffs, reps=10000, seed=0, level=0.95):
    rng = random.Random(seed); n = len(diffs); means = []
    for _ in range(reps):
        means.append(sum(diffs[rng.randrange(n)] for _ in range(n)) / n)
    means.sort(); lo = means[int((1 - level) / 2 * reps)]; hi = means[int((1 + level) / 2 * reps) - 1]
    return lo, hi

def main():
    data = {h: rows(h) for h in H}
    have = [h for h in H if data[h]]
    print("rows per harness:", {h: len(data[h]) for h in H})
    common = set.intersection(*[set(data[h]) for h in have]) if have else set()
    print(f"paired rows (present in all of {have}): {len(common)}")
    for h in have:
        rs = list(data[h].values()); p = sum(passed(r) for r in rs)
        st = collections.Counter(r["status"] for r in rs)
        ms = [meta(h, r) for r in rs]
        w = sorted(x["wallMs"] for x in ms if x["wallMs"]); reqs = [x["requests"] for x in ms if x["requests"]]
        ct = [x["completionTokens"] for x in ms if x["completionTokens"]]; pt = [x["promptTokens"] for x in ms if x["promptTokens"]]
        print(f"\n{h}: passed {p}/{len(rs)} = {p/len(rs)*100:.1f}%  statuses {dict(st)}")
        if w: print(f"  wall s: median {statistics.median(w)/1000:.0f}  p90 {w[int(len(w)*0.9)-1]/1000:.0f}  max {max(w)/1000:.0f}")
        if reqs: print(f"  requests/row: median {statistics.median(reqs):.0f}  total {sum(reqs)}")
        if ct: print(f"  completion tokens/row: median {statistics.median(ct):.0f}   prompt tokens/row: median {statistics.median(pt):.0f}" if pt else f"  completion tokens/row: median {statistics.median(ct):.0f}")
        bylang = collections.defaultdict(lambda: [0, 0])
        for r in rs:
            l = r["instanceId"].split("/")[0]; bylang[l][1] += 1; bylang[l][0] += passed(r)
        print("  by language: " + "  ".join(f"{l} {a}/{b}" for l, (a, b) in sorted(bylang.items())))
    print("\nprotocol / budget events per harness (how each row ended):")
    for h in have:
        ends = collections.Counter((r.get("agentEndReason") or r["status"]) for r in data[h].values())
        print(f"  {h:10s} " + ", ".join(f"{k} {v}" for k, v in sorted(ends.items(), key=lambda x: -x[1])))
    for h, subs in SUBSTITUTED.items():
        print(f"  {h}: {len(subs)} row(s) substituted by re-run: " + "; ".join(f"{i} ({was} -> {now})" for i, was, now in subs))
    if len(have) >= 2 and common:
        keys = sorted(common)
        for i in range(len(have)):
            for j in range(len(have)):
                if i == j: continue
                a, b = have[i], have[j]
                da = [passed(data[a][k]) for k in keys]; db = [passed(data[b][k]) for k in keys]
                only_a = sum(1 for x, y in zip(da, db) if x and not y); only_b = sum(1 for x, y in zip(da, db) if y and not x)
                diffs = [int(x) - int(y) for x, y in zip(da, db)]
                lo, hi = boot_ci(diffs)
                print(f"\n{a} vs {b} on {len(keys)} paired rows: {sum(da)} vs {sum(db)} passed; only-{a} {only_a}, only-{b} {only_b}; "
                      f"delta {sum(diffs)/len(diffs)*100:+.1f}pp  95% CI [{lo*100:+.1f}, {hi*100:+.1f}]  McNemar p={mcnemar_exact(only_a, only_b):.3f}")

if __name__ == "__main__": main()
