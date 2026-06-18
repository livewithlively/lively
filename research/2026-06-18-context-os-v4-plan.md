# Context OS v4 — 분류 재설계 실행 계획 (캐노니컬)

> v3(2026-06-18 새벽 출하, `research/2026-06-18-context-os-v3-plan.md`) 위에서 **분류 모델을 정리**. 윤상민과 긴 설계대화로 전 결정 확정("다 추천대로 가고 끝까지 멈추지말고 구현"). 본 문서가 v4 빌드의 단일 ground-truth. 빌드 에이전트는 이 문서 + 해당 소스를 읽고 구현.

## 0. 운영 규칙 (밤샘 자율, ultracode)
- 메인 체크아웃 직접 작업 + :8080 직접 반영. 페이즈 순차: 구현→적대검증→gates(build/typecheck/test/parity)→커밋→배포→e2e. 비파괴(백업·롤백), 게이트 후에만 라이브, 정직 보고. 시크릿 미출력.
- v3 자산(43 authored + 71 observed = 114 ku, domainmap, 36 MCP툴) 비파괴 보존하며 정리.

## 1. 확정 결정 (전부 윤상민 승인)

### A. KIND = 본질만, 4종 (+S/G federated)
- **ku kind = R·K·H·W.** 흡수: **A→K**(산출물=독자대상 지식포장, 본질은 지식)·**D→K**(도메인은 *축*[domain_key]이지 kind 아님)·**F→K**(외부/인용은 provenance+area가 잡음)·**M·L·Z→K**.
- **H(절차/런북) 유지** — 라이블리 ③축(AI워크플로 표준화) 핵심 산물. **W(작업) 유지** — 액션 아이템(상태·담당).
- **S(구조)·G(용어집) = domainmap 파생 그래프 = federated 뷰**(ku kind 아님 — 모양이 글이 아니라 노드+엣지라 domainmap DB에 삶, 웹/ctx가 모아 보여줌).

### B. AREA = 주제, 2단 `(space, key)` (kind 아님 — 축)
- `space=product` → **domainmap 도메인**(코드앵커·부채추적·CRUD).
- `space=business` → **비즈니스 기능**(vocab-only·CRUD·코드앵커X). **시드 6**: `gtm`·`business-model-pricing`·`fundraising`·`market-competition`·`brand`·`org`. (시장·경쟁=business의 한 key.)
- **null 허용**(전사)·**다중 허용**. 구현: domainmap `domain`에 `space` 컬럼 추가, business 기능 = space=business 도메인행(코드매핑 없음), knowledge_unit_domain 조인이 area를 표현.

### C. PROVENANCE (구 confidence — **개명**) = 출처, 기계적/사실
- 값 4: **observed**(외부 시스템 *살아있는 미러* — 클릭업·노션, 진실·편집 외부, 재싱크)·**human**(사람 저작/승인)·**ai**(AI 에이전트 모델판단 생성)·**rule**(시스템 결정론 알고리즘 파생 — *진짜* 파생만).
- **검증상태 별도축 없음** — lifecycle이 처리(사람이 reject). **provenance는 주입·가치 결정 안 함**(채널이 기계로 박는 사실).
- 값 의미 수정: `rule` 오라벨(마이그 import 34건)→*진짜 출처*(human/ai)로 재분류; distill 제거; domainmap origin `agent`→판단=ai/결정론스캔=rule 분리. 사람이 ai 유닛 *편집*→provenance=human(마지막 저자).

### D. LIFECYCLE = 상태: active·superseded·rejected (불변).

### E. 분류(kind+area)는 *판단*, provenance는 *기계*
- 웹/MCP: 판단 inline(사람/세션LLM이 쓰며 kind·area 판단). **커넥터·코드스캔·운영: 기계 인입(provenance 확정) + LLM 분류패스(kind·area 제안)+사람 큐레이션.**

### F. 주입 = 검색(retrieval), 정적 랭킹/중요도 폐기
- **R(규칙)=항상 주입**(맥락무관). **나머지=정적 주입 안 함** — 세션엔 *area 지도(≈20개, 작고 완전)*만, 에이전트가 일에 맞춰 **area+검색으로 그때 소환**. **importance 축 없음**(맥락 상대적). **observed→인덱스제외(H2) 폐기**(주입은 출처 아닌 kind/검색이 결정).

### G. 증류 = batch/규칙 distill 제거 → **in-flow 저작만**. (미래 on-demand LLM 합성은 증거 생기면.)

### H. 수집 5채널 + 정체성 dedup
- 채널: 커넥터(PM/문서)·코드스캔(git)·웹·MCP·(운영)CLI. db_query=읽기(수집 아님).
- **dedup = 정체성 기준 채널무관 upsert**: 미러=`(external_system,instance,external_id)`·저작=`name`. 키도출 1함수 중앙화, DB UNIQUE 백스톱.

