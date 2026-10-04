// 앱 설치 파이프라인 실-DB 스모크 — 빈 pg 에 전체 스키마 체인을 올린 뒤 seedBuiltinApps(픽스처) 로 예시 앱 'hello' 를 builtin 으로
//  실제로 설치하고, 저널(org_app)·조인(org_app_component)·전개 대상(org_harness_asset)이 올바로 남는지 본다.
//  두 번째 호출이 멱등(skipped)인지도 확인한다.
//  #4554 — hello 는 제품에서 은퇴했다(패키지는 scripts/fixtures/apps/hello 로 옮겼다). 마지막 절이 그 은퇴를 잰다:
//   제품 폴더(apps/builtin)로 시딩하면 builtin 으로 남아 있던 hello 가 회수되고, 같은 id 로 워크스페이스가 직접 깐 앱은 남는다.
//  ⚠ 수동 실행(docker). 실행:  node scripts/apps-install.itest.mjs
//   *.itest.mjs 라 run-tests(자동)에서 제외된다(schema-init.itest.mjs 와 동일 규약).
//  왜 실-DB 인가: deploy.ts 의 kind→스토어 배선은 순수 유닛으로 못 잡는다(upsert 실제 컬럼·ON CONFLICT·조인).
//   유닛(deploy.test.ts)은 디스패치 표만, 이 스모크는 실제 전개가 DB 에 착지하는지를 본다.
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";

const FIXTURE_APPS = new URL("./fixtures/apps", import.meta.url).pathname;   // #4554 — 예시 앱 hello 는 제품에서 빠져 시험 픽스처로만 남았다
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
  const r1 = await seedBuiltinApps(FIXTURE_APPS);
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
    // #1884 — 앱 자산은 하네스를 가리지 않는다("all"). "claude" 로 심으면 codex 세션엔 한 개도 안 깔린다.
    assert.equal(h.rows[0].harness, "all", "harness=all");
    assert.equal(h.rows[0].enabled, true, "enabled=true");
    assert.ok(String(h.rows[0].body).length > 0, "SKILL.md 본문이 실려야 한다");
    ok(`org_harness_asset: greet 스킬(id=${harnessRef}, kind=skill, harness=all, enabled)`);
  }

  // ── 2회차 시딩: 변경 없음 → 멱등(skipped) ──
  {
    const r2 = await seedBuiltinApps(FIXTURE_APPS);
    assert.ok(r2.skipped.includes("hello"), `2회차 skipped 에 hello 가 있어야 한다 (실제: ${JSON.stringify(r2)})`);
    assert.ok(!r2.seeded.includes("hello") && !r2.updated.includes("hello"), "2회차엔 재설치/업데이트가 없어야 한다");
    assert.deepEqual(r2.retired, [], "패키지 폴더에 아직 있는 앱은 은퇴 목록에 있어도 회수하지 않는다");
    ok(`seedBuiltinApps 2회차 — hello skipped (멱등, ${JSON.stringify(r2)})`);
  }

  // ── 은퇴(#4554): 제품 폴더(apps/builtin)엔 hello 가 없다 → builtin 으로 남아 있던 hello 를 회수한다 ──
  {
    const r3 = await seedBuiltinApps();
    assert.deepEqual(r3.retired, ["hello"], `제품 폴더로 시딩하면 hello 가 회수돼야 한다 (실제: ${JSON.stringify(r3)})`);
    assert.ok(!r3.seeded.includes("hello") && !r3.updated.includes("hello") && !r3.skipped.includes("hello"), "제품 폴더에 hello 패키지가 없어야 한다");
    assert.ok(r3.seeded.length > 0, `배선 — 제품의 빌트인 앱이 실제로 심겼다 (실제: ${JSON.stringify(r3)})`);
    const a = await itemsPool.query(`SELECT 1 FROM org_app WHERE id='hello'`);
    assert.equal(a.rowCount, 0, "org_app 에서 hello 행이 사라져야 한다");
    const c = await itemsPool.query(`SELECT 1 FROM org_app_component WHERE app_id='hello'`);
    assert.equal(c.rowCount, 0, "org_app_component 조인도 사라져야 한다");
    const h = await itemsPool.query(`SELECT 1 FROM org_harness_asset WHERE id=$1`, [harnessRef]);
    assert.equal(h.rowCount, 0, "greet 스킬(전개물)도 회수돼야 한다");
    const others = await itemsPool.query(`SELECT count(*)::int n FROM org_app WHERE source->>'kind'='builtin'`);
    assert.equal(others.rows[0].n, r3.seeded.length, "다른 빌트인 앱은 그대로다(은퇴 목록의 앱만 지운다)");
    ok(`은퇴: hello 회수(앱 행 · 조인 · greet 스킬) — 다른 빌트인 ${others.rows[0].n}개는 그대로`);

    const r4 = await seedBuiltinApps();
    assert.deepEqual(r4.retired, [], "이미 회수한 앱은 다음 시딩에서 다시 회수하지 않는다(멱등)");
    ok("은퇴 2회차 — 멱등");
  }

  // ── 은퇴는 builtin 만: 워크스페이스가 같은 id(hello)로 직접 깐 앱은 그 워크스페이스의 것이다 ──
  {
    const { loadAppPackage } = await import("../dist/apps/loader.js");
    const { installLoadedApp } = await import("../dist/apps/install-run.js");
    const loaded = await loadAppPackage(FIXTURE_APPS + "/hello");
    await installLoadedApp(loaded, { kind: "path", path: FIXTURE_APPS + "/hello" }, { actor: "test", source: "test" });
    const before = await itemsPool.query(`SELECT source->>'kind' k FROM org_app WHERE id='hello'`);
    assert.equal(before.rows[0]?.k, "path", "배선 — hello 가 builtin 이 아닌 출처로 깔렸다");
    const r5 = await seedBuiltinApps();
    assert.deepEqual(r5.retired, [], "builtin 이 아닌 hello 는 회수하지 않는다");
    const after = await itemsPool.query(`SELECT 1 FROM org_app WHERE id='hello'`);
    assert.equal(after.rowCount, 1, "워크스페이스가 깐 hello 는 남는다");
    ok("은퇴는 builtin 만 — 워크스페이스가 직접 깐 hello 는 남는다");
  }

  await itemsPool.end();
  console.log(`\n${pass} passed`);
} finally {
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
