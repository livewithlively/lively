// org 스키마 조각 — connectors-ingest: 외부 자료 인입 축. org_connector(커넥터 설정/시크릿)·
//  org_ingest_policy(인입 허용선)·org_distiller/org_distiller_seen(자료 증류기). 진입점 2개 —
//  원 파일에서 org_connector 는 org_mcp_server 직후, 인입 정책은 sessions-infra 뒤에 있었다(순서 보존).
// #1313 R19b: 구 단일 initOrgSchema(org/schema.ts, ~1,500줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 org/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initConnectorRegistry(pool: Pool): Promise<void> {
  // ── org_connector — 커넥터별 설정/토큰 레지스트리 (프로젝트 #541). system PK = 1행/커넥터(단일테넌트). ──
  //  config  = 비밀 아닌 설정(평문 JSONB: clickup list ids·notion instance·slack channels 등, CONNECTOR_SPECS secret:false).
  //  secrets = 암호화 시크릿(JSONB {key: "gcm$…"}, secret-box AES-256-GCM, CONNECTOR_SPECS secret:true).
  //  종전 org_mcp_server.auth_env(env 이름만) 컨벤션을, SSM 전용 배포(고객사 A 실박스=파일편집 불가)를 위해 '암호문 저장'
  //  으로 확장 — 평문 시크릿은 여전히 DB 에 두지 않는다(암호문만). 커넥터 해소(connectors/config.ts)가 DB→복호화→env 폴백.
  //  data_source(카탈로그: system/status/label)와 별개 축 — 그건 커넥터 존재·활성 메타, 여긴 자격/설정.
  await pool.query(`
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
}

// #1291 v4 — 커넥터별 자료 공개범위 정책. 수집물이 태어날 때의 공개범위를 커넥터(+채널)별로 정한다.
//  자료의 생산자는 사람이 아니라 커넥터라 개별 잠금이 현실적이지 않다(슬랙만 1만건 규모) → 생산 지점에 정책.
//  org_ingest_policy(무엇을 들일까)와 직교: 여기는 **들어온 것을 누가 보나**. 매칭 축이 같아 나란히 읽힌다.
export async function initSourceVisPolicy(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_source_vis_policy(
      id BIGSERIAL PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT true,
      match_system  TEXT NOT NULL,
      match_channel TEXT,
      visibility TEXT NOT NULL DEFAULT 'open',
      priority INT NOT NULL DEFAULT 0,
      note TEXT,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("org_source_vis_policy", {
      org_source_vis_policy_visibility_chk: "visibility IN ('open','members')",
    })}
    CREATE INDEX IF NOT EXISTS org_source_vis_policy_system_idx ON org_source_vis_policy(match_system) WHERE enabled;
    CREATE TABLE IF NOT EXISTS org_source_vis_policy_member(
      policy_id BIGINT NOT NULL REFERENCES org_source_vis_policy(id) ON DELETE CASCADE,
      subject_kind TEXT NOT NULL DEFAULT 'member',
      member_id TEXT NOT NULL,
      PRIMARY KEY (policy_id, subject_kind, member_id));
    ${ensureCheck("org_source_vis_policy_member", {
      org_source_vis_policy_member_kind_chk: "subject_kind IN ('member','team')",
    })}
  `);
}

