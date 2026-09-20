#!/bin/bash
# OpenCode against Motif-3 through an openai-compatible provider, with isolated XDG dirs.
HARNESS=opencode
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
export XDG_CONFIG_HOME="$BENCH/homes/opencode/config"
# Per-row data and state: OpenCode keeps a SQLite db under XDG_DATA_HOME, and two rows starting at the
# same instant on one db die with "database is locked". The row directory is removed by the runner after grading.
export XDG_DATA_HOME="$ROWDIR/xdg/data"
export XDG_STATE_HOME="$ROWDIR/xdg/state"
mkdir -p "$XDG_DATA_HOME" "$XDG_STATE_HOME"
export XDG_CACHE_HOME="$BENCH/homes/opencode/cache"
cd "$CWD" || exit 97
run_with_deadline opencode run --pure --dir "$CWD" -m infron/motif/motif-3 --format json --dangerously-skip-permissions "$PROMPT" \
  > "$LOGDIR/agent.log" 2> "$LOGDIR/agent.err"
code=$?
reason=done
if [ $code -ne 0 ]; then reason="$(classify_failure)"; fi
write_journal "$reason"
finish "$code" "$reason"
exit $code
