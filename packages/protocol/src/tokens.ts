/**
 * Motif-3 special tokens and structural markers.
 *
 * Read from the shipped `chat_template.jinja` and `tokenizer_config.json`
 * of Motif-Technologies/Motif-3. Do not guess these.
 */

export const BOS = "<|beginoftext|>";
export const EOS = "<|endoftext|>";
export const TURN_START = "<|startofturn|>";
export const TURN_END = "<|endofturn|>";

export const ROLE_SYSTEM = "<|system|>";
export const ROLE_USER = "<|user|>";
export const ROLE_ASSISTANT = "<|assistant|>";
export const ROLE_TOOL = "<|tool|>";
export const REFERENCE = "<|reference|>";

export const THINK_OPEN = "<think>";
export const THINK_CLOSE = "</think>";

export const TOOL_CALL_OPEN = "<tool_call>";
export const TOOL_CALL_CLOSE = "</tool_call>";
export const TOOL_RESPONSE_OPEN = "<tool_response>";
export const TOOL_RESPONSE_CLOSE = "</tool_response>";

/**
 * Official sampling defaults, from the model's `generation_config.json`.
 *
 * Deliberately NOT the near-greedy settings most coding harnesses use. Motif's
 * own published evaluations run at these values; changing them means you are no
 * longer reproducing the numbers on the model card.
 */
export const SAMPLING_DEFAULTS = {
  temperature: 1.0,
  top_p: 0.95,
} as const;

/** Native context length (`max_position_embeddings`). */
export const MAX_CONTEXT = 262_144;

/**
 * KV cache cost per token, in bytes, as an upper bound.
 *
 * Motif-3 uses MLA-style compressed KV: `kv_lora_rank` 512 + `qk_rope_head_dim`
 * 64 = 576 values per layer, 53 layers, 2 bytes each. Layers on the interleaved
 * sliding-window schedule hold less than this, so treat it as a ceiling.
 */
export const KV_BYTES_PER_TOKEN = 576 * 53 * 2;