### I. SoT = ku 단일홈 (C 승인)
- *우리 지식*(research·결정·설계): **ku가 유일한 집** — `ctx_save`로 전문 직접 기록, **레포 .md 안 만듦·포인터 안 씀.** `research/*.md`·lively-org 레포 = **지식 SoT에서 은퇴(동결)**, 백업/생성물로 강등. *외부 원본*(클릭업·노션·코드)=외부 소유→미러(observed), 파생 인사이트만 별도 authored.

### J. 쓰기 가이드 배선 + 어휘 CRUD 권한 + 훅 가시화
- **쓰기 가이드**(현재 0): 주입/런북이 *언제(in-flow)·어디(ku)·무엇(전문)·분류(kind R/K/H/W + area)·외부(복제말고 미러+파생)* 를 안내. 주입문 "lively-org=SoT"→"ku 캐노니컬" 갱신.
- **어휘(도메인·기능) CRUD = context 스코프**(admin 완화 — 지금 yoon admin 없어 못 씀).
- **훅 주입 가시화 웹UI**: 3훅(session-preload·work-flag·stop-writeback) 각자 *최종 주입 메시지* 미리보기.
- **버그**: "팀 메모리" 화면 observed 누락(listMemory가 observed 미제외→112; 큐레이션만 보여야).

### K. 기존데이터 재분류 (D 승인)
- 기존 114유닛 **LLM로 kind(4종)·area(space+key) 재분류**(특히 71 observed: 노션·클릭업 내용 기반). + provenance 오라벨 수정. 비파괴·백업·멱등.

## 2. 페이즈 (의존성順 — 설계 워크플로가 정교화)
- **V4-P1 분류 코어+ground-truth**: kind_registry→R/K/H/W(+S/G federated)·정의/기준/저장/전달·injection_mode(R=enforced/나머지=on-demand) · area(domain.space + business 기능 vocab+시드6) · provenance 개명+값정의 · 런북 knowledge-types + 웹 #/learn 갱신(non-stale). 비파괴 ADD/reseed.
- **V4-P2 데이터 재분류(LLM)**: kind 흡수(A/D/F/M/L/Z→K) + LLM area/kind 재분류(114, 특히 71 observed) + provenance 오라벨 수정. 백업·멱등.
- **V4-P3 주입·검색 재작성 + 쓰기가이드 + distill 제거**: buildKnowledgeIndex→규칙+area지도(중요도/observed제외 폐기)·session-preload·쓰기가이드 주입·distill.ts 제거·"lively-org=SoT" 문구 갱신.
- **V4-P4 SoT 단일홈 + 인입 판단 + dedup**: ku 캐노니컬(레포-SoT 동결)·커넥터/스캔/운영 LLM분류 패스·dedup 키 중앙화.
- **V4-P4 SoT+인입+dedup ✅ (커밋 f1c5030, 재배포·라이브 검증)** — dedup: external-identity.ts 단일홈(KIND_MAP/kindForSource/unitName/conflictKey), 복붙 2→1(mirror import·migrate.mjs dist import), 골든4(REF오라클 동치). ingest: ingest-classify.ts classifyIngest() — 무키=mechanicalFallback byte-identical(전 KIND_MAP 오라클), 키=fetch haiku-4-5 forced tool_use(새 dep0)·4중가드·graceful폴백, 9테스트, 활성화=.env ANTHROPIC_API_KEY. SoT: research/lively-org 캐노니컬 읽기 코드경로 0(전부 isMain CLI/신원축/백업), README 명문화, 주입문 일관. 게이트 build/typecheck/test/parity36·65 pass. 라이브 kinds=H,K,R,W·active45·observed71·learn4 무회귀. 적대검증 전 finding info·블로커0.
- **V4-P5 웹**: #/learn 신택소노미(KIND_META 12→4)·area 필터(space product/business)·어휘CRUD context스코프·팀메모리 observed 버그(store.ts:269)·훅 주입 가시화 UI·vocab 37→36 문구.
- **V4-P5 웹 ✅ (커밋 10c2348 + 후속 8efa51f, workflow-std b206f6b, 재배포·시각검증)** — listMemory+searchMemory observed제외(knowledge.ts confidenceNot, 라이브 팀메모리 114→43)·ctx_grep/search_items observed포함 유지. hooks-preview.ts + GET /api/ui/org/hooks/preview 3훅(session-preload=previewMemberContext 단일소스·work-flag 빈·stop-writeback REASON 추출)·라이브 3훅 반영. app.js KIND_META 12→4(R/K/H/W)+FEDERATED(S/G)/LEGACY 폴백·area space 2단필터(19→13 실증)·어휘 CRUD context스코프+business기능·훅 가시화 화면. 어휘 CRUD 이미 scope:context=서버 무변경. vocab 37→36. **playwright 시각검증 전화면 PASS**(map 4종카드·area섹션·browse space필터·system 훅/어휘/레지스트리·팀메모리43·콘솔에러0·레이아웃정상). 후속: app.js 12→4 주석·stop-writeback REASON v4(distill→ctx_save) 정정. 게이트 build/test/parity36·65·node --check. 블로커0.
- **V4-P6 최종 종합검증**: 라이브 시스템 e2e + 회귀 + 고객 셀프호스트(fresh boot) 멱등성.

