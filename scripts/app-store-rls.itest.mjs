// 앱 데이터 테이블 RLS 테넌트 격리 실증 (#1780 D6) — 핵심 불변식: 앱 role(NOBYPASSRLS)이 tenant A로 넣은 행을
//  tenant B 컨텍스트에선 **0행**으로 봐야 한다(FORCE RLS + tenant_isolation). owner(owner_all)는 전부 본다.
//  fail-first: createAppTable/RLS 는 이 PR 이전 없었다. ⚠ 수동 실행:  node scripts/app-store-rls.itest.mjs
import { execFileSync, execSync } from "node:child_process";
import assert from "node:assert/strict";
import pg from "pg";

const PORT = 59467, CNAME = "co-app-store-rls-itest";
const superUrl = `postgres://postgres:pw@127.0.0.1:${PORT}/postgres`;
const appUrl = `postgres://lvly_app_postgres:apppw@127.0.0.1:${PORT}/postgres`;
const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
let pass = 0; const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const sh = (c) => execSync(c, { stdio: ["ignore", "pipe", "pipe"] }).toString();
try { sh(`docker rm -f -v ${CNAME} 2>/dev/null`); } catch { /* */ }
console.log("· pg 컨테이너 기동…");
execFileSync("docker", ["run", "-d", "--name", CNAME, "-e", "POSTGRES_PASSWORD=pw", "-p", `${PORT}:5432`, "postgres:16-alpine"], { stdio: "ignore" });

let appClient = null;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { try { sh(`docker exec ${CNAME} pg_isready -U postgres`); ready = true; break; } catch { /* */ } execSync("sleep 0.5"); }
  assert.ok(ready, "pg 준비 실패");
  execSync("sleep 0.5");

  process.env.ITEMS_DATABASE_URL = superUrl;         // withOwnerConn → itemsPool(=owner)
  delete process.env.LIVELY_OWNER_DATABASE_URL;
  const { itemsPool } = await import("../dist/db/client.js");
  const { createAppTable } = await import("../dist/apps/store-schema.js");

  // 앱 role — 반드시 NOSUPERUSER NOBYPASSRLS(안 그러면 RLS 를 우회해 테스트가 거짓 통과).
  await itemsPool.query("CREATE ROLE lvly_app_postgres LOGIN PASSWORD 'apppw' NOSUPERUSER NOBYPASSRLS");
  ok("앱 role 생성(NOSUPERUSER NOBYPASSRLS)");

  // 테이블 2개(같은 논리명 'notes' 를 앱 appx·appy 가) — createAppTable 이 tenant_id+RLS 를 한 몸으로.
  const px = await createAppTable(itemsPool, "appx", { table: "notes", columns: [{ name: "body", type: "text" }] });
  const py = await createAppTable(itemsPool, "appy", { table: "notes", columns: [{ name: "body", type: "text" }] });
  assert.equal(px, "appx__notes"); assert.equal(py, "appy__notes");
  assert.notEqual(px, py, "앱 네임스페이스 — 같은 논리명이라도 물리 테이블 분리");
  ok("createAppTable — appx__notes·appy__notes(앱 격리 네임스페이스)");

  // RLS 실재 확인: FORCE + 정책 3종 여부.
  const meta = await itemsPool.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT array_agg(policyname) FROM pg_policies WHERE schemaname='app' AND tablename='appx__notes') AS pols
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname='appx__notes'`);
  assert.equal(meta.rows[0].relrowsecurity, true, "RLS enabled");
  assert.equal(meta.rows[0].relforcerowsecurity, true, "RLS forced");
  assert.ok((meta.rows[0].pols || []).includes("tenant_isolation"), "tenant_isolation 정책");
  assert.ok((meta.rows[0].pols || []).includes("owner_all"), "owner_all 정책");
  ok("RLS: ENABLE+FORCE + tenant_isolation·owner_all 정책");

  // ── 앱 role 로 접속(NOBYPASSRLS) — SET LOCAL app.tenant_id 로 tenant 컨텍스트 ──
  appClient = new pg.Client({ connectionString: appUrl });
  await appClient.connect();
  const asTenant = async (t, fn) => { await appClient.query("BEGIN"); await appClient.query("SELECT set_config('app.tenant_id',$1,true)", [t]); try { return await fn(); } finally { await appClient.query("COMMIT"); } };

  await asTenant(A, () => appClient.query("INSERT INTO app.appx__notes(body) VALUES('secret-A')"));
  await asTenant(A, () => appClient.query("INSERT INTO app.appx__notes(body) VALUES('secret-A2')"));
  ok("tenant A: 2행 삽입");

  // tenant B 컨텍스트 → A 의 행이 안 보인다(격리).
  const bView = await asTenant(B, () => appClient.query("SELECT count(*)::int n FROM app.appx__notes"));
  assert.equal(bView.rows[0].n, 0, `tenant B 는 A 의 행을 못 본다 (실제 ${bView.rows[0].n})`);
  ok("★ 테넌트 격리: tenant B → 0행(A 의 데이터 불가시)");

  // tenant B 가 넣은 건 B 만.
  await asTenant(B, () => appClient.query("INSERT INTO app.appx__notes(body) VALUES('secret-B')"));
  const aView = await asTenant(A, () => appClient.query("SELECT count(*)::int n FROM app.appx__notes"));
  const bView2 = await asTenant(B, () => appClient.query("SELECT count(*)::int n FROM app.appx__notes"));
  assert.equal(aView.rows[0].n, 2, "tenant A 는 자기 2행만");
  assert.equal(bView2.rows[0].n, 1, "tenant B 는 자기 1행만");
  ok("★ 테넌트 격리: A=2 · B=1(교차 불가)");

  // WITH CHECK — B 컨텍스트에서 남의 tenant_id 로 바꿔치기 시도 → 거부.
  await assert.rejects(
    () => asTenant(B, () => appClient.query("UPDATE app.appx__notes SET tenant_id=$1", [A])),
    /row-level security|policy|violat/i, "tenant_id 바꿔치기(WITH CHECK) 거부");
  ok("★ WITH CHECK: 남의 tenant 로 바꿔치기 거부");

  // owner(itemsPool = superuser=owner)는 owner_all 로 전부 본다.
  const ownerAll = await itemsPool.query("SELECT count(*)::int n FROM app.appx__notes");
  assert.equal(ownerAll.rows[0].n, 3, "owner_all: owner 는 전체(A2+B1=3)");
  ok("owner_all: 소유자는 전체 가시(운영·백필용)");

  console.log(`\n✓ ${pass} passed`);
  await itemsPool.end().catch(() => {});
} finally {
  if (appClient) await appClient.end().catch(() => {});
  try { sh(`docker rm -f -v ${CNAME}`); } catch { /* */ }
}
