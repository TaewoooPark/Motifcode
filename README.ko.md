<p align="center">
  <img src="docs/logo.svg" alt="motifcode" width="912">
</p>

<p align="center">
  <strong>단 하나의 모델, Motif-3를 위해 만든 코딩 에이전트 하네스.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> &nbsp;·&nbsp; 한국어
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/motifcode?style=flat-square&labelColor=000000&color=333333" alt="npm">
  <img src="https://img.shields.io/github/last-commit/TaewoooPark/Motifcode?style=flat-square&labelColor=000000&color=333333" alt="Last commit">
  <img src="https://img.shields.io/github/actions/workflow/status/TaewoooPark/Motifcode/ci.yml?branch=main&style=flat-square&labelColor=000000&color=333333" alt="CI">
  <img src="https://img.shields.io/badge/license-Apache--2.0-000000?style=flat-square&labelColor=000000&color=333333" alt="Apache-2.0">
  &nbsp;
  <img src="https://img.shields.io/badge/TypeScript-000000?style=flat-square&logo=typescript&logoColor=white&labelColor=000000" alt="TypeScript">
  <img src="https://img.shields.io/badge/Python-000000?style=flat-square&logo=python&logoColor=white&labelColor=000000" alt="Python">
  <img src="https://img.shields.io/badge/Vitest-000000?style=flat-square&logo=vitest&logoColor=white&labelColor=000000" alt="Vitest">
  &nbsp;
  <img src="https://img.shields.io/badge/Motif--3-000000?style=flat-square&labelColor=000000&color=000000" alt="Motif-3">
  <img src="https://img.shields.io/badge/314B--A13B-000000?style=flat-square&labelColor=000000&color=000000" alt="314B-A13B">
  <img src="https://img.shields.io/badge/256K%20context-000000?style=flat-square&labelColor=000000&color=000000" alt="256K context">
  <img src="https://img.shields.io/badge/alpha-000000?style=flat-square&labelColor=000000&color=000000" alt="alpha">
</p>

