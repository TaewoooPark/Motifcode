"""The import rewrite, which is the only thing this script actually changes.

Everything else is a copy. If the rewrite is wrong the plugin either fails to
import — loud, fine — or silently binds to the wrong module, which is not.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from build_plugin import FILES, LOCAL, PACKAGE_OF, rewrite


class TestRewrite(unittest.TestCase):
    def test_the_fork_s_own_config_becomes_a_package_import(self):
        line = "from vllm.transformers_utils.configs.motif import MotifConfig"
        self.assertEqual(rewrite(line), "from .motif_config import MotifConfig")

    def test_the_custom_attention_backend_becomes_a_package_import(self):
        line = "from vllm.v1.attention.backends.flash_attn_diffkv import FlashAttentionDiffKVBackend"
        self.assertEqual(rewrite(line), "from .flash_attn_diffkv import FlashAttentionDiffKVBackend")

    def test_a_sibling_of_the_models_package_goes_to_the_installed_vllm(self):
        # `interfaces` is vLLM's, not Motif's. Left as a relative import it
        # would resolve to nothing; copied into the package it would be a
        # second, stale copy of an interface vLLM checks with isinstance.
        line = "from .interfaces import SupportsPP"
        self.assertEqual(rewrite(line), "from vllm.model_executor.models.interfaces import SupportsPP")

    def test_a_motif_module_stays_relative(self):
        line = "from .motif_mhc_kernels import mhc_forward"
        self.assertEqual(rewrite(line), "from .motif_mhc_kernels import mhc_forward")

    def test_unrelated_vllm_imports_are_untouched(self):
        line = "from vllm.model_executor.layers.layernorm import RMSNorm"
        self.assertEqual(rewrite(line), line)

    def test_a_string_mentioning_an_import_is_not_a_line_to_rewrite(self):
        line = '    doc = "from .interfaces import SupportsPP"'
        self.assertEqual(rewrite(line), line)

    def test_a_sibling_resolves_against_the_file_s_own_package(self):
        # `flash_attn_diffkv.py` lives in `v1.attention.backends`, beside
        # `flash_attn.py`. Sending its relative imports to the models package
        # produces `vllm.model_executor.models.flash_attn`, which does not
        # exist — and vLLM reports that as "architectures failed to be
        # inspected", four frames away from anything naming the cause.
        line = "from .flash_attn import FlashAttentionMetadata"
        self.assertEqual(
            rewrite(line, PACKAGE_OF["flash_attn_diffkv.py"]),
            "from vllm.v1.attention.backends.flash_attn import FlashAttentionMetadata",
        )
        self.assertEqual(
            rewrite(line, PACKAGE_OF["motif_model.py"]),
            "from vllm.model_executor.models.flash_attn import FlashAttentionMetadata",
        )

    def test_every_copied_file_knows_where_it_came_from(self):
        self.assertEqual(set(PACKAGE_OF), set(FILES.values()))
        self.assertEqual(PACKAGE_OF["motif_model.py"], "vllm.model_executor.models")
        self.assertEqual(PACKAGE_OF["flash_attn_diffkv.py"], "vllm.v1.attention.backends")

    def test_every_local_name_matches_a_file_the_script_copies(self):
        # A name in LOCAL that no file produces means some relative import is
        # left pointing at a module that will not exist.
        produced = {Path(dst).stem for dst in FILES.values()}
        self.assertEqual(LOCAL, produced)


if __name__ == "__main__":
    unittest.main()
