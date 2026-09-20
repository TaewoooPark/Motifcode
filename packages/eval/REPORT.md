# Motif-3 on Three Coding Harnesses: A Paired Aider-Polyglot Benchmark

**Date:** 2026-09-21 (KST) · **Model:** `motif/motif-3` (Motif Technologies, 314B-A13B MoE) via Infron · **Suite:** Aider polyglot-benchmark, 213 instances · **Harnesses:** motifcode 0.3.0, codex-cli 0.154.0, opencode 1.17.9

Every number in this report is computed by `make_report.py` from the campaign directory: the runner's rows (`results/*.jsonl`), the per-row logs (`logs/`), the manifests and `results/campaign.log`. Those raw artifacts are not in this repository; the kit that produces them is `packages/eval/polyglot-bench/` (Section 10, *How to reproduce*).

## 1. Executive summary

Three coding-agent harnesses were driven by the same model, the same API key, the same 213 Exercism exercises and the same budgets, and graded by the same test command in a pristine checkout. Pass rates over the 213 paired instances:

| harness | passed | pass rate | 95% CI |
|---|---|---|---|
| **motifcode** | 196/213 | **92.0%** | [87.6, 95.0] |
| **codex** | 170/213 | **79.8%** | [73.9, 84.7] |
| **opencode** | 177/213 | **83.1%** | [77.5, 87.5] |

Findings:

- **motifcode, the harness written for this model, solved the most instances.** Against Codex the paired difference is +12.2 pp (95% CI [+7.0, +17.4], McNemar p < 0.0001, significant at the 5% level); against OpenCode it is +8.9 pp (95% CI [+3.8, +14.6], p = 0.0026, significant at the 5% level).
- **OpenCode led Codex** by +3.3 pp (95% CI [-3.3, +9.9], p = 0.4101, not significant at the 5% level).
- The gap is mostly about **how each harness copes with this model's failure modes**, not about what the model can write: 182 motifcode rows ended normally versus 173 for Codex and 174 for OpenCode; the rest ended on the 15-minute cap, a turn cap, a router-side repetition abort, or a protocol error (Section 6.4).
- All three harnesses ran at temperature 1.0 with one seed, so per-instance outcomes are noisy; the paired design removes instance difficulty but not sampling variance (Section 8).

## 2. Benchmark

- **Source:** [Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark) at `7e0611e77b54` — 225 Exercism practice exercises across C++, Go, Java, JavaScript, Python and Rust.
- **Instance construction:** each exercise becomes a single-commit git repository containing the stub, the tests, `INSTRUCTIONS.md` and the toolchain files. The `.meta/` directory (reference solution) is never copied. Base commits are deterministic across rebuilds (fixed author/committer dates), and were verified identical across all 13 suite directories used (2,925 repositories checked, 0 mismatches).
- **Task text:** the exercise's `instructions.md` (plus `instructions.append.md` when present), followed by the files to implement and the test files to run, and a note that tests are restored before grading. Identical for all harnesses.
- **Grading:** the agent's work leaves its checkout as a `git diff` (staged, so new files count). The patch is applied to a fresh worktree of the same base commit, every test path is restored from the base commit, and the track's own test command runs (`pytest`, `jest`, `go test ./...`, `cargo test`, `./gradlew test`, `g++ … && ./runner`). Exit 0 is a pass. A row times out, crashes or is missing → scored as a fail, never dropped.
- **Exclusions (decided before the run, from `motif-suite verify` on this machine):** 12 of 225. Six exercises pass with the stub untouched and cannot discriminate (`go/counter`, `go/ledger`, `go/markdown`, `java/ledger`, `java/tree-building`, `javascript/ledger`); six Rust exercises ship a reference solution that does not build (`rust/alphametics`, `rust/decimal`, `rust/grep`, `rust/pig-latin`, `rust/poker`, `rust/robot-name`). 213 instances remain; all 213 have a graded row for every harness.

## 3. Systems under test

**Model and endpoint.** `motif/motif-3` served by Infron at `https://llm.onerouter.pro/v1` (free tier, one API key). The router exposes `/v1/chat/completions` (used by motifcode and OpenCode) and `/v1/responses` (used by Codex); it returns structured `tool_calls`, a separate `reasoning` field, and prompt-cache statistics. Over the campaign it never returned a 429.

