#!/bin/bash
# usage: [REPLICATE=N] run_pool.sh <harness> <tag>
# Claims chunk files from chunks/pool/<harness>/ (atomic mv into chunks/claimed/r<N>/<harness>/) and runs each with
# the concurrency in chunks/conc-<harness>.txt, read afresh per chunk so it can be changed without a restart.
# A second replicate is the same plan again: python3 make_chunks.py refills the pool, then REPLICATE=2.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
H="$1"; TAG="$2"; R="${REPLICATE:-1}"
POOL="$BENCH/chunks/pool/$H"; CLAIMED="$BENCH/chunks/claimed/r$R/$H"; mkdir -p "$POOL" "$CLAIMED"
while :; do
  next="$(ls "$POOL" 2>/dev/null | sort -V | head -1)"
  [ -n "$next" ] || break
  if mv "$POOL/$next" "$CLAIMED/$next" 2>/dev/null; then
    conc="$(cat "$BENCH/chunks/conc-$H.txt" 2>/dev/null || cat "$BENCH/chunks/conc.txt" 2>/dev/null || echo 3)"   # per-harness value wins
    REPLICATE="$R" "$BENCH/run_chunk.sh" "$H" "$CLAIMED/$next" "$conc" "$TAG"
  fi
done
echo "[$(date -u +%FT%TZ)] r$R $H pool scheduler $TAG: pool empty, exiting" >> "$BENCH/results/campaign.log"
