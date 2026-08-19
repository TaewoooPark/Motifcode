# model_guide.md — Motif-3 가지치기 작업 인수인계

이 문서는 **새 에이전트 세션에게 이 작업을 통째로 넘기기 위해** 쓰였다. 앞선
대화 맥락을 모른다고 가정하고 읽어도 되게 만들었다. 사실에는 전부 출처를 붙였고,
확인되지 않은 것은 확인되지 않았다고 적었다.

> **작업 전 세 가지 원칙**
>
> 1. **여기 적힌 수치를 다시 유도하지 마라.** 전부 1차 출처에서 확인한 값이고
>    출처를 병기했다. 의심스러우면 출처를 열어 확인하되, 새로 추정하지 마라.
> 2. **퍼플렉시티로 판정하지 마라.** 선행 연구에서 망가진 모델이 멀쩡한 모델보다
>    높은 점수를 받은 사례가 보고됐다. 게이트는 코드 벤치마크와 에이전틱 평가다.
> 3. **임대 GPU를 켜기 전에 오프라인으로 끝낼 수 있는 것을 전부 끝내라.** 준비가
>    덜 된 채 켜면 시간당 요금이 디버깅 비용이 된다.

---

## 0. 한 문단 요약

Motif-3는 314B 파라미터 MoE 모델이고 NVFP4 체크포인트가 **186.9 GB**다. 목표
하드웨어인 GB10(HP ZGX Nano)은 통합 메모리가 **121.6 GiB**라 들어가지 않는다.
전체 파라미터의 **약 98%가 라우팅 전문가**이므로, 용량 문제는 통째로 전문가 뱅크
문제다. 이 작업은 **코딩에 쓰이지 않는 전문가를 골라 잘라내어** 단일 GB10에서
돌아가는 코딩 특화 체크포인트를 만들고, 그것을 이 저장소의 CLI(`motif`)에 붙이는
것이다.

### 첫 한 시간에 할 것

새 세션이라면 여기서 시작하라. 아무것도 망가뜨리지 않고 환경이 살아 있는지 확인하는
순서다.

```bash
# 1. 저장소 테스트가 도는가
cd <저장소>
pnpm install && pnpm test                                   # TypeScript 쪽
cd toolkit/prune && python3 -m unittest test_surgery test_select   # 25개

# 2. 수술 계획이 실제 체크포인트 인덱스와 맞는가
python3 surgery.py --index testdata/motif3-nvfp4.index.json --keep-count 192
#   -> 510 sliced / 51 layers / per layer 10  이 나와야 한다

# 3. 파이프라인이 맞물리는지 합성 데이터로 확인 (모델 불필요)
#    select.py 출력이 surgery.py 입력으로 그대로 들어가는지만 보면 된다
```

그 다음 이 문서에서 **§2를 통째로 읽어라.** 나머지는 필요할 때 돌아와도 되지만 §2는
전제다. §2를 안 읽고 시작하면 이미 답이 나온 것을 다시 유도하게 된다.

**작업 상태를 어디에 적을지 먼저 정하라.** 이 문서는 계획이지 로그가 아니다.
`prune-work/LOG.md` 같은 파일을 만들어 각 단계의 실제 수치·실패·결정을 남겨라.
다음 세션이 그것을 읽는다.

---

## 1. 왜 이 작업을 하는가

### 1.1 산술

| 항목 | 값 | 출처 |
|---|---|---|
| 전체 파라미터 | 314B (토큰당 13.2B 활성) | 모델 카드 |
| 라우팅 전문가 | 384개, top-8, 공유 전문가 1 | `config.json` |
| MoE 레이어 | 51 (dense 2 + MoE 51, 총 53) | `config.json`, 모델 카드 |
| BF16 체크포인트 | 629.7 GB | HF 파일 트리 합계 |
| NVFP4 체크포인트 | **186.9 GB** | HF 파일 트리 합계 |
| GB10 통합 메모리 | **121.6 GiB** | 실측 (2026-08-06) |

전문가 파라미터를 직접 계산하면:

```
레이어당 전문가 하나 = 3 × 4096 × 1280        = 15.73M
레이어당 전문가 전체 = 384 × 15.73M           =  6.04B
51개 MoE 레이어      = 51 × 6.04B             =  308B      ← 전체 314B의 98%
```

나머지(어텐션·dense FFN·공유 전문가·mHC·임베딩·MTP 헤드)를 전부 합쳐도 6B 안팎이다.
**어텐션을 아무리 줄여도 용량 문제는 안 풀린다.** 전문가 말고는 건드릴 곳이 없다.

### 1.2 186.9 GB의 내역

314B를 순수 4비트로 담으면 157 GB인데 실제는 186.9 GB다. 차액 30 GB는:

```
전문가 4비트 가중치                      154.0 GB
전문가 FP8 블록 스케일 (16값당 1)         19.3 GB
비전문가 레이어 bf16 잔류                 13.6 GB
                                        ─────────
                                        186.9 GB
```

즉 줄일 수 있는 곳이 셋이다. 이 작업이 건드리는 것은 첫 두 개(전문가를 통째로
제거하므로 가중치와 스케일이 함께 줄어든다)이고, 세 번째(비전문가 FP8화)는
**속도에 크게 영향을 주므로** P6(§5)에서 선택 항목으로 다룬다.

### 1.3 왜 다른 방법은 안 되는가

이미 검토했고 전부 막혔다. 다시 검토하지 마라.

- **더 낮은 비트 양자화** — Motif-3는 `MotifForCausalLM` 커스텀 아키텍처(GDLA
  어텐션, mHC 잔차, Expert-Specific PolyNorm)라 **llama.cpp/GGUF가 지원하지 않는다.**
  ollama로 애초에 못 띄운다. AWQ·GPTQ·exllama도 마찬가지. 존재하는 양자화 산출물은
  Motif가 자기 vLLM 포크의 자체 스크립트로 만든 NVFP4 하나뿐이다.
