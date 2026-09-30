#!/usr/bin/env python3
"""Write REPORT-v2.md: the polyglot harness benchmark, protocol v2, for the three harnesses on Motif-3.

What protocol v2 asks a report to carry, and nothing it does not:
  - pass@1 under the official rules (the primary number) and the strict ones, pass@2 after the feedback round,
    per replicate and per language;
  - paired comparisons between harnesses on the same instances: discordant pairs, McNemar exact p, a bootstrap CI
    on the difference; agreement between replicates;
  - how the rows that did not pass ended: false completion, abort, protocol error, infrastructure, safety cap,
    invalid by the network rule — and, where results/manual-labels.json says so, spec ambiguity or a wrong answer;
  - cost per task and per success (requests, tokens, wall time: p50 / p90 / max) and pass rate by budget;
  - a Harness Card per harness (harness-cards.json, with the versions and budgets from the manifests);
  - a comparison with the 2026-09-20 campaign, named as a different protocol, and none with Aider's leaderboard.

Reads results/r<N>/<harness>/*.jsonl (the runner's rows; rerun.jsonl replaces the rows it names), the manifests, the
runner's artifacts/ and the adapters' logs/. Every number is computed from those files, except the campaign's totals
when CAMPAIGN_RESULTS (that campaign's results/ directory) is not given: then they are the ones ../REPORT.md records.
"""
import collections, glob, json, math, os, pathlib, random, statistics, sys

B = pathlib.Path(os.environ.get("BENCH") or pathlib.Path(__file__).resolve().parent)
H = ["motifcode", "codex", "opencode"]
TOKEN_BUDGETS = [10_000, 20_000, 50_000, 100_000, 200_000, None]
STEP_BUDGETS = [5, 10, 20, 40, 80, None]
# motifcode's endings where the model's output could not be run as actions: malformed actions past the repair budget,
# or turn after turn with no action at all. Codex and OpenCode report no such ending of their own.
PROTOCOL_ERRORS = {"breakage_limit", "no_action_limit"}
# The 2026-09-20 campaign as ../REPORT.md records it: passes out of 213, first-test grading in four languages.
CAMPAIGN_RECORDED = {"motifcode": 196, "codex": 170, "opencode": 177}


def ok(grade):
    return (grade or {}).get("status") == "passed"


def load(rep, h, base=None):
    base = base or B / f"results/r{rep}/{h}"
    rows = {}
    for f in sorted(glob.glob(str(base / "chunk*.jsonl"))):
        for line in open(f):
            if line.strip():
                r = json.loads(line)
                rows[r["instanceId"]] = r
    rerun = base / "rerun.jsonl"
    if rerun.exists():
        for line in open(rerun):
            if line.strip():
                r = json.loads(line)
                rows[r["instanceId"]] = r
    return rows


def pass1(r, strict=False):
    if r.get("invalid"):
        return False
    return ok(r.get("gradeStrict") or r.get("grade")) if strict else ok(r.get("grade"))


def pass2(r):
    return not r.get("invalid") and (ok(r.get("grade")) or ok((r.get("feedback") or {}).get("grade")))


def row_dirs(h, r):
    lang, ex = r["instanceId"].split("/")
    name = f"{r['configId']}--{lang}--{ex}--{r['seed']}--{r['replicate']}"
    art = pathlib.Path(r["artifacts"]) if r.get("artifacts") else B / f"artifacts/r{r['replicate']}/{h}/{name}"
    log = B / f"logs/{h}/{r['configId']}--{lang}/{ex}--{r['seed']}--{r['replicate']}"
    return art, log


def jsonl(path):
    try:
        for line in open(path):
            if line.startswith("{"):
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    pass
    except OSError:
        return


def cost(h, r, rounds=("",)):
    """Requests, prompt tokens and completion tokens a row spent, from the harness's own records."""
    art, log = row_dirs(h, r)
    requests = prompt = completion = 0
    seen = False
    for phase in rounds:
        if h == "motifcode":
            for e in jsonl(art / f"session{phase}.jsonl"):
                ev = (e.get("record") or {}).get("event") or {}
                if ev.get("type") == "usage":
                    seen = True
                    requests += 1
                    prompt += ev.get("promptTokens") or 0
                    completion += ev.get("completionTokens") or 0
        elif h == "codex":
            for e in jsonl(art / f"agent{phase}.log"):
                if e.get("type") == "turn.completed":
                    seen = True
                    u = e.get("usage") or {}
                    prompt += u.get("input_tokens") or 0
                    completion += u.get("output_tokens") or 0
            # Codex's events carry no request count; the parameter proxy logs one line per request.
            requests += sum(1 for _ in jsonl(log / f"param-proxy{phase}.jsonl"))
        elif h == "opencode":
            for e in jsonl(art / f"agent{phase}.log"):
                if e.get("type") == "step_finish":
                    seen = True
                    requests += 1
                    t = (e.get("part") or {}).get("tokens") or {}
                    prompt += (t.get("input") or 0) + ((t.get("cache") or {}).get("read") or 0)
                    completion += (t.get("output") or 0) + (t.get("reasoning") or 0)
    return (requests or None, prompt or None, completion or None) if seen else (None, None, None)