## 설계 확정 (w7oy1kg5e — 빌드 에이전트 필독)
- **provenance 개명 = 물리 컬럼 rename 안 함.** `knowledge_unit.confidence`(enum)와 `mapping/item_domain/item_project/knowledge_unit_domain/knowledge_unit_project.confidence`(REAL 0~1 매핑신뢰도)가 같은 코드·INSERT 공존 → grep-replace 치명회귀. **컬럼 confidence 유지 + 의미/UI/문서 라벨만 "출처(provenance)"로**(~10곳). enum 값(observed/human/ai/rule) 불변 → CHECK·116행 안전.
- **kind CHECK narrow + registry-row 제거(A/D/F/M/S/G) = P2** (데이터 흡수 *후*). P1에서 좁히면 라이브 56행(A41/D6/F7/M2) 위반→ADD CONSTRAINT throw·부팅깨짐. 현 kind_chk는 NOT EXISTS만이라 confidence-CHECK식 DROP+probe(pg_get_constraintdef LIKE)로 교체. **P1=additive only(removal/narrow 없음, 12 kind 인식 유지→무중단)**, P2가 흡수+registry제거+CHECK narrow 원자 수행.
- **S/G**: 라이브 0행 → P2에서 registry/CHECK/KIND_META 제거하고 domainmap 파생(debt federate 패턴). CHECK→(R,K,H,W).
- **golden-compare 재캡처 필수**: `scripts/stage6-golden-compare.mjs`가 listDomainsApi를 deepStrictEqual → DomainListItem `space` 추가 시 깨짐. P1에서 베이스라인 재캡처.
- **LLM 재분류(P2)**: per-unit Haiku, tool-use 구조화출력(enum kind 4 + 통제어휘 area), 본문 8KB 트렁케이트, 본문해시 캐시+temperature=0(비결정성·비용 차단), 4중가드(enum+통제어휘·conf<0.7 보류·보수 오버레이·ai/proposed 격리), **외부 API 송신 전 redact 재검증(H1)**. **@anthropic-ai/sdk 신규 설치 + ANTHROPIC_API_KEY 필요**(없으면 기계흡수만 하고 LLM패스 보고). 모델ID/tool-use는 **claude-api 스킬** 확인.
- **결과 격리**: LLM 제안 = confidence='ai'+state='proposed'(인덱스 자동진입 X, 큐레이션 큐). 사람 confirm 후 진입.
- **business 시드6** = productivity repo에 space='business'(ctx_save가 단일 repo 검증).
- **materialize.test 3케이스**(recalled필터·H2 observed제외·recalledKinds)는 P3가 삭제하는 동작 → P3에서 재작성(fail-by-design).
- **observed 폐기 정밀**: "주입 결정 안 함(kind/검색이 결정)"으로 의미전환하되 **overview observed_count·팀메모리 구분은 유지**(P5 버그픽스 정합).
- **dedup**: unitName+KIND_MAP+conflict키 복붙 2벌(knowledge-mirror.ts + migrate-items-to-ku.mjs, 현 byte-identical)→`src/org/external-identity.ts` 추출, byte-identical 회귀테스트.
- **distill 제거(P3)**: distill.ts/test/scripts + package.json:15 + materialize.ts distill source_ref 절 한 커밋. 라이브 0건.

