// org-content 스키마 — workflow-std(전달 서브시스템)의 진실원천을 git 파일에서 이 DB로 이관.
// items DB(itemsPool)에 co-locate: 멤버 신원(person/person_identity)이 이미 거기 있고, 쓰기 풀이라
// 게이트웨이 firewall(읽기전용 db_query 경로)을 우회한다. 발행 시에만 DB→임시디렉토리 materialize 후
// 기존 file-based generator 를 subprocess 로 재사용한다(ARCHITECTURE.md 전달층 흡수).
//
// 멱등 마이그레이션 패턴은 items/store.ts 와 동일: CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS
//  + pg_constraint 프로브로 CHECK enum 멱등 적용. 부팅 시 1회(비치명적) 호출.
import { itemsPool } from "../items/store.js";

export async function initOrgSchema(): Promise<void> {
  // ── org_profile — 단일 행(id=1): 조직 표시명 + 게이트웨이 주소 + 시간대. ──
  //  timezone(#778): 게이트웨이의 벽시계 의미론(cron·일자집계·세션 pane TZ) 기준. NULL=미설정 → 코드 기본값
  //  (org/timezone.ts DEFAULT_TZ). DB DEFAULT 를 안 박는 이유 = 기본값 출처를 한 곳(코드)으로 유지.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_profile(
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      name TEXT,
      display_name TEXT,
      gateway_url TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    INSERT INTO org_profile(id) VALUES(1) ON CONFLICT (id) DO NOTHING;
    ALTER TABLE org_profile ADD COLUMN IF NOT EXISTS timezone TEXT;
  `);

  // org_content/org_memory 폐기(2026-06-24) — v6 knowledge 컷오버 완료(store 함수=v6 래퍼). knowledge_unit 복사 후 원본 DROP.

  // ── org_member — 구성원 authoring 레코드(members/<id>.md 의 DB 표현). ──
  // identities JSONB = [{system, external_id, email?, instance?, display_name?}]. body_md = 개인 레이어 본문.
  // upsert 시 person/person_identity 로도 동기화(org/store.ts) → 멤버 편집이 즉시 신원 매칭에 반영.
  await itemsPool.query(`
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
    -- harness_machine_alias = 머신별 사용자 지정 별명(#893 후속). 형태: { "<machine_id>": "집 맥북" }.
    --  관측(host)과 별개다 — 세션 report 는 host 만 관측하고 이 별명은 안 건드린다(사용자가 직접 지정, 리포트에 안 실림).
    ALTER TABLE org_member ADD COLUMN IF NOT EXISTS harness_machine_alias JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
  await itemsPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_member'::regclass AND conname='org_member_kind_chk') THEN
        ALTER TABLE org_member ADD CONSTRAINT org_member_kind_chk CHECK (kind IN ('human','agent','system'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_member'::regclass AND conname='org_member_state_chk') THEN
        ALTER TABLE org_member ADD CONSTRAINT org_member_state_chk CHECK (state IN ('active','inactive'));
      END IF;
    END $$;
  `);


  // ── org_content_audit — append-only 감사 로그(item_mapping_audit/change_log 대응물). ──
  // 모든 org-content 쓰기는 여기 before/after 스냅샷을 남긴다. FK 없음(행 삭제 후에도 이력 보존).
  // append-only 불변식: UPDATE/DELETE 코드 경로를 만들지 않는다.
  await itemsPool.query(`
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
  //  args = redactDeep(시크릿 마스킹) + 큰 문자열 절단 + 총량 캡(src/org/tool-log.ts). 본문 같은 대형 페이로드는 잘려 들어간다.
  //  읽는 쪽: 직접/LLM 쿼리(db_query 가 이 테이블을 SELECT) + 대시보드 집계(/api/ui/tool-usage → 관리탭 'MCP 호출 통계').
  //  harness = 접속 신원(x-lively-harness 헤더 우선, 없으면 UA — claude-code/codex/openclaw/null). actor = 토큰 principal(userId).
  //  ⚠ 보존정책: v1 은 무제한(소팀 볼륨 가정 — 일 수천~수만 행, 90일<1M 행은 postgres 무리 없음). 성장 시
  //   주기 prune(예: DELETE WHERE called_at < now()-INTERVAL '90 days')를 별도 cron 액션으로 추가한다(현재 미구현).
  await itemsPool.query(`
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
  await itemsPool.query(`
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

  // ── org_runtime_config — 런타임(훅) 설정 단일행: 훅 on/off · work-roots · writeback 너지 문구. ──
  // 멤버 머신에 materialize → ~/.lively/hooks-config.json + work-roots. 훅이 런타임에 읽음(fail-open).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_runtime_config(
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      hooks JSONB NOT NULL DEFAULT '{"session_preload":true,"work_flag":true,"stop_writeback_gate":true,"self_update":true}'::jsonb,
      writeback_notice TEXT,
      work_roots JSONB NOT NULL DEFAULT '[]'::jsonb,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT (id) DO NOTHING;
  `);

  // ── org_mcp_server — 조직 MCP 서버 레지스트리. register-clients/어댑터가 멤버 하네스에 등록. ──
  // 시크릿 금지: 인증은 auth_env(환경변수 '이름'만, 값 아님). transport http(url) | stdio(command).
  await itemsPool.query(`
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
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_mcp_server'::regclass AND conname='org_mcp_server_transport_chk') THEN
        ALTER TABLE org_mcp_server ADD CONSTRAINT org_mcp_server_transport_chk CHECK (transport IN ('http','stdio'));
      END IF;
    END $$;
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
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_mcp_server'::regclass AND conname='org_mcp_server_mode_chk') THEN
        ALTER TABLE org_mcp_server ADD CONSTRAINT org_mcp_server_mode_chk CHECK (mode IN ('client','proxy'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_mcp_server'::regclass AND conname='org_mcp_server_level_chk') THEN
        ALTER TABLE org_mcp_server ADD CONSTRAINT org_mcp_server_level_chk CHECK (level IS NULL OR level IN ('L0','L1','L2'));
      END IF;
    END $$;
    -- auth_mode 허용값 확장(#746: +sigv4) — CHECK 은 IF NOT EXISTS 로 라이브 제약이 안 바뀌므로 DROP+ADD(멱등).
    ALTER TABLE org_mcp_server DROP CONSTRAINT IF EXISTS org_mcp_server_auth_mode_chk;
    ALTER TABLE org_mcp_server ADD CONSTRAINT org_mcp_server_auth_mode_chk CHECK (auth_mode IS NULL OR auth_mode IN ('bearer','oauth','sigv4'));
  `);

  // ── org_connector — 커넥터별 설정/토큰 레지스트리 (프로젝트 #541). system PK = 1행/커넥터(단일테넌트). ──
  //  config  = 비밀 아닌 설정(평문 JSONB: clickup list ids·notion instance·slack channels 등, CONNECTOR_SPECS secret:false).
  //  secrets = 암호화 시크릿(JSONB {key: "gcm$…"}, secret-box AES-256-GCM, CONNECTOR_SPECS secret:true).
  //  종전 org_mcp_server.auth_env(env 이름만) 컨벤션을, SSM 전용 배포(어니스트 실박스=파일편집 불가)를 위해 '암호문 저장'
  //  으로 확장 — 평문 시크릿은 여전히 DB 에 두지 않는다(암호문만). 커넥터 해소(connectors/config.ts)가 DB→복호화→env 폴백.
  //  data_source(카탈로그: system/status/label)와 별개 축 — 그건 커넥터 존재·활성 메타, 여긴 자격/설정.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_connector(
      system TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);

  // ── org_hook — 커스텀 훅(관리자 정의, 구성원 머신에서 실행). 본문(source_code)은 멤버 디스크에 굳히지 ──
  // 않고 불변 런너가 매 세션 게이트웨이에서 fetch 해 실행한다(회수=다음 세션 무효, kill-switch). 내장 훅 3종은
  // org_runtime_config.hooks 토글로 별도 관리(여기는 커스텀 전용). content_hash=sha256(source_code)는 런너 무결성 게이트용.
  await itemsPool.query(`
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
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_hook'::regclass AND conname='org_hook_harness_chk') THEN
        ALTER TABLE org_hook ADD CONSTRAINT org_hook_harness_chk CHECK (harness IN ('claude','codex','openclaw','all'));
      END IF;
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
  await itemsPool.query(`
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
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_tool'::regclass AND conname='org_tool_kind_chk') THEN
        ALTER TABLE org_tool ADD CONSTRAINT org_tool_kind_chk CHECK (kind IN ('http_proxy','builtin','prompt'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_tool'::regclass AND conname='org_tool_method_chk') THEN
        ALTER TABLE org_tool ADD CONSTRAINT org_tool_method_chk CHECK (method IS NULL OR method IN ('GET','POST','PUT','PATCH','DELETE'));
      END IF;
    END $$;
    -- always_load(주입모드 override) — NULL=코드 기본값(cap.meta) 사용, true=항상 주입, false=deferred(검색 시 로드). #187.
    --  Claude Code 만 해석하는 _meta(anthropic/alwaysLoad)로 변환된다(Codex 는 서버측 deferral 미지원). 비파괴 ADD COLUMN.
    ALTER TABLE org_tool ADD COLUMN IF NOT EXISTS always_load BOOLEAN;
    -- level(권한 등급, P2 #746) — NULL=코드 기본값(L0). L0=조회 / L1=제안(MR·draft) / L2=집행(외부발신·상태변경).
    --  L2 툴은 auto_approve 목록에서 강제 제외(listAutoApproveTools) → 하네스 인터랙티브 컨펌으로만 집행. prod apply·배포·sync 는 미노출(관리자 전담).
    ALTER TABLE org_tool ADD COLUMN IF NOT EXISTS level TEXT;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_tool'::regclass AND conname='org_tool_level_chk') THEN
        ALTER TABLE org_tool ADD CONSTRAINT org_tool_level_chk CHECK (level IS NULL OR level IN ('L0','L1','L2'));
      END IF;
    END $$;
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
  await itemsPool.query(`
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
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_harness_asset'::regclass AND conname='org_harness_asset_kind_chk') THEN
        ALTER TABLE org_harness_asset ADD CONSTRAINT org_harness_asset_kind_chk CHECK (kind IN ('skill','subagent','command'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_harness_asset'::regclass AND conname='org_harness_asset_harness_chk') THEN
        ALTER TABLE org_harness_asset ADD CONSTRAINT org_harness_asset_harness_chk CHECK (harness IN ('claude','codex','openclaw','all'));
      END IF;
    END $$;
  `);

  // ── org_asset_pref — per-member 개인 오버라이드(#699). 관리자 정책(enabled+target_members) 위에 멤버가 본인 것만 ──
  //  on(opt-in)/off(opt-out)/기본복귀(행 삭제)로 조정. harness_asset·org_hook 공통(target_kind 로 구분). 유효 가시성 =
  //  enabled AND harness매치 AND (pref 있으면 그 state, 없으면 target_members NULL/빈 OR member∈target_members).
  //  enabled=false 는 마스터킬(pref 무시). 내부 테이블 → firewall DENIED_TABLES 등록(db_query 차단).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_asset_pref(
      target_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      state BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY(target_kind, ref_id, member_id));
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_asset_pref'::regclass AND conname='org_asset_pref_kind_chk') THEN
        ALTER TABLE org_asset_pref ADD CONSTRAINT org_asset_pref_kind_chk CHECK (target_kind IN ('harness_asset','org_hook'));
      END IF;
    END $$;
  `);

  // 개명 마이그레이션(2026-06-25): 구 knowledge_search(의미검색 미스노머, 실동작 grep) → knowledge_grep.
  //  시드 INSERT **앞**에서 라이브 org_tool 행을 이관해 운영자의 enabled/auto_approve 를 보존한다(뒤에 두면 시드가 기본값으로 새 행을 먼저 박음).
  //  멱등: 새 이름(grep) 행이 없을 때만 개명. ⚠ 2026-06-26(#172): 'knowledge_search' 이름이 **진짜 벡터/하이브리드 검색 도구로 재배정**됨 →
  //   과거의 무조건 `DELETE knowledge_search` 는 제거(이제 새 도구의 게이트 행을 매 부팅 지우면 안 됨). 개명은 grep 부재 시에만 동작하므로,
  //   이미 grep 이 있는(개명 완료) DB 에선 no-op 이고 새 knowledge_search 시드(아래 INSERT)가 벡터검색 도구로 박힌다.
  await itemsPool.query(`
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
  await itemsPool.query(`
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

  // ── org_runtime_config 확장: http_proxy 안전 화이트리스트(B15). 둘 다 기본 빈 배열(deny-all). ──
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS allowed_auth_envs JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS url_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장: db 소스가 참조 가능한 시크릿 env '이름' 화이트리스트(deny-all 기본). ──
  // 인프라 시크릿(DATABASE_URL·ITEMS_DATABASE_URL 등)을 UI 로 참조해 게이트웨이 자기 DB 를 탈취하는 권한상승 차단.
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS allowed_db_secret_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장: db 데이터소스가 접속 가능한 host 화이트리스트(deny-all 기본). ──
  // 웹 등록 소스는 SSRF 가드로 사설/localhost 를 막는다(브라우저 임의입력 신뢰 불가). 운영자가 admin 으로 여기에
  //  명시한 host 만 사설/내부 DB(예: localhost 의 items)를 db 소스로 접속 허용 — 신뢰경계를 운영자에 고정.
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS allowed_db_hosts JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장(#746 T1): MCP 프록시가 접속 가능한 '내부(사설/localhost)' host 화이트리스트(deny-all 기본). ──
  // 프록시 대상 remote MCP 는 기본 공인 https 만 — 사설/메타데이터/loopback 은 SSRF 로 차단. 격리 VPC 내부 MCP 서버처럼
  //  정당한 사설 대상은 운영자가 admin 으로 여기에 명시한 host 만 예외 허용(allowed_db_hosts 와 동형 — 신뢰경계를 운영자에 고정).
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS allowed_internal_hosts JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장: write_tools — work-flag 가 '기록함(writeback)'으로 인정할 lively MCP 툴 목록. ──
  // 비면(기본 '[]') 훅 내장 v6 기본목록 사용(writeback_notice 와 동형 오버라이드). 온톨로지 변경 시 재배포 없이 웹에서 갱신.
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS write_tools JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장: pull_tools — work-flag 가 '외부 맥락을 끌어왔다'로 볼 MCP 툴 이름 **prefix** 목록(#906). ──
  // write_tools 와 달리 **비면 끔**(기본값이 곧 on): 노브 하나로 on/off + 범위를 함께 잡는다. 훅 내장 폴백 없음 —
  //  게이트웨이 불가 시 pull_tools 부재 → 넛지 안 함(fail-safe: 넛지는 못 하는 쪽이 안전).
  // 기본 'mcp__lively__ext__' = 라이블리 MCP 프록시 전 호출(읽기·쓰기).
  //  ⚠ prefix 매칭이다(substring 아님) — 'ext__' 로 두면 서버명이 'context__…' 인 MCP 가 오탐된다.
  //  ⚠ 현재 훅 matcher 가 mcp__lively__.* 라 **다른 서버 prefix 를 넣어도 훅이 그 호출을 못 본다**(구성원 자체설치 MCP
  //   커버는 후속 — matcher 를 이 목록에서 파생시키는 설계가 선행돼야 한다. 넓히기만 하면 모든 MCP 호출마다 훅이 스폰된다).
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS pull_tools JSONB NOT NULL DEFAULT '["mcp__lively__ext__"]'::jsonb;
  `);

  // ── org_runtime_config 확장: embedding_config — 벡터검색(#172) 추론 seam 설정. config-over-code(고객 모델 스왑). ──
  // 기본 {"provider":"off"} = 벡터 비활성(현행 grep/ILIKE 그대로). 켜면 OpenAI-compatible /v1/embeddings 로 임베딩.
  // 시크릿 금지: auth_env_ref 는 환경변수 '이름'만(키 값 아님 — org_db_source.auth_ref idiom). 정규화/해석은 src/v6/embedding-provider.ts.
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS embedding_config JSONB NOT NULL DEFAULT '{"provider":"off"}'::jsonb;
  `);

  // ── org_runtime_config 확장: storage_policy — 박스 저장소 정책(#813). 로그 보관 상한 · 디스크 임계치. ──
  // 기본 '{}' = 미설정 → env 시드(LOG_MAX_MB·DISK_WARN_PCT…) → 코드 기본값 순으로 해석(src/org/storage-policy.ts).
  // **관리탭이 단일 창구**: 고객 박스는 우리가 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다.
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS storage_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: call_log_policy — MCP 호출 감사로그 보관 정책(#1082). 보존일수. ──
  // 기존엔 mcp_call_log 가 **무기한** 쌓였다(schema 주석에 'prune 은 성장 시 추가' 로 예고만 되고 미구현).
  //  호출 로그엔 누가 언제 무엇을 했는지가 사람 단위로 남으므로, 보관기간 없는 축적은 개인정보 최소보관 원칙에 어긋난다.
  // 기본 '{}' = 미설정 → env 시드(MCP_CALL_LOG_RETENTION_DAYS) → 코드 기본값(90일) 순(src/org/call-log-policy.ts).
  // **관리탭이 단일 창구**: 고객 박스는 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다(storage_policy 와 동일 교리).
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS call_log_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: session_memory_policy — per-session cgroup 메모리 격리(#1059 D). 세션당 MemoryHigh/Max(MB). ──
  // 기본 '{}' = 미설정 → env 시드(LIVELY_SESSION_MEM_HIGH_MB·_MAX_MB) → 0/0(무제한, 무회귀) 순으로 해석
  //  (src/org/session-memory-policy.ts). claude 는 네이티브라 힙제한이 안 통해 cgroup 이 유일 수단 — box-cgspawn 이
  //  systemd-run --scope 로 세션을 이 상한의 scope 에 가둬 폭주 세션 하나만 OOM-kill 되고 박스는 생존(#1059 어니스트 다운).
  // **관리탭이 단일 창구**: 고객 박스는 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다(storage_policy 와 동일 교리).
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS session_memory_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: session_reclaim_policy — idle 세션 자동 회수(reaper) 정책(#1059 F). idle TTL(분). ──
  // 기본 '{}' = 미설정 → env 시드(LIVELY_SESSION_IDLE_TTL_MIN) → 0(회수 끔, 무회귀) 순으로 해석
  //  (src/org/session-reclaim-policy.ts). 켜면 그 시간 넘게 idle 인 세션을 reaper 가 회수하되 desired-state
  //  (org_session_state)를 보존해 restorable 로 남긴다(#1059 E lazy resume). admission control 대신 채택된 근본대책.
  // **관리탭이 단일 창구**: 고객 박스는 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다(storage/session-memory 와 동일 교리).
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS session_reclaim_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: hook_relay_decisions — 러너가 PreToolUse 에서 하네스로 전파할 결정값(#892). ──
  // 기본 '["deny","ask","defer"]' = 제한적 결정만 전파. **'allow' 는 기본 제외**가 핵심: allow 는 멤버의 권한
  //  프롬프트(동의 UI)를 건너뛰므로, 관리자 훅이 조용히 그걸 없애는 걸 기본값으로 두지 않는다. 넓히려면 명시 opt-in.
  //  (관리자는 이미 멤버 머신에서 임의 코드를 실행할 수 있어 기술적 새 권한은 아니지만, 동의 표면은 별개 문제다.)
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS hook_relay_decisions JSONB NOT NULL DEFAULT '["deny","ask","defer"]'::jsonb;
  `);

  // ── org_runtime_config 확장: session_share — 세션이력 캡처 정책(#905 C1). 관리탭 ▸ 세션 공유 에서 조절. ──
  //  기본 '{}' → resolveSessionShare 가 기본값(enabled=false)으로 접는다. **켜기 전엔 아무 세션도 캡처 안 함**(롤아웃 안전).
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS session_share JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: hook_grace_ms — 커스텀 훅 런너(run-custom)가 게이트웨이 미도달 시 최근 성공 캐시를
  //  얼마나 오래 쓸지(ms). **NULL = 무제한**(마지막 접속 기준 영구 실행 — #1008 기본). 양수 = 그 ms 경과 후 fail-CLOSED.
  //  종전엔 런너에 10분이 하드코딩돼 오프라인 10분 후 로컬-자족 커스텀 훅(스킬 라우터·spec-blind 품질게이트)까지 죽었다.
  //  이 컬럼을 관리탭 노브로 승격 — 기본을 무제한으로 둬 오프라인에도 마지막 설정대로 돌게 한다. content_hash 무결성
  //  검증은 캐시에도 적용되므로 무제한이어도 변조 훅 실행 위험은 없고, 회수의 실질(재접속 시 캐시 교체)은 그대로다.
  //  DEFAULT NULL 이라 기존/신규 조직 전부 마이그레이션만으로 무제한이 된다. 보안상 짧은 회수창이 필요한 조직만 값을 준다.
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS hook_grace_ms BIGINT DEFAULT NULL;
  `);

  // ── org_runtime_config 확장: embedding_backfill_paused — 자동 임베딩 백필 스윕 일시중지(#1060). ──
  //  자동 백필(부팅 30초·10분 주기·connector_sync 완료 후·쓰기 nudge)은 느린/CPU 임베딩 백엔드에서 게이트웨이 성능을
  //  갉아먹을 수 있는데 종전엔 멈출 창구가 없었다. 이 플래그가 true 면 runAutoBackfillSweep 이 즉시 return(4개 트리거 전부
  //  차단) + 실행 중 잡은 shouldStop 으로 협조적 중단. **DB 영속** — 재시작에도 유지되어 부팅 스윕이 이 상태를 존중한다
  //  (성능 때문에 껐는데 재부팅으로 되살아나면 안 된다). 기본 false=평소대로 자동 백필. 관리탭 ▸ 의미 검색 에서 사람이 토글.
  await itemsPool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS embedding_backfill_paused BOOLEAN NOT NULL DEFAULT false;
  `);

  // ── org_hook 확장: health — 멤버별 마지막 훅 실행 실패 기록(#892 결함 C). ──
  // { "<member_id>": { at, reason, exit_code, stderr } } — 멤버 수로 자연히 유계라 별도 테이블·정리 불요.
  // 종전엔 훅이 죽어도 러너가 크래시를 삼켜(stdout "") '죽음'과 '결정 없음'이 구분 불가였고, 그래서 spec-blind
  //  guard/tracker 가 등록 이래 내내 죽은 걸 아무도 몰랐다. 실패했을 때만 기록되므로 정상 조직은 항상 '{}'.
  await itemsPool.query(`
    ALTER TABLE org_hook ADD COLUMN IF NOT EXISTS health JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_db_source — db_query/db_schema 가 읽는 외부 데이터소스 레지스트리(웹 관리). ──
  // 시크릿 금지: url 은 비밀번호 없는 접속문자열, 인증은 auth_mode(password|iam|mtls|vault) + auth_ref(참조: env 이름/
  //  파일경로/role/path)만. 실제 비번 등은 런타임에 참조에서 해소(src/db/sources.ts resolveConnectionString).
  //  env(DB_SOURCES_JSON) 소스와 병합되며, 여기 행은 무재시작 반영(db_query 가 매 호출 읽음 + 캐시 무효화).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_db_source(
      name TEXT PRIMARY KEY,
      driver TEXT NOT NULL DEFAULT 'postgres',
      url TEXT,
      auth_mode TEXT NOT NULL DEFAULT 'password',
      auth_ref TEXT,
      rls TEXT,
      max_rows INT,
      timeout_ms INT,
      note TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    DO $$ BEGIN
      -- #715: driver 제약 확장(postgres→postgres|mysql). 구버전 pg-only chk 가 있으면 교체(멱등).
      IF EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_driver_chk'
                   AND pg_get_constraintdef(oid) NOT ILIKE '%mysql%') THEN
        ALTER TABLE org_db_source DROP CONSTRAINT org_db_source_driver_chk;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_driver_chk') THEN
        ALTER TABLE org_db_source ADD CONSTRAINT org_db_source_driver_chk CHECK (driver IN ('postgres','mysql'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_auth_mode_chk') THEN
        ALTER TABLE org_db_source ADD CONSTRAINT org_db_source_auth_mode_chk
          CHECK (auth_mode IN ('password','iam','mtls','vault'));
      END IF;
    END $$;
  `);

  // ── org_db_source 확장: 소스별 테이블 '기본자세'(#186). 'allow'=deny-list(후방호환 — 명시 deny만 차단) /
  //  'deny'=allow-list(개인정보 컴플라이언스 — 명시 allow만 허용, 신규 테이블 자동노출 방지). 기존 소스 무변경 위해 기본 allow. ──
  await itemsPool.query(`
    ALTER TABLE org_db_source ADD COLUMN IF NOT EXISTS table_default TEXT NOT NULL DEFAULT 'allow';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_table_default_chk') THEN
        ALTER TABLE org_db_source ADD CONSTRAINT org_db_source_table_default_chk CHECK (table_default IN ('allow','deny'));
      END IF;
    END $$;
  `);

  // ── org_db_table_policy — db_query 대상 소스의 '테이블별 조회 허용/차단'(웹 관리, #186). ──
  //  라이브 스키마(information_schema) 위 오버레이 — 스키마 사본은 저장 안 함(쉬프트 드리프트 원천 없음), 여기엔 정책(on/off)만.
  //  effective(t) = 정책행 있으면 그 mode, 없으면 org_db_source.table_default. 쉬프트로 사라진 테이블 행 = 무해한 고아(무시).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_db_table_policy(
      source TEXT NOT NULL,
      table_name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'deny',
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (source, table_name));
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_table_policy'::regclass AND conname='org_db_table_policy_mode_chk') THEN
        ALTER TABLE org_db_table_policy ADD CONSTRAINT org_db_table_policy_mode_chk CHECK (mode IN ('allow','deny'));
      END IF;
    END $$;
  `);

  // ── org_db_column_mask — 개인정보 컬럼 마스킹 정책(웹 관리, 컴플라이언스, #186). 라이브 스키마 위 오버레이. ──
  //  집행은 게이트웨이가 결정론적으로(고객 DB 무수정): 게이트1(AST 파생차단)+게이트2(출처기반 결과 마스킹, src/db/firewall.ts·tools/db.ts).
  //  style: full(전체) | partial(부분) | email(로컬부) | hash(sha256) | null(널).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_db_column_mask(
      source TEXT NOT NULL,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT 'full',
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (source, table_name, column_name));
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_column_mask'::regclass AND conname='org_db_column_mask_style_chk') THEN
        ALTER TABLE org_db_column_mask ADD CONSTRAINT org_db_column_mask_style_chk CHECK (style IN ('full','partial','email','hash','null'));
      END IF;
    END $$;
  `);

  // ── org_db_subject_key — db 접근 감사(P5, #746)의 '조회 대상 식별자' 컬럼 지정(웹/REST 관리). ──
  //  관리자가 소스별로 '이 컬럼 값 = 조회 대상의 서로게이트 키(고객ID 등)'를 지정하면, db_query 가 그 컬럼의
  //  반환값을 db_access_log.subject_keys 에 상한부 수집한다(신용정보법 R8 '누구의 정보를 조회했나').
  //  ⚠ 운영 규약: 민감 원값 컬럼(주민번호·계좌 등)은 지정 금지 — 감사로그가 PII 저장소가 되면 안 된다.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_db_subject_key(
      source TEXT NOT NULL,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      PRIMARY KEY (source, table_name, column_name));
  `);

  // ── org_db_unmask_grant — raw-PII 언마스크 권한(P4, #746). 직무 RBAC + JIT(만료) + maker-checker(승인자 기록). ──
  //  기본은 전원 마스킹(#186/#705). 이 grant 를 받은 멤버만 지정 (source, table, column) 을 raw 로 조회한다.
  //  column='*' = 그 테이블의 모든 마스킹 컬럼 언마스크(편의). effective = revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()).
  //  집행: db_query 가 요청 userId 의 유효 grant 를 해소해 그 컬럼을 마스킹 대상에서 per-user 차감(Gate1/Gate2 자동 정합).
  //  언마스크 조회는 db_access_log 에 unmasked_columns·grant_ids 로 구분 기록(P5). FK 없음(정책 오버레이 — 소스 연결 전 사전작성 가능).
  //  ⚠ expires_at NULL(무기한)은 지양 — JIT 원칙상 기간 제한 권장. approved_by ≠ member_id 권장(maker-checker).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_db_unmask_grant(
      id BIGSERIAL PRIMARY KEY,
      member_id TEXT NOT NULL,
      source TEXT NOT NULL,
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL DEFAULT '*',
      reason TEXT,
      approved_by TEXT,
      granted_by TEXT,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      revoked_by TEXT);
    CREATE INDEX IF NOT EXISTS org_db_unmask_grant_lookup_idx
      ON org_db_unmask_grant(member_id, source) WHERE revoked_at IS NULL;
  `);

  // ── db_access_log — 데이터 접근 감사(P5, #746). append-only + 해시체인(위변조 증거). ──
  //  db_query(성공·차단·실패)와 db_schema 접근을 전건 기록한다. 기록 실패 시 db_query 는 fail-closed
  //  (결과 미반환 — 비상 우회 env DB_AUDIT_FAIL_OPEN=1). 쓰기 단일 진입점 = src/db/access-log.ts(advisory lock 으로 체인 선형화).
  //  row_hash = sha256(canonical([prev_hash, at, user_id, …])) — UPDATE/DELETE/TRUNCATE 는 트리거로 차단하되,
  //  진짜 방어는 체인(db_audit_verify 가 재계산 검증 — 슈퍼유저가 행을 고치면 이후 전 행이 깨진다).
  //  sql 은 리터럴 스크럽본(#705, PII 미잔존). subject_keys 는 org_db_subject_key 지정 컬럼의 반환값 상한부 수집.
  //  unmasked_columns/grant_ids 는 P4(언마스크 게이트) 예약 — v1 에선 항상 []/null.
  //  보존정책: v1 무제한(컴플라이언스 기록 — prune 하지 않는다). 성장 시 파티셔닝/아카이브를 별도 설계.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS db_access_log(
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL,
      user_id TEXT NOT NULL,
      token_hash_prefix TEXT,
      harness TEXT,
      op TEXT NOT NULL DEFAULT 'query',
      source TEXT NOT NULL,
      sql TEXT,
      tables JSONB NOT NULL DEFAULT '[]'::jsonb,
      masked_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
      unmasked_columns JSONB NOT NULL DEFAULT '[]'::jsonb,
      grant_ids JSONB,
      subject_keys JSONB,
      row_count INT NOT NULL DEFAULT 0,
      duration_ms INT,
      ok BOOLEAN NOT NULL,
      error TEXT,
      prev_hash TEXT NOT NULL,
      row_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS db_access_log_at_idx ON db_access_log(at DESC);
    CREATE INDEX IF NOT EXISTS db_access_log_user_at_idx ON db_access_log(user_id, at DESC);
    CREATE INDEX IF NOT EXISTS db_access_log_source_at_idx ON db_access_log(source, at DESC);
    CREATE INDEX IF NOT EXISTS db_access_log_tables_gin ON db_access_log USING GIN (tables);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='db_access_log'::regclass AND conname='db_access_log_op_chk') THEN
        ALTER TABLE db_access_log ADD CONSTRAINT db_access_log_op_chk CHECK (op IN ('query','schema'));
      END IF;
    END $$;
    CREATE OR REPLACE FUNCTION db_access_log_block_mutation() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'db_access_log is append-only (P5 감사 — 수정/삭제 불가)'; RETURN NULL; END
    $fn$ LANGUAGE plpgsql;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='db_access_log_immutable' AND tgrelid='db_access_log'::regclass) THEN
        CREATE TRIGGER db_access_log_immutable BEFORE UPDATE OR DELETE ON db_access_log
          FOR EACH ROW EXECUTE FUNCTION db_access_log_block_mutation();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='db_access_log_no_truncate' AND tgrelid='db_access_log'::regclass) THEN
        CREATE TRIGGER db_access_log_no_truncate BEFORE TRUNCATE ON db_access_log
          FOR EACH STATEMENT EXECUTE FUNCTION db_access_log_block_mutation();
      END IF;
    END $$;
  `);

  // ── org_cron — 서버사이드 스케줄 잡(웹 관리). is 신선화·커넥터 sync 등을 게이트웨이 프로세스가 주기 실행. ──
  //  트리거 표준화: git push 웹훅(도달성+repo당 등록 필요)을 대체 — 게이트웨이가 바깥으로 fetch 하므로 직원 0·repo셋업 0.
  //  보안: action 은 allowlist enum(임의 셸 금지 — org_hook 은 멤버 머신, 이건 게이트웨이 권한이라 블래스트 반경↑).
  //  params = 액션 인자(예: {repo} / {system}). interval_sec = 폴 주기(최소 60 앱 강제). 단일 프로세스 전제(리더선출 불요).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_cron(
      id TEXT PRIMARY KEY,
      label TEXT,
      action TEXT NOT NULL,
      params JSONB NOT NULL DEFAULT '{}'::jsonb,
      interval_sec INT NOT NULL DEFAULT 600,
      cron_expr TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      last_run_at TIMESTAMPTZ,
      last_status TEXT,
      last_summary JSONB,
      next_run_at TIMESTAMPTZ,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    DO $$ BEGIN
      -- action allowlist — 확장 시 DROP+ADD(IF NOT EXISTS 만으론 라이브 제약이 안 바뀜).
      ALTER TABLE org_cron DROP CONSTRAINT IF EXISTS org_cron_action_chk;
      ALTER TABLE org_cron ADD CONSTRAINT org_cron_action_chk
        CHECK (action IN ('refresh_all','refresh_repo','refresh_bases','connector_sync','connector_push','wiki_push','eval_domain_debt','map_unmapped','map_unmapped_headless','classify_knowledge','classify_knowledge_headless','bootstrap_is','distill_sources','agent_inject','agent_headless','ensure_managed_sessions','wikilink_sweep','preview_reconcile'));
    END $$;
    -- cron_expr(절대 벽시계 스케줄, 5필드). NULL=interval_sec 상대 모드. 기존 테이블 비파괴 추가.
    ALTER TABLE org_cron ADD COLUMN IF NOT EXISTS cron_expr TEXT;
    -- run_once = 1회 실행 후 자동 비활성(반복 안 함). 부트스트랩 등 일회성 잡용. 비파괴 추가.
    ALTER TABLE org_cron ADD COLUMN IF NOT EXISTS run_once BOOLEAN NOT NULL DEFAULT false;
  `);
  // 기본 잡 시드(최초 1회만 — 운영자 변경 보존).
  //  refresh_all: 커밋→is 자동 반영(결정적, LLM 없음). map_unmapped: 미매핑→도메인 LLM 분류(라이블리 시드 에이전트) — 토큰 설정 전이라 기본 OFF.
  await itemsPool.query(`
    INSERT INTO org_cron(id, label, action, interval_sec, enabled, note) VALUES
      ('refresh-all-domainmap','도메인맵 is 신선화 (전 repo)','refresh_all',600,true,
       'last_refreshed_sha→origin/HEAD 증분 diff 를 결정적 refresh 엔진에 먹인다(LLM 없음). 멱등.'),
      ('refresh-provision-bases','작업 base 레포 확보·최신화 (워크트리 원본)','refresh_bases',1800,true,
       '관리탭 등록 레포를 이 호스트 workspace/repos 에 없으면 clone·있으면 FF — 워크트리 셀프서비스(lively_local_repo_worktree)의 최신 원본을 무인 보장. 도메인맵 스캐너 클론(refresh_all, stateDir/repos)과 대상이 다르다.'),
      ('map-unmapped-domains','미매핑 코드유닛 LLM 분류 (상시 세션 주입)','map_unmapped',1800,false,
       '상시 LLM 세션(라이블리 시드, 팀플랜 과금)에 분류 태스크를 tmux send-keys 로 주입 → 세션이 도메인 should+DDD 로 분류(propose+근거→audit). 활성화 전 params.session 에 타깃 세션 id 설정 필요 → 기본 enabled=false.'),
      ('classify-unmapped-knowledge','미분류 지식 LLM 분류 (상시 세션 주입, #982)','classify_knowledge',3600,false,
       'map_unmapped 의 지식판 — 카테고리 0건 지식(노션 미러 등 인입분)을 상시 세션에 주입해 카테고리(사업·제품·시스템 전체)로 분류(propose+근거→proposed). 미분류=recall INNER JOIN 에서 소환 불가라 편입의 핵심. 활성화 전 params.session 설정 필요 → 기본 enabled=false.'),
      ('keepalive-managed-sessions','상시 세션 keep-alive','ensure_managed_sessions',120,true,
       'enabled 상시 세션(org_managed_session)의 tmux 세션을 보장 — 죽었으면 격리 워크스페이스에 재생성. 등록된 상시 세션 없으면 no-op.')
    ON CONFLICT (id) DO NOTHING;
  `);
  // #177 아웃바운드 푸시 잡 — external_outbox(우리 편집)→ClickUp. 우리 DB=master 반영. params.system='clickup'(run-push 는 clickup 전용).
  //  검증 전이라 기본 enabled=false — 수동 run-push 1회 확인 후 관리탭/DB 로 활성화. 별도 INSERT(params 컬럼 포함).
  await itemsPool.query(`
    INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, note) VALUES
      ('push-clickup','ClickUp 아웃바운드 푸시 (우리 편집→ClickUp)','connector_push','{"system":"clickup"}'::jsonb,120,false,
       'external_outbox(pending) 드레인 → ClickUp create/update/delete. 로컬 편집을 미러에 반영(멱등, 부모 미푸시면 다음 틱 수렴). 검증 후 enabled=true.'),
      ('push-wiki-notion','위키 아웃바운드 푸시 (산출 지식→노션 피드, #976)','wiki_push','{}'::jsonb,600,false,
       '등록 노션 feed_target(category_feed N:M 매핑)으로 정본·authored 지식을 피드 카드로 투영. 옵트인: 매핑 없으면 무동작. 멱등(content_hash skip). 피드 DB 부트스트랩+exclude_pages 등록·라이브 E2E 검증 후 enabled=true.')
    ON CONFLICT (id) DO NOTHING;
  `);
  // #177 #6d 인바운드 싱크 잡 — ClickUp→우리, external_base 3-way 머지(name/desc/status_category). 충돌=우리 DB master.
  //  검증 전 기본 enabled=false. 아웃바운드(push-clickup)와 함께 가동하면 <5분 양방향 항상 싱크.
  await itemsPool.query(`
    INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, note) VALUES
      ('sync-clickup','ClickUp 인바운드 싱크 (ClickUp→우리, 3-way 머지)','connector_sync','{"system":"clickup"}'::jsonb,240,false,
       'run-sync clickup — 컨테이너 Task 당겨 external_base 3-way 머지(theirs==base→ours, ours==base→theirs, 충돌→ours). 검증 후 enabled=true.')
    ON CONFLICT (id) DO NOTHING;
  `);

  // ── org_managed_session — 상시 에이전트 세션의 desired state(관리탭 CRUD). keep-alive(ensure_managed_sessions 크론)가 ──
  //  실제 tmux box-* 세션을 보장(없으면 재생성). account = 어떤 라이블리 계정/프로필(=클로드 로그인)으로 띄울지 —
  //  지금 맥미니 단일 프로필, 멀티프로필 대비 필드. session_id = 현재 살아있는 tmux 세션(provision 시 기록).
  //  격리 워크스페이스(공유폴더 managed/<id>)·하네스·플래그·자동승인은 프로젝트 터미널 생성(createSession) 그대로 재사용.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_managed_session(
      id TEXT PRIMARY KEY,
      label TEXT,
      account TEXT,
      workspace_subpath TEXT,
      harness TEXT NOT NULL DEFAULT 'claude',
      flags JSONB NOT NULL DEFAULT '{}'::jsonb,
      auto_approve BOOLEAN NOT NULL DEFAULT true,
      enabled BOOLEAN NOT NULL DEFAULT true,
      session_id TEXT,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);

  // ── org_session_state — 웹터미널 세션의 desired-state DB 미러(#1059 E). ──
  //  왜(#1059): 세션 메타(owner·label·harness·dir·flags·invites·project·mode)의 SoT 는 tmux @box_* user-option 인데
  //   **재부팅 = tmux 서버 사망 = 그 메타 전부 증발** → 어떤 세션이 있었는지조차 알 수 없어 복원 진입점이 사라진다.
  //   이 테이블이 그 desired-state 를 DB 에 미러해, 재부팅 후에도 세션이 '복원 가능(restorable)' 목록으로 살아남고,
  //   사용자가 '열 때' lazy 하게 createSession(resume=<id>)로 재생성된다(부팅 시 전부 자동 spawn 은 OOM 재현이라 금물).
  //  ⚠ **미러지 SoT 아님**(storage_policy 교리와 달리 여긴 tmux 가 SoT): tmux 가 살아있으면 tmux 가 진실,
  //   DB 는 재부팅 백업 + F(reaper)의 desired-state 보존처. listSessions 병합이 tmux 우선(라이브)·DB 폴백(offline).
  //  root_key/subpath = 재생성 좌표(createSession 입력). last_busy = F(reaper)의 idle 판정 기준(@box_last_busy 미러).
  //  last_seen = 마지막으로 라이브(tmux)로 관측된 시각 — 오래 안 보이면 stale 정리 후보(도그푸드; 지금은 조회만).
  //  managed 세션(org_managed_session)은 여기 넣지 않는다 — keep-alive 가 그 영속을 소유하므로(createSession managed 플래그가 upsert skip).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_session_state(
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      label TEXT,
      harness TEXT NOT NULL DEFAULT 'claude',
      dir TEXT,
      root_key TEXT,
      subpath TEXT,
      flags JSONB NOT NULL DEFAULT '{}'::jsonb,
      auto_approve BOOLEAN NOT NULL DEFAULT false,
      invites JSONB NOT NULL DEFAULT '[]'::jsonb,
      project_id INT,
      project_src TEXT,
      read_only BOOLEAN NOT NULL DEFAULT false,
      incognito BOOLEAN NOT NULL DEFAULT false,
      created BIGINT,
      last_busy BIGINT,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  // owner 로 자주 조회(복원 목록 = 이 사용자의 tmux 에 없는 레코드) — 인덱스로 스캔 회피.
  await itemsPool.query(`CREATE INDEX IF NOT EXISTS org_session_state_owner_idx ON org_session_state(owner);`);
  // #1059 정밀 복원 — 이 box 세션이 **현재 도는 claude 자신의 세션 UUID**(box-id ≠ claude UUID). work-flag 훅이 세션
  //  활동 시 (box-id, claude session_id)를 보고해 last-write-wins 로 갱신(한 box 안에서 branch·resume·/clear 로 UUID 가
  //  바뀔 수 있으므로 최신만 유지). 복원 시 이 값으로 `claude --resume <uuid>` 정밀 이어받기. null=미상(셸·코덱스·미보고)→picker 폴백.
  await itemsPool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS claude_session_id TEXT;`);
  // #1059 — **사용자 정상 종료** 표시(exited_at). claude SessionEnd 훅이 reason=prompt_input_exit(/exit·Ctrl-D)·logout
  //  일 때 보고 → 이 box 가 tmux 에서 사라진 뒤 복원목록에서 '종료됨(대화 이어보기)'으로 뜬다. NULL 이면(재부팅·강제kill·
  //  reaper 회수 — 훅이 프로세스 사망으로 못 뜸) '복원 가능(중단됨)'. exit_reason 은 진단용(어떤 사유였나).
  await itemsPool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS exited_at TIMESTAMPTZ;`);
  await itemsPool.query(`ALTER TABLE org_session_state ADD COLUMN IF NOT EXISTS exit_reason TEXT;`);

  // ── org_preview_env — 프리뷰 환경(작업자별 격리 미리보기)의 desired state (#1036). 관리탭 CRUD. ──
  //  kind=work: 작업 워크트리(project/<id>)를 게이트웨이가 /preview/<id>/ 서브패스로 정적 서빙(shared-proxy — /api 는 게이트웨이 자신).
  //   프론트가 API 를 root-relative(/api/ui)로 부르므로 페이지가 서브패스에서 로드돼도 진짜 API 로 간다 → 별도 프로세스·포트·프록시 불필요.
  //  worktree_path = 서빙할 워크트리 절대경로(비우면 project_id+repo 로 canonical 슬롯 workspace/project/<id>/<repo> 계산).
  //  kind=stage(2단계): 여러 브랜치를 base 위에 merge 한 통합 워크트리. backing_mode·backing_ref 는 3단계(throwaway·existing-ref) 확장 대비.
  //  포트·pid 컬럼은 3단계에서 별도 백엔드 프로세스를 띄울 때 ALTER ADD(shared-proxy 는 불요). §설계 preview-environment-design-1036.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_preview_env(
      id TEXT PRIMARY KEY,
      label TEXT,
      kind TEXT NOT NULL DEFAULT 'work',
      owner_member TEXT,
      project_id INT,
      repo TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      backing_mode TEXT NOT NULL DEFAULT 'shared-proxy',
      backing_ref TEXT,
      status TEXT NOT NULL DEFAULT 'stopped',
      last_error TEXT,
      last_active_at TIMESTAMPTZ,
      ttl_idle_sec INT NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT true,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);
  // #1036 2단계 stage 통합 — 여러 작업 브랜치를 base 위에 merge 한 통합 워크트리. 기존 org_preview_env 에 비파괴 추가.
  //  member_branches = 통합할 브랜치 목록(project/<id> 등). base_ref = merge base(비면 origin/main). merge_trigger = auto(reconcile 재-merge)|manual.
  //  merge_status = 브랜치별 결과(merged|conflict|missing|invalid) — 충돌 표면화.
  await itemsPool.query(`
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS member_branches JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS base_ref TEXT;
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS merge_trigger TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS merge_status JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS port INT;          -- throwaway: 할당된 백엔드 포트
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS pid INT;           -- throwaway: 백엔드 프로세스 PID
    ALTER TABLE org_preview_env ADD COLUMN IF NOT EXISTS stack_profile TEXT; -- 어떻게 띄우나(org_stack_profile.id) — throwaway 필수
  `);
  // #1036 3단계 — org_stack_profile: '어떻게 띄우나'(start_cmd·포트env·env·헬스체크)를 데이터로. throwaway backing 프로세스가 참조.
  //  비개발자는 프리셋을 드롭다운으로 고르기만(제로 입력 회피). Heroku Procfile / devcontainer.json / .gitpod.yml 모델.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_stack_profile(
      id TEXT PRIMARY KEY,
      label TEXT,
      repo TEXT,
      static_only BOOLEAN NOT NULL DEFAULT false,
      start_cmd TEXT,
      port_env TEXT NOT NULL DEFAULT 'PORT',
      env_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      healthcheck_path TEXT,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);
  // build_cmd — 미리보기를 띄우기 전에 워크트리에서 실행할 빌드(예: 프론트 번들). 사람이 터미널을 안 열어도 되게 하는 핵심.
  await itemsPool.query(`ALTER TABLE org_stack_profile ADD COLUMN IF NOT EXISTS build_cmd TEXT;`);
  await itemsPool.query(`
    INSERT INTO org_stack_profile(id,label,repo,static_only,start_cmd,build_cmd,port_env,env_json,healthcheck_path,note) VALUES
      ('co-frontend','context-ontology 프론트 (정적·shared-proxy)','context-ontology',true,NULL,'npm run build:web','PORT','{}'::jsonb,'/',
       '프론트(public/)만 서빙 — /api 는 게이트웨이 자신. 별도 프로세스·포트 없음(가장 싸고 안전).'),
      ('co-fullstack','context-ontology 풀스택 (throwaway 게이트웨이)','context-ontology',false,'node dist/index.js','npm run build','PORT','{"LIVELY_NO_SCHEDULER":"1"}'::jsonb,'/healthz',
       '자체 게이트웨이 프로세스를 워크트리에서 기동 — 백엔드 변경까지 격리 확인. DB 등 backing 은 env 로 지정(라이브 DB 쓰기 금지).')
    ON CONFLICT (id) DO NOTHING;
  `);
  // 기존 프리셋 보정 — 위 INSERT 는 ON CONFLICT DO NOTHING 이라 이미 있던 행엔 build_cmd 가 안 들어간다.
  //  운영자가 직접 채운 값은 건드리지 않는다(IS NULL 조건).
  await itemsPool.query(`
    UPDATE org_stack_profile SET build_cmd='npm run build:web' WHERE id='co-frontend' AND build_cmd IS NULL;
    UPDATE org_stack_profile SET build_cmd='npm run build'     WHERE id='co-fullstack' AND build_cmd IS NULL;
  `);

  // ── org_node — 분산 노드 레지스트리(#869). 멤버 PC(member)/워커(worker)에 도는 노드 에이전트의 desired state. ──
  //  연결은 항상 노드→게이트웨이 아웃바운드 WSS(/node/ws) — 노드는 포트를 열지 않는다(단일 정문 유지).
  //  token_hash = 이 노드 전용 auth_token(scopes=[] — REST/MCP 표면 접근 불가, 노드 채널 전용)의 해시.
  //   재발급 시 교체(구 토큰 revoke). 인증 = org_node⋈auth_token(revoked_at IS NULL)⋈org_member(active) — 멤버
  //   비활성/토큰 회수/노드 비활성 어느 하나로도 즉시 차단. platform/agent_ver/host/last_seen 은 hello 시 갱신(관측 필드).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_node(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member','worker')),
      owner_member TEXT NOT NULL,
      token_hash TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      platform TEXT,
      agent_ver TEXT,
      -- 노드가 hello 로 선언한 op 목록(#905 C4). 오프라인 노드의 능력도 관리탭에서 보이게 저장한다.
      --  NULL = 아직 선언한 적 없음(구 에이전트) → 코드가 v1 기준선으로 해석(protocol.nodeCaps).
      agent_caps TEXT[],
      host TEXT,
      last_seen TIMESTAMPTZ,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  
    -- 기존 테이블에도 붙인다(#905 C4) — CREATE TABLE IF NOT EXISTS 는 이미 있는 테이블을 안 고친다.
    ALTER TABLE org_node ADD COLUMN IF NOT EXISTS agent_caps TEXT[];
  `);

  // ── org_task — 위탁 태스크(P2 #869). 의뢰자가 delegate_run 으로 넣고, 태스크 스케줄러가 리소스-적합 노드에 ──
  //  배치(§10: 예상 소모량 vs 노드 상시 리소스 push). 노드 사망 시 grace 후 재큐(attempt<max) 또는 실패+알림.
  //  결과 전문은 워크스페이스 .lively-task/<id>/ 에, 여기엔 요약(result jsonb)만.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_task(
      id BIGSERIAL PRIMARY KEY,
      requester TEXT NOT NULL,
      requester_session TEXT,
      prompt TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'claude',
      subpath TEXT NOT NULL DEFAULT '',
      repo TEXT,
      git_ref TEXT,
      flags JSONB NOT NULL DEFAULT '{}'::jsonb,
      need_cpu REAL,
      need_ram_mb INT,
      need_disk_mb INT,
      needs_docker BOOLEAN NOT NULL DEFAULT false,
      node_pref TEXT,
      env_lease BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','canceled')),
      node_id TEXT,
      session_id TEXT,
      task_dir TEXT,
      attempt INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 2,
      timeout_sec INT NOT NULL DEFAULT 3600,
      node_lost_at TIMESTAMPTZ,
      result JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  // 레포 자동 provision(#869 P2 후속) — 기존 org_task 테이블에도 소급(CREATE IF NOT EXISTS 는 컬럼 추가 안 함).
  await itemsPool.query(`ALTER TABLE org_task ADD COLUMN IF NOT EXISTS repo TEXT`);
  await itemsPool.query(`ALTER TABLE org_task ADD COLUMN IF NOT EXISTS git_ref TEXT`);

  // ── org_ingest_policy — 지식 인입 허용선 정책(#638, #783 확장). 오너가 관리탭에서 조절하는 자동화 게이트. ──
  //  매치 규칙 0개면 디폴트 auto(현행 무변 — 오너가 켠 만큼만 gate). 평가 = resolveIngestPolicy(src/org/ingest-policy.ts).
  //  적용 경로: mirror(observed·신규만) + knowledge_save(에이전트 MCP·사람 웹·distill — 신규/수정 양축).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_ingest_policy(
      id BIGSERIAL PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT true,
      match_category   TEXT,
      match_system     TEXT,
      match_channel    TEXT,
      match_provenance TEXT,
      match_sensitive  TEXT,
      action TEXT NOT NULL DEFAULT 'confirm',
      priority INT NOT NULL DEFAULT 0,
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_ingest_policy'::regclass AND conname='org_ingest_policy_action_chk') THEN
        ALTER TABLE org_ingest_policy ADD CONSTRAINT org_ingest_policy_action_chk CHECK (action IN ('auto','confirm','drop'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_ingest_policy'::regclass AND conname='org_ingest_policy_provenance_chk') THEN
        ALTER TABLE org_ingest_policy ADD CONSTRAINT org_ingest_policy_provenance_chk
          CHECK (match_provenance IS NULL OR match_provenance IN ('authored','observed'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS org_ingest_policy_enabled_idx ON org_ingest_policy(enabled);
  `);

  // ── #783 정책 축·액션 확장 — 멱등 가산(구 행은 NULL/기본값 = 현행 동작 그대로). ──
  //  · match_actor_kind = 누가 썼나(ai=MCP 에이전트 | human=웹 사람). 서버가 채널로 판정(db/write.ts actorKindOf) — 자기보고 아님.
  //  · match_agent      = 하네스 id(claude-code|codex|openclaw…) — 접속 신원(org/agent-identity.ts). 자율 실행만 좁혀 게이트 가능.
  //  · match_type       = page-type(decision|concept|how-to|reference|research|entity) — 예: 런북(how-to)만 사람 승인.
  //  · action_update    = 기존 지식 '수정' 시 동작(auto|review|stage|drop). NULL/auto = 수정 게이트 없음(구 규칙 무변).
  //      review=반영하되 diff 를 검토 큐에 적재(사후검토) · stage=본문 미반영, 승인해야 반영(리비전 제안) · drop=수정 거부.
  //      신규(action)와 분리한 이유: 에이전트 쓰기의 상당수가 '기존 지식 갱신'이라 신규만 막으면 게이트가 샌다.
  //  · is_exception     = 예외(carve-out) — 매치되면 보수적 누적을 건너뛰고 이 규칙이 확정("전부 검토하되 이 도메인만 통과").
  //  · preset           = 관리탭 프리셋 스위치가 관리하는 규칙 표식('agent-knowledge') — 사람이 만든 세부 규칙과 구분.
  await itemsPool.query(`
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS match_actor_kind TEXT;
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS match_agent      TEXT;
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS match_type       TEXT;
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS action_update    TEXT NOT NULL DEFAULT 'auto';
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS is_exception     BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS preset           TEXT;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_ingest_policy'::regclass AND conname='org_ingest_policy_actor_kind_chk') THEN
        ALTER TABLE org_ingest_policy ADD CONSTRAINT org_ingest_policy_actor_kind_chk
          CHECK (match_actor_kind IS NULL OR match_actor_kind IN ('ai','human'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_ingest_policy'::regclass AND conname='org_ingest_policy_action_update_chk') THEN
        ALTER TABLE org_ingest_policy ADD CONSTRAINT org_ingest_policy_action_update_chk
          CHECK (action_update IN ('auto','review','stage','drop'));
      END IF;
    END $$;
    -- 프리셋 규칙은 종류당 1행(관리탭 스위치가 upsert 로 관리 — 중복 생성 방지).
    CREATE UNIQUE INDEX IF NOT EXISTS org_ingest_policy_preset_uq ON org_ingest_policy(preset) WHERE preset IS NOT NULL;
  `);

  // 멤버 상태메시지 — 본인이 설정해 프로필 밑에 공유하는 '현재 상태'(프로젝트 팀원 프로필 그리드).
  await itemsPool.query(`ALTER TABLE org_member ADD COLUMN IF NOT EXISTS status_message TEXT;`);

  // ── project_member — 프로젝트 팀원(n:n). project(v6).id 참조 — v6/schema 가 FK 를 project 로 ALTER한다. ──
  //  레거시 org_project 는 폐기(2026-06-24, projects2/v6 통합 — 고아 v1 제거 + 테이블 DROP). project_member 는 v6 소유로 잔존.
  await itemsPool.query(`
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
  await itemsPool.query(`
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
  await itemsPool.query(`
    ALTER TABLE org_content_audit ADD COLUMN IF NOT EXISTS actor_kind TEXT;
    ALTER TABLE org_content_audit ADD COLUMN IF NOT EXISTS channel    TEXT;
  `);
  await itemsPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_content_audit'::regclass AND conname='org_content_audit_actor_kind_chk') THEN
        ALTER TABLE org_content_audit ADD CONSTRAINT org_content_audit_actor_kind_chk
          CHECK (actor_kind IS NULL OR actor_kind IN ('human','ai','connector','system','unknown'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_content_audit'::regclass AND conname='org_content_audit_channel_chk') THEN
        ALTER TABLE org_content_audit ADD CONSTRAINT org_content_audit_channel_chk
          CHECK (channel IS NULL OR channel IN ('mcp','web','connector','cli','migration','unknown'));
      END IF;
    END $$;
  `);

  // ════════ 지식유형/수집 ground-truth(데이터층) — kind_registry + data_source ════════
  // v6 컷오버(2026-06-24): 지식 본체는 v6 knowledge 테이블(src/v6/schema.ts)이 캐노니컬 — 구 knowledge_unit 통합스토어는 드랍됨.
  //  이 섹션은 #/learn ground-truth 용 별도 메타 테이블 2종(kind_registry=지식종류 정의, data_source=소스별 수집방식)만 시드한다.

  // ── kind_registry — 지식 종류 분류 + 주입 정책 메타. 12 kind 시드(아래). ──
  // injection_mode = 멤버 컨텍스트에 어떻게 노출되는가(enforced/always/recalled/manual/query/digest).
  //  domain_scoped = domainmap 도메인 귀속을 갖는 종류인지. cardinality = 한 종류당 한 단위(one)인지 다수(many)인지.
  // P-V3-2(D-GT): description 외에 **분류기준(criteria)·저장방식(storage)·전달방식(delivery)** 을 ground-truth 로
  //  채운다(비파괴 ADD COLUMN, 멱등). 런북(LLM)·웹(#/learn, 비개발자)이 여기서 렌더 → non-stale 단일 출처.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS kind_registry(
      kind TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      injection_mode TEXT NOT NULL DEFAULT 'manual',
      audience TEXT,
      cardinality TEXT NOT NULL DEFAULT 'many',
      domain_scoped BOOLEAN NOT NULL DEFAULT false,
      description TEXT NOT NULL DEFAULT '',
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    -- P-V3-2: 분류기준/저장방식/전달방식(ground-truth 확장, 비파괴·멱등). description 과 함께 런북·웹이 렌더.
    ALTER TABLE kind_registry ADD COLUMN IF NOT EXISTS criteria TEXT NOT NULL DEFAULT '';
    ALTER TABLE kind_registry ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT '';
    ALTER TABLE kind_registry ADD COLUMN IF NOT EXISTS delivery TEXT NOT NULL DEFAULT '';
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='kind_registry'::regclass AND conname='kind_registry_mode_chk') THEN
        ALTER TABLE kind_registry ADD CONSTRAINT kind_registry_mode_chk
          CHECK (injection_mode IN ('enforced','always','recalled','manual','query','digest'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='kind_registry'::regclass AND conname='kind_registry_card_chk') THEN
        ALTER TABLE kind_registry ADD CONSTRAINT kind_registry_card_chk CHECK (cardinality IN ('one','many'));
      END IF;
    END $$;
  `);

  // ── data_source — 소스별 수집방식 레지스트리(ground-truth). 어떤 외부 시스템에서 무엇이 어떻게 수집되어 ──
  //  v6 knowledge 의 어느 kind 로 적재되는지를 비개발자도 읽도록 명문화. status=active(수집중) | dropped
  //  (수집중단, 커넥터 코드는 유지). collection_method = 수집 방식 설명(자유텍스트). into_kinds = 적재 kind 목록.
  //  시크릿 금지(토큰/URL 없음 — 시스템명·라벨·설명만). 시드는 아래(discord=dropped, notion/clickup/slack=active).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS data_source(
      system TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      collection_method TEXT NOT NULL DEFAULT '',
      cadence TEXT,
      into_kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='data_source'::regclass AND conname='data_source_status_chk') THEN
        ALTER TABLE data_source ADD CONSTRAINT data_source_status_chk CHECK (status IN ('active','dropped'));
      END IF;
    END $$;
  `);

  // ── knowledge_unit 폐기(2026-06-24): v6 knowledge 컷오버 완료 — DROP. ──
  //  지식(기록)=knowledge, 섹션(규칙·페르소나)=knowledge injection='always', observed 통계=knowledge provenance='observed',
  //  도메인 active 카운트=knowledge_category 기준 집계. 임베딩(pgvector)·구 미러는 폐기.
  //  knowledge_unit_revision(뷰)·knowledge_unit_mapping_audit(구 item→domain 매핑 감사)·knowledge_unit_domain 동반 드랍.
  //  org_content_audit 의 entity='knowledge_unit' 이력행은 비파괴 보존(투영 뷰만 제거). kind_registry/data_source(별도 테이블)는 유지.
  await itemsPool.query(`DROP VIEW IF EXISTS knowledge_unit_revision`);
  await itemsPool.query(`DROP TABLE IF EXISTS knowledge_unit_mapping_audit`);
  await itemsPool.query(`DROP TABLE IF EXISTS knowledge_unit_domain`);
  await itemsPool.query(`DROP TABLE IF EXISTS knowledge_unit CASCADE`);

  // ── 고아 레거시 테이블 폐기(2026-06-24): org_content/org_memory→v6 knowledge 컷오버 완료, org_project→v6 project 대체. ──
  //  위(:25) 주석이 "폐기"라 선언했으나 실제 DROP문이 없어 DB에 잔존했다(라이브 read 0 — v6-migrate 스크립트만 참조).
  //  멱등 DROP 으로 스키마 자기정합·재빌드 안전성 확보. org_content_audit(감사 로그)는 별개라 유지.
  await itemsPool.query(`DROP TABLE IF EXISTS org_content CASCADE`);
  await itemsPool.query(`DROP TABLE IF EXISTS org_memory CASCADE`);
  await itemsPool.query(`DROP TABLE IF EXISTS org_project CASCADE`);

  // ── kind 캐노니컬 정의 시드(ground-truth) — label/injection_mode/domain_scoped/audience/sort 골격 + ──
  //  description(정의)·criteria(분류기준: 언제 이 kind 인가 + 인접 kind 구분)·storage(저장방식)·
  //  delivery(전달방식 = injection_mode 의 의미). 비개발자도 이해할 쉬운 한국어.
  //  멱등 정책: ON CONFLICT(kind) DO UPDATE — **정의 4필드(description/criteria/storage/delivery)는 코드가
  //  캐노니컬**이라 부팅 시마다 시드값으로 정렬한다. 웹 #/learn 은 읽기전용 렌더라 사용자가 정의를 편집하지
  //  않는다 → DO UPDATE 가 사람 편집을 덮을 위험 없음.
  //
  //  ⚠ V4-P2a(분류 재설계, 2026-06-18 v4 plan §1.A): 본질 kind = **R·K·H·W 4종만 시드**.
  //   - R(규칙/정책/페르소나)=강제, K(지식노트, A/D/F/M/L/Z 흡수)=회상, H(런북/절차)=회상, W(과업)=질의.
  //   - **A/D/F/G/S/M/L/Z 행은 P2a 에서 시드 제거 + 부팅 DELETE 로 정리**(데이터 흡수 *후*). 데이터 마이그
  //     (A/D/F/M/L/Z→K, S/G=domainmap federate 0행)는 scripts/v4-absorb-kinds.mjs 가 1회 수행. 이 시드+DELETE 가
  //     소스 캐노니컬이라 부팅마다 4kind 로 정렬·정리(스크립트 미실행 DB 도 시드는 4행, 데이터 흡수만 스크립트 의존).
  //   - injection_mode: R=enforced / K·H=recalled / W=query. materialize FALLBACK·web #/learn 은 라이브 registry 읽음.
  await itemsPool.query(`
    INSERT INTO kind_registry(kind, label, injection_mode, domain_scoped, audience, cardinality, sort, description, criteria, storage, delivery) VALUES
      ('R','Rule/Policy/Persona','enforced',false,'context','many',10,
        '조직이 모든 AI 세션에 강제하는 규칙·정책·페르소나. "반드시/금지" 같은 행동 규범과 AI 의 말투·역할. 4 본질 종류 중 하나(R·K·H·W).',
        '"항상/반드시/절대" 지켜야 하는 강제 규범이면 R. 한 번 일어난 사실·방법 절차(H)·배경 지식(K)과 구분: R 은 위반하면 안 되는 명령형이다. 페르소나(AI 역할·말투)도 R.',
        '항상-주입 섹션 문서(injection=always)로 저장. 본문 전체가 보존된다.',
        '강제 주입(enforced): 맥락과 무관하게 모든 세션 컨텍스트 최상단에 전문이 그대로 들어간다(R 만 항상 주입).'),
      ('K','Knowledge note','recalled',false,'memory','many',20,
        '지식 노트 — 결정의 배경, 알게 된 것, 정리한 생각, 사실, 도메인 지식, 메모·링크까지 아우르는 일반 지식. 4 본질 종류 중 가장 큰 기본값(R·K·H·W). (구 A/D/F/M/L/Z 흡수.)',
        '강제 규범(R)·절차(H)·과업(W)이 아닌 거의 모든 저작 지식은 K. 배경·맥락·사실·도메인 지식·메모·외부 링크·산출물이 다 K 로 모인다(주제는 종류가 아니라 area=domain 으로 구분, 출처는 provenance 로 구분). 애매하면 K.',
        '지식 단위로 저장(제목+본문). 본문은 전문 보존, 검색 대상. 주제 귀속은 area(domain_key, product/business)로 단다.',
        '검색 회상(recalled): 인덱스(제목·요약)에 노출, 전문은 일에 맞춰 area+검색으로 그때 소환(on-demand).'),
      ('H','How-to/Runbook','recalled',true,'memory','many',50,
        '하우투·런북 — 무엇을 어떤 순서로 하는지의 재현 가능한 절차(예: 배포 방법, 동기화 실행법). AI 워크플로 표준화의 핵심 산물. 4 본질 종류 중 하나(R·K·H·W).',
        '"이렇게 한다"는 단계별 절차면 H. 배경 지식(K)과 구분: H 는 따라 하면 결과가 재현된다. 도메인 절차여도 H(area=domain 부여 가능).',
        '지식 단위로 저장(단계 목록 본문). 주제 귀속은 area(domain_key) 부여 가능.',
        '검색 회상(recalled): 인덱스에 노출, 필요할 때 area+검색으로 전문 소환(on-demand).'),
      ('W','과업(Task)','query',false,'memory','many',90,
        '과업·태스크 — PM 도구(ClickUp 등)의 태스크/이슈. 진행 상태·담당을 가진 일. 4 본질 종류 중 하나(R·K·H·W). (과업을 향한 개별 행위·진척은 별 엔티티 작업=activity.)',
        '진행 상태(미정/진행/완료)·담당을 가진 **과업/태스크**면 W. 절차 설명은 H, 정리된 지식은 K. 수집된 외부 활동/문서는 출처(provenance=observed)로 들어온 W/K 미러다.',
        '커넥터/pm_* 가 적재(external_id·상태). 과업 단위. 과업을 향한 개별 작업(activity)은 activity_* 가 별도 기록.',
        '질의 시(query): 필요할 때 조회(과업 현황 검색).')
    ON CONFLICT (kind) DO UPDATE SET
      label=EXCLUDED.label, injection_mode=EXCLUDED.injection_mode, domain_scoped=EXCLUDED.domain_scoped,
      audience=EXCLUDED.audience, cardinality=EXCLUDED.cardinality, sort=EXCLUDED.sort,
      description=EXCLUDED.description, criteria=EXCLUDED.criteria, storage=EXCLUDED.storage, delivery=EXCLUDED.delivery,
      updated_at=now();
    -- V4-P2a: legacy kind 행 정리(흡수돼 ku 가 더는 쓰지 않음). 멱등 — 이미 없으면 no-op.
    --  A/D/F/M/L/Z=K 로 흡수, S/G=domainmap 파생(federated, ku kind 아님). 데이터 흡수가 선행돼야 안전(스크립트가 보장).
    DELETE FROM kind_registry WHERE kind IN ('A','D','F','G','S','M','L','Z');
  `);

  // ── data_source 시드(소스별 수집방식, 멱등 DO UPDATE — 정의 ground-truth). ──
  //  notion/clickup=active(KIND_MAP 정의 → 미러 적재), slack/discord=dropped(message:* 미정의 → 미러 skip, ku 0건).
  //  into_kinds 는 **실제 적재** kind 만(KIND_MAP 과 정합): clickup=[W], notion=[K], slack/discord=[](미적재).
  await itemsPool.query(`
    INSERT INTO data_source(system, label, status, collection_method, cadence, into_kinds, sort, note) VALUES
      ('clickup','ClickUp','active',
        'ClickUp 커넥터가 리스트→프로젝트로 매핑하고, 태스크를 작업 단위로 가져온다. pm_* 툴로 태스크를 직접 쓰기도 한다.',
        '주기 동기화(run-sync)', '["W"]'::jsonb, 10,
        '프로젝트 provenance=initiative 와 연결. 태스크는 W kind 로 적재.'),
      ('notion','Notion','active',
        'Notion 커넥터가 지정한 페이지/데이터베이스의 문서를 가져온다.',
        '동기화(run-sync/backfill)', '["K"]'::jsonb, 20,
        '문서 본문은 지식(K)으로 수집(V4: 산출물 A 흡수). 외부수집은 provenance=observed. 시크릿은 적재 전 redact.'),
      ('slack','Slack','dropped',
        'Slack 커넥터가 메시지를 자료(source)로 적재한다(#541). distill 이 자료를 지식(K)으로 증류.',
        '주기 동기화(run-sync)', '[]'::jsonb, 30,
        'message → source(raw, provenance=observed). 관리탭 커넥터 설정에서 bot token 넣고 활성화. distill 이 source→knowledge.'),
      ('discord','Discord','dropped',
        'Discord 커넥터가 메시지를 자료(source)로 적재한다(#541). distill 이 자료를 지식(K)으로 증류.',
        '주기 동기화(run-sync)', '[]'::jsonb, 40,
        'message → source(raw). 관리탭 커넥터 설정에서 bot token 넣고 활성화.'),
      ('gmail','Gmail','dropped',
        'Gmail 커넥터가 메일을 자료(source)로 적재한다(#541, OAuth2 refresh-token). distill 이 지식으로 증류.',
        '주기 동기화(run-sync)', '[]'::jsonb, 50,
        'message → source(raw). 관리탭에서 Google OAuth(client_id/secret/refresh_token) 설정 후 활성화. scope gmail.readonly.'),
      ('gdrive','Google Drive','dropped',
        'Google Drive 커넥터가 문서를 지식(K)으로 적재한다(#541, OAuth2 refresh-token).',
        '주기 동기화(run-sync)', '["K"]'::jsonb, 60,
        'doc(정제 문서) → knowledge(observed). native 문서는 text/plain·csv export. 관리탭에서 Google OAuth 설정 후 활성화. scope drive.readonly.')
    ON CONFLICT (system) DO UPDATE SET
      label=EXCLUDED.label, status=EXCLUDED.status, collection_method=EXCLUDED.collection_method,
      cadence=EXCLUDED.cadence, into_kinds=EXCLUDED.into_kinds, sort=EXCLUDED.sort, note=EXCLUDED.note,
      updated_at=now();
  `);

  // ── member_credential — 로컬 로그인 자격(P4). 비번은 scrypt 해시만 저장(평문·복원 불가). ──
  //  member_id = org_member.id. must_change=초기 비번(관리자 발급) → 첫 로그인 후 변경 권장.
  //  failed_attempts+locked_until 로 브루트포스 완화. OIDC 도입 시에도 이 테이블은 로컬 폴백(IdP 없는 고객)으로 유지.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS member_credential(
      member_id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      must_change BOOLEAN NOT NULL DEFAULT false,
      failed_attempts INT NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);

  // ── member_secret — per-user 백엔드 자격 vault(P1, #746). 능동 커넥터 툴(gitlab·slack·google·aws…)이 쓰는
  //  자격을 사용자별 격리 보관. git_credential(owner=gateway|member:<id>) 패턴을 임의 kind 로 일반화한 것.
  //  ⚠ member_credential(로컬 로그인 비번, scrypt 단방향)과 다르다 — 여기는 API 호출용이라 복원 가능해야 함(secret-box AES-GCM).
  //  owner: 'gateway'(라이블리 통합 자격, 관리자 설정 — 비-PII read 폴백) | 'member:<id>'(개인 자격 — write·raw-PII 필수).
  //  kind: gitlab_pat|slack_user_token|google_oauth_refresh|clickup_token|notion_token|aws_role_arn|prometheus_bearer|… (확장 TEXT).
  //  scope_key: 같은 kind 의 다중 대상 구분(예 gitlab host, aws account) — 없으면 ''(단일). PK=(owner,kind,scope_key).
  //  secret_enc: 봉투 암호화된 시크릿(secret-box). meta: 비밀 아닌 부속정보(oauth client_id·aws region 등, jsonb 평문).
  //  해소 체인 resolveMemberSecret: member 우선 → (허용 시) gateway 폴백 → null. write/외부발신은 폴백 금지(per-user 필수).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS member_secret(
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      secret_enc TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      last_used_at TIMESTAMPTZ,
      PRIMARY KEY (owner, kind, scope_key));
    CREATE INDEX IF NOT EXISTS member_secret_kind_idx ON member_secret(kind, scope_key);
  `);

  // ── web_session — 사람 웹 로그인 세션(P4). HttpOnly 쿠키가 나르는 평문 세션ID 는 저장 안 함(sha256 만). ──
  //  revoke=logout/회수, expires_at 만료. scope 는 저장하지 않는다 — 인증 시 org_member.scopes 를 LIVE 로 읽어
  //  desync 를 원천 차단(토큰과 달리 세션은 사람이 본인으로 행위 → 멤버 권한 그대로, 최소권한 캡 없음).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS web_session(
      session_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      ip TEXT,
      user_agent TEXT);
    CREATE INDEX IF NOT EXISTS web_session_member_idx ON web_session(member_id);
  `);

  // ── git_credential — 레포 클론·세션 git 용 자격(#540). 웹UI로 관리(→DB 저장)하되 시크릿(개인키·토큰)은
  //  봉투 암호화(secret-box, CONNECTOR_SECRET_KEY)만 저장 — 공개키는 평문(웹 노출 OK). owner='gateway'(조직 머신
  //  계정) | 'member:<id>'(개별 사용자). (owner,host) 1행. kind 가 어느 필드가 채워졌는지 결정.
  //   게이트웨이 provision 클론은 요청 멤버 자격(없으면 gateway)을 주입, 세션 안 git 은 멤버 자격을 멤버 홈에 materialize.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS git_credential(
      owner TEXT NOT NULL,                     -- 'gateway' | 'member:<id>'
      host  TEXT NOT NULL DEFAULT 'github.com',
      kind  TEXT NOT NULL,                     -- 'ssh' | 'https'
      ssh_public_key      TEXT,                -- 공개키(평문 — 웹 노출·GitHub 등록용)
      ssh_private_key_enc TEXT,                -- SSH 개인키(봉투 암호화)
      https_username      TEXT,                -- HTTPS 사용자명(GitHub 토큰이면 임의값 무관)
      https_token_enc     TEXT,                -- HTTPS 토큰/PAT(봉투 암호화)
      label TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by   TEXT,
      last_used_at TIMESTAMPTZ,
      PRIMARY KEY (owner, host));
  `);

  // ── 멤버 이메일 유일성(로그인 아이디) — 부분 유니크(비어있지 않은 이메일만, 대소문자 무시). ──
  //  앱 레벨(org_member_upsert)이 1차 방어, 이 인덱스가 DB 보증. 기존 중복 데이터가 있으면 생성 실패 →
  //  **비치명적**으로 보류(중복 정리 후 다음 부팅에 자동 적용). 앱 검증은 그 사이에도 신규 중복을 막는다.
  await itemsPool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS org_member_email_lc_uniq ON org_member (lower(email)) WHERE email IS NOT NULL AND email <> ''`,
  ).catch((e) => { console.warn("[org schema] 멤버 이메일 유니크 인덱스 보류(기존 중복 데이터?):", (e as Error)?.message); });

  // ── pending_device_auth — CLI 브라우저 로그인(디바이스 코드, #880). CLI 가 device_code 보유, 사람이 user_code
  //  를 브라우저에서 승인, CLI 가 폴링해 토큰 수령. 평문 토큰은 저장 안 함(폴 시점 발급) — sha256 지문만.
  //  device_code_hash=sha256(평문 32B), code_challenge=S256(verifier)로 개시자 바인딩(도난 device_code 상환 차단).
  //  status pending→approved→consumed / denied. TTL 15분, GC 로 회수(reaper + lazy delete-on-read).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS pending_device_auth(
      device_code_hash TEXT PRIMARY KEY,
      user_code TEXT NOT NULL,                          -- 저장형: 8자 대문자, 하이픈 없음
      code_challenge TEXT NOT NULL,                     -- S256(code_verifier) base64url
      status TEXT NOT NULL DEFAULT 'pending',           -- pending | approved | denied | consumed
      member_id TEXT,                                   -- 승인 시 세션 멤버
      approver_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,-- 승인자 scope 스냅샷(poll 이 ∩ 재교집합 → 증폭 차단)
      include_control_plane BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      approved_at TIMESTAMPTZ,
      last_polled_at TIMESTAMPTZ,
      client_label TEXT);
  `);
  //  pending 중 user_code 유일(부분 유니크) — terminal 행은 자유 충돌 허용(user_code 재사용). 이메일 인덱스처럼
  //  비치명 보류(신규 테이블이라 사실 충돌 불가지만 관례 유지).
  await itemsPool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS pending_device_user_code_idx ON pending_device_auth(user_code) WHERE status='pending'`,
  ).catch((e) => { console.warn("[org schema] pending_device_auth user_code 유니크 인덱스 보류:", (e as Error)?.message); });

  // (org_memory/org_content → knowledge_unit 1회복사 폐기 2026-06-24 — 원본 DROP, 복사 완료·v6 컷오버.)
}