def failure_type(r, labels, h):
    if r.get("invalid"):
        return "invalid (network rule)"
    st = r.get("status")
    if st == "safety_cap":
        return "safety cap"
    if st in ("model_transport_failure", "agent_crash", "grader_infra_error", "missing") or (r.get("grade") or {}).get("status") == "infra_error":
        return "infrastructure"
    label = labels.get(f"{h} {r['instanceId']}")
    if label:
        return label
    reason = r.get("agentEndReason")
    if reason == "done":
        return "false completion (unlabelled)"
    if reason in PROTOCOL_ERRORS:
        return f"protocol error ({reason})"
    return f"abort ({reason or st})"


def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def boot(diffs, reps=20000, seed=0):
    rng = random.Random(seed)
    n = len(diffs)
    means = sorted(sum(diffs[rng.randrange(n)] for _ in range(n)) / n for _ in range(reps))
    return means[int(0.025 * reps)], means[int(0.975 * reps) - 1]


def within(spent, budget):
    """Solved within a budget: any spend within none; an unrecorded spend within no finite one."""
    return budget is None or (spent is not None and spent <= budget)


def pct(a, b):
    return f"{a}/{b} ({a / b * 100:.1f}%)" if b else "—"


def quant(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return "—"
    return f"{statistics.median(xs):,.0f} / {xs[max(0, math.ceil(len(xs) * 0.9) - 1)]:,.0f} / {xs[-1]:,.0f}"


def main():
    manifests = {h: json.load(open(B / f"manifests/{h}.json")) for h in H if (B / f"manifests/{h}.json").exists()}
    reps = sorted({int(p.name[1:]) for p in (B / "results").glob("r*") if p.name[1:].isdigit()})
    data = {(rep, h): load(rep, h) for rep in reps for h in H}
    data = {k: v for k, v in data.items() if v}
    labels = json.load(open(B / "results/manual-labels.json")) if (B / "results/manual-labels.json").exists() else {}
    out = []
    w = out.append
    any_m = next(iter(manifests.values()), {})
    proto = any_m.get("protocol", {})
    w("# Polyglot harness benchmark — protocol v2\n")
    w(f"Track **{proto.get('track', '?')}**{' + feedback round (H2)' if proto.get('feedback_round') else ''} · "
      f"grading rules {', '.join(proto.get('grading_rules', []))} (the first is primary) · network rule `{proto.get('network_rule', '?')}` · "
      f"{proto.get('replicates', '?')} replicate(s) planned, {len(reps)} present.\n")
    w("Tasks, task text and grading are Aider's polyglot benchmark (225 exercises, its addendum, its test commands); the protocol is an "
      "agent's. The numbers are not comparable with Aider's leaderboard, which measures models under a different protocol.\n")

    w("## pass@1 and pass@2\n")
    w("| replicate | harness | rows | pass@1 official | pass@1 strict | pass@2 official | invalid |")
    w("|---|---|---|---|---|---|---|")
    for (rep, h), rows in sorted(data.items()):
        rs = list(rows.values())
        n = len(rs)
        w(f"| r{rep} | {h} | {n} | {pct(sum(pass1(r) for r in rs), n)} | {pct(sum(pass1(r, True) for r in rs), n)} | "
          f"{pct(sum(pass2(r) for r in rs), n)} | {sum(1 for r in rs if r.get('invalid'))} |")

    w("\n## By language (pass@1 · pass@2 official / rows, first replicate present)\n")
    first = reps[0] if reps else None
    langs = sorted({i.split("/")[0] for (rep, h), rows in data.items() for i in rows})
    w("| harness | " + " | ".join(langs) + " |")
    w("|---|" + "---|" * len(langs))
    for h in H:
        rows = data.get((first, h))
        if not rows:
            continue
        cells = []
        for l in langs:
            rs = [r for i, r in rows.items() if i.startswith(l + "/")]
            cells.append(f"{sum(pass1(r) for r in rs)} · {sum(pass2(r) for r in rs)} / {len(rs)}" if rs else "—")
        w(f"| {h} | " + " | ".join(cells) + " |")

    w("\n## Paired comparisons (same instances, McNemar exact, bootstrap 95% CI of the difference)\n")
    w("| replicate | metric | A vs B | A only | B only | Δ pp [95% CI] | p |")
    w("|---|---|---|---|---|---|---|")
    for rep in reps:
        for metric, f in (("pass@1", pass1), ("pass@2", pass2)):
            for i, a in enumerate(H):
                for b in H[i + 1:]:
                    ra, rb = data.get((rep, a)), data.get((rep, b))
                    if not ra or not rb:
                        continue
                    keys = sorted(set(ra) & set(rb))
                    if not keys:
                        continue
                    da = [f(ra[k]) for k in keys]
                    db = [f(rb[k]) for k in keys]
                    only_a = sum(1 for x, y in zip(da, db) if x and not y)
                    only_b = sum(1 for x, y in zip(da, db) if y and not x)
                    diffs = [int(x) - int(y) for x, y in zip(da, db)]
                    lo, hi = boot(diffs)
                    w(f"| r{rep} | {metric} | {a} vs {b} ({len(keys)}) | {only_a} | {only_b} | "
                      f"{sum(diffs) / len(diffs) * 100:+.1f} [{lo * 100:+.1f}, {hi * 100:+.1f}] | {mcnemar(only_a, only_b):.4f} |")

    if len(reps) >= 2:
        w("\n## Agreement between replicates (pass@1 official)\n")
        w("| harness | instances in both | same verdict | Cohen's κ | first only | second only | McNemar p |")
        w("|---|---|---|---|---|---|---|")
        for h in H:
            r1, r2 = data.get((reps[0], h)), data.get((reps[1], h))
            if not r1 or not r2:
                continue
            keys = sorted(set(r1) & set(r2))
            a = [pass1(r1[k]) for k in keys]
            b = [pass1(r2[k]) for k in keys]
            n = len(keys)
            po = sum(x == y for x, y in zip(a, b)) / n
            pa, pb = sum(a) / n, sum(b) / n
            pe = pa * pb + (1 - pa) * (1 - pb)
            kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0
            only1 = sum(1 for x, y in zip(a, b) if x and not y)
            only2 = sum(1 for x, y in zip(a, b) if y and not x)
            w(f"| {h} | {n} | {po * 100:.1f}% | {kappa:.2f} | {only1} | {only2} | {mcnemar(only1, only2):.4f} |")

    w("\n## How the rows that did not pass ended (pass@1 official)\n")
    w("False completion: the agent ended the task as done and the grade failed. Protocol error: the harness ended the task "
      "because the model's output could not be run as actions. Label rows in results/manual-labels.json "
      "(`{\"<harness> <instance>\": \"spec ambiguity\" | \"wrong answer\"}`) to split them.\n")
    for (rep, h), rows in sorted(data.items()):
        kinds = collections.Counter(failure_type(r, labels, h) for r in rows.values() if not pass1(r))
        w(f"- r{rep} {h}: " + (", ".join(f"{k} {v}" for k, v in kinds.most_common()) or "none"))
        for r in rows.values():
            if r.get("invalid"):
                w(f"  - invalid: {r['instanceId']} — {r['invalid']}")

    w("\n## Cost (p50 / p90 / max)\n")
    w("| replicate | harness | requests per task | prompt tokens per task | completion tokens per task | wall s per task | "
      "requests per success | completion tokens per success | wall s per success |")
    w("|---|---|---|---|---|---|---|---|---|")
    costs = {}
    for (rep, h), rows in sorted(data.items()):
        per = {i: cost(h, r) for i, r in rows.items()}
        costs[(rep, h)] = per
        succ = [i for i, r in rows.items() if pass1(r)]
        wall = {i: (r.get("wallMs") or 0) / 1000 for i, r in rows.items()}
        w(f"| r{rep} | {h} | {quant(p[0] for p in per.values())} | {quant(p[1] for p in per.values())} | "
          f"{quant(p[2] for p in per.values())} | {quant(wall.values())} | "
          f"{quant(per[i][0] for i in succ)} | {quant(per[i][2] for i in succ)} | {quant(wall[i] for i in succ)} |")

    w("\n## Pass rate by budget (pass@1 official: solved within the budget)\n")
    header = ["completion tokens ≤ " + (f"{b // 1000}k" if b else "∞") for b in TOKEN_BUDGETS]
    w("| replicate | harness | " + " | ".join(header) + " |")
    w("|---|---|" + "---|" * len(header))
    for (rep, h), rows in sorted(data.items()):
        cells = []
        for b in TOKEN_BUDGETS:
            n = sum(1 for i, r in rows.items() if pass1(r) and within(costs[(rep, h)][i][2], b))
            cells.append(f"{n / len(rows) * 100:.1f}%")
        w(f"| r{rep} | {h} | " + " | ".join(cells) + " |")
    header = ["requests ≤ " + (str(b) if b else "∞") for b in STEP_BUDGETS]
    w("\n| replicate | harness | " + " | ".join(header) + " |")
    w("|---|---|" + "---|" * len(header))
    for (rep, h), rows in sorted(data.items()):
        cells = []
        for b in STEP_BUDGETS:
            n = sum(1 for i, r in rows.items() if pass1(r) and within(costs[(rep, h)][i][0], b))
            cells.append(f"{n / len(rows) * 100:.1f}%")
        w(f"| r{rep} | {h} | " + " | ".join(cells) + " |")

    w("\n## Harness Cards\n")
    cards = json.load(open(B / "harness-cards.json")) if (B / "harness-cards.json").exists() else {}
    for h in H:
        m = manifests.get(h)
        card = cards.get(h, {})
        if not m and not card:
            continue
        w(f"### {m['harness']['name'] if m else h}\n")
        if m:
            bud = m["budgets"]
            w(f"- Budgets (manifest): output cap {m['sampling']['max_output_tokens_per_step']} tokens per step; "
              f"{'no wall clock, safety cap ' + str(bud.get('safety_cap_seconds')) + ' s' if bud['task_wall_timeout_seconds'] is None else str(bud['task_wall_timeout_seconds']) + ' s wall'}; "
              f"{'turn limit ' + str(bud['max_turns']) if h == 'motifcode' else 'no turn limit (the harness has none)'}; "
              f"grading {bud['command_timeout_seconds']} s per test run.")
        for layer in ("execution", "tools", "context", "scheduling", "observability", "verification", "governance"):
            if layer in card:
                w(f"- {layer.capitalize()}: {card[layer]}")
        w("")

    w("## Comparison with the 2026-09-20 campaign\n")
    w("A different protocol, compared only as that: 213 of the 225 exercises; the graded tests in the agent's directory, "
      "most of them switched off in four languages; a 15-minute wall clock per task and 120 s per test run; grading on the "
      "first test in JavaScript, Java, C++ and Rust, C++ compiled with `g++` without warning flags; Codex without an "
      "output cap; the task text without `introduction.md`; one run.\n")
    campaign = os.environ.get("CAMPAIGN_RESULTS")
    if campaign:
        w("| harness | campaign passes (its grading) | this run, pass@1 official, same instances | campaign only | this run only | this run, all rows |")
        w("|---|---|---|---|---|---|")
        for h in H:
            old = load(None, h, pathlib.Path(campaign) / h)
            new = data.get((first, h))
            if not old or not new:
                continue
            keys = sorted(set(old) & set(new))
            po = [ok(old[k].get("grade")) for k in keys]
            pn = [pass1(new[k]) for k in keys]
            w(f"| {h} | {pct(sum(po), len(keys))} | {pct(sum(pn), len(keys))} | "
              f"{sum(1 for x, y in zip(po, pn) if x and not y)} | {sum(1 for x, y in zip(po, pn) if y and not x)} | "
              f"{pct(sum(pass1(r) for r in new.values()), len(new))} |")
    else:
        w("| harness | campaign passes (its grading, ../REPORT.md) | this run, pass@1 official |")
        w("|---|---|---|")
        for h in H:
            new = data.get((first, h))
            if new:
                w(f"| {h} | {pct(CAMPAIGN_RECORDED[h], 213)} | {pct(sum(pass1(r) for r in new.values()), len(new))} |")
        w("\nSet CAMPAIGN_RESULTS to that campaign's results/ directory for the same instances side by side.")
    w("\nAider's leaderboard measures a model with Aider's own harness (track A, not run here); nothing in this report is "
      "comparable with it.")
    target = B / "REPORT-v2.md"
    target.write_text("\n".join(out) + "\n")
    print(f"wrote {target}")


if __name__ == "__main__":
    sys.exit(main())
