# Lively

*[English](architecture.md)*

라이블리 **통합 컨텍스트 스토어** — 모든 로컬 AI 도구(클로드코드 · Codex · OpenCode · Antigravity CLI · Grok Build …)가 붙는
사내 **MCP 게이트웨이** 한 대. 조직 지식(WIKI) · 분류축(category) · 프로젝트/과업 · 도메인 맥락 · DB(읽기전용) 를
한 곳에서 노출하고, **퍼유저 인증 + 스코프**로 통제한다. 웹 UI · 웹 터미널 · 수집기 · 스케줄러도 이 게이트웨이가 맡는다.

```
로컬 CLI들 ──(Streamable HTTP /mcp, Bearer)──▶ 이 게이트웨이 ──▶ 지식(WIKI) · 분류/프로젝트/과업 · 맥락 · DB(읽기전용)
                                                   └ 인증·스코프·감사의 단일 경계
```

> 로컬 CLI·사내 브라우저만 붙는다면 **퍼블릭 노출이 필요 없다.** 사내망 URL이면 충분.
> (claude.ai·ChatGPT 같은 외부 챗 표면을 OAuth 로 붙이려면 그쪽에서 닿는 공개 주소가 필요하다.)
> 단, 모델 추론은 LLM 클라우드로 가므로 **툴 결과(코드·DB 데이터)는 컨텍스트로 외부 전송**된다 —
> 컴플라이언스가 걸리면 PII 마스킹/셀프호스팅 모델을 검토할 것.

## 구조

