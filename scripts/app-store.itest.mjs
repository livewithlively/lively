// 앱 데이터 store_* 능력(핸들러 게이트) 실-DB 스모크 (#1780 D6) — 설치가 app 테이블을 만들고,
//  store_insert/query/tables 가 앱 principal 로 자기 테이블만 다루는지. (테넌트 RLS 격리는 app-store-rls.itest 가 별도 실증.)
//  fail-first: store_* 는 이 PR 이전 없었다. ⚠ 수동 실행:  node scripts/app-store.itest.mjs
import { execFileSync, execSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import assert from "node:assert/strict";

const PORT = 59472, CNAME = "co-app-store-itest";
const url = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

let fx = null;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패"); execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = url; delete process.env.LIVELY_OWNER_DATABASE_URL;
  const { itemsPool } = await import("../dist/db/client.js");
  const { initAllSchemas } = await import("../dist/boot/schemas.js");
  const { appCapabilities } = await import("../dist/capabilities/apps.js");
  const { appStoreCapabilities } = await import("../dist/capabilities/app-store.js");
  await initAllSchemas();
  ok("스키마 체인 완주");

  const installCap = appCapabilities.find((c) => c.name === "org_app_install");
  const removeCap = appCapabilities.find((c) => c.name === "org_app_remove");
  const ins = appStoreCapabilities.find((c) => c.name === "store_insert");
  const qry = appStoreCapabilities.find((c) => c.name === "store_query");
  const tbl = appStoreCapabilities.find((c) => c.name === "store_tables");
  assert.ok(ins && qry && tbl, "store_insert/query/tables 능력 존재(= 이 PR)");
  ok("store_* 능력 존재");

  // 픽스처 앱: data.tables=[notes(body text, done bool)]
  fx = await mkdtemp(path.join(os.tmpdir(), "store-app-"));
  await writeFile(path.join(fx, "lively-app.json"), JSON.stringify({
    id: "dataapp", title: "데이터앱", version: "0.1.0",
    permissions: { scopes: ["context"], tools: ["store_insert", "store_query", "store_tables"] },
    data: { tables: [{ name: "notes", columns: [{ name: "body", type: "text" }, { name: "done", type: "bool" }] }] },
  }));
  const admin = { userId: "admin", memberId: "admin", email: "", scopes: ["admin", "context"], projects: ["*"] };
  await installCap.handler({ source: { kind: "path", path: fx } }, admin, { source: "test" });
  ok("설치(app 테이블 생성 포함)");

  // 설치가 물리 테이블을 만들었나.
  const exists = await itemsPool.query("SELECT to_regclass('app.dataapp__notes') AS t");
  assert.ok(exists.rows[0].t, "app.dataapp__notes 물리 테이블 생성됨");
  ok("설치 → app.dataapp__notes 생성");

  const appUser = { userId: "m1", email: "", appId: "dataapp", scopes: ["context"], projects: ["*"] };
  const normalUser = { userId: "m1", email: "", scopes: ["context"], projects: ["*"] };
  const ctx = { source: "test" };

  // store_tables → 선언 목록.
  const t = await tbl.handler({}, appUser, ctx);
  assert.equal(t.tables.length, 1); assert.equal(t.tables[0].name, "notes");
  ok("store_tables → 선언 테이블 목록");

  // store_insert → id 반환, store_query → 조회.
  const i1 = await ins.handler({ table: "notes", row: { body: "first", done: false } }, appUser, ctx);
  const i2 = await ins.handler({ table: "notes", row: { body: "second", done: true } }, appUser, ctx);
  assert.ok(i1.id && i2.id && i1.id !== i2.id, "삽입 id 반환(증가)");
  ok("store_insert → 행 삽입(id 반환)");

  const all = await qry.handler({ table: "notes" }, appUser, ctx);
  assert.equal(all.rows.length, 2, "2행 조회");
  const done = await qry.handler({ table: "notes", match: { done: true } }, appUser, ctx);
  assert.equal(done.rows.length, 1, "match 필터(done=true) 1행");
  assert.equal(done.rows[0].body, "second");
  ok("store_query → 전체 + match 필터");

  // store_update — match 필수, 왕복.
  const upd = appStoreCapabilities.find((c) => c.name === "store_update");
  const del = appStoreCapabilities.find((c) => c.name === "store_delete");
  const u = await upd.handler({ table: "notes", match: { done: false }, set: { done: true } }, appUser, ctx);
  assert.equal(u.changed, 1, "update changed=1(first: done false→true)");
  const bothDone = await qry.handler({ table: "notes", match: { done: true } }, appUser, ctx);
  assert.equal(bothDone.rows.length, 2, "update 후 done=true 2행");
  await assert.rejects(() => upd.handler({ table: "notes", set: { done: false } }, appUser, ctx), /match/i, "match 없는 update 거부(전량 방지)");
  ok("store_update → match 대상 수정 + match 없으면 거부");

  // store_delete — match 필수, 왕복.
  const d = await del.handler({ table: "notes", match: { body: "first" } }, appUser, ctx);
  assert.equal(d.deleted, 1, "delete deleted=1");
  const left = await qry.handler({ table: "notes" }, appUser, ctx);
  assert.equal(left.rows.length, 1, "delete 후 1행");
  await assert.rejects(() => del.handler({ table: "notes" }, appUser, ctx), /match/i, "match 없는 delete 거부(전량 방지)");
  ok("store_delete → match 대상 삭제 + match 없으면 거부");

  // 게이트: 일반 세션(appId 없음) → 400.
  await assert.rejects(() => ins.handler({ table: "notes", row: { body: "x" } }, normalUser, ctx), /앱 세션|principal|400/i, "일반 세션 차단");
  ok("일반 세션(appId 없음) → 차단");

  // 앱 격리: 다른 앱(appId=other)이 dataapp 의 테이블명으로 조회 → other 는 notes 미선언 → 404.
  const otherUser = { userId: "m1", email: "", appId: "other", scopes: ["context"], projects: ["*"] };
  await assert.rejects(() => qry.handler({ table: "notes" }, otherUser, ctx), /없음|선언되지|404/i, "다른 앱은 이 테이블 접근 불가(선언·물리명)");
  ok("★ 앱 격리: 다른 앱은 남의 테이블 접근 불가");

  // 선언 안 한 테이블 → 404.
  await assert.rejects(() => qry.handler({ table: "ghost" }, appUser, ctx), /선언되지|404/i, "미선언 테이블 차단");
  ok("미선언 테이블 → 404");

  // 제거 시 app 테이블 DROP.
  await removeCap.handler({ app_id: "dataapp" }, admin, ctx);
  const gone = await itemsPool.query("SELECT to_regclass('app.dataapp__notes') AS t");
  assert.equal(gone.rows[0].t, null, "제거 시 app 테이블 DROP");
  ok("제거 → app.dataapp__notes DROP");

  console.log(`\n✓ ${pass} passed`);
  await itemsPool.end().catch(() => {});
} finally {
  if (fx) await rm(fx, { recursive: true, force: true }).catch(() => {});
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
