// org-content 스키마 — workflow-std(전달 서브시스템)의 진실원천을 git 파일에서 이 DB로 이관.
// items DB(itemsPool)에 co-locate: 멤버 신원(person/person_identity)이 이미 거기 있고, 쓰기 풀이라
// 게이트웨이 firewall(읽기전용 db_query 경로)을 우회한다. 발행 시에만 DB→임시디렉토리 materialize 후
// 기존 file-based generator 를 subprocess 로 재사용한다(ARCHITECTURE.md 전달층 흡수).
//
// 멱등 마이그레이션 패턴은 items/store.ts 와 동일: CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS
//  + pg_constraint 프로브로 CHECK enum 멱등 적용. 부팅 시 1회(비치명적) 호출.
import { itemsPool } from "../items/store.js";
import { logger } from "../log.js";

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

  // ── 수정이력(작성자/리비전) — org_content_audit 가 *이미* knowledge_unit 의 append-only 리비전 소스다 ──
  //  (entity='knowledge_unit' 행 586건: insert/update/set_lifecycle/delete + before/after = redactDeep 후 full
  //   KnowledgeUnit JSONB 스냅샷 + actor + source). 윤상민 요구("누가 사람/AI·어떤경로 mcp/web/connector·언제·내용
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

  // ════════ P1a 통합 지식스토어(데이터층) — knowledge_unit 단일 캐노니컬 ════════
  // org_memory(메모) + org_content(규칙/페르소나)을 하나의 지식 단위 테이블로 통합. 기존 store 함수는
  //  이 위 얇은 래퍼로 재구현(시그니처 불변, 듀얼라이트 없음). 임베딩/pgvector 는 이번 범위 밖(ILIKE 검색만).
  //  원본 org_memory/org_content 는 보존(드롭·수정 금지 — 롤백용). 부팅 시 1회 비파괴 복사로 캐노니컬에 채운다.

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
  //  knowledge_unit 의 어느 kind 로 적재되는지를 비개발자도 읽도록 명문화. status=active(수집중) | dropped
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
      -- V4-P2a(분류 재설계): kind = 본질 4종 **R·K·H·W** 로 narrow. 흡수: A/D/F/M/L/Z→K,
      --  S/G→domainmap 파생(federated, ku kind 아님). 데이터 흡수(UPDATE)는 scripts/v4-absorb-kinds.mjs 가
      --  1회 수행(56행)하고, 여기서는 *제약/시드*만 4값으로 굳힌다. 멱등 패턴 = confidence_chk 와 동일
      --  (pg_get_constraintdef 프로브로 "이미 4값(레거시 문자 미포함)이면 스킵", 아니면 DROP 후 4값 재ADD).
      --  ⚠ 반드시 데이터 흡수 *후*에만 narrow 가 통과한다 — 잔존 A/D/F/M 이 있으면 ADD CONSTRAINT 가 throw.
      --   부팅 순서상 마이그 스크립트가 먼저 흡수했으므로 안전(미흡수 DB 에선 throw=조기발견 가드).
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_kind_chk'
                       AND pg_get_constraintdef(oid) NOT LIKE '%''A''%'
                       AND pg_get_constraintdef(oid) NOT LIKE '%''D''%'
                       AND pg_get_constraintdef(oid) NOT LIKE '%''F''%') THEN
        ALTER TABLE knowledge_unit DROP CONSTRAINT IF EXISTS knowledge_unit_kind_chk;
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_kind_chk
          CHECK (kind IN ('R','K','H','W'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_lifecycle_chk') THEN
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_lifecycle_chk
          CHECK (lifecycle IN ('active','rejected','superseded'));
      END IF;
      -- H2(P-V3-3a): confidence 에 'observed' 추가 — 커넥터 수집물(A/W)의 신뢰축. 큐레이션된 ai/rule/human 과
      --  의미가 다르다: observed = '관측된 외부 사실'(주입 인덱스 영구 제외 + overview 별도 카운트 + 검토 큐 제외,
      --  배선은 knowledge.ts/materialize.ts). 멱등: 구 3값 CHECK(=observed 미포함)면 DROP 후 4값 재생성, 이미
      --  observed 포함이면 no-op(매 부팅 DROP/ADD 락 churn 회피). fresh DB 면 바로 4값. 기존 43행(ai/rule/human)
      --  은 4값의 부분집합이라 무손상(재검증 통과). item_domain_state_chk 멱등 패턴과 동일(pg_get_constraintdef 프로브).
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_confidence_chk'
                       AND pg_get_constraintdef(oid) LIKE '%observed%') THEN
        ALTER TABLE knowledge_unit DROP CONSTRAINT IF EXISTS knowledge_unit_confidence_chk;
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_confidence_chk
          CHECK (confidence IN ('ai','rule','human','observed'));
      END IF;
      -- L-가(P-V3-2): kinds[] 다중분류 가드 — 모든 원소가 유효 kind 문자여야 한다. 빈 배열은 통과.
      --  V4-P2a: 화이트리스트도 본질 4종 **R/K/H/W** 로 narrow(흡수원소→K 정규화는 마이그 스크립트가 1회 수행).
      --  CHECK 는 서브쿼리 불가 → jsonb 부분집합 연산자 <@ 로 검증: kinds 가 4 kind 화이트리스트의 부분집합인지.
      --  멱등: confidence_chk 와 동일 DROP+probe(이미 4값=레거시 문자 미포함이면 스킵, 아니면 DROP 후 4값 재ADD).
      --  반드시 kinds[] 정규화 *후*에만 통과(잔존 A/D/F 원소가 있으면 throw=조기발견).
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit'::regclass AND conname='knowledge_unit_kinds_chk'
                       AND pg_get_constraintdef(oid) NOT LIKE '%"A"%'
                       AND pg_get_constraintdef(oid) NOT LIKE '%"D"%'
                       AND pg_get_constraintdef(oid) NOT LIKE '%"F"%') THEN
        ALTER TABLE knowledge_unit DROP CONSTRAINT IF EXISTS knowledge_unit_kinds_chk;
        ALTER TABLE knowledge_unit ADD CONSTRAINT knowledge_unit_kinds_chk CHECK (
          jsonb_typeof(kinds) = 'array'
          AND kinds <@ '["R","K","H","W"]'::jsonb);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS knowledge_unit_kind_idx ON knowledge_unit(kind);
    CREATE INDEX IF NOT EXISTS knowledge_unit_lifecycle_idx ON knowledge_unit(lifecycle);
    CREATE INDEX IF NOT EXISTS knowledge_unit_domain_idx ON knowledge_unit(domain_key);
    CREATE INDEX IF NOT EXISTS knowledge_unit_updated_idx ON knowledge_unit(updated_at DESC);
  `);

  // ════════ P-V3-3a 단일스토어 스키마 확장(가산적) — knowledge_unit 이 커넥터 활동(kind=A/W)을 흡수할 ════════
  //  컬럼/배선만 준비한다. **실제 데이터 적재·읽기경로 전환·item→item_legacy 리네임은 P-V3-3b/3c**(여기서 안 함).
  //  발견 A 의 item(prov_*/external_id/parent/fields/raw/2시간축) 풍부함을 흡수할 컬럼 세트를 비파괴로 추가.
  //  전부 ADD COLUMN IF NOT EXISTS 라 기존 43행/12 kind 에 영향 0(신 컬럼은 NULL/기본값으로 채워짐).

  // ── knowledge_unit 외부출처/동기화/스레드/원본보존 컬럼(커넥터 적재 흡수용). ──
  //  source: 단위의 출처 분류 — 'authored'(저작물: 기존 R/K/메모, 기본값) | 외부 시스템명(커넥터 적재 A/W).
  //  external_*: 동기화물의 출처 좌표(system/instance/id/url). item 의 prov_system/prov_instance/external_id/external_url 대응.
  //  occurred_at: 사건 발생시각, last_synced_at: 마지막 동기화 시각 — as_of/updated_at 과 더불어 '2시간축'(발생 vs 반영).
  //  parent_external_id + parent_name: 스레드/서브태스크 자기참조(parent_external_id=외부좌표, parent_name=내부 PK 연결).
  //  fields/raw: 커넥터 원본 보존(item.fields/raw 대응). ⚠ H1 — 이 두 컬럼은 적재 시 ingest 가 redactDeep 후 써야 함
  //   (적재 전환은 P-V3-3b 책임). 본 페이즈는 컬럼만 추가(데이터 미적재라 유출면 없음).
  await itemsPool.query(`
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'authored';
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS external_system TEXT;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS external_instance TEXT;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS external_id TEXT;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS external_url TEXT;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS sync_state JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS parent_external_id TEXT;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS parent_name TEXT;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS fields JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE knowledge_unit ADD COLUMN IF NOT EXISTS raw JSONB;
  `);

  // ── 동기화물 멱등 upsert 키 — UNIQUE(external_system, external_instance, external_id) WHERE external_id IS NOT NULL. ──
  //  부분 유니크 인덱스: 저작물(external_id IS NULL)은 name PK 만, 동기화물은 (system,instance,id)로 upsert(item 의
  //  UNIQUE(prov_system,prov_instance,external_id) 대응). external_instance NULL 도 키 일부 — pg 는 NULL 을 distinct 로
  //  보므로 (sys,NULL,id) 중복은 막히지 않지만, 커넥터는 instance 를 항상 채운다(없으면 ''로 정규화 — 적재층 P-V3-3b 책임).
  //  name PK 와 공존: 같은 행이 name(내부) + external 좌표(외부) 둘 다 가질 수 있다.
  await itemsPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_unit_external_uidx
      ON knowledge_unit(external_system, external_instance, external_id)
      WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS knowledge_unit_source_idx ON knowledge_unit(source);
    CREATE INDEX IF NOT EXISTS knowledge_unit_occurred_idx ON knowledge_unit(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS knowledge_unit_parent_idx ON knowledge_unit(parent_name);
  `);

  // ── 다중도메인/다중프로젝트 매핑 조인(item_domain/item_project 구조 참고) — A/W 단위가 도메인 여러개에 ──
  //  귀속 가능하게. name↔domain key(repo 스코프) + mapped_by/confidence/state/evidence. 기존 단일 domain_key
  //  컬럼은 저작물(R/K) 편의로 유지하되, 조인 테이블이 다중의 캐노니컬(P-V3-3b 적재가 채움 — 본 페이즈는 테이블만).
  //  PK(name, repo, domain_key): 한 단위가 (repo,key) 별로 한 번 매핑. FK(name) ON DELETE CASCADE — 단위 삭제 시 매핑도.
  //  mapped_by/state CHECK 는 item_domain 과 동일 enum(rule/llm/manual/declared, proposed/confirmed/rejected).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_unit_domain(
      name TEXT REFERENCES knowledge_unit(name) ON DELETE CASCADE,
      repo TEXT, domain_key TEXT,
      mapped_by TEXT NOT NULL DEFAULT 'rule',
      confidence REAL,
      state TEXT NOT NULL DEFAULT 'proposed',
      evidence TEXT,
      PRIMARY KEY(name, repo, domain_key));
    CREATE TABLE IF NOT EXISTS knowledge_unit_project(
      name TEXT REFERENCES knowledge_unit(name) ON DELETE CASCADE,
      repo TEXT, project_key TEXT,
      mapped_by TEXT NOT NULL DEFAULT 'rule',
      confidence REAL,
      state TEXT NOT NULL DEFAULT 'proposed',
      evidence TEXT,
      PRIMARY KEY(name, repo, project_key));
    CREATE INDEX IF NOT EXISTS knowledge_unit_domain_key_idx  ON knowledge_unit_domain(repo, domain_key);
    CREATE INDEX IF NOT EXISTS knowledge_unit_domain_state_idx ON knowledge_unit_domain(state);
    CREATE INDEX IF NOT EXISTS knowledge_unit_project_key_idx  ON knowledge_unit_project(repo, project_key);
    CREATE INDEX IF NOT EXISTS knowledge_unit_project_state_idx ON knowledge_unit_project(state);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit_domain'::regclass AND conname='knowledge_unit_domain_state_chk') THEN
        ALTER TABLE knowledge_unit_domain ADD CONSTRAINT knowledge_unit_domain_state_chk
          CHECK (state IN ('proposed','confirmed','rejected'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit_domain'::regclass AND conname='knowledge_unit_domain_mappedby_chk') THEN
        ALTER TABLE knowledge_unit_domain ADD CONSTRAINT knowledge_unit_domain_mappedby_chk
          CHECK (mapped_by IN ('rule','llm','manual','declared'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit_project'::regclass AND conname='knowledge_unit_project_state_chk') THEN
        ALTER TABLE knowledge_unit_project ADD CONSTRAINT knowledge_unit_project_state_chk
          CHECK (state IN ('proposed','confirmed','rejected'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='knowledge_unit_project'::regclass AND conname='knowledge_unit_project_mappedby_chk') THEN
        ALTER TABLE knowledge_unit_project ADD CONSTRAINT knowledge_unit_project_mappedby_chk
          CHECK (mapped_by IN ('rule','llm','manual','declared'));
      END IF;
    END $$;
  `);

  // ── item 폐기·ku 컷오버: knowledge_unit_mapping_audit — kud/kup 쓰기의 append-only 감사층. ──
  //  item_mapping_audit(item_id 좌표)의 ku-좌표 대응물(name 좌표). 매핑 큐레이션이 item 무의존이 되면
  //  모든 propose/confirm/reject/declare 쓰기가 이 테이블에 검증경로 통과 증거를 남긴다(우회 SQL 쓰기는
  //  감사행이 없어 드러남). append-only 불변식: UPDATE/DELETE 코드 경로 없음. FK 없음(의도 — ku 행이
  //  지워져도 이력 보존). item_mapping_audit 은 비파괴 보존(레거시 이력) — 이 테이블은 가산.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_unit_mapping_audit(
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      target TEXT NOT NULL CHECK (target IN ('domain','project')),
      name TEXT NOT NULL,
      repo TEXT NOT NULL,
      key TEXT NOT NULL,
      mapped_by TEXT,
      action TEXT NOT NULL,
      state TEXT,
      confidence REAL,
      evidence TEXT,
      source TEXT,
      actor TEXT);
    CREATE INDEX IF NOT EXISTS knowledge_unit_mapping_audit_name_idx ON knowledge_unit_mapping_audit(name);
    CREATE INDEX IF NOT EXISTS knowledge_unit_mapping_audit_at_idx   ON knowledge_unit_mapping_audit(at DESC);
  `);

  // ── knowledge_unit_revision — ku 전용 수정이력 뷰(작성자/리비전 노출 표면). ──
  //  org_content_audit(entity='knowledge_unit') 를 캐노니컬 리비전 소스로 채택하고 ku-전용으로 투영한다.
  //  version = (name 내) at,id 순 1-base 순번(audit 기준 진실 — ku.version 과 별개; set_lifecycle 도 행을 남기므로
  //  대체로 일치하나 view 가 진실). before/after = 그 시점 redactDeep 스냅샷(시크릿 이미 마스킹·시점 보존).
  //  actor_kind=누가(사람/AI), channel=어떤경로 — 둘 다 평문 노출(비-본문 메타라 redact 대상 아님). 백필은
  //  사실상 불요(audit 가 이미 시간순 보존 → row_number 가 자동 v1,v2.. 부여). 컬럼 actor_kind/channel 의
  //  레거시 백필은 scripts/backfill-ku-revision.mjs(멱등·비파괴)가 담당.
  // DROP+CREATE(멱등·비파괴 — 뷰는 데이터 미보유) — 컬럼 타입(version int 캐스트) 변경은 CREATE OR REPLACE 가
  //  거부(checkViewColumns)하므로 DROP IF EXISTS 선행. 뷰 의존객체 없음(다른 뷰/룰이 참조 안 함).
  await itemsPool.query(`DROP VIEW IF EXISTS knowledge_unit_revision`);
  await itemsPool.query(`
    CREATE VIEW knowledge_unit_revision AS
      SELECT id,
             entity_key AS name,
             op,
             (row_number() OVER (PARTITION BY entity_key ORDER BY at, id))::int AS version,
             at,
             actor,
             actor_kind,
             channel,
             source,
             token_hash_prefix,
             before,
             after
        FROM org_content_audit
       WHERE entity='knowledge_unit';
  `);

  // ── M-라 성능: pg_trgm 확장 + title/body_md GIN trgm 인덱스(pgvector 없이 ILIKE 가속). ──
  //  item 흡수로 knowledge_unit 급증 시 searchKnowledge 의 ILIKE full-scan 을 가속한다(gin_trgm_ops 가 ILIKE '%...%' 지원).
  //  ⚠ graceful: 확장 미가용(권한/미설치 서버)이면 CREATE EXTENSION 또는 GIN 생성이 throw → 별 트랜잭션으로 감싸
  //   catch 후 warn(부팅·검색 무중단, ILIKE 는 인덱스 없이도 동작). embedding(pgvector)과 독립 — trgm 부재여도 OK.
  try {
    await itemsPool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await itemsPool.query(`
      CREATE INDEX IF NOT EXISTS knowledge_unit_title_trgm_idx ON knowledge_unit USING gin (title gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS knowledge_unit_body_trgm_idx  ON knowledge_unit USING gin (body_md gin_trgm_ops);
    `);
  } catch (err) {
    logger.warn({ err }, "pg_trgm 확장/인덱스 생성 실패(무시) — ILIKE 검색은 인덱스 없이 동작(graceful)");
  }

  // ── kind 캐노니컬 정의 시드(ground-truth) — label/injection_mode/domain_scoped/audience/sort 골격 + ──
  //  description(정의)·criteria(분류기준: 언제 이 kind 인가 + 인접 kind 구분)·storage(저장방식)·
  //  delivery(전달방식 = injection_mode 의 의미). 비개발자도 이해할 쉬운 한국어.
  //  멱등 정책: ON CONFLICT(kind) DO UPDATE — **정의 4필드(description/criteria/storage/delivery)는 코드가
  //  캐노니컬**이라 부팅 시마다 시드값으로 정렬한다. 웹 #/learn 은 읽기전용 렌더라 사용자가 정의를 편집하지
  //  않는다 → DO UPDATE 가 사람 편집을 덮을 위험 없음.
  //
  //  ⚠ V4-P2a(분류 재설계, 2026-06-18 v4 plan §1.A): 본질 kind = **R·K·H·W 4종만 시드**.
  //   - R(규칙/정책/페르소나)=강제, K(지식노트, A/D/F/M/L/Z 흡수)=회상, H(런북/절차)=회상, W(작업)=질의.
  //   - **A/D/F/G/S/M/L/Z 행은 P2a 에서 시드 제거 + 부팅 DELETE 로 정리**(데이터 흡수 *후*). 데이터 마이그
  //     (A/D/F/M/L/Z→K, S/G=domainmap federate 0행)는 scripts/v4-absorb-kinds.mjs 가 1회 수행. 이 시드+DELETE 가
  //     소스 캐노니컬이라 부팅마다 4kind 로 정렬·정리(스크립트 미실행 DB 도 시드는 4행, 데이터 흡수만 스크립트 의존).
  //   - injection_mode: R=enforced / K·H=recalled / W=query. materialize FALLBACK·web #/learn 은 라이브 registry 읽음.
  await itemsPool.query(`
    INSERT INTO kind_registry(kind, label, injection_mode, domain_scoped, audience, cardinality, sort, description, criteria, storage, delivery) VALUES
      ('R','Rule/Policy/Persona','enforced',false,'context','many',10,
        '조직이 모든 AI 세션에 강제하는 규칙·정책·페르소나. "반드시/금지" 같은 행동 규범과 AI 의 말투·역할. 4 본질 종류 중 하나(R·K·H·W).',
        '"항상/반드시/절대" 지켜야 하는 강제 규범이면 R. 한 번 일어난 사실·방법 절차(H)·배경 지식(K)과 구분: R 은 위반하면 안 되는 명령형이다. 페르소나(AI 역할·말투)도 R.',
        '강제규칙(managed-policy)·회사맥락(org-defaults) 섹션으로 저장. 본문 전체가 보존된다.',
        '강제 주입(enforced): 맥락과 무관하게 모든 세션 컨텍스트 최상단에 전문이 그대로 들어간다(R 만 항상 주입).'),
      ('K','Knowledge note','recalled',false,'memory','many',20,
        '지식 노트 — 결정의 배경, 알게 된 것, 정리한 생각, 사실, 도메인 지식, 메모·링크까지 아우르는 일반 지식. 4 본질 종류 중 가장 큰 기본값(R·K·H·W). (구 A/D/F/M/L/Z 흡수.)',
        '강제 규범(R)·절차(H)·작업(W)이 아닌 거의 모든 저작 지식은 K. 배경·맥락·사실·도메인 지식·메모·외부 링크·산출물이 다 K 로 모인다(주제는 종류가 아니라 area=domain 으로 구분, 출처는 provenance 로 구분). 애매하면 K.',
        '지식 단위로 저장(제목+본문). 본문은 전문 보존, 검색 대상. 주제 귀속은 area(domain_key, product/business)로 단다.',
        '검색 회상(recalled): 인덱스(제목·요약)에 노출, 전문은 일에 맞춰 area+검색으로 그때 소환(on-demand).'),
      ('H','How-to/Runbook','recalled',true,'memory','many',50,
        '하우투·런북 — 무엇을 어떤 순서로 하는지의 재현 가능한 절차(예: 배포 방법, 동기화 실행법). AI 워크플로 표준화의 핵심 산물. 4 본질 종류 중 하나(R·K·H·W).',
        '"이렇게 한다"는 단계별 절차면 H. 배경 지식(K)과 구분: H 는 따라 하면 결과가 재현된다. 도메인 절차여도 H(area=domain 부여 가능).',
        '지식 단위로 저장(단계 목록 본문). 주제 귀속은 area(domain_key) 부여 가능.',
        '검색 회상(recalled): 인덱스에 노출, 필요할 때 area+검색으로 전문 소환(on-demand).'),
      ('W','Work/Task','query',false,'memory','many',90,
        '작업·태스크 — PM 도구(ClickUp 등)의 태스크/이슈. 진행 상태·담당을 가진 일. 4 본질 종류 중 하나(R·K·H·W).',
        '진행 상태(미정/진행/완료)·담당을 가진 **일/태스크**면 W. 절차 설명은 H, 정리된 지식은 K. 수집된 외부 활동/문서는 출처(provenance=observed)로 들어온 W/K 미러다.',
        '커넥터/pm_* 가 적재(external_id·상태). 작업 단위.',
        '질의 시(query): 필요할 때 조회(작업 현황 검색).')
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
        '(미적재) Slack 커넥터 코드는 있으나 message:slack 이 KIND_MAP 에 미정의라 knowledge_unit 으로 적재되지 않는다(미러 skip).',
        NULL, '[]'::jsonb, 30,
        '적재하려면 KIND_MAP 에 message:slack 매핑을 추가해야 한다(현재 미정의 → 미러 skip). 라이브 ku 에 slack 0건.'),
      ('discord','Discord','dropped',
        '(미적재) Discord 커넥터 코드는 있으나 message:discord 가 KIND_MAP 에 미정의라 knowledge_unit 으로 적재되지 않는다(미러 skip).',
        NULL, '[]'::jsonb, 40,
        '적재하려면 KIND_MAP 에 message:discord 매핑을 추가해야 한다(현재 미정의 → 미러 skip). 라이브 ku 에 discord 0건.')
    ON CONFLICT (system) DO UPDATE SET
      label=EXCLUDED.label, status=EXCLUDED.status, collection_method=EXCLUDED.collection_method,
      cadence=EXCLUDED.cadence, into_kinds=EXCLUDED.into_kinds, sort=EXCLUDED.sort, note=EXCLUDED.note,
      updated_at=now();
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
