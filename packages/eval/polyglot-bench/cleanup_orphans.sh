#!/bin/bash
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"
# Kill processes whose working directory is a benchmark checkout that no longer exists (left behind by a killed row).
for p in $(pgrep -f '.'); do
  case "$(ps -o comm= -p "$p" 2>/dev/null)" in *bin/java) continue;; esac
  cwd="$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)"
  case "$cwd" in
    "$BENCH"/work/*/*/checkout*) [ -d "$cwd" ] || { echo "orphan $p ($cwd)"; kill -KILL "$p" 2>/dev/null; } ;;
  esac
done