export async function initIngestPolicyAndDistillers(pool: Pool): Promise<void> {
  // ── org_ingest_policy — 지식 인입 허용선 정책(#638, #783 확장). 오너가 관리탭에서 조절하는 자동화 게이트. ──
  //  매치 규칙 0개면 디폴트 auto(현행 무변 — 오너가 켠 만큼만 gate). 평가 = resolveIngestPolicy(src/org/ingest/ingest-policy.ts).
  //  적용 경로: mirror(observed·신규만) + knowledge_save(에이전트 MCP·사람 웹·distill — 신규/수정 양축).
  await pool.query(`
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
    ${ensureCheck("org_ingest_policy", {
      org_ingest_policy_action_chk: "action IN ('auto','confirm','drop')",
      org_ingest_policy_provenance_chk: "match_provenance IS NULL OR match_provenance IN ('authored','observed')",
    })}
    CREATE INDEX IF NOT EXISTS org_ingest_policy_enabled_idx ON org_ingest_policy(enabled);
  `);

  // ── #783 정책 축·액션 확장 — 멱등 가산(구 행은 NULL/기본값 = 현행 동작 그대로). ──
  //  · match_actor_kind = 누가 썼나(ai=MCP 에이전트 | human=웹 사람). 서버가 채널로 판정(v6/content-audit.ts actorKindOf) — 자기보고 아님.
  //  · match_agent      = 하네스 id(claude-code|codex|openclaw…) — 접속 신원(org/auth/agent-identity.ts). 자율 실행만 좁혀 게이트 가능.
  //  · match_type       = page-type(decision|concept|how-to|reference|research|entity) — 예: 런북(how-to)만 사람 승인.
  //  · action_update    = 기존 지식 '수정' 시 동작(auto|review|stage|drop). NULL/auto = 수정 게이트 없음(구 규칙 무변).
  //      review=반영하되 diff 를 검토 큐에 적재(사후검토) · stage=본문 미반영, 승인해야 반영(리비전 제안) · drop=수정 거부.
  //      신규(action)와 분리한 이유: 에이전트 쓰기의 상당수가 '기존 지식 갱신'이라 신규만 막으면 게이트가 샌다.
  //  · is_exception     = 예외(carve-out) — 매치되면 보수적 누적을 건너뛰고 이 규칙이 확정("전부 검토하되 이 도메인만 통과").
  //  · preset           = 관리탭 프리셋 스위치가 관리하는 규칙 표식('agent-knowledge') — 사람이 만든 세부 규칙과 구분.
  await pool.query(`
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS match_actor_kind TEXT;
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS match_agent      TEXT;
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS match_type       TEXT;
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS action_update    TEXT NOT NULL DEFAULT 'auto';
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS is_exception     BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE org_ingest_policy ADD COLUMN IF NOT EXISTS preset           TEXT;
    ${ensureCheck("org_ingest_policy", {
      org_ingest_policy_actor_kind_chk: "match_actor_kind IS NULL OR match_actor_kind IN ('ai','human')",
      org_ingest_policy_action_update_chk: "action_update IN ('auto','review','stage','drop')",
    })}
    -- 프리셋 규칙은 종류당 1행(관리탭 스위치가 upsert 로 관리 — 중복 생성 방지).
    CREATE UNIQUE INDEX IF NOT EXISTS org_ingest_policy_preset_uq ON org_ingest_policy(preset) WHERE preset IS NOT NULL;
  `);

  // ── org_distiller — 자료 증류기(#1289). "어떤 자료를 · 무슨 기준으로 · 어떤 형식의 지식으로" 를 n개 정의. ──
  //  계기(실측 ernest-slack-distill-zero-measurement-1289): 고객사 A 슬랙 10,900건 중 증류 13건(0.12%). 근본원인은
  //  distill_sources 크론 미등록이었지만, 등록만으론 안 된다 — 인박스가 전역 고정(listUndistilledSources(50))이라
  //  증류기를 둘 만들어도 **둘이 같은 최근 50건을 집는다**. 팀별로 대상 채널·지식화 기준·결과 형식이 다르므로
  //  스코프를 데이터로 갈라야 n개가 성립한다.
  //  ⚠ org_ingest_policy(#638)와 직교 — 저건 '지식이 되고 나서 auto/confirm/drop 어디로 보내나'(허용선 밸브),
  //   이건 '무엇을 집어 무슨 기준·형식으로 증류하나'(생산 라인). 증류기가 만든 지식도 그 밸브를 그대로 탄다.
  //  겹침 해소: priority DESC, id ASC 로 **한 자료는 가장 높은 우선순위 증류기 하나에만 배정**된다(중복 증류 방지).
  //   → 낮은 우선순위에 넓은 스코프를 두면 자연히 catch-all 레인이 된다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_distiller(
      id BIGSERIAL PRIMARY KEY,
      key   TEXT NOT NULL,
      label TEXT,
      enabled  BOOLEAN NOT NULL DEFAULT false,
      priority INT NOT NULL DEFAULT 0,
      -- ① 스코프: 무엇을 집는가 (전부 비우면 '나머지 전부' catch-all)
      match_kinds      TEXT[],
      match_system     TEXT,
      include_channels TEXT[],
      exclude_channels TEXT[],
      include_authors  TEXT[],
      exclude_authors  TEXT[],
      exclude_bots     BOOLEAN NOT NULL DEFAULT true,
      min_chars        INT NOT NULL DEFAULT 0,
      lookback_days    INT,
      -- ② 기준: 무엇을 지식화하는가 (팀마다 다른 자유서술 — 프롬프트에 그대로 삽입)
      criteria_md TEXT,
      -- ③ 형식: 결과 문서를 어떤 모양으로 (제목 규칙·섹션 구성 등 자유서술 + 고정 분류/타입/접두어)
      format_md       TEXT,
      target_category TEXT,
      default_type    TEXT,
      name_prefix     TEXT,
      thread_aware    BOOLEAN NOT NULL DEFAULT true,
      -- ④ 실행
      batch_size  INT NOT NULL DEFAULT 50,
      mode        TEXT NOT NULL DEFAULT 'headless',
      session_ref TEXT,
      model TEXT, effort TEXT, requester TEXT,
      -- ⑤ 관측
      last_run_at TIMESTAMPTZ, last_status TEXT, last_summary JSONB,
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("org_distiller", {
      org_distiller_mode_chk: "mode IN ('headless','session')",
      org_distiller_batch_chk: "batch_size BETWEEN 1 AND 500",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS org_distiller_key_uq ON org_distiller(key);
    CREATE INDEX IF NOT EXISTS org_distiller_enabled_idx ON org_distiller(enabled, priority DESC, id);
  `);

  // ── org_distiller_seen — 증류기가 **이미 판정한** 자료(#1289 후속). ──
  //  왜 필요한가(고객사 A 실측 2026-07-30): 인박스 판정이 'knowledge_source 링크 없음' 뿐이라, LLM 이 skip 한 자료는
  //  아무 흔적도 안 남아 **다음 배치에 그대로 다시 올라왔다.** 연속 두 배치의 대상 id 를 대조하니 50건 중 32건(64%)이
  //  재독이었다. 극단적으로 한 배치가 전부 skip 이면 링크가 0이라 다음 배치도 똑같은 50건 — 진행이 영원히 0이 된다
  //  (잡담 비율이 높은 채널일수록 위험). 그래서 '봤다'를 기록해 인박스에서 뺀다.
  //  ⚠ LLM 자기보고에 의존하지 않는다 — **서버가 배치를 낸 시점에** 기록한다(안 부르면 새는 툴 계약보다 견고).
  //   대신 배치가 실패하면 그 task_id 의 기록을 되돌려(task-store.markFinished) 자료가 유실되지 않게 한다.
  //  증류에 성공한 자료는 knowledge_source 링크로 이미 빠지므로, 이 테이블의 실질 역할은 **'보고 버린 것'** 이다.
  //  기준(criteria)을 바꿔 다시 보고 싶으면 org_distiller_upsert 의 reset_seen 으로 비운다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_distiller_seen(
      distiller_id BIGINT NOT NULL REFERENCES org_distiller(id) ON DELETE CASCADE,
      source_id INT NOT NULL,
      task_id BIGINT,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(distiller_id, source_id));
    CREATE INDEX IF NOT EXISTS org_distiller_seen_task_idx ON org_distiller_seen(task_id) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS org_distiller_seen_src_idx ON org_distiller_seen(source_id);
  `);

  // ── 사전 필터(#1289 후속) — LLM 에 먹이기 **전에** 서버가 스레드를 걸러낸다. ──
  //  계기(실측 2026-07-31): 배치 1건(자료 100건)이 **2,600만~7,000만 토큰**을 썼다. 구성비가 결정적이다 —
  //  캐시읽기 73% + 캐시생성 26% + 실입력·출력 1%. 즉 새 정보를 넣는 비용은 1%고, 나머지 99%는
  //  '이미 읽은 자료를 매 턴 다시 들고 다니는' 비용이다(턴 150~217회 × 턴당 컨텍스트 14만~32만).
  //  그런데 그렇게 읽은 자료의 **68%가 skip** 된다 — 버릴 것을 읽는 데 대부분을 쓴 셈이다.
  //  비용이 자료 수에 대해 O(n²) 이라 입력을 32%로 줄이면 토큰은 ~90% 준다.
  //  → 원 방식(vina '지식화 방법.md')의 2단계 스코어링을 **서버측 SQL 로** 이식한다. LLM 은 통과분만 읽는다.
  //
  //  · prefilter_level(0~100) = **레버 하나**. 올릴수록 빡빡해진다. 각 축 임계값이 여기서 파생된다.
  //     0 = 필터 끔(전부 통과) · 50 = 기본(결정성1·참여자2·메시지3|400자) · 100 = 매우 엄격.
  //  · prefilter_rules(jsonb) = 축별 **개별 덮어쓰기**. 레버가 정한 파생값보다 우선한다(부분 지정 가능).
  //     { min_decisive, min_authors, min_msgs, min_chars, keywords[], match: 'all'|'any' }
  //     → 레버로 대충 맞추고 필요한 축만 손으로 고정하는 운용(커스텀 상한을 두지 않는다).
  //  채널마다 대화 성격이 달라 같은 임계가 안 통한다 — 그래서 증류기(=채널)마다 따로 조절한다.
  await pool.query(`
    ALTER TABLE org_distiller ADD COLUMN IF NOT EXISTS prefilter_level INT NOT NULL DEFAULT 0;
    ALTER TABLE org_distiller ADD COLUMN IF NOT EXISTS prefilter_rules JSONB;
    -- #1289 배치는 **스레드 단위**로 자른다(메시지 단위 LIMIT 은 스레드를 쪼개 컨텍스트를 통제하지 못했다).
    --  batch_size = 스레드 상한 · batch_max_msgs = 메시지 상한. 스레드를 최근순으로 누적하다 어느 한쪽을 넘으면 멈춘다.
    --  ⚠ 단 **첫 스레드는 상한을 넘어도 통째로 담는다** — 스레드를 자르면 대화가 끊겨 증류 자체가 불가능하다
    --   (171메시지짜리 스레드는 그 하나만 처리하고 다음 배치로 넘긴다).
    ALTER TABLE org_distiller ADD COLUMN IF NOT EXISTS batch_max_msgs INT NOT NULL DEFAULT 20;
    ${ensureCheck("org_distiller", { org_distiller_prefilter_chk: "prefilter_level BETWEEN 0 AND 100" })}
  `);
}