- **CPU 오프로드** — GB10은 통합 메모리라 CPU RAM과 VRAM이 **같은 121.6 GiB 풀**이다.
  같은 주머니에서 바이트를 옮길 뿐 용량이 생기지 않는다.
- **NVMe 스트리밍** — 디코드 토큰 하나당 3.2 GB의 전문가를 읽어야 하고 어느 전문가인지는
  토큰마다 바뀐다. 천장이 4~6 tok/s다. 에이전트로 못 쓴다. (단, **프로파일링에는
  쓸 수 있다** — §5 P1 참조.)

---

## 2. 다시 유도하지 말아야 할 사실들

### 2.1 체크포인트 구조 — 실측 확인됨

safetensors 헤더를 range request로 직접 읽어 확인한 실제 shape이다. **레이어당
10개 텐서가 전문가 차원을 갖는다.** (초안에서 6개로 잘못 적었다가 정정한 부분이니
6이라는 숫자를 어디서 보면 무시하라.)

```
moe.experts.gate_up_proj                  U8       [384, 4096, 1280]
moe.experts.gate_up_proj_weight_scale     F8_E4M3  [384, 4096,  160]   블록 스케일
moe.experts.gate_up_proj_weight_scale_2   F32      [384]               전문가별 전역 스케일
moe.experts.down_proj                     U8       [384, 4096,  640]
moe.experts.down_proj_weight_scale        F8_E4M3  [384, 4096,   80]
moe.experts.down_proj_weight_scale_2      F32      [384]
moe.experts.act_fn.weight                          [384, 3]            Expert-Specific PolyNorm
moe.experts.act_fn.bias                            [384, 1]
moe.router.gate.weight                             [384, 4096]
moe.expert_bias                                    [384]               aux-loss-free 선택 편향
```

**열 개 전부 dim 0이 384다.** 전역 스케일 `_2`까지 per-expert라서 keep-list 하나로
전부 슬라이싱된다. 51개 레이어 × 10 = **510회 슬라이스**.

건드리지 않는 것: `shared_experts`(모든 토큰에 대해 항상 실행되므로 라우팅 뱅크가
아니다), 어텐션, mHC, layernorm, MTP 헤드.

이 계획은 저장소에 드라이런으로 검증돼 있다:

```bash
cd toolkit/prune
python3 surgery.py --index testdata/motif3-nvfp4.index.json --keep-count 192
# experts 384 -> 192 (50.0% kept) / MoE layers 51 / tensors 510 sliced of 2440 / per layer 10
```

### 2.2 라우터 내부 — 프로파일링 훅 지점

`modeling_motif.py`에서 확인:

- `MoE.forward` (약 997행)이 `self.router(x, self.expert_bias)`를 호출하고
  `(top_scores, selected_experts_indices, num_tokens_per_expert)`를 받는다.
- `TokenChoiceTopKRouter.forward` (약 825행):
  - `scores = sigmoid(F.linear(x, gate.weight))`
  - **선택은** `topk(scores + expert_bias)` — 부하균형 편향이 들어간다
  - **반환되는 top_scores는** `scores.gather(...)` — 편향이 **안** 들어간 원 시그모이드
  - 이후 `route_norm`으로 선택된 k개에 대해 정규화하고 `route_scale`(2.0)을 곱한다

**이 비대칭이 프로파일링 설계를 정한다.** 선택 빈도(count)는 부하균형 편향을 반영하고,
게이트 질량(mass)은 반영하지 않는다. 둘 다 수집해야 한다. §5 P1.

### 2.3 부하 균형 — 빈도로 고르면 안 되는 이유

기술 보고서 §5.1.2에 따르면 SFT 단계에서 aux-loss-free 전문가 선택 편향(계수 1×10⁻⁴)과
시퀀스 단위 부하균형 손실을 걸었다. **의도적으로 전문가 사용률을 균등하게 만들었다는
뜻이고, 따라서 "거의 안 쓰이는 전문가"는 존재하지 않는다.**

순진하게 사용 빈도로 순위를 매기면 노이즈를 얻는다. 반드시 **도메인 대조**로 가야
한다 — 목표 코퍼스(에이전틱 코딩)와 참조 코퍼스(일반 대화·추론·한국어)의 비율.

### 2.4 선행 연구 — 알고 시작해야 할 네 가지

**"Half the Experts, All the Code: One-Shot Domain Pruning of Mixture-of-Experts
LLMs for Coding"** ([arXiv:2607.16721](https://arxiv.org/abs/2607.16721), 2026-07)

1. **전문가 절반을 제거해도 주 코드 벤치마크에 통계적으로 유의한 손실이 없었다.**
   손상은 거의 전부 코딩 **외** 능력에 떨어졌다 — 우리가 원하는 거래 그대로다.
2. **승리 전략이 모델 계열 간에 뒤집혔다.** 한 계열에서 검증된 레시피가 다른
   계열에서 통한다고 가정할 수 없다. → 기준을 여러 개 만들어 전부 재라. §5 P2.
3. **3비트 교차점.** 같은 메모리 예산이면 양자화가 먼저다. 가지치기가 이기는 구간은
   양자화가 3비트 아래로 내려가야 하는 경우뿐이다.
4. **에이전틱 평가에서 수리 턴 하나가 2비트 양자화 페널티를 통째로 지웠고, 압축된
   모델일수록 회복 폭이 컸다.** 단발 벤치마크는 압축 손해를 과대평가한다.
   → 우리 하네스에 수리 루프가 코어로 들어가 있는 이유이자, 평가 시 반드시 수리 턴을
   준 조건을 병행해야 하는 이유. §6.3.

**주의:** 그 논문의 대상은 35B·26B 모델이었다. **314B·384전문가 규모에서 같은
비율이 성립하는지는 아무도 확인한 적이 없다.** 이 작업이 그걸 확인하는 일이다.

### 2.5 GB10 서빙 환경 — 미해결 이슈

