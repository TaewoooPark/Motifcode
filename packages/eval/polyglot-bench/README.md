# polyglot-bench

The kit that produced [`../REPORT.md`](../REPORT.md): the same Motif-3, through three harnesses, over the
Aider polyglot benchmark, graded by this package. Anyone with an Infron API key can repeat it.

- **Dataset:** [Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark) at commit
  `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f` (225 Exercism exercises; the run used 213 — see `verify.sh`).
- **Model:** `motif/motif-3` via `https://llm.onerouter.pro/v1` (Infron). The key is read from `MOTIF_API_KEY`
  or `~/.motif/.env`; it is handed to each agent through its environment and never written to disk by this kit.
- **Harnesses:** motifcode (this repository's `motif` binary), Codex CLI (`codex exec`) and OpenCode (`opencode run`),
  each driven by an adapter in `adapters/` that speaks the runner's argv/journal contract.

## Prerequisites

`node` ≥ 20 with this repository built (`pnpm install && pnpm build`), `git`, `python3` with `pytest`, `go`,
`rustc`/`cargo`, a JDK the Java exercises' Gradle 8.7 accepts (JDK 21; set `JAVA21_HOME` if it is not the
Homebrew path), a C++ compiler, and Boost headers for two C++ exercises (`CXX_EXTRA_INCLUDE`). For the other two
harnesses: `codex` and `opencode` on `PATH`. Versions used in the report are in its Section 10.

## Run

```bash
cd packages/eval/polyglot-bench
git clone https://github.com/Aider-AI/polyglot-benchmark && git -C polyglot-benchmark checkout 7e0611e77b54
(cd js-deps && npm install)          # shared jest/babel for the JavaScript track
export MOTIF_API_KEY=...             # or `motif login`
source env.sh
./verify.sh                          # build the suite; confirm every exercise runs and its reference passes
python3 make_manifests.py            # manifests/{motifcode,codex,opencode}.json
python3 make_chunks.py 12            # stratified 12-row pieces into chunks/pool/<harness>/
./run_pool.sh motifcode p1 &  ./run_pool.sh codex p1 &  ./run_pool.sh opencode p1 &
./status.sh                          # progress; 429s; abnormal rows
python3 compare.py                   # paired statistics over the rows present for all three
python3 make_report.py               # REPORT.md
```

Concurrency per harness is read from `chunks/conc-<harness>.txt` at each piece start (default 3). A second
scheduler for the same harness (`./run_pool.sh codex p2`) claims the next piece; each scheduler builds its own
suite directory because `motif-suite` rebuilds the suite on every command.

## What the adapters do

`adapters/common.sh` parses the runner's argv (`<task> --cwd --journal --endpoint --model --max-turns
--max-output-tokens --seed …`), runs the agent in its own process group under an 870 s deadline and an 8 GB
resident-memory cap, writes a journal the runner reads (`session_end` with `done`, `wall_timeout`,
`memory_limit`, `repetition_abort`, `transport_error` or `agent_error`), and keeps the patch, the agent's log
and timing under `logs/<harness>/…` after the runner deletes the row.

- `motifcode.sh` runs `motif "<task>"` in benchmark mode as shipped and symlinks its journal into `logs/`.
- `codex.sh` copies `homes/codex/config.pristine.toml` into a per-row `CODEX_HOME` (responses API, sandbox bypassed,
  `stream_idle_timeout_ms` 30 min because the stock 300 s drops the stream on this endpoint's 200–300 s reasoning steps)
  and runs `codex exec --json`.
- `opencode.sh` uses `homes/opencode/config/opencode/opencode.json` (openai-compatible provider, webfetch/websearch
  denied) with per-row XDG data/state directories and runs `opencode run --pure --format json --dangerously-skip-permissions`.

Rows that fail for infrastructure reasons go into `results/rerun.txt` by hand, one per line
(`<harness> <instance> <reason>`), and `./run_rerun.sh` re-runs them into `results/<harness>/rerun.jsonl`, which
`compare.py` and `make_report.py` substitute for the originals.

## Files

| | |
|---|---|
| `env.sh` | paths, toolchain pins, fixed git dates so the suite's base commits are deterministic |
| `verify.sh` | `motif-suite build` + `verify` per language into `verify/*.json` |
| `make_manifests.py`, `make_chunks.py` | the pinned plan: budgets, seeds, exclusions, stratified pieces |
| `run_chunk.sh`, `run_pool.sh`, `run_rerun.sh` | drive `motif-suite run` over one piece, over a pool, over the re-run list |
| `adapters/`, `homes/` | the three harnesses behind one runner contract; pristine Codex and OpenCode configs |
| `status.sh`, `cleanup_orphans.sh` | progress and hygiene during a campaign |
| `compare.py`, `make_report.py` | paired bootstrap CI, McNemar, per-language tables; the report |

Outputs (`suite-*/`, `results/`, `logs/`, `chunks/pool*/`, `verify/`, `manifests/`, `instances.json`,
`corpus-spec.json`, `REPORT.md`) are ignored by git here.
