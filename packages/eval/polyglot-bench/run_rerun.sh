#!/bin/bash
# usage: [REPLICATE=N] run_rerun.sh [harness...]   (default: all three)
# Re-runs the rows listed in results/rerun.txt for replicate N — one line each, "<harness> <instance> <reason>" — into
# results/r<N>/<harness>/rerun.jsonl, which the report substitutes for the originals. Only reasons fixed before the
# campaign qualify: a row that hit the safety cap, an infrastructure failure (DNS, a machine restart, an external kill).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
R="${REPLICATE:-1}"
mkdir -p "$BENCH/chunks/rerun"
for h in ${@:-motifcode codex opencode}; do
  awk -v h="$h" '!/^#/ && $1==h {print $2}' "$BENCH/results/rerun.txt" | sort -u > "$BENCH/chunks/rerun/rerun-r$R-$h.txt"
  n=$(wc -l < "$BENCH/chunks/rerun/rerun-r$R-$h.txt" | tr -d ' ')
  [ "$n" -gt 0 ] || { rm -f "$BENCH/chunks/rerun/rerun-r$R-$h.txt"; continue; }
  [ "$n" -gt 4 ] && n=4
  ( REPLICATE="$R" "$BENCH/run_chunk.sh" "$h" "$BENCH/chunks/rerun/rerun-r$R-$h.txt" "$n" rerun
    for ext in jsonl out err; do mv "$BENCH/results/r$R/$h/rerun-r$R-$h.$ext" "$BENCH/results/r$R/$h/rerun.$ext" 2>/dev/null; done ) &
done
wait
echo "[$(date -u +%FT%TZ)] r$R reruns finished" >> "$BENCH/results/campaign.log"
