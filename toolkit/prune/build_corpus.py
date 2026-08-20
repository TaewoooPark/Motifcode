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


# Tasks in both languages the harness has to serve. A conversation is in one
# language throughout — question, reasoning and summary — because a Korean
# question answered with English reasoning is neither, and the routing it
# produces describes neither.
TASK_TEMPLATES = {
    "en": [
        "Find where {symbol} is defined in this repository and explain what calls it.",
        "There is a bug in {path}: describe what the code does and where it could go wrong.",
        "Add a test for the behaviour implemented in {path}.",
        "Review {path} for correctness and report anything that would fail on an edge case.",
        "{path} needs a short docstring on each public function. Draft the change.",
        "Trace how a value flows through {path} from entry to return.",
        "Why might {symbol} behave differently on a second call? Check {path}.",
    ],
    "ko": [
        "{path}에서 {symbol}이 어디에 정의돼 있고 누가 호출하는지 찾아서 설명해줘.",
        "{path}에 버그가 있는 것 같아. 이 코드가 무슨 일을 하는지, 어디서 잘못될 수 있는지 알려줘.",
        "{path}에 구현된 동작에 대한 테스트를 추가해줘.",
        "{path}를 검토하고 경계 조건에서 실패할 만한 부분이 있으면 알려줘.",
        "{path}의 공개 함수마다 짧은 설명을 붙이려고 해. 어떻게 바꿀지 초안을 잡아줘.",
        "{path}에서 값이 진입부터 반환까지 어떻게 흘러가는지 따라가줘.",
        "{symbol}을 두 번째로 호출하면 결과가 달라질 수 있을까? {path} 확인해줘.",
    ],
}

# What the assistant thinks between actions, per language. The reasoning is a
# large share of a coding session's tokens, so leaving it in one language while
# the user writes in another biases the profile toward that language.
REASONING = {
    "en": {
        "search": (
            "Before changing anything I need to know where {symbol} lives and who calls it. "
            "One search is cheaper than reading files one at a time, and every extra tool call "
            "is another chance to malform an argument."
        ),
        "read": "{path} is where the definition is. Reading the top of it before deciding anything.",
        "test": "Running the tests near this file before editing.",
        "repair": (
            "Exit 5 from pytest means it collected nothing, not that anything failed. "
            "Wrong directory; looking at what is actually here."
        ),
        "done": "That answers the question; nothing here needs editing.",
    },
    "ko": {
        "search": (
            "뭔가 고치기 전에 {symbol}이 어디 있고 누가 쓰는지부터 알아야 한다. "
            "파일을 하나씩 열어보는 것보다 검색 한 번이 싸고, 도구 호출이 늘어날수록 "
            "인자를 잘못 만들 위험도 같이 늘어난다."
        ),
        "read": "정의는 {path}에 있다. 판단하기 전에 앞부분부터 읽는다.",
        "test": "고치기 전에 이 파일 근처 테스트를 먼저 돌려본다.",
        "repair": (
            "pytest의 종료 코드 5는 실패가 아니라 수집된 테스트가 없다는 뜻이다. "
            "디렉터리를 잘못 잡았으니 여기에 실제로 뭐가 있는지부터 본다."
        ),
        "done": "질문에는 답이 됐고, 여기서 고칠 것은 없다.",
    },
}

REPAIR_TURN = {
    "en": (
        "The command above failed. Read its output carefully, identify the specific cause, "
        "and fix it. Do not repeat the same command unchanged."
    ),
    "ko": (
        "위 명령이 실패했다. 출력을 잘 읽고 원인을 정확히 짚은 다음 고쳐라. "
        "같은 명령을 그대로 다시 실행하지 마라."
    ),
}

SUMMARY = {
    "en": "Located {symbol} in {path} and reported what calls it.",
    "ko": "{path}에서 {symbol}을 찾아 어디서 호출되는지 정리했다.",
}

