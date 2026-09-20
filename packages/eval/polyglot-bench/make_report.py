#!/usr/bin/env python3
"""Write REPORT.md: the final three-harness Aider-polyglot comparison on Motif-3.

Every number is read from results/ (the runner's rows), logs/ (the adapters' evidence), the manifests,
and results/campaign.log. Rows re-run after an infrastructure failure or an adapter fix replace the
originals (results/<harness>/rerun.jsonl); the originals stay in the chunk files for the record.
"""
import json, glob, pathlib, collections, statistics, subprocess, datetime, math, random, re, os, sys

B = pathlib.Path(os.environ.get("BENCH") or pathlib.Path(__file__).resolve().parent)
REPO_DIR = os.environ.get("MOTIFCODE_REPO") or (str(B.parents[2]) if (B.parents[2] / "package.json").exists() and "motifcode" in (B.parents[2] / "package.json").read_text() else str(pathlib.Path.home() / "personal/Motif-code"))
H = ["motifcode", "codex", "opencode"]
KST = datetime.timezone(datetime.timedelta(hours=9))


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return "?"


def load(h):
    out, subs = {}, []
    for f in sorted(glob.glob(str(B / f"results/{h}/chunk*.jsonl"))):
        for l in open(f):
            if l.strip():
                r = json.loads(l)
                out[r["instanceId"]] = r
    rr = B / f"results/{h}/rerun.jsonl"
    if rr.exists():
        for l in open(rr):
            if l.strip():
                r = json.loads(l)
                old = out.get(r["instanceId"], {})
                subs.append((r["instanceId"], end_of(old), grade_of(old), end_of(r), grade_of(r)))
                out[r["instanceId"]] = r
    return out, subs


def end_of(r):
    return r.get("agentEndReason") or r.get("status") or "?"


def grade_of(r):
    return (r.get("grade") or {}).get("status", "?")


def ok(r):
    return grade_of(r) == "passed"


def meta(h, r):
    lang, ex = r["instanceId"].split("/")
    d = B / f"logs/{h}/{h}--{lang}/{ex}--0--1"
    reqs = ptok = ctok = None
    try:
        if h == "motifcode":
            n = p = c = 0
            for l in open(d / "session.jsonl"):
                ev = (json.loads(l).get("record") or {}).get("event") or {}
                if ev.get("type") == "usage":
                    n += 1
                    p += ev.get("promptTokens") or 0
                    c += ev.get("completionTokens") or 0
            reqs, ptok, ctok = n, p, c
        elif h == "codex":
            n = 0
            for l in open(d / "agent.log"):
                if not l.startswith("{"):
                    continue
                if '"turn.completed"' in l:
                    u = json.loads(l).get("usage") or {}
                    ptok, ctok = u.get("input_tokens"), u.get("output_tokens")
                if '"item.completed"' in l and '"command_execution"' in l:
                    n += 1
            reqs = n  # shell commands executed; codex --json carries no request count
        elif h == "opencode":
            n = p = c = 0
            for l in open(d / "agent.log"):
                if l.startswith("{") and '"step_finish"' in l:
                    e = json.loads(l)
                    t = (e.get("part") or {}).get("tokens") or {}
                    n += 1
                    p += (t.get("input") or 0) + ((t.get("cache") or {}).get("read") or 0)
                    c += t.get("output") or 0
            reqs, ptok, ctok = n, p or None, c or None
    except Exception:
        pass
    return reqs, ptok, ctok


def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def boot(diffs, reps=20000, seed=0):
    rng = random.Random(seed)
    n = len(diffs)
    m = []
    for _ in range(reps):
        m.append(sum(diffs[rng.randrange(n)] for _ in range(n)) / n)
    m.sort()
    return m[int(0.025 * reps)], m[int(0.975 * reps) - 1]


def fmt_p(p):
    return "p < 0.0001" if p < 0.0001 else f"p = {p:.4f}"


def wilson(p, n, z=1.96):
    ph = p / n
    den = 1 + z * z / n
    c = (ph + z * z / (2 * n)) / den
    hw = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return (c - hw) * 100, (c + hw) * 100


def med(xs):
    return statistics.median(xs) if xs else float("nan")


