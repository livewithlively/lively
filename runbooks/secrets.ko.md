# 시크릿 매니저 런북 — 시크릿 경계의 형식 모델 (P8)
*[English](secrets.md)*

> **제품 원칙(단일 문장):** 시크릿은 *어떤 콘텐츠에도 안 들어간다*. 연결/provider 인증은
> **환경변수 이름 참조**(auth_env/auth_ref)로만 저장하고 값은 외부 시크릿 매니저(`.env`/1Password/
> Doppler/SOPS)에 둔다. 제품 데이터 접근은 **멤버별 DB role**(db_query RLS)로 분리한다.
> *확장(#541·#746):* 관리탭·자격 금고로 넣는 커넥터·구성원 자격은 **암호문으로만** DB 에 저장한다(평문 미저장 — (b) 자격 금고).

이 문서는 위 원칙을 강제하는 코드 choke-point, 안전한 시크릿 추가 절차, 유출 시 로테이션 절차를
형식화한다. 관련 인증평면: db-multi-source(`research/2026-06-16-멀티db읽기-설계.md` — 내부 설계 노트, 이 레포에 없음),
임베딩 provider auth(`src/v6/embedding-provider.ts`).

---

## (a) 시크릿 불입 원칙 + 강제 choke-point

콘텐츠(에이전트·사람이 쓰는 자유텍스트 본문)에는 평문 시크릿이 절대 들어가지 않는다. 강제는
**저장 경계에서 hard-block**(경고 아님) — `src/org/ingest/redact.ts` 의 두 함수가 단일 패턴 출처다.

| 함수 | 역할 | 동작 |
|---|---|---|
| `assertNoHardSecrets(text, field, hint?)` | 고위험 평문 시크릿 **저장 거부** | 패턴 매치 시 `HttpError(400)` throw — 저장 자체가 안 됨 |
| `redactDeep(v)` / `redactString` | 감사 로그·HTTP 응답 **마스킹** | 매치 문자열을 `[REDACTED]` 로 치환(저장은 허용하되 평문 사본 차단) |

`assertNoHardSecrets` 의 hard-block 패턴(2026-09-30 기준, #4501): Anthropic(`sk-ant-`), OpenAI(`sk-`·`sk-proj-`·`sk-svcacct-`·`sk-admin-` — 낱말 안에서
시작하면 제외, 마스킹과 같은 규칙), GitHub 토큰(`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`)·PAT(`github_pat_`), Slack(`xox[abprs]-`),
AWS(`AKIA…` — AWS 문서 예시 `…EXAMPLE` 제외), 라이블리 토큰(`lvk_`), 개인키(`BEGIN … PRIVATE KEY` 뒤에 키 본문이 이어질 때 — 사이의 줄바꿈·JSON 이스케이프 `\n`·암호화 PEM 머리·인용 `>` 는 건너뛴다.
머리줄만 적은 형식 설명은 제외). `redactDeep`/`redactString` 는 여기에
JWT·`Bearer <literal>` 까지 더 넓게 마스킹한다(`TOKEN_SHAPE_RES`·`PROSE_RISKY_RES`).

### choke-point 적용 현황 (콘텐츠 쓰기경로)

| 쓰기경로 | 입력 | assertNoHardSecrets | 위치 |
|---|---|---|---|
| ~~`ctx_save`~~ (폐기 — `knowledge_*` 로 흡수) | `note` | — | 구 `src/capabilities/ctx.ts`(삭제). 후속 `knowledge_save` 는 아래 v6 행 |
| `org_update_section` (MCP·REST) | `body_md` | ✓ (P8) | `src/capabilities/delivery/org-content.ts` |
| `org_member_upsert` (MCP·REST/admin) | `body_md`(개인레이어) | ✓ (P8) | `src/capabilities/delivery/members.ts` |
| 본인 쓰기(`me_profile_update`·`me_onboarding_set`·`me_liv_profile_set`·`me_welcome_*`) | 개인레이어 `body_md`·메모·프로필·온보딩 답 | ✓ | `src/capabilities/delivery/me-self.ts`·`liv.ts`·`welcome.ts` |
| ~~`propose_domain`·`dm_domain_edit`~~ (폐기 2026-06-24 — `category_*` 로 대체) | `description`·`evidence` | — | 후속 `category_*` 는 아래 v6 행 |
| v6 콘텐츠 쓰기 — `knowledge_save`·`knowledge_set_title`·`category_create`/`category_update`/`category_group_upsert`·`project_create_v6`/`project_update_v6`/`project_rename_v6`·`task_create_v6`/`task_update_v6`·`task_checklist_v6`·`task_comment_v6`·`project_list_create_v6`/`project_list_update_v6`·`task_field_value_set_v6`·`knowledge_comment_post`·`task_tags_v6`/`task_tag_update_v6`·`task_field_create_v6`/`task_field_update_v6`·`project_folder_create_v6`/`project_folder_update_v6` (MCP·REST) | 입력의 **모든 문자열**(중첩 포함). 옛 텍스트 칸(`edits[].old`·`description_base`)은 제외 — 시크릿을 지우는 편집을 막지 않게 | ✓ (#4501, 2026-09-30) | 각 핸들러 맨 앞에서 `src/capabilities/content-secrets.ts` `assertNoContentSecrets` |
| 첫 지시 → 초안 프로젝트 자동 생성 | 이름·본문 | 가림(`redactTokenShapes`) — 막으면 세션 작업면이 안 생긴다 | 서버 경로 `src/project/first-prompt-project.ts` · 외부 하네스 훅(`project-auto-bind` → `project_create_v6`)은 본문의 `AUTO_CREATED_MARK` 를 보고 `projects-v6.ts` 가 같은 가림 |
| `org_hook_upsert` (MCP·REST/runtime) | `source_code` | ✓ | `src/capabilities/delivery/hooks.ts` |
| `org_harness_asset_upsert`·`me_harness_asset_draft` | description·body·frontmatter | ✓ | `src/capabilities/delivery/harness-assets.ts`·`me-self.ts` |
| ~~`migrate-content.mjs`~~ (스크립트 — 현재 레포에서 제거) | `body_md` | ✓ (직접 호출) | 구 `scripts/migrate-content.mjs` |
| 감사(audit) before/after | org 관리 엔티티(`src/org/store/*`) | redactDeep | `src/org/store/audit.ts` — v6 knowledge/category/project 감사(`src/v6/content-audit.ts auditOrgContent`)는 마스킹하지 않음 |
| 커넥터 미러 적재 | title/body/fields/raw | redactString·redactDeep | `src/v6/mirror/*` |
| http_proxy 응답 본문 | dynamic-tools res.body | redactDeep | `src/mcp/dynamic-tools.ts` |

**설계 결정 — 가드는 capability(어댑터) 층에 둔다, 데이터 층(`upsertKnowledge`)이 아니다.** 데이터 층에
무차별 `assertNoHardSecrets` 를 박으면 시드/마이그레이션/정당 콘텐츠가 깨질 수 있고, 마이그(`source=
'migration'`)는 `upsertKnowledge` 를 직접 호출하므로 어댑터 가드를 우회한다 — 그래서 마이그는 자기
경로에서 명시적으로 assert 했다(같은 패턴, 같은 단일 출처 — 그 스크립트는 현재 제거됨). 거짓양성 위험이 낮은(토큰 형식을 정당
콘텐츠가 담을 일이 드문) 자유텍스트 경로에만 추가했다.

### 가드하지 않는(권고만) 경로

- **debt_finding.detail** — 사용자 쓰기 capability 가 없다. domainmap refresh/ingest 파이프라인
  (`reconcile.ts`→`upsertDebt`)이 코드 분석으로 채우는 기계 산출이며, `dm_debt_status` 는 상태만 바꾼다.
  코드 분석이 레포의 토큰 형태 문자열을 인용할 수 있어(거짓양성) 파이프라인 무차별 차단은 하지 않는다.
  → 권고: refresh 입력(분석 대상 레포)에 평문 시크릿을 두지 말 것(소스 시크릿 위생은 별 책임).
- **데이터 층 `upsertKnowledge`/`upsertMember` 직접 호출** — 시드/마이그/테스트 경로. 어댑터 가드로
  충분하며, 직접 호출자는 자기 경로에서 assert 할 책임(마이그가 선례).
- **v6 감사 기록(`org_content_audit` 의 v6 before/after)** — 마스킹하지 않는다. 입구 차단(#4501) 뒤의 새 쓰기에는
  하드 시크릿이 들어오지 않지만, 그 전에 저장된 본문과 가림 대상(JWT·Bearer 등 hard-block 밖 패턴)은 감사 사본에 남을 수 있다.
  검출은 (f) 스캔, 제거는 (e) 로테이션 3단계.

---

## (b) 연결/provider 시크릿 = env 이름 참조 (값 DB 미저장)

외부 시스템 인증은 **시크릿 값이 아니라 환경변수 '이름'** 을 저장하고 런타임에 `process.env` 에서
해소한다. 이 경로에서 값은 DB·코드·콘텐츠 어디에도 굳지 않는다(암호문 저장 경로는 아래 자격 금고).

| 대상 | 저장 필드 | 저장 내용 | 런타임 해소 | 화이트리스트 |
|---|---|---|---|---|
| DB 소스(`org_db_source`) | `auth_ref` | env **이름**(예 `PROD_DB_PW`) | `resolveConnectionString` → `process.env[auth_ref]` | `allowed_db_secret_refs`(deny-all 기본) |
| MCP 서버(`org_mcp_server`, client 모드) | `auth_env` | env **이름** | register-clients/세션훅이 멤버 머신 env 에서 | 이름 형식 검증(`^[A-Za-z_][A-Za-z0-9_]*$`) |
| http_proxy 툴(`org_tool`) | `auth_env` | env **이름** | dynamic-tools 가 호출 시 `process.env[auth_env]` → Bearer | `allowed_auth_envs`(deny-all 기본) |
| 임베딩 provider | `embedding_config.auth_env_ref`(런타임 설정 — 시드 env `EMBEDDINGS_AUTH_ENV`) | env **이름** | `src/v6/embedding-provider.ts` 가 그 env 값을 Bearer 로 | 이름 형식 검증 |

강제 가드(전부 위 표의 코드 위치에 존재):
- **이름 형식 검증** — `^[A-Za-z_][A-Za-z0-9_]*$` 만 통과(시크릿 값을 이름 칸에 넣는 것을 형식으로 차단).
- **화이트리스트** — `auth_ref`/`auth_env` 는 런타임 설정의 허용목록에 먼저 등록돼야 참조 가능
  (`isSecretRefAllowed`, `allowed_auth_envs`). 인프라 시크릿(`ITEMS_DATABASE_URL` 등) 임의 참조 차단.
- **url 비번 인라인 차단** — `org_db_source.url` 은 비번 없는 접속문자열만. `assertNoHardSecrets(url)` +
  pg 파서 검사(`inspectConnString`: `?password=`/`?hostaddr=` 쿼리파라미터 우회까지) — `src/db/source-guard.ts`.
- **응답 마스킹** — DB 소스 목록 응답은 url 원문 대신 host 만 노출(`maskDbSource`), auth_ref 는 이름만.

값의 실제 보관 위치: 게이트웨이 `.env`(gitignore 됨) 또는 외부 매니저(1Password/Doppler/SOPS)에서
`.env`/프로세스 env 로 주입. **`.env` 는 절대 커밋·출력하지 않는다**(gitignore + `*.sw?`/`*~` 무시).

### 자격 금고 — 암호문 저장 경로(#541·#746)

`.env` 편집이 어려운 배포(SSM 전용 박스 등)를 위해, 관리탭·MCP 로 넣는 자격은 **암호문으로만** DB 에 저장한다:
커넥터 토큰(`org_connector`), 게이트웨이 통합·구성원 자격(`org_credential_set`·`me_credential_set` → `member_secret`),
git 자격. 암호화는 `src/org/credentials/secret-box.ts`(AES-256-GCM, 마스터키 env `CONNECTOR_SECRET_KEY` —
미설정이면 금고 저장이 비활성이고 env 폴백만 된다).
- 값은 응답으로 절대 나가지 않는다(`has_secret` 플래그·meta 만). `member_secret`·`git_credential` 은 db_query 차단 테이블이다((c)).
- `org_tool`·`org_mcp_server` 는 `auth_env` 대신 `auth_kind`(금고 kind — 요청자 개인 자격 우선, 조건부로 통합 자격 폴백)로
  인증을 참조할 수 있다. 둘은 배타다(인증 출처 하나만).
- ⚠ 마스터키를 잃거나 바꾸면 기존 암호문은 복호화할 수 없다(재입력 필요) — 키를 `.env` 볼륨과 함께 보존한다.

---

## (c) 제품 DB 접근 = 멤버별 DB role (db_query RLS)

운영 DB 접근은 게이트웨이가 만능 계정으로 대리하지 않는다 — **멤버별 DB role** 로 분리하고 RLS 로
행을 제한한다.

- `db_query`/`db_schema` 는 등록된 소스로 게이트웨이가 직접 pg 연결(http_proxy 와 동일 outbound 표면).
- 인증은 `auth_mode`(1차 `password` 만; iam/mtls/vault 자리만) + `auth_ref`(env 이름) — 위 (b) 평면.
- **RLS GUC 주입** — 게이트웨이가 `app.current_user` 등 GUC 를 세션에 주입하고, 방화벽이 이를 덮어쓰는
  `set_config`/`current_setting` 호출을 SELECT 안에서 차단(정규식 + AST, CTE·서브쿼리까지) —
  `src/db/firewall.ts`. 멤버 토큰의 신원이 RLS 정책의 입력이 되어 멤버별 가시범위가 강제된다.
- **SSRF/리바인딩 차단** — host 는 공인 IP 로 pin(`pinHost`), 사설/메타데이터 대역 거부.
- **메타테이블 차단** — `DENIED_TABLES`(auth_token·org_content_audit·org_hook·org_tool·org_mcp_server·
  org_db_source·member_secret·git_credential 등) SELECT 차단 — 시크릿 참조·감사·인증 테이블을 db_query 로 못 읽게.

---

## (d) 새 연결/provider 시크릿 안전 추가 절차

값을 콘텐츠/DB/코드에 넣지 않고 추가하는 표준 순서:

1. **값을 외부에 둔다.** 게이트웨이 `.env`(또는 외부 매니저에서 주입)에 `MY_API_TOKEN=…` 추가.
   `.env` 는 gitignore — 커밋·로그·PR 어디에도 값을 남기지 않는다.
   (자격 금고를 쓰면: `org_credential_set`/`me_credential_set` 로 자격을 넣고 3단계에서 `auth_kind` 로 참조 — 2단계 불요.)
2. **이름을 화이트리스트에 등록한다.** 웹 런타임 설정(`org_runtime_update`)에서:
   - http_proxy/MCP 인증 → `allowed_auth_envs` 에 `MY_API_TOKEN` 추가.
   - DB 소스 비번 → `allowed_db_secret_refs` 에 추가.
   (등록 안 하면 다음 단계가 "허용목록에 없습니다" 400 으로 거부된다 — deny-all 기본.)
3. **연결을 이름으로 참조한다.** 해당 CRUD(`org_mcp_upsert`/`org_tool_upsert`/`org_db_source_upsert`)에서
   `auth_env`/`auth_ref` 칸에 **이름**(`MY_API_TOKEN`)을 넣는다. 값을 넣으면 형식 검증/`assertNoHardSecrets`
   가 막는다.
4. **검증.** `node --env-file=.env scripts/scan-content-secrets.mjs` — 콘텐츠 스토어 hit 0 확인(아래 (f)).
   값이 어딘가 콘텐츠로 샜으면 여기서 잡힌다.

멤버 머신에서 실행되는 것(client 모드 MCP 서버)은 그 env 가 **멤버 머신**에 존재해야 한다 — 설치 번들/
멤버 본인 `.env`. 게이트웨이는 이름만 배포한다. 게이트웨이에서 실행되는 것은 게이트웨이에서 해소한다 — http_proxy 툴은
게이트웨이 env(또는 금고 `auth_kind`), proxy 모드 MCP 서버는 금고(`auth_kind`)·OAuth·SigV4.

---

## (e) 유출 시 로테이션 절차

평문 시크릿이 콘텐츠/로그/저장소에 들어간 정황(또는 스캔 hit)이 있으면:

1. **즉시 무효화(rotate at source).** 발급처(OpenAI/GitHub/Slack/AWS/DB)에서 해당 키를 폐기·재발급.
   라이블리 토큰(`lvk_`)이면 `org_token_revoke` — 핸들은 `org_token_mint` 응답의 `tokenHash` 또는 `org_tokens` 의
   `token_hash` 를 그대로 넣는다(앞자리 12자 이상도 유일하면 통한다). 게이트웨이 재시작 불요.
   ⚠ **응답을 읽어라**(#2646): `revoked:true` 여야 이번 호출이 죽인 것이다. `revoked:false`(=이미 회수돼 있었음)나
   404(=그런 토큰 없음)는 **다른 토큰을 봐야 한다는 뜻**이다 — 종전엔 셋 다 `{ok:true}` 라, 회수했다고 믿고
   자리를 뜨면 살아 있는 토큰이 남았다(2026-09-04 실측). 유출 대응에서는 회수 뒤 그 평문 토큰으로 한 번
   찔러 **401 을 눈으로 확인**하는 것이 가장 확실하다.
2. **새 값을 외부에 주입.** (d)1 처럼 `.env`/매니저에 새 값. **이름은 그대로 둘 수 있다**(참조가 env 이름이라
   값만 바꾸면 런타임이 새 값을 해소 — DB 소스는 풀 회수로 무재시작 반영).
3. **콘텐츠/로그에서 제거.** 평문이 콘텐츠 본문에 들어갔다면: 해당 knowledge/section/member/category 를
   수정(section/member 는 `assertNoHardSecrets` 가 재저장을 막으므로 정제 후 저장). 감사 로그(`org_content_audit`)는
   append-only 다 — org 관리 엔티티 감사는 redactDeep 으로 이미 마스킹돼 있지만(마스킹 누락 패턴이면 redact.ts 패턴을
   보강), v6 knowledge/category/project 감사(`auditOrgContent`)는 마스킹하지 않으므로 평문 사본이 남았을 수 있다.
4. **스캔으로 확인.** `scripts/scan-content-secrets.mjs` 로 hit 0 재확인.
5. **재발 방지.** 어느 쓰기경로로 샜는지 추적(감사 actor/source) → 그 경로에 choke-point 누락이면 추가
   ((a) 표 갱신), 시크릿 패턴이 hard-block 목록에 없었으면 `HARD_LABELS`/`TOKEN_SHAPE_RES`·`PROSE_RISKY_RES` 보강.

---

## (f) 상시 검증 — 콘텐츠 스토어 시크릿 스캔

```
node --env-file=.env scripts/scan-content-secrets.mjs      # 게이트웨이 앱 디렉터리에서(dist 빌드 필요)
```

- 대상: items DB(단일 DB — 도메인맵 테이블도 여기 있다): `knowledge` name/title/body_md/summary,
  `category` name/description/should, `org_member` display_name/email/body_md/identities, `debt_finding` title/detail,
  `project`(프로젝트·태스크) name/description, `task_comment` body, `task_checklist_item` name, `knowledge_comment` body.
  목록은 스크립트의 `SCAN_TARGETS` 이고, `scripts/scan-content-secrets.test.mjs` 가 스키마 정의와 대조한다.
- `assertNoHardSecrets` + `redactDeep`(redact.ts 단일 출처)을 전수 적용. **값 비출력** — 위치(테이블/PK/
  컬럼)와 패턴 라벨(hard/masked)만 보고.
- hit ≥ 1 → `exit 1`(CI 후보). `ITEMS_DATABASE_URL` 이 없거나 대상 테이블이 없으면 그 부분은 skip(보고만, fail 아님).
- 런타임 무영향(standalone) — MCP 표면 불변.
