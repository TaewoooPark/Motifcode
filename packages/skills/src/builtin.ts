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
name: mcp-setup
description: Register an MCP server from a GitHub URL or server docs, then verify it — MCP 연결/등록
budget: 900
tags: setup mcp
---
사용자가 요청한 MCP를 Motifcode에 등록하고 연결을 확인한다. 아래 순서만 수행한다. 설정 설명·검토만 요청했으면 변경하지 않는다. 원래 요청과 실행 권한을 따른다.

완료 기준은 \`motif mcp doctor --connect\`에서 대상 서버가 \`ready\`인 것이다. 성공하면 즉시 결과를 보고하고 끝낸다. 직접 JSON-RPC를 만들거나, 서버를 백그라운드로 띄우거나, README의 별도 smoke test·업무 예제를 실행하지 않는다.

1. \`bash\`로 \`motif mcp --help\`와 \`motif mcp list\`를 확인한다. CLI가 없거나 MCP 기능이 없으면 한계를 보고한다. Motifcode 소스를 찾거나 수정하지 않는다.
2. 주소에 따라 한 경로만 선택한다.
   - **서비스 URL과 HTTP/SSE 방식이 주어졌다면** 저장소 탐색이나 curl 검사를 생략하고 곧바로 다음처럼 등록한다. \`motif mcp add ID --transport http URL\`. SSE로 명시됐을 때만 sse를 쓴다. 그다음 4번으로 간다.
   - **GitHub 저장소 URL이면** README, manifest/스크립트, 버전만 확인한다. URL 자체를 HTTP 서버로 등록하지 않는다. 문서의 \`npx\`·\`uvx\` 명령이 있으면 그것을 우선하며 검토한 버전을 고정한다. 예: \`motif mcp add ID -- npx -y PACKAGE_SPEC\`. 문서 인자를 그대로 보존한다. cold npx는 doctor 전에 \`npm exec --yes --package=PACKAGE_SPEC -- node -e 'process.exit(0)'\`로 검토한 정확한 패키지만 미리 설치한다(서버를 시작하지 않음). 그다음 4번으로 간다. 문서 명령이 없거나 실패했을 때만 3번의 소스 설치를 검토한다. 다른 폴더를 탐색하지 않는다.
3. 소스 설치가 필요할 때만 \`"$HOME/.motif/mcp-servers/ID"\` 같은 영구 경로를 쓴다. HOME을 사용자 이름이나 작업 경로에서 추측하지 않는다. bash에서 실제 \`$HOME\`과 \`command -v\`로 경로를 구한다. 작업 폴더 밖 메타데이터도 bash로 읽는다. 설치 스크립트를 먼저 검토하고 \`package-lock.json\`이면 \`npm ci --ignore-scripts\`, 이어서 검토한 필수 빌드만 실행한다. 원본 소스·manifest·잠금 파일·tsconfig를 고치거나 재생성하지 말고 빌드가 지원되지 않으면 한계를 보고한다. Node 예: \`motif mcp add ID -- node "$HOME/.motif/mcp-servers/ID/dist/index.js"\`. 이 entry가 실제 문서 경로이고 존재하는지 먼저 확인한다. **.js 파일은 node의 인자이며 실행 권한도 확인하지 않고 command로 지정하면 안 된다.** Python/uv/Docker는 문서의 런타임·인자를 보존한다. 인자는 전부 \`--\` 뒤에 둔다. 임시 checkout 경로를 저장하지 않는다. 기존 임시·설치 디렉터리를 \`rm -rf\`로 지우지 말고 확인 후 재사용하거나 충돌하지 않는 새 디렉터리를 쓴다.
4. \`motif mcp connect ID --login\`으로 대상 서버만 연결한다. 이 명령은 필요한 경우 브라우저를 열고 사용자의 공급자 로그인을 기다린 뒤 도구 목록을 다시 확인한다. bash의 \`timeout_s\`는 240으로 두어 로그인 대기를 허용한다. 로그인/연결을 요청하지 않고 등록만 요청했으면 실행하지 않는다. \`authentication_required\`가 남으면 \`motif mcp login ID\` 또는 TUI의 \`/mcp login ID\`를 안내한다. 제공자가 사전 등록 client ID를 요구하면 사용자의 Motif용 client ID를 \`--client-id\`로 지정하고, 필요하면 \`--callback-port\`와 \`--scope\`를 사용한다. Claude/Codex client ID나 토큰을 복사하지 않는다.
5. 연결 결과의 \`ready\`·도구 수를 확인한다. \`connecting\`이나 exit 0만으로 성공이라 하지 않는다. 취소·동의 거절·권한 부족이면 그 상태로 보고하고 자동으로 재로그인하지 않는다. 성공 후에도 이미 실행한 업무 도구를 재전송하지 않는다. 로그인 없이 진단만 할 때는 \`motif mcp doctor --connect\`를 쓴다. provider 승인이 필요한 서비스와 앱 ID만 제공된 커넥터는 자동 연결을 보장할 수 없다.

기존 설정은 보존한다. 같은 ID만으로 같은 서버라고 판단하지 말고 로컬에서 command/args/URL이 일치하는지 비교하되 자격증명은 출력하지 않는다(\`get\`은 값이 가려져 있다). 기존 항목 교체는 사용자가 원할 때만 한다. 이번 작업에서 직접 만든 실패 항목은 수정할 수 있다. 다른 홈·자격증명 저장소·\`.env\`를 읽거나 환경 전체를 출력하지 않는다. 토큰은 저장·출력하지 말고 \`--env-ref NAME=ENV\` 또는 \`--header-env HEADER=ENV\`로 참조한다. 모델 키를 MCP 키로 재사용하지 않는다. 별도 config 파일은 현재/변경 후 해시 신뢰 절차를 따른다.

마지막 응답 또는 \`done.summary\`에는 사용자 언어로 다음 네 항목을 모두 넣는다: **서버 ID, 자격증명을 제외한 실제 저장 실행 명령·버전(또는 HTTP/SSE 방식), ready 여부·도구 수, Motif 프로세스 재시작 필요 여부.** 새로 등록하거나 설정을 바꿨다면 **현재 Motif를 종료하고 다시 실행해야 사용 가능하며 \`/new\`와 \`/mcp\`는 설정을 다시 읽지 않는다**고 최종 응답에도 명시한다. 앞선 진행 설명에만 쓰지 않는다. doctor가 업무 도구 실행 검증은 아님을 구별한다.`,

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
  /* ---------------------------------------------------------------- */
  `---
name: skill-setup
description: Install a skill from a link, Claude/Codex or a marketplace and verify it — 스킬 설치·가져오기
budget: 1200
tags: setup skills
---
사용자가 요청한 스킬을 Motifcode의 관리 라이브러리에 설치하고 결과를 확인한다.
설치 요청은 실행 요청이다. 설명·검토·미리보기만 요청했다면 설치하지 않는다.
사용자가 정한 출처·스킬·범위와 현재 실행 권한을 따른다.

완료 기준은 선택한 스킬이 설치 영수증과 등록 목록에 나타나고, 출처·이름·범위가
요청과 일치하는 것이다. 확인하면 사용법과 한계를 보고하고 끝낸다. 설치 확인을
위해 다른 모델 세션이나 스킬의 예제 업무를 실행하지 않는다.

1. \`bash\`로 \`pwd\`와 \`motif skills --help\`를 확인한다. project 범위는 이
   작업 디렉터리를 유지한다. 상위 Git 루트나 Motif 소스 폴더로 이동하지 않는다.
   사용자가 다른 대상 폴더를 지정했으면 그 경로를 \`--cwd\`로 전달한다. 이후 설치·관리는 이 CLI를
   사용한다. Motif 소스를 탐색·수정하거나 수동으로 SKILL.md만 복사하지 않는다.
   CLI가 없거나 해당 기능을 지원하지 않으면 그 한계를 보고한다.
2. 주어진 출처를 한 번 조회한다.
   - 저장소·스킬 폴더·SKILL.md 링크 또는 로컬 폴더:
     \`motif skills inspect 'SOURCE' --json\`. GitHub tree/blob 및 raw SKILL.md
     링크도 그대로 전달한다. 링크는 shell 인자로 인용한다.
   - 기존 Claude/Codex 설치본: \`motif skills import claude --json\` 또는
     \`motif skills import codex --json\`. 선택 옵션 없이는 목록만 반환한다.
   - 마켓플레이스에서 특정 항목을 요청하면
     \`motif skills inspect 'SOURCE' --plugin ENTRY --json\`.
     항목 이름을 모르면 \`motif skills marketplace 'SOURCE' --json\`으로 조회한다.
   설치기가 반환한 후보·selectionId·진단을 따른다. 컬렉션에서 사용자가 지정한
   스킬을 선택하며, 여러 후보 중 선택 근거가 없으면 이름을 물어본다. 전체 설치를
   요청하지 않았다면 \`--all\`을 쓰지 않는다. 미지원 링크·모호한 ref 오류는
   설명하고 정확한 저장소/ref/path를 요청한다. 무관한 디렉터리를 찾지 않는다.
3. \`motif skills add 'SOURCE' --skill 'SELECTION_ID' --scope SCOPE --json\`으로
   설치한다. 클라이언트 가져오기는
   \`motif skills import CLIENT --skill 'SELECTION_ID' --scope SCOPE --json\`.
   inspect에 사용한 \`--plugin\`, \`--path\`, \`--ref\`도 동일하게 유지한다.
   기본 SCOPE는 user다. 글로벌·전역·모든 프로젝트·globally 요청도 user로,
   \`~/.motif/\`에 설치해 모든 프로젝트에서 쓰게 한다. 이 프로젝트/저장소만
   요청하면 project다. 전역 스킬 설치에 npm 전역 패키지 설치는 필요 없다.
   명시한 namespace가 있으면 조회·설치에 같은 \`--namespace\`를 적용한다.
   이름 충돌은 원본을 지우지 말고 namespace로 해결한다. \`--dry-run\` 요청은
   미리보기로만 마친다. 같은 출처·선택·범위가 이미 설치되어 있으면 확인만 한다.
4. \`motif skills installed --scope SCOPE --json\`과 \`motif skills list --json\`을
   함께 확인한다. 영수증의 source/ref, 실제 등록 이름·filePath와 진단을 대조한다.
   파일/참고 자료 검증까지 요청했으면 영수증의 snapshot과 relativeFile을 사용해
   해당 파일만 읽는다. snapshot은 user의 \`~/.motif/\` 또는 project의
   \`<작업 디렉터리>/.motif/\` 기준이며, list의 filePath는 절대 경로다.
   설치한 스킬은 현재 세션에 아직 없으므로 skill 도구로
   즉시 호출해 검증하지 않는다.
5. 사용자가 동반 연결·로그인·활성화도 요청했다면 \`motif skills connect '등록 이름' --scope SCOPE --dry-run --json\`으로 실행 명령·주소·필요 환경변수·지원하지 않는 앱 ID를 확인한다. 사용자가 승인한 범위만 선택해 \`motif skills connect '등록 이름' --scope SCOPE --server SERVER --yes --login --json\`을 실행한다. 전체 연결을 요청한 경우에만 \`--all\`을 사용한다. \`--yes\`는 검토한 실행 구성의 승인을 뜻하며, 로그인 동의를 대신하지 않는다. bash \`timeout_s\`는 240을 사용한다. provider 로그인은 브라우저에서 사용자가 진행하고 토큰/인증 코드를 대화로 받지 않는다. 설치만 요청한 경우에는 이 단계를 건너뛴다.
6. 설치 이름·범위·확인 결과와 연결별 상태를 짧게 보고한다. 현재 Motif를 종료·재실행한 뒤
   \`/<등록 이름> 작업\` 또는 \`@skill:<등록 이름> 작업\`으로 사용하도록 안내한다.
   파일 설치는 실제 업무 전체 성공의 증거가 아니다. 외부 실행 파일·MCP·커넥터·
   인증 등 남은 의존성을 알리고, 자격 증명을 복사하거나 plugin hook을 실행하거나
   완전한 Claude/Codex 플러그인 환경이 설치됐다고 말하지 않는다.

갱신·삭제 요청은 먼저 \`motif skills installed --scope SCOPE --json\`으로 확인하고
같은 범위의 \`motif skills update NAME\` 또는 \`motif skills remove NAME\`을 사용한다.
로컬 수정본 보호 오류를 우회하거나 다른 클라이언트 설치를 변경하지 않는다.`,

  /* ---------------------------------------------------------------- */
  `---
name: plugin-setup
description: Install Claude/Codex skill packages, approve their MCP connections and open required browser sign-in — 플러그인 설치·연결·로그인
budget: 1200
tags: setup plugins auth
---
사용자의 플러그인 설치·연결 요청을 Motif CLI로 완료한다. 설명·검토만 요청하면 변경하지 않는다.
1. 이미 설치된 플러그인의 연결·활성화·로그인 요청이고 사용자가 등록 이름/namespace를 주면 \`motif plugins inspect 'NAME' --scope SCOPE --json\`부터 바로 실행하고 3단계의 계획 검토로 이어간다. 이름이 없거나 not_installed이면 \`motif plugins installed --scope SCOPE\`의 간단한 텍스트 목록으로 등록 이름만 확인한다. 이 목록에는 --json을 붙이거나 전체 receipt를 head/tail로 발췌하지 않는다. 원본 캐시·전체 파일시스템·CLI 설치 위치를 탐색하지 않는다. 기존 설치는 원본 SOURCE 탐색·inspect·add·재설치를 생략한다. 새 설치일 때만 \`pwd\`, \`motif plugins --help\`, \`motif skills inspect 'SOURCE' --json\`으로 후보를 확인하고 마켓플레이스 항목은 \`--plugin ENTRY\`를 지정한다. 현재 작업 폴더를 유지한다.
2. 요청한 스킬을 \`motif plugins add 'SOURCE' --skill SELECTION --scope user --json\`으로 설치한다. 패키지 전체를 명시적으로 요청했으면 \`--all\`을 쓴다. 글로벌/전역/모든 프로젝트는 user, 현재 프로젝트만 요청하면 project다. 같은 패키지가 이미 있으면 재설치하지 말고 등록 이름을 사용한다.
3. \`motif plugins inspect '등록 이름 또는 플러그인 namespace' --scope SCOPE --json\`을 실행한다. 명령/주소/필요 환경변수와 unsupported 진단을 확인한다. 이 단계는 실행하지 않는다. 플러그인 hook·agent·호스트 전용 앱 ID는 자동 활성화 대상이 아니므로 연결 성공과 구별한다.
4. 사용자가 연결을 요청했고 실행 계획이 그 범위에 맞으면 \`motif plugins connect NAME --scope SCOPE --server SERVER --yes --login --json\`을 실행한다. 모든 연결이 요청됐을 때만 \`--all\`을 쓴다. bash의 \`timeout_s\`는 240으로 설정한다. \`--yes\`는 검토된 프로세스/연결 실행 승인이며 provider 로그인은 브라우저에서 사용자가 한다. 자동 승인 설정이나 다른 클라이언트의 token/client ID를 복사하지 않는다. 로그인 취소·거절이면 반복 실행하지 말고 남은 상태를 보고한다.
5. 설치·등록·인증·실제 연결을 구별해 결과를 보고하고 끝낸다. \`ready\`는 도구 목록 확인이며 실제 업무 전체 성공이 아니다. partial/unsupported를 모두 성공했다고 바꾸지 않는다. 프로젝트 설정은 반환된 configPath/configHash의 \`--mcp-config PATH --trust-mcp HASH\`로 실행해야 한다. 새 스킬/MCP 등록을 사용하려면 Motif를 재시작한다. 기존 등록의 로그인은 TUI \`/mcp login ID\`로 현재 세션에서 이어갈 수 있다.

MCP-only 패키지 전체 설치는 현재 plugins 명령이 지원하지 않는다. 이 경우 기본 mcp-setup의 명시적 서버 등록 경로를 사용한다. 앱 ID-only 커넥터는 제공자별 adapter가 없으면 원래 호스트가 필요하며, 공개 MCP 대안은 원래 커넥터의 모든 기능과 같다고 주장하지 않는다.`,

];

export const BUILTIN_SKILLS: readonly Skill[] = Object.freeze(
  SOURCES.map((src) => parseSkill(src, "builtin")),
);
