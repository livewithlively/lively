# context-ontology

라이블리 **통합 컨텍스트 스토어** — 모든 로컬 CLI(클로드코드 · Codex · openclaw · pi)가 붙는
사내 **MCP 게이트웨이** 한 대. 아이템/매핑 · 도메인/프로젝트 맥락 · PM(ClickUp) · DB(읽기전용) 를
한 곳에서 노출하고, **퍼유저 인증 + 스코프**로 통제한다. (메모리·코드 툴은 컷 — 아래 주 참조.)

```
로컬 CLI들 ──(Streamable HTTP /mcp, Bearer)──▶ 이 게이트웨이 ──▶ 아이템/매핑 · 맥락 · PM · DB(읽기전용)
                                                   └ 인증·스코프·감사의 단일 경계
```

> 모든 클라이언트가 로컬/사내라 **퍼블릭 노출이 필요 없다.** 사내망 URL이면 충분.
> 단, 모델 추론은 LLM 클라우드로 가므로 **툴 결과(코드·DB 데이터)는 컨텍스트로 외부 전송**된다 —
> 컴플라이언스가 걸리면 PII 마스킹/셀프호스팅 모델을 검토할 것.

## 구조

| 영역 | 파일 | 비고 |
|---|---|---|
| 엔트리포인트 | `src/index.ts` | Express + Streamable HTTP + bearer 인증 |
| 서버 조립 | `src/server.ts` · `src/capabilities/dynamic-tools.ts` | 능력 계층 등록 — **MCP 표면 24툴**(`scripts/parity-check.mjs`의 EXPECTED_MCP_SURFACE 로 동결) + 웹 정의 `org_tool`(http_proxy) `/mcp` **동적 등록**(SSRF 가드)·빌트인 on/off 게이팅 |
| **보안 경계** | `src/context.ts` | `resolveUser → requireScope` — 모든 툴 첫 줄 |
| 인증 | `src/auth/bearer.ts` | 1단계 정적 토큰. 2단계 OAuth로 이 파일만 교체 |
| **능력 계층** | `src/capabilities/*` | op = 스키마·스코프·핸들러 단일 정의 + `expose{mcp,rest}` 선별 노출 — items·mapping·context·pm·domainmap-curation·**delivery(웹 관리/전달)** |
| **전달/관리** | `src/capabilities/delivery.ts` | 웹 `/ui` '관리' 탭 — org-content(강제규칙·맥락·메모리·구성원)·토큰·**커스텀 훅(`org_hook`)·AI 도구(`org_tool`)·MCP 서버·런타임 설정**. admin/runtime scope·REST 전용(에이전트 비노출). 항목별 '구성원에게 미치는 효과' 의미 패널 + auto-approve |
| 도메인/프로젝트 | `src/capabilities/context.ts` | `context_overview`/`domain_list`/`domain_get`/`project_list`/`debt_list`/`repo_list` + **authoring 쓰기 `propose_domain`/`domain_deprecate`** — domainmap 프록시 |
| domainmap 엔진 | `src/domainmap/` | 흡수된 엔진 모듈 — `db.ts`(전용 pg Pool) · `core/`(reconcile·changelog·domains·mappings·debts·projects·refresh·queries) · `cli.ts`(호스트 CLI) · `webhook.ts`(HMAC push-refresh) (`DOMAINMAP_DATABASE_URL`) |
| PM (ClickUp) | `src/capabilities/pm.ts` · `src/connectors/clickup.ts` | `pm_task_*` 6툴 write-through(+`pm_write_audit`) + 폴링 증분 싱크(`run-sync`) — `runbooks/clickup-sync.md` |
| 팀 메모리 | `src/tools/memory.ts` · `src/org/store.ts` | `memory_save`/`memory_search`(`memory` scope) — `org_memory` **단일 공유 풀**(에이전트 생산·소비). 인덱스(제목·요약)는 발행 시 주입, 본문은 memory_search pull. domain 자동분류 |
| DB | `src/tools/db.ts` | `db_sources` / `db_schema` / `db_query` — 멀티 데이터소스(`source` 인자·`DB_SOURCES_JSON`), 방화벽·RLS·timeout·감사 |
| DB 안전장치 | `src/db/firewall.ts` · `src/db/sources.ts` | 단일 SELECT + 위험함수(`set_config`/`current_setting` 등) 차단 + 민감 테이블(`auth_token`·`org_*`) deny · 소스 레지스트리 |
| RLS 예시 | `sql/rls-example.sql` | 읽기전용 role + 행 정책 |
| 클라 등록 | `scripts/register-clients.sh` | 4종 등록 |

