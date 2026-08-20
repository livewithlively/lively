// 앱 UI 브리지 tools/call 보안 실-DB 스모크 (#1780 PR5b) — 핵심 불변식:
//  (1) grant 안 도구만 실행(앱 principal) (2) grant 밖 도구 403 (3) denylist(me_app_* 등) grant 에 있어도 403
//  (4) 스코프 캡: 멤버가 admin 이어도 grant 스코프에 없으면 admin 도구 403 (5) grant 없으면 403
//  (6) 실행은 앱 principal(mcp_call_log.app=앱). fail-first: 이 브리지(org_app_tool_call)는 이 PR 이전 없었다.
//  ⚠ 수동 실행(docker):  node scripts/app-tool-call.itest.mjs
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59466, CNAME = "co-app-toolcall-itest";
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
  const { seedBuiltinApps } = await import("../dist/apps/seed.js");
  const { upsertGrant, revokeGrant } = await import("../dist/org/store/apps.js");
  const { appToolCallCapabilities } = await import("../dist/capabilities/app-tool-call.js");
  const { _clearAppToolCache } = await import("../dist/apps/principal.js");

  await initAllSchemas();
  await seedBuiltinApps();
  const MEMBER = "m1";
  await itemsPool.query(`INSERT INTO org_member(id,email,state,scopes) VALUES($1,$2,'active','["context","memory","admin"]'::jsonb)`, [MEMBER, "m1@x.com"]);
  ok("스키마 + hello 시드 + 멤버(admin 포함)");

  const cap = appToolCallCapabilities.find((c) => c.name === "org_app_tool_call");
  assert.ok(cap, "org_app_tool_call 능력 존재(= 이 PR 로 생김)");
  ok("org_app_tool_call 능력 존재");

  // 멤버는 admin 을 갖지만, grant 는 context 스코프 + 도구 [org_apps, me_app_grant, org_app_set_enabled] 로 준다(직접 upsert).
  await upsertGrant("hello", MEMBER, ["context"], ["org_apps", "me_app_grant", "org_app_set_enabled"], { actor: "test" });
  _clearAppToolCache();
  const member = { userId: MEMBER, email: "m1@x.com", scopes: ["context", "memory", "admin"], projects: ["*"] };
  const ctx = { source: "test" };

  // (1) grant 안 + scope null 도구(org_apps) → 실행됨(앱 principal), 결과 반환.
  const r1 = await cap.handler({ app_id: "hello", name: "org_apps", arguments: {} }, member, ctx);
  assert.ok(r1 && r1.result && Array.isArray(r1.result.apps), "org_apps 실행 결과(apps 배열)");
  assert.equal(r1.app_id, "hello");
  ok("(1) grant 안 도구 org_apps → 앱 principal 로 실행");

  // (2) grant 밖 도구(도구 allowlist 게이트). org_app_get 은 scope null(스코프 통과)이지만 grant.tools 에 없다 → requireAppTool 403.
  await assert.rejects(() => cap.handler({ app_id: "hello", name: "org_app_get", arguments: { app_id: "hello" } }, member, ctx), /쓸 수 없|권한 밖|allow|Forbidden|lacks/i, "grant 밖 도구(allowlist) 차단");
  ok("(2) grant 밖 도구(scope 통과·allowlist 밖) → 403");

  // (3) denylist: me_app_grant 는 grant.tools 에 있어도 브리지가 거부.
  await assert.rejects(() => cap.handler({ app_id: "hello", name: "me_app_grant", arguments: { app_id: "hello" } }, member, ctx), /앱 UI 에서 호출할 수 없|403/i, "denylist 도구 거부");
  ok("(3) denylist me_app_grant → 403(grant 에 있어도)");

  // (4) 스코프 캡: org_app_set_enabled 는 admin 필요. 멤버는 admin 이지만 grant 스코프는 context 뿐 → appUser 는 admin 없음 → 403.
  await assert.rejects(() => cap.handler({ app_id: "hello", name: "org_app_set_enabled", arguments: { app_id: "hello", enabled: true } }, member, ctx), /scope|권한|admin|403/i, "grant 스코프 밖(admin) 차단");
  ok("(4) 스코프 캡: 멤버 admin 이어도 grant 스코프 밖이면 admin 도구 403");

  // (6) 앱 principal 로 실행됐나 — mcp_call_log.app='hello' 기록(위 org_apps 성공분).
  let logged = false;
  for (let i = 0; i < 40; i++) {
    const r = await itemsPool.query("SELECT count(*)::int n FROM mcp_call_log WHERE app='hello' AND tool='org_apps' AND ok=true");
    if (Number(r.rows[0].n) > 0) { logged = true; break; }
    execSync("sleep 0.1");
  }
  assert.ok(logged, "org_apps 호출이 mcp_call_log.app=hello 로 기록(앱 principal)");
  ok("(6) 실행 귀속: mcp_call_log.app=hello");

  // (5) grant 회수 후 → 403.
  await revokeGrant("hello", MEMBER); _clearAppToolCache();
  await assert.rejects(() => cap.handler({ app_id: "hello", name: "org_apps", arguments: {} }, member, ctx), /동의|grant|403/i, "grant 회수 후 차단");
  ok("(5) grant 회수 → 403");

  // 비활성 앱 → 409.
  const { setAppEnabled } = await import("../dist/org/store/apps.js");
  await upsertGrant("hello", MEMBER, ["context"], ["org_apps"], { actor: "test" }); _clearAppToolCache();
  await setAppEnabled("hello", false, { actor: "test" });
  await assert.rejects(() => cap.handler({ app_id: "hello", name: "org_apps", arguments: {} }, member, ctx), /활성|409/i, "비활성 앱 차단");
  ok("비활성 앱 → 409");

  console.log(`\n✓ ${pass} passed`);
  await itemsPool.end().catch(() => {});
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