| 영역 | 파일 | 비고 |
|---|---|---|
| 엔트리포인트 | `src/index.ts` · `src/boot/mcp-transport.ts` | Express + Streamable HTTP + bearer 인증 |
| 서버 조립 | `src/server.ts` · `src/mcp/dynamic-tools.ts` | 능력 계층 등록 — MCP 표면은 `expose.mcp:true` capability 자동등록(단일 SoT — 카운트를 하드코딩하지 않는다. 실제 집합은 `src/capabilities/index.ts` 의 `buildToolCandidates`/`isToolExposed` 가 정한다) + 웹 정의 `org_tool`(http_proxy) `/mcp` **동적 등록**(SSRF 가드)·빌트인 on/off 게이팅 |
| **보안 경계** | `src/context.ts` | `resolveUser → requireScope` — 모든 툴 첫 줄 |
| 인증 | `src/auth/bearer.ts` | 정적 토큰(`AUTH_TOKENS_JSON`) + **DB 토큰**(`auth_token`, sha256·revoke 즉시·재시작 불요). OAuth 2.1 인가서버(`src/org/auth/oauth-*.ts`, #1473)가 발급한 토큰도 같은 `auth_token` 에 들어가 이 검증기를 탄다 |
| **능력 계층** | `src/capabilities/*` | op = 스키마·스코프·핸들러 단일 정의 + `expose{mcp,rest}` 선별 노출 — knowledge·categories·projects-v6·task-v6·activity·context·domainmap-curation·**delivery(웹 관리/전달)** |
| **전달/관리** | `src/capabilities/delivery.ts`(+ `delivery/`) | 웹 `/ui` '관리' 탭 — org-content(강제규칙·맥락·WIKI 인덱스·구성원)·토큰·**커스텀 훅(`org_hook`)·AI 도구(`org_tool`)·MCP 서버·런타임 설정**. admin/runtime scope·REST(웹) + MCP(에이전트) 양쪽 노출(#549 — 회수 가능한 DB 토큰만, 모든 쓰기는 `org_content_audit` 감사). 항목별 '구성원에게 미치는 효과' 의미 패널 + auto-approve |
| **조직 지식(WIKI)** | `src/capabilities/knowledge.ts`(+ `knowledge/`) | `knowledge_save`/`knowledge_grep`/`knowledge_search`/`knowledge_get`/`knowledge_list`/`knowledge_set_lifecycle`/`knowledge_set_wiki`/`knowledge_link_category`/`knowledge_delete`(휴지통·사람전용) — 단일 `knowledge` 테이블이 진실원천(SoT). 신규 저장은 category 1개 + type(page-type) 필수(#290). 아래 §SoT 참조 |
| **분류축(category)** | `src/capabilities/categories.ts` | `category_*`(create/update/get/list/delete·edge_*) — 사업·제품·시스템 분류축. **제품 카테고리=도메인**(탈-repo, 단일 `category` 테이블) |
| 프로젝트/과업 | `src/capabilities/projects-v6.ts` · `src/capabilities/task-*.ts` · `src/capabilities/activity.ts` | `project_*_v6`/`task_*_v6`/`activity_*` |
| 도메인 맥락 | `src/capabilities/context.ts` | `context_overview`/`debt_list`/`repo_*`/`domainmap_proxy` — domainmap 읽기(리더 함수 직결) + repo 관리. (`all_domains`·`domain_list`/`domain_get` 은 **제거** — v6 `category_*` 가 대체) |
| domainmap 엔진 | `src/domainmap/` | 흡수된 엔진 모듈 — `db.ts`(items DB 풀 재수출 shim — 실체는 `src/db/client.ts`) · `core/`(reconcile·changelog·mappings·debts·domain-debt·refresh·refresh-fs·repos·scan-fs·schema) · `cli.ts`(호스트 CLI) · `webhook.ts`(HMAC push-refresh) · `git-pull.ts`(스케줄러 폴링 refresh) (통합 DB — `ITEMS_DATABASE_URL`) |
| DB | `src/tools/db.ts` | `db_sources` / `db_schema` / `db_query` — 멀티 데이터소스(`source` 인자·`org_db_source` 등록), 방화벽·RLS·timeout·감사 |
| DB 안전장치 | `src/db/firewall.ts` · `src/db/sources.ts` | 단일 SELECT + 위험함수(`set_config`/`current_setting` 등) 차단 + 민감 테이블(`auth_token`·`org_*`) deny · 소스 레지스트리 |
| RLS 예시 | `sql/rls-example.sql` | 읽기전용 role + 행 정책 |
| 클라 등록 | `scripts/register-clients.sh` | 4종 등록 |

> 구 `memory_*`(2026-06-24 폐기)·`ctx_*`(흡수)·`search_items`/`get_item`·`propose_domain`/`domain_set_should`·구 `pm_task_*` 는 전부 위 `knowledge_*`/`category_*`/`task_*_v6` 표면으로 통합됐다. `code_*` 툴은 컷.

## 코드 구조 관례 (#1313 구조 리팩토링 캠페인이 세운 것)

기능을 덕지덕지 얹어 한 파일이 수천 줄이 되던 상태를 축을 따라 갈랐다. 새 코드를 얹기 전에 이 세 가지를 안다.

### ① 서브시스템 디렉터리 — 파일이 어디 사는가

| 디렉터리 | 소관 |
|---|---|
| `src/capabilities/` | **표면** — op(스키마·스코프·핸들러) 정의와 `expose{mcp,rest}`. 하위 폴더(`knowledge/`·`delivery/`)는 큰 표면을 가른 것 |
| `src/v6/` | **캐노니컬 스토어 계층** — 엔티티당 1파일 + 병치 테스트. 전용 관례는 [`src/v6/README.ko.md`](../src/v6/README.ko.md) |
| `src/org/` | 조직 설정·전달(배포/온보딩)·자격금고·인증·수집 정책 스토어 |
| `src/db/` | **범용** `db_query` 스택(방화벽·마스킹·소스 레지스트리·접근감사). 온톨로지를 몰라야 한다 — 아는 코드는 `src/db/self/` 안에만 |
| `src/domainmap/` | 도메인맵 엔진(`core/` + CLI + 웹훅 + git 폴링. DB 풀은 `src/db/client.ts` 공유) |
| `src/connectors/` | 수집 커넥터(Slack·Notion·GitHub … — 레지스트리 `index.ts`) + 증분 싱크 러너(`run-sync.ts`) |
| `src/apps/` | 앱(에이전트·도구) 패키지 로더·설치·worker 실행 호스트(#1780) |
| `src/enterprise/`·`src/ee/` | Enterprise 경계 — `src/enterprise/` 가 코어 쪽 훅 레지스트리·동적 로더, `src/ee/` 가 선택 모듈(상용 라이선스). 코어는 `src/ee/` 를 정적 import 하지 않는다 |
| `src/node/`·`src/terminal/`·`src/sessions/`·`src/preview/`·`src/scheduler/`·`src/broker/` | 워커 노드·터미널·세션기록·프리뷰 환경·크론·중계 |
| `web/*.ts`(루트) | 탭/화면 단위 모듈 1개 = 파일 1개 |
| `web/lib/` | 프레임워크 없는 **공용층**(dom·net·format·markdown·state·overlay·avatar …). **페이지를 절대 import 하지 않는다**(기계 검증) |
| `web/v2/` | 새 앱 셸(#1719) — 좌측 레일·사이드바·앱 인스턴스·도킹 칸. 뿌리는 `web/v2/main.ts` |
| `web/dash/`·`web/projects/`·`web/taskmodal/`·`web/editor/`·`web/terminal/` | 대형 화면을 축을 따라 가른 조각(홈 셸+위젯 / 보드·상세 부품 / 태스크 모달 섹션 / 블록 에디터 / 터미널 부품). 같은 이름의 `web/<x>.ts`(대시보드는 `web/dashboard-home.ts`, 에디터는 `web/block-editor.ts`)가 그 배럴이다 |
| `web/guide/` | 「사용 가이드」 앱(#4179) — 화면·본문·도식 |
| `web/standalone/` | 별도 tsconfig — 클래식 `<script>` 단독 페이지용. **SPA 번들(`public/app`)에 섞이면 안 된다** |

`public/app/`·`dist/`(+ 단독 페이지 번들 `public/terminal.js` 등)는 **빌드 산출물**이다 — 웹 산출물도 `dist/` 처럼 git 밖이고(#2054) `npm run build` 가 만든다. 손으로 고치지 마라.

### ② 배럴 패턴 — 옛 import 경로를 살려 두는 법

큰 파일을 가를 때 소비자 수십 곳을 한 커밋에서 다 바꾸지 않는다. 대신 **원래 파일명을 재수출 전용 배럴로 남긴다**
(`web/taskmodal.ts`·`web/admin.ts` 는 순수 배럴, `web/core.ts` 는 게이트 + 배럴, `web/learn.ts` 는 UI 프리미티브 몫만).

- 배럴에 **로직을 두지 않는다.** 실체는 이름이 역할을 말하는 모듈에 산다.
- 배럴에 **새 심볼을 추가하지 않는다.** 새 소비자는 실체 모듈에서 직접 받는다 — 배럴 경유는 소유가 이미 옮겨간
  심볼을 통과-재수출하는 **가짜 소유**를 만들고, 그게 순환 import 의 주된 원인이었다.
- 배럴은 **줄어드는 방향으로만** 간다. 소비자가 0이 되면 파일을 지운다.

### ③ 상주 게이트 4종 — 구조를 기계가 지킨다

리팩토링이 조용히 무언가를 깨뜨리는 사고를 사람 눈 대신 CI 가 잡는다. 구조를 건드렸으면 넷 다 돌려라.

| 게이트 | 실행 | 막는 사고 |
|---|---|---|
| **러너** | `node scripts/run-tests.mjs` | 유닛 회귀 일반. 소스 글롭 자동 발견이라 **테스트 추가 = 파일 생성만**(등록 불요). **병렬(`-j`)·실패해도 끝까지** 돌고 끝에 실패를 모아 보고한다(#1431 — 실측 121s→42s). 계층·옵션은 [`scripts/README.ko.md`](../scripts/README.ko.md) |
| **표면 스냅샷** | `node dist/capabilities/surface-snapshot.test.js` | 파일을 옮기고 가르는 사이 MCP/REST op 이 조용히 빠지거나 스키마·경로·순서가 바뀌는 것. 리팩토링 커밋에서 이게 빨개지면 **그 자체가 회귀 신호** — `UPDATE_SURFACE_SNAPSHOT=1` 은 의도적 표면 변경일 때만 |
| **경계** | `node scripts/check-imports.mjs` | 새 순환 import(알려진 잔존은 소관 항목과 함께 등재) · 계층 위반 엣지(스토어→표면, 스토어→express, 범용 db→온톨로지, `web/lib`→페이지) · 500줄 초과 신규 대형 파일(경고) |
| **번들** | `npm run build`(`scripts/build-node-agent.mjs` 내장) | 워커 노드 에이전트 번들에 DB 계열 모듈이 새로 실리는 것 — '**노드에 DB 없음**' 계약. 목록이 둘이다(#2165): 승인 `scripts/node-agent-allowed-modules.json`(노드가 실제로 쓰는 것 — 사람이 판단해 손으로 옮긴다) · 부채 `scripts/node-agent-known-debt.json`(빠져야 하는 것 — 줄어들기만 하고 `UPDATE_NODE_AGENT_ALLOWLIST=1` 로만 재동결). 어느 쪽에도 없는 모듈이 실리면 빌드 실패. 끊을 간선은 `node scripts/node-agent-bundle-map.mjs` 가 보여 준다 |

**파일 첫 줄(헤더)은 계약이다.** AI 가 가장 먼저 읽는 자리라, 틀리면 grep 기반 탐색이 통째로 어긋난다.
역할 한 줄 + 소비자 + import 방향 규칙을 적고, **파일을 옮기거나 가르면 헤더도 같이 고쳐라**
(잘 정리된 예: `web/wiki-*.ts` 계열). 이름이 역할과 어긋나면 파일명을 바꾼다.

## 조직 지식의 진실원천(SoT) = 단일 `knowledge` 테이블

**우리 지식**(결정·설계·런북·정리된 노트)의 **유일한 집은 v6 `knowledge` DB 테이블** 이다. `knowledge_save` 로 그 자리에서(in-flow) **전문**을 직접 기록한다 — 레포에 `.md` 를 새로 만들거나 파일 포인터를 쓰지 않는다. 주입·검색·발행·정적 폴백 모두 **DB `knowledge` 단일 소스**에서 나오며, 파일 트리를 캐노니컬로 읽는 런타임/부팅 경로는 없다. (배경·설계는 위키 참조: `knowledge_grep "context-os"` / `knowledge_grep "design-doc"`.)

- **레포의 `.md`(루트 설계문서·과거 `research/*.md`) = 지식 SoT 에서 은퇴** — 백업/생성물로 강등됐고, 새 조직 지식은 레포가 아니라 `knowledge` 로 들어간다.
- **외부 원본**(클릭업·노션·코드)은 외부 소유 → 게이트웨이는 **미러(provenance=observed)** 로만 둔다. 복제하지 말고, 파생 인사이트만 별도 저작.
- 분류축은 `category`(사업·제품·시스템) — **제품 카테고리=도메인**(탈-repo). `knowledge_link_category` 로 지식↔분류를 잇는다.

## 권한 스코프 (scope)

허용 scope 단일 진실원천: **`src/auth/scopes.ts`** (여기서 types union·웹 `mw()`·토큰 검증을 전부 파생. `src/capabilities/scopes.ts` 는 재수출 shim). 토큰/구성원에 부여하고 capability·MCP 툴이 요구한다.

| scope | 의미 |
|---|---|
| `items` · `context` | 아이템 조회(레거시 — 지금은 GitHub 연결 등 일부만) · 컨텍스트(도메인맵·레포·분류축·팀) |
| `memory` | 조직 콘텐츠 — 지식·프로젝트/과업·자료 등 대부분의 표면. 구성원 기본 scope 는 `items`·`context`·`memory` |
| `db` (`db:<source>`) | `db_query`/`db_schema`(전 소스 또는 특정 소스) |
| `admin` | 데이터/정책 관리(섹션·구성원·WIKI 인덱스·토큰·발행) |
| `runtime` | **멤버 머신에서 실행되는 것 정의** — 커스텀 훅·AI 도구. admin 과 분리(admin ⊉ runtime) |
| `code` | 코드 작업 부속 — 프리뷰 환경·레포 브랜치·스택 프로필·broker 실행 |

- **정적 토큰(`AUTH_TOKENS_JSON`)은 admin/runtime 행위 거부**(`DANGEROUS_SCOPES`) — 회수 불가 토큰으로 fleet 코드/정책 변경 금지(kill-switch). DB 토큰(`auth_token`, revoke 즉시)만 관리 권한 행사.
- 웹 `mw()`는 미지 scope 를 **fail-closed(403)** — 분기 누락으로 "인증만으로 통과"하는 권한 구멍 차단.

## 실행

```bash
cp .env.example .env      # 토큰/DB 채우기
npm install
npm run build             # 또는: npm run dev
npm start
curl localhost:8080/healthz
```

장기 실행(백그라운드) 시 **로그는 `logs/gateway.log`(리포 내, 내구 위치)로** 리다이렉트:

```bash
nohup node --env-file-if-exists=.env dist/index.js >> logs/gateway.log 2>&1 &
```

`/tmp` 리다이렉트 금지 — 쓰기 감사 등 운영 로그가 재부팅에 증발한다(op 단위 내구 감사는
items DB 감사 테이블이 별도로 보존하지만, 로그도 내구 위치가 기본).

Docker: `docker compose up -d` 는 스토어(items-db, pgvector)만 띄운다 — 게이트웨이는 호스트 네이티브가 기본이다(`deploy/`).
게이트웨이까지 컨테이너로: `docker compose --profile gateway up -d --build`

## 벡터/하이브리드 검색 (선택 — #172)

지식 검색은 두 도구다: **`knowledge_grep`**(정확 텍스트·정규식 매칭, ripgrep 식 — 항상 동작) + **`knowledge_search`**(의미·자연어 **하이브리드** — 벡터 임베딩 ∪ 렉시컬 grep 을 **RRF**(`Σ 1/(rank+60)`)로 융합). 단어가 본문에 그대로 없어도 의미로 회수한다.

**기본 off** — 임베딩을 켜기 전엔 `knowledge_search` 도 grep 으로 자동 폴백한다(무중단·하위호환). 켜는 건 opt-in:

```bash
# 1) .env: EMBEDDINGS_PROVIDER=http  (기본 사이드카 = Ollama bge-m3, OpenAI-compatible /v1/embeddings)
# 2) 임베딩 사이드카 기동(+ 모델 자동 pull)
docker compose --profile embeddings up -d
# 3) 기존 지식 백필(이후 저장분은 쓰기 시 자동 임베딩)
npm run build && node --env-file-if-exists=.env scripts/backfill-embeddings.mjs
```

- **pgvector 필요** — items DB(`ITEMS_DATABASE_URL`)에 `vector` 확장. 부팅 시 `CREATE EXTENSION IF NOT EXISTS vector` + `knowledge.embedding_vector vector(N)` + HNSW(cosine) 인덱스를 멱등 생성한다(권한 없거나 확장 부재면 경고 후 **렉시컬 폴백** — 깨지지 않음).
- **추론 seam = config-over-code(모델 스왑 자유).** provider/base_url/model/dimensions/auth_env 는 `org_runtime_config.embedding_config`(웹·DB, 무재시작) 또는 `.env` `EMBEDDINGS_*`(부트스트랩 시드)로 정한다 — DB 우선. **계약은 OpenAI-compatible `/v1/embeddings`** 라 OpenAI·로컬 TEI/vLLM·고객 자체 엔드포인트로 base_url 만 바꿔 교체 가능. 시크릿은 `EMBEDDINGS_AUTH_ENV`=환경변수 **이름**만(값 미저장).
- **모델 교체:** `EMBEDDINGS_MODEL` 변경 → `docker compose exec embeddings ollama pull <model>` → 차원이 다르면 `EMBEDDINGS_DIMENSIONS` 도 바꾸고 `scripts/backfill-embeddings.mjs --all`. 기본 bge-m3(1024d, 다국어)는 한국어 강화 시 KURE-v1(동일 1024d → 재임베딩만)로 무손실 스왑.
- 끄기: `EMBEDDINGS_PROVIDER=off`(또는 org_runtime_config provider=off) → 즉시 grep 으로 복귀.
- 렉시컬 채널의 한국어 형태소 FTS(mecab-ko)·리랭커는 후속(현재 렉시컬은 ILIKE 토큰-AND·정규식, RRF 의 정확매칭 절반을 담당).

## "권한으로 조절"의 실제 구현 (자유 SQL 안전장치)

`db_query` 는 자유 SELECT 를 받되, 통제를 **DB 레이어**로 내려서 안전하게 만든다:

1. **읽기 전용 리플리카 + 읽기 전용 role** — DDL/DML 물리적 차단 (등록한 소스의 접속 URL)
2. **퍼유저 RLS** — 요청마다 소스의 `rls` 세션변수(예: `app.current_user`)에 사용자 주입 → DB의 RLS 정책이 row 필터 (`sql/rls-example.sql`)
3. **쿼리 방화벽** — 단일 SELECT 만, 위험 함수 차단 (`src/db/firewall.ts`)
4. **`statement_timeout` + 행수 제한** — 리소스 고갈 방어 (`.env`)
5. **전수 감사로그** (`src/db/audit.ts` — 운영 로그라인. 영속 접근감사 `db_access_log` 는 `src/db/access-log.ts` 계약 + Enterprise 구현)

> RLS = 행 필터, 게이트웨이 = 컬럼 마스킹(PII — Enterprise, `src/ee/db/mask.ts`). 방화벽은 보조 방어선이고,
> **진짜 권한 경계는 읽기전용 role + RLS** 다.

> **멀티 데이터소스:** 여러 운영 DB 를 `org_db_source`(웹 관리탭 또는 `org_db_source_upsert`)에 명명 등록하고 `db_query`/`db_schema` 의
> `source` 인자로 고른다(`DATABASE_URL`/`DB_SOURCES_JSON` env 자동등록은 2026-06-23 폐기). 미지정 시 `default` 이름 소스 → 등록 소스가 하나면 그것 →
> 등록 소스가 없으면 내장 `self`(admin 전용, 게이트웨이 자기 items DB); 그 외엔 명시 필수(`db_sources` 로 목록 확인).
> 소스별 `rls` GUC·`maxRows`·`timeoutMs` 오버라이드 — **`rls` 미지정 소스는 행수준 격리 없음**(테이블수준은 읽기전용 role 책임).
> 권한은 스코프 `db`(전 소스) 또는 `db:<source>`(특정). 드라이버는 postgres·mysql(#715 — mysql 은 RLS 등가 없음). (설계는 위키 참조: `knowledge_grep "멀티db 읽기"`)

## 클라이언트 등록

```bash
STORE_URL=http://localhost:8080/mcp LIVELY_TOKEN=<본인토큰> ./scripts/register-clients.sh
```

## 버전 주의

`@modelcontextprotocol/sdk` 의 API(`registerTool`, `StreamableHTTPServerTransport`,
`requireBearerAuth` import 경로)는 마이너 버전마다 바뀔 수 있다. `npm i @modelcontextprotocol/sdk@latest`
후 타입에러가 나면 해당 시그니처를 설치된 버전 기준으로 맞출 것.