> `memory_save`/`memory_search` 는 **라이브**(06-16 — `org_memory` 팀 공유 메모리, `memory` scope). `code_*` 툴은 **컷**(DESIGN §10.6); `src/tools/code.ts` 는 미등록 보존 파일.

## 조직 지식의 진실원천(SoT) = ku 단일홈 (research·lively-org 동결)

> 설계 캐노니컬: `research/2026-06-18-context-os-v4-plan.md` §I. (참조용 포인터 — 이 문서 자체가 SoT 가 아니라 아래 정의가 SoT.)

**우리 지식**(research·결정·설계·런북·정리된 K)의 **유일한 집은 `knowledge_unit`(ku) DB** 다. `ctx_save` 로 그 자리에서(in-flow) **전문**을 ku 에 직접 기록한다 — 레포에 `.md` 를 새로 만들거나 ku→파일 포인터를 쓰지 않는다. 주입·검색·발행·정적 폴백 모두 **DB `knowledge_unit` 단일 소스**(`buildKnowledgeIndex`)에서 나오며, 파일 트리를 캐노니컬로 읽는 런타임/부팅 경로는 없다.

- **`research/*.md` 와 `lively-org` 레포 = 지식 SoT 에서 은퇴(동결)** — 백업/생성물로 강등. 새 조직 지식은 레포가 아니라 ku 로 들어간다.
  - `research/*.md` → 설계 이력 포인터(예: 본 README 의 `research/...` 링크) + 1회 시드 소스(`scripts/migrate-content.mjs`, **READ-ONLY**·CLI 전용, 부팅 미배선).
  - `lively-org` → 발행/배포 아티팩트의 출판 홈(예: 훅 생성물 `session-preload.mjs` 재발행) + 신원 바인딩 원본(`members/*.md`, 지식이 아니라 person/identity 계약 — `src/items/load-bindings.ts`, CLI 마이그 전용) + 1회 org-content 마이그(`src/org/migrate.ts`, CLI 전용·부팅 미배선).
- **외부 원본**(클릭업·노션·코드)은 외부 소유 → 게이트웨이는 **미러(provenance=observed)** 로만 둔다. 복제하지 말고, 파생 인사이트만 `K` 로 별도 저작.
- 주입문/쓰기가이드(`org-defaults` 본문·`ctx_save` desc·`session-preload` 훅)는 "캐노니컬은 ku / `lively-org`=동결"로 일관 — `src/org/publish.ts:22-23` 와 `src/org/static-context.test.ts` 가 "stale 파일기반 Canonical 아님(=DB 인덱스)" 을 회귀로 못박는다.

## 권한 스코프 (scope)

허용 scope 단일 진실원천: **`src/capabilities/scopes.ts`** (여기서 types union·웹 `mw()`·토큰 검증을 전부 파생). 토큰/구성원에 부여하고 capability·MCP 툴이 요구한다.

| scope | 의미 |
|---|---|
| `items` · `context` | 아이템 조회 · 컨텍스트(도메인맵 등) |
| `db` (`db:<source>`) | `db_query`/`db_schema`(전 소스 또는 특정 소스) |
| `admin` | 데이터/정책 관리(섹션·구성원·메모리·토큰·발행) |
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

`/tmp` 리다이렉트 금지 — pm_* 쓰기 감사 등 운영 로그가 재부팅에 증발한다(op 단위 내구 감사는
items DB `pm_write_audit` 테이블이 별도로 보존하지만, 로그도 내구 위치가 기본).

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
> `default` 만 후방호환으로 `app.current_user`). 권한은 스코프 `db`(전 소스) 또는 `db:<source>`(특정). 1차 pg-only. (설계: `research/2026-06-16-멀티db읽기-설계.md`)

