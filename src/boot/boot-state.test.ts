// 부팅 상태(#2578) — /readyz 의 schema 신호가 «listen 했다»와 «스키마·시딩까지 끝났다»를 가르는 규칙.
//  2026-09-03 EC2 실측: healthz 200 직후 부트스트랩이 `column "tenant_id" does not exist` 로 죽고 설치는 '완료'.
//  여기서 못 박는 것: ① pending 에서 한 번만 나간다(restarting 뒤 체인 꼬리가 ready 를 못 덮는다) ② 체인 배선 —
//  restarting 이면 뒤 스텝을 끊고, 스키마가 선 경계(SCHEMA_ESTABLISHED_AFTER_STEP)가 실제 스텝이며 schemas 뒤다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { markSchemaBoot, schemaBootPhase, _resetSchemaBootForTest } from "./boot-state.js";
import { DB_BOOT_STEPS, SCHEMA_ESTABLISHED_AFTER_STEP } from "./housekeeping.js";

test("초기값은 pending — listen 직후 readyz 가 '준비됨'이라 우기지 않는다", () => {
  _resetSchemaBootForTest();
  assert.equal(schemaBootPhase(), "pending");
});

test("pending → ready 는 한 번뿐이고, 그 뒤 어떤 표시도 무시된다", () => {
  _resetSchemaBootForTest();
  markSchemaBoot("ready");
  assert.equal(schemaBootPhase(), "ready");
  markSchemaBoot("failed");
  markSchemaBoot("pending");
  assert.equal(schemaBootPhase(), "ready", "ready 뒤 failed/pending 으로 되돌아가면 안 된다");
});

test("★ restarting 은 ready 를 막는다 — 첫 부팅 자가 재기동은 '준비됨'이 아니다(다음 부팅이 낸다)", () => {
  _resetSchemaBootForTest();
  markSchemaBoot("restarting");
  markSchemaBoot("ready");   // 체인 꼬리가 찍는 ready
  assert.equal(schemaBootPhase(), "restarting");
});

test("failed 뒤에도 ready 로 덮이지 않는다(설치 스크립트가 failed 를 보고 즉시 멈출 수 있게)", () => {
  _resetSchemaBootForTest();
  markSchemaBoot("failed");
  markSchemaBoot("ready");
  assert.equal(schemaBootPhase(), "failed");
});

test("skipped 는 종단 — 체인을 안 도는 프로세스(매니지드 중앙 게이트웨이)가 pending 에 영영 걸리지 않는다", () => {
  _resetSchemaBootForTest();
  markSchemaBoot("skipped");
  assert.equal(schemaBootPhase(), "skipped");
  _resetSchemaBootForTest();
});

// ── 체인 배선 회귀 가드 ──
const names = DB_BOOT_STEPS.map((s) => s.name);

test("[W1] 스키마가 선 경계는 실제 스텝이고 schemas 뒤다 — 이름이 바뀌면 failed/ready 판정이 조용히 틀어진다", () => {
  assert.ok(names.includes(SCHEMA_ESTABLISHED_AFTER_STEP), `'${SCHEMA_ESTABLISHED_AFTER_STEP}' 스텝이 없다`);
  assert.ok(names.indexOf("schemas") < names.indexOf(SCHEMA_ESTABLISHED_AFTER_STEP), "schemas 가 경계보다 앞이어야 한다");
  assert.ok(names.indexOf(SCHEMA_ESTABLISHED_AFTER_STEP) < names.indexOf("seed-default-content"), "시딩은 경계 뒤(best-effort)여야 한다");
});

test("[W2] 체인은 restarting 을 보고 끊고, 끝에서 ready 를 찍고, catch 에서 경계로 failed/ready 를 가른다", () => {
  const src = readFileSync("src/boot/housekeeping.ts", "utf8");
  assert.match(src, /if \(schemaBootPhase\(\) === "restarting"\) break;/, "restarting 이면 뒤 스텝을 돌리면 안 된다(500ms 뒤 exit 와 겹친다)");
  assert.match(src, /markSchemaBoot\("ready"\);/, "체인 끝에서 ready");
  assert.match(src, /markSchemaBoot\(schemaEstablished \? "ready" : "failed"\)/, "catch 는 경계 전/후를 갈라야 한다");
  assert.match(src, /logger\.error\(\{ err \}, "schema init failed"\)/, "실패 로그 문구는 lvly-shared-migrate.sh 의 grep 마커다 — 바꾸지 마라");
  // 체인을 안 도는 두 경로는 skipped 를 찍어야 한다(안 찍으면 readyz 가 영영 503).
  assert.match(src, /if \(!process\.env\.ITEMS_DATABASE_URL\) \{ markSchemaBoot\("skipped"\); return; \}/);
  assert.match(src, /requestScopedTenancy\(\)\) \{[\s\S]{0,300}markSchemaBoot\("skipped"\);/);
});

test("[W3] 등록부 활성화 스텝은 exit 전에 restarting 을 찍는다", () => {
  const src = readFileSync("src/boot/housekeeping.ts", "utf8");
  const mark = src.indexOf('markSchemaBoot("restarting")');
  const exit = src.indexOf("setTimeout(() => process.exit(0), 500)");
  assert.ok(mark > 0 && exit > 0 && mark < exit, "restarting 표시가 exit 예약보다 앞이어야 한다");
});