vLLM은 aarch64 휠을 배포하지만 **GB10(sm_121) 지원은 미병합 PR 상태**였다
(2026-08 확인). 그리고 열린 버그가 하필 이 조합을 정면으로 때린다:

| 이슈 | 영향 |
|---|---|
| NVFP4 crash on ARM64 GB10 (CUDA illegal instruction) | **직격** — 우리 체크포인트가 NVFP4다 |
| EngineCore fatal errors on sm_121 | 런타임 안정성 미확보 |
| Sleep mode crash (unified memory) | 통합메모리 경로 미성숙 |
| SM121 build targets 미병합 | 직접 빌드 필요, Motif 포크에 별도 이식 |

**작업 착수 전 이 상태를 다시 확인하라.** 몇 달 지났으면 해결됐을 수 있다.
해결됐다면 §7이 훨씬 쉬워진다.

### 2.6 통합 메모리의 위험

GB10은 과할당이 `CUDA out of memory`로 깔끔하게 실패하지 **않는다.** 호스트 RAM을
계속 먹다가 커널 OOM 킬러가 뜬다. 이미 겪은 사례: 114 GiB 점유, 로드애버리지 43.6,
박스 거의 접속 불가. **KV 캐시를 반드시 명시적으로 캡하라.**

---

## 3. 목표 사양과 유지 비율

### 3.1 무엇을 만드는가

- 이름: `Motif-3-Coder-A13B-NVFP4` (가칭)
- 전문가: 384 → **192** (50%)
- 가중치: **약 100.2 GB = 93.3 GiB**
- 컨텍스트: **256K 유지** (아래 계산 참조)
- 활성 파라미터: **변화 없음** (여전히 top-8) → 연산량과 디코드 속도 불변
- 라이선스: MIT 상속

### 3.2 왜 하필 50%인가 — GB10이 사실상 강제한다

유지 비율별로 계산하면:

| 유지 | 전문가 4bit | 스케일 | 비전문가 bf16 | 합계 | GiB | GB10 적재 |
|---:|---:|---:|---:|---:|---:|:--|
| 100% | 154.0 | 19.3 | 13.6 | 186.9 GB | 174.1 | ✗ 1.59× 초과 |
| 75% | 115.5 | 14.4 | 13.6 | 143.5 GB | 133.7 | ✗ 초과 |
| 62.5% | 96.3 | 12.0 | 13.6 | 121.9 GB | 113.5 | △ 들어가나 KV 여유 8 GiB |
| **50%** | **77.0** | **9.6** | **13.6** | **100.2 GB** | **93.3** | **✓ 여유 28 GiB** |
| 37.5% | 57.8 | 7.2 | 13.6 | 78.6 GB | 73.2 | ✓ 여유 큼 |

50% 기준 KV 여유 계산:

```
121.6 GiB (총) − 93.3 (가중치) = 28.3 GiB
  − headless OS       ~3 GiB
  − 엔진/CUDA/워크스페이스 ~8 GiB
  ────────────────────────────
  KV + 마진            ~17 GiB
  = 18.6 GB ÷ 61 KB/token ≈ 305K 토큰 → 256K 전체 컨텍스트 수용
```

KV가 토큰당 61 KB인 근거: MLA 압축이라 `kv_lora_rank` 512 + `qk_rope_head_dim` 64
= 576 값/레이어, × 53 레이어 × 2 바이트. 인터리브드 sliding-window 레이어는 이보다
적게 쓰므로 **상한**으로 봐야 한다.

**결론: 75%는 GB10에 안 들어가고 62.5%는 위험하다. GB10을 목표로 하는 한 실질적으로
50%가 상한이다.** 그리고 그 지점이 마침 선행 연구가 "절반은 제거 가능"이라고 보고한
지점이다. 운이 좋은 것이지 보장은 아니다.

**50%가 실패하면 GB10은 탈락이다.** §8의 대체 경로로 간다.

### 3.3 속도는 가지치기로 안 변한다

활성 파라미터가 그대로이므로 디코드 속도도 그대로다. 가지치기는 **용량을 사는 것이지
속도를 사는 것이 아니다.**

GB10 실효 대역폭 약 210 GB/s(qwen3:8b 43.6 tok/s 실측에서 역산) 기준:

```
비전문가 bf16 그대로   16.1 GB/token → ~13 tok/s
비전문가 FP8          10.1 GB/token → ~21 tok/s
전 계층 4비트          7.4 GB/token → ~28 tok/s
참고: Codex 실사용 디코드 중앙값 33 tok/s
```

**비전문가 레이어를 FP8로 내리는 것이 속도에 가장 크게 기여한다.** 가지치기 후에는
매 토큰 읽는 16.1 GB 중 12 GB가 어텐션이다. 이 작업은 P6(§5)에서 다룬다.

---

## 4. 저장소에 이미 있는 것

전부 `toolkit/prune/`에 있다. 실행 가능하고 단위 테스트가 붙어 있다.

| 파일 | 상태 |
|---|---|
| `surgery.py` | 계획 수립 + 실제 체크포인트 쓰기. 합성 데이터로 테스트됨. **실제 가중치에 돌린 적 없음** |
| `profile.py` | 라우팅 통계 수집기. 훅 지점은 소스에서 확인했으나 **실행된 적 없음** |
| `select.py` | keep-list 선택. 합성 프로파일로 11개 테스트 통과 |
| `verify.py` | **정합성 검증**(§6.1). 원본 라우터를 keep-list 안으로 가두고 가지친 모델과 대조. **실행된 적 없음** |
| `test_surgery.py` | 14개 테스트. 실제 인덱스에 대한 레이아웃 검증 포함 |
| `test_select.py` | 11개 테스트 |
| `testdata/motif3-nvfp4.index.json` | 실제 NVFP4 체크포인트 인덱스 (커밋됨) |

```bash
cd toolkit/prune
python3 -m unittest test_surgery test_select   # 25 tests
```

