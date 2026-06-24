# context-ontology 리팩토링 계획 — 난개발 → 정돈 (2026-06-24)

> 6개 영역 병렬 코드감사(capabilities·v6 stores·domainmap 스캔엔진·org/items/connectors·웹·교차절단) 종합.
> 모든 항목 file:line 근거 포함. **본 문서는 계획 — 실행 전 승인 대상.**

## 진단 요약

**v6 데이터 모델 컷오버는 사실상 완료** — 빌드 green, 테스트 green, knowledge_unit/item/domain/activity_task 등 드랍 완료, 라이브 SQL에 레거시 테이블 참조 0. 부채는 **correctness 가 아니라 명명·구조·죽은코드**다(시스템은 동작하나 자기 모습을 잘못 설명함).

**근본 원인:** tooling 부재 — `tsconfig` 에 `noUnusedLocals` 없음 + lint 스크립트 없음 → 컷오버마다 죽은코드가 컴파일을 통과해 누적됐다. 이게 모든 죽은코드의 인에이블러.

**3대 명명 부채(부하 큰 리네임):**
- `domainmap` (서브시스템 162참조) — 이제 `category` 를 다루는데 이름은 domain
- `items` (`itemsPool` 266참조) — item 개념은 드랍됐는데 통합 DB 풀의 이름이 items
- `dmPool()` (44참조) — `return itemsPool` 인 2-DB 설계 잔재

**건강한 곳:** 스캔엔진(reconcile/refresh/aggregate/domain-debt) v6-correct, Capability 레지스트리 패턴 깔끔, v6 스키마 멱등·일관, 커넥터 SPI 사운드, redact/HttpError 중앙화됨.

---

## Phase 0 — 안전망 (먼저 / 다른 모든 단계의 전제)

죽은코드를 자동으로 잡는 그물부터. 이게 없으면 Phase 1 이 또 새 죽은코드를 남긴다.

| 작업 | 근거 | 리스크 |
|---|---|---|
| `tsconfig` 에 `noUnusedLocals`+`noUnusedParameters` 켜기 + 폴아웃 분류 | tsconfig 15줄, strict만 있고 unused 없음 | 낮음 — 폴아웃이 곧 Phase 1 워크리스트 |
| ESLint(`@typescript-eslint/no-unused-vars`) + `npm run lint` 추가, push 게이트에 편입 | lint/포맷 설정 전무 | 낮음 |
| 고아 테이블 DROP 3종 추가: `org_content`·`org_memory`·`org_project` | schema 주석은 "폐기/DROP"인데 실제 DROP문 없음(`org/schema.ts:25,265,457`); DB에 잔존 확인 | 낮음 — 라이브 read 0(스크립트 1곳만) |
| `.bak*` 정리(`knowledge.ts.bakp3.*`·`projects-v6.ts.bakp3.*`·`app.js.bak3.*`·`.env.bak.*`) | 교차절단 에이전트 발견(src 내 스냅샷) | **`.env.bak`=시크릿 → 확인 후** |

**검증:** 빌드+lint green, `init` 2회 멱등(3 테이블 재드랍 무에러).

---

## Phase 1 — 죽은코드 제거 (tooling 이 잡아주는 상태에서 안전)

