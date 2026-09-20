#!/usr/bin/env python3
"""Write the three campaign manifests from instances.json and corpus-spec.json.

Wraps toolkit/campaign/make_manifest.py (which measures every hash it records) and then pins what the
campaign used: 16,384 output tokens per step, one seed, 40 turns, a 900 s wall cap; for Codex and OpenCode the
harness fields hash the adapter script and its pristine config so the record identifies what ran.
"""
import hashlib, json, os, pathlib, subprocess, sys

B = pathlib.Path(os.environ.get("BENCH") or pathlib.Path(__file__).resolve().parent)
REPO = pathlib.Path(os.environ.get("MOTIFCODE_REPO") or B.parents[2])
SUITE_JS = REPO / "packages/cli/dist/motif-suite.js"
MOTIF_JS = REPO / "packages/cli/dist/motif.js"
POLYGLOT = pathlib.Path(os.environ.get("POLYGLOT") or B / "polyglot-benchmark")
(B / "manifests").mkdir(exist_ok=True)

if not (B / "instances.json").exists():
    sys.exit("instances.json is missing: run ./verify.sh first")
if not (B / "corpus-spec.json").exists():
    (B / "corpus-spec.json").write_text(subprocess.run(["node", str(MOTIF_JS), "corpus-spec"], capture_output=True, text=True, check=True).stdout)
sha = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()

for h in ("motifcode", "codex", "opencode"):
    out = B / f"manifests/{h}.json"
    subprocess.run([sys.executable, str(REPO / "toolkit/campaign/make_manifest.py"),
                    "--instances", str(B / "instances.json"), "--corpus-spec", str(B / "corpus-spec.json"),
                    "--benchmark", str(POLYGLOT), "--harness-git-sha", sha, "--config-id", h, "--model-id", "motif/motif-3",
                    "--manifest-id", f"polyglot-motif3-hosted-{h}", "--channel", "toolcall", "--seeds", "0",
                    "--max-turns", "40", "--task-timeout", "900", "--out", str(out)], check=True, capture_output=True)
    m = json.loads(out.read_text())
    m["sampling"]["max_output_tokens_per_step"] = 16384
    if h != "motifcode":
        adapter = (B / f"adapters/{h}.sh").read_text()
        cfg = (B / "homes/codex/config.pristine.toml").read_text() if h == "codex" else (B / "homes/opencode/config/opencode/opencode.json").read_text()
        m["harness"]["name"] = h
        m["harness"]["system_prompt_sha256"] = hashlib.sha256(adapter.encode()).hexdigest()
        m["harness"]["tool_schema_sha256"] = hashlib.sha256(cfg.encode()).hexdigest()
        m["harness"]["features"] = {"tool_failure_repair": False, "benchmark_one_repair": False, "subagents": True, "hooks": False}
    out.write_text(json.dumps(m, indent=2) + "\n")
    print(f"wrote {out.relative_to(B)}: max_turns {m['budgets']['max_turns']}, timeout {m['budgets']['task_wall_timeout_seconds']} s, {m['sampling']['max_output_tokens_per_step']} tokens/step, seeds {m['sampling']['seeds']}")
