#!/bin/bash
# usage: run_rerun.sh [harness...]   (default: all three)
# Re-runs the rows listed in results/rerun.txt (infra failures and rows run under a since-fixed adapter setting),
# one chunk per harness, into results/<harness>/rerun.jsonl. compare.py substitutes these rows for the originals.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
mkdir -p "$BENCH/chunks/rerun"
for h in ${@:-motifcode codex opencode}; do
  awk -v h="$h" '!/^#/ && $1==h {print $2}' "$BENCH/results/rerun.txt" | sort -u > "$BENCH/chunks/rerun/$h.txt"
  n=$(wc -l < "$BENCH/chunks/rerun/$h.txt" | tr -d ' ')
  [ "$n" -gt 0 ] || { rm -f "$BENCH/chunks/rerun/$h.txt"; continue; }
  # run_chunk names the results file after the chunk file; make that "rerun.jsonl"
  cp "$BENCH/chunks/rerun/$h.txt" "$BENCH/chunks/rerun/rerun-$h.txt"
  [ "$n" -gt 4 ] && n=4
  ( "$BENCH/run_chunk.sh" "$h" "$BENCH/chunks/rerun/rerun-$h.txt" "$n" rerun; mv "$BENCH/results/$h/rerun-$h.jsonl" "$BENCH/results/$h/rerun.jsonl" 2>/dev/null; mv "$BENCH/results/$h/rerun-$h.out" "$BENCH/results/$h/rerun.out" 2>/dev/null; mv "$BENCH/results/$h/rerun-$h.err" "$BENCH/results/$h/rerun.err" 2>/dev/null ) &
done
wait
echo "[$(date -u +%FT%TZ)] reruns finished" >> "$BENCH/results/campaign.log"
