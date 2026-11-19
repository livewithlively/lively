# 지식유형 분류 런북 (knowledge-types)

> **자동 생성물 — 직접 수정 금지.** 출처(ground-truth)는 DB 의 `kind_registry`·`data_source` 이며,
> `scripts/build-classify-runbook.mjs` 가 렌더한다. 정의를 바꾸려면 DB(또는 시드 `src/org/schema/registry.ts`)를 고치고
> 재빌드한다. 웹 `#/learn`(GET `/api/ui/learn`)이 같은 데이터를 렌더하므로 두 표면은 항상 일치한다.
> 지식 분류(type)의 목록·설명은 `knowledge_save` 의 `type` 입력 선언(`src/capabilities/knowledge/authoring.ts`)에서 렌더한다.

이 문서는 (1) LLM 이 지식을 마이그/증류·분류할 때 읽는 **분류 지침**이자 (2) 사람이 읽는 안내다.

## 0. 분류 모델 — 지식은 type 하나로 분류하고, kind 는 저장 자리다

- **지식의 분류 = `type` 6종: `decision`·`concept`·`how-to`·`reference`·`research`·`entity`.** 지식 하나에 하나만 단다(신규 저장 시 필수).
  - 정의(`knowledge_save` 의 `type` 설명에서): decision(결정·ADR)|concept(개념·배경·도메인설명)|how-to(런북·절차)|reference(사양·참조)|research(조사·분석)|entity(사람·조직·제품)
- **종류(kind) R·K·H·W = 맥락이 저장되는 자리**이고 지식의 두 번째 분류가 아니다.
  - **R**(규칙/정책/페르소나) = 세션 주입 섹션 문서. 지식이 아니라 type 을 달지 않는다. **항상 주입.**
  - **K**(지식) = type 이 how-to 가 아닌 지식(decision·concept·reference·research·entity).
  - **H**(하우투/런북) = type=how-to 인 지식.
  - **W**(과업) = 프로젝트·태스크. 지식이 아니라 type 을 달지 않는다.
