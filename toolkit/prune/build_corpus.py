#!/usr/bin/env python3
"""Build a calibration corpus out of real repositories.

The profiler measures routing on whatever the model is shown, so the corpus has
to look like what the harness sends: the system prompt, the tools block, the
role markers, tool-call syntax, tool output and the repair turns. Raw source
files do not, and that is what the earlier plan profiled.

What this produces is honest about what it is. The *content* is real — actual
files, actual `rg` output, actual test output, actual diffs — and the *task
structure* around it is constructed. It is a pilot corpus, and the manifest says
so. The production corpus should come from graded motifcode sessions via
`motif distil --format trajectory-jsonl`, which needs a served model first;
this exists so the profiler has something faithful to run against before that
loop closes.

Two corpora, and they must differ in the way the criteria assume:

  target     agentic coding: repositories, searches, patches, test runs
  reference  general use: prose, reasoning, Korean, explanation without tools

The contrast between them is what `guard_reap` and `hybrid_share` read. Building
both from the same material would make the reference corpus a copy of the target
and every contrastive number meaningless.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
from pathlib import Path

from corpus import CorpusRecord, sha256_text

# Files worth showing a coding model, and sizes worth reading.
CODE_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".java", ".rb", ".sh", ".md"}
MIN_BYTES = 400
MAX_BYTES = 60_000


def run(command: list[str], cwd: Path) -> str:
    """A command's real output, capped. Failures are output too."""
    try:
        result = subprocess.run(
            command, cwd=cwd, capture_output=True, text=True, timeout=30, check=False
        )
        return (result.stdout + result.stderr)[:8000]
    except (subprocess.TimeoutExpired, OSError) as err:
        return f"{err}"


def code_files(repo: Path, limit: int, rng: random.Random) -> list[Path]:
    candidates = []
    for path in repo.rglob("*"):
        if not path.is_file() or path.suffix not in CODE_SUFFIXES:
            continue
        parts = set(path.parts)
        if parts & {".git", "node_modules", "dist", "build", "__pycache__", ".venv", "target"}:
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if MIN_BYTES <= size <= MAX_BYTES:
            candidates.append(path)
    rng.shuffle(candidates)
    return candidates[:limit]


def numbered(text: str, start: int = 1, limit: int | None = None) -> str:
    """Exactly the shape the `read` tool returns, line numbers and all."""
    lines = text.split("\n")
    end = len(lines) if limit is None else min(len(lines), start - 1 + limit)
    body = "\n".join(f"{i + 1}\t{lines[i]}" for i in range(start - 1, end))
    if end < len(lines):
        body += f"\n… {len(lines) - end} more lines"
    return body


def tool_call(name: str, arguments: dict) -> str:
    return f'<tool_call>{json.dumps({"name": name, "arguments": arguments})}</tool_call>'


TASK_TEMPLATES = [
    "Find where {symbol} is defined in this repository and explain what calls it.",
    "There is a bug in {path}: describe what the code does and where it could go wrong.",
    "Add a test for the behaviour implemented in {path}.",
    "Review {path} for correctness and report anything that would fail on an edge case.",
    "{path} needs a short docstring on each public function. Draft the change.",
    "Trace how a value flows through {path} from entry to return.",
    "{path}에서 하는 일을 설명하고, 고쳐야 할 부분이 있으면 알려줘.",
]


