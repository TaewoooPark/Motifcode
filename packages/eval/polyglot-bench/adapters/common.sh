# Shared by the three agent adapters. The runner (motif-suite run) spawns an adapter as
#   <adapter> "<prompt>" --cwd <checkout> --journal <path> --endpoint <url> --model <id> \
#             --channel toolcall --channel-policy fixed --max-turns N --max-output-tokens N --seed N --no-hero
# with MOTIF_API_KEY in the environment, and reads the journal's session_end event for the outcome.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/env.sh"
PROMPT="$1"; shift
CWD=""; JOURNAL=""; ENDPOINT=""; MODEL=""; MAX_TURNS=""; MAX_OUT=""; SEED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) CWD="$2"; shift 2 ;;
    --journal) JOURNAL="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --max-turns) MAX_TURNS="$2"; shift 2 ;;
    --max-output-tokens) MAX_OUT="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --channel|--channel-policy) shift 2 ;;
    *) shift ;;
  esac
done
ROWDIR="$(dirname "$CWD")"
# logs/<harness>/<configId>--<lang>/<exercise>--<seed>--<rep>/ mirrors the runner's row directory.
REL="${ROWDIR#"$BENCH"/work/*/}"   # strips work/<any root>/, so pool schedulers with their own work roots log to the same place
LOGDIR="$BENCH/logs/$HARNESS/$REL"
mkdir -p "$LOGDIR"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
START_MS=$(python3 -c 'import time;print(int(time.time()*1000))')

# Run the agent with a deadline just under the runner's task_wall_timeout_seconds (900). Returns the
# agent's exit code, or 124 when the deadline killed it.
ADAPTER_DEADLINE_S=870
# A row may not hold more than this much resident memory across the agent and everything it spawned; a
# runaway test (a solution that loops forever) otherwise eats the machine and slows every other row.
ROW_RSS_LIMIT_KB=$((8*1024*1024))
TIMED_OUT=0
MEM_KILLED=0
group_rss_kb() { local pids; pids="$(pgrep -g "$1" 2>/dev/null | tr '\n' ',')"; [ -n "$pids" ] && ps -o rss= -p "${pids%,}" 2>/dev/null | awk '{s+=$1} END {print s+0}' || echo 0; }
kill_group() {
  # Everything in the agent's group except java: Gradle daemons are shared between rows, and killing one mid-build
  # fails a build that is not this row's. Daemons are disabled via GRADLE_OPTS for rows started after this change.
  local pids; pids="$(pgrep -g "$1" 2>/dev/null)"
  local keep=""; for p in $pids; do case "$(ps -o comm= -p "$p" 2>/dev/null)" in *bin/java) ;; *) keep="$keep $p";; esac; done
  [ -n "$keep" ] && { kill -TERM $keep 2>/dev/null; sleep 3; kill -KILL $keep 2>/dev/null; }
}
run_with_deadline() {
  local marker="$LOGDIR/.deadline_fired" memmarker="$LOGDIR/.memory_limit_fired"; rm -f "$marker" "$memmarker"
  # The agent leads its own process group, so everything it spawns can be stopped together.
  perl -e 'setpgrp(0,0); exec @ARGV or die "exec: $!"' -- "$@" & local pid=$!
  ( local t=0
    while [ "$t" -lt "$ADAPTER_DEADLINE_S" ]; do
      sleep 10; t=$((t+10))
      kill -0 "$pid" 2>/dev/null || exit 0
      if [ "$(group_rss_kb "$pid")" -gt "$ROW_RSS_LIMIT_KB" ]; then touch "$memmarker"; kill_group "$pid"; exit 0; fi
    done
    touch "$marker"; kill_group "$pid" ) & local wd=$!
  wait "$pid"; local code=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  # Whatever the agent left behind in its group (a hung test, a build) goes with it.
  kill_group "$pid"
  if [ -f "$memmarker" ]; then MEM_KILLED=1; code=137; rm -f "$memmarker"; fi
  if [ -f "$marker" ]; then TIMED_OUT=1; code=124; rm -f "$marker"; fi
  return $code
}

# Why a non-zero exit happened, from the harness's own logs.
#   repetition_abort : the router stopped generation ("Repetition was detected ...") and the harness gave up
#   transport_error  : an actual HTTP 429 / rate limit / connection failure (the runner counts these as model_transport_failure)
#   agent_error      : anything else
classify_failure() {
  local logs="$LOGDIR/agent.err $LOGDIR/agent.log"
  if [ "$MEM_KILLED" = 1 ]; then echo memory_limit
  elif [ "$TIMED_OUT" = 1 ]; then echo wall_timeout
  elif grep -q 'Repetition was detected' $logs 2>/dev/null; then echo repetition_abort
  elif grep -q -E 'Too Many Requests|rate.?limit|"status": ?429|status code 429|HTTP 429|429 Too Many|ECONNREFUSED|ENOTFOUND|ECONNRESET' $logs 2>/dev/null; then echo transport_error
  else echo agent_error; fi
}

# Write a minimal journal the runner understands. Reason: done | agent_error | transport_error.
write_journal() {
  local reason="$1"
  printf '%s\n' "{\"v\":2,\"seq\":1,\"at\":\"$(now)\",\"runId\":\"$HARNESS-$SEED\",\"scopeId\":\"root\",\"scopeKind\":\"root\",\"record\":{\"t\":\"event\",\"event\":{\"type\":\"session_start\",\"model\":\"$MODEL\",\"endpoint\":\"$ENDPOINT\",\"channel\":\"toolcall\",\"tools\":[],\"toolsHash\":\"$HARNESS\"}}}" > "$JOURNAL"
  printf '%s\n' "{\"v\":2,\"seq\":2,\"at\":\"$(now)\",\"runId\":\"$HARNESS-$SEED\",\"scopeId\":\"root\",\"scopeKind\":\"root\",\"record\":{\"t\":\"event\",\"event\":{\"type\":\"session_end\",\"reason\":\"$reason\"}}}" >> "$JOURNAL"
}

# Keep the evidence the runner deletes with the row: the patch, the harness log, the journal, timing.
finish() {
  local code="$1"; local reason="$2"
  local end_ms; end_ms=$(python3 -c 'import time;print(int(time.time()*1000))')
  ( cd "$CWD" && git add -A >/dev/null 2>&1 && git diff --cached --binary > "$LOGDIR/patch.diff" 2>/dev/null; git reset -q >/dev/null 2>&1 ) || true
  [ -f "$JOURNAL" ] && cp "$JOURNAL" "$LOGDIR/session.jsonl"
  printf '{"harness":"%s","exit":%s,"reason":"%s","wallMs":%s,"cwd":"%s","seed":"%s","maxTurns":"%s","maxOutputTokens":"%s"}\n' \
    "$HARNESS" "$code" "$reason" "$((end_ms-START_MS))" "$CWD" "$SEED" "$MAX_TURNS" "$MAX_OUT" > "$LOGDIR/meta.json"
}
