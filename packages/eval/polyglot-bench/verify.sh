#!/bin/bash
# Build the suite from the polyglot checkout (TRACK=H by default, or V) and verify every exercise under both rule
# sets: the untouched stub must fail its tests — six refactoring exercises pass untouched and are listed, not
# dropped — and the shipped reference must pass them, a Rust reference with its Cargo-example.toml. Writes
# instances.json (the fingerprinted instance list make_manifests.py pins) and verify/<language>.json.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
[ -d "$POLYGLOT/python" ] || { echo "no polyglot checkout at $POLYGLOT (git clone https://github.com/Aider-AI/polyglot-benchmark)"; exit 2; }
[ -d "$NODE_PATH_DIR/jest" ] || { echo "no jest under $NODE_PATH_DIR (cd js-deps && npm install)"; exit 2; }
[ -f "$SUITE_JS" ] || { echo "no $SUITE_JS (pnpm install && pnpm build in the motifcode repository)"; exit 2; }
TRACK="${TRACK:-H}"
cd "$BENCH" && mkdir -p verify
suite build --benchmark "$POLYGLOT" --out "$BENCH/suite-verify" --languages "$LANGS" --track "$TRACK" --node-path "$NODE_PATH_DIR" > instances.json || exit 1
for l in ${LANGS//,/ }; do
  ( suite verify --benchmark "$POLYGLOT" --out "$BENCH/suite-verify-$l" --languages "$l" --track "$TRACK" --node-path "$NODE_PATH_DIR" > "verify/$l.json" 2> "verify/$l.log"; echo "exit $?" >> "verify/$l.log" ) &
done
wait
for l in ${LANGS//,/ }; do
  python3 - "$l" <<'PY'
import json, sys
l = sys.argv[1]
try:
    d = json.load(open(f"verify/{l}.json"))
    print(f"{l:11s} checked {d['checked']:3d}  stub fails {d['stubFails']:3d}  stub passes {d['stubPasses']}  "
          f"reference official {d['referenceConfirmedOfficial']:3d} strict {d['referenceConfirmedStrict']:3d}  "
          f"reference-broken {d['referenceBrokenButRunnable']}  unrunnable {d['unrunnable']}")
    for line in d["stubPassesIds"]: print(f"  stub passes untouched: {line}")
    for line in d["referenceBroken"] + d["unrunnableDetail"]: print(f"  {line}")
except Exception as e:
    print(f"{l:11s} no result: {e}")
PY
done