> **2026년 9월까지 무료.** Motif-3는 [Infron](https://infron.ai)에서 **Motif: Motif 3 (Free)** 로
> 제공됩니다. 입력·출력 모두 100만 토큰당 $0, 262,144 토큰 컨텍스트 전체가 열려 있고,
> 2026년 9월 말까지 무료 제공이 공지되어 있습니다. 계정과 API 키만 있으면 됩니다.
> `npx motifcode`가 키를 물어본 뒤 `motif` 명령까지 설치해 줍니다.
> 조건은 바뀔 수 있으며, [모델 페이지](https://infron.ai/models/motif/motif-3)가 기준입니다.

> **Motif 공식 프로젝트가 아닙니다.** Motifcode는 독립적인 오픈소스 프로젝트입니다.
> 모티프테크놀로지스(Motif Technologies)나 Infron이 인증·보증·후원·관리하는 저장소가
> 아닙니다. *Motif*와 *Motif-3*는 그들의 이름이고, 이 저장소는 그 모델의 클라이언트일 뿐입니다.

Motifcode는 Claude Code의 모양을 한 터미널 코딩 에이전트입니다. 위에는 대화 기록,
아래에는 테두리가 있는 프롬프트, `/` 명령, `@` 멘션, 권한 확인 창, 그리고 뒤에는
`.motif/` 디렉터리가 있습니다. 다만 도구 집합, 프롬프트 배치, 파서, 실패 처리 방식은
전부 **[Motif-3](https://huggingface.co/Motif-Technologies/Motif-3)에 대해 구체적으로
참인 사실들의 결과**이고, 그 대부분은 가정이 아니라 측정으로 얻은 것입니다. 범용
하네스에 base URL만 바꿔 끼운 것이 아닙니다.

> *"하네스는 모델을 감싸는 껍데기가 아니라 모델의 결과물일 때 제 몫을 한다."*

---

## 왜 만들었는가

2026년 8월 18일, 과학기술정보통신부는 **독자 AI 파운데이션 모델** 프로젝트의 2차
단계평가 결과를 발표했습니다. 네 팀이 평가를 받았고 LG AI연구원, SK텔레콤,
업스테이지가 다음 라운드로 올라갔으며, **모티프테크놀로지스는 탈락**했습니다. 네 팀
가운데 벤치마크 점수가 가장 높았는데도요. 차관의 설명은 *"기술력은 뛰어났지만
사용성·활용성 부분에서 다른 기업에 비해 다소 낮은 평가를 받았다"* 는 것이었습니다.
그 일주일 전에 Motif-3는 오픈 웨이트로 공개되어 Artificial Analysis 지능 지수 47점으로
국내 모델 1위를 기록한 참이었습니다.
([디일렉](https://www.thelec.kr/news/articleView.html?idxno=61033),
[비즈한국](https://bizhankook.com/articles/motif-eliminated-doks-round-3-change.html),
[헬로티](https://www.hellot.net/news/article.html?no=114379))

코딩 모델의 *사용성*은 대부분 가중치의 속성이 아닙니다. 모델이 내보낸 도구 호출이
파싱되는가, 프롬프트가 모델 자신의 채팅 템플릿이 기대하는 순서로 배치되는가, 한 번
깨진 턴을 고쳐서 이어 가는가 아니면 그대로 세션이 끝나는가, 손에 쥐어 준 도구가 그
모델이 점수를 냈던 바로 그 도구인가, 그리고 사람 앞에 놓인 터미널이 이미 쓰고 있는
도구들처럼 움직이는가. 이 전부가 하네스의 속성이고, 하네스는 누구나 쓸 수 있습니다.

**Motifcode는 오픈 웨이트 모델이 감점당한 그 사용성을 오픈소스로 충분히 끌어올릴 수
있다는 것을 입증하기 위해 만들어졌습니다.** 이 하네스는 이 모델 하나를 위해 쓰였고,
이 모델을 상대로 측정되었으며, Claude Code의 대화형 세션과 기능 하나하나를 맞대어
검증한 세션을 갖추고 있습니다.

---

## 어떻게 생겼는가

<p align="center">
  <img src="docs/screen-large.jpg" alt="넓은 터미널의 motif: 히어로, 환영 카드, 프롬프트" width="900">
</p>

<p align="center">
  <img src="docs/screen-small.jpg" alt="좁은 터미널의 motif: 작은 히어로" width="900">
</p>

<p align="center">
  <img src="docs/screen-login.jpg" alt="첫 실행: 프롬프트 자리에서 API 키를 물어본다" width="900">
</p>

히어로는 창 너비에 맞춰 바뀌고, 환영 카드는 무엇을 치면 되는지 알려 주며, 첫 실행은
프롬프트 자리에서 키를 물어봅니다. 세션 안에서 내가 친 줄은 `>` 뒤에, 모델의 말과
도구 호출은 `⏺` 뒤에, 결과는 `⎿` 아래에 놓이고, 추론 과정은 요청하지 않는 한
숨겨집니다. 상태 줄은 쓰인 컨텍스트와 서버가 캐시에서 꺼내 준 프롬프트 비율을 보여
줍니다.

---

## 설치와 사용법

**Node 20 이상**이 필요합니다. 패키지는 런타임 의존성이 없는 파일 하나입니다.

```bash
cd your-project
npx motifcode          # 첫 실행: 키를 물어본 뒤 `motif` 명령 설치까지 해 줍니다
```

첫 세션에서 Infron API 키를 한 번만 물어보고 `~/.motif/.env`에 저장합니다. `npx`는
명령을 남기지 않으므로 이어서 `npm install -g motifcode`를 대신 실행해 줄지
물어봅니다. 예라고 하면 그다음부터는 어느 폴더에서든 `motif`(또는 `motifcode`)로
세션을 엽니다. 처음부터 `npm install -g motifcode`를 직접 해도 같은 결과입니다.

| 명령 | 하는 일 |
|---|---|
| `motif` | 현재 디렉터리에서 대화형 세션을 연다 |
| `motif --continue` | 같은 세션을, 이 저장소의 최근 대화를 불러온 채로 연다 |
| `motif "<작업>"` | 작업 하나를 실행하고 종료; `--interactive`를 붙이면 끝난 뒤 세션에 남는다 |
| `motif -p "<질문>"` | 최종 답변만 출력; 스크립트와 파이프용 |
| `motif login` · `motif logout` | 세션 밖에서 키 입력; 저장된 키 삭제 |
| `motif doctor` | 엔드포인트 점검: 인증, 도구 호출·추론 파서, 프리픽스 캐시, 채널 |
| `motif sessions` · `motif resume <file>` | 기록된 세션 목록; 중단된 세션 이어 가기 |
| `motif skills` · `agents` · `plugins` · `config` | 로드된 것들, 그리고 유효한 설정과 각각의 출처 |
| `motif trust` | 이 저장소의 `.motif/settings.json` 훅을 승인 |

플래그: `--model`, `--endpoint`, `--env-file`, `--theme`, `--thinking`,
`--verbose`, `--permissions ask|auto`, `--cwd`, `--channel`, `--max-turns`,
`--max-output-tokens`, `--seed`, `--no-hero`. 전체 목록은 `motif --help`에 있습니다.

---

## Infron에서 API 키 발급하기

Motif-3는 Infron의 OpenAI 호환 엔드포인트로 접근합니다. 설정 전체는 base URL, 모델
id, 키 세 가지입니다.

| | |
|---|---|
| base URL | `https://llm.onerouter.pro/v1` |
| 모델 | `motif/motif-3` |
| 키 | `MOTIF_API_KEY` |

1. **[infron.ai/login](https://infron.ai/login)** 에서 이메일이나 Google로 로그인합니다.
2. **[Dashboard → API Keys](https://infron.ai/dashboard/apiKeys)** 를 열고 **Add new key** 를 누릅니다.
3. `motif`를 실행하고, 물어볼 때 키를 붙여 넣습니다. 토큰 하나짜리 요청으로
   엔드포인트에 확인한 뒤 `~/.motif/.env`에 저장되고(본인만 읽을 수 있는 권한),
   모델에게는 절대 보여 주지 않습니다. 세션 밖에서는 `motif login`이 같은 일을
   하고, 세션 안에서는 `/login`과 `/logout`이 있습니다. 환경 변수의
   `MOTIF_API_KEY`나 프로젝트 옆의 `.env`도 되고, `--env-file <경로>`는 그 파일을
   가장 먼저 읽게 합니다.
4. `motif doctor`가 연결을 확인하고, 서버가 도구 호출과 추론을 어떤 형태로
   돌려주는지와 프리픽스 캐시가 켜져 있는지를 보고합니다.

**2026년 9월까지 무료.** 이 글을 쓰는 시점에 Infron은 이 모델을 *Motif: Motif 3
(Free)* 로, 입력·출력 모두 100만 토큰당 $0로 올려 두었고, 2026년 9월 말까지 무료
제공을 공지했습니다. 현재 조건은 [모델 페이지](https://infron.ai/models/motif/motif-3)와
Infron의 [무료 모델 약관](https://infron.ai/docs/overview/free-models)에서 확인하세요.

`.env` 파일에서는 `MOTIF_*` 키만 읽고, 어느 것도 환경 변수로 내보내지 않으며, 무엇이든
실행되기 전에 하네스 자신의 환경에서도 키를 지웁니다. 모델의 `bash`도, 프로젝트 훅도
키를 볼 수 없습니다.

---

## 명령과 단축키

| 명령 | 하는 일 |
|---|---|
| `/help` | 명령과 단축키 |
| `/status` (`/cost`) | 연결, 설정, 세션 누적치 |
| `/config` | 유효한 설정과 각각의 출처, 설정 파일 |
| `/doctor` | 엔드포인트 점검: 인증, 파서, 캐시, 채널 |
| `/login`, `/logout` | Infron API 키를 붙여 넣어 확인 후 `~/.motif/.env`에 저장; 저장된 키 삭제 |
| `/model [id]`, `/endpoint [url]` | 다음 작업에 쓸 모델 id나 엔드포인트를 보거나 바꿈 |
| `/channel [toolcall\|object\|raw]` | 행동 채널을 보거나 바꿈; 바꾸면 대화가 새로 시작됨 |
| `/max-turns [n]`, `/max-tokens [n\|off]`, `/seed [n\|off]` | 작업당 상한과 샘플링 시드 |
| `/theme [name]` | 색 테마를 보거나, 나열하거나, 바꿈 |
| `/thinking` | 모델의 추론을 보이거나 숨김 |
| `/compact [focus]` | 대화 기록을 모델의 요약으로 대체; 뒤에 쓴 말은 무엇을 남길지 지정 |
| `/compact-at [0.5-1]` | 압축이 실행되는 컨텍스트 비율 (기본 0.75) |
| `/permissions [ask\|auto]` | 명령·쓰기·패치 전에 물을지, 전부 실행할지 |
| `/cwd [path]` | 작업 디렉터리를 보거나 바꿈 |
| `/notes` (`/memory`), `/hooks` | 모든 작업이 읽는 프로젝트 메모; 도구 주변에서 도는 훅 |
| `/skills`, `/agents`, `/plugins` | 로드된 것들; 각 스킬은 `/<skill> [input]`으로도 실행됨 |
| `/new` (`/clear`) | 새 대화 시작; 작업 트리는 건드리지 않음 |
| `/sessions`, `/resume [n\|file]` | 기록된 세션; 그중 하나에서 이어 가기 |
| `/quit` (`/exit`, `/q`) | 종료 |

```
enter send · \ + enter newline · esc interrupt or clear · ctrl-c twice quit · ctrl-d quit
↑ ↓ history · tab show or hide reasoning · ctrl-o full tool output · ctrl-l redraw · shift-tab permissions
@ attach a file · ! run a shell line · # add a project note · / commands · ? hide this
```

---

## 기능

| 영역 | 제공하는 것 |
|---|---|
| 세션 | 모델이 쓰는 대로 답변이 스트리밍됨; 추론은 `--thinking`이나 `/thinking`으로 요청하지 않는 한 대화 기록에 나오지 않음; 도구 호출은 `⏺` 뒤에, 결과는 `⎿` 아래에; 쓰인 컨텍스트와 프리픽스 캐시 비율을 보여 주는 상태 줄 |
| 입력 | `@경로`는 파일이나 디렉터리 목록을 첨부하고 입력 중에 선택 목록이 열림; `@skill:이름`은 스킬 지시문 첨부; `!명령`은 셸 명령을 실행하고 출력을 모델에게 보여 줌; `#메모`는 `.motif/NOTES.md`에 추가; `\` + Enter로 줄바꿈; 긴 붙여넣기는 접힘; 한글 같은 넓은 글자는 표시 폭 기준으로 처리; ↑↓ 히스토리 |
| 명령 | `/`를 치면 모든 설정의 메뉴가 열림; 프롬프트에서 바꾼 설정은 `~/.motif/settings.json`에 저장; 스킬이 곧 명령(`/commit fix the parser`); `?`로 단축키 목록 |
| 권한 | 명령·파일 쓰기·패치·터미널이 실행되기 전에 번호로 답하는 창; "이 도구는 다시 묻지 않기"; 거절하면 모델에게 그 사실이 전달됨; Shift-Tab이나 `/permissions auto`로 전부 자동 실행 |
| 대화 | 각 작업은 앞선 작업들을 전부 봄; `--continue`와 `/resume`으로 기록된 대화를 다시 불러옴; 실행 중에 보낸 메시지는 대기열에; Esc로 중단; 컨텍스트가 창의 `compactAt`을 넘으면 Codex 방식으로 압축(모델이 인수인계 요약을 쓰고 내 메시지는 원문 그대로 남김), `/compact <초점>`으로 직접 실행 |
| 백엔드 | Claude Code의 `.claude/`와 같은 배치의 `.motif/`: 사용자·프로젝트 설정, 스킬, 에이전트, 플러그인, 메모, 작업마다 저널 하나, 히스토리; 프로젝트 훅은 `motif trust`로 승인한 뒤 적용 |
| 스킬과 에이전트 | 내장 스킬 15개(`explore`, `plan`, `explain`, `code-review`, `security-review`, `test-fix`, `debug`, `refactor`, `commit`, `pr-body`, `docs`, `init`, `skill-creator`, `motif-endpoint`, `korean`); 내장 서브에이전트 5개(`explorer`, `reviewer`, `tester`, `planner`, `patcher`)는 도구 목록의 앞부분만 받고 로컬 스케줄러로 돎; Claude Code 배치를 따르는 플러그인 |
| 엔드포인트 | 키는 한 번만 물어보고 `~/.motif/.env`에 저장하며, 에이전트가 실행하는 모든 명령으로부터 차단; 401이면 키의 어느 쪽이 문제인지 알려 줌; 429는 서버의 `Retry-After`에 맞춰 재시도; `motif doctor`가 서버가 실제로 무엇을 내놓는지 보고 |
| 화면 | 사용 도중 창을 줄여도 줄이 남지 않음; 테마 다섯 개(`motif`, `claude`, `mono`, `solarized`, `dracula`)를 제자리에서 교체 |
| 스크립트 | `motif -p "질문"`은 답변만 출력; `motif "작업"`은 작업 하나를 실행하고 종료 |

스킬은 프런트매터(`name`, `description`)와 본문의 지시문으로 된 `SKILL.md`이고,
`$ARGUMENTS`는 명령 뒤에 쓴 말로 치환됩니다. 서브에이전트는 프런트매터 — `name`,
`description`, `tools`(개수, 또는 정해진 순서 목록의 앞부분), `readOnly`, `maxTurns` —
와 본문의 지시문으로 된 마크다운입니다. 플러그인은 `plugin.json`과 자체 `skills/`,
`agents/`를 가진 디렉터리입니다.

```
~/.motif/settings.json      내 기본값: model, endpoint, channel, 예산, theme, thinking, compactAt, permissions
~/.motif/.env               자격 증명
~/.motif/skills/<n>/SKILL.md, ~/.motif/agents/<n>.md      내 것, 모든 프로젝트에서
<repo>/.motif/settings.json 프로젝트의 설정과 훅 — `motif trust`로 승인한 뒤 적용
<repo>/.motif/skills/, agents/, NOTES.md                    프로젝트의 것
~/.motif/plugins/<n>/, <repo>/.motif/plugins/<n>/          plugin.json + skills/ + agents/
<repo>/.motif/sessions/*.jsonl                              작업마다 저널 하나
<repo>/.motif/history.jsonl                                 내가 입력한 것, ↑ 용
```

---

## Motif-3에 맞춰 설계된 지점들

범용 하네스는 모델의 도구 호출이 파싱된다고, 도구 목록을 마음대로 바꿔도 된다고,
추론은 선택 사항이라고 가정합니다. 여기서는 그 어느 것도 성립하지 않고, 하나하나
확인해 보니 각각이 설계 제약이 되었습니다.

| Motif-3에 대한 사실 | 출처 | 강제되는 설계 |
|---|---|---|
| `<tool_call>` 안에 잘못된 JSON을 자주 내보내며, 셸의 `\$`와 정규식의 `\s`에서 깨진다 | 벤더 자신의 vLLM 파서 주석 | 클라이언트 쪽 복구 사다리, 깨짐 예산, 문자열 이스케이프를 아예 피하는 채널 |
| 복구 오라클이 후보를 도구 스키마에 대해 검증한다 | 같음 | 적은 도구, 적은 매개변수, 닫힌 스키마 — 빌드를 실패시키는 린터로 강제 |
| 도구 블록이 시스템 프롬프트 **앞에**, 같은 턴에 렌더링된다 | `chat_template.jinja` | 도구 목록을 세션 동안 고정하고 *정해진 순서로* 유지 |
| 도구 두 개의 순서를 바꾸면 프리픽스 재사용이 **약 24%** 로 떨어진다 | **측정 — `template.test.ts`** | 부분집합은 항상 앞부분(prefix)으로만 취하고 필터로 취하지 않는다. 그래서 `done`이 목록의 맨 앞 |
| 중간 추론은 도구가 등록되어 있을 때 **에만** 렌더링된다 | **측정 — `template.test.ts`** | 도구를 호출하지 않는 채널을 포함해 모든 채널에서 도구를 등록 |
| Terminal-Bench 74.9는 상태 없는 서브셸이 아니라 지속되는 tmux 세션에서 나왔다 | Terminus 2 소스 | `bash` 옆에 `term` 도구 |
| SWE-bench 76.2는 `bash` 도구 하나로 나왔다 | mini-SWE-agent 설정 | 얇은 도구 집합이 타협이 아니라 기준선 |
| 복구 턴 하나가 2비트 양자화 손실을 지운다 | *Half the Experts, All the Code* | 복구 루프는 부가 기능이 아니라 핵심 |

도구 집합은 고정된 순서의 아홉 개 — `done, bash, read, write, apply_patch, term,
skill, task, mcp` — 이고, 서브에이전트는 그 *앞부분*만 받습니다. 서버의 프리픽스
캐시를 따뜻하게 유지하는 방법이자, 어떤 서브에이전트도 다른 서브에이전트를 만들 수
없는 이유이기도 합니다.

모델이 행동을 표현하는 방식은 런타임 스위치이고, 각 선택지는 Motif-3가 공식 점수를
낸 하네스에서 빌려 왔습니다.

| 채널 | 엔드포인트 | 어시스턴트 턴 | 출처 |
|---|---|---|---|
| `toolcall` | `/v1/chat/completions` | 네이티브 `content` + `tool_calls` | SWE-bench Verified **76.2** — mini-SWE-agent |
| `object` | `/v1/completions`, 프롬프트는 여기서 렌더링 | 모델의 JSON 원문 그대로 | Terminal-Bench 2.1 **74.9** — Terminus 2 기본 파서 |
| `raw` | `/v1/completions`, 프롬프트는 여기서 렌더링 | 모델의 XML 원문 그대로 | Terminus 2의 대체 파서 — Motif에서 측정된 적 없음 |

어느 채널이든 모델 자신의 본문은 대화 기록에 원문 그대로 남깁니다. JSON 응답을
행동으로 파싱한 뒤 네이티브 `tool_calls`로 다시 적어 주면, 두 번째 턴부터 모델은
쓰지 말라고 들은 형식을 읽게 되기 때문입니다. 호스팅 엔드포인트에는 `/v1/completions`가
없어서 거기서는 `toolcall`만 동작하고, 나머지 둘은 `--experimental-channel`과
completions 경로가 있는 서버가 필요합니다.

로컬 서버에서 호스팅 서버로 옮기자 결함 주입 테스트가 한 번도 닿지 못했던 결함이
드러났습니다. 도구 호출을 서버가 추출해 주는 경우 네이티브 채널이 어시스턴트 턴을
`tool_calls` 없이 다시 적고 있었던 것으로, 이제 end-to-end 테스트가 와이어에서
확인하는 항목입니다. 루프는 여전히 오작동을 주입해서 테스트합니다. 잘못된 이스케이프,
잘린 도구 호출, 파싱 불가능한 본문, 빈 턴, 죽은 서버는 전부 스위트가 일부러 만들어
내는 결함이고, 실제 모델이 만들어 낸 것들은 그래서 스위트에 들어 있습니다.

### Motif-3 공식 링크

| | |
|---|---|
| 모티프테크놀로지스 | [motiftech.io](https://motiftech.io) |
| 모델 가중치 (MIT) | [huggingface.co/Motif-Technologies/Motif-3](https://huggingface.co/Motif-Technologies/Motif-3) |
| 기술 보고서 | [arXiv:2608.09119](https://arxiv.org/abs/2608.09119) |
| 서빙 포크 (vLLM, `motif` 도구 호출 파서 포함) | [github.com/MotifTechnologies/vllm](https://github.com/MotifTechnologies/vllm) |
| 호스팅 채팅 | [chat.motiftech.io](https://chat.motiftech.io/chat) |
| 여기서 쓰는 호스팅 API | [infron.ai/models/motif/motif-3](https://infron.ai/models/motif/motif-3) |

Motif-3는 총 314B 매개변수에 토큰당 13.2B가 활성화되는 mixture-of-experts 모델로,
라우팅되는 전문가 384개와 네이티브 256K 컨텍스트를 갖습니다. Terminal-Bench 2.1
74.9와 SWE-bench Verified 76.2가 벤더가 공개한 에이전트 벤치마크 점수입니다.

---

## 저장소

```
packages/protocol/   채팅 템플릿 · 도구 호출 복구 · 추론 스크러버 · 채널
packages/tools/      고정된 도구 집합과 린터
packages/core/       에이전트 루프 · 엔드포인트 설정 · 압축 · 깨짐 예산 · 루프 가드
packages/replay/     전송 계층의 기록, 재생, 의도적 파괴
packages/tui/        타입 있는 셀 · 두 영역 스트리밍 · 컴포저 · 메뉴 · 테마
packages/skills/     스킬 레지스트리와 내장 스킬
packages/agents/     서브에이전트 정의와 로컬 스케줄러
packages/hooks/      생명주기 셸 훅
packages/journal/    추가 전용 세션 로그, 재개, 궤적 내보내기
packages/cli/        `motif` 명령, 대화형 세션, 로그인, doctor, 플러그인
packages/eval/       폴리글랏 스위트, 캠페인 러너, 워크트리 채점기
toolkit/             프롬프트 골든(jinja2), 전문가 가지치기 수술, 캠페인 점수표
corpus/              벤더 템플릿 + 생성된 골든
docs/                로고, 스크린샷, 모델 가이드
```

```bash
pnpm install && pnpm typecheck && pnpm build
pnpm test          # 단위, 통합, CLI end-to-end, 설치 스모크
pnpm lint:tools    # 스키마 린터 — 느슨한 스키마가 있으면 빌드 실패
```

릴리스는 두 `package.json`의 `version`과 `packages/cli/src/main.ts`의 `VERSION`을
올려 커밋한 뒤 태그를 푸시하면 됩니다(`git tag v0.3.0 && git push origin v0.3.0`).
릴리스 워크플로가 테스트를 돌리고 npm의 trusted publishing으로 provenance를 붙여
배포하므로 토큰을 어디에도 저장하지 않습니다.

참고한 선행 작업: 세션의 모양은 [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
타입 있는 히스토리 셀·두 영역 스트리밍·압축 인수인계는 [Codex](https://github.com/openai/codex),
승인 대기열과 루프 감지는 [gemini-cli](https://github.com/google-gemini/gemini-cli),
스트리밍 think 스크러버는 [hermes-agent](https://github.com/NousResearch/hermes-agent),
지속 터미널 계약은 [Terminus 2](https://github.com/harbor-framework/terminal-bench-1),
얇은 도구 집합으로 충분하다는 증명은 [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent).

---

## 개발자

**박태우 (Taewoo Park)** — KAIST에서 물리학과 스핀트로닉스를 하며, 과학과 코드를 위한
하네스를 만듭니다. [taewoopark.com](https://taewoopark.com) ·
[GitHub](https://github.com/TaewoooPark) · [X](https://x.com/theoverstrcture) ·
[LinkedIn](https://www.linkedin.com/in/taewoo-park-427a05352)

---

## 라이선스

Apache-2.0. Motif-3의 가중치와 채팅 템플릿은
[Motif-Technologies/Motif-3](https://huggingface.co/Motif-Technologies/Motif-3)의
MIT 라이선스이며, 파생 체크포인트는 그 라이선스를 물려받고 원본을 밝힙니다.
Motifcode는 모티프테크놀로지스나 Infron과 관계가 없습니다.
