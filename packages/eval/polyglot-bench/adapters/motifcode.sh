#!/bin/bash
# motifcode: the real binary with the runner's own flags; afterwards keep journal + patch. This repository's build,
# unless a release's adapter (motifcode-<version>.sh) names the builds to run.
HARNESS="${HARNESS:-motifcode}"
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
JS="${MOTIF_JS_TASK:-$MOTIF_JS}"
[ -n "$CONTINUE_FROM" ] && [ -n "$MOTIF_JS_CONTINUE" ] && JS="$MOTIF_JS_CONTINUE"
BUILD="$JS"
if [ ! -f "$JS" ]; then
  echo "no $JS: run ./install_harnesses.sh" | tee -a "$LOGDIR/agent$PHASE.err" >&2
  exit 2
fi
# The runner reads $JOURNAL inside the row directory, which it deletes after grading; the file itself lives in LOGDIR.
: > "$LOGDIR/session$PHASE.jsonl" && ln -sf "$LOGDIR/session$PHASE.jsonl" "$JOURNAL"
# The feedback round continues the first round's session from its journal.
CONT=(); [ -n "$CONTINUE_FROM" ] && CONT=(--continue-from "$CONTINUE_FROM")
run_agent node "$JS" "$PROMPT" "${CONT[@]}" --cwd "$CWD" --journal "$JOURNAL" --endpoint "$ENDPOINT" --model "$MODEL" \
  --channel toolcall --channel-policy fixed --max-turns "$MAX_TURNS" --max-output-tokens "$MAX_OUT" --seed "$SEED" --no-hero \
  > "$LOGDIR/agent$PHASE.log" 2> "$LOGDIR/agent$PHASE.err"
code=$?
reason="(journal)"
if [ "$MEM_KILLED" = 1 ]; then
  # The loop never wrote session_end; append one so the runner reads a reason instead of an unfinished journal.
  reason=memory_limit
  printf '%s\n' "{\"v\":2,\"seq\":999999,\"at\":\"$(now)\",\"runId\":\"motifcode-$SEED\",\"scopeId\":\"root\",\"scopeKind\":\"root\",\"record\":{\"t\":\"event\",\"event\":{\"type\":\"session_end\",\"reason\":\"$reason\"}}}" >> "$LOGDIR/session$PHASE.jsonl"
fi
finish "$code" "$reason"
exit $code
