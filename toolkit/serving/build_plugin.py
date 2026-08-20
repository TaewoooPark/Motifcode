#!/usr/bin/env python3
"""Make an unforked vLLM able to serve Motif-3.

The vendor ships a vLLM fork and an amd64-only container. Neither runs here:
this box is aarch64 with CUDA 13, and the fork is pinned to a vLLM that
predates both. Building it would mean compiling a year-old vLLM for a GPU it
has never heard of.

It turns out not to be necessary. The fork's Motif support is five Python
files, and every vLLM API they import still exists in the installed vLLM — the
two custom pieces, the diff-KV attention backend and the mHC kernels, are
Triton rather than C++. The one CUDA file, a fused PolyNorm-quantise kernel,
has a torch fallback that the model selects on its own when the extension is
absent.

So this script copies those five files out of the fork at a pinned revision,
rewrites their intra-fork imports, and leaves a package that registers
`MotifForCausalLM` from outside. Copying rather than vendoring: the files are
somebody else's, and a copy in the repository would drift from upstream the
moment it was made.

    python toolkit/serving/build_plugin.py --out ~/motif-prune/vllm_motif
    PYTHONPATH=~/motif-prune/vllm_motif vllm serve <checkpoint> ...

What this does not do is make the fork's numerics somebody else's problem.
`toolkit/serving/test_parity.py` checks the served model against the reference
implementation the profiler runs; a plugin that loads and answers plausibly is
not evidence that it answers correctly.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = "https://github.com/MotifTechnologies/vllm.git"

# Pinned. An unpinned fetch means the next person builds a different plugin
# from the same command and has no way to tell — and this one carries the
# model's numerics, so "whatever was on main that day" is not a version.
REVISION = "4cd9eb4129883565e69d508038d783d59ee01867"

# Fork path -> name in the plugin package. `motif.py` is renamed because the
# package would otherwise have a module named the same as the package's own
# config module in the fork's layout.
FILES = {
    "vllm/model_executor/models/motif.py": "motif_model.py",
    "vllm/model_executor/models/motif_mtp.py": "motif_mtp.py",
    "vllm/v1/attention/backends/flash_attn_diffkv.py": "flash_attn_diffkv.py",
    "vllm/model_executor/layers/motif_mhc_kernels.py": "motif_mhc_kernels.py",
    "vllm/transformers_utils/configs/motif.py": "motif_config.py",
}

# Modules that live in the plugin. A relative import naming anything else is a
# sibling in the fork's own tree and has to be redirected to the installed vLLM
# — to the package that file came from, which is not the same for all of them.
LOCAL = {
    "motif_model", "motif_mtp", "flash_attn_diffkv", "motif_mhc_kernels",
    "motif_config", "quant_config",
}

# A file's relative imports resolve against its *own* package. `motif.py` lives
# beside `interfaces.py` in `model_executor.models`; `flash_attn_diffkv.py`
# lives beside `flash_attn.py` in `v1.attention.backends`. Sending both to the
# models package produces `vllm.model_executor.models.flash_attn`, which does
# not exist — and the failure surfaces four frames inside vLLM's registry as
# "architectures failed to be inspected", saying nothing about the cause.
# Written by extraction rather than copied whole, so it is not in FILES — but
# it is still a module the plugin's relative imports may name, and still has a
# package its own relative imports resolve against.
GENERATED = {"quant_config.py": "vllm.model_executor.layers.quantization"}

PACKAGE_OF = {dst: src.rsplit("/", 1)[0].replace("/", ".") for src, dst in FILES.items()}
PACKAGE_OF.update(GENERATED)

# The fork's quantization module is a different vintage of upstream's, and
# porting all 2442 lines would be porting a fork. Only two classes are actually
# needed, and the fork's own docstrings call them "a thin alias" of a class
# upstream still has: they subclass `ModelOptMxFp8Config`, behave identically,
# and exist so Motif's MoE layer can `isinstance` its way to the right method.
# So they are extracted by name rather than copied wholesale.
QUANT_CLASSES = ("ModelOptBlockFp8Config", "ModelOptNvFp4DynamicConfig")
QUANT_SOURCE = "vllm/model_executor/layers/quantization/modelopt.py"


ABSOLUTE_REWRITES = {
    "from vllm.transformers_utils.configs.motif import": "from .motif_config import",
    # Both names come from the plugin now; upstream has neither.
    "from vllm.model_executor.layers.quantization.modelopt import (\n            ModelOptBlockFp8Config,\n            ModelOptMxFp8Config,\n            ModelOptNvFp4DynamicConfig,\n        )":
        "from .quant_config import (\n            ModelOptBlockFp8Config,\n            ModelOptMxFp8Config,\n            ModelOptNvFp4DynamicConfig,\n        )",
    "from vllm.v1.attention.backends.flash_attn_diffkv import": "from .flash_attn_diffkv import",
    "from vllm.model_executor.layers.motif_mhc_kernels import": "from .motif_mhc_kernels import",
    "from vllm.model_executor.models.motif import": "from .motif_model import",
}

INIT = '''"""Motif-3 for an unforked vLLM.

