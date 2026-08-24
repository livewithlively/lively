// 앱 크론 재전개 실-DB 스모크(#1780 v2 §7-1, 사양 H2) — 재전개가 last_run_at 을 보존하는가(예정 외 즉시 실행 방지).
//  ⚠ 수동 실행(docker):  node scripts/app-cron-redeploy.itest.mjs   (*.itest.mjs 라 run-tests 에서 제외)
//  왜 실-DB 인가: upsert 의 ON CONFLICT 컬럼·CASE 보존 규칙은 SQL 이 진실이라 유닛으로 못 본다.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59475, CNAME = "co-app-cron-redeploy-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initAllSchemas } = await import("../dist/boot/schemas.js");
  const { makeDeployDeps } = await import("../dist/apps/deploy.js");
  await initAllSchemas();
  ok("스키마 체인 완주");

  const deps = makeDeployDeps("cronapp", { actor: "itest", source: "itest" });
  const item = (schedule, prompt) => ({ comp: { kind: "cron", ref: "app-cronapp-nightly", orig_name: "nightly" }, payload: { schedule, run: { kind: "headless", prompt } } });

  // 1회차 전개 — 신설, last_run_at NULL
  await deps.deploy(item("0 3 * * *", "첫 프롬프트"));
  let r = await itemsPool.query(`SELECT id, cron_expr, params, last_run_at, enabled, version FROM org_cron WHERE id='app-cronapp-nightly'`);
  assert.equal(r.rowCount, 1); assert.equal(r.rows[0].last_run_at, null); assert.equal(r.rows[0].enabled, true);
  ok("1회차 전개: 행 신설, last_run_at NULL");

  // 실행 이력 + 자동 정지 흔적을 심는다(스케줄러가 남기는 모양).
  await itemsPool.query(`UPDATE org_cron SET last_run_at=now() - interval '1 second', fail_streak=3, auto_disabled_at=now(), auto_disabled_reason='auth', enabled=false WHERE id='app-cronapp-nightly'`);
  const before = (await itemsPool.query(`SELECT last_run_at FROM org_cron WHERE id='app-cronapp-nightly'`)).rows[0].last_run_at;

  // 2회차 전개(업그레이드) — 정의는 새 값, 이력은 보존, 브레이커는 초기화
  await deps.deploy(item("0 4 * * *", "둘째 프롬프트"));
  r = await itemsPool.query(`SELECT cron_expr, params, last_run_at, enabled, fail_streak, auto_disabled_at, auto_disabled_reason, version FROM org_cron WHERE id='app-cronapp-nightly'`);
  assert.equal(r.rowCount, 1, "행은 하나(중복 삽입 없음)");
  assert.equal(r.rows[0].cron_expr, "0 4 * * *", "정의는 새 값");
  assert.match(String(JSON.stringify(r.rows[0].params)), /둘째 프롬프트/, "params 도 새 값");
  assert.equal(String(r.rows[0].last_run_at), String(before), "★ last_run_at 보존(예정 외 즉시 실행 방지)");
  assert.equal(r.rows[0].enabled, true, "재전개는 켠다");
  assert.equal(r.rows[0].fail_streak, 0); assert.equal(r.rows[0].auto_disabled_at, null); assert.equal(r.rows[0].auto_disabled_reason, null);
  ok("2회차 전개: 정의 갱신 + last_run_at 보존 + 브레이커 초기화");

  // 경계 — interval 모드에서 방금 돌았으면 재전개 직후 due 가 아니다.
  const { __test_isDue } = await import("../dist/scheduler/engine.js").catch(() => ({}));
  if (typeof __test_isDue === "function") {
    const row = (await itemsPool.query(`SELECT * FROM org_cron WHERE id='app-cronapp-nightly'`)).rows[0];
    assert.equal(__test_isDue({ ...row, cron_expr: null, interval_sec: 600 }, Date.now(), "UTC"), false, "보존된 last_run_at 이면 즉시 due 아님");
    ok("경계: interval 모드 재전개 직후 due 아님");
  } else {
    console.log("skip isDue 경계(엔진 미노출) — last_run_at 보존으로 간접 보증");
  }

  // 회수 — 종전대로 삭제
  await deps.reclaim({ kind: "cron", ref: "app-cronapp-nightly" });
  r = await itemsPool.query(`SELECT 1 FROM org_cron WHERE id='app-cronapp-nightly'`);
  assert.equal(r.rowCount, 0);
  ok("reclaim: 행 삭제(무회귀)");

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
