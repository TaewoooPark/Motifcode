#!/usr/bin/env python3
"""Plan the campaign: exclusions from verify/*.json, a stratified order over the remaining instances, and pieces of
N rows (default 12) written into chunks/pool/<harness>/ for run_pool.sh to claim. Also seeds chunks/conc-<harness>.txt."""
import glob, json, os, pathlib, sys, collections
B = pathlib.Path(os.environ.get("BENCH") or pathlib.Path(__file__).resolve().parent)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 12
inst = json.load(open(B / "instances.json"))
excluded = {}
for f in sorted(glob.glob(str(B / "verify/*.json"))):
    d = json.load(open(f))
    for k in ("alreadyPassingDetail", "unrunnableDetail", "referenceBroken"):
        for line in d.get(k, []): excluded[line.split(":")[0].strip()] = k
by = collections.defaultdict(list)
for i in inst:
    if i["id"] not in excluded: by[i["language"]].append(i["id"])
for l in by: by[l].sort()
order = []
while any(by.values()):
    for l in sorted(by):
        if by[l]: order.append(by[l].pop(0))
pieces = [order[k:k + N] for k in range(0, len(order), N)]
(B / "chunks").mkdir(exist_ok=True)
(B / "chunks/excluded.json").write_text(json.dumps(excluded, indent=2, sort_keys=True) + "\n")
for h in ("motifcode", "codex", "opencode"):
    pool = B / "chunks/pool" / h; pool.mkdir(parents=True, exist_ok=True)
    for old in pool.glob("chunk*.txt"): old.unlink()
    for n, p in enumerate(pieces, 1): (pool / f"chunkP{n:02d}.txt").write_text("\n".join(p) + "\n")
    conc = B / f"chunks/conc-{h}.txt"
    if not conc.exists(): conc.write_text("3\n")
print(f"{len(order)} instances after {len(excluded)} exclusions -> {len(pieces)} pieces of up to {N}, in chunks/pool/<harness>/")
for k, v in sorted(excluded.items()): print(f"  excluded {k}: {v}")