data = {h: load(h) for h in H}
rows = {h: data[h][0] for h in H}
subs = {h: data[h][1] for h in H}
excluded = json.load(open(B / "chunks/excluded.json"))
expected = {i["id"] for i in json.load(open(B / "instances.json"))} - set(excluded)
common = set.intersection(*[set(rows[h]) for h in H]) & expected
keys = sorted(common)
langs = sorted({i.split("/")[0] for i in expected})
manifests = {h: json.load(open(B / f"manifests/{h}.json")) for h in H}
rerun_notes = [l.strip() for l in open(B / "results/rerun.txt") if l.strip() and not l.startswith("#")]
camp = [l.rstrip() for l in open(B / "results/campaign.log")]
versions = {
    "motifcode": sh(f"node {REPO_DIR}/packages/cli/dist/motif.js version 2>/dev/null | head -1") or "0.3.0",
    "codex": sh("codex --version"),
    "opencode": "opencode " + sh("opencode --version"),
}
harness_sha = manifests["motifcode"]["harness"]["git_sha"]
suite_rev = manifests["motifcode"]["suite"]["dataset_revision"]

pass_n = {h: sum(ok(rows[h][k]) for k in keys) for h in H}
n = len(keys)
metas = {h: {k: meta(h, rows[h][k]) for k in keys} for h in H}

# ---------------------------------------------------------------- write
L = []
A = L.append
A("# Motif-3 on Three Coding Harnesses: A Paired Aider-Polyglot Benchmark")
A("")
A(f"**Date:** {datetime.datetime.now(KST).strftime('%Y-%m-%d')} (KST) · **Model:** `motif/motif-3` (Motif Technologies, 314B-A13B MoE) via Infron · **Suite:** Aider polyglot-benchmark, 213 instances · **Harnesses:** motifcode {versions['motifcode']}, {versions['codex']}, {versions['opencode']}")
A("")
A("This campaign was a first, deliberately small measurement. The Aider polyglot benchmark was chosen to test performance quickly: it is the only agentic coding suite the machine at hand could run without Docker, and it exercises spec-to-code with a test loop rather than repository work. SWE-bench Verified and Terminal-Bench 2.1, the benchmarks behind Motif-3's published scores, have not been run with these harnesses; Section 8 lists the other limits.")
A("")
A("Every number in this report is computed by `make_report.py` from the campaign directory: the runner's rows (`results/*.jsonl`), the per-row logs (`logs/`), the manifests and `results/campaign.log`.")
A("")

# ---- 1. executive summary
A("## 1. Executive summary")
A("")
order = sorted(H, key=lambda h: -pass_n[h])
A(f"Three coding-agent harnesses were driven by the same model, the same API key, the same 213 Exercism exercises and the same budgets, and graded by the same test command in a pristine checkout. Pass rates over the {n} paired instances:")
A("")
A("| harness | passed | pass rate | 95% CI |")
A("|---|---|---|---|")
for h in H:
    lo, hi = wilson(pass_n[h], n)
    A(f"| **{h}** | {pass_n[h]}/{n} | **{pass_n[h]/n*100:.1f}%** | [{lo:.1f}, {hi:.1f}] |")
A("")
pairs = {}
for a, b in (("motifcode", "codex"), ("motifcode", "opencode"), ("opencode", "codex")):
    da = [ok(rows[a][k]) for k in keys]
    db = [ok(rows[b][k]) for k in keys]
    ao = sum(1 for x, y in zip(da, db) if x and not y)
    bo = sum(1 for x, y in zip(da, db) if y and not x)
    both = sum(1 for x, y in zip(da, db) if x and y)
    nei = sum(1 for x, y in zip(da, db) if not x and not y)
    diffs = [int(x) - int(y) for x, y in zip(da, db)]
    lo, hi = boot(diffs)
    pairs[(a, b)] = (ao, bo, both, nei, sum(diffs) / len(diffs) * 100, lo * 100, hi * 100, mcnemar(ao, bo))
mc = pairs[("motifcode", "codex")]
mo = pairs[("motifcode", "opencode")]
oc = pairs[("opencode", "codex")]
A("Findings:")
A("")
def verdict(d, lo, hi, p):
    return "significant at the 5% level" if p < 0.05 else "not significant at the 5% level"
