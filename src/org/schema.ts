// org-content 스키마 — workflow-std(전달 서브시스템)의 진실원천을 git 파일에서 이 DB로 이관.
// items DB(itemsPool)에 co-locate: 멤버 신원(person/person_identity)이 이미 거기 있고, 쓰기 풀이라
// 게이트웨이 firewall(읽기전용 db_query 경로)을 우회한다. 발행 시에만 DB→임시디렉토리 materialize 후
// 기존 file-based generator 를 subprocess 로 재사용한다(ARCHITECTURE.md 전달층 흡수).
//
// 멱등 마이그레이션 패턴은 items/store.ts 와 동일: CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS
//  + pg_constraint 프로브로 CHECK enum 멱등 적용. 부팅 시 1회(비치명적) 호출.
import { itemsPool } from "../items/store.js";

export async function initOrgSchema(): Promise<void> {
  // ── org_profile — 단일 행(id=1): 조직 표시명 + 게이트웨이 주소. ──
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
  `);

  // ── org_content — 섹션별 markdown 본문. 현재 섹션: 'managed-policy', 'org-defaults'. ──
  // 매 세션 멤버 컨텍스트 최상단에 주입되는 두 코어 문서. version 은 낙관적 잠금 + 변경 감지용.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_content(
      section TEXT PRIMARY KEY,
      body_md TEXT NOT NULL DEFAULT '',
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
  `);

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

  // ── org_memory — 단일 공유 풀(에이전트 생산·소비). 인덱스(요약)는 발행 시 항상-주입 컨텍스트로, 본문은 ──
  //  memory_search(게이트웨이 pull)로. visibility(member/internal) 분리는 2026-06-17 폐기 — 과설계였음.
  //  domain_key/domain_repo: domainmap 도메인 귀속(슬러그 약결합, FK 아님). 자동분류(memory_save) 또는 수동.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS org_memory(
      name TEXT PRIMARY KEY,
      title TEXT,
      body_md TEXT NOT NULL DEFAULT '',
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ALTER TABLE org_memory ADD COLUMN IF NOT EXISTS domain_key TEXT;
    ALTER TABLE org_memory ADD COLUMN IF NOT EXISTS domain_repo TEXT;
    -- 단순화 폐기(down-migration, 멱등): 구코드가 더는 안 읽음. visibility CHECK 는 컬럼 드롭 시 함께 사라짐.
    --  in_index 도 폐기 — 전 메모리가 인덱스에 들어감(cap 으로 관리). 파괴적이라 index.ts 가 listen 성공 후에만 실행.
    ALTER TABLE org_memory DROP COLUMN IF EXISTS visibility;
    ALTER TABLE org_memory DROP COLUMN IF EXISTS in_index;
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
      hooks JSONB NOT NULL DEFAULT '{"session_preload":true,"work_flag":true,"stop_writeback_gate":true}'::jsonb,
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
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_hook'::regclass AND conname='org_hook_event_chk') THEN
        ALTER TABLE org_hook ADD CONSTRAINT org_hook_event_chk CHECK (event IN
          ('SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop','SubagentStop','Notification'));
      END IF;
    END $$;
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
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_driver_chk') THEN
        ALTER TABLE org_db_source ADD CONSTRAINT org_db_source_driver_chk CHECK (driver = 'postgres');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='org_db_source'::regclass AND conname='org_db_source_auth_mode_chk') THEN
        ALTER TABLE org_db_source ADD CONSTRAINT org_db_source_auth_mode_chk
          CHECK (auth_mode IN ('password','iam','mtls','vault'));
      END IF;
    END $$;
  `);

  // ── org_content_audit 확장: 회수 대상 즉시 특정용 token 해시 prefix + 요청 IP(B23). ──
  await itemsPool.query(`
    ALTER TABLE org_content_audit ADD COLUMN IF NOT EXISTS token_hash_prefix TEXT;
    ALTER TABLE org_content_audit ADD COLUMN IF NOT EXISTS req_ip TEXT;
  `);

  // ════════ P1a 통합 지식스토어(데이터층) — knowledge_unit 단일 캐노니컬 ════════
  // org_memory(메모) + org_content(규칙/페르소나)을 하나의 지식 단위 테이블로 통합. 기존 store 함수는
  //  이 위 얇은 래퍼로 재구현(시그니처 불변, 듀얼라이트 없음). 임베딩/pgvector 는 이번 범위 밖(ILIKE 검색만).
  //  원본 org_memory/org_content 는 보존(드롭·수정 금지 — 롤백용). 부팅 시 1회 비파괴 복사로 캐노니컬에 채운다.

  // ── kind_registry — 지식 종류 분류 + 주입 정책 메타. 12 kind 시드(아래). ──
  // injection_mode = 멤버 컨텍스트에 어떻게 노출되는가(enforced/always/recalled/manual/query/digest).
  //  domain_scoped = domainmap 도메인 귀속을 갖는 종류인지. cardinality = 한 종류당 한 단위(one)인지 다수(many)인지.
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

  // ── knowledge_unit — 통합 지식 단위(캐노니컬). name PK(슬러그). kind=주분류, kinds=다중분류(예약, 기본 []). ──
  //  lifecycle: active(유효) | rejected(폐기) | superseded(supersedes 가 가리키는 신판으로 대체됨).
  //  confidence: ai(에이전트 생산) | rule(규칙 파생) | human(사람 확정) — upsert 에서 source 로 서버강제.
  //  domain_key/domain_repo: domainmap 약결합(FK 아님). embedding 컬럼은 pgvector 미가용이라 이번 범위 밖.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_unit(
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'K',
      kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
      title TEXT,
      body_md TEXT NOT NULL DEFAULT '',
      domain_key TEXT,
      domain_repo TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      supersedes TEXT,
      confidence TEXT NOT NULL DEFAULT 'human',
      author TEXT,
      source_ref TEXT,
      as_of TIMESTAMPTZ,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_kind_chk') THEN
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_kind_chk
          CHECK (kind IN ('F','D','K','R','H','S','G','A','W','M','L','Z'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_lifecycle_chk') THEN
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_lifecycle_chk
          CHECK (lifecycle IN ('active','rejected','superseded'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_confidence_chk') THEN
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_confidence_chk
          CHECK (confidence IN ('ai','rule','human'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS knowledge_unit_kind_idx ON knowledge_unit(kind);
    CREATE INDEX IF NOT EXISTS knowledge_unit_lifecycle_idx ON knowledge_unit(lifecycle);
    CREATE INDEX IF NOT EXISTS knowledge_unit_domain_idx ON knowledge_unit(domain_key);
    CREATE INDEX IF NOT EXISTS knowledge_unit_updated_idx ON knowledge_unit(updated_at DESC);
  `);

  // ── 12 kind 시드(ON CONFLICT DO NOTHING — 멱등). cardinality 전부 'many'. ──
  await itemsPool.query(`
    INSERT INTO kind_registry(kind, label, injection_mode, domain_scoped, audience, cardinality) VALUES
      ('R','Rule/Policy/Persona','enforced',false,'context','many'),
      ('K','Knowledge note','recalled',false,'memory','many'),
      ('D','Domain knowledge','recalled',true,'memory','many'),
      ('F','Fact','recalled',false,'memory','many'),
      ('H','How-to/Runbook','recalled',true,'memory','many'),
      ('S','Schema/Structure','digest',true,'memory','many'),
      ('G','Glossary/Graph','digest',true,'memory','many'),
      ('A','Artifact','query',false,'memory','many'),
      ('W','Work/Task','query',false,'memory','many'),
      ('M','Memo','manual',false,'memory','many'),
      ('L','Link/Ref','manual',false,'memory','many'),
      ('Z','Misc','manual',false,'memory','many')
    ON CONFLICT (kind) DO NOTHING;
  `);

  // ── 1회 비파괴 데이터복사(멱등) — 기존 org_memory/org_content → knowledge_unit. ──
  //  INSERT ... SELECT ... ON CONFLICT(name) DO NOTHING 라 재실행해도 무피해(이미 있는 name 은 건드리지 않음).
  //  원본 테이블은 보존(드롭·수정 금지 — 롤백용). version/updated_at/updated_by 보존, confidence='human', lifecycle='active'.
  //  org_memory → kind='K'(지식노트). domain_key/domain_repo 도 함께 복사.
  await itemsPool.query(`
    INSERT INTO knowledge_unit(name, kind, title, body_md, domain_key, domain_repo, lifecycle, confidence, sort, version, updated_at, updated_by)
      SELECT name, 'K', title, body_md, domain_key, domain_repo, 'active', 'human', sort, version, updated_at, updated_by
        FROM org_memory
    ON CONFLICT (name) DO NOTHING;
  `);
  //  org_content('managed-policy','org-defaults') → kind='R'(규칙/정책/페르소나). name=section.
  await itemsPool.query(`
    INSERT INTO knowledge_unit(name, kind, title, body_md, lifecycle, confidence, version, updated_at, updated_by)
      SELECT section, 'R', NULL, body_md, 'active', 'human', version, updated_at, updated_by
        FROM org_content WHERE section IN ('managed-policy','org-defaults')
    ON CONFLICT (name) DO NOTHING;
  `);
}