Generated by `toolkit/serving/build_plugin.py`. The model files are the
vendor's, copied at a pinned revision and re-pointed at the installed vLLM;
this module is the registration around them.

Registered through the `vllm.general_plugins` entry point when installed, or by
calling `register()` before constructing an `LLM`.
"""

from __future__ import annotations


def register() -> None:
    from transformers import AutoConfig
    from vllm import ModelRegistry

    from .motif_config import MotifConfig

    # vLLM resolves an unfamiliar `model_type` through transformers, so the
    # config belongs in that registry rather than in vLLM's own table.
    try:
        AutoConfig.register("Motif", MotifConfig)
    except ValueError:
        pass  # already registered, which happens on a re-import

    ModelRegistry.register_model(
        "MotifForCausalLM", "motif_vllm.motif_model:MotifForCausalLM"
    )
    ModelRegistry.register_model("MotifMTPModel", "motif_vllm.motif_mtp:MotifMTP")

    # `modelopt_nvfp4` is the name this checkpoint declares, and upstream vLLM
    # does not have it. Registering it is what makes the packed expert tensors
    # load as quantized rather than being misread.
    from .quant_config import register_quantization

    register_quantization()
'''


def rewrite(text: str, package: str = "vllm.model_executor.models") -> str:
    """Re-point the fork's imports without touching anything else.

    `package` is where this file lived in the fork, so that a relative import
    of a sibling resolves to the same sibling in the installed vLLM.
    """
    for old, new in ABSOLUTE_REWRITES.items():
        text = text.replace(old, new)

    lines = []
    for line in text.split("\n"):
        match = re.match(r"from \.([A-Za-z_]\w*) import", line)
        if match and match.group(1) not in LOCAL:
            # A sibling in the fork's own tree, which the installed vLLM has
            # under the same name in the same package.
            line = line.replace(
                f"from .{match.group(1)} import",
                f"from {package}.{match.group(1)} import",
            )
        lines.append(line)
    return "\n".join(lines)


QUANT_HEADER = '''"""The two quantization config classes upstream vLLM does not have.

Extracted from the fork rather than reimplemented, and only these two: the
fork's `modelopt.py` is a different vintage of upstream's whole file, and
carrying all of it would mean carrying a fork.

Both are, in the fork's own words, thin aliases of `ModelOptMxFp8Config` —
same behaviour, different name — so that Motif's MoE layer can pick a method
by `isinstance`. Upstream still has the parent, so subclassing it here gives
the same three-way distinction without the rest of the file.