## domainmap 통합 (도메인/프로젝트 맥락)

도메인/프로젝트/부채는 **게이트웨이에 흡수된 domainmap 엔진(`src/domainmap/`, DB는 lc-items-db 인스턴스의 `domainmap` database)이 canonical 소스**다.
(2026-06-12 Stage⑥) 구 `domain-map` 서비스(:7700)의 store-core/서버/CLI 를 모듈로 흡수 — capability 가 코어를 직접 호출한다(**읽기 + 화이트리스트 쓰기**, HTTP 프록시 제거).

- 읽기 툴: `context_overview` · `domain_list` · `domain_get` · `project_list` · `debt_list` · `repo_list`
- **(2026-06-11) 도메인 authoring 쓰기:** `propose_domain`(evidence 필수→change_log, proposed 착지) · `domain_deprecate` — MCP/REST.
- **(2026-06-11) 큐레이션 UI 통합:** 게이트웨이 `/ui`가 domainmap 큐레이션(확인/수정/병합/매핑/부채/이력/되돌리기)을 흡수 — REST 전용 capability 12 op, 화이트리스트+감사. 구 `:7700` UI는 퇴역 배너.
- 설정: `DOMAINMAP_DATABASE_URL`, `DOMAINMAP_DEFAULT_REPO`, `WEBHOOK_SECRET`, `SYNC_BLOCKED_REPOS`, `DOMAINMAP_REPOS_DIR` (`.env`)
- **보안:** 모든 읽기/쓰기는 게이트웨이 bearer 뒤(웹훅만 자체 HMAC fail-closed). 엔진 DB 는 게이트웨이 DATABASE_URL(읽기전용 리플리카)과 분리.
- **체인:** `domain_get → data_entity(예: Brand[prisma:database]) → db_query(그 테이블, 읽기전용 RLS)`.
  domainmap=맵, `db_query`=실데이터. 두 DB(맵 DB vs 제품 DB) 연결.

## 다음 작업

- [x] ~~`context_*`~~ → **domainmap 읽기 프록시로 구현·실데이터 e2e 검증**(repo=lively). 남은 것: confirmed/proposed 필터 옵션.
- [x] **(2026-06-11)** 도메인 authoring(`propose_domain`/`domain_deprecate`) + ClickUp 커넥터/`pm_*` + person 신원 2층 + 훅 패키지 연동 — 상세는 `runbooks/clickup-sync.md`·`runbooks/hooks.md`, DESIGN §12.
- [ ] `db_query` — **라이블리 실제 제품 DB(AWS RDS) 연결**(읽기전용 리플리카 + RLS). 정보: `lively/infra/terraform`. + 컬럼 마스킹.
- [x] **(2026-06-16→17)** `memory_save`/`memory_search` — `org_memory` **단일 공유 풀**(텍스트검색·domain 자동분류, `memory` scope). member/internal·visibility·in_index 분리는 06-17 폐기(과설계 — 에이전트 생산·소비 단일 풀). 재설계 `research/2026-06-17-shared-agent-memory-redesign.md`. pgvector 의미검색은 후속.
- [x] ~~`code_*` — ripgrep 미러 / Sourcegraph / 공식 GitHub MCP 합성~~ → **보류/컷**(개발자는 레포 내 네이티브 툴; 필요시 공식 GitHub MCP 래핑).
- [ ] 인증 2단계 — Google SSO 기반 OAuth 2.1 (`mcpAuthRouter` + jose), `bearer.ts` 교체

## 클라이언트 등록

```bash
STORE_URL=http://dev.lvly.io:8080/mcp LIVELY_TOKEN=<본인토큰> ./scripts/register-clients.sh
```

## 버전 주의

`@modelcontextprotocol/sdk` 의 API(`registerTool`, `StreamableHTTPServerTransport`,
`requireBearerAuth` import 경로)는 마이너 버전마다 바뀔 수 있다. `npm i @modelcontextprotocol/sdk@latest`
후 타입에러가 나면 해당 시그니처를 설치된 버전 기준으로 맞출 것.
