---
name: map-items
description: item→domain/project 매핑. 구조적 규칙은 스크립트가, 잔여 판단(D6/P5)만 이 인터랙티브 세션이 한다.
tools:
  - bash
  - lively:list_unmapped
  - lively:mapping_candidates
  - lively:ctx_cat
  - lively:curate_item_mapping
env:
  - ITEMS_DATABASE_URL
  - DOMAINMAP_DATABASE_URL
  - DOMAINMAP_DEFAULT_REPO
trigger: on-demand + subscription (in-session /loop) — never headless/programmatic
---

# map-items — 아이템 도메인/프로젝트 매핑 (Plane B 런북, DESIGN §10.5)

> **LLM = 이 머신의 인터랙티브 Claude Code 세션.** programmatic 모델 클라이언트(API/SDK) 없음.
> 결정적 플러밍(추출·컨테이너맵·parent/xref 전파·멱등 upsert)은 스크립트가, 잔여 판단(D6 도메인/P5 프로젝트)만 이 세션이 한다.
> **100% 매핑 강박 버리기 — 미매핑은 그 자체로 신호다.**

## 1. 목적

DESIGN §7 의 매핑 전략을 실행한다. 우선순위:

- **item→DOMAIN (구조적·결정적):** D2 컨테이너맵 → D3 엔티티/슬러그 토큰 → D4 parent 상속 → D5 xref 상속.
- **item→PROJECT (명시참조 우선, 잔여만 LLM):** P1 명시참조(코로보레이션) → P2 proto-project lift → P3 컨테이너→프로젝트 → P4 parent/xref 상속.
- **LLM 판단:** D6 도메인 잔여, P5 프로젝트 클러스터링 — 이 인터랙티브 세션만.

## 2. Step 0 — 결정적 플러밍 (LLM 0) — **폐기(item 컷오버, 2026-06)**

> ⚠ 구 결정적 rule 매퍼(`dist/items/run-map.js`)와 CLI(`dist/items/propose-cli.js`)는 **item 폐기 컷오버로 제거됐다**(item 테이블·`relation`·`item.parent_id` 체인 의존이라 ku 단일표면과 양립 불가). ku 시대의 결정적 매퍼는 후속 별도 빌드(parent_name 자기참조·ku 좌표 기반). **현재 큐레이션은 Step 1~3 의 MCP `curate_item_mapping`(ku `name` 좌표) + 웹 UI 로 한다.** kud/kup 가산이관은 완료(라이브 동기).

## 3. Step 1 — 잔여 표면화 (inbox)

```
list_unmapped { missing: "either", limit: 50 }
```

매핑 0건인 아이템이 곧 잔여. **억지 매핑 금지.**

## 4. Step 2 — 후보 로드

```
mapping_candidates { repo: "lively" }
```

도메인 key+description, 프로젝트 key+기간, 엔티티 name→domain 을 한 번에. 이걸로 D6/P5 판단을 grounding.

## 5. Step 3 — LLM 판단 (D6 도메인 잔여 / P5 프로젝트 클러스터링)

각 잔여 활동을 `ctx_cat { name }` 으로 정독(전문 + 메타; 스레드 필요하면 `ctx_cat { name, thread: true }`) → 후보 description/엔티티와 대조 → **확신할 때만** 제안.

> **좌표(item 폐기 컷오버 완료, 2026-06):** 읽기·쓰기 **모두 ku 좌표 `name`**(= `<system>-<external_id>` 슬러그, `ctx_ls`/`ctx_grep`/`list_unmapped` 결과 행의 `id` 필드가 곧 name)으로 한다. 구 `get_item { id }`/정수 `itemId` 는 폐기됐다(활동검색=`ctx_ls`/`ctx_grep` 의 `system`/`since`/`source`/`type` 필터, 단건상세/스레드=`ctx_cat`; 매핑 쓰기=`curate_item_mapping { name }`).

```
curate_item_mapping { action: "propose", kind: "domain",  name, key: domainKey,  evidence: "본문 인용 + 어느 도메인 설명/엔티티와 매치되는지", confidence }
curate_item_mapping { action: "propose", kind: "project", name, key: projectKey, evidence: "본문 인용 + 어느 프로젝트와 매치되는지",        confidence }
```

