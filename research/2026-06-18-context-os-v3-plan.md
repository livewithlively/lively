# Context OS v3 — 실행 계획 (캐노니컬)

> 출처: 발견+설계 워크플로우 `wf9fwhmow`(9 에이전트, 발견 A~E + 설계 1~3 + 완전성 비판). 본 문서가 v3 빌드의 **단일 ground-truth 계획**이다. 빌드 에이전트는 이 문서 + 해당 소스를 읽고 구현한다. 결정은 윤상민 위임("설계 나오면 확인받지 말고 판단해서 끝까지").

## 0. 운영 규칙 (밤샘 자율)
- **메인 체크아웃 직접 작업 + :8080 직접 반영**(워크트리 불요 — 동시세션·런칭 없음). 단 **페이즈 순차 실행**(메인 충돌 방지), 각 페이즈: 구현 → 적대검증 → gates(build/typecheck/test/parity) → **커밋** → 배포(restart 또는 정적) → e2e 테스트.
- **품질 바 유지**: 비파괴(item→item_legacy 보존, DB 백업/롤백 경로), 게이트 통과 후에만 라이브, 결과 정직 기록("라이브 반영"은 실제 배선 확인 후).
- 시크릿 절대 출력 금지. 모든 변경 출처 명기.

## 1. 확정 아키텍처 결정
- **D-ARCH: knowledge_unit = 단일 캐노니컬 표면.** 커넥터가 활동/태스크를 `kind=A/W` 행으로 knowledge_unit에 적재(source/external_id/fields/raw/sync_state + 다중도메인 매핑 조인). `item`은 **item_legacy로 리네임·보존**(비파괴), 읽기경로 전환 후 아카이브. 물리 2계층이지만 *표면은 단일* — 사용자 의도(커넥터→신모델)와 데이터 강제(PK/다중매핑/상태축 상이)를 화해. **정직: "단일 표면 + 레거시 보존", 완전 단일테이블 아님.**
- **D-GT: ground-truth = `kind_registry`(description/criteria/storage/delivery 컬럼 채움) + 신 `data_source` 레지스트리(소스별 수집방식).** 런북(LLM)·웹(`#/learn`, 비개발자)이 **여기서 렌더**(non-stale). 하드코딩(RECALLED_KINDS 등) 제거→테이블.
- **D-INJ: 훅이 지식 인덱스(buildKnowledgeIndex/org_preview)를 실제 주입.** 현 훅은 status만 주입·인덱스 미배선. 정적 폴백(context.md에 인덱스 박기)도. **로컬 ~/.claude는 주입 검증 후** 포인터/스코프로 화해(순서 강제 — 안 그러면 메모리 공백).
- **D-G: G kind 정합화** — 원 분류 G=부채(debt)이나 registry G=Glossary/Graph. 결정: **부채는 domainmap debt_finding을 federate(파생 뷰)**, G kind는 라벨/정의를 ground-truth 3곳(스펙·런북·웹) 모두에 일관 명문화(중복정의 금지).
- **D-PROJ: project '붕뜸' = provenance_kind 분리.** `initiative`(PM-tool provenance, 4행) vs `code_grouping`(doc-derived, 45행·touch 558). W(clickup task)↔initiative 링크. code_grouping 재배선은 별 마이그(설계는 본 문서에 존재, 실행은 후속).
- **D-RENAME: domain_rename = soft-alias**(old_key→new_key 매핑 테이블, 물리 key 불변) — items DB와 domainmap DB는 **별 DB라 cross-DB 트랜잭션 불가**(H3). 물리 cascade 금지.
- **D-DISTILL: 증류 v1 = 규칙만**(LLM 0; 예: 같은 도메인 N회 declared task → D 후보), opt-in, **proposed TTL/캡 + 멱등 후보키(source_ref+kind)**로 적체·재후보화 억제(H4). LLM 증류는 v2.

