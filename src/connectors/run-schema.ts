// connector_run 표의 DDL — 단일 출처(#5012).
//
//  ★ 왜 스키마 체인(boot/schemas.ts)에도 들어가는가(실측 2026-10-26, 위시스트 셀프호스트):
//   이 표는 원래 run-tracker 가 첫 사용 때 **지연 생성**했다. 다중 워크스페이스(registry)로 **처음부터** 설치한
//   박스에서는 게이트웨이가 앱 role(lvly_app_<db>)로 붙어 그 DDL 이 `permission denied for schema public` 으로
//   막히고, 부팅의 소유자 스키마 자식(schema-init-child)은 체인에 이 표가 없어 만들지 않았다 — 그래서 표가
//   **영영 안 생겼고** 모든 수집기가 연결 직후부터 실패했다(화면은 «수집 중»). #1750 의 수정(introspection)은
//   표가 이미 있던 dev 에서만 성립했다. 소유자가 치는 체인에 넣으면 registry·단일 어느 쪽이든 부팅 때 생긴다.
//   ensureTenantColumn **앞**에서 불러야 같은 체인에서 tenant_id·격리 정책이 붙는다.
import { itemsPool } from "../db/client.js";

export const CONNECTOR_RUN_DDL = `
      CREATE TABLE IF NOT EXISTS connector_run(
        id BIGSERIAL PRIMARY KEY,
        system TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'incremental',
        trigger TEXT NOT NULL DEFAULT 'cron',
        status TEXT NOT NULL DEFAULT 'running',
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        exit_code INT,
        stats JSONB,
        log TEXT NOT NULL DEFAULT '',
        started_by TEXT);
      CREATE INDEX IF NOT EXISTS connector_run_system_idx ON connector_run(system, started_at DESC);
      ALTER TABLE connector_run ADD COLUMN IF NOT EXISTS pid INT;
      ALTER TABLE connector_run ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE connector_run ADD COLUMN IF NOT EXISTS log_total BIGINT NOT NULL DEFAULT 0;
      UPDATE connector_run SET log_total = char_length(log) WHERE log_total = 0 AND log <> '';
      -- #1419 T1 — 실행을 **수집기 인스턴스**에 귀속. 구 행은 NULL(레거시 system 단위 실행)로 남고,
      --  화면은 collector_id 가 있으면 그 수집기 이력으로, 없으면 종전처럼 system 이력으로 읽는다.
      --  ⚠ FK 를 걸지 않는다 — 수집기를 지워도 그 실행 이력(무슨 일이 있었나)은 남아야 한다(감사 성격).
      ALTER TABLE connector_run ADD COLUMN IF NOT EXISTS collector_id BIGINT;
      CREATE INDEX IF NOT EXISTS connector_run_collector_idx ON connector_run(collector_id, started_at DESC)
        WHERE collector_id IS NOT NULL;
    `;

/** 소유자 역으로 표를 보장한다(멱등) — 스키마 체인과 run-tracker 의 지연 생성이 같은 문장을 친다. */
export async function initConnectorRunSchema(): Promise<void> {
  await itemsPool.query(CONNECTOR_RUN_DDL);
}
