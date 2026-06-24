# context-ontology

라이블리 **통합 컨텍스트 스토어** — 모든 로컬 CLI(클로드코드 · Codex · openclaw · pi)가 붙는
사내 **MCP 게이트웨이** 한 대. 조직 지식(WIKI) · 분류축(category) · 프로젝트/과업 · 도메인 맥락 · DB(읽기전용) 를
한 곳에서 노출하고, **퍼유저 인증 + 스코프**로 통제한다.

```
로컬 CLI들 ──(Streamable HTTP /mcp, Bearer)──▶ 이 게이트웨이 ──▶ 지식(WIKI) · 분류/프로젝트/과업 · 맥락 · DB(읽기전용)
                                                   └ 인증·스코프·감사의 단일 경계
```

> 모든 클라이언트가 로컬/사내라 **퍼블릭 노출이 필요 없다.** 사내망 URL이면 충분.
> 단, 모델 추론은 LLM 클라우드로 가므로 **툴 결과(코드·DB 데이터)는 컨텍스트로 외부 전송**된다 —
> 컴플라이언스가 걸리면 PII 마스킹/셀프호스팅 모델을 검토할 것.

## 구조

| 영역 | 파일 | 비고 |
|---|---|---|
| 엔트리포인트 | `src/index.ts` | Express + Streamable HTTP + bearer 인증 |
| 서버 조립 | `src/server.ts` · `src/capabilities/dynamic-tools.ts` | 능력 계층 등록 — MCP 표면은 `expose.mcp:true` capability 자동등록(단일 SoT, 현행 카운트는 `src/capabilities/index.ts` 주석·`scripts/parity-check.mjs` 참조) + 웹 정의 `org_tool`(http_proxy) `/mcp` **동적 등록**(SSRF 가드)·빌트인 on/off 게이팅 |
| **보안 경계** | `src/context.ts` | `resolveUser → requireScope` — 모든 툴 첫 줄 |
| 인증 | `src/auth/bearer.ts` | 정적 토큰(`AUTH_TOKENS_JSON`) + **DB 토큰**(`auth_token`, sha256·revoke 즉시·재시작 불요). 다음 단계 OAuth 로 이 파일만 교체 |
| **능력 계층** | `src/capabilities/*` | op = 스키마·스코프·핸들러 단일 정의 + `expose{mcp,rest}` 선별 노출 — knowledge·categories·projects-v6·task-v6·activity·context·domainmap-curation·**delivery(웹 관리/전달)** |
| **전달/관리** | `src/capabilities/delivery.ts` | 웹 `/ui` '관리' 탭 — org-content(강제규칙·맥락·WIKI 인덱스·구성원)·토큰·**커스텀 훅(`org_hook`)·AI 도구(`org_tool`)·MCP 서버·런타임 설정**. admin/runtime scope·REST 전용(에이전트 비노출). 항목별 '구성원에게 미치는 효과' 의미 패널 + auto-approve |
| **조직 지식(WIKI)** | `src/capabilities/knowledge.ts` | `knowledge_save`/`knowledge_search`/`knowledge_get`/`knowledge_list`/`knowledge_set_lifecycle`/`knowledge_set_wiki`/`knowledge_link_category`/`knowledge_delete`(휴지통·사람전용) — 단일 `knowledge` 테이블이 진실원천(SoT). 신규 저장은 category 1개 이상 필수. 아래 §SoT 참조 |
| **분류축(category)** | `src/capabilities/categories.ts` | `category_*`(create/update/get/list/delete·edge_*) — 사업·제품·시스템 분류축. **제품 카테고리=도메인**(탈-repo, 단일 `category` 테이블) |
| 프로젝트/과업 | `src/capabilities/projects-v6.ts` · `src/capabilities/task-*.ts` · `src/capabilities/activity.ts` | `project_*_v6`/`task_*_v6`/`activity_*` |
| 도메인 맥락 | `src/capabilities/context.ts` | `context_overview`/`debt_list`/`repo_list`/`all_domains` — domainmap 읽기 프록시. (`domain_list`/`domain_get` 은 **레거시** — v6 `category_*` 가 대체, REST 잔존) |
| domainmap 엔진 | `src/domainmap/` | 흡수된 엔진 모듈 — `db.ts`(전용 pg Pool) · `core/`(reconcile·changelog·domains·mappings·debts·projects·refresh·queries) · `cli.ts`(호스트 CLI) · `webhook.ts`(HMAC push-refresh) (`DOMAINMAP_DATABASE_URL`) |
| DB | `src/tools/db.ts` | `db_sources` / `db_schema` / `db_query` — 멀티 데이터소스(`source` 인자·`DB_SOURCES_JSON`), 방화벽·RLS·timeout·감사 |
| DB 안전장치 | `src/db/firewall.ts` · `src/db/sources.ts` | 단일 SELECT + 위험함수(`set_config`/`current_setting` 등) 차단 + 민감 테이블(`auth_token`·`org_*`) deny · 소스 레지스트리 |
| RLS 예시 | `sql/rls-example.sql` | 읽기전용 role + 행 정책 |
| 클라 등록 | `scripts/register-clients.sh` | 4종 등록 |

