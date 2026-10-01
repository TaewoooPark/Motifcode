#!/usr/bin/env python3
"""Write a campaign manifest per harness in HARNESSES (env.sh) from instances.json.

Protocol v2 (the polyglot harness benchmark): Aider's 225 tasks, task text and grading; track H (graded tests hidden)
unless TRACK=V; a feedback round (H2) unless FEEDBACK_ROUND=0; no wall-clock budget per task, a 6-hour safety cap
for a wedged process; Aider's 180 s per test run; the same 16,384-token output cap for every harness (the endpoint
ends reasoning at three quarters of it); 100 turns for motifcode, the only harness with a turn limit; two replicates
(REPLICATES).

Wraps toolkit/campaign/make_manifest.py, which measures every hash it records. A motifcode build's system prompt and
tool schemas are its own corpus spec, generated as a row sees it: an empty home, and one directory for every build
(the system prompt names its working directory). This repository's build is named by its version, with the commit in
harness.source; a release (motifcode-<version>) by its version, with the commit it was published from and what
install_harnesses.sh verified. For Codex and OpenCode the harness fields hash the adapter script and its pristine
config, and the name carries the CLI version.
"""
import hashlib, json, os, pathlib, re, subprocess, sys, tempfile

B = pathlib.Path(os.environ.get("BENCH") or pathlib.Path(__file__).resolve().parent)
REPO = pathlib.Path(os.environ.get("MOTIFCODE_REPO") or B.parents[2])
MOTIF_JS = REPO / "packages/cli/dist/motif.js"
POLYGLOT = pathlib.Path(os.environ.get("POLYGLOT") or B / "polyglot-benchmark")
TRACK = os.environ.get("TRACK", "H")
FEEDBACK = os.environ.get("FEEDBACK_ROUND", "1") != "0"
REPLICATES = os.environ.get("REPLICATES", "2")
OUTPUT_CAP = os.environ.get("OUTPUT_CAP", "16384")
(B / "manifests").mkdir(exist_ok=True)


def harnesses():
    """HARNESSES from the environment, else env.sh's default."""
    if os.environ.get("HARNESSES"):
        return os.environ["HARNESSES"].split()
    return re.search(r'HARNESSES="\$\{HARNESSES:-([^}"]*)\}"', (B / "env.sh").read_text()).group(1).split()


if TRACK not in ("H", "V"):
    sys.exit("TRACK must be H or V")
if not (B / "instances.json").exists():
    sys.exit("instances.json is missing: run ./verify.sh first")
built = {i.get("track", "H") for i in json.loads((B / "instances.json").read_text())}
if built != {TRACK}:
    sys.exit(f"instances.json was built for track {sorted(built)}, not {TRACK}: run TRACK={TRACK} ./verify.sh")
sha = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()


def version(cmd):
    """The first version number a CLI prints for --version."""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        m = re.search(r"\d+\.\d+\.\d+[\w.+-]*", out.stdout + out.stderr)
        return m.group(0) if m else "unknown"
    except Exception:
        return "unknown"


def corpus_spec(js, name):
    """A motif build's corpus spec, generated in B with an empty home."""
    out = B / f"corpus-spec{'' if name == 'motifcode' else '-' + name}.json"
    with tempfile.TemporaryDirectory() as home:
        text = subprocess.run(["node", str(js), "corpus-spec"], cwd=B, env={**os.environ, "HOME": home},
                              capture_output=True, text=True, check=True).stdout
    out.write_text(text)
    return out


for h in harnesses():
    source = None
    if h == "motifcode":
        spec, commit = corpus_spec(MOTIF_JS, h), sha
        name = f"motifcode {json.loads((REPO / 'packages/cli/package.json').read_text())['version']}"
        source = f"this repository at {sha}"
    elif h.startswith("motifcode-"):
        identity = B / f"harnesses/{h}/identity.json"
        if not identity.exists():
            sys.exit(f"{h} is not installed: run ./install_harnesses.sh")
        ident = json.loads(identity.read_text())
        task, feedback = ident["task_round"], ident["feedback_round"]
        spec = corpus_spec(B / f"harnesses/{h}/release/node_modules/motifcode/dist/motif.js", h)
        commit, name = task["git_head"], f"motifcode {ident['version']}"
        source = (f"task round: npm {task['npm']} ({task['integrity']}), published from {task['git_head']}; "
                  f"feedback round: {feedback['tag']} with harnesses/{h}/continue-from.patch "
                  f"(sha256 {feedback['continue_patch_sha256']}), the release's system prompt and tool schemas")
    else:
        spec, commit = B / "corpus-spec.json", sha
        if not spec.exists():
            spec = corpus_spec(MOTIF_JS, "motifcode")
    out = B / f"manifests/{h}.json"
    subprocess.run([sys.executable, str(REPO / "toolkit/campaign/make_manifest.py"),
                    "--instances", str(B / "instances.json"), "--corpus-spec", str(spec),
                    "--benchmark", str(POLYGLOT), "--harness-git-sha", commit, "--config-id", h, "--model-id", "motif/motif-3",
                    "--manifest-id", f"polyglot-v2-{TRACK}-motif3-hosted-{h}", "--channel", "toolcall", "--seeds", "0",
                    "--max-turns", "100", "--task-timeout", "none", "--safety-cap", str(6 * 3600),
                    "--command-timeout", "180", "--max-output-tokens", OUTPUT_CAP, "--network", "enabled",
                    "--protocol-track", TRACK, *(["--feedback-round"] if FEEDBACK else []), "--replicates", REPLICATES,
                    "--out", str(out)], check=True, capture_output=True)
    m = json.loads(out.read_text())
    if h == "motifcode" or h.startswith("motifcode-"):
        m["harness"]["name"] = name
        m["harness"]["source"] = source
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