(MCP `curate_item_mapping` 의 propose 는 `mappedBy='llm'` **만 허용**(기본값) — evidence 가 없으면 거부되고, `rule`/`manual` 자칭도 거부된다. rule 행은 (후속) ku 매퍼, manual 행은 웹 UI 의 사람 경로 전용.)

- **멀티도메인 허용** — ≥2 면 그대로 둔다(부채 신호). 단일 도메인으로 collapse 하지 말 것.
- 한 스레드가 한 프로젝트면 묶어서 같은 `projectKey`.
- `evidence` 없으면 llm 제안은 **거부**된다(가드레일).

## 6. 가드레일 (재명시 — 위반은 자동 거부)

1. **propose-only:** 이 런북의 LLM 제안은 항상 `state='proposed'`. 확정(`state='confirmed'`)은 별도 confirm 경로(§7).
2. **confirmed 행 + manual 행 절대 안 건드림** — 스크립트·툴이 ON CONFLICT WHERE(`state='proposed' AND mapped_by<>'manual'`)로 보장(조용한 손상 금지). 둘 다 보호되지만 **state 값은 다르다**: confirmed 행은 `state='confirmed'`, `--by manual` 로 만든 행은 `state='proposed'`(보호되지만 미확정). **유일 예외:** 커넥터 declared 싱크(§8)는 rejected/manual 행도 덮는다 — `declared-overrode-*` 감사로 표면화.
3. **provenance 강등 금지:** rule 재실행이 기존 `llm` 행을 `rule` 로 덮지 않는다(rank rule<llm<manual). 더 강한 출처만 덮어쓸 수 있다.
4. **llm 매핑은 evidence 필수** — 그리고 `evidence` 는 `knowledge_unit_domain`/`knowledge_unit_project` 의 `evidence` 컬럼에 영속된다(+ `knowledge_unit_mapping_audit` 에 검증경로 통과 감사행; `ctx_cat` 으로 활동 본문 확인).
5. **key 검증:** domain_key/project_key 는 domainmap repo 스코프에 존재해야 함(없으면 거부).
6. **미매핑 유지:** pre-pivot ORS 문서·'#회의' 잡담은 미매핑으로 남겨라. 규칙을 넓혀 억지 매핑 금지.
7. **재실행 멱등:** ON CONFLICT, proposed+같은/약한 출처 행만 refresh.
8. **reject 의미론:** `state='rejected'` 행은 rule/llm(그리고 propose 경로의 manual)의 **재제안을 영구 차단**한다 — 재시도하면 `action='skipped-rejected'` 로 보고(매핑 무변경, audit 에 기록). 부활 경로는 **confirm 뿐**(confirm 이 rejected→confirmed 전이를 허용 — 명시적 디자인, audit 가 커버). 매퍼(rule)/추출 코드는 rejected 를 **절대 쓰지 않으며**, rejected 행은 전파(D4/D5/P4)의 소스도 되지 않는다. rejected 만 남은 아이템은 **미매핑으로 inbox 에 복귀**한다(기각 = 신호). MCP `curate_item_mapping` 의 confirm/reject 는 **세션 내 사람의 명시 지시가 있을 때만** 호출 — per-user bearer 가 audit(source='mcp', actor=userId)에 누가 했는지 기록한다.

## 7. 확정 / 기각 (proposed → confirmed | rejected)

확정·기각은 **사람 큐레이션의 명시 행위** — 확정은 `state='confirmed'`+`mapped_by='manual'`, 기각은 `state='rejected'`(행의 원 mapped_by/evidence 는 보존, 기각 사유·기각자는 audit).

**확정 경로:**

- **웹 UI 확정 버튼**(아이템 디테일/인박스), 또는
- **MCP:** `curate_item_mapping { action: "confirm", kind, name, key, repo }` — **사람의 명시 지시가 있을 때만.** (확정: `state='confirmed'` + `mapped_by='manual'` 로 전이 — 매퍼·LLM 제안에서 영구 보호.) 구 `propose-cli.js --confirm` CLI 는 item 컷오버로 폐기.

