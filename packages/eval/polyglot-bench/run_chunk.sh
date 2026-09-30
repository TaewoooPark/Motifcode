#!/bin/bash
# usage: [REPLICATE=N] run_chunk.sh <harness> <chunk-file> <concurrency> <tag>
# Runs one piece of the plan under manifests/<harness>.json. The suite and work directories carry <tag> so that two
# schedulers for one harness never rebuild each other's suite; results go to results/r<N>/<harness>/<piece>.jsonl and
# the runner keeps every row's patch, grades and journals under artifacts/r<N>/<harness>/ whatever the adapter does.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
H="$1"; CHUNK="$2"; CONC="$3"; TAG="$4"; R="${REPLICATE:-1}"
[ -f "$CHUNK" ] || { echo "no chunk file $CHUNK"; exit 2; }
NAME="$(basename "$CHUNK" .txt)"
RES="$BENCH/results/r$R/$H"
mkdir -p "$RES" "$BENCH/work/$H-$TAG" "$BENCH/logs/$H" "$BENCH/artifacts/r$R/$H"
EXCL="$(python3 - "$BENCH/instances.json" "$CHUNK" <<'PY'
import json,sys
ids=[i["id"] for i in json.load(open(sys.argv[1]))]
keep={l.strip() for l in open(sys.argv[2]) if l.strip() and not l.startswith("#")}
print(",".join(i for i in ids if i not in keep))
PY
)"
cd "$BENCH"
echo "[$(date -u +%FT%TZ)] r$R $H $NAME start (concurrency $CONC, scheduler $TAG)" >> "$BENCH/results/campaign.log"
suite run --benchmark "$POLYGLOT" --out "$BENCH/suite-$H-$TAG" --languages "$LANGS" --node-path "$NODE_PATH_DIR" \
  --manifest "$BENCH/manifests/$H.json" --agent "$BENCH/adapters/$H.sh" --replicate "$R" \
  --results "$RES/$NAME.jsonl" --work-root "$BENCH/work/$H-$TAG" --artifacts "$BENCH/artifacts/r$R/$H" \
  --concurrency "$CONC" --exclude "$EXCL" \
  > "$RES/$NAME.out" 2> "$RES/$NAME.err"
code=$?
echo "[$(date -u +%FT%TZ)] r$R $H $NAME end exit $code (scheduler $TAG)" >> "$BENCH/results/campaign.log"
exit $code
