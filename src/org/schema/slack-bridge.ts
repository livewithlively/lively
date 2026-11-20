// 슬랙 다리(#1782) — 게이트웨이가 슬랙 소켓 모드로 이벤트를 받아 앱 백그라운드 작업으로 넘기고, 앱은 금고의 봇 토큰으로 답한다.
//  판정은 org/slack-bridge/plan.ts · 행은 store.ts · 연결은 socket.ts · 흐름은 manager.ts.
//
//  ⚠ 토큰 **값**은 이 표들에 없다 — 다리 한 줄은 금고 칸의 참조(owner · kind · scope_key)만 갖는다. 값은 연결할 때 · 앱이 부를 때 금고에서 읽는다.
//  tenant_id 는 다른 표처럼 ensureTenantColumn 이 붙인다 — 자연키 UNIQUE 는 tenant_id 를 앞에 넣어 다시 만들고, 저장소(store.ts)의 upsert 는 그 꼴을 중재자로 쓴다.
//   ⚠ 이 파일(스키마 초기화)에는 tenant_id 중재자를 쓰지 않는다 — 신규 설치에선 이 DDL 이 그 칸보다 먼저 돈다(db/tenant-column.test 가 지킨다).
import type pg from "pg";

export async function initSlackBridge(pool: pg.Pool): Promise<void> {
  //  org_slack_bridge — 다리 한 줄: 슬랙 앱 하나(앱 수준 토큰) ↔ 라이블리 앱 하나의 라우트.
  //   events · channels · bot_messages · bot_ids = 거르기(받은 것 중 무엇을 넘기나 — bot_ids 는 넘길 봇 · 워크플로, 비면 모든 봇) ·
  //   run_as = 사람이 쓰지 않은 글(워크플로 · 봇)을 돌릴 구성원 · react = 넘긴 글에 다는 반응.
  //   status = 연결을 쥔 게이트웨이가 적는 마지막 상태(연결 여부 · 받은/넘긴/거른 수 · 마지막 오류) — 여러 프로세스가 같은 다리를 쥐면 마지막에 적은 것이 남는다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_slack_bridge(
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      route TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      app_token_ref JSONB NOT NULL,
      bot_token_ref JSONB NOT NULL,
      events TEXT[] NOT NULL DEFAULT ARRAY['message','app_mention','block_actions']::text[],
      channels TEXT[] NOT NULL DEFAULT '{}'::text[],
      bot_messages BOOLEAN NOT NULL DEFAULT false,
      bot_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
      run_as TEXT,
      react TEXT,
      note TEXT,
      status JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    );
  `);
  //  org_slack_bridge_event — 한 번만 넘기기. 슬랙은 같은 이벤트를 다시 보낸다(retry_attempt · 다시 연결) — 열쇠(event_id · trigger_id · envelope_id)를 먼저 적은
  //   쪽만 작업을 만든다. 본문은 적지 않는다(무엇이 · 언제 · 어떻게 끝났나만). 7일이 지나면 지운다(정비 pruneBridgeRecords).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_slack_bridge_event(
      id BIGSERIAL PRIMARY KEY,
      bridge_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      outcome TEXT,
      job_id BIGINT,
      UNIQUE(bridge_id, event_key)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_slack_bridge_event_at_idx ON org_slack_bridge_event(received_at);`);
  //  org_slack_bridge_call — 앱이 다리의 봇 토큰으로 슬랙을 부른 기록(slack_bridge_call). 메서드 · 채널 · ts · 결과만 — 보낸 글은 적지 않는다.
  //   30일이 지나면 지운다(정비 pruneBridgeRecords).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_slack_bridge_call(
      id BIGSERIAL PRIMARY KEY,
      bridge_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      member TEXT,
      job_id BIGINT,
      method TEXT NOT NULL,
      channel TEXT,
      ts TEXT,
      ok BOOLEAN NOT NULL,
      error TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_slack_bridge_call_idx ON org_slack_bridge_call(bridge_id, id DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_slack_bridge_call_at_idx ON org_slack_bridge_call(at);`);
}
