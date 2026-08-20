// 앱 principal 실-DB 스모크 — 앱 세션 토큰이 실제로 (1) app_id 를 실어오고 (2) 그 앱 grant 의 도구
//  allowlist 로 축소되는지 본다. 순수 유닛(principal.test.ts)은 decideAppTool 표만 잡고, 이 스모크는
//  mintAppToken→verifyDbToken→appToolAllowed 왕복이 실제 auth_token.app_id·org_app_grant 를 타는지 본다.
//  ⚠ 수동 실행(docker):  node scripts/app-principal.itest.mjs  (*.itest.mjs 라 run-tests 제외)
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59462, CNAME = "co-app-principal-itest";
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
  const { upsertGrant } = await import("../dist/org/store/apps.js");
  const { verifyDbToken } = await import("../dist/org/store/tokens.js");
  const { mintAppToken, appToolAllowed, _clearAppToolCache } = await import("../dist/apps/principal.js");

  await initAllSchemas();
  ok("스키마 체인 완주");

  // 멤버 + hello 앱 시드 + grant
  const MEMBER = "tester";
  // 빈 DB 라 충돌 없음 — ON CONFLICT 생략(ensureTenantColumn 이 PK 를 (tenant_id,id)로 재작성해 (id) arbiter 가 없다).
  await itemsPool.query(
    `INSERT INTO org_member(id, email, state, scopes) VALUES($1,$2,'active','["context","memory"]'::jsonb)`,
    [MEMBER, "tester@example.com"],
  );
  const seeded = await seedBuiltinApps();
  assert.ok(seeded.seeded.includes("hello") || seeded.skipped.includes("hello"), "hello 앱 시드");
  ok("멤버 + hello 앱 준비");

  // grant: hello 앱을 tester 가 knowledge_search 만 쓰도록 동의(매니페스트는 knowledge_search+get 이 상한)
  await upsertGrant("hello", MEMBER, ["context"], ["knowledge_search"], { actor: "test" });
  ok("grant 생성(tools=[knowledge_search])");

  // ── mintAppToken → 앱 세션 토큰 ──
  const { token } = await mintAppToken(MEMBER, "hello", "test");
  assert.ok(token.startsWith("lvk_"), "앱 토큰은 lvk_ 접두");
  ok("mintAppToken → 앱 토큰 발급");

  // ── verifyDbToken 이 app_id 를 실어온다 ──
  const id = await verifyDbToken(token);
  assert.ok(id, "토큰 검증 성공");
  assert.equal(id.appId, "hello", `appId 가 hello 여야 한다 (실제: ${id.appId})`);
  // scope 축소: grant.scopes=[context] ∩ member=[context,memory] = [context]
  assert.deepEqual(id.scopes, ["context"], `scope 는 [context] 로 축소돼야 한다 (실제: ${JSON.stringify(id.scopes)})`);
  ok("verifyDbToken: appId=hello + scope 축소 [context]");

  // ── appToolAllowed: grant 도구만 허용 ──
  _clearAppToolCache();
  const appUser = { userId: MEMBER, appId: "hello", email: "", scopes: ["context"], projects: ["*"] };
  assert.equal(await appToolAllowed(appUser, "knowledge_search"), true, "grant 도구 knowledge_search 는 허용");
  assert.equal(await appToolAllowed(appUser, "knowledge_get"), false, "grant 밖 knowledge_get 은 차단(매니페스트 상한엔 있으나 grant 는 search 만)");
  assert.equal(await appToolAllowed(appUser, "project_create_v6"), false, "grant 밖 도구 차단");
  ok("appToolAllowed: grant 도구만 허용, 나머지 차단");

  // ── 일반 세션(appId 없음)은 축소 없음 ──
  const normalUser = { userId: MEMBER, email: "", scopes: ["context"], projects: ["*"] };
  assert.equal(await appToolAllowed(normalUser, "project_create_v6"), true, "일반 세션은 모든 도구 통과");
  ok("일반 세션(appId 없음)은 축소 없음");

  // ── grant 회수 후 fail-closed ──
  const { revokeGrant } = await import("../dist/org/store/apps.js");
  await revokeGrant("hello", MEMBER);
  _clearAppToolCache();
  assert.equal(await appToolAllowed(appUser, "knowledge_search"), false, "grant 회수 후 fail-closed(전부 차단)");
  ok("grant 회수 → appToolAllowed fail-closed");

  console.log(`\n✓ ${pass} passed`);
  await itemsPool.end().catch(() => {}); // 컨테이너 rm 전에 풀을 닫아 'Connection terminated' 노이즈 방지
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