**중요:** `surgery.py`의 `apply_surgery()`와 `profile.py` 전체는 **실제 가중치에
한 번도 돌지 않았다.** 첫 실행 때 반드시 §6.1의 정합성 검증을 먼저 하라.

---

## 5. 작업 순서

각 단계에 **산출물**, **게이트**, **실패 시 대응**이 붙어 있다. 게이트를 통과하지
못하면 다음 단계로 가지 마라.

### 대략의 시간 감각

정확한 견적이 아니라 계획을 세우기 위한 자릿수다. 실제 값은 `prune-work/LOG.md`에
남겨 다음 세션이 쓰게 하라.

| 단계 | 규모 |
|---|---|
| P0 체크포인트 다운로드 | 회선 나름, 수 시간 |
| P1 프로파일링 (GB10 오프로드) | 5만 토큰 기준 수 시간~하룻밤 |
| P1 프로파일링 (임대) | 로딩 포함 1~2시간 |
| P2 keep-list 생성 | 분 단위, 노트북 |
| P3 수술 | 디스크 I/O 바운드, 수십 분 |
| P3 정합성 검증 | 두 모델 로딩이 지배, 수십 분 |
| P4 SWE-bench | 과제당 최대 4시간 타임아웃 × 세트 크기 |
| P5 GB10 브링업 | **가장 불확실.** 며칠을 각오하라 |

**임대를 쓸 거라면 P1과 P4의 기준선 측정을 한 세션에 몰아라.** 187 GB 로딩이 매번
든다.


### P0 — 오프라인 준비 (기계 불필요)

1. §2.5의 vLLM GB10 이슈 현황을 다시 확인한다. 해결됐는지가 §7의 난이도를 좌우한다.
2. **체크포인트를 받는다.** `Motif-Technologies/Motif-3-NVFP4`, 186.9 GB, 165개 파일.
   회선에 따라 몇 시간 걸린다. **먼저 걸어두고 나머지를 하라.** 수술 결과를 쓸 공간까지
   같은 볼륨에 원본 크기만큼 더 필요하다(총 ~375 GB). ZGX는 3.4 TB 여유가 있다.

   ```bash
   huggingface-cli download Motif-Technologies/Motif-3-NVFP4 \
     --local-dir /mnt/nvme/Motif-3-NVFP4
   ```

3. 코퍼스 두 벌을 만든다.

**목표 코퍼스 T (에이전틱 코딩).** 가장 좋은 것은 **이 하네스가 실제로 만든 궤적**이다.
`motif` 세션이 `.motif/sessions/*.jsonl`에 저장하고 `motif distil`이 성공 궤적만
뽑아준다. 아직 세션이 없다면 SWE 계열 공개 과제의 문제·패치·테스트 출력으로 시작하되,
궤적이 쌓이면 다시 프로파일링하는 것을 계획에 넣어라.

**참조 코퍼스 R (일반).** 일반 대화, 수학·과학 추론, 한국어 산문. 목표 코퍼스와
**겹치지 않아야** 대조가 의미를 갖는다.

각각 5만 토큰 정도면 충분하다. 형식은 `.jsonl`(`text` 필드) 또는 빈 줄로 나눈 `.txt`.

> **작업 산출물은 전부 `prune-work/` 아래에 둔다.** 저장소 루트의 `corpus/`는 이미
> 채팅 템플릿 골든 픽스처가 쓰고 있으니 거기에 코퍼스를 넣지 마라. `prune-work/`도
> gitignore에 넣어라 — 프로파일은 수십 MB, 체크포인트는 수백 GB다.

- **산출물**: `prune-work/corpus/target.jsonl`, `prune-work/corpus/reference.jsonl`
- **게이트**: 두 코퍼스가 주제상 확실히 다른가. 같으면 대조가 0을 낸다.

### P1 — 라우팅 프로파일링

이 단계만이 **전체 187 GB 모델의 순전파**를 요구한다.

**어디서 돌릴 것인가 — 두 가지 선택지**

**(a) GB10 + 디스크 오프로드 — 먼저 시도할 것.**
`modeling_motif.py`에 `_no_split_modules = ["MotifDecoderLayer"]`가 선언돼 있어
accelerate가 레이어를 NVMe에서 스트리밍할 수 있다. 프로파일링은 **오프라인이고 지연에
민감하지 않다** — 수만 토큰을 몇 시간에 걸쳐 처리하면 되고 아무도 기다리지 않는다.
초당 몇 토큰이면 충분하다. 성공하면 임대 비용이 0이 된다.

```bash
python3 toolkit/prune/profile.py \
  --model /path/to/Motif-3-NVFP4 \
  --corpus prune-work/corpus/target.jsonl --name target \
  --offload-folder /mnt/nvme/motif-offload \
  --max-tokens 50000 --out prune-work/profiles/target.json
```

ZGX는 디스크 3.4 TB 여유가 있으므로 오프로드 폴더 공간은 문제없다. **메모리 캡을
반드시 걸어라**(§2.6).

**(b) 임대 GPU.** (a)가 실패하거나 너무 느리면. 이때 SWE-bench 기준선 측정(§6.2)과 **같은 세션에서 연속으로** 돌려 187 GB 로딩
비용을 한 번만 내라. 임대를 두 번 켜면 로딩만 두 번 낸다.

**수집하는 것**

레이어별 × 전문가별로 두 가지:
- `count` — 선택 횟수 (부하균형 편향 포함)
- `mass` — 게이트 가중치 합 (편향 미포함)

§2.2의 비대칭 때문에 둘 다 필요하다.

- **산출물**: `prune-work/profiles/target.json`, `prune-work/profiles/reference.json`
- **게이트**: 각 파일의 `tokens`가 목표치에 도달했는가. 레이어 51개가 전부
  기록됐는가. 어느 레이어에서 count 합이 `tokens × 8`과 크게 다르면 훅이 일부
  호출을 놓친 것이다 — 고치고 다시 돌려라.
