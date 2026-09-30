#!/usr/bin/env python3
"""Write the three campaign manifests from instances.json and corpus-spec.json.

Protocol v2 (the polyglot harness benchmark): Aider's 225 tasks, task text and grading; track H (graded tests hidden)
unless TRACK=V; a feedback round (H2) unless FEEDBACK_ROUND=0; no wall-clock budget per task, a 6-hour safety cap
for a wedged process; Aider's 180 s per test run; the same 16,384-token output cap for all three harnesses
(the endpoint ends reasoning at three quarters of it); 100 turns for motifcode, which is the only one of the three
with a turn limit; two replicates (REPLICATES).

Wraps toolkit/campaign/make_manifest.py, which measures every hash it records. For Codex and OpenCode the harness
fields hash the adapter script and its pristine config, and the name carries the CLI version, so the record
identifies what ran.
"""
import hashlib, json, os, pathlib, re, subprocess, sys

B = pathlib.Path(os.environ.get("BENCH") or pathlib.Path(__file__).resolve().parent)
REPO = pathlib.Path(os.environ.get("MOTIFCODE_REPO") or B.parents[2])
MOTIF_JS = REPO / "packages/cli/dist/motif.js"
POLYGLOT = pathlib.Path(os.environ.get("POLYGLOT") or B / "polyglot-benchmark")
TRACK = os.environ.get("TRACK", "H")
FEEDBACK = os.environ.get("FEEDBACK_ROUND", "1") != "0"
REPLICATES = os.environ.get("REPLICATES", "2")
OUTPUT_CAP = os.environ.get("OUTPUT_CAP", "16384")
(B / "manifests").mkdir(exist_ok=True)

if TRACK not in ("H", "V"):
    sys.exit("TRACK must be H or V")
if not (B / "instances.json").exists():
    sys.exit("instances.json is missing: run ./verify.sh first")
built = {i.get("track", "H") for i in json.loads((B / "instances.json").read_text())}
if built != {TRACK}:
    sys.exit(f"instances.json was built for track {sorted(built)}, not {TRACK}: run TRACK={TRACK} ./verify.sh")
if not (B / "corpus-spec.json").exists():
    (B / "corpus-spec.json").write_text(subprocess.run(["node", str(MOTIF_JS), "corpus-spec"], capture_output=True, text=True, check=True).stdout)
sha = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()


def version(cmd):
    """The first version number a CLI prints for --version."""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        m = re.search(r"\d+\.\d+\.\d+[\w.+-]*", out.stdout + out.stderr)
        return m.group(0) if m else "unknown"
    except Exception:
        return "unknown"


for h in ("motifcode", "codex", "opencode"):
    out = B / f"manifests/{h}.json"
    subprocess.run([sys.executable, str(REPO / "toolkit/campaign/make_manifest.py"),
                    "--instances", str(B / "instances.json"), "--corpus-spec", str(B / "corpus-spec.json"),
                    "--benchmark", str(POLYGLOT), "--harness-git-sha", sha, "--config-id", h, "--model-id", "motif/motif-3",
                    "--manifest-id", f"polyglot-v2-{TRACK}-motif3-hosted-{h}", "--channel", "toolcall", "--seeds", "0",
                    "--max-turns", "100", "--task-timeout", "none", "--safety-cap", str(6 * 3600),
                    "--command-timeout", "180", "--max-output-tokens", OUTPUT_CAP, "--network", "enabled",
                    "--protocol-track", TRACK, *(["--feedback-round"] if FEEDBACK else []), "--replicates", REPLICATES,
                    "--out", str(out)], check=True, capture_output=True)
    m = json.loads(out.read_text())
    if h == "motifcode":
        m["harness"]["name"] = f"motifcode {json.loads((REPO / 'packages/cli/package.json').read_text())['version']}"
    else:
        adapter = (B / f"adapters/{h}.sh").read_text()
        cfg = (B / "homes/codex/config.pristine.toml").read_text() if h == "codex" else (B / "homes/opencode/config/opencode/opencode.json").read_text()
        m["harness"]["name"] = f"{h} {version([h, '--version'])}"
        m["harness"]["system_prompt_sha256"] = hashlib.sha256(adapter.encode()).hexdigest()
        m["harness"]["tool_schema_sha256"] = hashlib.sha256(cfg.encode()).hexdigest()
        m["harness"]["features"] = {"tool_failure_repair": False, "benchmark_one_repair": False, "subagents": True, "hooks": False}
    out.write_text(json.dumps(m, indent=2) + "\n")
    b = m["budgets"]
    print(f"wrote {out.relative_to(B)}: {m['harness']['name']}, track {m['protocol']['track']}"
          f"{' + feedback round' if m['protocol']['feedback_round'] else ''}, {m['protocol']['replicates']} replicates, "
          f"max_turns {b['max_turns']}, no wall clock (safety cap {b['safety_cap_seconds']} s), tests {b['command_timeout_seconds']} s, "
          f"{m['sampling']['max_output_tokens_per_step']} tokens/step")
