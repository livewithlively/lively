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

export async function initCollectorRegistry(pool: Pool): Promise<void> {
  // ── org_collector — **수집기 인스턴스**(#1419 T1). org_connector 의 'system PK = 종류당 1개' 제약을 푼다. ──
  //  왜(요구 원문): "지금 채널 당 하나씩 밖에 못 만드는데, 구조를 바꿔서 그냥 수집기를 n 개 만들 수 있는데,
  //   프리셋으로 슬랙·노션 등을 설정할 수 있는 거고, 거기에 커스텀하게 프리셋을 추가할 수 있게."
  //   실제로 막히는 것: 워크스페이스가 둘인 슬랙, 루트가 다른 노션 트리 두 벌, 채널 그룹마다 다른 주기·산출정책.
  //   종전 구조에선 그 어느 것도 표현할 데가 없었다(org_connector.system 이 PK라 행이 하나).
  //
  //  ⚠ org_connector 를 **지우지 않는다**. 그 테이블은 이제 '각 프리셋의 레거시 기본 인스턴스'로 남고,
  //   마이그레이션(migrateConnectorsToCollectors)이 그 행을 여기로 복사한다. env 폴백도 그대로 산다 —
  //   커넥터 해소(connectors/config.ts)가 collector → org_connector → env 순으로 떨어지므로, 이 테이블이
  //   비어 있는 배포(마이그레이션 전·설치 직후)도 종전과 **정확히 같게** 동작한다(무중단이 이 설계의 제1계약).
  //
  //  축의 의미:
  //   · preset_key = 이 수집기가 무엇으로 동작하나. 내장 프리셋(slack·notion·…, CONNECTOR_SPECS) 또는
  //     커스텀 프리셋(org_collector_preset, T2). 여러 수집기가 같은 preset_key 를 공유할 수 있다 — 그게 요점이다.
  //   · instance_key = 이 수집기의 **커서·미러 네임스페이스**. connector_state(system, instance) 의 instance 로
  //     그대로 들어간다(그 PK 는 이미 2축이라 스키마 변경 0). 인스턴스끼리 커서를 밟지 않게 하는 유일한 열쇠라
  //     한 번 정하면 바꾸지 않는다(바꾸면 그 수집기는 커서를 잃고 전체 재수집한다).
  //     레거시 기본 인스턴스는 '_' 를 그대로 물려받는다 — 그래야 마이그레이션이 커서를 승계한다.
  //   · output_mode = 수집 결과를 자료로 둘지 지식으로 올릴지(T3 가 실제 배선. 여기선 열만 미리 둔다 —
  //     한 테이블을 두 번 ALTER 하지 않으려고).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_collector(
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      preset_key TEXT NOT NULL,
      instance_key TEXT NOT NULL DEFAULT '_',
      label TEXT,
      enabled BOOLEAN NOT NULL DEFAULT false,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
      sync_interval_sec INT NOT NULL DEFAULT 600,
      output_mode TEXT NOT NULL DEFAULT 'preset',
      output_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      sort INT NOT NULL DEFAULT 0,
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("org_collector", {
      // 'preset' = 프리셋 코드가 정하던 기존 동작 그대로(무중단 기본값). T3 가 나머지 셋을 배선한다.
      org_collector_output_chk: "output_mode IN ('preset','source','knowledge','both')",
      org_collector_interval_chk: "sync_interval_sec BETWEEN 60 AND 604800",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS org_collector_key_uq ON org_collector(key);
    -- 같은 프리셋의 두 수집기가 같은 커서 네임스페이스를 쓰면 서로의 진행을 덮어쓴다 — DB가 막는다.
    CREATE UNIQUE INDEX IF NOT EXISTS org_collector_instance_uq ON org_collector(preset_key, instance_key);
    CREATE INDEX IF NOT EXISTS org_collector_enabled_idx ON org_collector(enabled, preset_key);
  `);
}

export async function initCollectorPresets(pool: Pool): Promise<void> {
  // ── org_collector_preset — **커스텀 프리셋**(#1419 T2). "거기에 커스텀하게 프리셋을 추가할 수 있게." ──
  //  내장 프리셋(CONNECTOR_SPECS — slack·notion·…)은 코드가 SoT 로 남는다. 이 테이블은 그 옆에 서는
  //  **데이터 정의 프리셋**이다. 둘을 합친 카탈로그에서 수집기를 만든다(collectorPresetCatalog).
  //
  //  두 갈래:
  //   · driver='clone'  — 내장 프리셋을 복제해 기본값·라벨·안내문만 바꾼 것("우리 회사 슬랙 템플릿").
  //     수집 코드는 base_preset 의 커넥터 모듈을 그대로 쓴다.
  //   · driver='http'|'rss'|'webhook' — **코드 배포 없이** 새 수집 방식을 정의한 것. 커넥터 모듈이 없고,
  //     범용 드라이버(connectors/generic/*)가 driver_config 를 읽어 그 자리에서 커넥터처럼 행동한다.
  //     사내 API·공개 피드처럼 라이블리가 모르는 소스를 관리자가 화면에서 붙이는 경로다.
  //
  //  fields = 이 프리셋이 수집기에게 물어볼 설정 항목(ConnectorField[] 와 같은 모양). 화면 폼이 여기서 그려지고,
  //   secret:true 항목은 수집기의 secrets 로 암호화 저장된다 — 즉 **자격은 프리셋이 아니라 수집기가 갖는다**
  //   (프리셋은 틀, 수집기는 그 틀에 값을 채운 인스턴스). 그래서 같은 프리셋으로 계정이 다른 수집기 n개가 선다.
  //
  //  parser_script = 응답 → RawItem 변환을 관리자가 직접 쓰는 자리(선택). 매핑 규칙(driver_config.map)으로
  //   표현 안 되는 소스를 위한 탈출구다. ⚠ 실행은 격리 자식 프로세스(connectors/generic/parser-sandbox.ts) —
  //   그 파일 헤더에 보안 경계와 **한계**(네트워크는 못 막는다)가 명시돼 있다. admin scope 전용.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_collector_preset(
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      driver TEXT NOT NULL DEFAULT 'http',
      base_preset TEXT,
      description TEXT,
      fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      driver_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      guide JSONB,
      parser_script TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("org_collector_preset", {
      org_collector_preset_driver_chk: "driver IN ('clone','http','rss','webhook')",
      // clone 은 무엇을 복제할지가 있어야 성립한다 — 없으면 '수집 코드가 없는 프리셋'이 돼 조용히 아무것도 안 한다.
      org_collector_preset_clone_chk: "driver <> 'clone' OR base_preset IS NOT NULL",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS org_collector_preset_key_uq ON org_collector_preset(key);
  `);

  // ── 웹훅 수신 함(#1419 T2) — driver='webhook' 수집기가 받은 원문을 **먼저 쌓아 두는 자리**. ──
  //  왜 따로 두나: 웹훅은 남이 아무 때나 밀어넣는다. 수신 시점에 파싱·적재까지 하면 그 순간의 파서 버그·
  //  DB 지연이 곧 **전송 실패(4xx/5xx)** 가 되고, 보낸 쪽은 재전송하거나 그냥 버린다(원문 유실).
  //  그래서 수신은 '검증하고 통째로 적는' 것까지만 하고(즉시 200), 변환·적재는 싱크가 나중에 한다.
  //  → 파서를 고치고 나서 processed_at 을 비우면 **같은 원문으로 다시 돌릴 수 있다**(재처리 가능).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collector_webhook_event(
      id BIGSERIAL PRIMARY KEY,
      collector_id BIGINT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      headers JSONB NOT NULL DEFAULT '{}'::jsonb,
      body JSONB,
      body_text TEXT,
      processed_at TIMESTAMPTZ,
      error TEXT);
    CREATE INDEX IF NOT EXISTS collector_webhook_event_pending_idx
      ON collector_webhook_event(collector_id, id) WHERE processed_at IS NULL;
  `);
}

export async function initClassifierRegistry(pool: Pool): Promise<void> {
  // ── org_classifier — **분류기**(#1419 T4). 증류기(org_distiller)의 분류판. ──
  //  as-is 문제: 분류는 크론 액션(classify_knowledge[_headless]) 하나뿐이고 **설정할 게 없었다**. 대상은
  //   'listUnmappedKnowledge(50)' 전역 고정, 기준은 코드에 박힌 프롬프트, 후보는 전 카테고리. 그래서
  //   "제품 도메인은 엄격히·사업 맥락은 느슨히", "이 팀 지식은 이 축들 안에서만" 같은 걸 표현할 데가 없었다.
  //   증류기가 같은 이유로 n개가 됐고(#1289: 전역 인박스 하나면 둘을 만들어도 같은 50건을 집는다), 분류도 같다.
  //
  //  ⚠ 증류기와 직교한다 — 증류기는 **자료→지식**(없던 지식을 만든다), 분류기는 **지식→분류축**(있는 지식의
  //   자리를 정한다). 파이프라인에서 증류 다음이 분류다.
  //  ⚠ 산출 경로는 바꾸지 않는다 — 분류기가 만드는 것은 여전히 knowledge_propose_category 의 제안이고,
  //   사람 확정은 기존 [분류 검토 대기] 화면이 받는다. 새 진실 출처를 만들지 않는다(#837 불변식).
  //
  //  배정 규칙은 증류기와 같다: priority DESC, id ASC 로 **한 지식은 가장 앞선 분류기 하나에만** 배정된다.
  //   낮은 우선순위 + 넓은 스코프 = 나머지를 받는 기본 라인.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_classifier(
      id BIGSERIAL PRIMARY KEY,
      key   TEXT NOT NULL,
      label TEXT,
      enabled  BOOLEAN NOT NULL DEFAULT false,
      priority INT NOT NULL DEFAULT 0,
      -- ① 스코프: 어떤 지식을 분류 대상으로 삼는가 (전부 비우면 '나머지 전부' catch-all)
      --  target: unmapped=미분류만(기본) · low_confidence=제안 신뢰도 낮은 것 재분류 · both
      target TEXT NOT NULL DEFAULT 'unmapped',
      confidence_below REAL,
      match_spaces      TEXT[],
      match_types       TEXT[],
      match_provenance  TEXT,
      match_systems     TEXT[],
      exclude_names     TEXT[],
      min_chars     INT NOT NULL DEFAULT 0,
      lookback_days INT,
      -- ② 기준: 무엇을 근거로 자리를 정하는가(자유서술 — 프롬프트에 그대로 삽입) + 후보 축 제한
      criteria_md TEXT,
      candidate_categories TEXT[],
      -- 이 확신도 이상이면 confirmed, 미만이면 proposed(사람 검토). 분류기마다 엄격도가 다르다.
      confirm_threshold REAL NOT NULL DEFAULT 0.8,
      -- ③ 실행
      batch_size  INT NOT NULL DEFAULT 50,
      mode        TEXT NOT NULL DEFAULT 'headless',
      session_ref TEXT,
      model TEXT, effort TEXT, requester TEXT,
      -- ④ 관측
      last_run_at TIMESTAMPTZ, last_status TEXT, last_summary JSONB,
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("org_classifier", {
      org_classifier_mode_chk: "mode IN ('headless','session')",
      org_classifier_target_chk: "target IN ('unmapped','low_confidence','both')",
      org_classifier_batch_chk: "batch_size BETWEEN 1 AND 500",
      org_classifier_threshold_chk: "confirm_threshold BETWEEN 0 AND 1",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS org_classifier_key_uq ON org_classifier(key);
    CREATE INDEX IF NOT EXISTS org_classifier_enabled_idx ON org_classifier(enabled, priority DESC, id);
  `);

  // ── org_classifier_seen — 분류기가 **이미 판정한** 지식(#1419 T4). org_distiller_seen 과 같은 이유로 존재한다. ──
  //  증류기에서 실측된 문제(#1289, 고객사 A): 인박스 판정이 '결과물 없음' 뿐이라 LLM 이 skip 한 것은 흔적이
  //   안 남아 **다음 배치에 그대로 다시 올라왔다**(연속 두 배치의 64%가 재독). 극단적으로 한 배치가 전부 skip 이면
  //   진행이 영원히 0 이 된다. 분류도 정확히 같은 구조다 — '못 정하겠다'고 넘긴 지식은 카테고리 행이 안 생겨
  //   영원히 인박스 맨 앞에 남는다(updated_at DESC 정렬이라 더 나쁘다).
  //  ⚠ LLM 자기보고에 의존하지 않는다 — **서버가 배치를 낸 시점에** 기록한다.
  //  기준(criteria)을 바꿔 다시 보고 싶으면 upsert 의 reset_seen 으로 비운다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_classifier_seen(
      classifier_id BIGINT NOT NULL REFERENCES org_classifier(id) ON DELETE CASCADE,
      knowledge_name TEXT NOT NULL,
      task_id BIGINT,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(classifier_id, knowledge_name));
    CREATE INDEX IF NOT EXISTS org_classifier_seen_task_idx ON org_classifier_seen(task_id) WHERE task_id IS NOT NULL;
  `);
}

export async function initManagerRegistry(pool: Pool): Promise<void> {
  // ── org_manager — **관리기**(#1419 T5). 파이프라인의 마지막 단계: 쌓인 지식을 계속 옳게 유지한다. ──
  //  요구 원문: "자동으로 분류 어긋남 보정 및 지식 아웃데이티드 및 지식 간 모순, 지식-코드 간 비교 등
  //   관리기 라는 개념도 일급화해서 여기서 관리하게."
  //
  //  수집·증류·분류가 **만드는** 단계라면 관리는 **썩지 않게 하는** 단계다. 지금까지 이 일은 흩어져 있었다 —
  //   분류 어긋남은 분류체계 탭의 읽기전용 배지, 코드 괴리는 eval_domain_debt 크론, 나머지 둘은 아예 없었다.
  //   배지는 세기만 하고 고치지 않았고, 크론은 화면이 없어 무슨 일이 있었는지 볼 수 없었다.
  //
  //  4종(kind) — **판정 방식이 둘로 갈린다.** 이 구분이 설계의 핵심이다:
  //   · mismatch(분류 어긋남) · outdated(아웃데이티드) → **결정적 SQL**. LLM 없이 즉시·무료로 돈다.
  //     이미 있는 재료를 쓴다(정의 벡터 거리 · 자료 갱신시각). 매 주기 전수 판정해도 부담이 없다.
  //   · contradiction(지식 간 모순) · code_drift(지식↔코드) → **2단**. SQL 로 후보를 좁히고 LLM 이 판정한다.
  //     "이 둘이 실제로 상충하나", "이 정의와 저 코드가 어긋나나"는 의미 판단이라 SQL 로는 못 낸다.
  //     후보 좁히기를 안 하면 전 지식 쌍(n²)을 LLM 에 먹이게 된다 — 증류에서 이미 배운 비용 구조다(#1289).
  //
  //  action_level — 관리기가 발견한 뒤 **어디까지 하나**:
  //   · report(기본) = 목록에 쌓기만 · propose = 조치안을 만들어 사람 승인 대기 · auto = 즉시 적용
  //   기본이 report 인 이유: 관리기는 '이미 사람이 정리해 둔 것'을 건드리므로, 오탐 한 번의 반경이 크다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_manager(
      id BIGSERIAL PRIMARY KEY,
      key   TEXT NOT NULL,
      label TEXT,
      kind  TEXT NOT NULL,
      enabled  BOOLEAN NOT NULL DEFAULT false,
      priority INT NOT NULL DEFAULT 0,
      -- ① 스코프: 무엇을 검사하나
      match_spaces     TEXT[],
      match_categories TEXT[],
      match_types      TEXT[],
      match_provenance TEXT,
      exclude_names    TEXT[],
      lookback_days    INT,
      -- ② 민감도: 무엇을 '문제'로 볼 것인가 (kind 마다 의미가 다르다 — 화면이 kind 별 라벨을 붙인다)
      --   mismatch: 정의 거리 마진(기본 0.1) · outdated: 자료가 지식보다 며칠 앞서면(기본 30)
      --   contradiction: 후보로 볼 의미 유사도(기본 0.85) · code_drift: 미사용
      threshold REAL,
      stale_days INT,
      -- ③ 조치
      action_level TEXT NOT NULL DEFAULT 'report',
      criteria_md TEXT,
      -- ④ 실행(LLM 판정이 필요한 kind 만 씀)
      batch_size INT NOT NULL DEFAULT 20,
      model TEXT, effort TEXT, requester TEXT,
      -- ⑤ 관측
      last_run_at TIMESTAMPTZ, last_status TEXT, last_summary JSONB,
      note TEXT,
      version INT NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("org_manager", {
      org_manager_kind_chk: "kind IN ('mismatch','outdated','stale_ref','contradiction','code_drift')",
      org_manager_action_chk: "action_level IN ('report','propose','auto')",
      org_manager_batch_chk: "batch_size BETWEEN 1 AND 200",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS org_manager_key_uq ON org_manager(key);
    CREATE INDEX IF NOT EXISTS org_manager_enabled_idx ON org_manager(enabled, priority DESC, id);
  `);

  // ── org_manager_finding — 관리기가 낸 **발견**. 사람이 처리하는 일감 큐. ──
  //  ⚠ 멱등이 이 테이블의 생명이다. 관리기는 주기적으로 도는데 같은 문제는 매번 다시 발견된다 —
  //   그때마다 새 행을 만들면 큐가 같은 항목의 사본으로 뒤덮여 아무도 안 본다(그리고 '반려'가 무의미해진다).
  //   그래서 (manager_id, target_ref, dedup_key) 유니크로 **같은 발견은 한 행**이고, 재발견은 seen_count 를
  //   올리고 last_seen_at 만 갱신한다. 사람이 반려(rejected)한 것은 다시 열지 않는다(그 판단이 최신이다).
  //  dedup_key = kind 별로 '같은 문제'를 정의하는 값(모순이면 상대 지식 이름 등). 단일 대상이면 빈 문자열.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_manager_finding(
      id BIGSERIAL PRIMARY KEY,
      manager_id BIGINT NOT NULL REFERENCES org_manager(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      target_kind TEXT NOT NULL DEFAULT 'knowledge',
      target_ref  TEXT NOT NULL,
      dedup_key   TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'note',
      summary TEXT NOT NULL,
      evidence TEXT,
      proposed_action JSONB,
      state TEXT NOT NULL DEFAULT 'open',
      seen_count INT NOT NULL DEFAULT 1,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ, resolved_by TEXT, resolution TEXT);
    ${ensureCheck("org_manager_finding", {
      org_manager_finding_state_chk: "state IN ('open','accepted','rejected','resolved')",
      org_manager_finding_sev_chk: "severity IN ('note','warn','high')",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS org_manager_finding_uq
      ON org_manager_finding(manager_id, target_ref, dedup_key);
    CREATE INDEX IF NOT EXISTS org_manager_finding_open_idx
      ON org_manager_finding(state, severity, last_seen_at DESC) WHERE state='open';
    CREATE INDEX IF NOT EXISTS org_manager_finding_target_idx ON org_manager_finding(target_kind, target_ref);
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