- **실패 시**: (a)가 안 되면 (b). (b)도 예산이 안 되면 목표 토큰 수를 1만으로 줄여
  본다. 대조 신호는 생각보다 적은 토큰에서도 나온다.

### P2 — keep-list 생성 (오프라인)

순수 데이터 처리라 노트북에서 끝난다.

```bash
for crit in count mass blend; do
  for ratio in 0.75 0.5 0.375; do
    python3 toolkit/prune/select.py \
      --target prune-work/profiles/target.json --reference prune-work/profiles/reference.json \
      --criterion $crit --keep-ratio $ratio \
      --out prune-work/keeps/${crit}-${ratio}.json
  done
done
```

**기준을 하나만 만들지 마라.** §2.4-2의 이유로 3기준 × 3비율 = 9개를 만들어 곡선을
본다. `--global-alloc`도 한 번 돌려 레이어별 할당과 비교하라.

- **산출물**: `prune-work/keeps/*.json` 9개 이상
- **게이트**: `select.py`가 출력하는 요약에서 `shared across every layer` 값을 보라.
  이 값이 유지 개수와 거의 같으면(= 모든 레이어가 같은 전문가를 남겼으면) 대조가
  레이어 구분을 못 하고 있다는 뜻이다. 코퍼스를 의심하라.
- **실패 시**: 세 기준이 전부 균등 무작위와 구별되지 않으면 **가지치기 자체를 포기할
  근거**다. 무작위 keep-list를 대조군으로 만들어 P3에서 함께 평가하라.

### P3 — 수술

```bash
python3 toolkit/prune/surgery.py \
  --index /path/to/Motif-3-NVFP4/model.safetensors.index.json \
  --keep prune-work/keeps/blend-0.5.json \
  --src /path/to/Motif-3-NVFP4 \
  --dst /path/to/Motif-3-Coder-A13B-NVFP4 \
  --apply
```

디스크는 원본 크기만큼 더 필요하다(187 GB). 메모리는 샤드 하나씩 처리하므로 몇 GB면
된다.

- **산출물**: 새 체크포인트 디렉터리 (config·토크나이저·템플릿 포함)
- **게이트**: **정합성 검증을 반드시 통과할 것.** 품질을 재기 전에 "수술이 모델을
  망가뜨리지 않았는가"부터 확인해야 한다.

```bash
python3 toolkit/prune/verify.py \
  --original /path/to/Motif-3-NVFP4 \
  --pruned   /path/to/Motif-3-Coder-A13B-NVFP4 \
  --keep     prune-work/keeps/blend-0.5.json
```

  `PASS`가 아니면 §6.1을 읽고 원인을 잡아라. 품질 평가는 그 다음이다.

### P4 — 검증

§6 전체가 이 단계다. 게이트: **50% 유지에서 코드 성능에 통계적으로 유의한 손실이
없을 것.**

- **실패 시**: 75%로 후퇴한다. 단 75%는 GB10에 안 들어가므로(§3.2) 그 시점에 목표
  하드웨어가 바뀐다. §8로.

### P5 — 회복 튜닝 (선택)

손실이 남으면 가벼운 파인튜닝으로 절반쯤 회복한다는 보고가 있다(§2.4-1 논문).
`motif3-training-example`(torchtitan 기반)이 공개돼 있다. **라우터는 동결한 채**
진행한다 — Motif 자신의 SWE 교사 레시피와 같은 방식이다(기술 보고서 §5.2.3).

P4를 통과하면 건너뛴다.

### P6 — 비전문가 레이어 FP8화 (선택, 속도용)

**용량이 아니라 속도를 위한 작업이다.** 가지치기 후에도 매 토큰 읽는 16.1 GB 중
12 GB가 bf16 어텐션이므로, 여기가 병목이 된다(§3.3).

Motif 모델 카드가 **온라인 block-fp8 양자화**를 지원한다고 밝히고 있다:

```
--quantization modelopt_blockfp8
```

체크포인트를 바꾸지 않고 서버 플래그만으로 되는 길이므로 **가장 먼저 시도할 것.**
다만 그 안내는 BF16 체크포인트를 전제로 쓰였고, **NVFP4 체크포인트에서 전문가는 이미
NVFP4인 상태로 비전문가만 fp8로 내려가는 조합이 성립하는지는 확인된 바 없다.**
충돌하거나 무시될 수 있다.

- **시도 순서**: ① 플래그만 붙여 기동 → ② `motif doctor`와 짧은 세션으로 정상
  동작 확인 → ③ tok/s 측정해 §3.3의 예상(13 → 21 tok/s)과 대조
- **게이트**: 출력 품질이 §6.2 기준선 대비 유의하게 나빠지지 않을 것. 속도만 보고
  품질을 안 재면 조용히 나빠진 모델을 쓰게 된다.
- **실패 시**: 플래그가 안 먹으면 그냥 포기하라. 13 tok/s도 못 쓸 속도는 아니고,
  체크포인트를 직접 재양자화하는 것은 이 작업의 범위를 크게 벗어난다.

---

## 6. 무엇을 어떻게 테스트하는가

### 6.1 정합성 먼저 — 품질은 그 다음

**이것을 건너뛰지 마라.** 수술 버그와 품질 손실은 증상이 비슷하지만 원인이 완전히
다르고, 순서를 지키면 구분할 수 있다.

**정합성 테스트.** `toolkit/prune/verify.py`가 구현하고 있다. 원본 모델의 라우터를
바꿔 **제거된 전문가의 점수에 -inf를 더한 뒤** top-8을 뽑게 한다. 그러면 원본은
keep-list 안에서만 라우팅한다. 같은 입력에 대해 가지친 모델과 로짓을 비교한다.

두 모델이 일치해야 하는 이유는 근사가 아니라 정확하다:

- **선택** — 가지친 라우터의 gate 행은 원본 gate의 유지된 행이고 `expert_bias`도
  같은 인덱스로 잘린 것이다. 따라서 `topk(scores + bias)`가 훑는 값이 동일하고 같은
  전문가를 고른다.
