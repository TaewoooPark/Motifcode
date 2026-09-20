#!/bin/bash
# Codex CLI against Motif-3 through the responses route, with an isolated CODEX_HOME.
HARNESS=codex
source "$(cd "$(dirname "$0")" && pwd)/common.sh"
# Per-row CODEX_HOME from a pristine config: no state (memories, trust list, sqlite) carries between rows.
export CODEX_HOME="$ROWDIR/codex-home"
mkdir -p "$CODEX_HOME" && cp "$BENCH/homes/codex/config.pristine.toml" "$CODEX_HOME/config.toml"
cd "$CWD" || exit 97
run_with_deadline codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C "$CWD" -m motif/motif-3 \
  --json -o "$LOGDIR/last_message.txt" "$PROMPT" > "$LOGDIR/agent.log" 2> "$LOGDIR/agent.err"
code=$?
reason=done
if [ $code -ne 0 ]; then reason="$(classify_failure)"; fi
write_journal "$reason"
finish "$code" "$reason"
exit $code