def build_coding_conversation(
    repo: Path, path: Path, system: str, rng: random.Random
) -> list[dict]:
    """One agentic-coding exchange, with real tool output in it.

    Tool turns carry a `tool_call_id` because the harness always sets one:
    `serializeObservation` fills it from the id the loop synthesised, and the
    template renders it into the `<tool_response>` envelope. A corpus without
    ids renders a prompt shorter than the real one at every tool boundary.
    """
    relative = path.relative_to(repo)
    text = path.read_text(encoding="utf-8", errors="replace")
    symbol = pick_symbol(text, rng) or relative.stem

    calls = iter(f"root-c{n}" for n in range(1, 64))

    task = rng.choice(TASK_TEMPLATES).format(symbol=symbol, path=relative)
    search = run(["grep", "-rn", "--include=*" + path.suffix, symbol, "."], repo)
    head = numbered(text, 1, 80)

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": task},
        {
            "role": "assistant",
            "content": tool_call("bash", {"command": f"rg -n {symbol!r} ."}),
            "reasoning_content": (
                f"Before changing anything I need to know where {symbol} lives and who calls it. "
                f"One search is cheaper than reading files one at a time, and every extra tool "
                f"call is another chance to malform an argument."
            ),
        },
        {"role": "tool", "tool_call_id": next(calls), "content": search or "(no matches)"},
        {
            "role": "assistant",
            "content": tool_call("read", {"path": str(relative), "limit": 80}),
            "reasoning_content": (
                f"{relative} is where the definition is. Reading the top of it before deciding "
                f"anything."
            ),
        },
        {"role": "tool", "tool_call_id": next(calls), "content": head},
    ]

    # A repair turn on some conversations. The harness emits these on tool
    # failure, so a corpus without any is missing a shape the model sees often.
    if rng.random() < 0.35:
        messages += [
            {
                "role": "assistant",
                "content": tool_call("bash", {"command": f"python3 -m pytest {relative.parent} -x -q"}),
                "reasoning_content": "Running the tests near this file before editing.",
            },
            {"role": "tool", "tool_call_id": next(calls), "content": "no tests ran\n(exit 5)"},
            {
                "role": "user",
                "content": (
                    "The command above failed. Read its output carefully, identify the specific "
                    "cause, and fix it. Do not repeat the same command unchanged."
                ),
            },
            {
                "role": "assistant",
                "content": tool_call("bash", {"command": "ls"}),
                "reasoning_content": (
                    "Exit 5 from pytest means it collected nothing, not that anything failed. "
                    "Wrong directory; looking at what is actually here."
                ),
            },
            {"role": "tool", "tool_call_id": next(calls), "content": run(["ls"], repo)},
        ]

    summary = f"Located {symbol} in {relative} and reported what calls it."
    messages += [
        {
            "role": "assistant",
            "content": tool_call("done", {"summary": summary}),
            "reasoning_content": "That answers the question; nothing here needs editing.",
        },
        {
            "role": "user",
            "content": (
                "Before this counts as finished: is the task actually complete? Ending the "
                "session means no further changes are possible.\n\nYou proposed this summary:\n\n"
                f"{summary}\n\nIf that is right, call `done` again with the same `summary` and "
                "`confirm: true`. If not, keep working — take the next action instead."
            ),
        },
        {
            "role": "assistant",
            "content": tool_call("done", {"summary": summary, "confirm": True}),
        },
    ]
    return messages


def pick_symbol(text: str, rng: random.Random) -> str | None:
    """A defined name from the file, so the search finds something."""
    import re

    names = re.findall(r"^\s*(?:def|class|function|func|fn|export function)\s+([A-Za-z_]\w{3,})", text, re.M)
    return rng.choice(names) if names else None


REFERENCE_PROMPTS = [
    ("Explain the difference between a mutex and a semaphore, with an example of when each is wrong.", "en"),
    ("What makes a scientific result reproducible, and why is that harder than it sounds?", "en"),
    ("Summarise the argument for and against rent control in three paragraphs.", "en"),
    ("트랜스포머에서 어텐션이 하는 일을 비전공자에게 설명해줘.", "ko"),
    ("한국어와 영어의 어순 차이가 번역에 어떤 문제를 만드는지 설명해줘.", "ko"),
    ("이 문장을 자연스러운 한국어로 다듬어줘: 본 연구는 해당 문제에 대한 해결책을 제시하고자 한다.", "ko"),
    ("Why does the Monty Hall answer feel wrong, and what changes if the host opens a door at random?", "en"),
    ("Walk through the reasoning: a train leaves at 3pm at 60 km/h, another at 4pm at 80 km/h.", "en"),
    ("Describe the water cycle to a ten-year-old, then to a hydrologist.", "en"),
    ("좋은 회고(retrospective)의 조건은 무엇이고, 흔한 실패 유형은 무엇인가?", "ko"),
]

