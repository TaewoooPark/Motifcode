#!/bin/bash
# Install the harnesses in HARNESSES (env.sh) that are not this repository's build or a CLI on PATH:
#
#   motifcode-<version>   that motifcode release. The task round runs the npm package as published. The feedback round
#                         needs `--continue-from`, which no release before this branch has (a finished session could
#                         only be continued at a terminal), so it runs the release's own tag built from source with
#                         harnesses/motifcode-<version>/continue-from.patch, a backport of that one change.
#
# Nothing is installed unless: the npm package was published from the tag; the tag, built here without the patch, is
# byte-identical to the npm bundle; and the patched build carries the same system prompt and tool schemas (compared in
# one directory with an empty home, as the rows run). harnesses/<harness>/identity.json records what was checked.
# FORCE=1 reinstalls what is already there.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

fail() { echo "install_harnesses: $*" >&2; exit 1; }
hashes() {  # <motif.js> <cwd> <home> -> "<system prompt sha256> <tool schema sha256>"
  (cd "$2" && HOME="$3" node "$1" corpus-spec) | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["systemPromptSha256"], d["toolSchemaSha256"])'
}

install_motifcode_release() {
  local h="$1" v="${1#motifcode-}"
  local dir="$BENCH/harnesses/$h" tag="v${1#motifcode-}"
  local patch="$dir/continue-from.patch"
  [ -f "$patch" ] || fail "$h: no $patch — the kit has no feedback-round backport for motifcode $v"
  local patch_sha; patch_sha="$(shasum -a 256 "$patch" | cut -d' ' -f1)"
  if [ "${FORCE:-0}" != 1 ] && [ -f "$dir/identity.json" ] && grep -q "\"continue_patch_sha256\": \"$patch_sha\"" "$dir/identity.json"; then
    echo "$h: installed (FORCE=1 reinstalls)"; return 0
  fi
  command -v pnpm >/dev/null || fail "$h: pnpm is needed to build $tag"
  # A harness half installed is not installed: the adapter would find its builds.
  bail() { rm -rf "$dir/release" "$dir/continue" "$dir/identity.json"; fail "$@"; }

  # The release, as published.
  rm -rf "$dir/release" "$dir/continue" "$dir/identity.json"
  mkdir -p "$dir/release" "$dir/continue"
  npm install --prefix "$dir/release" --no-save --no-audit --no-fund --ignore-scripts "motifcode@$v" >/dev/null || bail "$h: npm install motifcode@$v"
  local rel="$dir/release/node_modules/motifcode/dist/motif.js"
  [ -f "$rel" ] || bail "$h: the package has no dist/motif.js"
  local integrity git_head
  integrity="$(npm view "motifcode@$v" dist.integrity)"; git_head="$(npm view "motifcode@$v" gitHead)"

  # Its tag, from this repository.
  git -C "$REPO" rev-parse -q --verify "$tag^{commit}" >/dev/null || git -C "$REPO" fetch -q --tags origin
  local commit; commit="$(git -C "$REPO" rev-parse "$tag^{commit}")" || bail "$h: no tag $tag in $REPO"
  [ "$commit" = "$git_head" ] || bail "$h: npm motifcode@$v was published from $git_head, not $tag ($commit)"
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/motif-harness.XXXXXX")"
  git -C "$REPO" worktree add -q --detach "$tmp/src" "$tag" || bail "$h: git worktree add $tag"
  (
    set -e
    cd "$tmp/src"
    pnpm install --frozen-lockfile --silent >/dev/null
    pnpm -s build >/dev/null
    cmp -s packages/cli/dist/motif.js "$rel" || { echo "$h: the $tag build is not the npm bundle" >&2; exit 1; }
    git apply "$patch"
    pnpm -s build >/dev/null
    cp packages/cli/dist/motif.js "$dir/continue/motif.js"
  )
  local built=$?
  git -C "$REPO" worktree remove --force "$tmp/src" >/dev/null 2>&1
  [ $built -eq 0 ] || { rm -rf "$tmp"; bail "$h: building $tag with the backport failed"; }

  # The same prompt and tools, so that a journal the release wrote is one the backport continues.
  mkdir -p "$tmp/cwd" "$tmp/home"
  local a b; a="$(hashes "$rel" "$tmp/cwd" "$tmp/home")"; b="$(hashes "$dir/continue/motif.js" "$tmp/cwd" "$tmp/home")"
  rm -rf "$tmp"
  [ -n "$a" ] && [ "$a" = "$b" ] || bail "$h: the backport build's system prompt or tool schemas differ from the release's"

  python3 - "$dir/identity.json" <<PY
import json, sys
json.dump({
    "harness": "$h", "version": "$v",
    "task_round": {"npm": "motifcode@$v", "integrity": "$integrity", "git_head": "$git_head",
                   "bundle_sha256": "$(shasum -a 256 "$rel" | cut -d' ' -f1)"},
    "feedback_round": {"tag": "$tag", "commit": "$commit", "continue_patch_sha256": "$patch_sha",
                       "bundle_sha256": "$(shasum -a 256 "$dir/continue/motif.js" | cut -d' ' -f1)"},
    "checks": ["npm gitHead is the tag's commit", "the tag's build is byte-identical to the npm bundle",
               "the backport build has the release's system prompt and tool schemas"],
    "tool_schema_sha256": "${a#* }",
}, open(sys.argv[1], "w"), indent=2)
PY
  echo "$h: npm motifcode@$v for the task round; $tag + continue-from.patch for the feedback round"
}

for h in $HARNESSES; do
  case "$h" in
    motifcode-*) install_motifcode_release "$h" ;;
    motifcode) [ -f "$MOTIF_JS" ] || fail "motifcode: no $MOTIF_JS (pnpm install && pnpm build in $REPO)" ;;
    *) command -v "$h" >/dev/null || fail "$h: not on PATH" ;;
  esac
done
