// 호출 감사로그 prune 의 워크스페이스별 실행 — 실제 Postgres 필요(기본 유닛 체인 밖, CI pg-test 잡 · .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/org/policies/call-log-prune.pg-test.mjs
//
// 왜 이 계층인가: prune 의 DELETE 에는 워크스페이스 조건이 없다 — 어느 워크스페이스 행을 지우는지는 풀의 테넌트 바인딩과
//  행 수준 보안이 전부 정한다. 보존기간도 워크스페이스별 행(org_runtime_config)에서 읽는다. 목 풀로는 둘 다 안 보이므로
//  등록부 모드 게이트웨이와 같은 조건(비특권 앱 역할 · ensureTenantPolicies 가 건 FORCE RLS · 등록부 리졸버)으로 돌린다.
//
//  사양 · 엣지 표:
//   C0 배선 — 앱 역할은 RLS 를 못 넘고, mcp_call_log 에 tenant_isolation 정책이 걸렸다
//   C1 컨텍스트 밖 1회(종전 배선) — primary 의 정책으로 primary 행만 지운다. 다른 워크스페이스의 오래된 행은 남는다
//   C2 워크스페이스마다(하우스키핑이 쓰는 forEachTenant + pruneCallLogByPolicy) — 각자 자기 보존기간으로 자기 행만 지운다
//      · A(30일): 60일 · 120일 행 삭제, 1일 행 유지
//      · B(90일): 120일 행만 삭제, 60일 행 유지 — A 의 30일 DELETE 가 B 의 60일 행을 건드리지 않았다는 증거이기도 하다
//      · 순회 대상이 아닌 primary 의 오래된 행은 그대로
import pg from "pg";
import { execFileSync } from "node:child_process";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_calllog_prune";
const ROLE = `lvly_app_${DB}`;            // org/tenancy/activate.ts appRoleName(current_database()) 과 같은 이름 — 정책이 이 역할에 걸린다
const ROLE_PW = "pgt-calllog";
const dsnFor = (db, role) => { const u = new URL(BASE); u.pathname = "/" + db; if (role) { u.username = role.name; u.password = role.pw; } return u.toString(); };
const D = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const J = JSON.stringify;
const P = "00000000-0000-0000-0000-000000000000";   // primary — db/tenant-column.ts SINGLE_TENANT_ID
const TA = "aaaaaaaa-0000-4000-8000-00000000000a", TB = "bbbbbbbb-0000-4000-8000-00000000000b";

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
  // 스키마 · 정책은 소유자로(게이트웨이의 스키마 초기화 자식과 같은 자리) — 이 프로세스의 풀은 앱 역할로 따로 연다.
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

  // 보존기간 — 워크스페이스마다 다르게. primary 10일 · A 30일 · B 90일.
  for (const [t, days] of [[P, 10], [TA, 30], [TB, 90]]) {
    await dbc.query(
      `INSERT INTO org_runtime_config(tenant_id, id, call_log_policy) VALUES ($1, 1, $2::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE SET call_log_policy = EXCLUDED.call_log_policy`, [t, J({ retention_days: days })]);
  }
  // 워크스페이스마다 1일 · 60일 · 120일 지난 호출 로그 한 줄씩(tool 이름에 나이를 적어 둔다).
  for (const t of [P, TA, TB]) {
    for (const age of [1, 60, 120]) {
      await dbc.query(`INSERT INTO mcp_call_log(tenant_id, tool, called_at) VALUES ($1, $2, now() - ($3 || ' days')::interval)`, [t, `age-${age}`, String(age)]);
    }
  }
  const left = async () => {
    const rows = (await dbc.query(`SELECT tenant_id::text AS t, tool FROM mcp_call_log ORDER BY tool`)).rows;
    const by = (t) => rows.filter((r) => r.t === t).map((r) => r.tool).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))).join(",");
    return { P: by(P), A: by(TA), B: by(TB) };
  };

  // C0 — 정책이 실제로 걸렸나(안 걸렸으면 아래 단언이 격리를 재는 게 아니다)
  const role = (await dbc.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1`, [ROLE])).rows[0];
  const pol = (await dbc.query(`SELECT c.relforcerowsecurity AS forced, array_agg(p.policyname::text) AS names
                                  FROM pg_class c LEFT JOIN pg_policies p ON p.tablename = c.relname
                                 WHERE c.relname = 'mcp_call_log' GROUP BY c.relforcerowsecurity`)).rows[0];
  chk("C0 앱 역할은 RLS 를 못 넘고 mcp_call_log 에 FORCE RLS + tenant_isolation 이 걸렸다",
    role && !role.rolsuper && !role.rolbypassrls && pol?.forced === true && (pol.names ?? []).includes("tenant_isolation"), J({ role, pol }));

  // 이 프로세스의 풀 — 앱 역할 + 등록부 모드 리졸버(컨텍스트 없으면 primary). 게이트웨이 부팅과 같은 함수로 꽂는다.
  process.env.ITEMS_DATABASE_URL = dsnFor(DB, { name: ROLE, pw: ROLE_PW });
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_TENANT_ID"]) delete process.env[k];
  const client = await import(`${D}/db/client.js`);
  itemsPool = client.itemsPool;
  const { installTenantBinding } = await import(`${D}/db/tenant-binding-boot.js`);
  const how = installTenantBinding({ LIVELY_TENANT_BINDING: "rls", LIVELY_TENANCY_MODE: "registry" });
  chk("C0' 등록부 바인딩이 켜졌다", /등록부/.test(how), how);
  const { pruneCallLogByPolicy } = await import(`${D}/org/policies/call-log-prune.js`);
  const { loadCallLogPolicy } = await import(`${D}/org/policies/runtime-loaders.js`);
  const { forEachTenant } = await import(`${D}/scheduler/tenant-fanout.js`);
  const sweepOne = () => pruneCallLogByPolicy(loadCallLogPolicy);

  // C1 — 컨텍스트 밖(종전 배선 그대로): primary 정책(10일)으로 primary 행만
  const n1 = await sweepOne();
  const s1 = await left();
  chk("C1 컨텍스트 밖 1회는 primary 의 10일로 primary 행만 지운다 — A · B 의 오래된 행은 남는다",
    n1 === 2 && s1.P === "age-1" && s1.A === "age-1,age-60,age-120" && s1.B === "age-1,age-60,age-120", J({ n1, s1 }));

  // C2 준비 — primary 에 오래된 행을 다시 넣는다. 순회가 primary 로 새면 이 행이 지워진다.
  await dbc.query(`INSERT INTO mcp_call_log(tenant_id, tool, called_at) VALUES ($1, 'age-60', now() - interval '60 days')`, [P]);
  // C2 — 하우스키핑이 쓰는 조합 그대로(대상 조회만 주입): 워크스페이스마다 자기 정책 · 자기 행
  const seen = [];
  await forEachTenant("call-log-prune", async () => { seen.push(await sweepOne()); },
    async () => [{ id: TA, slug: "ws-a" }, { id: TB, slug: "ws-b" }]);
  const s2 = await left();
  chk("C2 A 는 30일로 60일 · 120일 행을 지운다", s2.A === "age-1", J(s2));
  chk("C2 B 는 90일로 120일 행만 지운다 — 앞서 돈 A 의 30일 DELETE 가 B 의 60일 행을 건드리지 않았다", s2.B === "age-1,age-60", J(s2));
  chk("C2 순회 대상이 아닌 primary 는 그대로 — 60일 행이 남는다(A 의 30일로 지워지지 않았다)", s2.P === "age-1,age-60", J(s2));
  chk("C2 지운 수가 워크스페이스별로 맞다(A 2 · B 1)", J(seen) === J([2, 1]), J(seen));
} finally {
  await itemsPool?.end().catch(() => {});
  await dbc?.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await su.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
