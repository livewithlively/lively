// 앱 활동 관측 실-DB 스모크 (#1780 D3-5) — (1) logToolCall 이 mcp_call_log.app 을 실제로 쓰는지
//  (2) org_app_activity 가 앱별·도구별로 올바르게 집계하는지. fail-first: app 컬럼 기록·집계 능력은 이 PR 이전엔 없었다.
//  ⚠ 수동 실행(docker):  node scripts/app-activity.itest.mjs
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59464, CNAME = "co-app-activity-itest";
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
  const { logToolCall } = await import("../dist/org/policies/tool-log.js");
  const { appCapabilities } = await import("../dist/capabilities/apps.js");

  await initAllSchemas();
  ok("스키마 체인 완주(mcp_call_log.app 포함)");

  // ── (1) logToolCall 이 app 컬럼을 쓴다 — fire-and-forget 이라 폴링 ──
  logToolCall({ tool: "knowledge_search", harness: "claude", actor: "m1", app: "hello", args: {}, ok: true, durationMs: 5 });
  let wrote = false;
  for (let i = 0; i < 40; i++) {
    const r = await itemsPool.query("SELECT count(*)::int n FROM mcp_call_log WHERE app='hello' AND tool='knowledge_search'");
    if (Number(r.rows[0].n) > 0) { wrote = true; break; }
    execSync("sleep 0.1");
  }
  assert.ok(wrote, "logToolCall 이 mcp_call_log.app='hello' 를 기록");
  ok("기록: logToolCall → mcp_call_log.app");

  // 일반 세션(app 없음)은 app=NULL 로 남고 집계에서 빠진다.
  logToolCall({ tool: "project_create_v6", harness: "claude", actor: "m1", app: null, args: {}, ok: true, durationMs: 3 });

  // 집계용 시드 — hello: search ok×2(위 1건 + 여기 1건), get 실패×1 · other 앱: memo ok×1
  await itemsPool.query(`INSERT INTO mcp_call_log(tool,harness,actor,args,ok,error,duration_ms,app,called_at) VALUES
    ('knowledge_search','claude','m1','{}'::jsonb,true,null,4,'hello',now()),
    ('knowledge_get','claude','m1','{}'::jsonb,false,'boom',6,'hello',now()),
    ('memo_write','claude','m2','{}'::jsonb,true,null,7,'other',now())`);

  const cap = appCapabilities.find((c) => c.name === "org_app_activity");
  assert.ok(cap, "org_app_activity 능력 존재");
  ok("org_app_activity 능력 존재");

  // ── (2) app_id='hello' 집계 ──
  const helloOut = await cap.handler({ app_id: "hello", days: 7 }, { userId: "admin" }, { source: "test" });
  const byTool = Object.fromEntries(helloOut.activity.map((r) => [r.tool, r]));
  assert.equal(byTool["knowledge_search"].calls, 2, "hello/knowledge_search 2회");
  assert.equal(byTool["knowledge_search"].ok, 2, "hello/knowledge_search ok 2");
  assert.equal(byTool["knowledge_get"].calls, 1, "hello/knowledge_get 1회");
  assert.equal(byTool["knowledge_get"].errors, 1, "hello/knowledge_get 실패 1");
  assert.ok(!helloOut.activity.some((r) => r.app !== "hello"), "app_id 필터 — hello 만");
  assert.ok(!helloOut.activity.some((r) => r.tool === "project_create_v6"), "app=NULL(일반세션) 은 집계 제외");
  ok("집계(hello): 도구별 호출수·성공/실패 정확 + NULL 제외");

  // ── 전체(app_id 없음) — hello + other, NULL 제외 ──
  const allOut = await cap.handler({ days: 7 }, { userId: "admin" }, { source: "test" });
  const apps = new Set(allOut.activity.map((r) => r.app));
  assert.ok(apps.has("hello") && apps.has("other"), "전체 집계에 hello·other");
  assert.ok(!apps.has(null) && ![...apps].includes(null), "NULL 앱 없음");
  ok("집계(전체): 여러 앱, NULL 제외");

  console.log(`\n✓ ${pass} passed`);
  await itemsPool.end().catch(() => {});
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
