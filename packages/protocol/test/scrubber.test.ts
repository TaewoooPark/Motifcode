/**
 * The streaming reasoning scrubber.
 *
 * Every case here is a delta split that a per-delta regex gets wrong. That is
 * the whole point of the module: the tags arrive broken across chunk
 * boundaries, and the naive implementation either leaks reasoning to the user
 * or eats the first characters of the answer.
 */

import { describe, expect, it } from "vitest";
import { ThinkScrubber, splitThinking } from "../src/scrubber.js";

function feed(deltas: string[], startInReasoning = true) {
  const s = new ThinkScrubber({ startInReasoning });
  let reasoning = "";
  let content = "";
  for (const d of deltas) {
    const c = s.push(d);
    reasoning += c.reasoning;
    content += c.content;
  }
  const f = s.flush();
  return { reasoning: reasoning + f.reasoning, content: content + f.content };
}

describe("ThinkScrubber", () => {
  it("starts inside reasoning, because the prompt leaves <think> open", () => {
    // `add_generation_prompt` ends the prompt with `<think>`, so the model's
    // very first token is already reasoning and no opening tag is ever emitted.
    const r = feed(["thinking hard", "</think>", "the answer"]);
    expect(r.reasoning).toBe("thinking hard");
    expect(r.content).toBe("the answer");
  });

  it("survives a marker split across deltas", () => {
    const r = feed(["reasoning", "</thi", "nk>answer"]);
    expect(r.reasoning).toBe("reasoning");
    expect(r.content).toBe("answer");
  });

  it("survives a marker split one character at a time", () => {
    const r = feed(["r", "<", "/", "t", "h", "i", "n", "k", ">", "a"]);
    expect(r.reasoning).toBe("r");
    expect(r.content).toBe("a");
  });

  it("releases held-back text that turns out not to be a tag", () => {
    // "</th" looks like the start of `</think>` and must be held; when the
    // stream ends without completing it, it is real text and must come back.
    const r = feed(["value is 3 </th"]);
    expect(r.reasoning).toBe("value is 3 </th");
    expect(r.content).toBe("");
  });

  it("handles a lone '<' that never becomes a tag", () => {
    const r = feed(["a < b", "</think>", "x < y"]);
    expect(r.reasoning).toBe("a < b");
    expect(r.content).toBe("x < y");
  });

  it("handles reopening a thinking block mid-stream", () => {
    const r = feed(["one", "</think>", "mid", "<think>", "two", "</think>", "end"]);
    expect(r.reasoning).toBe("onetwo");
    expect(r.content).toBe("midend");
  });

  it("starts in content when thinking is disabled", () => {
    // With `enable_thinking: false` the template closes the block in the prompt,
    // so anything that looks like a marker in the output is just text.
    const r = feed(["direct answer"], false);
    expect(r.content).toBe("direct answer");
    expect(r.reasoning).toBe("");
  });

  it("tracks its own state", () => {
    const s = new ThinkScrubber();
    expect(s.reasoning).toBe(true);
    s.push("abc</think>");
    expect(s.reasoning).toBe(false);
  });

  it("matches the one-shot helper", () => {
    const text = "why</think>because";
    expect(splitThinking(text)).toEqual({ reasoning: "why", content: "because" });
  });

  it("never loses a character", () => {
    const full = "aaa</think>bbb<think>ccc</think>ddd";
    for (let cut = 1; cut < full.length; cut++) {
      const r = feed([full.slice(0, cut), full.slice(cut)]);
      expect(r.reasoning + "|" + r.content, `split at ${cut}`).toBe("aaaccc|bbbddd");
    }
  });
});
