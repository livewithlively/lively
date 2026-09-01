// #1879 신원 전역 표 — 워크스페이스 컨텍스트에서 계정행이 갈라지지 않는다 (**실제 Postgres 필요**,
//  기본 npm test 체인 밖). 실행: npm run build && node --env-file=.env src/db/identity-global-tenant.pg-test.mjs
//
//  왜 PG 통합인가: 이 버그는 **컬럼 기본값**에 살았다. `tenant_id DEFAULT current_setting('app.tenant_id')`
//   는 타입스크립트 어디에도 안 보인다 — INSERT 문이 그 컬럼을 아예 안 적기 때문이다. 그래서 단위
//   테스트로는 영원히 안 잡히고, **다른 워크스페이스 컨텍스트에서 한 번 써 봐야** 드러난다.
//   실제로 그렇게 드러났다(2026-08-27 dev.lvly.io, 온보딩 1막이 이름을 저장한 순간).
//
//  ⚠ 이 파일은 pinIdentityGlobalTenant() 를 부른다 — 즉 **마이그레이션을 실행한다**. 붙는 DB 를 보고 돌려라.
import crypto from "node:crypto";
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { SINGLE_TENANT_ID, pinIdentityGlobalTenant } = await import(`${DIST}/db/tenant-column.js`);
const { upsertMember } = await import(`${DIST}/org/store/members.js`);
const { audit } = await import(`${DIST}/org/store/audit.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const TAG = "__ig_pg_test__";
const OTHER_TENANT = crypto.randomUUID();          // '다른 워크스페이스' 컨텍스트

const rowsOf = async (id) => (await itemsPool.query(
  `SELECT tenant_id::text t, nickname FROM org_member WHERE id=$1 ORDER BY t`, [id])).rows;

async function cleanup() {
  await itemsPool.query(`DELETE FROM org_content_audit WHERE entity_key LIKE $1`, [`${TAG}%`]);
  await itemsPool.query(`DELETE FROM org_member WHERE id LIKE $1`, [`${TAG}%`]);
}

try {
  await cleanup();
  await pinIdentityGlobalTenant();   // 기본값 못박기 — 아래 시나리오의 전제

  // ── ① 다른 워크스페이스 컨텍스트에서 써도 계정행은 하나다 ──────────────────
  const A = `${TAG}a`;
  await upsertMember({ id: A, kind: "human", display_name: A, email: `${A}@example.invalid` });
  const c = await itemsPool.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [OTHER_TENANT]);
    // 기본값이 컨텍스트를 따라가면 여기서 두 번째 행이 생긴다(그게 원래 버그다).
    await c.query(
      `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
         VALUES($1,'human',$1,$1||'@example.invalid','active','["items"]'::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE SET nickname='from-other-ws'`, [A]);
  } finally {
    await c.query(`SELECT set_config('app.tenant_id', '', false)`).catch(() => {});
    c.release();
  }
  const after = await rowsOf(A);
  chk("① 다른 워크스페이스에서 써도 계정행은 하나", after.length === 1,
    `행이 ${after.length}개 — tenant_id: ${after.map((r) => r.t).join(", ")}`);
  chk("① 그 하나는 primary 다", after[0]?.t === SINGLE_TENANT_ID, after[0]?.t);

  // ── ② 갈라진 행이 있어도 audit() 이 500 을 내지 않는다 ─────────────────────
  //  스칼라 서브쿼리가 2행을 받으면 `more than one row returned by a subquery` 로 죽는다.
  //  못박기 전에 만들어진 옛 행이 남아 있을 수 있으므로 **읽는 쪽도** 좁혀져 있어야 한다.
  await itemsPool.query(
    `INSERT INTO org_member(tenant_id, id, kind, display_name, email, state, scopes)
       VALUES($2::uuid,$1,'human',$1,$1||'@example.invalid','active','["items"]'::jsonb)`, [A, OTHER_TENANT]);
  chk("② 시나리오 준비 — 계정행이 둘", (await rowsOf(A)).length === 2);
  let threw = null;
  try { await audit("org_member", `${TAG}audit`, "update", null, { x: 1 }, A, "pg-test"); }
  catch (e) { threw = e instanceof Error ? e.message : String(e); }
  chk("② 갈라진 행이 있어도 감사가 통과한다", threw === null, threw ?? "");

  // ── ③ 접기 — 짝이 있으면 손대지 않는다(지우지도 덮어쓰지도 않는다) ──────────
  const r1 = await pinIdentityGlobalTenant();
  chk("③ 짝이 있는 행은 옮기지 않는다", (await rowsOf(A)).length === 2, "짝이 있는데 옮겼다");
  chk("③ 그 사실을 보고한다", r1.conflicts.some((s) => s.startsWith("org_member")), r1.conflicts.join(" · "));

  // ── ④ 접기 — 짝이 없으면 primary 로 옮긴다 ────────────────────────────────
  const B = `${TAG}b`;
  await itemsPool.query(
    `INSERT INTO org_member(tenant_id, id, kind, display_name, email, state, scopes)
       VALUES($2::uuid,$1,'human',$1,$1||'@example.invalid','active','["items"]'::jsonb)`, [B, OTHER_TENANT]);
  await pinIdentityGlobalTenant();
  const bRows = await rowsOf(B);
  chk("④ 짝이 없는 행은 primary 로 접힌다", bRows.length === 1 && bRows[0].t === SINGLE_TENANT_ID,
    bRows.map((r) => r.t).join(", "));
} finally {
  await cleanup();
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
