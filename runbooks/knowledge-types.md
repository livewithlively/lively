# 지식유형 분류 런북 (knowledge-types)

> **자동 생성물 — 직접 수정 금지.** 출처(ground-truth)는 DB 의 `kind_registry`·`data_source` 이며,
> `scripts/build-classify-runbook.mjs` 가 렌더한다. 정의를 바꾸려면 DB(또는 시드 `src/org/schema.ts`)를 고치고
> 재빌드한다. 웹 `#/learn`(GET `/api/ui/learn`)이 같은 데이터를 렌더하므로 두 표면은 항상 일치한다.

이 문서는 (1) LLM 이 지식을 마이그/증류·분류할 때 읽는 **분류 지침**이자 (2) 사람이 읽는 안내다.

## 0. V4 분류 모델 — 본질 종류 4종 × 주제(area) × 출처(provenance)

- **종류(kind) = 본질만, 4종: R·K·H·W.**
  - **R**(규칙/정책/페르소나) = 모든 세션에 강제하는 규범·말투. **항상 주입.**
  - **K**(지식 노트) = 거의 모든 저작 지식(배경·사실·도메인 지식·메모·링크를 다 흡수). 가장 큰 기본값.
  - **H**(하우투/런북) = 재현 가능한 단계별 절차.
  - **W**(작업/태스크) = 상태·담당을 가진 일.
- **주제(area) = 종류가 아니라 별도 축**: `(space, key)` 2단. `space=product`(코드앵커 도메인) · `space=business`(비즈니스 기능: gtm·가격·펀딩·시장경쟁·브랜드·조직). 한 단위가 area 에 안 묶이거나(전사) 여럿에 묶일 수 있다.
- **출처(provenance) = 종류가 아니라 기계적 사실**(컬럼명은 `confidence` 유지): `observed`(외부 시스템 살아있는 미러) · `human`(사람 저작/승인) · `ai`(AI 생성) · `rule`(시스템 결정론 파생). 출처는 가치·주입을 결정하지 않는다.
- **S(구조)·G(용어집/그래프) 는 ku 종류가 아니다** — 모양이 글이 아니라 노드+엣지라 domainmap 파생 그래프(**federated 뷰**)로 다룬다. 도메인 부채도 ku 아님(domainmap `debt_finding`).
- ⚠ 아래 표의 **D·F·A·M·S·G·L·Z 는 통합 예정 legacy 종류**다(P1 무중단 유지 — 라이브 유닛이 아직 그 종류라 정상 렌더). **신규 분류에선 쓰지 말고** D/F/A/M/L/Z→K, S/G→domainmap federate 로 보낸다(데이터 흡수는 P2).

## 1. 지식 종류 — 정의·분류기준·저장·전달 (본질 4종 R·K·H·W + 통합 예정 legacy)

### R — Rule/Policy/Persona

**정의.** 조직이 모든 AI 세션에 강제하는 규칙·정책·페르소나. "반드시/금지" 같은 행동 규범과 AI 의 말투·역할. 4 본질 종류 중 하나(R·K·H·W).

**언제 이 종류인가(분류기준).** "항상/반드시/절대" 지켜야 하는 강제 규범이면 R. 한 번 일어난 사실·방법 절차(H)·배경 지식(K)과 구분: R 은 위반하면 안 되는 명령형이다. 페르소나(AI 역할·말투)도 R.

- 저장방식: 강제규칙(managed-policy)·회사맥락(org-defaults) 섹션으로 저장. 본문 전체가 보존된다.
- 전달방식: 강제 주입(enforced): 맥락과 무관하게 모든 세션 컨텍스트 최상단에 전문이 그대로 들어간다(R 만 항상 주입). (injection_mode=`enforced`)
- 도메인 귀속: 아니오 · 다중: many

### K — Knowledge note

**정의.** 지식 노트 — 결정의 배경, 알게 된 것, 정리한 생각, 사실, 도메인 지식, 메모·링크까지 아우르는 일반 지식. 4 본질 종류 중 가장 큰 기본값(R·K·H·W).

**언제 이 종류인가(분류기준).** 강제 규범(R)·절차(H)·작업(W)이 아닌 거의 모든 저작 지식은 K. 배경·맥락·사실·도메인 지식·메모·외부 링크가 다 K 로 모인다(주제는 종류가 아니라 area=domain 으로 구분, 출처는 provenance 로 구분). 애매하면 K.

- 저장방식: 지식 단위로 저장(제목+본문). 본문은 전문 보존, 검색 대상. 주제 귀속은 area(domain_key, product/business)로 단다.
- 전달방식: 검색 회상(recalled): 인덱스(제목·요약)에 노출, 전문은 일에 맞춰 area+검색으로 그때 소환(on-demand). (injection_mode=`recalled`)
- 도메인 귀속: 아니오 · 다중: many