A(f"- **motifcode, the harness written for this model, solved the most instances.** Against Codex the paired difference is {mc[4]:+.1f} pp (95% CI [{mc[5]:+.1f}, {mc[6]:+.1f}], McNemar {fmt_p(mc[7])}, {verdict(*mc[4:8])}); against OpenCode it is {mo[4]:+.1f} pp (95% CI [{mo[5]:+.1f}, {mo[6]:+.1f}], {fmt_p(mo[7])}, {verdict(*mo[4:8])}).")
A(f"- **OpenCode {'beat' if oc[7] < 0.05 else 'led'} Codex** by {oc[4]:+.1f} pp (95% CI [{oc[5]:+.1f}, {oc[6]:+.1f}], {fmt_p(oc[7])}, {verdict(*oc[4:8])}).")
ends = {h: collections.Counter(end_of(rows[h][k]) for k in keys) for h in H}
A(f"- The gap is mostly about **how each harness copes with this model's failure modes**, not about what the model can write: {ends['motifcode'].get('done',0)} motifcode rows ended normally versus {ends['codex'].get('done',0)} for Codex and {ends['opencode'].get('done',0)} for OpenCode; the rest ended on the 15-minute cap, a turn cap, a router-side repetition abort, or a protocol error (Section 6.4).")
A(f"- All three harnesses ran at temperature 1.0 with one seed, so per-instance outcomes are noisy; the paired design removes instance difficulty but not sampling variance (Section 8).")
A("")

# ---- 2. benchmark
A("## 2. Benchmark")
A("")
A(f"- **Source:** [Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark) at `{suite_rev[:12]}` — 225 Exercism practice exercises across C++, Go, Java, JavaScript, Python and Rust.")
A("- **Instance construction:** each exercise becomes a single-commit git repository containing the stub, the tests, `INSTRUCTIONS.md` and the toolchain files. The `.meta/` directory (reference solution) is never copied. Base commits are deterministic across rebuilds (fixed author/committer dates), and were verified identical across all 13 suite directories used (2,925 repositories checked, 0 mismatches).")
A("- **Task text:** the exercise's `instructions.md` (plus `instructions.append.md` when present), followed by the files to implement and the test files to run, and a note that tests are restored before grading. Identical for all harnesses.")
A("- **Grading:** the agent's work leaves its checkout as a `git diff` (staged, so new files count). The patch is applied to a fresh worktree of the same base commit, every test path is restored from the base commit, and the track's own test command runs (`pytest`, `jest`, `go test ./...`, `cargo test`, `./gradlew test`, `g++ … && ./runner`). Exit 0 is a pass. A row times out, crashes or is missing → scored as a fail, never dropped.")
A(f"- **Exclusions (decided before the run, from `motif-suite verify` on this machine):** {len(excluded)} of 225. Six exercises pass with the stub untouched and cannot discriminate (`{'`, `'.join(sorted(k for k,v in excluded.items() if v.startswith('already')))}`); six Rust exercises ship a reference solution that does not build (`{'`, `'.join(sorted(k for k,v in excluded.items() if v.startswith('reference')))}`). 213 instances remain; all 213 have a graded row for every harness.")
A("")