# The harness's own confirmation turn, which every session ends with, in both
# languages. `motif` emits the English one; the Korean is what a Korean-language
# session looks like around the same protocol.
CONFIRM_TURN = {
    "en": (
        "Before this counts as finished: is the task actually complete? Ending the session "
        "means no further changes are possible.\n\nYou proposed this summary:\n\n{summary}\n\n"
        "If that is right, call `done` again with the same `summary` and `confirm: true`. "
        "If not, keep working — take the next action instead."
    ),
    "ko": (
        "끝내기 전에 확인한다. 작업이 정말 끝났나? 세션을 종료하면 더 이상 수정할 수 없다."
        "\n\n제안한 요약은 다음과 같다:\n\n{summary}\n\n맞다면 같은 `summary`에 "
        "`confirm: true`를 붙여 `done`을 다시 호출하고, 아니라면 계속 작업해라."
    ),
}


def build_coding_conversation(
    repo: Path, path: Path, system: str, rng: random.Random, lang: str
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
    say = REASONING[lang]
    calls = iter(f"root-c{n}" for n in range(1, 64))

    task = rng.choice(TASK_TEMPLATES[lang]).format(symbol=symbol, path=relative)
    search = run(["grep", "-rn", "--include=*" + path.suffix, symbol, "."], repo)
    head = numbered(text, 1, 80)

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": task},
        {
            "role": "assistant",
            "content": tool_call("bash", {"command": f"rg -n {symbol!r} ."}),
            "reasoning_content": say["search"].format(symbol=symbol, path=relative),
        },
        {"role": "tool", "tool_call_id": next(calls), "content": search or "(no matches)"},
        {
            "role": "assistant",
            "content": tool_call("read", {"path": str(relative), "limit": 80}),
            "reasoning_content": say["read"].format(symbol=symbol, path=relative),
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
                "reasoning_content": say["test"],
            },
            {"role": "tool", "tool_call_id": next(calls), "content": "no tests ran\n(exit 5)"},
            {"role": "user", "content": REPAIR_TURN[lang]},
            {
                "role": "assistant",
                "content": tool_call("bash", {"command": "ls"}),
                "reasoning_content": say["repair"],
            },
            {"role": "tool", "tool_call_id": next(calls), "content": run(["ls"], repo)},
        ]

    summary = SUMMARY[lang].format(symbol=symbol, path=relative)
    messages += [
        {
            "role": "assistant",
            "content": tool_call("done", {"summary": summary}),
            "reasoning_content": say["done"],
        },
        {"role": "user", "content": CONFIRM_TURN[lang].format(summary=summary)},
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


# How a general-use question gets asked, per language. The article's title
# fills the slot, so a thousand records ask a thousand different questions.
REFERENCE_ASKS = {
    "en": [
        "Explain {title} to someone who has never encountered it.",
        "What is {title}, and what do people most often get wrong about it?",
        "Give me a clear account of {title} and why it matters.",
        "Summarise {title}, then say what a reader should take away.",
        "I keep seeing {title} referenced. What is it?",
    ],
    "ko": [
        "{title}에 대해 처음 듣는 사람에게 설명하듯이 알려줘.",
        "{title}이 뭐고, 사람들이 흔히 오해하는 부분은 뭐야?",
        "{title}을 정리해서 설명하고, 왜 중요한지도 알려줘.",
        "{title}에 대해 요약해주고 핵심만 짚어줘.",
        "{title}이라는 말을 자꾸 보는데 무슨 뜻이야?",
    ],
}

REFERENCE_THINKING = {
    "en": (
        "The question asks for an explanation rather than a task, so there is nothing to run "
        "and nothing to change. Lead with what the thing is, then what follows from it."
    ),
    "ko": (
        "실행할 것도 고칠 것도 없는, 설명을 요구하는 질문이다. "
        "먼저 그게 무엇인지 밝히고, 거기서 따라 나오는 것을 이어서 쓴다."
    ),
}


def load_prose(path: Path) -> list[dict]:
    """Real articles, one per record, in the language they were written in.

    The reference corpus is the control the contrastive criteria read: it says
    what the experts do when the model is *not* driving tools. That only works
    if the records differ from each other. An earlier version answered every
    prompt with the same fixed essay, which made a corpus of one document
    repeated a hundred times — and every contrast computed against it was a
    contrast with a single sample.

    Both languages are present because the harness has to serve both. A
    reference corpus in English alone would mark the experts that carry Korean
    as unused, and the pruning would then remove them on the evidence.
    """
    records = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    if not records:
        raise SystemExit(f"{path} is empty; --kind reference needs prose to draw from")
    return records


def build_reference_conversation(system: str, article: dict, rng: random.Random) -> list[dict]:
    """General use: no tools, longer prose, and half of it not in English.

    Deliberately unlike the target corpus. If the reference looked like the
    target, every contrastive criterion would be reading noise.
    """
    lang = article["lang"]
    ask = rng.choice(REFERENCE_ASKS[lang]).format(title=article["title"])
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": ask},
        {
            "role": "assistant",
            "content": article["text"],
            "reasoning_content": REFERENCE_THINKING[lang],
        },
    ]


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--spec", type=Path, required=True, help="`motif corpus-spec` output")
    ap.add_argument("--repo", type=Path, action="append", default=[], help="repository to draw from")
    ap.add_argument("--prose", type=Path, help="JSONL of {lang, title, text}, for --kind reference")
    ap.add_argument(
        "--korean-share",
        type=float,
        default=0.35,
        help=(
            "fraction of target conversations conducted in Korean. The harness has to serve "
            "both languages, and experts that only ever see English look unused"
        ),
    )
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
        # Round-robin rather than an equal split. An equal split caps the whole
        # corpus at (smallest repo x number of repos): asking for 1000 records
        # from a large repository and an 89-file one produced 589, silently,
        # and the shortfall looked like a corpus that was simply that size.
        pools = []
        for repo in args.repo:
            repo = repo.resolve()
            pools.append((repo, code_files(repo, args.count, rng)))
        revisions = {
            repo: run(["git", "rev-parse", "HEAD"], repo).strip()[:40] or "unversioned"
            for repo, _ in pools
        }
        chosen: list[tuple[Path, Path]] = []
        cursor = 0
        while len(chosen) < args.count and any(cursor < len(files) for _, files in pools):
            for repo, files in pools:
                if cursor < len(files) and len(chosen) < args.count:
                    chosen.append((repo, files[cursor]))
            cursor += 1

        for repo, path in chosen:
            lang = "ko" if rng.random() < args.korean_share else "en"
            messages = build_coding_conversation(repo, path, system, rng, lang)
            body = "\n".join(str(m.get("content", "")) for m in messages)
            records.append(
                CorpusRecord(
                    sample_id=f"code-{hashlib.sha256(str(path).encode()).hexdigest()[:16]}",
                    source=f"repo:{repo.name}:{lang}",
                    source_revision=revisions[repo],
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
        if not args.prose:
            raise SystemExit("--kind reference needs --prose; see toolkit/prune/README for how it is built")
        articles = load_prose(args.prose)
        rng.shuffle(articles)
        for i, article in enumerate(articles[: args.count]):
            messages = build_reference_conversation(system, article, rng)
            body = "\n".join(str(m.get("content", "")) for m in messages)
            records.append(
                CorpusRecord(
                    sample_id=f"general-{hashlib.sha256(article['title'].encode()).hexdigest()[:16]}",
                    source=f"wikipedia:{article['lang']}",
                    source_revision="20231101",
                    split=args.split,
                    messages=messages,
                    tools_sha256=tools_sha,
                    template_sha256=template_sha,
                    rendered_sha256=sha256_text(body),
                    license="CC BY-SA 4.0 (Wikipedia)",
                )
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record.to_json(), ensure_ascii=False) + "\n")
    print(f"{len(records)} record(s) -> {args.out}")


if __name__ == "__main__":
    main()