### D — Domain knowledge

**정의.** (V4 legacy — K 로 통합 예정) 특정 도메인에 귀속된 지식. V4 에서 도메인은 *종류*가 아니라 area(domain_key) 축이라, 본질은 K 이고 주제는 area 로 단다. P2 가 K 로 흡수한다.

**언제 이 종류인가(분류기준).** V4 신규 분류에선 D 를 쓰지 말고 K + area(domain_key) 를 쓴다(도메인은 종류가 아닌 area 축). 기존 D 유닛은 P2 가 K 로 재분류한다.

- 저장방식: 지식 단위로 저장하되 domain_key(domainmap 약결합)를 부여. 도메인별로 묶여 탐색된다.
- 전달방식: 검색 회상(recalled): 도메인 섹션으로 인덱스에 노출, 전문은 검색 회상. (injection_mode=`recalled`)
- 도메인 귀속: 예(domainmap 도메인에 묶임) · 다중: many

### F — Fact

**정의.** (V4 legacy — K 로 통합 예정) 단일 확정 사실. V4 에선 사실도 지식이므로 본질은 K 다. P2 가 K 로 흡수한다.

**언제 이 종류인가(분류기준).** V4 신규 분류에선 F 대신 K 를 쓴다. 기존 F 유닛은 P2 가 K 로 재분류한다.

- 저장방식: 지식 단위로 저장(짧은 본문). 사실 단위라 보통 한 단락.
- 전달방식: 검색 회상(recalled): 인덱스에 노출, 관련 시 회상. (injection_mode=`recalled`)
- 도메인 귀속: 아니오 · 다중: many

### H — How-to/Runbook

**정의.** 하우투·런북 — 무엇을 어떤 순서로 하는지의 재현 가능한 절차(예: 배포 방법, 동기화 실행법). 라이블리 AI 워크플로 표준화의 핵심 산물. 4 본질 종류 중 하나(R·K·H·W).

**언제 이 종류인가(분류기준).** "이렇게 한다"는 단계별 절차면 H. 배경 지식(K)과 구분: H 는 따라 하면 결과가 재현된다. 도메인 절차여도 H(area=domain 부여 가능).

- 저장방식: 지식 단위로 저장(단계 목록 본문). 주제 귀속은 area(domain_key) 부여 가능.
- 전달방식: 검색 회상(recalled): 인덱스에 노출, 필요할 때 area+검색으로 전문 소환(on-demand). (injection_mode=`recalled`)
- 도메인 귀속: 예(domainmap 도메인에 묶임) · 다중: many

### S — Schema/Structure

**정의.** (V4 legacy — domainmap 파생으로 이관 예정) 스키마·구조. V4 에선 구조는 글(지식단위)이 아니라 노드+엣지라 domainmap 파생 그래프(federated 뷰)로 다룬다(ku 종류 아님). 라이브 0행. P2 가 제거.

**언제 이 종류인가(분류기준).** V4 신규 분류에선 S 를 쓰지 않는다 — 구조는 domainmap(코드/데이터 구조)에서 파생해 federated 로 본다.

- 저장방식: 지식 단위로 저장. domain_key 부여 가능(스키마는 보통 도메인 귀속).
- 전달방식: 다이제스트(digest): 요약 형태로 노출(구조 전체가 아니라 개요만). (injection_mode=`digest`)
- 도메인 귀속: 예(domainmap 도메인에 묶임) · 다중: many

### G — Glossary/Graph

**정의.** (V4 legacy — domainmap 파생으로 이관 예정) 용어집·관계 그래프. V4 에선 용어/관계도 노드+엣지라 domainmap 파생(federated 뷰)으로 다룬다(ku 종류 아님). 라이브 0행. P2 가 제거.

**언제 이 종류인가(분류기준).** V4 신규 분류에선 G 를 쓰지 않는다 — 용어/관계는 domainmap 에서 파생해 federated 로 본다. (도메인 부채도 ku 종류 아님 — domainmap 의 debt_finding.)

- 저장방식: 지식 단위로 저장. domain_key 부여(용어는 도메인 귀속).
- 전달방식: 다이제스트(digest): 용어 요약으로 노출. (injection_mode=`digest`)
- 도메인 귀속: 예(domainmap 도메인에 묶임) · 다중: many

### A — Artifact

**정의.** (V4 legacy — K 로 통합 예정) 산출물(수집된 활동/메시지/문서). V4 에선 산출물=독자대상 지식포장이라 본질은 K 이고, 외부/수집 여부는 출처(provenance=observed)가 잡는다. P2 가 K 로 흡수.

