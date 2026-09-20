#!/bin/bash
# usage: run_pool.sh <harness> <tag>
# Claims chunk files from chunks/pool/<harness>/ (atomic mv into chunks/claimed/<harness>/) and runs each with
# the concurrency in chunks/conc.txt, read afresh per chunk so it can be raised without a restart.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
H="$1"; TAG="$2"
POOL="$BENCH/chunks/pool/$H"; CLAIMED="$BENCH/chunks/claimed/$H"; mkdir -p "$POOL" "$CLAIMED"
while :; do
  next="$(ls "$POOL" 2>/dev/null | sort -V | head -1)"
  [ -n "$next" ] || break
  if mv "$POOL/$next" "$CLAIMED/$next" 2>/dev/null; then
    conc="$(cat "$BENCH/chunks/conc-$H.txt" 2>/dev/null || cat "$BENCH/chunks/conc.txt" 2>/dev/null || echo 3)"   # per-harness value wins
    "$BENCH/run_chunk.sh" "$H" "$CLAIMED/$next" "$conc" "$TAG"
  fi
done
echo "[$(date -u +%FT%TZ)] $H pool scheduler $TAG: pool empty, exiting" >> "$BENCH/results/campaign.log"