Registration matters as much as the classes. Our checkpoint declares
`quant_method: "modelopt_nvfp4"`, and upstream vLLM has no such name at all —
it registers `modelopt_fp4` for the serialized path, which is a different
format. Without the registration below, the checkpoint's own declaration
resolves to nothing.
"""

from typing import Any

import torch
from vllm.model_executor.layers.quantization import QuantizationMethods
from vllm.model_executor.layers.quantization.base_config import QuantizeMethodBase
from vllm.model_executor.layers.quantization.modelopt import ModelOptMxFp8Config

'''

QUANT_REGISTER = '''

def register_quantization() -> None:
    """Make `modelopt_nvfp4` a name vLLM recognises."""
    from vllm.model_executor.layers import quantization as q

    for name, cls in (
        ("modelopt_nvfp4", ModelOptNvFp4DynamicConfig),
        ("modelopt_blockfp8", ModelOptBlockFp8Config),
    ):
        q.QUANTIZATION_METHODS.append(name) if name not in q.QUANTIZATION_METHODS else None
        # The lookup table is private and its name has moved between releases,
        # so it is found rather than assumed — and a miss is loud, because the
        # alternative is a checkpoint whose quantization is silently ignored.
        table = getattr(q, "_CUSTOMIZED_METHOD_TO_QUANT_CONFIG", None)
        if table is None:
            raise RuntimeError(
                "vLLM's quantization registry is not where this expects it. "
                "Without registering, a modelopt_nvfp4 checkpoint loads as if unquantized."
            )
        table[name] = cls
'''


def extract_classes(text: str, names: tuple[str, ...]) -> str:
    """The named top-level classes, verbatim, in source order."""
    lines = text.split("\n")
    starts = {}
    for i, line in enumerate(lines):
        for name in names:
            if line.startswith(f"class {name}("):
                starts[name] = i
    missing = [n for n in names if n not in starts]
    if missing:
        raise SystemExit(
            f"{QUANT_SOURCE} no longer defines {missing}. The fork's layout changed; "
            "this fails here rather than producing a plugin that cannot load a checkpoint."
        )

    out = []
    for name in sorted(starts, key=lambda n: starts[n]):
        start = starts[name]
        end = len(lines)
        for j in range(start + 1, len(lines)):
            if lines[j] and not lines[j][0].isspace() and not lines[j].startswith(")"):
                end = j
                break
        out.append("\n".join(lines[start:end]).rstrip())
    return "\n\n\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", type=Path, required=True, help="directory to hold the package")
    ap.add_argument("--revision", default=REVISION)
    ap.add_argument("--repo", default=REPO)
    args = ap.parse_args()

    package = args.out / "motif_vllm"
    package.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        # init + fetch rather than clone, because `--branch` takes a ref and
        # the pin is a commit. Fetching the commit directly is what makes the
        # revision reproducible rather than "whatever that branch points at".
        checkout = Path(tmp) / "vllm"
        checkout.mkdir()
        git = ["git", "-C", str(checkout)]
        subprocess.run([*git, "init", "-q"], check=True)
        subprocess.run([*git, "remote", "add", "origin", args.repo], check=True)
        subprocess.run([*git, "config", "core.sparseCheckout", "true"], check=True)
        subprocess.run(
            [*git, "sparse-checkout", "set", "--no-cone",
             "vllm/model_executor", "vllm/v1/attention/backends", "vllm/transformers_utils"],
            check=True,
        )
        subprocess.run(
            [*git, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", args.revision],
            check=True,
        )
        subprocess.run([*git, "checkout", "-q", "FETCH_HEAD"], check=True)
        head = subprocess.run(
            [*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
        ).stdout.strip()

        missing = [src for src in FILES if not (checkout / src).exists()]
        if missing:
            raise SystemExit(
                f"{args.repo}@{args.revision} does not contain {missing}. The fork's layout "
                "changed; this script names files explicitly so that shows up here rather "
                "than as a plugin that silently omits one."
            )
        for src, dst in FILES.items():
            (package / dst).write_text(
                rewrite((checkout / src).read_text(), PACKAGE_OF[dst]), encoding="utf-8"
            )

        quant = extract_classes((checkout / QUANT_SOURCE).read_text(), QUANT_CLASSES)
        (package / "quant_config.py").write_text(
            QUANT_HEADER + quant + "\n" + QUANT_REGISTER, encoding="utf-8"
        )

    (package / "__init__.py").write_text(INIT, encoding="utf-8")
    (package / "SOURCE").write_text(
        f"{args.repo}\n{head}\n"
        "Files are the vendor's, under that repository's licence. Imports rewritten by\n"
        "toolkit/serving/build_plugin.py; nothing else is changed.\n",
        encoding="utf-8",
    )
    print(f"{args.repo}@{head[:12]} -> {package}", file=sys.stderr)
    print(f"PYTHONPATH={args.out} vllm serve <checkpoint>", file=sys.stderr)


if __name__ == "__main__":
    main()
