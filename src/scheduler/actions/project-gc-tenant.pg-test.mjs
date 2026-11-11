// 자동 생성 프로젝트 정리(project_gc)의 워크스페이스 격리 — 실제 Postgres 필요(기본 유닛 체인 밖, CI pg-test 잡 · .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/scheduler/actions/project-gc-tenant.pg-test.mjs
//
// 왜 이 계층인가: 후보 SQL · 쓰기 어디에도 워크스페이스 조건이 없다 — 어느 워크스페이스 행을 보고 닫는지는 풀의 테넌트 바인딩과
//  행 수준 보안이 전부 정한다(project-gc.ts 머리말). 목 풀로는 안 보이므로 등록부 모드 게이트웨이와 같은 조건(비특권 앱 역할 ·
//  ensureTenantPolicies 가 건 FORCE RLS · 등록부 리졸버)으로 돌린다. 하네스는 org/policies/call-log-prune.pg-test.mjs 와 같다.
//
//  사양 · 엣지 표:
//   T0 배선 — 앱 역할은 RLS 를 못 넘고, project 에 FORCE RLS 가 걸렸다
//   T1 A 컨텍스트의 후보에는 A 의 껍데기만 있다 — 같은 조건의 B 껍데기는 없다
//   T2 A 컨텍스트에서 mode=on 으로 돌리면 A 껍데기만 닫히고 휴지통에 간다 — B 껍데기는 그대로 열려 있다
import pg from "pg";
import { execFileSync } from "node:child_process";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_project_gc_tenant";
const ROLE = `lvly_app_${DB}`;            // org/tenancy/activate.ts appRoleName(current_database()) 과 같은 이름 — 정책이 이 역할에 걸린다
const ROLE_PW = "pgt-project-gc";
const dsnFor = (db, role) => { const u = new URL(BASE); u.pathname = "/" + db; if (role) { u.username = role.name; u.password = role.pw; } return u.toString(); };
const D = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const J = JSON.stringify;
const TA = "aaaaaaaa-0000-4000-8000-0000000000c1", TB = "bbbbbbbb-0000-4000-8000-0000000000c2";

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };

const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`DROP ROLE IF EXISTS ${ROLE}`);
let dbc = null, itemsPool = null;
try {
  await su.query(`CREATE DATABASE ${DB}`);
  await su.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  const OWNER = dsnFor(DB);
  dbc = new pg.Client({ connectionString: OWNER }); await dbc.connect();
  await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");
  const childEnv = { ...process.env, ITEMS_DATABASE_URL: OWNER };
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID", "LIVELY_TENANCY_MODE", "EMBEDDINGS_PROVIDER"]) delete childEnv[k];
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { initAllSchemas } = await import(${J(`${D}/boot/schemas.js`)});
    await initAllSchemas({ quiet: true });
    const { ensureTenantPolicies } = await import(${J(`${D}/org/tenancy/activate.js`)});
    await ensureTenantPolicies();
    const { itemsPool } = await import(${J(`${D}/db/client.js`)});
    await itemsPool.end();
    process.exit(0);`], { env: childEnv, stdio: ["ignore", "ignore", "inherit"], timeout: 300_000 });
  await dbc.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);

  const forced = (await dbc.query(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname='project'`)).rows[0]?.f;
  const role = (await dbc.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1`, [ROLE])).rows[0];
  chk("T0 앱 역할은 RLS 를 못 넘고 project 에 FORCE RLS 가 걸렸다", forced === true && role && !role.rolsuper && !role.rolbypassrls, J({ forced, role }));

  process.env.ITEMS_DATABASE_URL = dsnFor(DB, { name: ROLE, pw: ROLE_PW });
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_TENANT_ID"]) delete process.env[k];
  itemsPool = (await import(`${D}/db/client.js`)).itemsPool;
  const { installTenantBinding } = await import(`${D}/db/tenant-binding-boot.js`);
  const how = installTenantBinding({ LIVELY_TENANT_BINDING: "rls", LIVELY_TENANCY_MODE: "registry" });
  chk("T0' 등록부 바인딩이 켜졌다", /등록부/.test(how), how);
  const { withTenant } = await import(`${D}/org/tenant-context.js`);
  const { candidateRows, runProjectGc } = await import(`${D}/scheduler/actions/project-gc.js`);
  const A = { id: TA, slug: "ws-a" };
  // 두 워크스페이스에 같은 조건의 껍데기 하나씩 — 기록 없음 · 기계 이름 · 손길 20일 전. 심기는 소유자 연결(dbc)로 한다.
  //  ⚠ dist 모듈은 풀을 앱 역할로 바꾼 **뒤에** import 한다 — 먼저 부르면 db/client 가 소유자 DSN 으로 풀을 만들어 RLS 를 안 탄다.
  const { AUTO_CREATED_MARK } = await import(`${D}/project/first-prompt-project.js`);
  const shell = async (t, name) => (await dbc.query(
    `INSERT INTO project(tenant_id, level, name, description, status, created_by, name_source, updated_at)
     VALUES ($1, 'project', $2, $3, 'active', '__gc_tenant__', 'rule', now() - interval '20 days') RETURNING id`,
    [t, name, `첫 지시\n\n${AUTO_CREATED_MARK}`])).rows[0].id;
  const pa = await shell(TA, "A 껍데기");
  const pb = await shell(TB, "B 껍데기");

  const ids = await withTenant(A, async () => (await candidateRows(14)).map((r) => r.id));
  chk("T1 A 컨텍스트의 후보에는 A 껍데기만 있다", ids.includes(pa) && !ids.includes(pb), J({ ids, pa, pb }));

  const res = await withTenant(A, () => runProjectGc({ mode: "on" }, { id: "pgt-gc-tenant", action: "project_gc", interval_sec: 86400 }));
  const rowOf = async (id) => (await dbc.query(`SELECT status, trashed_at FROM project WHERE id=$1`, [id])).rows[0];
  const a = await rowOf(pa), b = await rowOf(pb);
  chk("T2 A 에서 돌린 정리는 A 껍데기만 닫고 휴지통에 넣는다 — B 껍데기는 그대로",
    a.status === "done" && a.trashed_at != null && b.status === "active" && b.trashed_at == null, J({ a, b, done: res.summary.done }));
} catch (e) {
  fail++; console.error("FAIL 예외", e);
} finally {
  await itemsPool?.end().catch(() => {});
  await dbc?.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await su.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
