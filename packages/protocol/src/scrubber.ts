/**
 * Streaming separation of reasoning from content.
 *
 * The trap, learned the expensive way by other harnesses: running a regex over
 * each delta destroys the state the downstream consumer depends on. When the
 * model streams
 *
 *     delta1 = "</thi"
 *     delta2 = "nk>the answer"
 *
 * a per-delta regex sees no complete tag in either delta, passes both through,
 * and the user watches the model's private reasoning scroll past. Worse is the
 * opposite case, where a delta that *is* a partial tag gets emitted as content
 * and then the real tag never matches.
 *
 * So: one state machine, upstream of every consumer, that holds back any suffix
 * which could still become a marker and resolves it when the next delta lands.
 *
 * Motif specifics
 * ---------------
 * `add_generation_prompt` ends the prompt with an *open* `<think>`. The model's
 * output therefore begins inside the reasoning block and the first marker it
 * emits is the closing `</think>` — there is no opening tag in the output at
 * all. That is why `startInReasoning` defaults to true. With
 * `enable_thinking: false` the template closes the block in the prompt instead,
 * and the stream starts in content; construct with `startInReasoning: false`.
 */

import { THINK_CLOSE, THINK_OPEN } from "./tokens.js";

export interface ScrubChunk {
  reasoning: string;
  content: string;
}

const MARKERS = [THINK_OPEN, THINK_CLOSE] as const;

/** Longest suffix of `s` that is a proper prefix of any marker. */
function heldBackSuffix(s: string): number {
  let longest = 0;
  for (const marker of MARKERS) {
    const max = Math.min(marker.length - 1, s.length);
    for (let n = max; n > longest; n--) {
      if (s.endsWith(marker.slice(0, n))) {
        longest = n;
        break;
      }
    }
  }
  return longest;
}

export class ThinkScrubber {
  private buffer = "";
  private inReasoning: boolean;

  constructor(opts: { startInReasoning?: boolean } = {}) {
    this.inReasoning = opts.startInReasoning ?? true;
  }

  /** Feed one delta. Returns the parts that are now safe to emit. */
  push(delta: string): ScrubChunk {
    this.buffer += delta;
    let reasoning = "";
    let content = "";

    for (;;) {
      const marker = this.inReasoning ? THINK_CLOSE : THINK_OPEN;
      const idx = this.buffer.indexOf(marker);
      if (idx === -1) break;
      const before = this.buffer.slice(0, idx);
      if (this.inReasoning) reasoning += before;
      else content += before;
      this.buffer = this.buffer.slice(idx + marker.length);
      this.inReasoning = !this.inReasoning;
    }

    // Whatever could still grow into a marker stays in the buffer.
    const hold = heldBackSuffix(this.buffer);
    const emit = this.buffer.slice(0, this.buffer.length - hold);
    this.buffer = this.buffer.slice(this.buffer.length - hold);
    if (this.inReasoning) reasoning += emit;
    else content += emit;

    return { reasoning, content };
  }

  /**
   * End of stream. Anything still held back turned out not to be a marker, so
   * it is real text and must be released — dropping it is how harnesses lose
   * the last few characters of an answer.
   */
  flush(): ScrubChunk {
    const rest = this.buffer;
    this.buffer = "";
    return this.inReasoning ? { reasoning: rest, content: "" } : { reasoning: "", content: rest };
  }

  /** True while the stream is still inside a reasoning block. */
  get reasoning(): boolean {
    return this.inReasoning;
  }
}

/** Convenience for a complete, non-streamed response. */
export function splitThinking(
  text: string,
  opts: { startInReasoning?: boolean } = {},
): ScrubChunk {
  const s = new ThinkScrubber(opts);
  const a = s.push(text);
  const b = s.flush();
  return { reasoning: a.reasoning + b.reasoning, content: a.content + b.content };
}