| 대상 | 근거 | 비고 |
|---|---|---|
| `domainmap/core/domain-alias.ts` **파일 삭제** | 드롭된 `domain_alias` 테이블을 SELECT(`:16,28`), 임포터 0 | **런타임 지뢰**(미래 호출=500) |
| `items/mapping-extract.ts`·`mapping-config.ts`·`mapping-extract.test.ts` 삭제 + test 스크립트 정리 | 임포터 0(테스트만), 매핑 서브시스템 은퇴(`capabilities/index.ts:12`) | 죽은코드용 테스트 제거 |
| `domainmap/core/types.ts` 죽은 export ~15개 | `BestDomainRef/CreateDomainResult/DomainDelete*/…` 임포터 0(`:58-135`) | 라이브셋만 유지 |
| `rest-util.ts` item 헬퍼: `parseMappingBody`·`MappingBody`·`MISSING_VALUES`·`ITEM_TYPES`·`qtype` | 임포터 0(주석 1곳만), `web.ts:30` 주석 | `HttpError/wrap/qstr/qint/qiso/DM_KINDS` 유지 |
| `items/store.ts` 죽은 stub: `resolveParents`(no-op 0반환)·`uiStats` coverage 루프·`listMappingRepos`([]반환) | `:339,383-391,406` | 호출부(run-sync/backfill/context)도 정리 |
| `capabilities/domainmap-crud.ts:16,21`·`domainmap-curation.ts:23,25` 죽은 import(`itemsPool`·`assertNoHardSecrets` 미사용) | grep 미사용 확인 | Phase 0 lint 이 자동 표면화 |
| `domainmap/core/{mappings,changelog,repos}.ts` 죽은 주석(삭제된 `domains.ts` 참조·없어진 리더 헤더·스테일 cascade 목록) | `mappings:1-2`·`changelog:140-147`·`repos:107-108` | 코드는 정상, 주석만 |
| **웹** `app.js`: `#/u/<name>` 죽은링크→`#/k`(`:4391,4399`)·domain-select 헬퍼 60줄(`:459-518`)·`state.browse`(`:38`)·`#/map` skip-link(`index.html:53`) | 라우트 미등록·임포터 0 | 죽은 CSS(`browse`,`dm-`) 동반 정리 |

**검증:** 빌드+lint green, 웹 스모크(각 탭 렌더·죽은링크 제거), 테스트 green.

---

## Phase 2 — 공유 코어 레이어 (`src/db/` 또는 `src/core/`)

현재 `src/lib`/`src/core` 없음 → 유틸이 흩어지고 복붙됨. 중앙화:

| 추출 대상 | 현재 중복 | 목적지 |
|---|---|---|
| `org_content_audit` INSERT (`auditKnowledge/Category/Project/Connector`+org `audit`) | **5곳**: `v6/knowledge-store:29`·`category-store:26`·`project-store:31`·`connector-mirror:33`·`org/store:85` | `src/db/audit.ts`(이미 존재, `auditQuery`만 — 확장) |
| `WriteCtx` 타입 | **6곳**(v6 스토어 5 + org/store 1, shape 발산) | 공유 1개 export |
| `restoreSnapshot` 블록 | **3곳**: `restoreKnowledge/Category/Project`(동형) | 제네릭 `restoreSnapshot(table,cols,keyCol,before,auditFn)` |
| `audited<T>` 래퍼 | **2곳**(byte-identical, 라벨만 다름): `domainmap-crud:50`·`curation:51` | 라벨 인자 1개 |
| `q`/`one`/`withTx` DB 헬퍼 | `domainmap/db.ts:18-20` 인데 v6 스토어 7곳이 거기서 임포트 | 중립 `src/db/` 로 승격 |
| `*_COLS.split(",").map(trim)` | 모든 스토어 | `cols()` 유틸 |

**효과:** ~80줄 제거 + 드리프트 리스크 제거. **Phase 3 리네임의 토대**(중립 db 레이어 확보).

---

## Phase 3 — 명명/구조 리네임 (의도적·서브시스템별 / grep-replace 금지)

> 부하 큰 리네임. **동결 계약은 건드리지 않는다**: `domain:*` tally key(`reconcile.ts:13`), DB 컬럼 `domain_key/domain_id`, 프론트 계약 `domain_id/domain_key/domain_name`(`domainmap-store:85-93`, app.js 의존), `domainmap-compat` 502 토큰.

| 리네임 | 범위 | 근거 |
|---|---|---|
| `src/items/` → `src/db/`(또는 core) + `itemsPool`→`pool`·`initItemSchema`→`initAuxSchema`·`RawItem`→`RawRecord` | ~15파일 임포트 재작성 | item 엔티티 0, 실제는 "DB풀+identity스키마+커넥터인입" |
| `items/store.ts` 분할: `db/pool.ts`·`db/identity.ts`(person*)·`db/ingest.ts` | 단일 916줄 다목적 | 책임 분리 |
| `domainmap/` 스캔엔진 → `src/scan/`(또는 v6/scan) + `dmPool()` **제거**(→pool 직참) + "cross-DB/2-DB" 주석 18곳 정리 | 엔진 파일들 | 1물리DB 후 "cross-DB" 주석은 false |
| `domainmap/core/activity.ts` 분리(스캔엔진과 다른 관심사 — 사람×AI 대시보드) | 1파일 | core/ 가 엔진+활동로그 동거 |
| `v6/domainmap-store.ts` → `v6/category-views.ts` + `product*` 함수명 정리 | 임포터 2곳 | category(product) 읽기층인데 이름이 domainmap |
| `org/knowledge.ts` → `org/kind-registry.ts` | 임포터 2곳 | `v6/knowledge-store.ts` 와 이름 충돌 |

