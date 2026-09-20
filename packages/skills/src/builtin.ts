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
name: motif-endpoint
description: Diagnose the Motif-3 endpoint when tool calls or output quality look wrong
budget: 900
tags: ops motif
---
Bad output from this model is very often the endpoint rather than the model.
Motif-3 is reached through a hosted OpenAI-compatible endpoint, so the server
flags are not yours to set — but what they produce is observable, and
\`motif doctor\` measures it. Read its output before blaming the weights.

**Tool calls must arrive structured.** A correctly served Motif-3 returns
\`tool_calls\` with \`content: null\`, because the server runs the vendor's
tool-call parser and its repair ladder over the raw token stream. The harness
has a client-side ladder for calls that arrive as \`<tool_call>\` text, but it
only sees what is left in the body; if \`doctor\` reports text-form calls,
parse failures will rise and the breakage budget will bind sooner.

**Reasoning must arrive separated.** The generation prompt always leaves
\`<think>\` open, and the endpoint returns the reasoning as its own field. If
it arrives inline the harness splits it, but that is a fallback.

**Sampling.** \`temperature 1.0\`, \`top_p 0.95\` — the published evaluation
regime. Near-greedy settings are a different regime and will not reproduce the
model card's numbers.

**Credentials and limits.** A 401 means the key is missing or rejected: set
\`MOTIF_API_KEY\` in the environment or in a \`.env\` file, and note that the
harness never passes it to the commands it runs. A 429 is retried after the
endpoint's \`Retry-After\`; a 5xx is retried on backoff.

**Only the native channel.** The hosted endpoint has no \`/v1/completions\`,
so the \`object\` and \`raw\` channels cannot run against it. If a task needs
them, it needs a different server.`,

  /* ---------------------------------------------------------------- */
  `---
name: init
description: Write the project notes a session loads — stack, commands, conventions, gotchas
budget: 900
tags: setup
---
Produce \`.motif/NOTES.md\`: the file every session reads into its system
prompt before doing anything here. It is for a model arriving cold, so write
what you would want to be told, and nothing that \`ls\` already says.

Find out first, then write. Read the manifest and the README; run the test
command once to learn what passing looks like; \`rg -n\` for the conventions
the code actually follows rather than the ones the README claims.

Cover, briefly, each with a verifiable line:

- **What this is** and where the entry points are.
- **How to build, test and lint**, as exact commands, and how long the tests take.
- **Conventions that a change must match** — formatting, error handling,
  naming, how modules export, how tests are laid out.
- **Gotchas**: the thing that is not obvious and wastes an hour. A directory
  that is generated. A test that needs a service. A file that must not be edited.
- **Do not**: anything the owner has said is off limits.

Keep it under 60 lines. Every line is paid for on every request. If a
\`NOTES.md\` exists, update it rather than replacing it, and keep what still holds.`,

  /* ---------------------------------------------------------------- */
  `---
name: plan
description: Turn a request into an ordered plan with the files it touches and how to verify each step
budget: 900
tags: think
---
Plan before editing, and show the plan before running it. A plan is a list of
steps a reviewer could check off, not a paragraph of intent.

1. **Restate the goal in one line**, including what must not change.
2. **Locate.** \`rg -n\` for the code involved; name the files and the
   functions. If you cannot name them, you are not ready to plan.
3. **Order the steps** so that each leaves the repository working. Put the
   change that everything else depends on first, and the risky one where it
   can be reverted alone.
4. **Say how each step is verified** — a test to run, a command whose output
   changes, a file whose contents you will read back.
5. **Name the unknowns.** What would change the plan, and how you will find
   out early.

Then stop and reply with the plan. Do not start editing in the same turn:
the person reads the plan first, and either says go or changes it.`,

  /* ---------------------------------------------------------------- */
  `---
name: explain
description: Explain how a piece of code works, from its entry point down, with the parts that matter
budget: 800
tags: read
---
Explain by tracing, not by summarising. Start where execution starts — the
command, the request handler, the exported function — and follow it down,
naming each file and function as you pass through it.

Read before you claim. Every statement about behaviour should come from a
line you opened; quote the identifier, give the path and line.

Structure the answer as:

- **What it does**, in two sentences a newcomer would understand.
- **The path through the code**, step by step, with file and function names.
- **The parts that matter**: the invariant, the edge case, the thing that
  looks wrong and is not — or is.
- **What you did not check.**

Reply in prose; this task ends with an explanation, not with edits. Match the
language the person used to ask.`,

  /* ---------------------------------------------------------------- */
  `---
name: refactor
description: Restructure code without changing behaviour, verified by the tests before and after
budget: 900
tags: edit
---
A refactor changes structure and nothing else. The tests decide whether that
held, so run them first to know the baseline, and last to prove it.

1. **Run the tests before touching anything.** A failing test that was already
   failing is not yours to fix here; note it and move on.
2. **One kind of change at a time.** Rename, then move, then split. Mixing them
   makes the diff unreadable and a regression impossible to locate.
3. **Keep the public surface.** Exported names, signatures and error types stay
   unless the task says otherwise. \`rg -n\` for every caller before changing
   one.
4. **Prefer the edit tool to rewriting a file.** A whole-file rewrite hides
   what changed; a patch shows it.
5. **Run the tests after each step**, not only at the end.

Report what moved and what stayed, and paste the test summary from before and
after. If behaviour had to change to make the structure work, say so and stop
— that is a different task.`,

  /* ---------------------------------------------------------------- */
  `---
name: security-review
description: Look for the ways this change or repository can be made to do harm
budget: 1000
tags: review
---
Assume an attacker who can supply any input the code reads: arguments,
files, network bodies, environment, a cloned repository. Look for where that
input reaches something that acts.

Check, in this order, and give a file and line for every finding:

- **Injection**: strings that become shell commands, SQL, HTML, format
  strings, regular expressions, or paths. \`rg -n\` for \`exec\`, \`spawn\`,
  \`eval\`, template concatenation into commands.
- **Paths**: anything resolving a user-supplied path; can it escape the
  intended directory through \`..\` or a symlink?
- **Secrets**: keys in the tree, in logs, in error messages, in environment
  handed to child processes.
- **Deserialisation and parsing** of untrusted data; sizes and depths that
  are unbounded.
- **Authorisation**: a check that is a request rather than a boundary —
  enforced by a prompt, a comment, or the caller's good behaviour.
- **Terminal output** of untrusted text: escape sequences reaching the screen.

Rate each finding by what an attacker gains, and give the input that
demonstrates it. Do not fix anything unless asked; report, with severity
first. An empty report is a real result, and say what you did not look at.`,

  /* ---------------------------------------------------------------- */
  `---
name: docs
description: Write or update documentation from the code as it actually is
budget: 800
tags: write
---
Documentation is a claim about the code, so check the code before making it.
Read the thing being documented; run it if it can be run; copy the real
output rather than the expected one.

- **Start with what the reader needs to do**, not with what the code is.
  A quickstart before a reference.
- **Commands must be copy-pasteable** and must have been run. Show their
  actual output, trimmed.
- **Match the existing voice and format.** A README with sentence-case
  headings and short paragraphs does not want a new section in another style.
- **Update, do not append.** Find the paragraph that is now wrong and change
  it; a document that grows by appending contradicts itself.
- **Say what is not covered**, in one line, rather than implying completeness.

If asked to document an API, generate the list of exports from the code —
\`rg -n "^export"\` — rather than from memory, and check each signature.`,

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
