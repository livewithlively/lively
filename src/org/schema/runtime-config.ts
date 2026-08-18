// org 스키마 조각 — runtime-config: org_runtime_config(런타임 정책 단일행). 기본형(테이블+단일행 시드)과
//  정책 노브 ALTER 연발(화이트리스트·정책 jsonb·토글)을 한 파일로 응집하되, 진입점은 둘로 나눈다 —
//  원 파일에서 두 구획이 mcp-tools 조각을 사이에 두고 떨어져 있었다(순서 보존).
// #1313 R19b: 구 단일 initOrgSchema(org/schema.ts, ~1,500줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 org/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";

export async function initRuntimeConfigTable(pool: Pool): Promise<void> {
  // ── org_runtime_config — 런타임(훅) 설정 단일행: 훅 on/off · work-roots · writeback 너지 문구. ──
  // 멤버 머신에 materialize → ~/.lively/hooks-config.json + work-roots. 훅이 런타임에 읽음(fail-open).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_runtime_config(
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      hooks JSONB NOT NULL DEFAULT '{"session_preload":true,"work_flag":true,"stop_writeback_gate":true,"self_update":true}'::jsonb,
      writeback_notice TEXT,
      work_roots JSONB NOT NULL DEFAULT '[]'::jsonb,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    INSERT INTO org_runtime_config(id) VALUES(1) ON CONFLICT DO NOTHING;
  `);
}

export async function initRuntimeConfigPolicyColumns(pool: Pool): Promise<void> {
  // ── org_runtime_config 확장: http_proxy 안전 화이트리스트(B15). 둘 다 기본 빈 배열(deny-all). ──
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS allowed_auth_envs JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS url_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장(#1245): 온톨로지 가이드(제품 소유 섹션) 주입 토글. 기본 TRUE — 기존 org 무회귀. ──
  //  본문은 코드가 단일 출처(DB 섹션 행 무시)라 이 플래그는 '주입할지'만 정한다.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS inject_ontology_guide BOOLEAN NOT NULL DEFAULT TRUE;
  `);

  // ── org_runtime_config 확장: db 소스가 참조 가능한 시크릿 env '이름' 화이트리스트(deny-all 기본). ──
  // 인프라 시크릿(DATABASE_URL·ITEMS_DATABASE_URL 등)을 UI 로 참조해 게이트웨이 자기 DB 를 탈취하는 권한상승 차단.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS allowed_db_secret_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장: db 데이터소스가 접속 가능한 host 화이트리스트(deny-all 기본). ──
  // 웹 등록 소스는 SSRF 가드로 사설/localhost 를 막는다(브라우저 임의입력 신뢰 불가). 운영자가 admin 으로 여기에
  //  명시한 host 만 사설/내부 DB(예: localhost 의 items)를 db 소스로 접속 허용 — 신뢰경계를 운영자에 고정.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS allowed_db_hosts JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장(#746 T1): MCP 프록시가 접속 가능한 '내부(사설/localhost)' host 화이트리스트(deny-all 기본). ──
  // 프록시 대상 remote MCP 는 기본 공인 https 만 — 사설/메타데이터/loopback 은 SSRF 로 차단. 격리 VPC 내부 MCP 서버처럼
  //  정당한 사설 대상은 운영자가 admin 으로 여기에 명시한 host 만 예외 허용(allowed_db_hosts 와 동형 — 신뢰경계를 운영자에 고정).
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS allowed_internal_hosts JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장: write_tools — work-flag 가 '기록함(writeback)'으로 인정할 lively MCP 툴 목록. ──
  // 비면(기본 '[]') 훅 내장 v6 기본목록 사용(writeback_notice 와 동형 오버라이드). 온톨로지 변경 시 재배포 없이 웹에서 갱신.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS write_tools JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // ── org_runtime_config 확장: pull_tools — work-flag 가 '외부 맥락을 끌어왔다'로 볼 MCP 툴 이름 **prefix** 목록(#906). ──
  // write_tools 와 달리 **비면 끔**(기본값이 곧 on): 노브 하나로 on/off + 범위를 함께 잡는다. 훅 내장 폴백 없음 —
  //  게이트웨이 불가 시 pull_tools 부재 → 넛지 안 함(fail-safe: 넛지는 못 하는 쪽이 안전).
  // 기본 'mcp__lively__ext__' = 라이블리 MCP 프록시 전 호출(읽기·쓰기).
  //  ⚠ prefix 매칭이다(substring 아님) — 'ext__' 로 두면 서버명이 'context__…' 인 MCP 가 오탐된다.
  //  ⚠ 현재 훅 matcher 가 mcp__lively__.* 라 **다른 서버 prefix 를 넣어도 훅이 그 호출을 못 본다**(구성원 자체설치 MCP
  //   커버는 후속 — matcher 를 이 목록에서 파생시키는 설계가 선행돼야 한다. 넓히기만 하면 모든 MCP 호출마다 훅이 스폰된다).
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS pull_tools JSONB NOT NULL DEFAULT '["mcp__lively__ext__"]'::jsonb;
  `);

  // ── org_runtime_config 확장: embedding_config — 벡터검색(#172) 추론 seam 설정. config-over-code(고객 모델 스왑). ──
  // 기본 {"provider":"off"} = 벡터 비활성(현행 grep/ILIKE 그대로). 켜면 OpenAI-compatible /v1/embeddings 로 임베딩.
  // 시크릿 금지: auth_env_ref 는 환경변수 '이름'만(키 값 아님 — org_db_source.auth_ref idiom). 정규화/해석은 src/v6/embedding-provider.ts.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS embedding_config JSONB NOT NULL DEFAULT '{"provider":"off"}'::jsonb;
  `);

  // ── org_runtime_config 확장: storage_policy — 박스 저장소 정책(#813). 로그 보관 상한 · 디스크 임계치. ──
  // 기본 '{}' = 미설정 → env 시드(LOG_MAX_MB·DISK_WARN_PCT…) → 코드 기본값 순으로 해석(src/org/policies/storage-policy.ts).
  // **관리탭이 단일 창구**: 고객 박스는 우리가 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS storage_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: call_log_policy — MCP 호출 감사로그 보관 정책(#1082). 보존일수. ──
  // 기존엔 mcp_call_log 가 **무기한** 쌓였다(schema 주석에 'prune 은 성장 시 추가' 로 예고만 되고 미구현).
  //  호출 로그엔 누가 언제 무엇을 했는지가 사람 단위로 남으므로, 보관기간 없는 축적은 개인정보 최소보관 원칙에 어긋난다.
  // 기본 '{}' = 미설정 → env 시드(MCP_CALL_LOG_RETENTION_DAYS) → 코드 기본값(90일) 순(src/org/policies/call-log-policy.ts).
  // **관리탭이 단일 창구**: 고객 박스는 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다(storage_policy 와 동일 교리).
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS call_log_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: session_memory_policy — per-session cgroup 메모리 격리(#1059 D). 세션당 MemoryHigh/Max(MB). ──
  // 기본 '{}' = 미설정 → env 시드(LIVELY_SESSION_MEM_HIGH_MB·_MAX_MB) → 0/0(무제한, 무회귀) 순으로 해석
  //  (src/sessions/session-memory-policy.ts). claude 는 네이티브라 힙제한이 안 통해 cgroup 이 유일 수단 — box-cgspawn 이
  //  systemd-run --scope 로 세션을 이 상한의 scope 에 가둬 폭주 세션 하나만 OOM-kill 되고 박스는 생존(#1059 고객사 A 다운).
  // **관리탭이 단일 창구**: 고객 박스는 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다(storage_policy 와 동일 교리).
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS session_memory_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: session_reclaim_policy — idle 세션 자동 회수(reaper) 정책(#1059 F). idle TTL(분). ──
  // 기본 '{}' = 미설정 → env 시드(LIVELY_SESSION_IDLE_TTL_MIN) → 0(회수 끔, 무회귀) 순으로 해석
  //  (src/sessions/session-reclaim-policy.ts). 켜면 그 시간 넘게 idle 인 세션을 reaper 가 회수하되 desired-state
  //  (org_session_state)를 보존해 restorable 로 남긴다(#1059 E lazy resume). admission control 대신 채택된 근본대책.
  // **관리탭이 단일 창구**: 고객 박스는 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다(storage/session-memory 와 동일 교리).
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS session_reclaim_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: delegate_policy — 위탁 태스크 정책(#1101). 무출력 stall 상한(ms). ──
  // 기본 '{}' = 미설정 → env 시드(LIVELY_TASK_STALL_MS) → 300000(5분) 순으로 해석(src/org/policies/delegate-policy.ts).
  //  워커가 시작 후 그 시간 동안 stream.jsonl 에 한 바이트도 못 쓰면 스케줄러가 조기 종결하고 원인을 에러에 담는다
  //  (자격 부재로 claude -p 가 hang 하면 timeout_sec 1h 까지 무출력으로 매달렸다 — #1101 고객사 A 실측 32분).
  // **관리탭이 단일 창구**: 고객 박스는 SSH 로 못 들어가므로 .env 전용 정책은 사실상 아무도 못 바꾼다(storage/session-reclaim 과 동일 교리).
  //  정작 이 노브가 필요한 곳이 그 박스다 — 레포 준비가 느리면 늘리고, 배치 드레인은 줄여서 빨리 실패를 본다.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS delegate_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: hook_relay_decisions — 러너가 PreToolUse 에서 하네스로 전파할 결정값(#892). ──
  // 기본 '["deny","ask","defer"]' = 제한적 결정만 전파. **'allow' 는 기본 제외**가 핵심: allow 는 멤버의 권한
  //  프롬프트(동의 UI)를 건너뛰므로, 관리자 훅이 조용히 그걸 없애는 걸 기본값으로 두지 않는다. 넓히려면 명시 opt-in.
  //  (관리자는 이미 멤버 머신에서 임의 코드를 실행할 수 있어 기술적 새 권한은 아니지만, 동의 표면은 별개 문제다.)
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS hook_relay_decisions JSONB NOT NULL DEFAULT '["deny","ask","defer"]'::jsonb;
  `);

  // ── org_runtime_config 확장: session_share — 세션이력 캡처 정책(#905 C1). 관리탭 ▸ 세션 공유 에서 조절. ──
  //  기본 '{}' → resolveSessionShare 가 기본값(enabled=false)으로 접는다. **켜기 전엔 아무 세션도 캡처 안 함**(롤아웃 안전).
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS session_share JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장: hook_grace_ms — 커스텀 훅 런너(run-custom)가 게이트웨이 미도달 시 최근 성공 캐시를
  //  얼마나 오래 쓸지(ms). **NULL = 무제한**(마지막 접속 기준 영구 실행 — #1008 기본). 양수 = 그 ms 경과 후 fail-CLOSED.
  //  종전엔 런너에 10분이 하드코딩돼 오프라인 10분 후 로컬-자족 커스텀 훅(스킬 라우터·spec-blind 품질게이트)까지 죽었다.
  //  이 컬럼을 관리탭 노브로 승격 — 기본을 무제한으로 둬 오프라인에도 마지막 설정대로 돌게 한다. content_hash 무결성
  //  검증은 캐시에도 적용되므로 무제한이어도 변조 훅 실행 위험은 없고, 회수의 실질(재접속 시 캐시 교체)은 그대로다.
  //  DEFAULT NULL 이라 기존/신규 조직 전부 마이그레이션만으로 무제한이 된다. 보안상 짧은 회수창이 필요한 조직만 값을 준다.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS hook_grace_ms BIGINT DEFAULT NULL;
  `);

  // ── org_runtime_config 확장: embedding_backfill_paused — 자동 임베딩 백필 스윕 일시중지(#1060). ──
  //  자동 백필(부팅 30초·10분 주기·connector_sync 완료 후·쓰기 nudge)은 느린/CPU 임베딩 백엔드에서 게이트웨이 성능을
  //  갉아먹을 수 있는데 종전엔 멈출 창구가 없었다. 이 플래그가 true 면 runAutoBackfillSweep 이 즉시 return(4개 트리거 전부
  //  차단) + 실행 중 잡은 shouldStop 으로 협조적 중단. **DB 영속** — 재시작에도 유지되어 부팅 스윕이 이 상태를 존중한다
  //  (성능 때문에 껐는데 재부팅으로 되살아나면 안 된다). 기본 false=평소대로 자동 백필. 관리탭 ▸ 의미 검색 에서 사람이 토글.
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS embedding_backfill_paused BOOLEAN NOT NULL DEFAULT false;
    -- #1291 맥락 유형별 공개범위 켜기/끄기. 키가 없으면 '켜짐'(현행 동작) — 새 축이 추가돼도 자동으로 켜진 채 시작한다.
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS visibility_axes JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  // ── org_runtime_config 확장(#1454 S2~S5): 매니지드 표면 노브 4종 — 전부 기본값이 '기존 동작 완전 불변'이라
  //  셀프호스트 조직은 이 컬럼이 생겨도 아무 변화가 없다(매니지드 컨트롤플레인만 org_runtime_update 로 값을 준다).
  //   · ui_nav(S2): 상단 탭 게이팅. '{}' = 전부 노출(현행). {tabs:{context:false}} 처럼 **명시적 false 인 탭만** 숨김.
  //   · announcement(S3): 조직 공지 배너 {text, href?, tone?:'info'|'warn'}. NULL = 미표시(현행).
  //   · ui_profile(S4): 관리탭 프로파일 'full'(현행 전체) | 'personal'(개인 워크스페이스 — 조직 운영 섹션 숨김).
  //   · usage_url(S5): 상단바 '사용량' 칩 링크. NULL = 칩 미노출(현행).
  //  넷 다 whoami(me) 응답에 실려 프론트가 부팅 때 한 번에 받는다 — 별도 조회 왕복 없음(vis_axes 와 동형).
  await pool.query(`
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS ui_nav JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- ── oidc_config — 외부 IdP 웹 로그인(#1520) 설정. embedding_config 와 같은 seam(DB 우선, 비면 env 시드). ──
    --  왜 DB 인가: 고객 실박스가 SSM 전용이면 .env 편집이 비현실적이라 관리탭이 유일한 창구가 된다
    --   (secret-box.ts 머리주석의 컨벤션 확장과 같은 사정). 에어갭·자동화 배포는 종전대로 env 로 굽는다.
    --  ⚠ client_secret 은 **암호문(secret-box, gcm$…)만** 넣는다 — 평문 시크릿은 DB 에 두지 않는다.
    --   그래서 이 컬럼은 '시크릿 금지' 원칙의 예외가 아니다(암호문은 키 없이는 쓸모없다).
    --  {} = 미설정 → OIDC 는 env(OIDC_*)로만 켜지고, env 도 없으면 로컬 로그인만 남는다.
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS oidc_config JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS announcement JSONB;
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS ui_profile TEXT NOT NULL DEFAULT 'full';
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS usage_url TEXT;
    -- ── ui_mode(#1719): 기본 화면 셸 — 'v2'(새 1탭 셸: 사이드바·리브 대화·위젯·런치패드) | 'classic'(종전 탭 셸).
    --  ⚠ 기본값이 'v2' 다 — 다른 노브와 달리 '기존 동작 불변'이 아니다(대표 결정: 새 설치·매니지드는 새 화면이 기본,
    --   이미 배포된 셀프호스트는 운영자가 관리탭 [화면] 에서 classic 으로 내린다). 클래식 코드는 그대로 남아
    --   ?embed=1 로 새 셸의 런치패드 '앱'으로 실린다. 사람별로는 브라우저 로컬 오버라이드(web/lib/state.ts uiMode)가 우선.
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS ui_mode TEXT NOT NULL DEFAULT 'v2';
    -- ── workspace_kind(#1750): 이 워크스페이스(=이 게이트웨이)의 종류 — 'team'(여러 사람이 쓰는 팀 워크스페이스) |
    --   'personal'(한 사람의 개인 워크스페이스). 기본 'team' = 기존 셀프호스트 박스는 무설정으로 팀 워크스페이스가 된다
    --   (상민님 결정 2026-08-18: "기존 셀프호스팅 단일 워크스페이스는 팀 워크스페이스"). 매니지드는 컨트롤플레인이 가입 시 personal 로 push.
    --   개인 워크스페이스에서만 '팀으로 올리기(승격)' 흐름이 기본 동선이다 — 팀 워크스페이스에서도 링크·승격은 막지 않는다(멤버 단위).
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS workspace_kind TEXT NOT NULL DEFAULT 'team';
    -- workspace_hub_url(#1750): 계정의 워크스페이스 목록·만들기가 있는 허브(매니지드 = app.lvly.io/home). 좌상단 스위처가
    --   '다른 워크스페이스·새로 만들기'를 여기로 보낸다. null = 허브 없음(셀프호스트 기본 — 스위처엔 이 워크스페이스와 연결한 팀만).
    ALTER TABLE org_runtime_config ADD COLUMN IF NOT EXISTS workspace_hub_url TEXT;
  `);
}
