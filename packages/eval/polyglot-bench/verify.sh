#!/bin/bash
# Build the suite from the polyglot checkout and verify every track: the untouched stub must fail its tests and the
# shipped reference must pass them. Writes instances.json and verify/<language>.json; make_chunks.py reads the
# exclusions from there (already-passing stubs, references that do not build, exercises that cannot run here).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
[ -d "$POLYGLOT/python" ] || { echo "no polyglot checkout at $POLYGLOT (git clone https://github.com/Aider-AI/polyglot-benchmark)"; exit 2; }
[ -d "$NODE_PATH_DIR/jest" ] || { echo "no jest under $NODE_PATH_DIR (cd js-deps && npm install)"; exit 2; }
[ -f "$SUITE_JS" ] || { echo "no $SUITE_JS (pnpm install && pnpm build in the motifcode repository)"; exit 2; }
cd "$BENCH" && mkdir -p verify
suite build --benchmark "$POLYGLOT" --out "$BENCH/suite-verify" --languages "$LANGS" --node-path "$NODE_PATH_DIR" > instances.json || exit 1
for l in ${LANGS//,/ }; do
  ( suite verify --benchmark "$POLYGLOT" --out "$BENCH/suite-verify" --languages "$l" --node-path "$NODE_PATH_DIR" --timeout 300 > "verify/$l.json" 2> "verify/$l.log"; echo "exit $?" >> "verify/$l.log" ) &
done
wait
for l in ${LANGS//,/ }; do
  python3 - "$l" <<'PY'
import json, sys
l = sys.argv[1]
try:
    d = json.load(open(f"verify/{l}.json"))
    print(f"{l:11s} checked {d['checked']:3d}  confirmed {d['confirmed']:3d}  reference-broken {d['referenceBrokenButRunnable']}  already-passing {d['alreadyPassing']}  unrunnable {d['unrunnable']}")
except Exception as e:
    print(f"{l:11s} no result: {e}")
PY
done
