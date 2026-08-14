// org 스키마 조각 — mcp-tools: 하네스에 배포되는 조직 자산 레지스트리. org_mcp_server(MCP 서버)·
//  org_hook(커스텀 훅)·org_tool(조직 정의 툴 + 빌트인 시드)·org_harness_asset(스킬·서브에이전트·커맨드)·
//  org_asset_pref(멤버 오버라이드). 진입점 3개 — 원 파일에서 org_connector(connectors-ingest 조각)와
//  org_runtime_config ALTER 연발(runtime-config 조각)이 사이에 끼어 있었다(순서 보존).
// #1313 R19b: 구 단일 initOrgSchema(org/schema.ts, ~1,500줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 org/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck, redefineCheck } from "./ddl-util.js";

export async function initMcpServerRegistry(pool: Pool): Promise<void> {
  // ── org_mcp_server — 조직 MCP 서버 레지스트리. register-clients/어댑터가 멤버 하네스에 등록. ──
  // 시크릿 금지: 인증은 auth_env(환경변수 '이름'만, 값 아님). transport http(url) | stdio(command).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_mcp_server(
      name TEXT PRIMARY KEY,
      transport TEXT NOT NULL DEFAULT 'http',
      url TEXT,
      command TEXT,
      auth_env TEXT,
      note TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("org_mcp_server", { org_mcp_server_transport_chk: "transport IN ('http','stdio')" })}
    -- A-어댑터: 게이트웨이 MCP 프록시(#746 T1). mode='client'(기존 ③ — register-clients 가 멤버 클라에 직접 등록) |
    --  'proxy'(게이트웨이가 상류 MCP 클라이언트가 되어 tools 를 자기 /mcp 에 재노출·통제·포워딩). 기존 행은 client 유지(무회귀).
    --  tools_snapshot = 발행 시 캡처한 상류 tools/list(핀). scope/level/pii_scrub = 프록시 툴 통제. auth_kind/scope_key = per-member vault 인증(T2 OAuth 확장 전엔 정적토큰).
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'client';
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS tools_snapshot JSONB;
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS snapshot_at TIMESTAMPTZ;
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS scope TEXT;
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS level TEXT;
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS pii_scrub BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS auth_kind TEXT;
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS auth_scope_key TEXT;
    -- log_args(#1082): 이 서버 프록시 툴의 호출 '인자 값'을 감사로그(mcp_call_log)에 저장할지. 기본 false = 저장 안 함.
    --  프록시 인자에는 조직 밖으로 나가는 본문(슬랙 DM·메일 본문 등)이 실려 개인정보가 무기한 남았다 → 기본 미저장으로 뒤집는다.
    --  켤 만한 경우: 내부 전용 MCP 라 인자에 개인 통신이 없고 디버깅 가치가 큰 서버. 끈 상태에서도 호출 행(누가·언제·어떤 툴)은 남는다.
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS log_args BOOLEAN NOT NULL DEFAULT false;
    -- auth_mode(#746 T2): 'bearer'(정적토큰, 기본) | 'oauth'(per-member OAuth 브로커 — 토큰 생명주기·refresh 를 게이트웨이가 관리).
    ALTER TABLE org_mcp_server ADD COLUMN IF NOT EXISTS auth_mode TEXT;
    ${ensureCheck("org_mcp_server", {
      org_mcp_server_mode_chk: "mode IN ('client','proxy')",
      org_mcp_server_level_chk: "level IS NULL OR level IN ('L0','L1','L2')",
    })}
    -- auth_mode 허용값 확장(#746: +sigv4) — CHECK 은 IF NOT EXISTS 로 라이브 제약이 안 바뀌므로 DROP+ADD(멱등).
    ${redefineCheck("org_mcp_server", "org_mcp_server_auth_mode_chk", "auth_mode IS NULL OR auth_mode IN ('bearer','oauth','sigv4')")}
  `);
}

export async function initToolAndAssetRegistry(pool: Pool): Promise<void> {
  // ── org_hook — 커스텀 훅(관리자 정의, 구성원 머신에서 실행). 본문(source_code)은 멤버 디스크에 굳히지 ──
  // 않고 불변 런너가 매 세션 게이트웨이에서 fetch 해 실행한다(회수=다음 세션 무효, kill-switch). 내장 훅 3종은
  // org_runtime_config.hooks 토글로 별도 관리(여기는 커스텀 전용). content_hash=sha256(source_code)는 런너 무결성 게이트용.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_hook(
      id TEXT PRIMARY KEY,
      label TEXT,
      harness TEXT NOT NULL DEFAULT 'all',
      event TEXT NOT NULL,
      matcher TEXT,
      source_code TEXT NOT NULL DEFAULT '',
      timeout_sec INT NOT NULL DEFAULT 10,
      note TEXT,
      summary TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      content_hash TEXT,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    DO $$ BEGIN
      -- 하네스 집합 확장(#1519 opencode · #1689 antigravity). **DROP+ADD 로 갱신한다** — 종전 IF NOT EXISTS
      --  프로브형은 제약이 이미 있으면 그대로 둬서 라이브 DB 가 옛 목록에 머문다(그러면 API 는 통과시킨
      --  값을 DB 가 23514 로 거절한다). 아래 이벤트 제약이 같은 이유로 이미 이 패턴이다.
      --  ⚠ delivery/shared.ts HOOK_HARNESSES 와 일치 유지(둘이 갈리면 한쪽만 막는다).
      ALTER TABLE org_hook DROP CONSTRAINT IF EXISTS org_hook_harness_chk;
      ALTER TABLE org_hook ADD CONSTRAINT org_hook_harness_chk CHECK (harness IN ('claude','codex','openclaw','opencode','antigravity','grok','all'));
      -- 이벤트 집합 확장(2026-06-24): 기존 제약은 DROP+ADD 로 갱신한다(IF NOT EXISTS 만으론 라이브 제약이 안 바뀜).
      --  Claude 라이프사이클 이벤트 추가(SessionEnd·PreCompact·PostCompact). delivery.HOOK_EVENTS·runnerHooksBlock 와 일치 유지.
      ALTER TABLE org_hook DROP CONSTRAINT IF EXISTS org_hook_event_chk;
      ALTER TABLE org_hook ADD CONSTRAINT org_hook_event_chk CHECK (event IN
        ('SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SubagentStop','Notification','PreCompact','PostCompact'));
    END $$;
    -- per-member 타깃(#699): NULL/빈=전원, 배열=그 멤버만. org_harness_asset.target_members 와 대칭. 비파괴 ADD COLUMN.
    ALTER TABLE org_hook ADD COLUMN IF NOT EXISTS target_members JSONB;
  `);

  // ── org_tool — 조직 정의 MCP 툴. kind='http_proxy'(사내 API 래핑, 게이트웨이가 /mcp 에 동적 노출 → 재설치 ──
  // 불요) | 'builtin'(빌트인 툴 on/off·auto_approve 게이팅 행) | 'prompt'(예약·미구현). scope 는 http_proxy 호출
  // 권한(admin·NULL 금지, 앱 강제). auth_env=환경변수 '이름'만(시크릿 금지). auto_approve=설치 시 멤버 settings 의
  // 무확인 실행 허용목록에 넣을지(기본 false).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_tool(
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'http_proxy',
      enabled BOOLEAN NOT NULL DEFAULT true,
      title TEXT,
      description TEXT NOT NULL DEFAULT '',
      scope TEXT,
      input_schema JSONB NOT NULL DEFAULT '{"type":"object","properties":{},"additionalProperties":false}'::jsonb,
      method TEXT,
      url TEXT,
      auth_env TEXT,
      auto_approve BOOLEAN NOT NULL DEFAULT false,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("org_tool", {
      org_tool_kind_chk: "kind IN ('http_proxy','builtin','prompt')",
      org_tool_method_chk: "method IS NULL OR method IN ('GET','POST','PUT','PATCH','DELETE')",
    })}
    -- always_load(주입모드 override) — NULL=코드 기본값(cap.meta) 사용, true=항상 주입, false=deferred(검색 시 로드). #187.
    --  Claude Code 만 해석하는 _meta(anthropic/alwaysLoad)로 변환된다(Codex 는 서버측 deferral 미지원). 비파괴 ADD COLUMN.
    ALTER TABLE org_tool ADD COLUMN IF NOT EXISTS always_load BOOLEAN;
    -- level(권한 등급, P2 #746) — NULL=코드 기본값(L0). L0=조회 / L1=제안(MR·draft) / L2=집행(외부발신·상태변경).
    --  L2 툴은 auto_approve 목록에서 강제 제외(listAutoApproveTools) → 하네스 인터랙티브 컨펌으로만 집행. prod apply·배포·sync 는 미노출(관리자 전담).
    ALTER TABLE org_tool ADD COLUMN IF NOT EXISTS level TEXT;
    ${ensureCheck("org_tool", { org_tool_level_chk: "level IS NULL OR level IN ('L0','L1','L2')" })}
    -- 커넥터 자격/마스킹 결선(P1·P3 #746) — http_proxy 툴이 per-user vault 자격으로 인증하고 응답 PII 를 마스킹.
    --  auth_kind: 설정 시 auth_env(조직 공용 env) 대신 member_secret(호출자 개인 자격 우선)로 Authorization 해소.
    --   해소 폴백 정책은 level 이 정한다: L2(집행/외부발신)=per-user 필수(통합 폴백 금지) / 그 외=통합 폴백 허용(비-PII read).
    --  auth_scope_key: vault 조회 scope_key(예 gitlab host). pii_scrub: true 면 응답 본문(문자열)에 scrubPii 적용(비정형 PII 마스킹).
    ALTER TABLE org_tool ADD COLUMN IF NOT EXISTS auth_kind TEXT;
    ALTER TABLE org_tool ADD COLUMN IF NOT EXISTS auth_scope_key TEXT;
    ALTER TABLE org_tool ADD COLUMN IF NOT EXISTS pii_scrub BOOLEAN NOT NULL DEFAULT false;
    -- log_args(#1082): http_proxy 툴도 조직 밖으로 나가는 통신이라 org_mcp_server 와 같은 규칙 — 인자 값 기본 미저장.
    ALTER TABLE org_tool ADD COLUMN IF NOT EXISTS log_args BOOLEAN NOT NULL DEFAULT false;
  `);

  // ── org_harness_asset — 조직 하네스 자산(스킬·서브에이전트·슬래시커맨드, 관리자 정의). org_hook 과 같은 runtime ──
  // 자산군이지만 훅과 결정적으로 다르다: 하네스가 디스크를 '스캔'해야 발견하므로(name+description 상시광고,
  // 본문 온디맨드) 본문을 멤버 디스크에 **materialize** 한다(~/.claude|.codex/{skills,agents,commands}). session-preload
  // 가 매 세션 게이트웨이서 받아 비파괴 reconcile(회수=다음 세션 제거, 단 capability 라 fail-OPEN=last-known-good —
  // 위험 enforcement 는 paired_hook 이 fail-CLOSED 런너로 담당). content_hash=sha256(정규화 소스)는 클라 변경감지(재작성 skip)용.
  //  kind: skill|subagent|command. harness: 대상(claude|codex|openclaw|all). skill 은 Agent Skills 오픈표준이라 Claude·Codex
  //  동일 SKILL.md(파일 1개로 양 하네스). subagent 는 Claude .md=여기, Codex .toml 은 후속. command 는 Claude=여기, Codex=스킬로 통합.
  //  target_members: NULL/빈=전원, 배열=그 멤버만(per-member 타깃팅). paired_hook_id: 짝훅(org_hook.id, 약결합 — 자산 없이도 훅 독립).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_harness_asset(
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'skill',
      label TEXT,
      harness TEXT NOT NULL DEFAULT 'all',
      description TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
      target_members JSONB,
      paired_hook_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      content_hash TEXT,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ALTER TABLE org_harness_asset ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
    ALTER TABLE org_hook ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
    ${ensureCheck("org_harness_asset", {
      org_harness_asset_kind_chk: "kind IN ('skill','subagent','command')",
    })}
    ${/* 하네스 확장(#1519) — 프로브형이 아니라 DROP+ADD 여야 라이브 제약이 실제로 넓어진다. */
      redefineCheck("org_harness_asset", "org_harness_asset_harness_chk", "harness IN ('claude','codex','openclaw','opencode','antigravity','grok','all')")}
  `);

  // ── org_asset_pref — per-member 개인 오버라이드(#699). 관리자 정책(enabled+target_members) 위에 멤버가 본인 것만 ──
  //  on(opt-in)/off(opt-out)/기본복귀(행 삭제)로 조정. harness_asset·org_hook 공통(target_kind 로 구분). 유효 가시성 =
  //  enabled AND harness매치 AND (pref 있으면 그 state, 없으면 target_members NULL/빈 OR member∈target_members).
  //  enabled=false 는 마스터킬(pref 무시). 내부 테이블 → firewall DENIED_TABLES 등록(db_query 차단).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_asset_pref(
      target_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      state BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY(target_kind, ref_id, member_id));
    ${ensureCheck("org_asset_pref", { org_asset_pref_kind_chk: "target_kind IN ('harness_asset','org_hook')" })}
  `);

  // 개명 마이그레이션(2026-06-25): 구 knowledge_search(의미검색 미스노머, 실동작 grep) → knowledge_grep.
  //  시드 INSERT **앞**에서 라이브 org_tool 행을 이관해 운영자의 enabled/auto_approve 를 보존한다(뒤에 두면 시드가 기본값으로 새 행을 먼저 박음).
  //  멱등: 새 이름(grep) 행이 없을 때만 개명. ⚠ 2026-06-26(#172): 'knowledge_search' 이름이 **진짜 벡터/하이브리드 검색 도구로 재배정**됨 →
  //   과거의 무조건 `DELETE knowledge_search` 는 제거(이제 새 도구의 게이트 행을 매 부팅 지우면 안 됨). 개명은 grep 부재 시에만 동작하므로,
  //   이미 grep 이 있는(개명 완료) DB 에선 no-op 이고 새 knowledge_search 시드(아래 INSERT)가 벡터검색 도구로 박힌다.
  await pool.query(`
    UPDATE org_tool SET name='knowledge_grep'
     WHERE name='knowledge_search' AND NOT EXISTS (SELECT 1 FROM org_tool WHERE name='knowledge_grep');
  `);

  // 빌트인 도구 정책 시드 — 운영자 웹 최종 편집본(노출 enabled + 자동승인 auto_approve)을 신규 게이트웨이 기본으로 박는다.
  //  노출/자동승인 상태의 SoT 는 org_tool(DB). expose.mcp 는 "MCP 도구냐"만 선언하고, 노출·자동승인은 여기(DB)가 정한다.
  //  ON CONFLICT DO NOTHING = 최초 1회만 — 기존 인스턴스의 운영자 변경을 덮지 않는다(시드는 신규 설치 기본값일 뿐).
  //  현 정책: 대부분 빌트인 노출+자동승인, 위험한 삭제만 OFF — project_delete_v6(프로젝트 영구삭제)·task_delete_v6(작업 캐스케이드 삭제)·task_field_delete_v6(컬럼+전체값 손실).
  //  + delegate_run OFF(#904): MCP 동기 wait 는 하네스 인라인 블로킹 → 긴 위탁서 transport-drop(응답 유실) footgun. 위탁은 lively delegate CLI 를 Bash(run_in_background) 로(런북 delegate-background-cli-not-mcp-wait).
  //   REST(POST /api/ui/delegate)·모니터(delegate_status/list/logs/cancel) 는 유지 — CLI·교차세션 관찰 무손상(모니터는 non-blocking 이라 footgun 아님). delegate_run 은 현재 org_tool 행이 없어 이 시드가 신규·기존 모든 박스에 INSERT 된다. 시드에 없는 신규 도구는
  //  org_tool 행 없음 → expose.mcp 기본(노출) + auto_approve OFF 로 동작 — 필요하면 웹 도구탭에서 토글한다.
  await pool.query(`
    INSERT INTO org_tool(name, kind, enabled, auto_approve) VALUES
      ('activity_list','builtin',true,true),
      ('activity_log','builtin',true,true),
      ('category_create','builtin',true,true),
      ('category_delete','builtin',true,true),
      ('category_edge_list','builtin',true,true),
      ('category_edge_remove','builtin',true,true),
      ('category_edge_set','builtin',true,true),
      ('category_get','builtin',true,true),
      ('category_list','builtin',true,true),
      ('category_update','builtin',true,true),
      ('content_restore','builtin',true,true),
      ('context_overview','builtin',true,true),
      ('db_query','builtin',true,true),
      ('db_schema','builtin',true,true),
      ('db_sources','builtin',true,true),
      ('debt_list','builtin',true,true),
      ('deleted_list','builtin',true,true),
      ('knowledge_delete','builtin',true,true),
      ('knowledge_get','builtin',true,true),
      ('knowledge_link_category','builtin',true,true),
      ('knowledge_list','builtin',true,true),
      ('knowledge_save','builtin',true,true),
      ('knowledge_grep','builtin',true,true),
      ('knowledge_search','builtin',true,true),
      ('knowledge_similar','builtin',true,true),
      ('knowledge_set_lifecycle','builtin',true,true),
      ('knowledge_set_wiki','builtin',true,true),
      ('project_create_v6','builtin',true,true),
      ('project_delete_v6','builtin',false,false),
      ('project_get_v6','builtin',true,true),
      ('project_link_category_v6','builtin',true,true),
      ('project_link_knowledge_v6','builtin',true,true),
      ('project_recommend_knowledge_v6','builtin',true,true),
      ('project_list_v6','builtin',true,true),
      ('project_set_members_v6','builtin',true,true),
      ('project_set_status_v6','builtin',true,true),
      ('project_list_index_v6','builtin',true,true),
      ('project_list_create_v6','builtin',true,true),
      ('project_list_update_v6','builtin',true,true),
      ('project_list_delete_v6','builtin',true,true),
      ('project_list_set_members_v6','builtin',true,true),
      ('project_set_list_v6','builtin',true,true),
      ('repo_create','builtin',true,true),
      ('repo_delete','builtin',true,true),
      ('repo_deprecate','builtin',true,true),
      ('repo_list','builtin',true,true),
      ('repo_rename','builtin',true,true),
      ('repo_set_source','builtin',true,true),
      ('task_create_v6','builtin',true,true),
      ('task_set_status_v6','builtin',true,true),
      ('task_delete_v6','builtin',false,false),
      ('task_field_delete_v6','builtin',false,false),
      ('delegate_run','builtin',false,false),
      ('knowledge_link','builtin',true,true),
      ('source_list','builtin',true,true),
      ('source_get','builtin',true,true),
      ('source_save','builtin',true,true),
      ('source_link_knowledge','builtin',true,true),
      ('source_delete','builtin',true,true),
      -- #1072 whoami: 자기 신원 조회(읽기·인자 없음·부작용 0). 상시로드 툴이라 매 호출 컨펌은 순수 마찰 → 자동승인.
      ('whoami','builtin',true,true)
    ON CONFLICT (name) DO NOTHING;
  `);
}

export async function initOrgHookHealthColumn(pool: Pool): Promise<void> {
  // ── org_hook 확장: health — 멤버별 마지막 훅 실행 실패 기록(#892 결함 C). ──
  // { "<member_id>": { at, reason, exit_code, stderr } } — 멤버 수로 자연히 유계라 별도 테이블·정리 불요.
  // 종전엔 훅이 죽어도 러너가 크래시를 삼켜(stdout "") '죽음'과 '결정 없음'이 구분 불가였고, 그래서 spec-blind
  //  guard/tracker 가 등록 이래 내내 죽은 걸 아무도 몰랐다. 실패했을 때만 기록되므로 정상 조직은 항상 '{}'.
  await pool.query(`
    ALTER TABLE org_hook ADD COLUMN IF NOT EXISTS health JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
}
