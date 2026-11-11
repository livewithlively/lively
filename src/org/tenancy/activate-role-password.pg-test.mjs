// 워크스페이스 활성화가 앱 역할 비밀번호를 **평문으로 SQL 에 싣지 않는지** — 실제 Postgres 필요(기본 유닛 체인 밖,
//  CI pg-test 잡 · .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/org/tenancy/activate-role-password.pg-test.mjs
//
// 왜 이 계층인가: 활성화는 소유자(대개 슈퍼유저)로 붙어 CREATE/ALTER ROLE 을 보낸다. 서버가 log_statement=all 로
//  감사 로그를 남기면 그 문장 텍스트가 그대로 로그에 실린다 — 평문 비밀번호가 문장에 있으면 로그가 곧 자격 유출이다.
//  막는 방법은 «문장에 평문을 싣지 않는 것»(클라이언트가 만든 SCRAM verifier 를 보낸다)이고, 그 verifier 를 Postgres 가
//  verifier 로 알아보지 못하면 문자열 자체가 평문 비밀번호로 저장돼 로그인이 깨진다. 그래서 둘을 실제 서버로 함께 본다:
//  이 프로세스의 pg 클라이언트가 보낸 SQL 텍스트 전부를 가로채 평문이 없는지, 그리고 그 비밀번호로 실제 로그인이 되는지.
//
//  사양 · 엣지 표(활성화가 비밀번호를 정하는 세 갈래 — activate.ts activateWorkspaceRegistry ①):
//   R1 역할 없음 → CREATE ROLE        · R2 역할 있음 + 상태파일 없음 → ALTER ROLE(속성 + 비밀번호)
//   R3 역할 있음 + 상태파일 같은 역할인데 비밀번호 없음 → ALTER ROLE PASSWORD
//   각 갈래: ① 보낸 SQL 어디에도 평문 없음 ② 역할 문장이 실제로 가로채졌다(훅이 헛돌지 않았다) ③ 저장값이 보낸 SCRAM verifier 그대로
//           ④ 상태파일의 앱 DSN 으로 로그인된다 ⑤ (R2 · R3) 직전 비밀번호로는 로그인이 안 된다
import pg from "pg";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_activate_role_pw";
const ROLE = `lvly_app_${DB}`;            // activate.ts appRoleName(current_database()) 과 같은 이름
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const D = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const J = JSON.stringify;
const ROOT = mkdtempSync(path.join(os.tmpdir(), "lively-activate-role-pw-"));

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };

//  이 프로세스의 모든 pg 클라이언트(풀 포함)가 서버로 보내는 SQL 텍스트를 적는다 — 서버 로그가 받게 될 바로 그 텍스트다.
const SENT = [];
const origQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...rest) {
  const text = typeof config === "string" ? config : config?.text;
  if (text) SENT.push(String(text));
  return origQuery.call(this, config, ...rest);
};

