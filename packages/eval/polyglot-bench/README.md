# polyglot-bench

A benchmark of the harness around a model: Motif-3, through four harnesses on the Aider polyglot tasks, graded by this
package. Anyone with an Infron API key can repeat it.

| Harness (`HARNESSES` in `env.sh`) | What runs |
|---|---|
| `motifcode` | this repository's `motif`, 0.5.0: 0.4.0 with the Motif-3 harness optimizations |
| `motifcode-0.3.0` | motifcode 0.3.0 as published on npm, the build the 2026-09-20 campaign ran; its feedback round needs a backport (below) |
| `codex` | Codex CLI on `PATH` (0.154) |
| `opencode` | OpenCode on `PATH` (1.18) |

This is **protocol v2**. The 2026-09-20 campaign behind [`../REPORT.md`](../REPORT.md) ran an earlier one (213 exercises,
the tests in the agent's directory with most of them switched off, a 15-minute wall clock, first-test grading in four
languages); its kit is in the git history before this protocol, and its numbers are not this benchmark's.

## The protocol

Aider's polyglot is a benchmark of a model: the model sees the stub and the instructions, has no shell and gets two
tries. Here the tasks, the task text and the grading are Aider's own, and only the protocol is an agent's.

| | |
|---|---|
| Tasks | [Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark) `7e0611e77b54`, **all 225** exercises. The six whose stubs already pass (go/counter, go/ledger, go/markdown, java/ledger, java/tree-building, javascript/ledger) count when a harness does not break them, as Aider counts them |
| Directory | Named after the exercise (C++'s CMakeLists takes its target from it). The stub, helper sources, build files and `.docs/`; never `.meta/`, `.approaches/` or `.articles/`, which hold worked solutions |
| Task text | Aider's: `.docs/introduction.md` + `instructions.md` + `instructions.append.md`, then its addendum naming the solution files, then one line for the track |
| Track **H** (primary) | The graded tests are not in the directory — not in any commit the agent can reach. C++ keeps the vendored Catch2, so an agent can write `<exercise>_test.cpp` of its own and use the official build. Line: "The unit tests used for grading are not in this directory. You may write and run your own tests; test files you add are removed before grading." |
| Track **H2** | A row that fails track H is resumed once, in the same session and directory, with the official test output and Aider's `test_failures` text: pass@2, in the shape of Aider's `pass_rate_2`. The tests are still not in the directory |
| Track **V** (optional) | The tests are in the directory with every skip switched off — a ceiling, not the primary number |
| Grading | The tree graded is built, not patched: the exercise as shipped, the agent's solution files and any new source file it wrote. Tests, build files, vendored and helper files are the originals; build output and the agent's own tests are left out. Each track's official command from a directory named after the exercise, 180 s, exit 0 = pass: `pytest`; `go test ./...`; `cargo test -- --include-ignored`; `npm run test` (= `jest ./*`) after npm-test.sh's `xtest` switch; cpp-test.sh's CMake build (`-Wall -Wextra -Wpedantic -Werror`, `EXERCISM_RUN_ALL_TESTS`); `./gradlew test` after Aider's `@Disabled(...)` rule |
| Rules | **official** (primary): Aider's, holes included — `xit(` and a bare `@Disabled` stay off, and Java's rule reads only the test files the config lists. **strict** (beside it): everything switched on. They differ on javascript/grep, java/forth and java/satellite |
| Budget | No wall clock per task, as in Aider's benchmark: on a slow shared endpoint a wall clock scores serving speed as the harness. A 6-hour safety cap stands in for a wedged process (status `safety_cap`, re-run once); an 8 GB memory cap per row; 180 s per test run; motifcode's turn limit 100, both builds (Codex and OpenCode have none) |
| API parameters | The same for every harness: 16,384 output tokens per step — the endpoint ends reasoning at three quarters of a request's cap and never without one — and the model's published sampling, temperature 1.0 and top_p 0.95. motifcode sends them itself, OpenCode from a per-row config (its model's output limit, each of its agents' sampling), Codex — which has a setting for none of them — through `adapters/param_proxy.mjs`, which adds what a request lacks (`CODEX_STOCK=1` runs Codex without it) |
| Network | The endpoint only, where it can be enforced. On a host where it cannot, rule `network-v1` reads every command and tool call back from each agent's log and session record (Codex's rollout, which has the keystrokes its log leaves out): a download, a package install, a git remote operation, a web tool or a source-host URL in a command makes the row invalid (scored zero, kept in the denominator). The rule is fixed and versioned in `packages/eval/src/network.ts`. The web tools the harnesses ship with are switched off: Codex's hosted web search, OpenCode's webfetch and websearch |
| Replicates | Two independent runs (`REPLICATE=1`, `REPLICATE=2`); the endpoint does not honour seeds |
| Evidence | The runner keeps each row's patch, both grades, the feedback message, the second patch, the journals and the harness's own log and session record under `artifacts/`, whatever an adapter does |

