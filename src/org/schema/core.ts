// org 스키마 조각 — core: 조직 기본 축. org_profile(단일행)·org_member(구성원)·org_content_audit(감사)·
//  mcp_call_log(MCP 호출 전수 로그)·auth_token(DB bearer 토큰) + 후반 가산 블록(status_message·project_member·감사 확장).
// #1313 R19b: 구 단일 initOrgSchema(org/schema.ts, ~1,500줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 org/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initOrgCore(pool: Pool): Promise<void> {
  // ── org_profile — 단일 행(id=1): 조직 표시명 + 게이트웨이 주소 + 시간대. ──
  //  timezone(#778): 게이트웨이의 벽시계 의미론(cron·일자집계·세션 pane TZ) 기준. NULL=미설정 → 코드 기본값
  //  (org/timezone.ts DEFAULT_TZ). DB DEFAULT 를 안 박는 이유 = 기본값 출처를 한 곳(코드)으로 유지.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_profile(
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      name TEXT,
      display_name TEXT,
      gateway_url TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    INSERT INTO org_profile(id) VALUES(1) ON CONFLICT DO NOTHING;
    ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS timezone TEXT;
  `);

  // org_content/org_memory 폐기(2026-06-24) — v6 knowledge 컷오버 완료(store 함수=v6 래퍼). knowledge_unit 복사 후 원본 DROP.

  // ── org_member — 구성원 authoring 레코드(members/<id>.md 의 DB 표현). ──
  // identities JSONB = [{system, external_id, email?, instance?, display_name?}]. body_md = 개인 레이어 본문.
  // upsert 시 person/person_identity 로도 동기화(org/store.ts) → 멤버 편집이 즉시 신원 매칭에 반영.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_member(
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'human',
      display_name TEXT,
      email TEXT,
      identities JSONB NOT NULL DEFAULT '[]'::jsonb,
      body_md TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    -- scopes = 구성원 권한(발급 토큰의 scope). memory 기본 포함(단일 공유 풀=에이전트 생산·소비, 06-17).
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL DEFAULT '["items","context","memory"]'::jsonb;
    -- avatar = 셀프 업로드 프로필 이미지(data URL, 클라이언트에서 128px 리사이즈). null/'' = 이니셜+색상 자동생성.
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS avatar TEXT;
    -- avatar_char/color = 이미지 없을 때 쓰는 커스텀 글자/배경색(프로필 설정). null = 이니셜/해시색 자동.
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS avatar_char TEXT;
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS avatar_color TEXT;
    -- nickname = 표시 이름(display_name)과 별개의 닉네임(#762). 활동 로그 등 캐주얼 표기에 쓴다. null/'' = display_name 폴백.
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS nickname TEXT;
    -- use_nickname = 「이 닉네임을 내 이름으로 사용」(#1813). 켜면 **사람 이름을 보이는 자리 전부**에서
    --  nickname 이 display_name 을 대체한다(memberName() 단일 판정). 끄면 nickname 은 활동 로그 등
    --  캐주얼 표기에만 남는다. 닉네임이 비어 있으면 이 플래그는 의미가 없다(판정이 display_name 으로 떨어진다).
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS use_nickname BOOLEAN NOT NULL DEFAULT false;
    -- onboarding = 구성원 온보딩의 **보고된** 상태(#846/850). 형태:
    --   { "<step>": { "state": "done"|"skipped", "at": "<iso>", "by": "ai"|"self", "note": "…" } }
    -- ⚠ 자동 판정되는 것(MCP 호출 이력·자격 등록·레포 연결)은 **여기 저장하지 않는다** — 조회 시점에 라이브
    --  계산한다(computeMemberOnboarding). 이 컬럼엔 서버가 **볼 수 없는 것**(그 사람 노트북의 로컬 이관 완료 —
    --  AI 스킬이 보고)과 사용자의 **의도적 오버라이드**(웹 ⋯ 메뉴)만 담긴다. 상태를 두 곳에 두면 어긋난다.
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS onboarding JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- harness_snapshot = 멤버 노트북의 로컬 하네스 자산 **관측 스냅샷**(#891 온보딩 C). 형태:
    --   { "at": "<iso>", "host": "<hostname>", "harness": "claude"|"codex",
    --     "assets": [ { "id", "kind": "skill"|"subagent"|"command"|"hook", "managed": bool } ] }
    -- ⚠ 관측이지 보고가 아니다(onboarding 과 성격 다름 — 그래서 별 컬럼). 세션훅(session-preload)이 매 세션
    --  로컬을 스캔해 **메타만** push 한다 — 스킬 본문·메모리 내용은 절대 안 담는다(사생활·용량). "마지막으로
    --  본 것"이라 노드 상태처럼 stale 가능(웹은 at 로 신선도 표시). 웹이 라이블리 자산(me_assets)과 대조해
    --  중복(라이블리 채택 권고)·shadow 를 보여준다.
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS harness_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- harness_local_pref = 로컬 파일 토글 지시(#891 슬라이스 2). 형태(머신별):
    --   { "<machine_id>": { "<kind>:<id>": true } }  (true = 끄기 = 세션훅이 .disabled 로 rename)
    -- 라이블리 스킬 opt-out(org_asset_pref)과 다르다: 그건 멤버 단위(모든 머신 배포분), 이건 **그 머신의 로컬 파일만**.
    -- 세션훅(sync-harness-assets)이 자기 machine_id 지시를 pull 해 로컬 파일을 비파괴 rename 한다(원본 보존).
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS harness_local_pref JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- local_mode_pref = 이 멤버의 컴퓨터별 lively run 기본 연결 상태(#1869). 형태:
    --   { "<machine_id>": { "mode": "normal"|"readonly"|"incognito", "updated_at": "<iso>" } }
    -- 웹에서 바꾸면 CLI 가 **하네스를 띄우기 전에** pull 해 ~/.lively/mode 에 반영한다. incognito 는 세션훅을
    -- 끄므로 harness_local_pref 경로에 섞으면 웹에서 다시 켤 수 없다 — 그래서 훅과 독립된 CLI preflight 설정이다.
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS local_mode_pref JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- harness_machine_alias = 머신별 사용자 지정 별명(#893 후속). 형태: { "<machine_id>": "집 맥북" }.
    --  관측(host)과 별개다 — 세션 report 는 host 만 관측하고 이 별명은 안 건드린다(사용자가 직접 지정, 리포트에 안 실림).
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS harness_machine_alias JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- liv_profile = 리브(#1631)가 **이 사람에 대해 아는 것**. 형태:
    --   { "work": { "asis": "…", "tobe": "…", "at": "<iso>", "by": "ai"|"self" },
    --     "decisions": [ { "at", "what", "why", "by" } ],
    --     "declined":  [ { "at", "key", "why" } ] }
    -- ⚠ **리브의 기억은 대화가 아니라 여기 있다.** 세션은 죽고 컨텍스트는 날아가므로, 다음 세션의 리브가
    --  다시 묻지 않으려면 그 사이의 앎이 서버에 남아야 한다(기획 불변식: 리브 세션은 교체 가능하다).
    -- ⚠ **서버가 이미 아는 것은 절대 복제하지 않는다** — 온보딩 진행·파이프라인·하네스 인벤토리는 각자 자기
    --  자리에서 라이브 계산된다. 여기 담는 건 서버가 **볼 수 없는 것**뿐이다: 그 사람의 업무 방식(ASIS/TOBE),
    --  왜 그렇게 설정했는지, 그리고 **무엇을 거절했는지**. declined 가 없으면 리브는 매번 같은 걸 권하는
    --  잔소리꾼이 된다(#850 이 멤버 온보딩을 세션 주입에서 뺀 이유와 같은 함정, 상시 에이전트라 더 크다).
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS liv_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
  await pool.query(`
    ${ensureCheck("org_member", {
      org_member_kind_chk: "kind IN ('human','agent','system')",
      org_member_state_chk: "state IN ('active','inactive')",
    })}
  `);


  // ── org_content_audit — append-only 감사 로그(item_mapping_audit/change_log 대응물). ──
  // 모든 org-content 쓰기는 여기 before/after 스냅샷을 남긴다. FK 없음(행 삭제 후에도 이력 보존).
  // append-only 불변식: UPDATE/DELETE 코드 경로를 만들지 않는다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_content_audit(
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entity TEXT NOT NULL,
      entity_key TEXT,
      op TEXT NOT NULL,
      before JSONB,
      after JSONB,
      actor TEXT,
      source TEXT);
    CREATE INDEX IF NOT EXISTS org_content_audit_at_idx ON org_content_audit(at DESC);
    CREATE INDEX IF NOT EXISTS org_content_audit_entity_idx ON org_content_audit(entity, entity_key);
  `);

  // ── mcp_call_log — 하네스 MCP 툴 호출 전수 로그(프로젝트 #318). append-only, FK 없음(행 삭제 후에도 이력 보존). ──
  //  적재 경로: registerTool 단일 wrap(src/server.ts instrument)이 capability·db·dynamic 3경로의 모든 tools/call 을 포착한다.
  //   tools/list(목록 조회)는 적재 안 됨 — 실제 호출(핸들러 실행)만 1행. fire-and-forget INSERT(요청 지연 0, 실패는 무시 — fail-open).
  //  args = redactDeep(시크릿 마스킹) + 큰 문자열 절단 + 총량 캡(src/org/policies/tool-log.ts). 본문 같은 대형 페이로드는 잘려 들어간다.
  //  읽는 쪽: 직접/LLM 쿼리(db_query 가 이 테이블을 SELECT) + 대시보드 집계(/api/ui/tool-usage → 관리탭 'MCP 호출 통계').
  //  harness = 접속 신원(x-lively-harness 헤더 우선, 없으면 UA — claude-code/codex/openclaw/null). actor = 토큰 principal(userId).
  //  ⚠ 보존정책: v1 은 무제한(소팀 볼륨 가정 — 일 수천~수만 행, 90일<1M 행은 postgres 무리 없음). 성장 시
  //   주기 prune(예: DELETE WHERE called_at < now()-INTERVAL '90 days')를 별도 cron 액션으로 추가한다(현재 미구현).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_call_log(
      id BIGSERIAL PRIMARY KEY,
      called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      tool TEXT NOT NULL,
      harness TEXT,
      actor TEXT,
      args JSONB,
      ok BOOLEAN NOT NULL DEFAULT true,
      error TEXT,
      duration_ms INT,
      source TEXT NOT NULL DEFAULT 'mcp');
    -- 구 컬럼 'at' → 'called_at' 비파괴 개명(#318): db_query 읽기 방화벽 파서(node-sql-parser)가 'at' 를
    --  AT TIME ZONE 키워드로 오인 → 'SELECT ... at ... FROM mcp_call_log' 가 파싱 실패. 하네스/LLM 가
    --  직접 조회하는 게 이 테이블의 핵심 용도이므로, 외우게 할 함정을 만들지 않고 컬럼명에서 제거한다.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mcp_call_log' AND column_name='at')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mcp_call_log' AND column_name='called_at') THEN
        ALTER TABLE mcp_call_log RENAME COLUMN at TO called_at;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS mcp_call_log_at_idx ON mcp_call_log(called_at DESC);
    CREATE INDEX IF NOT EXISTS mcp_call_log_tool_at_idx ON mcp_call_log(tool, called_at DESC);
    CREATE INDEX IF NOT EXISTS mcp_call_log_harness_at_idx ON mcp_call_log(harness, called_at DESC);
  `);

  // ── auth_token — DB 기반 bearer 토큰(정적 AUTH_TOKENS_JSON 의 핫리로드 가능 대체). ──
  // 평문 토큰은 저장하지 않는다(sha256 해시만). 발급 시 1회만 평문 노출. revoke = revoked_at 세팅
  //  → 게이트웨이 재시작 없이 즉시 무효(verifyDbToken 이 revoked_at IS NULL 만 통과).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_token(
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      projects JSONB NOT NULL DEFAULT '["*"]'::jsonb,
      label TEXT,
      member_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by TEXT,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS auth_token_user_idx ON auth_token(user_id);
    CREATE INDEX IF NOT EXISTS auth_token_member_idx ON auth_token(member_id);
    -- email 은 토큰에 저장하지 않는다(귀속 표시용 → member_id 로 파생). 기존 DB 의 중복 컬럼 제거(멱등).
    ALTER TABLE auth_token DROP COLUMN IF EXISTS email;
  `);
}