**언제 이 종류인가(분류기준).** V4 신규 분류에선 A 대신 K(+provenance=observed for 미러)를 쓴다. 기존 A 유닛은 P2 가 K 로 재분류한다.

- 저장방식: 커넥터가 적재(source/external_id/원본 필드). 보통 자동 수집물이라 양이 많다.
- 전달방식: 질의 시(query): 평소엔 인덱스에 안 올라가고, 에이전트가 필요할 때 검색·조회. (injection_mode=`query`)
- 도메인 귀속: 아니오 · 다중: many

### W — Work/Task

**정의.** 작업·태스크 — PM 도구(ClickUp 등)의 태스크/이슈. 진행 상태·담당을 가진 일. 4 본질 종류 중 하나(R·K·H·W).

**언제 이 종류인가(분류기준).** 진행 상태(미정/진행/완료)·담당을 가진 **일/태스크**면 W. 절차 설명은 H, 정리된 지식은 K. 수집된 외부 활동/문서는 출처(provenance=observed)로 들어온 W/K 미러다.

- 저장방식: 커넥터/pm_* 가 적재(external_id·상태). 작업 단위.
- 전달방식: 질의 시(query): 필요할 때 조회(작업 현황 검색). (injection_mode=`query`)
- 도메인 귀속: 아니오 · 다중: many

### M — Memo

**정의.** (V4 legacy — K 로 통합 예정) 가벼운 임시 기록. V4 에선 메모도 지식이라 본질은 K 다. P2 가 K 로 흡수.

**언제 이 종류인가(분류기준).** V4 신규 분류에선 M 대신 K 를 쓴다. 기존 M 유닛은 P2 가 K 로 재분류한다.

- 저장방식: 지식 단위로 저장(짧은 본문).
- 전달방식: 수동(manual): 자동 주입 안 함. 사람이 직접 찾아볼 때만. (injection_mode=`manual`)
- 도메인 귀속: 아니오 · 다중: many

### L — Link/Ref

**정의.** (V4 legacy — K 로 통합 예정) 외부 문서/URL 포인터. V4 에선 링크도 지식이라 본질은 K 다. P2 가 K 로 흡수.

**언제 이 종류인가(분류기준).** V4 신규 분류에선 L 대신 K 를 쓴다(참조를 본문에). 라이브 0행.

- 저장방식: 지식 단위로 저장(URL·참조를 본문에).
- 전달방식: 수동(manual): 사람이 참조할 때만. (injection_mode=`manual`)
- 도메인 귀속: 아니오 · 다중: many

### Z — Misc

**정의.** (V4 legacy — K 로 통합 예정) 분류 보류함. V4 에선 애매한 것도 K 가 기본값이다. P2 가 K 로 흡수.

**언제 이 종류인가(분류기준).** V4 신규 분류에선 Z 대신 K 를 쓴다(K 가 가장 큰 기본값). 라이브 0행.

- 저장방식: 지식 단위로 저장.
- 전달방식: 수동(manual): 자동 주입 안 함. (injection_mode=`manual`)
- 도메인 귀속: 아니오 · 다중: many

## 2. 빠른 참조표

