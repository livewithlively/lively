// connector_run 스키마 보장 규칙(#1750 후속, 2026-08-25) — 런타임 DDL 을 언제 치는가.
//  실행: npm run build && node dist/connectors/run-tracker.test.js
//
//  배경: 다중 워크스페이스(registry)에서 게이트웨이는 표 소유자가 아닌 앱 role 로 붙는다. 그 역으로는
//  `CREATE TABLE IF NOT EXISTS` 조차 통과하지 못한다(ACL 검사가 존재 검사보다 먼저). 그래서 "이미 완성된
//  표에는 DDL 을 치지 않는다"가 이 모듈의 계약이 됐다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runSchemaColumnsComplete, RUN_REQUIRED_COLS } from "./run-tracker.js";
import { CONNECTOR_RUN_DDL } from "./run-schema.js";

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

// #5012 — 처음부터 registry 로 설치한 박스(위시스트)에서 표가 영영 안 생겨 모든 수집기가 실패했다.
//  소유자가 치는 스키마 체인이 이 표를 만들어야 하고, 그 DDL 은 완성 판정(RUN_REQUIRED_COLS)과 어긋나면 안 된다.
t("R5 DDL 은 필수 컬럼을 전부 만든다 — 판정과 DDL 이 어긋나면 체인이 만든 표를 런타임이 미완성으로 본다", () => {
  for (const col of RUN_REQUIRED_COLS) {
    assert.match(CONNECTOR_RUN_DDL, new RegExp(`(\\(|,|ADD COLUMN IF NOT EXISTS)\\s*${col}\\s+[A-Z]`),
      `DDL 에 ${col} 이 없다`);
  }
});

t("R6 ★ 스키마 체인이 connector_run 을 만든다 — v6 뒤 · ensureTenantColumn 앞", () => {
  const chain = readFileSync(new URL("../boot/schemas.js", import.meta.url), "utf8");
  const at = (needle: string): number => chain.indexOf(needle);
  const run = at("await initConnectorRunSchema()");
  assert.ok(run > 0, "initAllSchemas 가 initConnectorRunSchema 를 부르지 않는다 — registry 신규 설치에서 표가 영영 안 생긴다");
  assert.ok(at("await initV6Schema()") < run, "v6 스키마 뒤여야 한다");
  assert.ok(run < at("await ensureTenantColumn()"), "ensureTenantColumn 앞이어야 tenant_id·격리 정책이 같은 체인에서 붙는다");
});

console.log(`\n${pass} tests passed (run-tracker schema guard)`);
