# Shared by the three agent adapters. The runner (motif-suite run) spawns an adapter as
#   <adapter> "<prompt>" [--continue-from <journal>] --cwd <dir> --journal <path> --endpoint <url> --model <id> \
#             --channel toolcall --channel-policy fixed --max-turns N --max-output-tokens N --seed N --no-hero
# with MOTIF_API_KEY in the environment, and reads the journal's session_end event for the outcome.
# --continue-from marks the feedback round (track H2): the same session, resumed once with the test output.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/env.sh"
PROMPT="$1"; shift
CWD=""; JOURNAL=""; ENDPOINT=""; MODEL=""; MAX_TURNS=""; MAX_OUT=""; SEED=""; CONTINUE_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cwd) CWD="$2"; shift 2 ;;
    --journal) JOURNAL="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --max-turns) MAX_TURNS="$2"; shift 2 ;;
    --max-output-tokens) MAX_OUT="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --continue-from) CONTINUE_FROM="$2"; shift 2 ;;
    --channel|--channel-policy) shift 2 ;;
    *) shift ;;
  esac
done
# A message that starts with a dash reads as an option to all three CLIs, and a Go feedback round opens with
# `go test`'s "--- FAIL"; a leading newline keeps it the message.
case "$PROMPT" in -*) PROMPT=$'\n'"$PROMPT" ;; esac
ROWDIR="$(dirname "$CWD")"
# logs/<harness>/<configId>--<lang>/<exercise>--<seed>--<rep>/ mirrors the runner's row directory.
REL="${ROWDIR#"$BENCH"/work/*/}"   # strips work/<any root>/, so pool schedulers with their own work roots log to the same place
LOGDIR="$BENCH/logs/$HARNESS/$REL"
mkdir -p "$LOGDIR"
# The feedback round keeps its own files beside the first round's.
PHASE=""; [ -n "$CONTINUE_FROM" ] && PHASE="-h2"
# The protocol's sampling, as the manifests record it and motifcode sends it (the model's published generation
# config). Codex and OpenCode send none of their own; their adapters set these.
TEMPERATURE=1.0; TOP_P=0.95
# Every agent gets a home of its own, the same for both rounds of a row: none of the settings, installed skills,
# global instruction files or credentials of whoever runs the campaign reach a row. The tool caches stay shared (env.sh).
export HOME="$ROWDIR/home"; mkdir -p "$HOME"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
START_MS=$(python3 -c 'import time;print(int(time.time()*1000))')

# No wall-clock deadline: protocol v2 has no per-task budget, and the runner's safety cap stands in for a wedged
# process. What stays is a resident-memory cap: a runaway test (a solution that loops forever allocating) otherwise
# eats the machine and slows every other row.
ROW_RSS_LIMIT_KB=$((8*1024*1024))
MEM_KILLED=0
group_rss_kb() { local pids; pids="$(pgrep -g "$1" 2>/dev/null | tr '\n' ',')"; [ -n "$pids" ] && ps -o rss= -p "${pids%,}" 2>/dev/null | awk '{s+=$1} END {print s+0}' || echo 0; }
kill_group() {
  # Everything in the agent's group except java: Gradle daemons are shared between rows, and killing one mid-build
  # fails a build that is not this row's. Daemons are disabled via GRADLE_OPTS.
  local pids; pids="$(pgrep -g "$1" 2>/dev/null)"
  local keep=""; for p in $pids; do case "$(ps -o comm= -p "$p" 2>/dev/null)" in *bin/java) ;; *) keep="$keep $p";; esac; done
  [ -n "$keep" ] && { kill -TERM $keep 2>/dev/null; sleep 3; kill -KILL $keep 2>/dev/null; }
}
run_agent() {
  local memmarker="$LOGDIR/.memory_limit_fired$PHASE"; rm -f "$memmarker"
  # The agent leads its own process group, so everything it spawns can be stopped together — also when the
  # runner's safety cap kills this adapter's group.
  perl -e 'setpgrp(0,0); exec @ARGV or die "exec: $!"' -- "$@" & local pid=$!
  ( while kill -0 "$pid" 2>/dev/null; do
      sleep 10
      if [ "$(group_rss_kb "$pid")" -gt "$ROW_RSS_LIMIT_KB" ]; then touch "$memmarker"; kill_group "$pid"; exit 0; fi
    done ) & local wd=$!
  wait "$pid"; local code=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  # Whatever the agent left behind in its group (a hung test, a build) goes with it.
  kill_group "$pid"
  if [ -f "$memmarker" ]; then MEM_KILLED=1; code=137; rm -f "$memmarker"; fi
  return $code
}

