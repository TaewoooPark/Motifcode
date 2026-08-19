#!/usr/bin/env python3
"""Generate golden prompt renderings from Motif-3's real chat template.

The TypeScript renderer in `packages/protocol/src/template.ts` is only useful if
it is byte-identical to what the server produces. This script is the source of
truth for that claim: it renders a matrix of conversations through the actual
`chat_template.jinja` shipped with the model, using the same Jinja settings
transformers uses, and writes the results for `template.test.ts` to diff.

Run it whenever the template file changes:

    python3 toolkit/fixtures/gen_template_golden.py

Requires jinja2 only — no model weights, no GPU, no transformers. That is the
whole point: the most Motif-specific and most fragile part of this harness is
fully verifiable on a laptop.
"""

from __future__ import annotations

import json
from pathlib import Path

from jinja2 import BaseLoader, Environment

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "corpus" / "chat_template.jinja"
OUT = ROOT / "corpus" / "template-golden"


def make_env() -> Environment:
    """Match transformers' chat-template environment.

    Two settings matter and both were checked against transformers' source:
    `trim_blocks` / `lstrip_blocks` are on, and `tojson` is overridden with
    `ensure_ascii=False` so non-ASCII (Korean, in our case) stays raw.
    """
    env = Environment(loader=BaseLoader(), trim_blocks=True, lstrip_blocks=True)

    def tojson(x, ensure_ascii=False, indent=None, separators=None, sort_keys=False):
        return json.dumps(
            x,
            ensure_ascii=ensure_ascii,
            indent=indent,
            separators=separators,
            sort_keys=sort_keys,
        )

    env.filters["tojson"] = tojson
    return env


def tool(name: str, props: dict, description: str = "") -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description or f"{name} tool",
            "parameters": {
                "type": "object",
                "properties": props,
                "required": list(props),
                "additionalProperties": False,
            },
        },
    }


BASH = tool("bash", {"command": {"type": "string"}}, "Run a shell command")
READ = tool("read", {"path": {"type": "string"}}, "Read a file")
DONE = tool("done", {"summary": {"type": "string"}}, "Finish the task")

SYS = {"role": "system", "content": "You are motif-code."}
SYS_KO = {"role": "system", "content": "너는 motif-code다. 한국어로 답한다."}


def cases() -> dict[str, dict]:
    """The matrix. Each entry is kwargs for `template.render`."""
    return {
        # --- shape of the first turn -----------------------------------
        "bare_user": {
            "messages": [{"role": "user", "content": "hi"}],
            "add_generation_prompt": True,
        },
        "system_no_tools": {
            "messages": [SYS, {"role": "user", "content": "hi"}],
            "add_generation_prompt": True,
        },
        "system_with_tools": {
            "messages": [SYS, {"role": "user", "content": "hi"}],
            "tools": [BASH, READ, DONE],
            "add_generation_prompt": True,
        },
        "tools_no_system": {
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [BASH],
            "add_generation_prompt": True,
        },
        # --- non-ASCII, because ensure_ascii is a real trap -------------
        "korean_system_and_content": {
            "messages": [SYS_KO, {"role": "user", "content": "OHE 배경 제거가 안 먹어"}],
            "tools": [BASH],
            "add_generation_prompt": True,
        },
        # --- reasoning --------------------------------------------------
        "reasoning_intermediate_with_tools": {
            "messages": [
                SYS,
                {"role": "user", "content": "q1"},
                {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "AAA intermediate",
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": "bash", "arguments": {"command": "ls"}},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "c1", "content": "a.py"},
                {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "BBB last",
                    "tool_calls": [
                        {
                            "id": "c2",
                            "type": "function",
                            "function": {"name": "bash", "arguments": {"command": "cat a.py"}},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "c2", "content": "print(1)"},
                {"role": "user", "content": "q2"},
            ],
            "tools": [BASH],
            "add_generation_prompt": True,
        },
        "reasoning_intermediate_without_tools": {
            "messages": [
                SYS,
                {"role": "user", "content": "q1"},
                {"role": "assistant", "content": "", "reasoning_content": "AAA intermediate"},
                {"role": "user", "content": "q2"},
                {"role": "assistant", "content": "", "reasoning_content": "BBB last"},
                {"role": "user", "content": "q3"},
            ],
            "add_generation_prompt": True,
        },
        "reasoning_inline_think_tags": {
            "messages": [
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": "<think>inline reasoning</think>\nthe answer"},
                {"role": "user", "content": "q2"},
            ],
            "tools": [BASH],
            "add_generation_prompt": True,
        },
        # --- tool calls -------------------------------------------------
        "parallel_tool_calls": {
            "messages": [
                {"role": "user", "content": "q"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "p1",
                            "type": "function",
                            "function": {"name": "bash", "arguments": {"command": "a"}},
                        },
                        {
                            "id": "p2",
                            "type": "function",
                            "function": {"name": "bash", "arguments": {"command": "b"}},
                        },
                    ],
                },
                {"role": "tool", "tool_call_id": "p1", "content": "ra"},
                {"role": "tool", "tool_call_id": "p2", "content": "rb"},
                {"role": "user", "content": "q2"},
            ],
            "tools": [BASH],
            "add_generation_prompt": True,
        },
        "tool_call_arguments_as_string": {
            "messages": [
                {"role": "user", "content": "q"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "s1",
                            "type": "function",
                            "function": {
                                "name": "bash",
                                "arguments": '{"command": "echo \\"hi\\""}',
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "s1", "content": "hi"},
                {"role": "user", "content": "q2"},
            ],
            "tools": [BASH],
            "add_generation_prompt": True,
        },
        # --- generation prompt variants ---------------------------------
        "no_generation_prompt": {
            "messages": [SYS, {"role": "user", "content": "hi"}],
            "tools": [BASH],
            "add_generation_prompt": False,
        },
        "thinking_disabled": {
            "messages": [SYS, {"role": "user", "content": "hi"}],
            "tools": [BASH],
            "add_generation_prompt": True,
            "enable_thinking": False,
        },
        # --- mid-conversation system, references ------------------------
        "midstream_system": {
            "messages": [
                SYS,
                {"role": "user", "content": "a"},
                {"role": "system", "content": "new rule"},
                {"role": "user", "content": "b"},
            ],
            "tools": [BASH],
            "add_generation_prompt": True,
        },
        "user_references": {
            "messages": [{"role": "user", "content": "q", "references": "doc-1"}],
            "tools": [BASH],
            "add_generation_prompt": True,
        },
    }


def main() -> None:
    if not TEMPLATE.exists():
        raise SystemExit(f"missing template: {TEMPLATE}")
    env = make_env()
    tpl = env.from_string(TEMPLATE.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)

    bundle: dict[str, dict] = {}
    for name, kwargs in cases().items():
        bundle[name] = {"input": kwargs, "expected": tpl.render(**kwargs)}

    path = OUT / "cases.json"
    path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(bundle)} cases -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
