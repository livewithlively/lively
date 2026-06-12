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
| 서버 조립 | `src/server.ts` | 능력 계층 등록 — **MCP 표면 21툴**(`scripts/parity-check.mjs`의 EXPECTED_MCP_SURFACE 로 동결, REST/MCP 패리티 42) |
| **보안 경계** | `src/context.ts` | `resolveUser → requireScope` — 모든 툴 첫 줄 |
| 인증 | `src/auth/bearer.ts` | 1단계 정적 토큰. 2단계 OAuth로 이 파일만 교체 |
| **능력 계층** | `src/capabilities/*` | op = 스키마·스코프·핸들러 단일 정의 + `expose{mcp,rest}` 선별 노출 — items·mapping·context·pm·domainmap-curation |
| 도메인/프로젝트 | `src/capabilities/context.ts` | `context_overview`/`domain_list`/`domain_get`/`project_list`/`debt_list`/`repo_list` + **authoring 쓰기 `propose_domain`/`domain_deprecate`** — domainmap 프록시 |
| domainmap 엔진 | `src/domainmap/` | 흡수된 엔진 모듈 — `db.ts`(전용 pg Pool) · `core/`(reconcile·changelog·domains·mappings·debts·projects·refresh·queries) · `cli.ts`(호스트 CLI) · `webhook.ts`(HMAC push-refresh) (`DOMAINMAP_DATABASE_URL`) |
| PM (ClickUp) | `src/capabilities/pm.ts` · `src/connectors/clickup.ts` | `pm_task_*` 6툴 write-through(+`pm_write_audit`) + 폴링 증분 싱크(`run-sync`) — `runbooks/clickup-sync.md` |
| DB | `src/tools/db.ts` | `db_schema` / `db_query` (방화벽·RLS·timeout·감사 골격) |
| DB 안전장치 | `src/db/firewall.ts` | 단일 SELECT 만 허용 |
| RLS 예시 | `sql/rls-example.sql` | 읽기전용 role + 행 정책 |
| 클라 등록 | `scripts/register-clients.sh` | 4종 등록 |

> `memory_*`/`code_*` 툴은 **컷**(DESIGN §10.6 — canonical 메모리는 git 컨텍스트 레포). `src/tools/memory.ts`·`code.ts`는 미등록 보존 파일.

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
- [x] ~~`memory_*` — pgvector 검색/저장~~ → **컷**(DESIGN §10.6 — canonical 메모리는 git 컨텍스트 레포. 라이브 공유는 향후 memory-타입 Item으로).
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