> 구 `memory_*`(2026-06-24 폐기)·`ctx_*`(흡수)·`search_items`/`get_item`·`propose_domain`/`domain_set_should`·구 `pm_task_*` 는 전부 위 `knowledge_*`/`category_*`/`task_*_v6` 표면으로 통합됐다. `code_*` 툴은 컷.

## 조직 지식의 진실원천(SoT) = 단일 `knowledge` 테이블

**우리 지식**(결정·설계·런북·정리된 노트)의 **유일한 집은 v6 `knowledge` DB 테이블** 이다. `knowledge_save` 로 그 자리에서(in-flow) **전문**을 직접 기록한다 — 레포에 `.md` 를 새로 만들거나 파일 포인터를 쓰지 않는다. 주입·검색·발행·정적 폴백 모두 **DB `knowledge` 단일 소스**에서 나오며, 파일 트리를 캐노니컬로 읽는 런타임/부팅 경로는 없다. (배경·설계는 위키 참조: `knowledge_search "context-os"` / `knowledge_search "design-doc"`.)

- **레포의 `.md`(루트 설계문서·과거 `research/*.md`) = 지식 SoT 에서 은퇴** — 백업/생성물로 강등됐고, 새 조직 지식은 레포가 아니라 `knowledge` 로 들어간다.
- **외부 원본**(클릭업·노션·코드)은 외부 소유 → 게이트웨이는 **미러(provenance=observed)** 로만 둔다. 복제하지 말고, 파생 인사이트만 별도 저작.
- 분류축은 `category`(사업·제품·시스템) — **제품 카테고리=도메인**(탈-repo). `knowledge_link_category` 로 지식↔분류를 잇는다.

## 권한 스코프 (scope)

허용 scope 단일 진실원천: **`src/capabilities/scopes.ts`** (여기서 types union·웹 `mw()`·토큰 검증을 전부 파생). 토큰/구성원에 부여하고 capability·MCP 툴이 요구한다.

| scope | 의미 |
|---|---|
| `items` · `context` | 아이템 조회 · 컨텍스트(도메인맵 등) |
| `db` (`db:<source>`) | `db_query`/`db_schema`(전 소스 또는 특정 소스) |
| `admin` | 데이터/정책 관리(섹션·구성원·WIKI 인덱스·토큰·발행) |
| `runtime` | **멤버 머신에서 실행되는 것 정의** — 커스텀 훅·AI 도구. admin 과 분리(admin ⊉ runtime) |
| `memory` · `code` | 예약 |

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

Docker: `docker compose up --build`

## "권한으로 조절"의 실제 구현 (자유 SQL 안전장치)

`db_query` 는 자유 SELECT 를 받되, 통제를 **DB 레이어**로 내려서 안전하게 만든다:

1. **읽기 전용 리플리카 + 읽기 전용 role** — DDL/DML 물리적 차단 (`DATABASE_URL`)
2. **퍼유저 RLS** — 요청마다 `app.current_user` 세션변수 주입 → DB의 RLS 정책이 row 필터 (`sql/rls-example.sql`)
3. **쿼리 방화벽** — 단일 SELECT 만, 위험 함수 차단 (`src/db/firewall.ts`)
4. **`statement_timeout` + 행수 제한** — 리소스 고갈 방어 (`.env`)
5. **전수 감사로그** (`src/db/audit.ts`)

> RLS = 행 필터, 게이트웨이 = 컬럼 마스킹(PII). 방화벽은 보조 방어선이고,
> **진짜 권한 경계는 읽기전용 role + RLS** 다.

> **멀티 데이터소스:** `DB_SOURCES_JSON` 으로 여러 운영 DB 를 명명 등록하고 `db_query`/`db_schema` 의
> `source` 인자로 고른다(미지정 시 `default`=`DATABASE_URL`; 다중+default없음이면 명시 필수, `db_sources` 로 목록 확인).
> 소스별 `rls` GUC·`maxRows`·`timeoutMs` 오버라이드 — **`rls` 미지정 소스는 행수준 격리 없음**(테이블수준은 읽기전용 role 책임;
> `default` 만 후방호환으로 `app.current_user`). 권한은 스코프 `db`(전 소스) 또는 `db:<source>`(특정). 1차 pg-only. (설계는 위키 참조: `knowledge_search "멀티db 읽기"`)

## 클라이언트 등록

```bash
STORE_URL=http://dev.lvly.io:8080/mcp LIVELY_TOKEN=<본인토큰> ./scripts/register-clients.sh
```

## 버전 주의

`@modelcontextprotocol/sdk` 의 API(`registerTool`, `StreamableHTTPServerTransport`,
`requireBearerAuth` import 경로)는 마이너 버전마다 바뀔 수 있다. `npm i @modelcontextprotocol/sdk@latest`
후 타입에러가 나면 해당 시그니처를 설치된 버전 기준으로 맞출 것.
