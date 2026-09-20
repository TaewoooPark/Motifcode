#!/bin/bash
# motifcode: the real binary with the runner's own flags; afterwards keep journal + patch.
HARNESS=motifcode
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
# The runner reads $JOURNAL inside the row directory, which it deletes after grading; the file itself lives in LOGDIR.
: > "$LOGDIR/session.jsonl" && ln -sf "$LOGDIR/session.jsonl" "$JOURNAL"
run_with_deadline node "$MOTIF_JS" "$PROMPT" --cwd "$CWD" --journal "$JOURNAL" --endpoint "$ENDPOINT" --model "$MODEL" \
  --channel toolcall --channel-policy fixed --max-turns "$MAX_TURNS" --max-output-tokens "$MAX_OUT" --seed "$SEED" --no-hero \
  > "$LOGDIR/agent.log" 2> "$LOGDIR/agent.err"
code=$?
reason="(journal)"
if [ "$TIMED_OUT" = 1 ] || [ "$MEM_KILLED" = 1 ]; then
  # The loop never wrote session_end; append one so the runner reads a reason instead of an unfinished journal.
  reason=wall_timeout; [ "$MEM_KILLED" = 1 ] && reason=memory_limit
  printf '%s\n' "{\"v\":2,\"seq\":999999,\"at\":\"$(now)\",\"runId\":\"motifcode-$SEED\",\"scopeId\":\"root\",\"scopeKind\":\"root\",\"record\":{\"t\":\"event\",\"event\":{\"type\":\"session_end\",\"reason\":\"$reason\"}}}" >> "$LOGDIR/session.jsonl"
fi
finish "$code" "$reason"
exit $code
