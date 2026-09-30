#!/usr/bin/env python3
"""Plan the campaign: a stratified order over every instance in instances.json, and pieces of N rows (default 12)
written into chunks/pool/<harness>/ for run_pool.sh to claim. Also seeds chunks/conc-<harness>.txt.

Protocol v2 excludes nothing: Aider's 225 tasks, the six whose stubs already pass among them. An exercise that
verify/*.json says cannot run here is a toolchain to fix, not a task to drop — it is reported, and the plan
refuses to start until the list is empty or EXCLUDE_UNRUNNABLE=1 says otherwise out loud."""
import glob, json, os, pathlib, sys, collections
B = pathlib.Path(os.environ.get("BENCH") or pathlib.Path(__file__).resolve().parent)
N = int(sys.argv[1]) if len(sys.argv) > 1 else 12
inst = json.load(open(B / "instances.json"))
unrunnable = {}
for f in sorted(glob.glob(str(B / "verify/*.json"))):
    for line in json.load(open(f)).get("unrunnableDetail", []):
        unrunnable[line.split(":")[0].strip()] = line
if unrunnable and os.environ.get("EXCLUDE_UNRUNNABLE") != "1":
    for k, v in sorted(unrunnable.items()): print(f"  cannot run here: {v}")
    sys.exit(f"{len(unrunnable)} instance(s) cannot run on this machine; fix the toolchain (or EXCLUDE_UNRUNNABLE=1, which the report will name)")
by = collections.defaultdict(list)
for i in inst:
    if i["id"] not in unrunnable: by[i["language"]].append(i["id"])
for l in by: by[l].sort()
order = []
while any(by.values()):
    for l in sorted(by):
        if by[l]: order.append(by[l].pop(0))
pieces = [order[k:k + N] for k in range(0, len(order), N)]
(B / "chunks").mkdir(exist_ok=True)
(B / "chunks/excluded.json").write_text(json.dumps(unrunnable, indent=2, sort_keys=True) + "\n")
for h in ("motifcode", "codex", "opencode"):
    pool = B / "chunks/pool" / h; pool.mkdir(parents=True, exist_ok=True)
    for old in pool.glob("chunk*.txt"): old.unlink()
    for n, p in enumerate(pieces, 1): (pool / f"chunkP{n:02d}.txt").write_text("\n".join(p) + "\n")
    conc = B / f"chunks/conc-{h}.txt"
    if not conc.exists(): conc.write_text("3\n")
print(f"{len(order)} instances -> {len(pieces)} pieces of up to {N}, in chunks/pool/<harness>/")
for k, v in sorted(unrunnable.items()): print(f"  EXCLUDED (cannot run here): {v}")