## 2. 치명 완화 (각 페이즈에 반드시 내장)
- **🔴H1 시크릿 주입유출**: `fields`/`raw`(커넥터 원본) 추가 시 — (a) ingest가 knowledge_unit 쓰기 전 `redactDeep`, (b) `buildKnowledgeIndex`/preview 출력에 `assertNoHardSecrets` 게이트, (c) ctx_cat/memory_search **pull 경로도 redact**(인덱스 비주입만으론 불충분). publish.ts/materialize.ts/delivery.ts preview에 redact 0건이 현 사실.
- **🔴H2 confidence='observed' 파급**: 신값 추가 시 — review 큐 제외, overview 별도 카운트("수집물 N"), **주입 인덱스 영구 제외**를 불변식으로. app.js confidenceDot 3값 가정 갱신.
- **🔴H3 rename 원자성**: soft-alias(위 D-RENAME).
- **🔴H4 증류 골격**: 규칙판+TTL/캡(위 D-DISTILL).
- **🟡M-가 parity/표면**: org/ctx/materialize **테스트 파일 부재** → 신 툴 추가 전 테스트 선작성. 31→확장 시 `capabilities/index.ts` 카운트 주석 동기화 + 툴표면 단언 테스트 + 신툴 각 expose·parity 케이스.
- **🟡M-나 project 재배선**: code_grouping vs initiative UNIQUE(repo,key) 공간·네임스페이스 혼재 — 별 테이블 분리 또는 key kind-접두.
- **🟡M-다 고객 마이그**: 마이그 멱등·롤백(`--check`에 스키마버전·observed enum·source 컬럼 검사), INSERT…SELECT 1회성 가드.
- **🟡M-라 성능**: item 흡수로 knowledge_unit 급증 + ILIKE full-scan → **pg_trgm GIN 인덱스**(pgvector 없이 ILIKE 가속), A/W는 검색 source 필터.
- **🟡M-마 권한**: 신 CRUD(repo/domain/project) 각 op scope·protected repo·agent vs human을 화이트리스트(domainmap-curation.ts 패턴)로.
- **🟢L**: kinds[] CHECK 가드 실제 추가(17/43 실사용), 재발행 멱등(인덱스 중복 누적 방지), 레거시 read 래퍼 전환 순서(archive 전 전환), G≠debt 3곳 일관.

## 3. 실행 순서 (11단계 → 페이즈; 의존성 강제)
- **P-V3-1 주입 배선**(순서1·2): 훅이 지식 인덱스 주입 + 정적 폴백(context.md 인덱스). redact 게이트(H1-b). 최고가치·최저위험. 훅 소스=workflow-std/hooks/session-preload.mjs(생성물 ~/.lively/hooks/ 재발행). org_preview 엔드포인트 활용. 멱등 재발행 검증.
- **P-V3-2 ground-truth+런북+웹**(순서3·4): kind_registry 확장·시드(description/criteria/storage/delivery) + data_source 신설(비파괴 ADD COLUMN). 하드코딩→테이블. 런북 빌더(build-classify-runbook.mjs) + 웹 `#/learn`(12 kind 설명·분류기준·저장·전달 + 소스별 수집, 비개발자 쉬운말, 마크다운 렌더 재사용). non-stale 불변식 실증. G≠debt·kinds[] 명문화.
- **P-V3-3 단일스토어 데이터층**(순서5·6·7): knowledge_unit 스키마 확장(source/kind/sync_state/external_id/external_url/parent/fields/raw + observed enum) + 다중도메인 매핑 조인 + pg_trgm. 커넥터/pm_* 적재 전환(item→knowledge, kind A/W). 읽기경로 전환 + item→item_legacy. **H1·H2·M-다·M-라 내장. 테스트 선작성(M-가). 최대 수술·최대 위험 — 가장 엄격 검증·롤백(item 보존).**
- **P-V3-4 도메인/repo/project CRUD**(순서8): repo CRUD, domain CRUD(soft-alias rename), project provenance_kind 분리·W↔initiative. H3·M-나·M-마 내장.
- **P-V3-5 로컬 화해**(순서9): ~/.claude 중복 → 포인터/스코프. **P-V3-1 주입 검증 후에만.**
- **P-V3-6 증류 v1**(순서10): 규칙판+TTL/캡, opt-in.
- **P-V3-7 후속**(순서11): UserPromptSubmit recall + pg_trgm/pgvector. (시간/안정성 보고 판단.)

## 4. 페이즈 공통 산출
각 페이즈 완료 시: 커밋 해시·변경파일·게이트결과·적대검증 발견/수정·라이브 배포·e2e 결과·잔여리스크를 본 문서 말미 "진행 로그"에 추가(또는 보고). 모든 주장은 실측.

## 진행 로그
- (P-V3-1 착수 예정)
