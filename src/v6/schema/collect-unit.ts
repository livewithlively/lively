// v6 스키마 조각 — collect-unit(#4213 T10 #4742): **수집 단위 표**. 한 번에 모으는 묶음(채널 하나·페이지 묶음 하나·
//  메일함 하나·저장소 하나)마다 한 행이고, 누가 볼 수 있는지 · 누가 모으는지 · 어디까지 읽었는지를 서버가 쥔다.
//  설계 정본: 지식 connect-collect-tobe-claude-connector-4213 §2(표)·§3(메타데이터)·§5(한 판).
//
//  표 다섯:
//   · collect_unit          — 단위 1행. 좌표 = 앱(source.external_system 과 같은 키) + 외부 인스턴스 + 단위 id.
//                             공개범위(visibility) = 나만(me — owner_member 한 명) · 볼 수 있는 사람만(viewers) · 모두(all).
//                             수집 전 검토에서 사람이 단위마다 정한다(리브가 종류별로 먼저 제안 — 상민님 2026-10-16).
//                             경로(라이블리 수집기 / 구성원 Claude 커넥터 / 리브 직접 연결) · 상태 · 읽은 위치 · 주기 · 메타데이터.
//   · collect_unit_member   — 볼 수 있는 구성원 = 담당 후보. priority 가 작을수록 먼저 모은다(1순위가 끊기면 다음).
//                             verified_at 이 비면 «본인 신고만» — 후보(확인된 사람 뒤)일 뿐 자료는 열리지 않는다. 그 사람 커넥터로
//                             실제로 읽은 것(서버가 연 목록 실행 · 그 사람 실행의 저장)이 확인되면 채워지고, 그때부터 자료를 본다.
//   · collect_unit_source   — 단위로 모은 자료. 같은 자료가 여러 단위로 들어오면(같은 메일이 두 사람 메일함에) 행이 둘이고,
//                             자료의 볼 수 있는 사람은 그 단위들의 합집합이다. audience=false 는 «단위 체계 밖에서 먼저
//                             들어와 있던 자료(봇 수집기)» 라 공개범위를 건드리지 않는다는 표시다.
//   · collect_assignee_state — 구성원 × 커넥터의 담당 건강(로그인 끊김·커넥터 끊김·한도 초과). connector='*' 는 Claude 로그인 전체.
//                             끊김은 «수집 실행이 실패해야» 안다(로그인 파일은 만료돼도 있다 — profiles.aiAccountStatus 는 존재만 본다).
//   · collect_run          — 수집 실행(#4213 T11) 한 판 = 한 행. 시작에 그때 크기(상한·예약)를, 끝에 결과(성공·실패 사유)·최고 메모리·
//                             걸린 시간·비용을 적는다. [수집 · 증류 ▸ 수집기 설정 ▸ Claude 커넥터 수집] 의 실패율·메모리 지표가 이 표에서 나온다.
//                             원문·결과 문장은 싣지 않는다(그 사람 홈의 실행 폴더에만 있다). 90일 지난 행은 지운다(run-log.ts).
//                             목록·수집 실행은 계획(plan — 단위 id·ref·구간, 이름은 뺀다)과 저장 결과(ingest — 수)를 싣는다. ref 만으로도
//                             «누가 어떤 비공개 대화를 읽었나» 가 보이므로 이 표도 DENIED_TABLES 에 올렸다(조회는 관리자 지표 표면으로만).
//
//  ⚠ tenant_id 는 boot/schemas.ts 의 ensureTenantColumn 이 붙인다. 자연키(collect_unit 좌표 · collect_assignee_state PK)는
//   (tenant_id, …) 로 다시 쓰이므로 store 의 ON CONFLICT 는 tenant_id 를 명시한다. 대리키를 가리키는 PK(unit_id, …)는 그대로다.
//  ⚠ 볼 수 있는 구성원·단위 이름은 «누가 어떤 비공개 대화에 있나» 라 사생활이다 — db/firewall DENIED_TABLES 에 올려 두었다
//   (member_channel_meta 와 같은 급). 조회는 전용 표면(collect_units)이 볼 수 있는 구성원 기준으로 거른다.
import type { Pool } from "pg";
import { ensureCheck } from "../../org/schema/ddl-util.js";