- **게이트 가중치** — `top_scores`는 원 시그모이드에서 gather되고 `route_norm`이
  선택된 k개에 대해 정규화한다. 같은 k, 같은 값, 같은 분모.
- **전문가 가중치** — 가지친 전문가 j는 원본 전문가 keep[j] **그 자체**다.

**판정 기준:**
- 다음 토큰 argmax가 **모든 위치에서 일치**해야 한다. 타협 불가.
- 로짓 최대 절대 오차는 작아야 하지만 **비트 단위 동일을 요구하지 마라.**
  `num_experts`가 달라지면 fused MoE 커널이 다른 경로를 탈 수 있다. 1e-2 수준이면
  정상, 1e+0 수준이면 버그다. `verify.py`의 기본 허용치는 5e-2다.

**argmax가 하나라도 어긋나면 수술 버그다.** keep-list 정렬, 텐서 10개 전부 슬라이싱
됐는지, `expert_bias`와 `act_fn.weight/bias`를 빠뜨리지 않았는지 확인하라.

### 6.2 코드 성능 — 1차 게이트

**퍼플렉시티 금지.** §2.4-3.

측정할 것:
- SWE-bench Verified (mini-SWE-agent 하네스, 16K 토큰/스텝, 250스텝, 4시간 타임아웃 —
  Motif 공식 평가 설정과 동일하게)
- 원본 대비 신뢰구간을 붙여 보고하라. "76.2 → 74.8"은 손실인지 노이즈인지 알 수 없다.

**비교 대상을 반드시 포함:**
1. 원본 Motif-3 (기준선)
2. 가지친 모델 (기준 3종 × 비율 3종)
3. **무작위 keep-list 대조군** — 대조 선택이 무작위보다 나은지 확인하는 유일한 방법

### 6.3 에이전틱 평가 — 반드시 병행

§2.4-4 때문이다. 단발 벤치마크만 보면 **과도하게 보수적인 결정**을 하게 된다.

수리 턴을 준 조건에서 다시 재라. 이 저장소의 하네스가 그 조건을 이미 구현하고 있다 —
`packages/core/src/loop.ts`의 수리 루프가 도구 실패·테스트 실패 시 실행 출력을
구조화해 되먹인다.

```bash
motif "<SWE 과제>" --endpoint <서버> --model <가지친 모델> --max-turns 100
motif distil .motif/sessions   # 성공률과 파손율 집계
```

**보고할 지표:**
- 단발 통과율
- 수리 턴 1회 허용 시 통과율
- 그 **차이** — 압축 모델일수록 커야 한다. 안 커지면 논문의 관찰이 이 규모에서
  성립하지 않는다는 뜻이고, 그 자체가 결과다.

### 6.4 코딩 외 손실 — 측정하되 실패로 치지 않는다

의도한 거래다. 하지만 **모델 카드에 정직하게 기재해야 하므로** 반드시 측정하라.
GPQA Diamond, IFBench, 한국어 응답 품질 정도면 충분하다.

### 6.5 GB10 실측

§7 이후:
- 실제 디코드 속도 (tok/s)
- 최대 컨텍스트에서의 메모리 점유
- 장시간 세션 안정성 (EngineCore 크래시 빈도)

---

## 7. GB10 서빙 브링업

가장 불확실한 구간이다. 넉넉히 시간을 잡아라.

### 7.1 순서

1. **vLLM aarch64 휠 설치.** PyPI에 `manylinux_2_28_aarch64` 휠이 있다.
2. **SM121 패치 확인/이식.** §2.5. 미병합이면 해당 PR을 Motif 포크에 체리픽해야 한다.
3. **Motif 포크의 커스텀 커널 빌드.** `motif_fused_poly_quant_kernel.cu`, DeepGEMM,
   FlashAttention-MLA 백엔드를 GB10 컴퓨트 케이퍼빌리티로 컴파일.
4. **NVFP4가 도는지 확인.** 첫 관문이자 미해결 버그가 있는 지점.
5. **메모리 캡을 걸고 기동.**

ZGX에는 torch가 아직 안 깔려 있고 ARM64 + CUDA 13 조합이 만만치 않다고 기록돼 있다.
여기서 시간이 걸릴 것을 전제하라.

### 7.2 기동 명령 (출발점)

Motif 공식 H200 예시를 GB10 단일 장비용으로 줄인 것이다. **그대로 쓰지 말고
메모리를 재면서 조정하라.**

```bash
vllm serve /path/to/Motif-3-Coder-A13B-NVFP4 \
  --trust-remote-code \
  --tool-call-parser motif \
  --reasoning-parser motif \
  --enable-auto-tool-choice \
  --enable-prefix-caching \
  --speculative-config '{"model": "/path/to/Motif-3-Coder-A13B-NVFP4", "num_speculative_tokens": 1}' \
  --tensor-parallel-size 1 \
  --dtype bfloat16 \
  --max-model-len 262144 \
  --gpu-memory-utilization 0.80 \
  --host 0.0.0.0 --port 8080
```

각 플래그가 왜 필요한지는 `motif doctor`가 설명한다. 요약:

- `--tool-call-parser motif` — **없으면 툴콜 JSON이 깨진 턴이 통째로 버려진다.**
  이 모델은 그걸 자주 만든다. 하네스가 조용히 실패한다.
- `--reasoning-parser motif` — 생성 프롬프트가 항상 `<think>`를 열어두므로 서버가
  추론과 내용을 분리해야 한다.
- `--enable-prefix-caching` — 하네스가 도구 목록을 얼리고 정규 순서로 고정하는 이유가
  이 캐시를 살리기 위해서다. 꺼져 있으면 그 설계가 아무것도 사지 못한다.
- `--speculative-config` — 체크포인트에 MTP 헤드가 있어 자체 추측 디코딩이 공짜다.
- `--gpu-memory-utilization` — **통합 메모리라 과할당이 OOM 킬러로 간다.** 0.80에서
  시작해 실측하며 올려라.