**검증:** 단계마다 빌드+lint+테스트. 리네임은 **커밋 1개=리네임 1종**으로 분리(리뷰·롤백 용이).

---

## Phase 4 — Capabilities 재편

| 작업 | 근거 |
|---|---|
| `domainmap-crud.ts` → `repos.ts`(이제 repo CRUD 전용, domain CRUD 은퇴됨 `:209`) | 이름이 내용과 불일치 |
| `domain_*` vs `category_*` 중복 표면 정리: `category_*` 캐노니컬, `domain_list/get/all_domains` 은퇴(웹 `/api/ui/domains` 소비자를 `/api/ui/categories` 로 repoint 후) | `index.ts:65` MCP_TOGGLE_CANDIDATES 잔존 |
| `context.ts` 관심사 분리(repo리스트/카테고리읽기/items통계/proxy 혼재) + `items_stats`·`context_overview.items` 제거(웹 `/api/ui/stats` 미사용) | `:13,81-89` 레거시 item-store 표면 |
| `index.ts`·`domainmap-curation.ts` 스테일 툴카운트 주석 제거("36툴"/"22툴") | 컷오버마다 썩음 |
| `me` capability 를 `index.ts` 인라인 → 모듈로(선택) | 유일하게 배열 밖 |

---

## Phase 5 — 웹 모듈화 (`public/app.js` 7,527줄)

1. **Phase 1 죽은코드 먼저**(~150줄 + 혼란 3종 제거 — 모듈화와 무관하게 고가치).
2. **ES 모듈 분할**(빌드 불필요 — `<script type="module">`): 기존 배너주석 클러스터 기준 — `core.js`(el/api/state/상수)·`knowledge.js`·`projects.js`(~1900줄, 최대)·`dashboard.js`·`terminal.js`·`learn-install.js`·`admin.js`·`domainmap.js`·`main.js`(route/boot). xterm 전역(`Terminal`/`FitAddon`)은 모듈에서 그대로 읽힘.
3. UI 용어 통일: 제품 카테고리=도메인이라 둘이 섞임 — `도메인`은 코드구조(domainmap) 뷰에만, 그 외 `카테고리` 통일.

---

## Phase 6 — 스크립트/문서 정리

- `scripts/archive/` 신설 → 일회성 마이그 **11개** 이동: `v6-migrate`·`v5-area-decouple`·`v4-absorb-kinds`·`v4-apply-reclass`·`drop-item-legacy`·`migrate-items-to-ku`·`migrate-item-mappings-to-ku`·`migrate-content`·`backfill-ku-revision`·`backfill-embeddings`·`backfill-domainmap-trust`. (운영 유지: `parity-check`·`scan-content-secrets`·`build-classify-runbook`·`register-clients`·stage6 골든.)
- `runbooks/` v6 정합성 재확인(이미 knowledge_unit 잔여 0).

---

## 실행 순서·원칙

1. **Phase 0 → 1 → 2 가 우선**(안전망→죽은코드→공유레이어). 여기까지가 "정돈"의 80%, 리스크 최저.
2. Phase 3(리네임)은 **0~2 완료 후** — 중립 db 레이어가 생긴 뒤라야 깨끗.
3. Phase 4·5 는 독립 가능(병렬).
4. **각 단계: 빌드+lint+테스트 green 확인 후 다음.** 리네임은 커밋 1=리네임 1.
5. 동결 계약(tally key·DB컬럼·프론트 계약·502토큰)은 **의도적으로 보존**.

## 규모감 (대략)

| Phase | 성격 | 블래스트 |
|---|---|---|
| 0 안전망 | 설정+DROP+정리 | 소 |
| 1 죽은코드 | 삭제 위주 | 소~중 |
| 2 공유레이어 | 추출+중앙화 | 중 |
| 3 리네임 | 광범위 import 재작성 | **대** |
| 4 capabilities | 재편+은퇴 | 중 |
| 5 웹 | 모듈분할 | 중~대 |
| 6 스크립트 | 이동 | 소 |