export async function initV6CollectUnit(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collect_unit(
      id SERIAL PRIMARY KEY,
      app TEXT NOT NULL,
      instance TEXT NOT NULL DEFAULT '',
      ref TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      name TEXT,
      parent_id INT REFERENCES collect_unit(id) ON DELETE SET NULL,
      route TEXT NOT NULL DEFAULT 'member_ai',
      collector_id BIGINT REFERENCES org_collector(id) ON DELETE SET NULL,
      connector TEXT,
      state TEXT NOT NULL DEFAULT 'candidate',
      cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      read_by TEXT,
      last_item_at TIMESTAMPTZ,
      interval_sec INT,
      description TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("collect_unit", {
      collect_unit_route_chk: "route IN ('lively_collector','member_ai','liv_direct')",
      collect_unit_state_chk: "state IN ('candidate','active','excluded')",
      collect_unit_interval_chk: "interval_sec IS NULL OR interval_sec >= 60",
      collect_unit_noself_chk: "parent_id IS NULL OR parent_id <> id",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS collect_unit_coord_uq ON collect_unit(app, instance, ref);
    CREATE INDEX IF NOT EXISTS collect_unit_collector_idx ON collect_unit(collector_id) WHERE collector_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS collect_unit_parent_idx ON collect_unit(parent_id) WHERE parent_id IS NOT NULL;
    ALTER TABLE collect_unit ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'viewers';
    ALTER TABLE collect_unit ADD COLUMN IF NOT EXISTS owner_member TEXT;
    ${ensureCheck("collect_unit", {
      collect_unit_visibility_chk: "visibility IN ('me','viewers','all')",
      collect_unit_owner_chk: "visibility <> 'me' OR owner_member IS NOT NULL",
    })}
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collect_unit_member(
      unit_id INT NOT NULL REFERENCES collect_unit(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      priority INT NOT NULL DEFAULT 100,
      via TEXT NOT NULL DEFAULT 'listing',
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      verified_at TIMESTAMPTZ,
      PRIMARY KEY (unit_id, member_id));
    ${ensureCheck("collect_unit_member", {
      collect_unit_member_via_chk: "via IN ('listing','split','migrate')",
    })}
    CREATE INDEX IF NOT EXISTS collect_unit_member_member_idx ON collect_unit_member(member_id);
    ALTER TABLE collect_unit_member ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collect_unit_source(
      unit_id INT NOT NULL REFERENCES collect_unit(id) ON DELETE CASCADE,
      source_id INT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
      audience BOOLEAN NOT NULL DEFAULT true,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (unit_id, source_id));
    CREATE INDEX IF NOT EXISTS collect_unit_source_source_idx ON collect_unit_source(source_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collect_assignee_state(
      member_id TEXT NOT NULL,
      connector TEXT NOT NULL DEFAULT '*',
      state TEXT NOT NULL DEFAULT 'ok',
      reason TEXT,
      since TIMESTAMPTZ NOT NULL DEFAULT now(),
      retry_at TIMESTAMPTZ,
      fails INT NOT NULL DEFAULT 0,
      last_run_id TEXT,
      notified_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (member_id, connector));
    ${ensureCheck("collect_assignee_state", {
      collect_assignee_state_chk: "state IN ('ok','login_broken','connector_missing','quota')",
    })}
  `);

  //  ended_by — 끝을 누가 적었나. runner = 러너의 끝 신호(exit.json) · gateway = 게이트웨이가 추정한 끝(끝 신호 없음 · 판이 사라짐).
  //   늦게 온 러너의 끝은 게이트웨이 추정을 덮고, 그 반대는 없다(run-log.ts recordRunEnd).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collect_run(
      run_id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      apps TEXT[] NOT NULL DEFAULT '{}',
      model TEXT,
      cap_mb INT,
      request_mb INT,
      outcome TEXT,
      error TEXT,
      ended_by TEXT,
      mem_limit_mb INT,
      mem_start_mb INT,
      mem_peak_mb INT,
      duration_ms BIGINT,
      cost_usd DOUBLE PRECISION,
      turns INT,
      tool_calls INT,
      tool_errors INT,
      captures INT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ${ensureCheck("collect_run", {
      collect_run_ended_by_chk: "ended_by IS NULL OR ended_by IN ('runner','gateway')",
    })}
    CREATE INDEX IF NOT EXISTS collect_run_started_idx ON collect_run(started_at DESC);
    -- 저장 단계(#4213 T11): 실행 종류(probe · listing · collect) · 계획(단위·앱) · 저장 결과 · claude 를 띄운 수(커넥터가 안 떠 다시 띄운 것 포함)
    ALTER TABLE collect_run ADD COLUMN IF NOT EXISTS mode TEXT;
    ALTER TABLE collect_run ADD COLUMN IF NOT EXISTS plan JSONB;
    ALTER TABLE collect_run ADD COLUMN IF NOT EXISTS ingest JSONB;
    ALTER TABLE collect_run ADD COLUMN IF NOT EXISTS attempts INT;
  `);
}