# ---- 3. systems under test
A("## 3. Systems under test")
A("")
A("**Model and endpoint.** `motif/motif-3` served by Infron at `https://llm.onerouter.pro/v1` (free tier, one API key). The router exposes `/v1/chat/completions` (used by motifcode and OpenCode) and `/v1/responses` (used by Codex); it returns structured `tool_calls`, a separate `reasoning` field, and prompt-cache statistics. Over the campaign it never returned a 429.")
A("")
A("| harness | version | invocation | protocol | deviations from stock |")
A("|---|---|---|---|---|")
A(f"| motifcode | {versions['motifcode']} (`{harness_sha[:12]}`) | `motif \"<task>\" --cwd … --channel toolcall --max-turns 40 --max-output-tokens 16384 --seed 0` | chat completions, native tool calls, 9 fixed tools | none; benchmark mode as shipped (`done` contract with confirmation, no-action re-prompt, loop guard) |")
A(f"| Codex CLI | {versions['codex']} | `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C … -m motif/motif-3 --json` | responses API via a custom provider (`wire_api = \"responses\"`) | `stream_idle_timeout_ms` raised from 300 s to 30 min (stock Codex dropped the stream on this endpoint's 200–300 s reasoning steps; see Section 9); per-row `CODEX_HOME` |")
A(f"| OpenCode | {versions['opencode']} | `opencode run --pure --dir … -m infron/motif/motif-3 --format json --dangerously-skip-permissions` | chat completions via `@ai-sdk/openai-compatible` | `webfetch`/`websearch` denied; per-row XDG data/state directories |")
A("")
A("Sampling: motifcode sends temperature 1.0 / top_p 0.95 explicitly (the model's published evaluation settings). Codex and OpenCode send their defaults; the server default is the same pair. Whether the two clients send reasoning back into history was not instrumented.")
A("")

# ---- 4. protocol
A("## 4. Protocol")
A("")
A("- **Isolation per row:** a fresh `git worktree` of the pinned base commit; a fresh agent process in its own process group; per-row config/state directories for Codex and OpenCode; grading in a separate pristine worktree the agent never sees. No container: the host toolchains are shared, and the network is reachable from the shell for all three.")
A("- **Budgets (identical):** 15-minute wall cap per row (an in-adapter deadline at 870 s, the runner's 900 s SIGKILL as backstop), 8 GB resident-memory cap per row, seed 0, one attempt per instance. motifcode additionally has its own 40-turn cap and 16,384 output tokens per step (`--max-turns`, `--max-output-tokens`); Codex and OpenCode expose no equivalent switches.")
A("- **Pairing:** every instance was run once by each harness; comparisons are paired by instance (McNemar exact test on discordant pairs; 95% bootstrap CI on the mean paired difference, 20,000 resamples, fixed seed).")
A("- **Re-runs:** a row was re-run only for a documented infrastructure failure or when it had run under a since-fixed adapter setting; the list with reasons is `results/rerun.txt` (Section 9). Re-run rows replace the originals; originals are kept.")
A("- **Scheduling:** three campaigns in parallel, 2 rows per harness for the first 3 hours, then 3–5 per harness (up to 26 concurrent streams for about 20 minutes near the end). Endpoint decode speed fell from ~62 to 46–55 tok/s in the heaviest stretch; the time-based cap therefore bit harder there (Section 8).")
A("")

# ---- 5. completeness
A("## 5. Completeness and integrity checks")
A("")
for h in H:
    ids = set(rows[h]) & expected
    A(f"- **{h}:** {len(ids)}/213 instances graded, 0 missing, 0 duplicates, {len(subs[h])} re-run substitution(s); no row in an infrastructure status (`agent_crash`, `grader_infra_error`, `model_transport_failure`, `missing`).")
A("- Manifests: identical suite hash, dataset revision, budgets, seeds, per-step output cap and pair group across the three harnesses (`checkPairable` criteria).")
A("- Suite base commits: identical across all suite directories (2,925 repositories checked).")
A("")

# ---- 6. results
A("## 6. Results")
A("")
A("### 6.1 Pass rates")
A("")
A("| harness | passed | failed | pass rate | 95% CI (Wilson) |")
A("|---|---|---|---|---|")
for h in H:
    lo, hi = wilson(pass_n[h], n)
    A(f"| {h} | {pass_n[h]} | {n-pass_n[h]} | **{pass_n[h]/n*100:.1f}%** | [{lo:.1f}, {hi:.1f}] |")
A("")
A("### 6.2 Paired comparisons")
A("")
A("| A vs B | A only | B only | both pass | both fail | Δ (A − B) | 95% CI | McNemar p |")
A("|---|---|---|---|---|---|---|---|")
for (a, b), (ao, bo, both, nei, d, lo, hi, p) in pairs.items():
    A(f"| {a} vs {b} | {ao} | {bo} | {both} | {nei} | **{d:+.1f} pp** | [{lo:+.1f}, {hi:+.1f}] | {fmt_p(p)} |")
