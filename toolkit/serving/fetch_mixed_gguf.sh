#!/usr/bin/env bash
# Fetch the community mixed-quant Motif-3 GGUF and verify it against the
# publisher's hashes.
#
# Why this artifact: it is the only Motif-3 build measured on a single GB10 —
# a 262,080-token prompt plus decode, and three-way 196K-context serving. It
# keeps the full topology (all 53 layers, all 384 routed experts, top-8, the
# shared expert, GDLA, PolyNorm, mHC, and the one-layer MTP predictor); the
# 87.70 GiB comes from precision assignment, not from dropping anything.
#
#   routed expert gate/up   IQ2_XXS + Q8 imatrix   <- carries the compression
#   routed expert down      Q2_K    + Q8 imatrix
#   embeddings / LM head    Q8_0                   <- always active
#   GDLA, dense MLP, MTP    Q8_0
#   router                  F32                    <- top-8 decision stability
#
# The revision is pinned. The publisher notes later model-card commits do not
# change shard bytes, but a pin is what makes the hash check meaningful.
#
# The retry loop is not defensive programming: a 94 GB pull over a home link
# drops at least once, and `hf download` resumes from what is already on disk.
set -euo pipefail

REPO=${REPO:-Baekpica/Motif-3-Mixed-Quant-GGUF}
REV=${REV:-efd6044e25e7f8e3b459a737d021091e2e69b6c6}
DST=${DST:-$HOME/motif-serve/models/Motif-3-MQ87-88-FIT}
VENV=${VENV:-$HOME/motif-prune/.venv-fork}
ATTEMPTS=${ATTEMPTS:-40}

# 94,162,542,816 bytes of shards, plus room for the runtime to page.
NEED_GIB=110
avail_gib=$(df -BG --output=avail "$(dirname "$(dirname "$DST")")" 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$avail_gib" ] && [ "$avail_gib" -lt "$NEED_GIB" ]; then
  echo "only ${avail_gib} GiB free, need ~${NEED_GIB} GiB" >&2
  exit 1
fi

mkdir -p "$DST"
export HF_HUB_ENABLE_HF_TRANSFER=0

for attempt in $(seq 1 "$ATTEMPTS"); do
  echo "=== attempt $attempt at $(date -Is) ==="
  if "$VENV/bin/hf" download "$REPO" \
      --revision "$REV" \
      --include 'Motif-3-MQ87-88-FIT-*.gguf' \
      --include 'MQ87-88-FIT-SHA256SUMS' \
      --include 'MQ87-88-FIT-VERIFY.json' \
      --local-dir "$DST" \
      --max-workers 8; then
    echo "=== download complete at $(date -Is) ==="
    break
  fi
  echo "--- attempt $attempt failed, retrying in 30s ---"
  sleep 30
done

cd "$DST"
if [ ! -f MQ87-88-FIT-SHA256SUMS ]; then
  echo "no SHA256SUMS — refusing to call this verified" >&2
  exit 1
fi

echo
echo "=== shard inventory ==="
ls -l Motif-3-MQ87-88-FIT-*.gguf | awk '{s+=$5; print}  END {printf "total %d bytes (%.2f GiB)\n", s, s/1073741824}'
echo "expected 94162542816 bytes (87.6957 GiB)"

echo
echo "=== verifying hashes (this reads 94 GB; a few minutes) ==="
# The published file lists more than we downloaded; check only what is here.
grep -F 'Motif-3-MQ87-88-FIT-' MQ87-88-FIT-SHA256SUMS > .sums.here || true
if sha256sum -c .sums.here; then
  echo "=== all shards verified at $(date -Is) ==="
else
  echo "=== HASH MISMATCH — do not serve this ===" >&2
  exit 1
fi
