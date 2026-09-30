#!/bin/bash
# OpenCode against Motif-3 through an openai-compatible provider, with isolated XDG dirs.
HARNESS=opencode
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
# Per-row config, data and state. The config is the pristine one with the manifest's output cap as the model's
# output limit, which OpenCode sends as max_tokens. OpenCode keeps a SQLite db under XDG_DATA_HOME, and two rows
# starting at the same instant on one db die with "database is locked"; the feedback round resumes the first
# round's session from the same db. The row directory is removed by the runner after grading.
export XDG_CONFIG_HOME="$ROWDIR/xdg/config"
export XDG_DATA_HOME="$ROWDIR/xdg/data"
export XDG_STATE_HOME="$ROWDIR/xdg/state"
export XDG_CACHE_HOME="$BENCH/homes/opencode/cache"
mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
python3 - "$BENCH/homes/opencode/config/opencode/opencode.json" "$XDG_CONFIG_HOME/opencode/opencode.json" "$MAX_OUT" <<'PY'
import json, sys
src, dst, cap = sys.argv[1], sys.argv[2], sys.argv[3]
c = json.load(open(src))
if cap and cap not in ("0", "off"):
    for m in c["provider"]["infron"]["models"].values(): m["limit"]["output"] = int(cap)
json.dump(c, open(dst, "w"), indent=2)
PY
# The flag that skips permission prompts was renamed between releases.
if opencode run --help 2>&1 | grep -q -- '--dangerously-skip-permissions'; then APPROVE=--dangerously-skip-permissions; else APPROVE=--auto; fi
SESSION=()
if [ -n "$CONTINUE_FROM" ]; then
  ID="$(grep -m1 -o '"sessionID":"[^"]*"' "$LOGDIR/agent.log" 2>/dev/null | cut -d'"' -f4)"
  if [ -n "$ID" ]; then SESSION=(--session "$ID"); else SESSION=(--continue); fi
fi
cd "$CWD" || exit 97
run_agent opencode run --pure --dir "$CWD" -m infron/motif/motif-3 --format json "$APPROVE" "${SESSION[@]}" "$PROMPT" \
  > "$LOGDIR/agent$PHASE.log" 2> "$LOGDIR/agent$PHASE.err"
code=$?
reason=done
if [ $code -ne 0 ]; then reason="$(classify_failure)"; fi
write_journal "$reason"
finish "$code" "$reason"
exit $code