What protocol v2 recommends and this host does not do: running the agents and the grader inside Aider's Docker image
(this Mac has no container runtime — grading uses the host's toolchains: Apple clang where the image has GCC 11, Go 1.26,
Node 24, Python 3.14, JDK 21), and enforcing the network rather than inspecting it. Track A — Aider's own harness on
Motif-3, the only thing comparable with Aider's leaderboard — is not in the kit.

## Prerequisites

`node` ≥ 20 with this repository built (`pnpm install && pnpm build`), `git`, `python3` with `pytest`, `go`,
`rustc`/`cargo` (the six Rust references that use crates download them during `verify.sh`), a JDK the Java exercises'
Gradle 8.7 accepts (JDK 21; set `JAVA21_HOME` if it is not the Homebrew path), `cmake` and a C++ compiler, and Boost
headers for two C++ exercises (`CXX_EXTRA_INCLUDE`). For the other harnesses: `codex` and `opencode` on `PATH`, and
`npm` and `pnpm` for `install_harnesses.sh`, which installs motifcode 0.3.0 and builds its feedback-round backport.

A release before this repository's build cannot continue a finished session without a terminal, and the feedback round
needs exactly that. So `motifcode-0.3.0` runs the npm package for the task round, and for the feedback round its tag
built from source with `harnesses/motifcode-0.3.0/continue-from.patch` — a backport of `--continue-from`, nothing else.
`install_harnesses.sh` installs nothing unless the package was published from the tag, the tag's own build is
byte-identical to the npm bundle, and the patched build carries the release's system prompt and tool schemas (the
journal the release writes is the one the backport continues); `harnesses/motifcode-0.3.0/identity.json` records it.

## Run

```bash
cd packages/eval/polyglot-bench
git clone https://github.com/Aider-AI/polyglot-benchmark && git -C polyglot-benchmark checkout 7e0611e77b54
(cd js-deps && npm install)          # shared jest/babel for the JavaScript track
export MOTIF_API_KEY=...             # or `motif login`
source env.sh
./verify.sh                          # build track H; every stub fails but six, every reference passes under both rule sets
./install_harnesses.sh               # motifcode 0.3.0 and its feedback-round build; checks codex and opencode are on PATH
python3 make_manifests.py            # manifests/<harness>.json for each of HARNESSES (TRACK=V for the visible-test track)
python3 make_chunks.py 12            # stratified 12-row pieces into chunks/pool/<harness>/
for h in $HARNESSES; do ./run_pool.sh $h p1 & done
./status.sh                          # pass@1 official/strict, pass@2, statuses, invalid rows, rows to re-run
python3 make_chunks.py 12 && REPLICATE=2 ./run_pool.sh motifcode p1 & ...   # the second replicate
python3 report_v2.py                 # REPORT-v2.md
```

