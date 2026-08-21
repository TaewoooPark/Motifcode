#!/usr/bin/env bash
# Serve the mixed-quant Motif-3 GGUF through ds4-dfm on GB10.
#
# Configuration notes, each of which is a decision rather than a default:
#
#   --no-spec        The publisher's own GB10 gates ran without speculation.
#                    The artifact does contain the one-layer MTP predictor, so
#                    speculative decode is a later experiment — but it is an
#                    experiment, and it does not belong in the run that first
#                    establishes whether the model works at all.
#
#   -c 32768         Coding-agent turns are small: a stub, a test file, an
#                    instruction. 256K is what this artifact is famous for and
#                    it costs 4.9x decode speed to use it. Startup allocates KV
#                    for whatever is asked here, so asking for less is free.
#
#   --kv-disk-dir    An agent resends the same system prompt and tool list every
#                    turn. At 396 tok/s prefill a 32K prefix is 80 seconds if it
#                    is recomputed; the disk KV cache is what stops that. The
#                    server's own docs call this the case it is for.
#
#   MemoryMax        GPU memory is host memory here. A bad flag does not fail
#                    with an allocator error, it takes the desktop session down;
#                    that has happened on this box. ds4's own --mem-floor-gb is
#                    a second line, not a substitute for the cgroup.
#
set -euo pipefail

ROOT=${ROOT:-$HOME/motif-serve}
DS4=${DS4:-$ROOT/ds4}
MODEL=${MODEL:-$ROOT/models/Motif-3-MQ87-88-FIT/Motif-3-MQ87-88-FIT-00001-of-00011.gguf}
PORT=${PORT:-8080}
CTX=${CTX:-32768}
RESERVE_GIB=${RESERVE_GIB:-12}

[ -x "$DS4/ds4-server" ] || { echo "no ds4-server at $DS4 — run build_ds4.sh" >&2; exit 1; }
[ -f "$MODEL" ]          || { echo "no model at $MODEL — run fetch_mixed_gguf.sh" >&2; exit 1; }

mkdir -p "$ROOT/kv" "$ROOT/logs"

TOTAL_GIB=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
CAP_GIB=$(( TOTAL_GIB - RESERVE_GIB ))

echo "model      : $(basename "$MODEL")"
echo "context    : $CTX"
echo "cgroup cap : ${CAP_GIB}G of ${TOTAL_GIB} GiB"
echo "endpoint   : http://127.0.0.1:$PORT"
echo

# Motif-3 prefill is chunked explicitly; the publisher's GB10 runs used 4096.
export DS4_MOTIF3_PREFILL_CHUNK=${DS4_MOTIF3_PREFILL_CHUNK:-4096}
export DS4_SERVER_COALESCE_MAX=${DS4_SERVER_COALESCE_MAX:-2}
export DS4_NO_UPDATE_CHECK=1

cd "$DS4"
exec systemd-run --user --scope --quiet \
  -p MemoryMax=${CAP_GIB}G -p MemorySwapMax=0 \
  -- choom -n 800 -- \
  ./ds4-server \
    --model "$MODEL" \
    --model-id motif-3 \
    --ctx "$CTX" \
    --host 127.0.0.1 \
    --port "$PORT" \
    --no-spec \
    --mem-floor-gb 8 \
    --kv-disk-dir "$ROOT/kv" \
    --kv-disk-space-mb 32768 \
    --trace "$ROOT/logs/trace.jsonl"