| harness | version | invocation | protocol | deviations from stock |
|---|---|---|---|---|
| motifcode | 0.3.0 (`a87dec0c1bf1`) | `motif "<task>" --cwd … --channel toolcall --max-turns 40 --max-output-tokens 16384 --seed 0` | chat completions, native tool calls, 9 fixed tools | none; benchmark mode as shipped (`done` contract with confirmation, no-action re-prompt, loop guard) |
| Codex CLI | codex-cli 0.154.0 | `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C … -m motif/motif-3 --json` | responses API via a custom provider (`wire_api = "responses"`) | `stream_idle_timeout_ms` raised from 300 s to 30 min (stock Codex dropped the stream on this endpoint's 200–300 s reasoning steps; see Section 9); per-row `CODEX_HOME` |
| OpenCode | opencode 1.17.9 | `opencode run --pure --dir … -m infron/motif/motif-3 --format json --dangerously-skip-permissions` | chat completions via `@ai-sdk/openai-compatible` | `webfetch`/`websearch` denied; per-row XDG data/state directories |

Sampling: motifcode sends temperature 1.0 / top_p 0.95 explicitly (the model's published evaluation settings). Codex and OpenCode send their defaults; the server default is the same pair. Whether the two clients send reasoning back into history was not instrumented.

## 4. Protocol

- **Isolation per row:** a fresh `git worktree` of the pinned base commit; a fresh agent process in its own process group; per-row config/state directories for Codex and OpenCode; grading in a separate pristine worktree the agent never sees. No container: the host toolchains are shared, and the network is reachable from the shell for all three.
- **Budgets (identical):** 15-minute wall cap per row (an in-adapter deadline at 870 s, the runner's 900 s SIGKILL as backstop), 8 GB resident-memory cap per row, seed 0, one attempt per instance. motifcode additionally has its own 40-turn cap and 16,384 output tokens per step (`--max-turns`, `--max-output-tokens`); Codex and OpenCode expose no equivalent switches.
- **Pairing:** every instance was run once by each harness; comparisons are paired by instance (McNemar exact test on discordant pairs; 95% bootstrap CI on the mean paired difference, 20,000 resamples, fixed seed).
- **Re-runs:** a row was re-run only for a documented infrastructure failure or when it had run under a since-fixed adapter setting; the list with reasons is `results/rerun.txt` (Section 9). Re-run rows replace the originals; originals are kept.
- **Scheduling:** three campaigns in parallel, 2 rows per harness for the first 3 hours, then 3–5 per harness (up to 26 concurrent streams for about 20 minutes near the end). Endpoint decode speed fell from ~62 to 46–55 tok/s in the heaviest stretch; the time-based cap therefore bit harder there (Section 8).

## 5. Completeness and integrity checks

- **motifcode:** 213/213 instances graded, 0 missing, 0 duplicates, 0 re-run substitution(s); no row in an infrastructure status (`agent_crash`, `grader_infra_error`, `model_transport_failure`, `missing`).
- **codex:** 213/213 instances graded, 0 missing, 0 duplicates, 4 re-run substitution(s); no row in an infrastructure status (`agent_crash`, `grader_infra_error`, `model_transport_failure`, `missing`).
- **opencode:** 213/213 instances graded, 0 missing, 0 duplicates, 8 re-run substitution(s); no row in an infrastructure status (`agent_crash`, `grader_infra_error`, `model_transport_failure`, `missing`).
- Manifests: identical suite hash, dataset revision, budgets, seeds, per-step output cap and pair group across the three harnesses (`checkPairable` criteria).
- Suite base commits: identical across all suite directories (2,925 repositories checked).

## 6. Results

### 6.1 Pass rates

| harness | passed | failed | pass rate | 95% CI (Wilson) |
|---|---|---|---|---|
| motifcode | 196 | 17 | **92.0%** | [87.6, 95.0] |
| codex | 170 | 43 | **79.8%** | [73.9, 84.7] |
| opencode | 177 | 36 | **83.1%** | [77.5, 87.5] |

### 6.2 Paired comparisons

| A vs B | A only | B only | both pass | both fail | Δ (A − B) | 95% CI | McNemar p |
|---|---|---|---|---|---|---|---|
| motifcode vs codex | 31 | 5 | 165 | 12 | **+12.2 pp** | [+7.0, +17.4] | p < 0.0001 |
| motifcode vs opencode | 28 | 9 | 168 | 8 | **+8.9 pp** | [+3.8, +14.6] | p = 0.0026 |
| opencode vs codex | 30 | 23 | 147 | 13 | **+3.3 pp** | [-3.3, +9.9] | p = 0.4101 |

### 6.3 By language

| language | n | motifcode | codex | opencode |
|---|---|---|---|---|
| cpp | 26 | 24/26 (92%) | 24/26 (92%) | 22/26 (85%) |
| go | 36 | 33/36 (92%) | 27/36 (75%) | 24/36 (67%) |
| java | 45 | 39/45 (87%) | 29/45 (64%) | 40/45 (89%) |
| javascript | 48 | 48/48 (100%) | 46/48 (96%) | 45/48 (94%) |
| python | 34 | 32/34 (94%) | 25/34 (74%) | 27/34 (79%) |
| rust | 24 | 20/24 (83%) | 19/24 (79%) | 19/24 (79%) |

### 6.4 How rows ended

The end reason is what the harness reported (motifcode's journal; the adapter's classification of Codex/OpenCode exits). `done` is a normal completion; everything else is a budget or protocol event. A row can still pass after an abnormal ending because grading reads the patch left behind.

| end reason | motifcode | codex | opencode | meaning |
|---|---|---|---|---|
| agent_error | 0 | 2 | 0 | the harness exited non-zero for another reason (Codex: a malformed tool call echoed back was rejected as invalid_request) |
| agent_timeout | 1 | 0 | 0 | the 15-minute cap enforced by the runner (before the adapter deadline existed) |
| done | 182 | 173 | 174 | the harness reported normal completion |
| loop_detected | 3 | 0 | 0 | motifcode's loop guard (identical call/output repeated) |
| repetition_abort | 0 | 0 | 21 | the router stopped generation ("Repetition was detected") and the harness gave up |
| turn_limit | 6 | 0 | 0 | motifcode's 40-turn cap |
| wall_timeout | 21 | 38 | 18 | the 15-minute cap (adapter deadline at 870 s) |

Passed despite an abnormal ending: motifcode 14, codex 8, opencode 9.

### 6.5 Cost per row (median over paired rows)

| harness | wall s | requests / steps | prompt tokens | completion tokens | totals (prompt / completion) |
|---|---|---|---|---|---|
| motifcode | 264 | 16 requests | 239,098 | 12,722 | 66,149,162 / 3,557,122 |
| codex | 237 | 10 shell commands | 190,087 | 8,693 | 44,863,708 / 2,341,137 |
| opencode | 221 | 14 steps | 382,278 | 9,594 | 155,382,597 / 2,953,757 |

Prompt tokens are the sum over a row's requests (motifcode: server `prompt_tokens`, ~90% served from the prefix cache; OpenCode: `input + cache.read`; Codex: `input_tokens` from `turn.completed`). Codex's `--json` stream carries no request count. Wall time depends on endpoint load and is a secondary metric.

## 7. Analysis

**Where the three differ.** The instances that separate the harnesses are not the ones the model cannot solve; they are the ones where a harness lost the model's work:

- **Codex** lost 38 rows to the 15-minute cap and 2 to a protocol error. In the protocol case the model emitted a tool call Codex could not route (`final_answer`, or `apply_patch` in the wrong shape); Codex echoed the malformed call back into history and the router rejected the next request with `invalid_request` ("Unterminated string"). Codex also sets no default command timeout: one row's infinite-loop test consumed 9 GB before it was stopped.
- **OpenCode** lost 21 rows to the router's repetition guard ("Repetition was detected in the model's output and generation was stopped"): it treats the provider error as fatal and exits, keeping whatever was already written. It was the fastest per row (fewest steps) and never hit the turn or loop guards it does not have.
- **motifcode** ended 182 rows normally. Its losses were the cap (22 rows, several of them still passing on the patch left behind), its own 40-turn cap (6) and loop guard (3; in one row the model deleted its own checkout after a CMake error). It never saw a repetition abort or a protocol abort: its transport retries server errors and its parser recovers tool calls the router leaves in the body.

**What the model-specific harness bought.** The measurable advantages on this endpoint were (1) reasoning continuity and a ~2k-token prompt with a frozen tool order, keeping 90%+ of every request in the prefix cache; (2) recovery of tool calls the server did not extract; (3) the `done` contract and no-action re-prompt in benchmark mode, so a turn that stops without acting is handed back instead of ending the task. The thin fixed tool set (bash/read/write/apply_patch/term) did not hurt relative to the richer tool sets of Codex and OpenCode.

## 8. Threats to validity

- **Sampling noise.** One seed at temperature 1.0. The paired test controls for instance difficulty, not for the draw; a second seed would tighten the intervals. Effects smaller than ~8 pp are not resolved here.
- **Time-based cap under variable load.** Concurrency rose from 6 to 26 streams over the campaign and the endpoint slowed by up to 25%. Rows that ran in the slowest stretch were more likely to hit the cap. All harnesses shared the load, but Codex ran a larger share of its rows in the final, heaviest hour.
- **Adapter deviations.** Codex's stream idle timeout was raised (Section 9); OpenCode had web tools denied. Both are documented; the first is the same accommodation motifcode makes for itself (it disables Node's 300 s header timeout).
- **Benchmark scope.** Exercism exercises measure spec-to-code with a test loop in a two-file repository. Nothing here speaks to navigating an unfamiliar codebase.
- **No container isolation.** Host toolchains and the network were shared. Solutions to these exercises exist online; all three harnesses could reach them through the shell, none was observed doing so.
- **Unknown client-side sampling and history handling** for Codex and OpenCode (whether they send temperature, and whether they return reasoning to history) was not instrumented.

## 9. Incidents, fixes and re-runs

Recorded in `results/campaign.log` as they happened:

- opencode rows ['go/book-store', 'cpp/binary-search-tree'] reclassified to completed/repetition_abort: the adapter had matched a token count of 429 as a rate limit; grades untouched
- codex: per-row CODEX_HOME from config.pristine.toml and stream_idle_timeout_ms=1800000 from now on; go/bowling and go/connect (agent_timeout under the stock 300 s idle timeout) listed in results/rerun.txt
- adapters: in-adapter deadline 870 s (reason wall_timeout) so timed-out rows keep journal/patch/log; motifcode journal now symlinked into logs/; the runner's 900 s cap stays as the backstop
- opencode: the per-row XDG_DATA_HOME/XDG_STATE_HOME patch had silently not applied (chunk 1 ran on the shared db); applied for real now; cpp/complex-numbers (chunk 2, database is locked) listed in results/rerun.txt
- [2026-09-20T15:28:44Z] codex python/forth: four runaway python test processes (model solution loops forever; codex sets no command timeout) reached 9 GB and were killed externally; row continues
- [2026-09-20T15:28:44Z] adapters: agent runs in its own process group; the group is killed at the 870 s deadline, after exit (leftovers), and when the row's resident memory exceeds 8 GB (reason memory_limit)
- [2026-09-20T15:30:40Z] GRADLE_OPTS=-Dorg.gradle.daemon=false for rows started from now; kill_group and the orphan sweep spare java processes
- [2026-09-20T15:36:15Z] per-harness concurrency from the next chunk: codex 5, motifcode 4, opencode 3 (codex has the longest mean wall time and the most rows left)
- [2026-09-20T16:01:28Z] remaining pool re-chunked into ~12-row pieces (chunks/pool2); p1 schedulers exit after their current chunk; p2 schedulers started with overlap concurrency codex 3 / motifcode 2 / opencode 1, to be raised to 5/4/3 when p1 exits
- [2026-09-20T16:10:18Z] codex p1 exited; conc-codex raised to 5 for the next piece
- [2026-09-20T16:54:54Z] conc-motifcode and conc-opencode raised to 4 for their next pieces (p1 schedulers are in the tail of their last chunk)
- [2026-09-20T17:04:52Z] opencode: second p2-style scheduler (p3) started so the remaining pieces run at 4 while p2 finishes its concurrency-1 piece
- [2026-09-20T17:18:29Z] motifcode: p1 exited; extra scheduler p3 started so remaining pieces run at 4 while p2 finishes its concurrency-2 piece
- [2026-09-20T17:25:04Z] codex: extra scheduler p3 started (two schedulers x 5) because codex is the long pole with 66 rows left; endpoint decode is 63 tok/s at 12 streams
- [2026-09-20T18:09:27Z] seven opencode rows in flight were SIGKILLed simultaneously at 18:06:29Z (exit 137, mid-step); no deadline/memory/orphan-sweep action matches; listed in results/rerun.txt as infra failures

Re-run rows (original → re-run):

- codex `java/affine-cipher`: agent_timeout/failed → done/passed
- codex `java/alphametics`: agent_timeout/failed → done/passed
- codex `go/bowling`: agent_timeout/failed → done/passed
- codex `go/connect`: agent_timeout/failed → wall_timeout/failed
- opencode `java/word-search`: agent_error/failed → done/passed
- opencode `java/zipper`: agent_error/failed → repetition_abort/failed
- opencode `cpp/complex-numbers`: agent_error/failed → done/passed
- opencode `javascript/state-of-tic-tac-toe`: agent_error/failed → done/passed
- opencode `javascript/two-bucket`: agent_error/passed → done/passed
- opencode `javascript/variable-length-quantity`: agent_error/passed → done/passed
- opencode `javascript/transpose`: agent_error/failed → repetition_abort/passed
- opencode `javascript/wordy`: agent_error/failed → done/passed

Reasons per row are in `results/rerun.txt`.

## 10. Reproducibility

| item | value |
|---|---|
| motifcode harness commit | `a87dec0c1bf158c13a4c720c7c90b16ade4a06d2` |
| suite revision | `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f` |
| instances sha256 | `22f5c0e9d2e50a6dc8d4b837b847db6a941025cf599a58b1083a4a410c0606d9` |
| motifcode system-prompt / tool-schema sha256 | `413c4f807b561c72…` / `6f0062d5dad6a90c…` |
| Codex adapter / config sha256 | `fe8aba6fe8a0b55c…` / `97594771159eeb08…` |
| OpenCode adapter / config sha256 | `01d576c2562420fc…` / `aff54d586e7f6887…` |
| machine | macOS 26.6.2, Apple M4, 32 GB |
| toolchains | Node v24.13.0, JDK 21 (21.0.11) with Gradle 8.7 (daemon off), Rust 1.95.0, Go go1.26.5, Python 3.14.2 + pytest 9.0.2, Apple clang 17.0.0, boost from Homebrew |

Layout of the campaign directory: `env.sh` (toolchain pins, fixed git dates), `adapters/` (the three agent adapters + `common.sh`), `homes/` (pristine Codex/OpenCode configs), `manifests/`, `chunks/` (the stratified plan and `excluded.json`), `results/<harness>/*.jsonl` (rows), `logs/<harness>/…` (journal, agent log, patch, meta per row), `compare.py`, `make_report.py`.

### How to reproduce

The adapters, configs and scripts are published as a kit at `packages/eval/polyglot-bench/` in the motifcode repository (`a87dec0c1bf1` or later); an Infron API key (`MOTIF_API_KEY`) is the only credential. The dataset is [Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark) at commit `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`.

```bash
git clone https://github.com/TaewoooPark/Motifcode && cd Motifcode && pnpm install && pnpm build
cd packages/eval/polyglot-bench
git clone https://github.com/Aider-AI/polyglot-benchmark && git -C polyglot-benchmark checkout 7e0611e77b54
(cd js-deps && npm install)                 # shared jest/babel for the JavaScript track
export MOTIF_API_KEY=...                    # Infron key; Codex and OpenCode read it through the adapters
source env.sh                               # toolchains: node, go, rustc, JDK 21 (Gradle 8.7), python3+pytest, clang, boost
./verify.sh                                 # builds the suite, checks every exercise runs and its reference passes -> verify/*.json
python3 make_manifests.py                   # manifests/{motifcode,codex,opencode}.json: 40 turns, 16K tokens/step, 900 s cap, seed 0
python3 make_chunks.py 12                   # stratified 12-row pieces into chunks/pool/<harness>/, exclusions from verify/
./run_pool.sh motifcode p1 & ./run_pool.sh codex p1 & ./run_pool.sh opencode p1 &   # concurrency from chunks/conc-<harness>.txt
python3 compare.py && python3 make_report.py   # paired statistics; REPORT.md
```

Codex needs `codex` on PATH with no login (the kit's `CODEX_HOME` config uses the key through `env_key`); OpenCode needs `opencode` on PATH. Rows that fail for infrastructure reasons are listed by hand in `results/rerun.txt` and re-run with `run_rerun.sh`; `compare.py` and `make_report.py` substitute them.

## Appendix A. Per-instance results

✓ = passed, ✗ = failed; the end reason follows when it was not `done`.

| instance | motifcode | codex | opencode |
|---|---|---|---|
| cpp/all-your-base | ✓ | ✓ | ✓ |
| cpp/allergies | ✗ (loop_detected) | ✓ | ✓ |
| cpp/bank-account | ✓ | ✓ | ✓ |
| cpp/binary-search-tree | ✓ | ✓ | ✓ (repetition_abort) |
| cpp/circular-buffer | ✓ | ✓ | ✗ |
| cpp/clock | ✓ | ✓ | ✓ |
| cpp/complex-numbers | ✓ | ✓ | ✓ |
| cpp/crypto-square | ✓ | ✓ | ✓ |
| cpp/diamond | ✓ | ✓ | ✗ |
| cpp/dnd-character | ✓ | ✓ | ✓ |
| cpp/gigasecond | ✓ | ✓ | ✓ |
| cpp/grade-school | ✓ | ✓ | ✓ |
| cpp/kindergarten-garden | ✓ | ✓ | ✓ |
| cpp/knapsack | ✓ | ✓ | ✓ |
| cpp/linked-list | ✓ | ✓ | ✓ |
| cpp/meetup | ✓ (turn_limit) | ✓ | ✓ |
| cpp/parallel-letter-frequency | ✓ (turn_limit) | ✓ | ✓ |
| cpp/perfect-numbers | ✓ | ✓ | ✓ |
| cpp/phone-number | ✓ | ✗ | ✓ |
| cpp/queen-attack | ✓ | ✓ | ✓ |
| cpp/robot-name | ✓ | ✓ | ✓ |
| cpp/space-age | ✓ | ✓ | ✗ (repetition_abort) |
| cpp/spiral-matrix | ✓ | ✓ | ✓ |
| cpp/sublist | ✓ | ✓ | ✓ |
| cpp/yacht | ✓ | ✓ | ✓ |
| cpp/zebra-puzzle | ✗ (wall_timeout) | ✗ (wall_timeout) | ✗ (wall_timeout) |
| go/alphametics | ✓ | ✓ | ✓ |
| go/beer-song | ✓ | ✓ | ✓ |
| go/book-store | ✓ | ✓ | ✗ (repetition_abort) |
| go/bottle-song | ✓ | ✓ | ✓ |
| go/bowling | ✓ | ✓ | ✓ |
| go/connect | ✓ | ✗ (wall_timeout) | ✓ |
| go/crypto-square | ✓ | ✓ | ✓ |
| go/dnd-character | ✓ | ✓ | ✓ |
| go/dominoes | ✓ | ✗ (wall_timeout) | ✓ |
| go/error-handling | ✓ | ✓ | ✓ |
| go/food-chain | ✓ | ✓ | ✗ (repetition_abort) |
| go/forth | ✓ | ✓ | ✗ |
| go/hexadecimal | ✓ | ✓ | ✓ |
| go/kindergarten-garden | ✓ | ✓ | ✓ |
| go/matrix | ✓ | ✗ | ✗ |
| go/octal | ✓ | ✓ | ✓ |
| go/paasio | ✓ | ✓ | ✓ |
| go/palindrome-products | ✓ | ✓ | ✓ |
| go/pig-latin | ✓ | ✗ (wall_timeout) | ✓ |
| go/poker | ✗ (turn_limit) | ✗ (wall_timeout) | ✓ |
| go/pov | ✗ (wall_timeout) | ✓ | ✗ (repetition_abort) |
| go/protein-translation | ✓ | ✓ | ✓ |
| go/react | ✓ | ✗ (wall_timeout) | ✗ (wall_timeout) |
| go/robot-simulator | ✗ (wall_timeout) | ✗ (wall_timeout) | ✗ (repetition_abort) |
| go/say | ✓ | ✓ | ✓ |
| go/scale-generator | ✓ | ✗ (wall_timeout) | ✗ (wall_timeout) |
| go/simple-linked-list | ✓ | ✓ | ✓ |
| go/sublist | ✓ | ✓ | ✓ |
| go/transpose | ✓ | ✗ | ✗ (repetition_abort) |
| go/tree-building | ✓ | ✓ | ✓ |
| go/trinary | ✓ | ✓ | ✗ (wall_timeout) |
| go/two-bucket | ✓ | ✓ | ✗ (wall_timeout) |
| go/variable-length-quantity | ✓ | ✓ (wall_timeout) | ✓ |
| go/word-search | ✓ | ✓ | ✓ |
| go/wordy | ✓ | ✓ | ✓ |
| go/zebra-puzzle | ✓ | ✓ | ✗ (wall_timeout) |
| java/affine-cipher | ✓ | ✓ | ✓ |
| java/all-your-base | ✓ | ✓ | ✓ |
| java/alphametics | ✗ (agent_timeout) | ✓ | ✓ |
| java/bank-account | ✓ (turn_limit) | ✗ | ✓ |
| java/book-store | ✓ (turn_limit) | ✗ (wall_timeout) | ✓ |
| java/bottle-song | ✓ | ✓ | ✓ |
| java/bowling | ✓ | ✗ | ✓ |
| java/change | ✓ | ✗ (agent_error) | ✓ |
| java/circular-buffer | ✓ | ✓ | ✓ (repetition_abort) |
| java/connect | ✓ | ✗ (wall_timeout) | ✓ |
| java/custom-set | ✓ | ✓ | ✓ |
| java/dominoes | ✓ (loop_detected) | ✗ | ✓ |
| java/food-chain | ✓ | ✓ | ✓ |
| java/forth | ✓ | ✗ (wall_timeout) | ✓ |
| java/go-counting | ✗ (wall_timeout) | ✓ | ✗ (wall_timeout) |
| java/hangman | ✗ (wall_timeout) | ✗ (wall_timeout) | ✓ |
| java/house | ✓ | ✓ | ✗ (repetition_abort) |
| java/kindergarten-garden | ✓ | ✓ | ✓ |
| java/mazy-mice | ✓ (wall_timeout) | ✗ (wall_timeout) | ✓ (wall_timeout) |
| java/ocr-numbers | ✓ | ✗ | ✗ (repetition_abort) |
| java/palindrome-products | ✓ | ✓ | ✓ |
| java/phone-number | ✓ | ✓ | ✓ |
| java/pig-latin | ✓ | ✓ (wall_timeout) | ✓ |
| java/poker | ✓ | ✗ (wall_timeout) | ✓ |
| java/pov | ✓ | ✓ (wall_timeout) | ✓ |
| java/protein-translation | ✓ | ✓ | ✓ (wall_timeout) |
| java/pythagorean-triplet | ✓ | ✓ | ✓ |
| java/queen-attack | ✓ | ✓ | ✓ |
| java/rational-numbers | ✓ | ✓ | ✓ |
| java/react | ✓ (wall_timeout) | ✗ (wall_timeout) | ✓ |
| java/resistor-color-trio | ✓ | ✓ | ✓ |
| java/rest-api | ✗ (wall_timeout) | ✗ (wall_timeout) | ✓ (wall_timeout) |
| java/satellite | ✓ (loop_detected) | ✓ | ✓ |
| java/series | ✓ | ✓ | ✓ |
| java/sgf-parsing | ✗ (wall_timeout) | ✗ (wall_timeout) | ✓ |
| java/simple-linked-list | ✓ | ✓ | ✓ |
| java/state-of-tic-tac-toe | ✓ | ✓ (wall_timeout) | ✓ |
| java/transpose | ✓ (wall_timeout) | ✗ (wall_timeout) | ✓ |
| java/twelve-days | ✓ | ✓ | ✓ |
| java/two-bucket | ✓ | ✓ | ✗ (repetition_abort) |
| java/variable-length-quantity | ✓ (wall_timeout) | ✓ (wall_timeout) | ✓ |
| java/word-search | ✓ | ✓ | ✓ |
| java/wordy | ✓ | ✓ | ✓ |
| java/zebra-puzzle | ✗ (wall_timeout) | ✓ | ✓ |
| java/zipper | ✓ (wall_timeout) | ✗ (wall_timeout) | ✗ (repetition_abort) |
| javascript/affine-cipher | ✓ | ✓ | ✓ |
| javascript/alphametics | ✓ | ✓ | ✓ |
| javascript/beer-song | ✓ | ✓ | ✓ |
| javascript/binary | ✓ | ✓ | ✓ |
| javascript/book-store | ✓ | ✓ | ✓ |
| javascript/bottle-song | ✓ | ✓ | ✓ |
| javascript/bowling | ✓ | ✓ | ✓ |
| javascript/complex-numbers | ✓ (turn_limit) | ✓ | ✓ |
| javascript/connect | ✓ | ✗ (wall_timeout) | ✓ (repetition_abort) |
| javascript/food-chain | ✓ | ✓ | ✓ |
| javascript/forth | ✓ | ✓ | ✓ |
| javascript/go-counting | ✓ | ✓ | ✓ |
| javascript/grade-school | ✓ | ✓ | ✓ |
| javascript/grep | ✓ | ✓ | ✓ |
| javascript/house | ✓ | ✓ | ✓ |
| javascript/killer-sudoku-helper | ✓ | ✓ | ✓ |
| javascript/list-ops | ✓ | ✓ | ✓ |
| javascript/meetup | ✓ | ✓ | ✓ |
| javascript/ocr-numbers | ✓ | ✓ | ✓ |
| javascript/palindrome-products | ✓ | ✓ | ✓ |
| javascript/parallel-letter-frequency | ✓ | ✓ | ✓ |
| javascript/phone-number | ✓ | ✓ | ✓ |
| javascript/pig-latin | ✓ | ✓ | ✓ |
| javascript/poker | ✓ | ✓ | ✓ |
| javascript/promises | ✓ | ✓ | ✓ |
| javascript/queen-attack | ✓ | ✓ | ✓ |
| javascript/rational-numbers | ✓ | ✓ | ✓ |
| javascript/react | ✓ | ✓ (wall_timeout) | ✓ |
| javascript/rectangles | ✓ | ✓ | ✓ |
| javascript/resistor-color-trio | ✓ | ✓ | ✓ |
| javascript/rest-api | ✓ | ✓ | ✓ |
| javascript/robot-name | ✓ | ✓ | ✗ |
| javascript/say | ✓ | ✓ | ✓ |
| javascript/scale-generator | ✓ | ✓ | ✓ |
| javascript/simple-linked-list | ✓ | ✓ | ✓ |
| javascript/space-age | ✓ | ✓ | ✗ (repetition_abort) |
| javascript/state-of-tic-tac-toe | ✓ | ✓ | ✓ |
| javascript/sum-of-multiples | ✓ | ✓ | ✓ |
| javascript/tournament | ✓ | ✓ | ✓ |
| javascript/transpose | ✓ | ✓ | ✓ (repetition_abort) |
| javascript/triangle | ✓ | ✓ | ✓ |
| javascript/twelve-days | ✓ | ✓ | ✗ |
| javascript/two-bucket | ✓ | ✗ (wall_timeout) | ✓ |
| javascript/variable-length-quantity | ✓ | ✓ | ✓ |
| javascript/word-search | ✓ | ✓ | ✓ |
| javascript/wordy | ✓ | ✓ | ✓ |
| javascript/zebra-puzzle | ✓ | ✓ | ✓ |
| javascript/zipper | ✓ | ✓ | ✓ |
| python/affine-cipher | ✓ | ✗ | ✓ |
| python/beer-song | ✓ | ✓ | ✓ |
| python/book-store | ✓ | ✓ | ✓ |
| python/bottle-song | ✓ | ✗ | ✓ |
| python/bowling | ✓ | ✓ (agent_error) | ✗ (wall_timeout) |
| python/connect | ✓ | ✗ (wall_timeout) | ✗ (wall_timeout) |
| python/dominoes | ✓ | ✓ | ✓ |
| python/dot-dsl | ✓ | ✓ | ✓ |
| python/food-chain | ✓ | ✓ | ✓ |
| python/forth | ✓ | ✗ (wall_timeout) | ✓ |
| python/go-counting | ✓ | ✗ (wall_timeout) | ✓ |
| python/grade-school | ✓ | ✓ | ✓ |
| python/grep | ✓ | ✓ | ✓ |
| python/hangman | ✓ | ✓ | ✓ |
| python/list-ops | ✓ | ✓ | ✓ |
| python/paasio | ✗ (wall_timeout) | ✗ (wall_timeout) | ✗ (repetition_abort) |
| python/phone-number | ✓ | ✓ | ✓ |
| python/pig-latin | ✓ | ✓ | ✓ |
| python/poker | ✓ | ✓ | ✓ |
| python/pov | ✓ | ✓ | ✗ (repetition_abort) |
| python/proverb | ✓ | ✓ | ✓ |
| python/react | ✓ | ✗ (wall_timeout) | ✓ |
| python/rest-api | ✓ | ✗ | ✓ |
| python/robot-name | ✓ | ✓ | ✓ |
| python/scale-generator | ✓ | ✓ | ✗ (repetition_abort) |
| python/sgf-parsing | ✗ (wall_timeout) | ✗ (wall_timeout) | ✗ (wall_timeout) |
| python/simple-linked-list | ✓ | ✓ | ✓ |
| python/transpose | ✓ | ✓ | ✗ (wall_timeout) |
| python/tree-building | ✓ | ✓ | ✓ |
| python/two-bucket | ✓ | ✓ | ✓ |
| python/variable-length-quantity | ✓ | ✓ | ✓ |
| python/wordy | ✓ | ✓ | ✓ |
| python/zebra-puzzle | ✓ | ✓ | ✓ |
| python/zipper | ✓ | ✓ | ✓ |
| rust/accumulate | ✓ | ✓ | ✓ |
| rust/acronym | ✓ | ✓ | ✓ |
| rust/book-store | ✓ | ✗ | ✓ |
| rust/bowling | ✓ (wall_timeout) | ✓ | ✓ |
| rust/dot-dsl | ✓ | ✓ | ✓ |
| rust/doubly-linked-list | ✗ (wall_timeout) | ✗ (wall_timeout) | ✓ (wall_timeout) |
| rust/fizzy | ✓ | ✓ | ✓ |
| rust/forth | ✓ (wall_timeout) | ✓ (wall_timeout) | ✗ (wall_timeout) |
| rust/gigasecond | ✓ | ✓ | ✓ |
| rust/grade-school | ✓ | ✓ | ✓ |
| rust/luhn-from | ✓ | ✓ | ✓ |
| rust/macros | ✓ | ✓ | ✗ (repetition_abort) |
| rust/nucleotide-codons | ✓ | ✓ | ✓ |
| rust/ocr-numbers | ✓ | ✓ | ✓ |
| rust/parallel-letter-frequency | ✓ | ✓ | ✓ (repetition_abort) |
| rust/react | ✗ (wall_timeout) | ✗ (wall_timeout) | ✗ (wall_timeout) |
| rust/say | ✓ | ✓ | ✓ |
| rust/scale-generator | ✗ (wall_timeout) | ✗ (wall_timeout) | ✓ |
| rust/simple-cipher | ✓ | ✓ | ✓ |
| rust/two-bucket | ✓ | ✓ | ✓ |
| rust/variable-length-quantity | ✓ | ✓ | ✓ |
| rust/word-count | ✓ | ✓ | ✓ |
| rust/wordy | ✓ | ✓ | ✗ (wall_timeout) |
| rust/xorcism | ✗ (wall_timeout) | ✗ (wall_timeout) | ✗ (repetition_abort) |

## Appendix B. Campaign timeline

```
[2026-09-20T12:00:30Z] motifcode chunk1 start (concurrency 2)
[2026-09-20T12:00:30Z] codex chunk1 start (concurrency 2)
[2026-09-20T12:00:30Z] opencode chunk1 start (concurrency 2)
[2026-09-20T12:02:29Z] opencode chunk1 end exit 143
[2026-09-20T12:02:31Z] opencode chunk1 aborted and restarted after fixing per-row XDG dirs
[2026-09-20T12:02:31Z] opencode chunk1 start (concurrency 2)
[2026-09-20T13:41:19Z] opencode chunk1 end exit 0
[2026-09-20T13:41:19Z] opencode chunk2 start (concurrency 2)
[2026-09-20T13:47:30Z] motifcode chunk1 end exit 0
[2026-09-20T13:47:30Z] motifcode chunk2 start (concurrency 2)
[2026-09-20T13:54:48Z] codex chunk1 end exit 0
[2026-09-20T13:54:49Z] codex chunk2 start (concurrency 2)
[2026-09-20T14:52:55Z] scale-up: chunks 3-8 moved to chunks/pool/<harness>; forward drivers finish chunk 2 and exit; pool schedulers start at concurrency 3 per harness
[2026-09-20T14:52:56Z] motifcode chunk3 start (concurrency 3, scheduler p1)
[2026-09-20T14:52:56Z] codex chunk3 start (concurrency 3, scheduler p1)
[2026-09-20T14:52:56Z] opencode chunk3 start (concurrency 3, scheduler p1)
[2026-09-20T15:00:41Z] opencode chunk2 end exit 0
[2026-09-20T15:00:41Z] opencode all chunks finished
[2026-09-20T15:31:08Z] motifcode chunk2 end exit 0
[2026-09-20T15:31:08Z] motifcode all chunks finished
[2026-09-20T15:48:39Z] opencode chunk3 end exit 0 (scheduler p1)
[2026-09-20T15:48:39Z] opencode chunk4 start (concurrency 3, scheduler p1)
[2026-09-20T15:57:01Z] codex chunk2 end exit 0
[2026-09-20T15:57:01Z] codex all chunks finished
[2026-09-20T16:00:09Z] motifcode chunk3 end exit 0 (scheduler p1)
[2026-09-20T16:00:09Z] motifcode chunk4 start (concurrency 3, scheduler p1)
[2026-09-20T16:01:28Z] codex chunkP01 start (concurrency 3, scheduler p2)
[2026-09-20T16:01:28Z] motifcode chunkP01 start (concurrency 2, scheduler p2)
[2026-09-20T16:01:28Z] opencode chunkP01 start (concurrency 1, scheduler p2)
[2026-09-20T16:09:54Z] codex chunk3 end exit 0 (scheduler p1)
[2026-09-20T16:09:54Z] codex pool scheduler p1: pool empty, exiting
[2026-09-20T16:32:22Z] codex chunkP01 end exit 0 (scheduler p2)
[2026-09-20T16:32:22Z] codex chunkP02 start (concurrency 5, scheduler p2)
[2026-09-20T16:42:47Z] motifcode chunkP01 end exit 0 (scheduler p2)
[2026-09-20T16:42:47Z] motifcode chunkP02 start (concurrency 2, scheduler p2)
[2026-09-20T16:51:35Z] codex chunkP02 end exit 0 (scheduler p2)
[2026-09-20T16:51:35Z] codex chunkP03 start (concurrency 5, scheduler p2)
[2026-09-20T16:59:19Z] opencode chunk4 end exit 0 (scheduler p1)
[2026-09-20T16:59:19Z] opencode pool scheduler p1: pool empty, exiting
[2026-09-20T17:04:52Z] opencode chunkP02 start (concurrency 4, scheduler p3)
[2026-09-20T17:17:48Z] motifcode chunk4 end exit 0 (scheduler p1)
[2026-09-20T17:17:48Z] motifcode pool scheduler p1: pool empty, exiting
[2026-09-20T17:18:29Z] motifcode chunkP03 start (concurrency 4, scheduler p3)
[2026-09-20T17:20:57Z] codex chunkP03 end exit 0 (scheduler p2)
[2026-09-20T17:20:57Z] codex chunkP04 start (concurrency 5, scheduler p2)
[2026-09-20T17:24:44Z] motifcode chunkP02 end exit 0 (scheduler p2)
[2026-09-20T17:24:44Z] motifcode chunkP04 start (concurrency 4, scheduler p2)
[2026-09-20T17:25:04Z] codex chunkP05 start (concurrency 5, scheduler p3)
[2026-09-20T17:29:02Z] opencode chunkP02 end exit 0 (scheduler p3)
[2026-09-20T17:29:02Z] opencode chunkP03 start (concurrency 4, scheduler p3)
[2026-09-20T17:38:00Z] motifcode chunkP03 end exit 0 (scheduler p3)
[2026-09-20T17:38:00Z] motifcode chunkP05 start (concurrency 4, scheduler p3)
[2026-09-20T17:40:07Z] motifcode chunkP04 end exit 0 (scheduler p2)
[2026-09-20T17:40:07Z] motifcode chunkP06 start (concurrency 4, scheduler p2)
[2026-09-20T17:42:04Z] codex chunkP05 end exit 0 (scheduler p3)
[2026-09-20T17:42:04Z] codex chunkP06 start (concurrency 5, scheduler p3)
[2026-09-20T17:42:34Z] opencode chunkP01 end exit 0 (scheduler p2)
[2026-09-20T17:42:34Z] opencode chunkP04 start (concurrency 4, scheduler p2)
[2026-09-20T17:43:27Z] codex chunkP04 end exit 0 (scheduler p2)
[2026-09-20T17:43:27Z] codex chunkP07 start (concurrency 5, scheduler p2)
[2026-09-20T17:55:59Z] opencode chunkP03 end exit 0 (scheduler p3)
[2026-09-20T17:55:59Z] opencode chunkP05 start (concurrency 4, scheduler p3)
[2026-09-20T17:58:55Z] opencode chunkP04 end exit 0 (scheduler p2)
[2026-09-20T17:58:55Z] opencode chunkP06 start (concurrency 4, scheduler p2)
[2026-09-20T18:01:13Z] codex chunkP07 end exit 0 (scheduler p2)
[2026-09-20T18:01:13Z] codex chunkP08 start (concurrency 5, scheduler p2)
[2026-09-20T18:02:04Z] motifcode chunkP05 end exit 0 (scheduler p3)
[2026-09-20T18:02:04Z] motifcode pool scheduler p3: pool empty, exiting
[2026-09-20T18:02:20Z] motifcode chunkP06 end exit 0 (scheduler p2)
[2026-09-20T18:02:20Z] motifcode pool scheduler p2: pool empty, exiting
[2026-09-20T18:05:33Z] codex chunkP06 end exit 0 (scheduler p3)
[2026-09-20T18:05:33Z] codex chunkP09 start (concurrency 5, scheduler p3)
[2026-09-20T18:08:11Z] opencode chunkP05 end exit 0 (scheduler p3)
[2026-09-20T18:08:11Z] opencode pool scheduler p3: pool empty, exiting
[2026-09-20T18:11:32Z] opencode chunkP06 end exit 0 (scheduler p2)
[2026-09-20T18:11:32Z] opencode pool scheduler p2: pool empty, exiting
[2026-09-20T18:11:52Z] opencode rerun-opencode start (concurrency 4, scheduler rerun)
[2026-09-20T18:20:23Z] codex chunkP09 end exit 0 (scheduler p3)
[2026-09-20T18:20:23Z] codex pool scheduler p3: pool empty, exiting
[2026-09-20T18:21:48Z] opencode rerun-opencode end exit 0 (scheduler rerun)
[2026-09-20T18:21:48Z] reruns finished
[2026-09-20T18:24:42Z] codex rerun-codex start (concurrency 4, scheduler rerun)
[2026-09-20T18:26:54Z] codex chunkP08 end exit 0 (scheduler p2)
[2026-09-20T18:26:54Z] codex pool scheduler p2: pool empty, exiting
[2026-09-20T18:39:29Z] codex rerun-codex end exit 0 (scheduler rerun)
[2026-09-20T18:39:29Z] reruns finished
[2026-09-20T18:40:24Z] campaign complete: 213 rows x 3 harnesses, 12 re-run substitutions; REPORT.md written
```

