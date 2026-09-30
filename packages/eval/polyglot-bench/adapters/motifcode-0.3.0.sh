#!/bin/bash
# motifcode 0.3.0 — the build the 2026-09-20 campaign ran (tag v0.3.0, a87dec0) — as published on npm; the feedback
# round continues its session with v0.3.0 built with the --continue-from backport. Both come from install_harnesses.sh.
D="$(cd "$(dirname "$0")/.." && pwd)/harnesses/motifcode-0.3.0"
export HARNESS=motifcode-0.3.0
export MOTIF_JS_TASK="$D/release/node_modules/motifcode/dist/motif.js"
export MOTIF_JS_CONTINUE="$D/continue/motif.js"
exec "$(cd "$(dirname "$0")" && pwd)/motifcode.sh" "$@"