## 진행 로그
- **V4-P1 분류코어 additive ✅ (커밋 4574fc0, :8080 라이브)** — kind_registry R/K/H/W v4 정의(legacy 보존)·domain.space+business 시드6(active 36도메인=product30+business6; '37'은 merged product 1행 오포함 오라벨 — P5 정정)·provenance 라벨(컬럼 confidence 불변·mapping REAL 무오염)·런북/웹 4kind(legacy graceful)·golden core-mode 재캡처(68). 무중단(kind CHECK 12값·데이터 UPDATE 0·ku 116[45+71] 무손상). 블로커0. 실측정정: ku 116·domain active 36.
- **⚠️ P2 LLM 키 부재**: .env에 ANTHROPIC_API_KEY 없음·SDK 미설치 → 독립스크립트 LLM 불가. **재분류는 워크플로 에이전트(모델접근)로 = 키 불요.** P2 분할: **P2a=기계 흡수+CHECK narrow+registry 정리(결정론)**, **P2b=LLM area/kind 분류(워크플로)**. 런타임 인입 LLM(P4)=키 게이트+기계폴백(현 KIND_MAP), 키 확보 시 활성.
- **V4-P2a 기계 흡수 ✅ (커밋 2d22da5, :8080 라이브)** — A/D/F/M→K 56행(+kinds[] 17정규화), CHECK narrow(R,K,H,W), registry 4행, S/G federate(0행 무손실). 백업 ku/kud/kup _v4bak_p2a. 멱등(재실행 md5 동일·쓰기0)·116/observed71/kud154 무손상. 라이브 K84/R2/W30·learn 4kind. test157·parity65·36툴·golden68. 블로커0. (distill D→K 임시브리지=P3 제거, 인입 KIND_MAP 기계폴백=P4 LLM.)
- **V4-P2b LLM area/kind 분류 ✅ (커밋 49bd8c1, 라이브)** — 워크플로 10병렬(키불요). area llm-proposed 161(state=proposed·구조적 격리=buildKnowledgeIndex가 ku만 읽음)·provenance rule34→ai19/human15(rule 0·observed71 무손)·kind 보수0적용(human무override 입증·conf<0.85 보류5=P5). ku116/kup70 불변·백업 p2b·멱등. test157·parity65·36툴. 블로커0. (vocab 실제 36[product30+business6], 문서 '37' 오라벨=P5 정정.)
- (V4-P3 착수: buildKnowledgeIndex 재작성[R 전문 항상주입 + area지도 ~36 + 쓰기가이드, 중요도캡·observed제외·title리스트 폐기] + materialize.test 3케이스 재작성 + distill 전면제거(ts/test/scripts/pkg/source_ref/D→K브리지) + ctx_save·session-preload 쓰기가이드 + org-defaults 'lively-org=SoT'→'ku 캐노니컬'. WYSIWYG·observed_count 유지.)
- **V4-P3 주입·검색 재작성 ✅ (커밋 5c35d2d + workflow-std c7f9b74, 재배포·라이브 검증완료)** — 재기동 후 /api/ui/org/preview 실증: 강제규칙 전문 + area지도(product30/business6) + 쓰기가이드 3블록 라이브, `ctx_cat name=` 잔존 1=가이드 소환예시(옛 title리스트 0), distill 코드 grep 0, observed_count71·learn 4kind 회귀정상. SoT 문구 "캐노니컬은 ku" 주입문 반영. buildKnowledgeIndex v4: R(규칙) 전문 항상주입(enforced) + area지도 36(space별 product30→business6, active수 메타, e2e-sandbox 2 포함) + 쓰기가이드 블록(WRITE_GUIDE_BLOCK 단일상수). **제거**: PER_KIND_CAP/TOTAL_CAP·recalled제목리스트·observed제외필터·distill source_ref절. signature `buildKnowledgeIndex(units, areaMap)`. 라이브헬퍼 areaMapForIndex(domainmap+items 두DB 메모리조인·fail-open). 콜러(publish.previewMemberContext/materialize)·static-context.test 를 areaMapForIndex 로 갱신(recalledKindsForIndex 폐기). **distill 전면제거**: distill.ts/test, scripts/distill.mjs, package.json test체인줄, dist맵 — 함수참조 grep 0(코멘트 1줄만 잔존=제거기록). 라이브 distill 0건(정리불요). **쓰기가이드 배선**: ctx_save desc(kind R/K/H/W·area domain·외부 미러+파생)·session-preload tail(canonical+~/.lively/hooks 동기)·org-defaults R본문 SoT→'캐노니컬은 ku'(knowledge_unit 'org-defaults' body 직수정, kind=R/conf=human/active 보존·백업 org-defaults__ku_v4bak_p3 + 레거시 org_content 동기·백업 __v4bak_p3). materialize.test 12 v4 재작성(R전문·K/H/W미주입·observed폐기·area렌더·가이드·무캡·redact·멱등). **게이트**: build·typecheck·test(전수 pass·distill줄 제거)·parity36툴·65건. **WYSIWYG byte-identical**: preview↔static 동일 인덱스 md5(6986B) 임베드 입증. observed_count 71·total_active45 보존. **라이브 :8080 미반영**(restart 금지 — 새 구조는 next-restart 시·SoT문구 DB변경은 즉시 라이브). 블로커0. (kind_registry injection_mode 라벨[K/H=recalled]은 이제 표시용·미사용=무해.)
