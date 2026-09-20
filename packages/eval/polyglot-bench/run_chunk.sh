#!/bin/bash
# usage: run_chunk.sh <harness> <chunk-file> <concurrency> <tag>
# Same as run_chunk.sh, but the suite and work directories carry <tag> so that two schedulers for one
# harness never rebuild each other's suite. Results, logs and manifests are shared.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
H="$1"; CHUNK="$2"; CONC="$3"; TAG="$4"
[ -f "$CHUNK" ] || { echo "no chunk file $CHUNK"; exit 2; }
NAME="$(basename "$CHUNK" .txt)"
mkdir -p "$BENCH/results/$H" "$BENCH/work/$H-$TAG" "$BENCH/logs/$H"
EXCL="$(python3 - "$BENCH/instances.json" "$CHUNK" <<'PY'
import json,sys
ids=[i["id"] for i in json.load(open(sys.argv[1]))]
keep={l.strip() for l in open(sys.argv[2]) if l.strip() and not l.startswith("#")}
print(",".join(i for i in ids if i not in keep))
PY
)"
cd "$BENCH"
echo "[$(date -u +%FT%TZ)] $H $NAME start (concurrency $CONC, scheduler $TAG)" >> "$BENCH/results/campaign.log"
suite run --benchmark "$POLYGLOT" --out "$BENCH/suite-$H-$TAG" --languages "$LANGS" --node-path "$NODE_PATH_DIR" \
  --manifest "$BENCH/manifests/$H.json" --agent "$BENCH/adapters/$H.sh" \
  --results "$BENCH/results/$H/$NAME.jsonl" --work-root "$BENCH/work/$H-$TAG" --concurrency "$CONC" --exclude "$EXCL" \
  > "$BENCH/results/$H/$NAME.out" 2> "$BENCH/results/$H/$NAME.err"
code=$?
echo "[$(date -u +%FT%TZ)] $H $NAME end exit $code (scheduler $TAG)" >> "$BENCH/results/campaign.log"
exit $code
