// 앱 설치 파이프라인 실-DB 스모크 — 빈 pg 에 전체 스키마 체인을 올린 뒤 seedBuiltinApps() 로 builtin 'hello' 앱을
//  실제로 설치하고, 저널(org_app)·조인(org_app_component)·전개 대상(org_harness_asset)이 올바로 남는지 본다.
//  두 번째 호출이 멱등(skipped)인지도 확인한다.
//  ⚠ 수동 실행(docker). 실행:  node scripts/apps-install.itest.mjs
//   *.itest.mjs 라 run-tests(자동)에서 제외된다(schema-init.itest.mjs 와 동일 규약).
//  왜 실-DB 인가: deploy.ts 의 kind→스토어 배선은 순수 유닛으로 못 잡는다(upsert 실제 컬럼·ON CONFLICT·조인).
//   유닛(deploy.test.ts)은 디스패치 표만, 이 스모크는 실제 전개가 DB 에 착지하는지를 본다.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const PORT = 59461, CNAME = "co-apps-install-itest";
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
  const { appAssetId } = await import("../dist/apps/manifest.js");

  // ── 스키마 체인 완주(org_app·org_app_component·org_harness_asset·org_cron 등 준비) ──
  await initAllSchemas();
  ok("전체 스키마 체인 완주(initAllSchemas)");

  // ── 1회차 시딩: hello 신규 설치 ──
  const r1 = await seedBuiltinApps();
  assert.ok(r1.seeded.includes("hello"), `1회차 seeded 에 hello 가 있어야 한다 (실제: ${JSON.stringify(r1)})`);
  ok(`seedBuiltinApps 1회차 — hello seeded (${JSON.stringify(r1)})`);

  // ── org_app: hello status=active ──
  {
    const a = await itemsPool.query(`SELECT id, status, content_hash, source FROM org_app WHERE id='hello'`);
    assert.equal(a.rowCount, 1, "org_app 에 hello 행이 있어야 한다");
    assert.equal(a.rows[0].status, "active", "hello status 는 active 여야 한다");
    assert.ok(a.rows[0].content_hash, "hello content_hash 가 채워져야 한다");
    ok("org_app: hello status=active + content_hash 존재");
  }

  // ── org_app_component: ui_page(main) + harness_asset 행 ──
  let harnessRef = null;
  {
    const c = await itemsPool.query(`SELECT kind, ref, orig_name FROM org_app_component WHERE app_id='hello' ORDER BY kind, ref`);
    const kinds = c.rows.map((x) => `${x.kind}:${x.ref}`);
    assert.ok(c.rows.some((x) => x.kind === "ui_page" && x.ref === "main"), `ui_page:main 조인이 있어야 한다 (실제: ${JSON.stringify(kinds)})`);
    const ha = c.rows.find((x) => x.kind === "harness_asset");
    assert.ok(ha, `harness_asset 조인이 있어야 한다 (실제: ${JSON.stringify(kinds)})`);
    assert.equal(ha.orig_name, "greet", "harness_asset orig_name 은 greet 여야 한다");
    harnessRef = ha.ref;
    ok(`org_app_component: ui_page:main + harness_asset(${harnessRef}) 조인 존재`);
  }

  // ── org_harness_asset: greet 스킬(id = 앱스코프 ref) ──
  {
    // id 가 앱스코프 ref(appAssetId('hello','greet'))와 일치하는지 이중 확인.
    assert.equal(harnessRef, appAssetId("hello", "greet"), "harness_asset ref = appAssetId('hello','greet') 여야 한다");
    const h = await itemsPool.query(`SELECT id, kind, harness, label, enabled, body FROM org_harness_asset WHERE id=$1`, [harnessRef]);
    assert.equal(h.rowCount, 1, "org_harness_asset 에 greet 스킬 행이 있어야 한다");
    assert.equal(h.rows[0].kind, "skill", "kind=skill");
    assert.equal(h.rows[0].harness, "claude", "harness=claude");
    assert.equal(h.rows[0].enabled, true, "enabled=true");
    assert.ok(String(h.rows[0].body).length > 0, "SKILL.md 본문이 실려야 한다");
    ok(`org_harness_asset: greet 스킬(id=${harnessRef}, kind=skill, harness=claude, enabled)`);
  }

  // ── 2회차 시딩: 변경 없음 → 멱등(skipped) ──
  {
    const r2 = await seedBuiltinApps();
    assert.ok(r2.skipped.includes("hello"), `2회차 skipped 에 hello 가 있어야 한다 (실제: ${JSON.stringify(r2)})`);
    assert.ok(!r2.seeded.includes("hello") && !r2.updated.includes("hello"), "2회차엔 재설치/업데이트가 없어야 한다");
    ok(`seedBuiltinApps 2회차 — hello skipped (멱등, ${JSON.stringify(r2)})`);
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