### 7.3 알아둘 함정

- **어텐션 백엔드.** Motif 공식 H200 예시는 `--attention-backend FLASH_ATTN_MLA`를
  쓴다. GB10에서 그 커널이 빌드·동작하는지는 확인된 바 없다. 안 되면 백엔드를 빼고
  기본값으로 먼저 뜨는지 보라 — 느려도 도는 것이 먼저다.
- **`--tensor-parallel-size 1`.** GB10은 한 장이다. 공식 예시의 `--data-parallel-size 8`
  이나 `--enable-expert-parallel`을 따라 붙이지 마라.
- **첫 기동은 짧은 컨텍스트로.** `--max-model-len 262144`로 바로 시작하면 KV 캐시
  할당에서 OOM 킬러를 만나기 쉽다. 32768로 떠보고 늘려가라.

### 7.4 검증

```bash
motif doctor --endpoint http://zgx-1c3b:8080
```

`endpoint`·`model`·`model family`·`context length`가 ✓여야 한다. 나머지 넷은 API가
보고하지 않으므로 `?`로 나오는 게 정상이다 — 명령줄과 대조해 직접 확인하라.

---

## 8. 실패 시 대체 경로

### 8.1 50% 가지치기가 품질 게이트를 통과 못 하면

75%로 후퇴한다. **가중치 143.5 GB = 133.7 GiB라 GB10에는 안 들어간다.** 목표
하드웨어가 바뀐다:

- **소비자 데스크톱 + FreeToken.** RTX 5090 32GB + DDR5 256GB. 전문가 풀이 호스트
  RAM에 들어가고 VRAM이 LRU 캐시가 된다.
  [FreeToken](https://arxiv.org/abs/2608.16157)이 DeepSeek-V4-Flash(284B-A13B)를
  RTX 5090에서 22~25 tok/s로 서빙했다. **Motif-3는 314B-A13.2B로 형상이 거의 같다.**
  단 FreeToken은 `Linux x86_64` 요구라 ZGX에서는 못 쓴다.
- **단일 H200 임대.** 가지친 100 GB 체크포인트는 H200 한 장(141 GB)에 들어간다.
  공식 8×H200 구성 대비 1/8 규모다.

**어느 쪽이든 가지치기 작업은 낭비되지 않는다.** 더 작은 체크포인트는 모든 경로에서
유리하다.

### 8.2 GB10에서 vLLM NVFP4가 안 돌면

8.1과 같은 대체 경로. 체크포인트는 그대로 쓸 수 있다.

### 8.3 세 기준이 전부 무작위와 구별되지 않으면

가지치기를 포기하고 §1.3의 다른 경로를 재검토한다. 다만 그 경로들은 이미 막혀 있으므로,
실질적으로는 "GB10에서 Motif-3를 돌리는 것을 포기하고 데스크톱/임대로 간다"가 된다.

---

## 9. CLI에 붙이기 — 최종 단계

가지친 모델이 나왔다고 끝이 아니다. 이 저장소의 `motif`가 그것을 알아보고 잘 쓰게
만들어야 한다.

### 9.1 그냥 쓰는 법

붙이는 데 코드 변경이 필요 없다. 하네스는 OpenAI 호환 엔드포인트를 말하므로 서버만
떠 있으면 된다.

```bash
motif "테스트가 깨진 이유를 찾아서 고쳐줘" \
  --endpoint http://zgx-1c3b:8080 \
  --model /path/to/Motif-3-Coder-A13B-NVFP4

# 또는 환경변수로 고정
export MOTIF_ENDPOINT=http://zgx-1c3b:8080
export MOTIF_MODEL=/path/to/Motif-3-Coder-A13B-NVFP4
motif doctor
motif "..."
```

아래 9.2~9.4는 **그 위에 얹는 마감 작업**이지 동작 전제가 아니다.

### 9.2 채널 A/B를 다시 재라

이건 놓치기 쉬우니 명시한다. 하네스에는 액션 채널이 셋 있고
(`toolcall` / `object` / `raw` — `README.md` 참조), **어느 것이 Motif-3에서 가장 좋은지는
아직 아무도 측정하지 않았다.** 그리고 가지치기가 그 답을 바꿀 수 있다 — 툴콜 JSON을
만드는 능력이 코딩 외 능력에 얹혀 있었다면 잘려나갔을 수 있기 때문이다.

```bash
for ch in toolcall object raw; do
  motif "<동일 과제>" --channel $ch --model <가지친 모델> --endpoint <서버>
done
motif distil .motif/sessions    # 채널별 파손율·성공률 비교
```

**원본과 가지친 모델 양쪽에서 재라.** 채널 순위가 뒤바뀌면 그 자체가 가지치기가
무엇을 잘라냈는지에 대한 증거다.

### 9.3 체크포인트 쪽

`surgery.py`가 `config.json`에 이미 표식을 남긴다:

```json
{
  "num_experts": 192,
  "experts_top_k": 8,
  "motifcode": { "pruned_from": 384, "pruned_to": 192 }
}
```

`experts_top_k`는 **건드리지 않는다.** 가지치기는 전문가가 몇 개 존재하는지를 바꾸지,
토큰당 몇 개를 참조하는지를 바꾸지 않는다.

### 9.4 `motif doctor` 확장

`packages/cli/src/doctor.ts`에 추가할 것:

1. **가지친 체크포인트 인식.** `/v1/models`로는 `config.json`을 못 읽으므로, 모델
   이름에 `Coder`가 들어가는지 또는 사용자가 `--checkpoint <path>`로 알려주는지로
   판단하고, 그 경우 `pruned_from`/`pruned_to`를 보고한다.
2. **GB10 감지 시 안내.** 이미 `deviceMemoryBytes` 인자를 받고 있고 200 GiB 미만이면
   경고와 함께 가지친 체크포인트를 권한다. GB10에서 원본을 올리려다 OOM 킬러를 만나는
   사고를 막는 장치다.
3. **메모리 여유 실측.** 가능하면 `nvidia-smi` 또는 `/proc/meminfo`로 실제 여유를 읽어
   `--gpu-memory-utilization` 권장값을 계산해 출력한다.

### 9.5 모델 프로필

현재 `HttpTransport`는 `SAMPLING_DEFAULTS`(temperature 1.0, top_p 0.95)를 무조건
보낸다. 이건 Motif의 공식 평가 설정이고 가지친 모델도 같은 계열이므로 **그대로 두는
것이 맞다.** 바꾸지 마라.

(참고: 일반 모델을 붙이려 프로필 계층을 만들었다가 릴리스에서 제외한 이력이 있다.
가지친 Motif에는 필요 없다.)

### 9.6 문서

- `README.md`의 Status 표에 가지친 체크포인트 항목을 추가하고 실측 수치를 넣는다.
- 모델 카드를 쓴다. **코딩 성능 유지와 코딩 외 손실을 둘 다 기재하라.** 의도한
  거래임을 숨기지 마라.
- **재현 자료를 공개하라** — keep-list JSON, 프로파일링 스크립트, 평가 결과 원본.
  "어느 전문가를 왜 남겼는지"가 이 모델의 신뢰도 그 자체다.

### 9.7 최종 수용 기준

다음이 전부 참이면 이 작업은 끝났다:

1. `motif doctor --endpoint <GB10>` 이 ✓로 통과한다.
2. `motif "<실제 과제>"` 가 GB10의 가지친 모델로 완주하고 exit 0을 낸다.
3. 세션이 `.motif/sessions/`에 기록되고 `motif distil`이 궤적을 뽑는다.
4. 실측 디코드 속도가 기록돼 있다.
5. 256K 컨텍스트에서 OOM 없이 돈다.
6. SWE-bench 결과가 원본 대비 신뢰구간과 함께 보고돼 있다.
7. 채널 A/B 결과가 원본·가지친 양쪽에 대해 기록돼 있다 (§9.2).
8. 모델 카드와 keep-list가 공개돼 있다.

### 9.8 공개 전

**Motif Technologies에 사전 연락하라.** 파생 모델을 내는 것은 MIT상 자유지만, 원
저작자가 모르는 채로 "Motif-3 코더"가 돌아다니는 것은 서로에게 손해다. 이 시점이면
보여줄 결과물이 있으니 훨씬 좋은 대화가 된다.

---

## 10. 하지 말아야 할 것

- **프로파일링 전에 가지치기.** 어느 전문가를 남길지 모른 채 자르면 그냥 무작위다.
- **퍼플렉시티로 판정.** §2.4-3.
- **기준 하나만 믿기.** §2.4-2.
- **단발 벤치마크만 보기.** §2.4-4. 수리 턴 조건을 반드시 병행.
- **정합성 검증 없이 품질 판정.** §6.1. 수술 버그를 품질 손실로 오진한다.
- **임대를 여러 번 켜기.** 187 GB 로딩이 매번 든다. 준비를 끝내고 한 번에 몰아라.
- **`experts_top_k` 손대기.** §9.3.
- **`shared_experts` 자르기.** 모든 토큰에 대해 실행되는 경로다. 라우팅 뱅크가 아니다.
- **keep-list를 정렬 안 한 채 넘기기.** 라우터의 남은 로짓 순서가 뒤바뀐다.
  `validate_keep()`이 막지만 우회하지 마라.
- **GB10에서 메모리 캡 없이 기동.** §2.6.

---

## 11. 아직 아무도 모르는 것

정직하게 남겨둔다. 이 작업의 성패가 여기 달려 있다.

1. **314B·384전문가 규모에서 절반 가지치기가 성립하는가.** 선행 연구는 35B·26B였다.
2. **어느 선택 기준이 이 모델에서 맞는가.** 계열 간 이전이 안 된다는 것만 알려져 있다.
3. **부하 균형된 라우터에서 도메인 대조가 충분한 신호를 내는가.** 논리적으로는
   그래야 하지만 검증된 바 없다.
4. **GB10에서 vLLM NVFP4가 도는가.** 미해결 버그가 있다.
5. **수리 턴의 회복 효과가 이 규모에서도 나타나는가.**

1·2·3은 P1~P4로, 4는 P5로, 5는 §6.3으로 답이 나온다. **전부 몇 주 안에 답을 알 수
있는 질문이지, 답이 없는 질문이 아니다.**

---

## 12. 참고 자료

| 자료 | 용도 |
|---|---|
| [Motif-Technologies/Motif-3](https://huggingface.co/Motif-Technologies/Motif-3) | 모델 카드, `config.json`, `chat_template.jinja`, `modeling_motif.py` |
| [Motif-3-NVFP4](https://huggingface.co/Motif-Technologies/Motif-3-NVFP4) | 작업 대상 체크포인트 |
| [arXiv:2608.09119](https://arxiv.org/abs/2608.09119) | Motif 3 기술 보고서. §5.1.2 부하균형, §5.2.3 교사 학습, Appendix C 평가 설정 |
| [arXiv:2607.16721](https://arxiv.org/abs/2607.16721) | Half the Experts, All the Code — 이 작업의 방법론 근거 |
| [arXiv:2608.16157](https://arxiv.org/abs/2608.16157) | FreeToken — §8 대체 경로 |
| [MotifTechnologies/vllm](https://github.com/MotifTechnologies/vllm) | 서빙 포크. 툴콜/추론 파서 원본 |
| [motif3-training-example](https://github.com/MotifTechnologies/motif3-training-example) | P5 회복 튜닝용 |
| 이 저장소 `toolkit/prune/` | 실행 코드와 테스트 |
| 이 저장소 `packages/cli/src/doctor.ts` | 서버 설정 점검 항목의 근거가 주석에 있음 |

---

*이 문서는 gitignore에 등록돼 있다. 공개 저장소에 올라가지 않는다.*