const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`DROP ROLE IF EXISTS ${ROLE}`);
let itemsPool = null;
try {
  await su.query(`CREATE DATABASE ${DB}`);
  const OWNER = dsnFor(DB);
  const dbc = new pg.Client({ connectionString: OWNER }); await dbc.connect();
  await dbc.query("CREATE EXTENSION IF NOT EXISTS vector");
  await dbc.end();
  const scrub = (env) => {
    for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE",
      "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID", "LIVELY_TENANCY_MODE", "LIVELY_TENANT_HEADER_SECRET", "LIVELY_WORKSPACE_REGISTRY", "EMBEDDINGS_PROVIDER"]) delete env[k];
    env.ITEMS_DATABASE_URL = OWNER;
    env.LIVELY_STATE_DIR = path.join(ROOT, "state");
    env.LIVELY_LOG_DIR = path.join(ROOT, "logs");
    return env;
  };
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { initAllSchemas } = await import(${J(`${D}/boot/schemas.js`)});
    await initAllSchemas({ quiet: true });
    const { itemsPool } = await import(${J(`${D}/db/client.js`)});
    await itemsPool.end();
    process.exit(0);`], { env: scrub({ ...process.env }), stdio: ["ignore", "ignore", "inherit"], timeout: 300_000 });

  // 이 프로세스의 풀 = 소유자 DSN(활성화 전 게이트웨이와 같은 자리). 상태파일은 임시 폴더로.
  scrub(process.env);
  ({ itemsPool } = await import(`${D}/db/client.js`));
  const { activateWorkspaceRegistry } = await import(`${D}/org/tenancy/activate.js`);
  const { tenancyRuntimePath } = await import(`${D}/org/tenancy/state.js`);
  const RT = tenancyRuntimePath();
  const appDsn = () => JSON.parse(readFileSync(RT, "utf8")).app_dsn;
  const pwOf = (dsn) => decodeURIComponent(new URL(dsn).password);
  const canLogin = async (dsn) => {
    const c = new pg.Client({ connectionString: dsn });
    try { await c.connect(); return String((await c.query("SELECT current_user AS u")).rows[0]?.u); }
    catch (e) { return `ERR ${e?.message ?? e}`; }
    finally { await c.end().catch(() => {}); }
  };
  const stored = async () => String((await su.query(`SELECT rolpassword FROM pg_authid WHERE rolname=$1`, [ROLE])).rows[0]?.rolpassword ?? "");

  const branch = async (tag, roleRe, prevDsn) => {
    SENT.length = 0;
    await activateWorkspaceRegistry({ ownerMember: "pgt-admin" });
    const dsn = appDsn(); const pw = pwOf(dsn);
    const leaked = SENT.filter((s) => s.includes(pw));
    chk(`${tag}① 보낸 SQL ${SENT.length}건 어디에도 평문 비밀번호가 없다`, pw.length >= 16 && leaked.length === 0,
      J(leaked.map((s) => s.replace(pw, "<평문>").slice(0, 160))));
    chk(`${tag}② 역할 문장이 가로채졌다(훅이 헛돌지 않았다)`, SENT.some((s) => roleRe.test(s)), J(SENT.filter((s) => /ROLE/.test(s)).slice(0, 5)));
    const sv = await stored();
    chk(`${tag}③ 저장된 값이 보낸 SCRAM verifier 그대로다(서버가 평문을 받아 해시한 게 아니다)`,
      sv.startsWith("SCRAM-SHA-256$4096:") && SENT.some((s) => s.includes(sv)), sv.slice(0, 20));
    chk(`${tag}④ 상태파일의 앱 DSN 으로 로그인된다`, (await canLogin(dsn)) === ROLE, await canLogin(dsn));
    if (prevDsn) chk(`${tag}⑤ 직전 비밀번호로는 로그인이 안 된다`, (await canLogin(prevDsn)).startsWith("ERR"), "직전 비밀번호가 아직 통한다");
    return dsn;
  };

  // R1 — 역할 없음: CREATE ROLE
  const d1 = await branch("R1", /^CREATE ROLE "lvly_app_/, null);
  // R2 — 역할 있음 + 상태파일 없음: ALTER ROLE ... LOGIN PASSWORD
  unlinkSync(RT);
  const d2 = await branch("R2", /^ALTER ROLE "lvly_app_[^"]+" NOSUPERUSER/, d1);
  // R3 — 상태파일이 같은 역할을 가리키는데 비밀번호가 비었다: ALTER ROLE ... PASSWORD
  const u = new URL(d2); u.password = ""; writeFileSync(RT, J({ mode: "registry", app_dsn: u.toString() }));
  await branch("R3", /^ALTER ROLE "lvly_app_[^"]+" PASSWORD/, d2);
} catch (e) {
  fail++; console.error("FAIL 예외 —", e?.stack ?? e);
} finally {
  pg.Client.prototype.query = origQuery;
  await itemsPool?.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await su.end().catch(() => {});
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