Concurrency per harness is read from `chunks/conc-<harness>.txt` at each piece start (default 3); keep them all
together under about 18 streams, past which the endpoint's decode rate falls. A second scheduler for the same harness
(`./run_pool.sh codex p2`) claims the next piece. Never edit a script here while rows are running: bash reads a script
as it goes, and a row whose adapter changed under it dies without its evidence.

Rows that fail for a reason fixed in advance — the safety cap, a DNS or network outage, a machine restart, an external
kill — go into `results/rerun.txt` by hand (`<harness> <instance> <reason>`), and `REPLICATE=N ./run_rerun.sh` re-runs
them into `results/r<N>/<harness>/rerun.jsonl`, which the report substitutes for the originals.

`motif-suite inspect <log>...` applies the network rule to any agent log or journal.

## What the adapters do

`adapters/common.sh` parses the runner's argv (`<task> [--continue-from <journal>] --cwd --journal --endpoint --model
--max-turns --max-output-tokens --seed …`), gives the agent a home directory of its own (the tool caches stay shared),
runs it in its own process group under an 8 GB resident-memory cap, writes a journal the runner reads (`session_end`
with `done`, `memory_limit`, `repetition_abort`, `transport_error` or `agent_error`) with the harness's own log beside
it for the network rule, and keeps its evidence under `logs/<harness>/…`. `--continue-from` marks the feedback round,
which keeps its own `-h2` files. A feedback message that starts with a dash (`go test` opens a failure with
"--- FAIL") goes with a leading newline, since all three CLIs would read it as an option.

- `motifcode.sh` runs `motif "<task>"` as shipped; the feedback round is `motif --continue-from <journal> "<output>"`.
- `motifcode-0.3.0.sh` is `motifcode.sh` with the npm 0.3.0 bundle for the task round and the backport build for the
  feedback round.
- `codex.sh` copies `homes/codex/config.pristine.toml` into a per-row `CODEX_HOME` (responses API, sandbox bypassed,
  web search disabled, `stream_idle_timeout_ms` 30 min because the responses route sends nothing while the model
  reasons), starts the parameter proxy, runs `codex exec --json` and keeps Codex's rollout beside the journal; the
  feedback round is `codex exec resume <thread>`, which appends to the same rollout.
- `opencode.sh` writes a per-row config from `homes/opencode/config/opencode/opencode.json` (openai-compatible
  provider, webfetch/websearch denied, output limit = the manifest's cap, the protocol's sampling on each agent) with
  per-row XDG directories and runs `opencode run --pure --format json`; the feedback round is
  `opencode run --session <id>`.

## Files

| | |
|---|---|
| `env.sh` | paths, toolchain pins, fixed git dates so the suite's base commits are deterministic, the harness list |
| `install_harnesses.sh`, `harnesses/` | motifcode releases: the npm package, the feedback-round backport patch and build, what was verified |
| `verify.sh` | `motif-suite build` + `verify` per language into `verify/*.json`; `instances.json` for the manifests |
| `make_manifests.py`, `make_chunks.py` | the pinned plan (protocol, budgets, caps, replicates) and stratified pieces |
| `run_chunk.sh`, `run_pool.sh`, `run_rerun.sh` | drive `motif-suite run` over one piece, over a pool, over the re-run list |
| `adapters/`, `homes/` | the harnesses behind one runner contract; the parameter proxy; pristine Codex and OpenCode configs |
| `status.sh`, `cleanup_orphans.sh` | progress and hygiene during a campaign |
| `report_v2.py`, `harness-cards.json` | the protocol v2 report: pass@1/pass@2 under both rule sets, paired statistics, replicate agreement, failure types, cost and budget curves, Harness Cards |
| `compare.py`, `make_report.py` | the 2026-09-20 campaign's report, kept for that record |

Outputs (`suite-*/`, `results/`, `artifacts/`, `logs/`, `chunks/pool*/`, `verify/`, `manifests/`, `instances.json`,
`corpus-spec*.json`, `REPORT*.md`, the installed builds under `harnesses/`) are ignored by git here.