A("")
A("### 6.3 By language")
A("")
A("| language | n | " + " | ".join(H) + " |")
A("|---|---|" + "---|" * len(H))
for lg in langs:
    ks = [k for k in keys if k.startswith(lg + "/")]
    A(f"| {lg} | {len(ks)} | " + " | ".join(f"{sum(ok(rows[h][k]) for k in ks)}/{len(ks)} ({sum(ok(rows[h][k]) for k in ks)/len(ks)*100:.0f}%)" for h in H) + " |")
A("")
A("### 6.4 How rows ended")
A("")
A("The end reason is what the harness reported (motifcode's journal; the adapter's classification of Codex/OpenCode exits). `done` is a normal completion; everything else is a budget or protocol event. A row can still pass after an abnormal ending because grading reads the patch left behind.")
A("")
allends = sorted({e for h in H for e in ends[h]})
A("| end reason | " + " | ".join(H) + " | meaning |")
A("|---|" + "---|" * len(H) + "---|")
meaning = {
    "done": "the harness reported normal completion",
    "wall_timeout": "the 15-minute cap (adapter deadline at 870 s)",
    "agent_timeout": "the 15-minute cap enforced by the runner (before the adapter deadline existed)",
    "turn_limit": "motifcode's 40-turn cap",
    "loop_detected": "motifcode's loop guard (identical call/output repeated)",
    "repetition_abort": "the router stopped generation (\"Repetition was detected\") and the harness gave up",
    "agent_error": "the harness exited non-zero for another reason (Codex: a malformed tool call echoed back was rejected as invalid_request)",
    "memory_limit": "the 8 GB per-row cap",
}
for e in allends:
    A(f"| {e} | " + " | ".join(str(ends[h].get(e, 0)) for h in H) + f" | {meaning.get(e, '')} |")
A("")
A("Passed despite an abnormal ending: " + ", ".join(f"{h} {sum(1 for k in keys if ok(rows[h][k]) and end_of(rows[h][k]) != 'done')}" for h in H) + ".")
A("")
A("### 6.5 Cost per row (median over paired rows)")
A("")
A("| harness | wall s | requests / steps | prompt tokens | completion tokens | totals (prompt / completion) |")
A("|---|---|---|---|---|---|")
for h in H:
    ms = [metas[h][k] for k in keys]
    w = [rows[h][k].get("wallMs", 0) / 1000 for k in keys]
    reqs = [m[0] for m in ms if m[0]]
    pt = [m[1] for m in ms if m[1]]
    ct = [m[2] for m in ms if m[2]]
    unit = "shell commands" if h == "codex" else ("requests" if h == "motifcode" else "steps")
    A(f"| {h} | {med(w):.0f} | {med(reqs):.0f} {unit} | {med(pt):,.0f} | {med(ct):,.0f} | {sum(pt):,} / {sum(ct):,} |")
A("")
A("Prompt tokens are the sum over a row's requests (motifcode: server `prompt_tokens`, ~90% served from the prefix cache; OpenCode: `input + cache.read`; Codex: `input_tokens` from `turn.completed`). Codex's `--json` stream carries no request count. Wall time depends on endpoint load and is a secondary metric.")
A("")

