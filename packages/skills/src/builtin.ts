/**
 * Built-in skills.
 *
 * The set every coding harness ends up needing — review, commit, debug, test,
 * explore, PR body, skill authoring — plus two that only make sense here.
 *
 * Names and shape follow what Codex and the published skill collections settled
 * on, so a user arriving from either finds what they expect. The contents do
 * not: each one is written for a model that thinks on every turn, breaks JSON
 * on backslashes, drives a persistent terminal, and answers in Korean when
 * asked to.
 */

import { parseSkill, type Skill } from "./parse.js";

const SOURCES: string[] = [
  /* ---------------------------------------------------------------- */
  `---
name: explore
description: Map an unfamiliar codebase before changing it — structure, entry points, conventions
budget: 900
tags: read
---
Build a picture of the code before touching it. Cheap now, or expensive later.

1. **Shape first.** Read the manifest (\`package.json\`, \`pyproject.toml\`,
   \`Cargo.toml\`) and the README. Those name the entry points, the test command
   and the conventions, and they are shorter than guessing.
2. **Follow the imports, not the directories.** A folder tree tells you how
   someone filed the code; the import graph tells you how it runs.
3. **Read the tests for the area you are changing.** They are the executable
   specification, and they tell you what "working" means here.
4. **Note the conventions you must match** — error handling, logging, naming,
   how modules are exported. Matching them is most of what makes a change
   reviewable.

Search with \`rg\` before opening files. Prefer one \`rg -n\` over five
\`read\` calls: each tool call is a chance for a malformed argument, so fewer
and larger is safer as well as faster.

Do not start editing until you can say, in one sentence, where the change goes
and what will break if it is wrong.`,

  /* ---------------------------------------------------------------- */
  `---
name: code-review
description: Review a diff for correctness, then for everything else
budget: 1100
tags: review
---
Review in this order and stop early if an earlier tier fails — a change that is
wrong does not need a style opinion.

**1. Correctness.** Does it do what it claims? Walk the new path with a concrete
input. Check boundaries: empty, one, many, null, the maximum. Check the error
paths, which are where real bugs hide because nobody runs them.

**2. Blast radius.** What else calls this? \`rg\` for the symbol before deciding
a signature change is safe. Look for callers in tests, scripts and docs, not
just source.

**3. Tests.** Is the new behaviour covered? A test that passes before and after
the change tests nothing. Ask what test would have caught this bug.

**4. Simplification.** Is there an existing helper this reimplements? Can a
branch be removed? Reuse beats cleverness.

**5. Style.** Only after the above, and only where it deviates from the
surrounding code.

Report each finding as: file:line, what is wrong, and a concrete failing input.
"This looks fragile" is not a finding. If you cannot produce the input that
breaks it, say so and downgrade it to a question.`,

  /* ---------------------------------------------------------------- */
  `---
name: test-fix
description: Run the tests, read the first real failure, fix the cause
budget: 800
tags: verify
---
Failing tests are information, not an obstacle.

1. **Run them and read the output.** Not the summary — the first failure's
   actual message and stack. Later failures are usually the same cause.
2. **Reproduce the smallest case.** Run the single failing test, not the suite.
   Faster feedback is worth the extra command.
3. **Find the cause, not the symptom.** If an assertion fails, ask why the value
   is what it is. Changing the assertion to match the bug is how bugs ship.
4. **Fix, then re-run the single test, then the suite.** In that order.

If a test is wrong rather than the code, say so explicitly and explain why
before changing it. That is a claim reviewers must be able to check.

Never disable, skip or delete a failing test to make the run green. If you truly
cannot fix it, leave it failing and say what you found — a red suite with an
explanation is worth more than a green one that lies.`,

  /* ---------------------------------------------------------------- */
  `---
name: debug
description: Systematic debugging — narrow, don't guess
budget: 800
tags: verify
---
Guessing is slow. Narrowing is fast.

1. **State the expected and the observed.** Precisely. Half of all bugs resolve
   at this step because the expectation was wrong.
2. **Find the boundary.** Where does the value stop being right? Bisect the
   pipeline — print or log at the midpoint, not at the end.
3. **Change one thing.** If two changes go in and the symptom moves, you have
   learned nothing.
4. **Prove the cause before fixing it.** You should be able to say "this is
   wrong because X", and make the bug appear and disappear on demand.

Use the \`term\` tool when the situation wants a live session — a debugger, a
REPL, a long-running process you need to poke at. Stateless \`bash\` cannot hold
a breakpoint.

When stuck for more than a few cycles, write down what you know and what you
have ruled out. Stating it usually surfaces the assumption that was wrong.`,

  /* ---------------------------------------------------------------- */
  `---
name: commit
description: Write a commit message that explains why, in the repository's language
budget: 700
tags: git
---
The diff already says what changed. The message says why.

- **Subject**: imperative, specific, under ~72 characters. "Fix the retry
  window" beats "fixes". Do not restate the file names.
- **Body**: the reason the change exists, what you considered and rejected, and
  anything a reader six months from now would need. Wrap at ~72 columns.
- Skip the body only when the change is genuinely self-evident.

Match the repository. Run \`git log --oneline -20\` first and follow whatever
convention is already there — conventional-commit prefixes if they use them,
plain prose if they do not, **and the language they write in**. If the log is in
Korean, write in Korean, and write it as natural prose rather than translated
English: no unnecessary English terms where a Korean one exists, no romanised
loanwords where the Korean word is normal.

Stage deliberately. \`git add -A\` sweeps up files you did not mean to include;
check \`git status\` before committing.`,

  /* ---------------------------------------------------------------- */
  `---
name: pr-body
description: Write a pull-request description a reviewer can act on
budget: 700
tags: git
---
Write for the person who has to approve it, and who was not in your head.

**What and why** — two or three sentences. The problem, then the fix.

**How to verify** — the exact commands. A reviewer who can reproduce your
confidence approves faster than one who has to build it themselves.

**Risk** — what could break, what you checked, what you deliberately did not.
Naming a limitation is not a weakness; discovering it in review is.

Keep it proportional. A one-line fix does not need five headings. Derive the
content from \`git diff\` against the base branch rather than from memory, and
match the language and tone of recent merged PRs in the repository.`,

  /* ---------------------------------------------------------------- */
  `---
name: skill-creator
description: Author a new skill for this harness
budget: 900
tags: meta
---
A skill is instructions, not capability. It cannot add tools — the tool list is
frozen for the session because changing it invalidates the prompt prefix — so if
what you want needs different tools, you want a subagent instead.

Write \`.motif/skills/<name>/SKILL.md\`:

\`\`\`
---
name: kebab-case-name
description: one line, written so a reader knows when to reach for it
budget: 800
---
Body in markdown. Imperative. Concrete.
\`\`\`

Rules that earn their place:

- **The description is the whole index.** It is what the model sees on every
  turn; the body only loads when the skill is called. Say *when to use this*,
  not what it contains.
- **Be specific enough to act on.** "Follow best practices" costs tokens and
  changes nothing. Name the command, the file, the check.
- **Keep it short.** A skill is injected into a live context; \`budget\` is the
  ceiling and the loader enforces it.
- **Do not restate the tools.** The model already has their descriptions.

Test it by loading it and doing the task. If the skill did not change what you
did, it is not a skill — it is a comment.`,

  /* ---------------------------------------------------------------- */
  `---
name: motif-serving
description: Diagnose and fix the Motif-3 endpoint when output quality looks wrong
budget: 1000
tags: ops motif
---
Bad output from this model is very often a server misconfiguration rather than
the model. Check these before blaming the weights.

**The fork.** Stock vLLM with the stock Hermes tool parser silently drops any
turn whose tool-call JSON is malformed, and this model produces malformed JSON
often enough that it matters. The server must run the Motif fork with
\`--tool-call-parser motif --reasoning-parser motif\`. Without them the repair
ladder is simply absent and turns disappear.

**Prefix caching.** \`--enable-prefix-caching\` must be on. The tool list here is
frozen and canonically ordered specifically to keep the cached prefix alive; if
caching is off, that design buys nothing and time-to-first-token stays bad.

**Sampling.** The published evaluations run at \`temperature 1.0\`,
\`top_p 0.95\`. Near-greedy settings are a different regime and will not
reproduce the model card's numbers.

**Speculative decoding.** The checkpoint carries an MTP head; passing
\`--speculative-config\` with one speculative token is free throughput.

**On GB10 specifically.** Unified memory means an over-large KV cache does not
fail with a CUDA error — it consumes host RAM until the kernel OOM killer
arrives. Cap it explicitly. NVFP4 on ARM64 GB10 also has open upstream issues;
if the engine dies on startup, check that before assuming a bad checkpoint.

Run \`motif doctor\` first — it checks all of the above and prints what is
missing.`,

  /* ---------------------------------------------------------------- */
  `---
name: korean
description: Write output in natural Korean rather than translated English
budget: 600
tags: writing
---
This model was trained against an explicit Korean rubric, so it can write Korean
that reads as Korean. Getting that requires asking for it deliberately.

Avoid, in order of how badly they read:

- **Unnecessary code-switching.** Use the Korean word where one exists. A Korean
  term followed by an English gloss is fine; an English term followed by a
  Korean gloss is not.
- **Translated syntax.** Long subordinate chains, "~에 대해", "~를 통해",
  "~할 수 있습니다" everywhere. Korean prose carries its verbs differently from
  English; do not transliterate the structure.
- **Uniform sentence length.** Real writing varies. Three medium sentences in a
  row is a rhythm problem even when every one is correct.
- **Padding.** "결론적으로", "요약하자면" before a summary that is already
  obviously a summary.

Keep verbatim, always: identifiers, file paths, commands, error text, library
names and quoted output. Translating an error message helps nobody.

Match the register of the surrounding material — a commit log, a code comment
and a design document are three different voices.`,
];

export const BUILTIN_SKILLS: readonly Skill[] = Object.freeze(
  SOURCES.map((src) => parseSkill(src, "builtin")),
);