# Why a non-zero exit happened, from the harness's own logs.
#   repetition_abort : the router stopped generation ("Repetition was detected ...") and the harness gave up
#   transport_error  : an actual HTTP 429 / rate limit / connection failure (the runner counts these as model_transport_failure)
#   agent_error      : anything else
classify_failure() {
  local logs="$LOGDIR/agent$PHASE.err $LOGDIR/agent$PHASE.log"
  if [ "$MEM_KILLED" = 1 ]; then echo memory_limit
  elif grep -q 'Repetition was detected' $logs 2>/dev/null; then echo repetition_abort
  elif grep -q -E 'Too Many Requests|rate.?limit|"status": ?429|status code 429|HTTP 429|429 Too Many|ECONNREFUSED|ENOTFOUND|ECONNRESET' $logs 2>/dev/null; then echo transport_error
  else echo agent_error; fi
}

# Write a minimal journal the runner understands. Reason: done | agent_error | transport_error | ...
write_journal() {
  local reason="$1"
  printf '%s\n' "{\"v\":2,\"seq\":1,\"at\":\"$(now)\",\"runId\":\"$HARNESS-$SEED\",\"scopeId\":\"root\",\"scopeKind\":\"root\",\"record\":{\"t\":\"event\",\"event\":{\"type\":\"session_start\",\"model\":\"$MODEL\",\"endpoint\":\"$ENDPOINT\",\"channel\":\"toolcall\",\"tools\":[],\"toolsHash\":\"$HARNESS\"}}}" > "$JOURNAL"
  printf '%s\n' "{\"v\":2,\"seq\":2,\"at\":\"$(now)\",\"runId\":\"$HARNESS-$SEED\",\"scopeId\":\"root\",\"scopeKind\":\"root\",\"record\":{\"t\":\"event\",\"event\":{\"type\":\"session_end\",\"reason\":\"$reason\"}}}" >> "$JOURNAL"
  # The harness's own log beside the journal, where the runner reads every command the agent ran for the
  # network rule.
  ln -sf "$LOGDIR/agent$PHASE.log" "$JOURNAL.agent.log"
}

# Keep the evidence beside the runner's own copy: the patch, the harness log, the journal, timing.
finish() {
  local code="$1"; local reason="$2"
  local end_ms; end_ms=$(python3 -c 'import time;print(int(time.time()*1000))')
  # Against the base (the suite's only commit), so that work the agent committed is in it too.
  ( cd "$CWD" && git add -A >/dev/null 2>&1 && git diff --cached --binary "$(git rev-list --max-parents=0 HEAD | tail -n 1)" > "$LOGDIR/patch$PHASE.diff" 2>/dev/null; git reset -q >/dev/null 2>&1 ) || true
  [ -f "$JOURNAL" ] && cp "$JOURNAL" "$LOGDIR/session$PHASE.jsonl" 2>/dev/null
  printf '{"harness":"%s","phase":"%s","exit":%s,"reason":"%s","wallMs":%s,"cwd":"%s","seed":"%s","maxTurns":"%s","maxOutputTokens":"%s"}\n' \
    "$HARNESS" "${PHASE:-first}" "$code" "$reason" "$((end_ms-START_MS))" "$CWD" "$SEED" "$MAX_TURNS" "$MAX_OUT" > "$LOGDIR/meta$PHASE.json"
}