REFERENCE_ANSWER = (
    "A mutex has an owner and a semaphore has a count, and that difference decides which one is "
    "wrong for a given problem. A mutex protects a resource that exactly one thread may touch at "
    "a time; because it has an owner, it can support priority inheritance and it can notice when "
    "the wrong thread tries to release it. A semaphore counts permits and has no owner, so it "
    "suits a pool of interchangeable resources — a connection pool, a bounded queue — and it can "
    "be signalled from a thread that never waited on it, which is exactly what makes it useful "
    "for producer-consumer handoff and exactly what makes it a poor lock.\n\n"
    "The failure mode of using a semaphore as a lock is that nothing enforces the pairing: any "
    "thread may post, so a bug that posts twice quietly raises the permit count and two threads "
    "enter the critical section. The failure mode of using a mutex as a signal is worse in a "
    "different way — many implementations make unlocking from another thread undefined behaviour."
)


def build_reference_conversation(system: str, prompt: str, rng: random.Random) -> list[dict]:
    """General use: no tools, longer prose, and often not English.

    Deliberately unlike the target corpus. If the reference looked like the
    target, every contrastive criterion would be reading noise.
    """
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
        {
            "role": "assistant",
            "content": REFERENCE_ANSWER if rng.random() < 0.5 else prompt + "\n\n" + REFERENCE_ANSWER,
            "reasoning_content": (
                "The question asks for a distinction, so the answer should lead with the "
                "distinction and then show what each choice costs when it is the wrong one."
            ),
        },
    ]


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--spec", type=Path, required=True, help="`motif corpus-spec` output")
    ap.add_argument("--repo", type=Path, action="append", default=[], help="repository to draw from")
    ap.add_argument("--kind", choices=["target", "reference"], required=True)
    ap.add_argument("--count", type=int, default=200)
    ap.add_argument("--split", default="calibration")
    ap.add_argument("--seed", type=int, default=17)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    spec = json.loads(args.spec.read_text())
    system = spec["system"]
    tools_sha = spec["toolSchemaSha256"]
    rng = random.Random(args.seed)

    # The template hash travels with the corpus so a profile taken against a
    # different chat template is refused rather than quietly compared.
    template_sha = spec.get("templateSha256", "unrecorded")

    records: list[CorpusRecord] = []
    if args.kind == "target":
        if not args.repo:
            raise SystemExit("--kind target needs at least one --repo")
        per_repo = max(1, args.count // len(args.repo))
        for repo in args.repo:
            repo = repo.resolve()
            for path in code_files(repo, per_repo, rng):
                messages = build_coding_conversation(repo, path, system, rng)
                body = "\n".join(str(m.get("content", "")) for m in messages)
                records.append(
                    CorpusRecord(
                        sample_id=f"code-{hashlib.sha256(str(path).encode()).hexdigest()[:16]}",
                        source=f"repo:{repo.name}",
                        source_revision=run(["git", "rev-parse", "HEAD"], repo).strip()[:40] or "unversioned",
                        split=args.split,
                        messages=messages,
                        tools_sha256=tools_sha,
                        template_sha256=template_sha,
                        rendered_sha256=sha256_text(body),
                        license="see the source repository",
                        repo=repo.name,
                    )
                )
    else:
        for i in range(args.count):
            prompt, language = REFERENCE_PROMPTS[i % len(REFERENCE_PROMPTS)]
            messages = build_reference_conversation(system, prompt, rng)
            body = "\n".join(str(m.get("content", "")) for m in messages)
            records.append(
                CorpusRecord(
                    sample_id=f"general-{i:05d}",
                    source=f"authored:{language}",
                    source_revision="pilot-v1",
                    split=args.split,
                    messages=messages,
                    tools_sha256=tools_sha,
                    template_sha256=template_sha,
                    rendered_sha256=sha256_text(body),
                    license="written for this repository",
                )
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record.to_json(), ensure_ascii=False) + "\n")
    print(f"{len(records)} record(s) -> {args.out}")


if __name__ == "__main__":
    main()