| 종류 | 이름 | 분류기준(요약) | 전달방식 |
|---|---|---|---|
| R | Rule/Policy/Persona | "항상/반드시/절대" 지켜야 하는 강제 규범이면 R. 한 번 일어난 사실·방법 절차(H)·배경 지식(K)과 구분: R 은 위반하면 안 되는 명령형이다. 페르소… | 강제 주입(enforced): 맥락과 무관하게 모든 세션 컨텍스트 최상단에 전문이 그대로 들어간다(R 만 항상 주입). |
| K | Knowledge note | 강제 규범(R)·절차(H)·작업(W)이 아닌 거의 모든 저작 지식은 K. 배경·맥락·사실·도메인 지식·메모·외부 링크가 다 K 로 모인다(주제는 종류가 아니라… | 검색 회상(recalled): 인덱스(제목·요약)에 노출, 전문은 일에 맞춰 area+검색으로 그때 소환(on-demand). |
| D | Domain knowledge | V4 신규 분류에선 D 를 쓰지 말고 K + area(domain_key) 를 쓴다(도메인은 종류가 아닌 area 축). 기존 D 유닛은 P2 가 K 로 재분… | 검색 회상(recalled): 도메인 섹션으로 인덱스에 노출, 전문은 검색 회상. |
| F | Fact | V4 신규 분류에선 F 대신 K 를 쓴다. 기존 F 유닛은 P2 가 K 로 재분류한다. | 검색 회상(recalled): 인덱스에 노출, 관련 시 회상. |
| H | How-to/Runbook | "이렇게 한다"는 단계별 절차면 H. 배경 지식(K)과 구분: H 는 따라 하면 결과가 재현된다. 도메인 절차여도 H(area=domain 부여 가능). | 검색 회상(recalled): 인덱스에 노출, 필요할 때 area+검색으로 전문 소환(on-demand). |
| S | Schema/Structure | V4 신규 분류에선 S 를 쓰지 않는다 — 구조는 domainmap(코드/데이터 구조)에서 파생해 federated 로 본다. | 다이제스트(digest): 요약 형태로 노출(구조 전체가 아니라 개요만). |
| G | Glossary/Graph | V4 신규 분류에선 G 를 쓰지 않는다 — 용어/관계는 domainmap 에서 파생해 federated 로 본다. (도메인 부채도 ku 종류 아님 — doma… | 다이제스트(digest): 용어 요약으로 노출. |
| A | Artifact | V4 신규 분류에선 A 대신 K(+provenance=observed for 미러)를 쓴다. 기존 A 유닛은 P2 가 K 로 재분류한다. | 질의 시(query): 평소엔 인덱스에 안 올라가고, 에이전트가 필요할 때 검색·조회. |
| W | Work/Task | 진행 상태(미정/진행/완료)·담당을 가진 **일/태스크**면 W. 절차 설명은 H, 정리된 지식은 K. 수집된 외부 활동/문서는 출처(provenance=ob… | 질의 시(query): 필요할 때 조회(작업 현황 검색). |
| M | Memo | V4 신규 분류에선 M 대신 K 를 쓴다. 기존 M 유닛은 P2 가 K 로 재분류한다. | 수동(manual): 자동 주입 안 함. 사람이 직접 찾아볼 때만. |
| L | Link/Ref | V4 신규 분류에선 L 대신 K 를 쓴다(참조를 본문에). 라이브 0행. | 수동(manual): 사람이 참조할 때만. |
| Z | Misc | V4 신규 분류에선 Z 대신 K 를 쓴다(K 가 가장 큰 기본값). 라이브 0행. | 수동(manual): 자동 주입 안 함. |

## 3. 데이터소스별 수집방식

외부 시스템에서 무엇이 어떻게 수집되어 어느 종류로 적재되는지. status=dropped 는 현재 수집 중단(커넥터 코드는 유지).

| 소스 | 상태 | 수집방식 | 주기 | 적재 종류 |
|---|---|---|---|---|
| ClickUp | 수집중(active) | ClickUp 커넥터가 리스트→프로젝트로 매핑하고, 태스크를 작업 단위로 가져온다. pm_* 툴로 태스크를 직접 쓰기도 한다. | 주기 동기화(run-sync) | W |
| Notion | 수집중(active) | Notion 커넥터가 지정한 페이지/데이터베이스의 문서를 가져온다. | 동기화(run-sync/backfill) | A |
| Slack | 수집중(active) | Slack 커넥터가 지정 채널의 메시지/스레드를 활동으로 가져온다. | 동기화(run-sync/backfill) | A |
| Discord | 중단(dropped) | (수집 중단) Discord 커넥터로 채널 메시지를 가져오던 경로. 커넥터 코드는 유지하나 현재 수집하지 않는다. | — | A |

## 4. 증류·마이그레이션 분류 지침 (LLM)

- **종류(kind)는 R·K·H·W 4종 중에서만 고른다.** 기본값은 K — 강제 규범(R)·절차(H)·작업(W)이 아니면 거의 다 K.
  - 강제 규범(반드시/금지)·페르소나 → **R**. 재현 가능한 단계별 절차 → **H**. 상태·담당을 가진 일 → **W**.
  - 배경·사실·도메인 지식·메모·링크는 모두 → **K**(주제는 area, 출처는 provenance 로 따로 단다).
- **주제(area)는 종류와 별개 축**: 특정 도메인에 속하면 area(domain_key, space=product) 를 단다. 비즈니스 기능이면 space=business 의 key(gtm 등). 전사면 null.
- **출처(provenance, 컬럼 confidence)는 기계가 채널로 박는 사실**이라 LLM 이 *판단*하지 않는다: 외부 미러=observed, 사람=human, AI=ai, 결정론 파생=rule.
- **D·F·A·M·S·G·L·Z 는 통합 예정 legacy** — 신규로 부여하지 말 것. D/F/A/M/L/Z 는 K 로, S/G 는 domainmap 파생(federated)으로 본다. 도메인 부채는 ku 가 아니라 domainmap `debt_finding`.
- 한 단위가 둘 이상 종류에 걸치면 주분류(kind) 하나 + 다중분류(kinds[])로 보조 종류를 단다.

