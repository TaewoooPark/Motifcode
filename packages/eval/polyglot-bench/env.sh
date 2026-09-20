# Shared environment for the Motif-3 polyglot campaign. Sourced by every script here (bash).
# Relocatable: BENCH is this file's directory unless set; the motifcode checkout is MOTIFCODE_REPO,
# else the repository this directory sits in (packages/eval/polyglot-bench), else ~/personal/Motif-code.
export BENCH="${BENCH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
if [ -n "$MOTIFCODE_REPO" ]; then export REPO="$MOTIFCODE_REPO"
elif [ -f "$BENCH/../../../package.json" ] && grep -q '"name": "motifcode"' "$BENCH/../../../package.json" 2>/dev/null; then export REPO="$(cd "$BENCH/../../.." && pwd)"
else export REPO="$HOME/personal/Motif-code"; fi
export SUITE_JS="$REPO/packages/cli/dist/motif-suite.js"
export MOTIF_JS="$REPO/packages/cli/dist/motif.js"
export POLYGLOT="${POLYGLOT:-$BENCH/polyglot-benchmark}"        # a checkout of Aider-AI/polyglot-benchmark
export NODE_PATH_DIR="${NODE_PATH_DIR:-$BENCH/js-deps/node_modules}"
export LANGS="${LANGS:-cpp,go,java,javascript,python,rust}"
# Toolchain pins: Gradle 8.7 in the Java exercises does not run on JDK 25 (JAVA21_HOME overrides); boost for two C++ exercises.
J="${JAVA21_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
[ -d "$J" ] && export JAVA_HOME="$J" && export PATH="$JAVA_HOME/bin:$PATH"
[ -d "${CXX_EXTRA_INCLUDE:-/opt/homebrew/include}" ] && export CXX_EXTRA_INCLUDE="${CXX_EXTRA_INCLUDE:-/opt/homebrew/include}"
# The suite is rebuilt from scratch on every motif-suite command; fixed dates make the base commits identical across rebuilds.
export GIT_AUTHOR_DATE="2024-12-22T00:00:00+0000"
export GIT_COMMITTER_DATE="2024-12-22T00:00:00+0000"
# Gradle daemons are shared across rows; with per-row process-group kills they must not exist at all.
export GRADLE_OPTS="-Dorg.gradle.daemon=false"
export NO_COLOR=1
suite() { node "$SUITE_JS" "$@"; }