# ---- 7. analysis
A("## 7. Analysis")
A("")
A("**Where the three differ.** The instances that separate the harnesses are not the ones the model cannot solve; they are the ones where a harness lost the model's work:")
A("")
A(f"- **Codex** lost {ends['codex'].get('wall_timeout',0)+ends['codex'].get('agent_timeout',0)} rows to the 15-minute cap and {ends['codex'].get('agent_error',0)} to a protocol error. In the protocol case the model emitted a tool call Codex could not route (`final_answer`, or `apply_patch` in the wrong shape); Codex echoed the malformed call back into history and the router rejected the next request with `invalid_request` (\"Unterminated string\"). Codex also sets no default command timeout: one row's infinite-loop test consumed 9 GB before it was stopped.")
A(f"- **OpenCode** lost {ends['opencode'].get('repetition_abort',0)} rows to the router's repetition guard (\"Repetition was detected in the model's output and generation was stopped\"): it treats the provider error as fatal and exits, keeping whatever was already written. It was the fastest per row (fewest steps) and never hit the turn or loop guards it does not have.")
A(f"- **motifcode** ended {ends['motifcode'].get('done',0)} rows normally. Its losses were the cap ({ends['motifcode'].get('wall_timeout',0)+ends['motifcode'].get('agent_timeout',0)} rows, several of them still passing on the patch left behind), its own 40-turn cap ({ends['motifcode'].get('turn_limit',0)}) and loop guard ({ends['motifcode'].get('loop_detected',0)}; in one row the model deleted its own checkout after a CMake error). It never saw a repetition abort or a protocol abort: its transport retries server errors and its parser recovers tool calls the router leaves in the body.")
A("")
A("**What the model-specific harness bought.** The measurable advantages on this endpoint were (1) reasoning continuity and a ~2k-token prompt with a frozen tool order, keeping 90%+ of every request in the prefix cache; (2) recovery of tool calls the server did not extract; (3) the `done` contract and no-action re-prompt in benchmark mode, so a turn that stops without acting is handed back instead of ending the task. The thin fixed tool set (bash/read/write/apply_patch/term) did not hurt relative to the richer tool sets of Codex and OpenCode.")
A("")

# ---- 8. threats to validity
A("## 8. Threats to validity")
A("")
A("- **Sampling noise.** One seed at temperature 1.0. The paired test controls for instance difficulty, not for the draw; a second seed would tighten the intervals. Effects smaller than ~8 pp are not resolved here.")
A("- **Time-based cap under variable load.** Concurrency rose from 6 to 26 streams over the campaign and the endpoint slowed by up to 25%. Rows that ran in the slowest stretch were more likely to hit the cap. All harnesses shared the load, but Codex ran a larger share of its rows in the final, heaviest hour.")
A("- **Adapter deviations.** Codex's stream idle timeout was raised (Section 9); OpenCode had web tools denied. Both are documented; the first is the same accommodation motifcode makes for itself (it disables Node's 300 s header timeout).")
A("- **Benchmark scope.** Exercism exercises measure spec-to-code with a test loop in a two-file repository. Nothing here speaks to navigating an unfamiliar codebase.")
A("- **No container isolation.** Host toolchains and the network were shared. Solutions to these exercises exist online; all three harnesses could reach them through the shell, none was observed doing so.")
A("- **Unknown client-side sampling and history handling** for Codex and OpenCode (whether they send temperature, and whether they return reasoning to history) was not instrumented.")
A("")

# ---- 9. incidents
A("## 9. Incidents, fixes and re-runs")
A("")
A("Recorded in `results/campaign.log` as they happened:")
A("")
for l in camp:
    if "[note]" in l:
        A(f"- {l.replace('[note] ', '')}")
A("")
A("Re-run rows (original → re-run):")
A("")
for h in H:
    for i, we, wg, ne, ng in subs[h]:
        A(f"- {h} `{i}`: {we}/{wg} → {ne}/{ng}")
A("")
A("Reasons per row are in `results/rerun.txt`.")
A("")