// 후반 가산 블록 — 원 파일에서 ingest 조각 뒤·registry 시드 앞에 있던 core 관심사 블록(순서 보존을 위한 별도 진입점).
export async function initOrgCoreLateAdditions(pool: Pool): Promise<void> {
  // 멤버 상태메시지 — 본인이 설정해 프로필 밑에 공유하는 '현재 상태'(프로젝트 팀원 프로필 그리드).
  await pool.query(`ALTER TABLE org_member ADD COLUMN IF NOT EXISTS status_message TEXT;`);

  // ── project_member — 프로젝트 팀원(n:n). project(v6).id 참조 — v6/schema 가 FK 를 project 로 ALTER한다. ──
  //  레거시 org_project 는 폐기(2026-06-24, projects2/v6 통합 — 고아 v1 제거 + 테이블 DROP). project_member 는 v6 소유로 잔존.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_member(
      project_id INT NOT NULL,
      member_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      sort INT NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, member_id));
    ALTER TABLE project_member ADD COLUMN IF NOT EXISTS sort INT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS project_member_member_idx ON project_member(member_id);
  `);

  // ── org_content_audit 확장: 회수 대상 즉시 특정용 token 해시 prefix + 요청 IP(B23). ──
  await pool.query(`
    ALTER TABLE org_content_audit ADD COLUMN IF NOT EXISTS token_hash_prefix TEXT;
    ALTER TABLE org_content_audit ADD COLUMN IF NOT EXISTS req_ip TEXT;
  `);

  // ── 수정이력(작성자/리비전) — org_content_audit 가 지식·섹션 쓰기의 append-only 리비전 소스다 ──
  //  (v6: entity='knowledge' 행 — insert/update/set_lifecycle/delete + before/after = redactDeep 후 full 스냅샷 + actor + source.
  //   구 entity='knowledge_unit' 이력행은 비파괴 보존되나 투영 뷰 knowledge_unit_revision 은 v6 드랍됨.) 윤상민 요구("누가 사람/AI·어떤경로 mcp/web/connector·언제·내용
  //   history")를 **신 테이블 없이** 2개 가산 컬럼 + 편의 뷰로 충족한다(신 테이블은 586행 백필·이중감사·기존
  //   wrap 호환 리스크만 키움 — view 채택). 스냅샷 채택(이미 full after 스냅샷이라 diff 파생은 읽기 시 인접 비교).
  //   · actor_kind = 누가(사람/AI) — 진실원천은 org_member.kind(신원)지 channel 이 아님(yoon 이 mcp 로 써도 human).
  //   · channel    = 어떤 경로(mcp/web/connector/cli/migration) — source 컬럼이 이미 채널(어댑터가 결정적 주입).
  //  CHECK 는 NULL 허용(레거시 source 에 cleanup/test 등 잡값 존재 → 신규 쓰기만 enum 강제, 기존행 무손상).
  await pool.query(`
    ALTER TABLE org_content_audit ADD COLUMN IF NOT EXISTS actor_kind TEXT;
    ALTER TABLE org_content_audit ADD COLUMN IF NOT EXISTS channel    TEXT;
  `);
  await pool.query(`
    ${ensureCheck("org_content_audit", {
      org_content_audit_actor_kind_chk: "actor_kind IS NULL OR actor_kind IN ('human','ai','connector','system','unknown')",
      org_content_audit_channel_chk: "channel IS NULL OR channel IN ('mcp','web','connector','cli','migration','unknown')",
    })}
  `);
}
