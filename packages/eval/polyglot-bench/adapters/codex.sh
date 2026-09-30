#!/bin/bash
# Codex CLI against Motif-3 through the responses route, with an isolated CODEX_HOME.
HARNESS=codex
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
# Per-row CODEX_HOME from a pristine config: no state (memories, trust list, sqlite) carries between rows. The
# feedback round resumes the first round's session, so it keeps the home that session lives in.
export CODEX_HOME="$ROWDIR/codex-home"
if [ -z "$CONTINUE_FROM" ]; then mkdir -p "$CODEX_HOME" && cp "$BENCH/homes/codex/config.pristine.toml" "$CODEX_HOME/config.toml"; fi
# The output cap: codex-cli 0.154 has no setting for max_output_tokens, so a per-row proxy adds the manifest's cap
# (--max-output-tokens) to each request, as motifcode and OpenCode send it themselves. CODEX_STOCK=1 runs Codex as
# shipped, without a cap — the "stock" track.
OVERRIDE=(); PROXY=""
if [ "${CODEX_STOCK:-0}" != 1 ] && [ -n "$MAX_OUT" ] && [ "$MAX_OUT" != 0 ] && [ "$MAX_OUT" != off ]; then
  PORTFILE="$LOGDIR/.cap-port$PHASE"; rm -f "$PORTFILE"
  node "$BENCH/adapters/cap_proxy.mjs" "${ENDPOINT%/}" "$MAX_OUT" "$PORTFILE" "$LOGDIR/cap-proxy$PHASE.jsonl" 2>> "$LOGDIR/agent$PHASE.err" & PROXY=$!
  for _ in $(seq 1 100); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
  [ -s "$PORTFILE" ] || { echo "cap proxy did not start" >> "$LOGDIR/agent$PHASE.err"; kill "$PROXY" 2>/dev/null; write_journal agent_error; finish 98 agent_error; exit 98; }
  OVERRIDE=(-c "model_providers.infron.base_url=\"http://127.0.0.1:$(cat "$PORTFILE")/v1\"")
fi
cd "$CWD" || exit 97
if [ -z "$CONTINUE_FROM" ]; then
  run_agent codex exec "${OVERRIDE[@]}" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C "$CWD" -m motif/motif-3 \
    --json -o "$LOGDIR/last_message$PHASE.txt" "$PROMPT" > "$LOGDIR/agent$PHASE.log" 2>> "$LOGDIR/agent$PHASE.err"
else
  # The first round's thread, from its own event log.
  THREAD="$(grep -m1 -o '"thread_id":"[^"]*"' "$LOGDIR/agent.log" 2>/dev/null | cut -d'"' -f4)"
  if [ -z "$THREAD" ]; then
    echo "no thread id in the first round's log; nothing to resume" >> "$LOGDIR/agent$PHASE.err"
    [ -n "$PROXY" ] && kill "$PROXY" 2>/dev/null
    write_journal agent_error; finish 96 agent_error; exit 96
  fi
  run_agent codex exec resume "${OVERRIDE[@]}" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m motif/motif-3 \
    --json -o "$LOGDIR/last_message$PHASE.txt" "$THREAD" "$PROMPT" > "$LOGDIR/agent$PHASE.log" 2>> "$LOGDIR/agent$PHASE.err"
fi
code=$?
[ -n "$PROXY" ] && kill "$PROXY" 2>/dev/null
reason=done
if [ $code -ne 0 ]; then reason="$(classify_failure)"; fi
write_journal "$reason"
finish "$code" "$reason"
exit $code