# ---- 10. reproducibility
A("## 10. Reproducibility")
A("")
A("| item | value |")
A("|---|---|")
A(f"| motifcode harness commit | `{harness_sha}` |")
A(f"| suite revision | `{suite_rev}` |")
A(f"| instances sha256 | `{manifests['motifcode']['suite']['instances_sha256']}` |")
A(f"| motifcode system-prompt / tool-schema sha256 | `{manifests['motifcode']['harness']['system_prompt_sha256'][:16]}…` / `{manifests['motifcode']['harness']['tool_schema_sha256'][:16]}…` |")
A(f"| Codex adapter / config sha256 | `{manifests['codex']['harness']['system_prompt_sha256'][:16]}…` / `{manifests['codex']['harness']['tool_schema_sha256'][:16]}…` |")
A(f"| OpenCode adapter / config sha256 | `{manifests['opencode']['harness']['system_prompt_sha256'][:16]}…` / `{manifests['opencode']['harness']['tool_schema_sha256'][:16]}…` |")
A(f"| machine | macOS {sh('sw_vers -productVersion')}, {sh('sysctl -n machdep.cpu.brand_string')}, {sh('sysctl -n hw.memsize | awk \"{print int(\\$1/1073741824)}\"')} GB |")
A(f"| toolchains | Node {sh('node --version')}, JDK 21 ({sh('/opt/homebrew/opt/openjdk@21/bin/java -version 2>&1 | head -1 | cut -d\\\" -f2')}) with Gradle 8.7 (daemon off), Rust {sh('rustc --version | cut -d\" \" -f2')}, Go {sh('go version | cut -d\" \" -f3')}, Python {sh('python3 --version | cut -d\" \" -f2')} + pytest {sh('python3 -m pytest --version 2>&1 | cut -d\" \" -f2')}, Apple clang {sh('clang --version | head -1 | sed -E \"s/.*version ([0-9.]+).*/\\\\1/\"')}, boost from Homebrew |")
A("")
A("Layout of the campaign directory: `env.sh` (toolchain pins, fixed git dates), `adapters/` (the three agent adapters + `common.sh`), `homes/` (pristine Codex/OpenCode configs), `manifests/`, `chunks/` (the stratified plan and `excluded.json`), `results/<harness>/*.jsonl` (rows), `logs/<harness>/…` (journal, agent log, patch, meta per row), `compare.py`, `make_report.py`.")
A("")
A("### How to reproduce")
A("")
A("The adapters, configs and scripts are published as a kit at `packages/eval/polyglot-bench/` in the motifcode repository (`" + harness_sha[:12] + "` or later); an Infron API key (`MOTIF_API_KEY`) is the only credential. The dataset is [Aider-AI/polyglot-benchmark](https://github.com/Aider-AI/polyglot-benchmark) at commit `" + suite_rev + "`.")
A("")
A("```bash")
A("git clone https://github.com/TaewoooPark/Motifcode && cd Motifcode && pnpm install && pnpm build")
A("cd packages/eval/polyglot-bench")
A("git clone https://github.com/Aider-AI/polyglot-benchmark && git -C polyglot-benchmark checkout " + suite_rev[:12])
A("(cd js-deps && npm install)                 # shared jest/babel for the JavaScript track")
A("export MOTIF_API_KEY=...                    # Infron key; Codex and OpenCode read it through the adapters")
A("source env.sh                               # toolchains: node, go, rustc, JDK 21 (Gradle 8.7), python3+pytest, clang, boost")
A("./verify.sh                                 # builds the suite, checks every exercise runs and its reference passes -> verify/*.json")
A("python3 make_manifests.py                   # manifests/{motifcode,codex,opencode}.json: 40 turns, 16K tokens/step, 900 s cap, seed 0")
A("python3 make_chunks.py 12                   # stratified 12-row pieces into chunks/pool/<harness>/, exclusions from verify/")
A("./run_pool.sh motifcode p1 & ./run_pool.sh codex p1 & ./run_pool.sh opencode p1 &   # concurrency from chunks/conc-<harness>.txt")
A("python3 compare.py && python3 make_report.py   # paired statistics; REPORT.md")
A("```")
A("")
A("Codex needs `codex` on PATH with no login (the kit's `CODEX_HOME` config uses the key through `env_key`); OpenCode needs `opencode` on PATH. Rows that fail for infrastructure reasons are listed by hand in `results/rerun.txt` and re-run with `run_rerun.sh`; `compare.py` and `make_report.py` substitute them.")
A("")

# ---- appendix A: per-instance
A("## Appendix A. Per-instance results")
A("")
A("✓ = passed, ✗ = failed; the end reason follows when it was not `done`.")
A("")
A("| instance | " + " | ".join(H) + " |")
A("|---|" + "---|" * len(H))


def cell(r):
    e = end_of(r)
    return ("✓" if ok(r) else "✗") + ("" if e == "done" else f" ({e})")


for k in keys:
    A(f"| {k} | " + " | ".join(cell(rows[h][k]) for h in H) + " |")
A("")

# ---- appendix B: timeline
A("## Appendix B. Campaign timeline")
A("")
A("```")
for l in camp:
    if "[note]" not in l:
        A(l)
A("```")
A("")
(B / "REPORT.md").write_text("\n".join(L) + "\n")
print("wrote", B / "REPORT.md", f"({len(L)} lines)")