**기각 경로(2):**

- **웹 UI '기각' 버튼**(proposed 칩 옆 — 디테일/인박스), 또는
- **MCP:** `curate_item_mapping { action: "reject", kind, name, key, repo, evidence: "기각 사유" }` — **사람의 명시 지시가 있을 때만.** (기각: `state='rejected'` 전이 — 이후 rule/llm 재제안 영구 차단(skipped-rejected), 부활은 confirm 만.) 구 `propose-cli.js --reject` CLI 는 폐기.

기각된 행은 읽기에서 기본 제외(검색 배지·디테일·커버리지·키 카운트), rejected 만 남은 아이템은 inbox 로 복귀한다. confirmed 행도 기각할 수 있다(사람 판단 우선 — audit 가 전이 이력을 보존).

참고 — `mapped_by='manual'` + `state='proposed'` 는 *보호된 미확정* 행이다(매퍼/LLM 제안으로부터 보호되지만 미확정). "확정" 상태가 필요하면 `curate_item_mapping { action: "confirm" }` 또는 웹 UI 확정 버튼을 쓸 것. (구 `--by manual`/`--confirm` CLI 는 item 컷오버로 폐기.)

## 8. declared (커넥터 싱크 전용 출처) — 의미론과 운영 규칙

`mapped_by='declared'` 는 **PM 툴의 구조적 사실**(예: ClickUp 태스크가 리스트/프로젝트에 속함)을 그대로 기록하는 출처다 (설계결정 2026-06-11 §1-②).

1. **쓰기 주체는 커넥터 싱크 코드 경로뿐.** MCP propose 는 zod enum(rule|llm|manual)에서 차단된다. `declareUnitProject`(item 컷오버로 ku 좌표 `name` 기반) 의 프로덕션 호출자는 둘이다 — **ClickUp 커넥터 싱크(`run-sync`, 2026-06-11 가동)** 와 **`pm_*` write-through 의 에코 업서트**(`src/capabilities/pm.ts`). **수동/애드혹 invocation 으로 declared 를 만들지 말 것** — declared 는 "소스 구조가 진실"의 주장이라, 실제 툴 선언 없는 declared 행은 가짜 provenance 다.
2. **단일 마스터: declared 는 rejected/manual 행도 무조건 덮는다.** 사람이 declared 매핑에 이견이 있으면 **우리 스토어가 아니라 PM 툴의 구조를 바꿔야 한다** (우리 쪽 reject 는 다음 싱크가 도로 덮는다). 그런 덮어쓰기는 묻히지 않는다: audit action `declared-overrode-rejected`/`declared-overrode-manual` + `DeclareResult.action` 으로 구분 반환되며 phase ③ 싱크 요약은 이를 충돌로 표면화해야 한다.
3. **이력 (2026-06-11):** 최초의 declared 행(item 13 → pivot-strategy-definition)은 커넥터 싱크 e2e 테스트 잔재였음(실제 툴 선언 없음, audit 106). 리뷰에서 `confirmItemProject` 로 manual/confirmed 재표기(audit 108, source='curation-restamp'). 당시 DB 의 declared 행 수 = 0 — phase ③ 전까지 0 이어야 정상이었다. *(2026-06-11 갱신: phase ③ ClickUp 싱크 가동으로 declared 행 = 12+ — 이제 declared 는 ClickUp 의 실제 선언 구조(task→List)와 1:1 이어야 정상.)*

## 9. 신원(person_identity) 운영 노트 (2026-06-11)

- **manual 신원은 ground truth** (members/*.md 바인딩): ingest 의 관측치 갱신은 manual 행의 **email 을 절대 덮지 않고**, display_name 은 NULL 일 때만 채운다 (시도는 audit detail `skipped_observed_email` 로 기록).
- **email-join 신원은 `state='proposed'` 로 착지** — 소스가 주장한 프로필 이메일 기반 자동 추론(사칭 가능)이라 사람 확정 전까진 미확정. 액터 귀속 자체는 state 무관이라 정상 동작. 큐레이션에서 origin='email-join' proposed 행을 주기적으로 확인·확정할 것.