- **주제 = 종류가 아니라 별도 축**: 분류축(category) `key` 하나. 위에 얹힌 고정 서랍장은 없다(#1631 — 축은 조직이 자기 일에서 뽑아낸다). 지식은 카테고리 1개(단일 home)에 속하고, 교차 주제는 `knowledge_link` 로 잇는다.
- **출처(provenance) = 종류가 아니라 기계적 사실**: `authored`(저작) · `observed`(외부 시스템 살아있는 미러). 외부 미러는 type 을 비운 채 들어올 수 있어 type 축 밖이다 — type 이 비었다고 미분류 지식으로 세지 않는다.
- **`confidence` 는 칸이 둘이고 뜻이 다르다**(컬럼명은 `confidence` 유지): 지식의 `confidence` = 마지막으로 저장한 채널(`human` 사람 웹 · `ai` 에이전트 MCP · `observed` 외부 미러 · `rule` 시스템 결정론 파생)이고 서버가 채운다(되돌리기와 이미 반영된 수정 제안의 반려는 이전 값을, 가져오기로 새로 들이는 지식은 꾸러미에 실린 원본의 값을 유지하고, 수정 제안 승인은 제안자의 채널을 따른다). 지식↔카테고리 연결의 `confidence` = 분류 신뢰도(0~1). 어느 쪽도 가치·주입을 결정하지 않는다.
- **S(구조)·G(용어집/그래프) 는 ku 종류가 아니다** — 모양이 글이 아니라 노드+엣지라 domainmap 파생 그래프(**federated 뷰**)로 다룬다. 도메인 부채도 ku 아님(domainmap `debt_finding`).
- 옛 kind 코드 D·F·A·M·S·G·L·Z 는 시드에서 지워졌다(부팅마다 DELETE). D/F/A/M/L/Z 는 지식(type 으로 분류)으로, S/G 는 domainmap 파생(federated)으로 본다.

## 1. 저장 자리(kind) — 정의·분류기준·저장·전달 (R·K·H·W)

### R — Rule/Policy/Persona

**정의.** 조직이 모든 AI 세션에 강제하는 규칙·정책·페르소나. "반드시/금지" 같은 행동 규범과 AI 의 말투·역할. 지식이 아니라 세션 주입 섹션 문서라 지식 분류(type)를 달지 않는다.

**언제 이 종류인가(분류기준).** "항상/반드시/절대" 지켜야 하는 강제 규범이면 R. 페르소나(AI 역할·말투)도 R. R 은 위반하면 안 되는 명령형이다 — 한 번 정한 결정·배경·절차는 R 이 아니라 지식이고 type 으로 분류한다.

- 저장방식: 항상-주입 섹션 문서(injection=always)로 저장. 관리 ▸ 세션 주입(org_update_section)으로 쓰며, 지식 저장(knowledge_save)으로는 만들 수 없다(지식은 항상 recalled). 본문 전체가 보존된다.
- 전달방식: 강제 주입(enforced): 맥락과 무관하게 모든 세션 컨텍스트 최상단에 전문이 그대로 들어간다(R 만 항상 주입). (injection_mode=`enforced`)
- 도메인 귀속: 아니오 · 다중: many

### K — Knowledge note

**정의.** 지식 — 결정·개념·사양·조사·개체처럼 지속되는 기록. 지식의 분류는 kind 가 아니라 type 6종(decision·concept·how-to·reference·research·entity)이고, K 는 그중 how-to 를 뺀 다섯이 저장되는 자리를 부르는 이름이다.

**언제 이 종류인가(분류기준).** 세션 주입 규범(R)·과업(W)이 아닌 기록이면 지식이다. 지식으로 저장할 땐 kind 를 고르지 않고 type 을 고른다 — 절차면 how-to(H), 그 밖에는 decision·concept·reference·research·entity 중 하나(K). 주제는 kind 가 아니라 카테고리로, 출처는 provenance 로 구분한다.

- 저장방식: 지식 단위로 저장(제목+본문, type 1개, 카테고리 1개). 본문은 전문 보존, 검색 대상.
- 전달방식: 검색 회상(recalled): 인덱스(제목·요약)에 노출, 전문은 일에 맞춰 카테고리+검색으로 그때 소환(on-demand). (injection_mode=`recalled`)
- 도메인 귀속: 아니오 · 다중: many

### H — How-to/Runbook

**정의.** 하우투·런북 — 무엇을 어떤 순서로 하는지의 재현 가능한 절차(예: 배포 방법, 동기화 실행법). 지식의 type=how-to 와 같은 것이다. AI 워크플로 표준화의 핵심 산물.

**언제 이 종류인가(분류기준).** "이렇게 한다"는 단계별 절차면 H 이고, 지식으로 저장할 땐 type=how-to 를 단다. 결정·배경(decision·concept 등)과 구분: H 는 따라 하면 결과가 재현된다.

- 저장방식: 지식 단위로 저장(type=how-to, 단계 목록 본문). 주제는 카테고리 1개.
- 전달방식: 검색 회상(recalled): 인덱스에 노출, 필요할 때 카테고리+검색으로 전문 소환(on-demand). (injection_mode=`recalled`)
- 도메인 귀속: 예(domainmap 도메인에 묶임) · 다중: many

### W — 과업(Task)

**정의.** 과업·태스크 — 진행 상태·담당을 가진 일. 지식이 아니라 프로젝트·태스크(project ▸ task ▸ subtask)로 저장해 지식 분류(type)를 달지 않는다. PM 도구(ClickUp 등)의 태스크도 여기로 들어온다. (과업을 향한 개별 행위·진척은 별 엔티티 작업=activity.)

**언제 이 종류인가(분류기준).** 진행 상태(미정/진행/완료)·담당을 가진 **과업/태스크**면 W. 절차 설명은 지식(type=how-to), 정리된 기록은 지식(그 밖의 type)이다. 수집된 외부 과업·문서는 출처(provenance=observed)로 들어온 W·지식 미러다.

- 저장방식: 프로젝트·태스크로 저장(project_*_v6·task_*_v6, 커넥터는 external_id·상태와 함께 적재). 과업을 향한 개별 작업(activity)은 activity_* 가 별도 기록.
- 전달방식: 질의 시(query): 필요할 때 조회(과업 현황 검색). (injection_mode=`query`)
- 도메인 귀속: 아니오 · 다중: many

## 2. 빠른 참조표 (저장 자리)

| 종류 | 이름 | 분류기준(요약) | 전달방식 |
|---|---|---|---|
| R | Rule/Policy/Persona | "항상/반드시/절대" 지켜야 하는 강제 규범이면 R. 페르소나(AI 역할·말투)도 R. R 은 위반하면 안 되는 명령형이다 — 한 번 정한 결정·배경·절차는… | 강제 주입(enforced): 맥락과 무관하게 모든 세션 컨텍스트 최상단에 전문이 그대로 들어간다(R 만 항상 주입). |
| K | Knowledge note | 세션 주입 규범(R)·과업(W)이 아닌 기록이면 지식이다. 지식으로 저장할 땐 kind 를 고르지 않고 type 을 고른다 — 절차면 how-to(H), 그… | 검색 회상(recalled): 인덱스(제목·요약)에 노출, 전문은 일에 맞춰 카테고리+검색으로 그때 소환(on-demand). |
| H | How-to/Runbook | "이렇게 한다"는 단계별 절차면 H 이고, 지식으로 저장할 땐 type=how-to 를 단다. 결정·배경(decision·concept 등)과 구분: H 는… | 검색 회상(recalled): 인덱스에 노출, 필요할 때 카테고리+검색으로 전문 소환(on-demand). |
| W | 과업(Task) | 진행 상태(미정/진행/완료)·담당을 가진 **과업/태스크**면 W. 절차 설명은 지식(type=how-to), 정리된 기록은 지식(그 밖의 type)이다. 수… | 질의 시(query): 필요할 때 조회(과업 현황 검색). |

## 3. 데이터소스별 수집방식

외부 시스템에서 무엇이 어떻게 수집되어 어느 자리(kind)로 적재되는지. status=dropped 는 현재 수집 중단(커넥터 코드는 유지).

| 소스 | 상태 | 수집방식 | 주기 | 적재 종류 |
|---|---|---|---|---|
| ClickUp | 수집중(active) | ClickUp 커넥터가 리스트→프로젝트로 매핑하고, 태스크를 작업 단위로 가져온다. pm_* 툴로 태스크를 직접 쓰기도 한다. | 주기 동기화(run-sync) | W |
| Notion | 수집중(active) | Notion 커넥터가 지정한 페이지/데이터베이스의 문서를 가져온다. | 동기화(run-sync/backfill) | K |
| Slack | 중단(dropped) | Slack 커넥터가 메시지를 자료(source)로 적재한다(#541). distill 이 자료를 지식(K)으로 증류. | 주기 동기화(run-sync) |  |
| Discord | 중단(dropped) | Discord 커넥터가 메시지를 자료(source)로 적재한다(#541). distill 이 자료를 지식(K)으로 증류. | 주기 동기화(run-sync) |  |
| Gmail | 중단(dropped) | Gmail 커넥터가 메일을 자료(source)로 적재한다(#541, OAuth2 refresh-token). distill 이 지식으로 증류. | 주기 동기화(run-sync) |  |
| Google Drive | 중단(dropped) | Google Drive 커넥터가 문서를 지식(K)으로 적재한다(#541, OAuth2 refresh-token). | 주기 동기화(run-sync) | K |

## 4. 증류·마이그레이션 분류 지침 (LLM)

- **지식으로 저장할 것이면 kind 가 아니라 type 을 고른다** — 위 §0 의 type 중 하나. 재현 가능한 단계별 절차는 `how-to`, 그 밖에는 내용에 맞는 type.
  - 세션마다 강제할 규범·페르소나(R)는 지식이 아니라 세션 주입 섹션 문서다(`knowledge_save` 로 만들지 않는다).
  - 상태·담당을 가진 일(W)은 지식이 아니라 프로젝트·태스크다(`project_*_v6`·`task_*_v6`).
- **주제는 type 과 별개 축**: 어느 분류축에 속하면 그 축의 key 를 단다(카테고리 1개). 교차 주제는 카테고리를 늘리지 않고 `knowledge_link` 로 잇는다.
- **provenance 와 지식의 `confidence` 는 기계가 채널로 박는 사실**이라 LLM 이 *판단*하지 않는다. 카테고리 연결의 `confidence`(0~1)는 분류를 제안하는 쪽이 매기는 분류 신뢰도다.
- **D·F·A·M·S·G·L·Z 를 kind 로 부여하지 않는다.** 도메인 부채는 ku 가 아니라 domainmap `debt_finding`.
- type 은 칸이 하나다. 한 기록이 둘 이상 성격에 걸치면 주된 성격 하나를 고른다.

