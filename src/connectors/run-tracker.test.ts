// connector_run 스키마 보장 규칙(#1750 후속, 2026-08-25) — 런타임 DDL 을 언제 치는가.
//  실행: npm run build && node dist/connectors/run-tracker.test.js
//
//  배경: 다중 워크스페이스(registry)에서 게이트웨이는 표 소유자가 아닌 앱 role 로 붙는다. 그 역으로는
//  `CREATE TABLE IF NOT EXISTS` 조차 통과하지 못한다(ACL 검사가 존재 검사보다 먼저). 그래서 "이미 완성된
//  표에는 DDL 을 치지 않는다"가 이 모듈의 계약이 됐다.
import assert from "node:assert/strict";
import { runSchemaColumnsComplete, RUN_REQUIRED_COLS } from "./run-tracker.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("R1 필수 컬럼이 전부 있으면 완성 — DDL 을 치지 않는다", () => {
  assert.equal(runSchemaColumnsComplete([...RUN_REQUIRED_COLS]), true);
  // 남는 컬럼(나중에 추가된 것)이 있어도 완성 판정은 유지된다
  assert.equal(runSchemaColumnsComplete([...RUN_REQUIRED_COLS, "future_col"]), true);
});

t("R2 하나라도 빠지면 미완성 — DDL 이 필요하다", () => {
  for (const drop of RUN_REQUIRED_COLS) {
    const cols = RUN_REQUIRED_COLS.filter((c) => c !== drop);
    assert.equal(runSchemaColumnsComplete(cols), false, `${drop} 가 없으면 미완성이어야 한다`);
  }
});

t("R3 빈 표(=표 자체가 없음)는 미완성", () => {
  assert.equal(runSchemaColumnsComplete([]), false);
});

t("R4 #1419 collector_id 는 필수 목록에 있다 — 수집기별 이력 조회의 근거 컬럼", () => {
  assert.ok((RUN_REQUIRED_COLS as readonly string[]).includes("collector_id"));
  assert.ok((RUN_REQUIRED_COLS as readonly string[]).includes("heartbeat_at"));
  assert.ok((RUN_REQUIRED_COLS as readonly string[]).includes("log_total"));
});

console.log(`\n${pass} tests passed (run-tracker schema guard)`);
