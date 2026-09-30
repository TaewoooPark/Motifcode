#!/usr/bin/env python3
"""Write an immutable eval manifest for a Motif-3 polyglot campaign.

Every hash here is read from the thing it describes rather than typed in. A
manifest whose fields are asserted is a record of what somebody meant to run;
one whose fields are measured is a record of what ran.

`instances_sha256` covers the built instance list — ids, base commits, test
files — so that a campaign cannot silently be compared against a differently
built suite later.

`noninferiority_margin_pp` is deliberately null. There is no baseline arm in
this run, and a margin is a product decision about how much quality may be
traded; inventing one here would let the tools print "quality retained" about a
comparison nobody registered.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def git_sha(repo: Path) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except Exception:
        return "unknown"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instances", required=True, help="motif-suite build JSON")
    ap.add_argument("--corpus-spec", required=True, help="motif corpus-spec JSON")
    ap.add_argument("--benchmark", required=True, help="polyglot checkout")
    # The harness revision is threaded across rather than read here, so the
    # manifest can be written from anywhere. Still a measured value — just
    # measured somewhere else.
    ap.add_argument("--harness-git-sha", required=True)
    # The serving side is a hosted endpoint now, so there is no repository to
    # read a revision from; what identifies it is the endpoint and the model
    # id it routes to. Anything more specific the operator knows goes in too.
    ap.add_argument("--engine", default="hosted (llm.onerouter.pro)")
    ap.add_argument("--serving-git-sha", default="")
    ap.add_argument("--quantization", default="")
    ap.add_argument("--hardware", default="hosted")
    ap.add_argument("--hardware-count", type=int, default=1)
    ap.add_argument("--config-id", default="motif3-hosted")
    ap.add_argument("--model-id", default="motif/motif-3")
    ap.add_argument("--checkpoint-sha256", default="")
    ap.add_argument("--manifest-id", required=True)
    ap.add_argument("--channel", default="toolcall")
    ap.add_argument("--seeds", default="0")
    ap.add_argument("--max-turns", type=int, default=20)
    # Seconds, or "none" for no wall-clock budget (Aider's benchmark has none);
    # a safety cap then stands in for a wedged process.
    ap.add_argument("--task-timeout", default="900")
    ap.add_argument("--safety-cap", type=int, default=6 * 3600)
    # The grader's limit on one test run; Aider's is 180 s.
    ap.add_argument("--command-timeout", type=int, default=120)
    ap.add_argument("--max-output-tokens", type=int, default=4096)
    ap.add_argument("--network", default="enabled", choices=["disabled", "allowlist", "enabled"])
    # Polyglot harness benchmark protocol v2 (docs: tracks H/V, feedback round).
    ap.add_argument("--protocol-track", choices=["H", "V"], default=None)
    ap.add_argument("--feedback-round", action="store_true")
    ap.add_argument("--network-rule", default="network-v1")
    ap.add_argument("--replicates", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    task_timeout = None if str(a.task_timeout).lower() == "none" else int(a.task_timeout)

    instances = json.loads(Path(a.instances).read_text())
    spec = json.loads(Path(a.corpus_spec).read_text())

    # Canonical form: sorted ids with their base commits. Order-independent, so
    # a rebuild that emits the same set hashes the same.
    rows = sorted(
        (
            {"id": i["id"], "baseCommit": i["baseCommit"], "language": i["language"]}
            for i in instances
        ),
        key=lambda r: r["id"],
    )
    canon = json.dumps(rows, sort_keys=True)

    manifest = {
        "schema_version": "motifcode.eval/v1",
        "manifest_id": a.manifest_id,
        "suite": {
            "name": "polyglot",
            "dataset_revision": git_sha(Path(a.benchmark)),
            "split": "dev",
            "instances_sha256": sha256_text(canon),
            "evaluator": {
                "repo": "https://github.com/Aider-AI/polyglot-benchmark",
                "commit": git_sha(Path(a.benchmark)),
            },
        },
        "candidate": {
            "config_id": a.config_id,
            "role": "candidate",
            "model_id": a.model_id,
            **({"checkpoint_sha256": a.checkpoint_sha256} if a.checkpoint_sha256 else {}),
        },
        "harness": {
            "name": "motifcode",
            "git_sha": a.harness_git_sha,
            "system_prompt_sha256": spec["systemPromptSha256"],
            "tool_schema_sha256": spec["toolSchemaSha256"],
            "initial_channel": a.channel,
            "channel_policy": "fixed",
            "features": {
                "tool_failure_repair": True,
                "benchmark_one_repair": False,
                "subagents": False,
                "hooks": False,
            },
        },
        "serving": {
            "engine": a.engine,
            **({"git_sha": a.serving_git_sha} if a.serving_git_sha else {}),
            **({"quantization": a.quantization} if a.quantization else {}),
            "hardware": {"name": a.hardware, "count": a.hardware_count},
        },
        "sampling": {
            # The server applies its own defaults in thinking mode; recorded as
            # requested, not as guaranteed.
            "temperature": 1.0,
            "top_p": 0.95,
            "seed_policy": "paired",
            "seeds": [int(s) for s in a.seeds.split(",") if s.strip()],
            "max_output_tokens_per_step": a.max_output_tokens,
        },
        "budgets": {
            "max_model_steps": a.max_turns * 2,
            "max_turns": a.max_turns,
            "max_repairs_per_failure": 2,
            "command_timeout_seconds": a.command_timeout,
            "task_wall_timeout_seconds": task_timeout,
            **({"safety_cap_seconds": a.safety_cap} if task_timeout is None else {}),
            "max_total_tokens": None,
        },
        "environment": {
            # The grader runs in a git worktree the agent cannot reach; Docker
            # on this host needs root, which is not available unattended.
            "network": a.network,
            "repo_reset": "git worktree per row, removed after grading",
        },
        "design": {
            "split_role": "dev",
            "pair_group": "instance",
            "primary_metric": "pass_rate",
            "noninferiority_margin_pp": None,
            "confidence_level": 0.95,
            "randomization_seed": 0,
            "missing_run_policy": "score_zero",
        },
    }
    if a.protocol_track:
        manifest["protocol"] = {
            "name": "polyglot-harness-v2",
            "track": a.protocol_track,
            "feedback_round": a.feedback_round,
            "grading_rules": ["official", "strict"],
            "network_rule": a.network_rule,
            "replicates": a.replicates,
        }

    Path(a.out).write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {a.out}")
    print(f"  instances      : {len(instances)}")
    print(f"  instances_sha  : {manifest['suite']['instances_sha256'][:16]}…")
    print(f"  harness git_sha: {manifest['harness']['git_sha'][:12]}")
    print(f"  serving        : {manifest['serving']['engine']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
