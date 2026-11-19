// #1764 DB 소스 비밀번호를 시크릿 저장소에서 읽기 — **실제 Postgres 필요**(CI 의 services:postgres 잡이 `run-tests --pg` 로 자동 수집).
//  로컬 수동 실행: npm run build && ITEMS_DATABASE_URL=postgres://<superuser>@<host>:<port>/<db> node src/db/secret-ref-rotation.pg-test.mjs
//
// 무엇을 왜 재는가 — 목으로는 못 보는 것: pg 가 새 연결마다 부르는 비밀번호 함수, 진짜 서버의 인증 실패(28P01), 그 뒤 다시 읽고
//  다시 붙기, 그리고 «재시작 없이» (게이트웨이 프로세스 · 풀을 그대로 둔 채) 교체를 따라가는지. GCP 메타데이터 서버와
//  Secret Manager 는 이 프로세스 안의 가짜 HTTP 서버다(실제 클라우드에는 닿지 않는다 — 요청 꼴은 secret-store.test.ts 가 본다).
//  사양(이슈 #1764 「시험」 · 스크래치 spec.md E):
//   R0 허용 목록에 없는 참조는 접속 단계에서도 막히고 저장소를 부르지 않는다
//   R1 등록 즉시(재시작 없이) 저장소 참조로 접속된다
//   R2 DB 비밀번호와 시크릿을 함께 바꾸면, 풀을 지우지 않은 채 다음 새 연결이 다시 읽어 붙는다(기존 연결도 산다)
//   R3 시크릿과 DB 가 어긋나면(다시 읽어도 같은 값) 다시 붙지 않고 «값이 그대로» 와 원래 SQLSTATE
//   R4 다시 읽기가 막히면(범위 부족) 그 까닭이 소스 이름과 함께 나온다
//   R5 주소에 사용자 이름이 없으면 시크릿 JSON 의 username 으로 붙는다
//   R6 등록 도구 · 런타임 설정 도구가 저장소 참조를 받고, 형식 오류 · 허용 목록 밖은 막는다(어느 꼴도 아닌 값은 되싣지 않는다)
//   R7 환경변수 이름 참조는 종전 그대로(저장소를 부르지 않는다)
import http from "node:http";
import pg from "pg";

const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${D}/db/client.js`);
const store = await import(`${D}/org/store.js`);
const { getPool, invalidatePool, SecretRefPgPool } = await import(`${D}/db/pool.js`);
const ss = await import(`${D}/db/secret-store.js`);
const { registry } = await import(`${D}/capabilities/index.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

const ACTOR = "__secret_ref_rotation_pg_test__";
const ROLE = "lively_t1764_ro";
const ROLE_ENV = "lively_t1764_env";
const SRC = "t1764-store";
const SRC_JSON = "t1764-json";
const SRC_ENV = "t1764-env";
const SRC_DENY = "t1764-deny";
const REF = "gcp-sm:t1764-project/db-pw";
const REF_JSON = "gcp-sm:t1764-project/db-json";
const REF_DENY = "gcp-sm:t1764-project/not-allowed";
const ENV_NAME = "T1764_ENV_PW";
const admin = { userId: ACTOR, email: "t1764@example.invalid", scopes: ["admin", "context", "memory"], projects: ["*"] };
const cap = (name) => registry.get(name);

// ── 가짜 GCP(메타데이터 서버 + Secret Manager) ──
const secrets = new Map([["db-pw", "pw-A"]]);
let smCalls = 0;
let smFail = null; // { status, json } — 주면 모든 접근이 그 응답
const meta = http.createServer((_req, res) => {
  res.writeHead(200, { "Metadata-Flavor": "Google", "content-type": "application/json" })
    .end(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }));
});
const sm = http.createServer((req, res) => {
  smCalls++;
  const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  if (smFail) return send(smFail.status, smFail.json);
  const m = /\/secrets\/([^/]+)\/versions\/[^/]+:access$/.exec(req.url ?? "");
  const v = m ? secrets.get(m[1]) : undefined;
  if (v === undefined) return send(404, { error: { code: 404, status: "NOT_FOUND", message: "Secret not found" } });
  return send(200, { payload: { data: Buffer.from(v, "utf8").toString("base64") } });
});
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const metaPort = await listen(meta);
const smPort = await listen(sm);
ss.__setSecretStoreDepsForTest({
  gcpMetadataBase: () => `http://127.0.0.1:${metaPort}`,
  gcpSecretManagerBase: `http://127.0.0.1:${smPort}/v1`,
  retryDelayMs: 0,
});

// ── 접속 대상 — 시험 DB 서버에 역할을 만들어 «외부 DB» 로 등록한다 ──
const u = new URL(process.env.ITEMS_DATABASE_URL);
const HOST = u.hostname === "localhost" ? "127.0.0.1" : u.hostname.replace(/^\[|\]$/g, "");
const PORT = u.port || "5432";
const DB = decodeURIComponent(u.pathname.replace(/^\//, ""));
const urlFor = (user) => `postgres://${user ? `${user}@` : ""}${HOST}:${PORT}/${DB}`;
const setPw = (role, pw) => itemsPool.query(`ALTER ROLE ${role} PASSWORD '${pw}'`);
/** 풀의 쉬는 연결을 모두 빌려 쥔다 — 다음 질의가 반드시 **새 연결**(= 새 인증)을 열게. */
const holdIdle = async (pool) => { const held = []; while (pool.idleCount > 0) held.push(await pool.connect()); return held; };

const rc0 = await store.getRuntimeConfig();
try {
  for (const r of [ROLE, ROLE_ENV]) {
    await itemsPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1`, [r]);
    await itemsPool.query(`DROP ROLE IF EXISTS ${r}`);
  }
  await itemsPool.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'pw-A'`);
  await itemsPool.query(`CREATE ROLE ${ROLE_ENV} LOGIN PASSWORD 'pw-env'`);

  // 전제 — 이 서버가 TCP 접속에서 비밀번호를 실제로 본다(trust 면 인증 실패가 안 나 교체 시험이 헛돈다).
  {
    const c = new pg.Client({ host: HOST, port: Number(PORT), database: DB, user: ROLE, password: "definitely-wrong" });
    const e = await errOf(c.connect());
    await c.end().catch(() => {});
    if (e?.code !== "28P01") throw new Error(`전제 실패 — 틀린 비밀번호로 접속이 ${e ? `다른 오류(${e.code ?? e.message})` : "성공"}했다. 이 서버의 pg_hba 가 TCP 비밀번호를 보지 않으면 이 시험을 할 수 없다`);
    ok("전제: 틀린 비밀번호는 28P01 로 거절된다(비밀번호를 실제로 본다)");
  }

  // ── R6 런타임 설정 도구 — 저장소 참조를 허용 목록에 받는다 · 형식 오류는 막는다 ──
  await cap("org_runtime_update").handler({
    allowed_db_hosts: [...rc0.allowed_db_hosts, HOST],
    allowed_db_secret_refs: [...rc0.allowed_db_secret_refs, REF, REF_JSON, ENV_NAME],
  }, admin, { source: "web", actor: ACTOR });
  const rc1 = await store.getRuntimeConfig();
  chk("R6 허용 목록이 저장소 참조를 받는다", [REF, REF_JSON, ENV_NAME].every((r) => rc1.allowed_db_secret_refs.includes(r)), JSON.stringify(rc1.allowed_db_secret_refs));
  {
    const e = await errOf(cap("org_runtime_update").handler({ allowed_db_secret_refs: [...rc1.allowed_db_secret_refs, "gcp-sm:Bad/x"] }, admin, { source: "web", actor: ACTOR }));
    chk("R6 허용 목록: 형식이 틀린 저장소 참조는 400", e?.status === 400 && /번째 항목/.test(e.message), `${e?.status} ${e?.message}`);
    const e2 = await errOf(cap("org_runtime_update").handler({ allowed_db_secret_refs: ["p@ss w0rd! 123"] }, admin, { source: "web", actor: ACTOR }));
    chk("R6 허용 목록: 어느 꼴도 아닌 값은 막고 되싣지 않는다", e2?.status === 400 && !e2.message.includes("p@ss"), `${e2?.status} ${e2?.message}`);
    const rc2 = await store.getRuntimeConfig();
    chk("R6 거절된 저장은 허용 목록을 바꾸지 않는다", JSON.stringify(rc2.allowed_db_secret_refs) === JSON.stringify(rc1.allowed_db_secret_refs));
  }

  // ── R6 등록 도구 — 저장소 참조 · 형식 오류 · 허용 목록 밖 ──
  {
    const e = await errOf(cap("org_db_source_upsert").handler({ name: SRC, driver: "postgres", url: urlFor(ROLE), auth_ref: "gcp-sm:Bad/x" }, admin, { source: "web" }));
    chk("R6 등록: 형식이 틀린 참조는 400", e?.status === 400 && /auth_ref/.test(e.message), `${e?.status} ${e?.message}`);
    const e2 = await errOf(cap("org_db_source_upsert").handler({ name: SRC, driver: "postgres", url: urlFor(ROLE), auth_ref: REF_DENY }, admin, { source: "web" }));
    chk("R6 등록: 허용 목록 밖 참조는 400", e2?.status === 400 && /허용목록/.test(e2.message), `${e2?.status} ${e2?.message}`);
    chk("R6 거절된 등록은 행을 만들지 않는다", (await store.getDbSource(SRC)) === null);
  }
  const before0 = smCalls;
  const up = await cap("org_db_source_upsert").handler({ name: SRC, driver: "postgres", url: urlFor(ROLE), auth_ref: REF }, admin, { source: "web" });
  chk("R6 등록: 허용된 저장소 참조는 받고 응답엔 참조만", up?.source?.auth_ref === REF && !JSON.stringify(up).includes("pw-A"), JSON.stringify(up));
  chk("R6 등록 자체는 시크릿을 읽지 않는다(접속할 때 읽는다)", smCalls === before0, `smCalls ${before0}→${smCalls}`);

  // ── R0 접속 단계의 허용 목록 — 등록 도구를 거치지 않은 행이어도 막힌다 ──
  await store.upsertDbSource({ name: SRC_DENY, driver: "postgres", url: urlFor(ROLE), auth_ref: REF_DENY, enabled: true }, ACTOR, "test");
  await (await import(`${D}/db/sources.js`)).refreshSources(true);
  {
    const b = smCalls;
    const e = await errOf(getPool(SRC_DENY));
    chk("R0 허용 목록 밖 참조는 접속 단계에서 막힌다", /허용목록/.test(e?.message ?? ""), e?.message);
    chk("R0 막힐 때 저장소를 부르지 않는다", smCalls === b, `smCalls ${b}→${smCalls}`);
  }

  // ── R1 재시작 없이 접속 ──
  const pool = await getPool(SRC);
  chk("R1 저장소 참조 소스는 시크릿 풀(SecretRefPgPool)", pool instanceof SecretRefPgPool, pool?.constructor?.name);
  {
    const r = await pool.query("SELECT current_user AS u");
    chk("R1 등록 즉시 그 역할로 접속된다", r.rows[0].u === ROLE, JSON.stringify(r.rows));
    chk("R1 시크릿은 한 번 읽었다", smCalls === before0 + 1, `smCalls ${before0}→${smCalls}`);
  }

  // ── R2 교체 — DB 비밀번호 + 시크릿을 함께 바꾼다. 기억(5분)은 아직 옛 값이다 ──
  {
    const held = await holdIdle(pool);
    await setPw(ROLE, "pw-B");
    secrets.set("db-pw", "pw-B");
    const b = smCalls;
    const e = await errOf(pool.query("SELECT 1 AS one"));
    chk("R2 교체 뒤 다음 새 연결이 붙는다", e === null, e?.message);
    chk("R2 그 사이 시크릿을 한 번 다시 읽었다(옛 값 실패 → 다시 읽기)", smCalls === b + 1, `smCalls ${b}→${smCalls}`);
    chk("R2 풀을 바꾸지 않았다(재시작 · 재등록 없이)", (await getPool(SRC)) === pool);
    const he = await errOf(held[0]?.query("SELECT 1"));
    chk("R2 교체 전에 맺은 연결도 그대로 쓴다", held.length > 0 && he === null, `held=${held.length} ${he?.message}`);
    held.forEach((c) => c.release());
  }

  // ── R3 시크릿과 DB 가 어긋남 ──
  {
    const held = await holdIdle(pool);
    await setPw(ROLE, "pw-C"); // 시크릿은 pw-B 그대로
    const b = smCalls;
    const e = await errOf(pool.query("SELECT 1"));
    // 다시 읽어도 시크릿이 그대로라 다시 붙지 않는다(실패 로그인을 늘리지 않는다 — 격리 리뷰 지적 1).
    chk("R3 어긋나면 «값이 그대로라 다시 붙지 않았다» 와 원래 SQLSTATE", /값이 그대로/.test(e?.message ?? "") && e?.code === "28P01", `${e?.code} ${e?.message}`);
    chk("R3 다시 읽기는 한 번", smCalls === b + 1, `smCalls ${b}→${smCalls}`);
    chk("R3 오류 문장에 비밀번호가 없다", !/pw-[A-Z]/.test(e?.message ?? ""), e?.message);
    held.forEach((c) => c.release());
  }

  // ── R4 다시 읽기가 막힘(범위 부족) ──
  {
    const held = await holdIdle(pool);
    await setPw(ROLE, "pw-D");
    smFail = { status: 403, json: { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } } };
    const e = await errOf(pool.query("SELECT 1"));
    smFail = null;
    chk("R4 다시 읽기가 막히면 그 까닭(접근 범위 부족)이 소스 이름과 함께", e?.reason === "scope_insufficient" && e.message.includes(`db source '${SRC}'`), `${e?.reason} ${e?.message}`);
    held.forEach((c) => c.release());
  }

  // ── R5 주소에 사용자 이름이 없으면 시크릿 JSON 의 username ──
  {
    await setPw(ROLE, "pw-E");
    secrets.set("db-json", JSON.stringify({ username: ROLE, password: "pw-E", engine: "postgres" }));
    await cap("org_db_source_upsert").handler({ name: SRC_JSON, driver: "postgres", url: urlFor(null), auth_ref: REF_JSON }, admin, { source: "web" });
    const b = smCalls;
    const p2 = await getPool(SRC_JSON);
    const r = await p2.query("SELECT current_user AS u");
    chk("R5 주소에 사용자 이름이 없으면 시크릿 username 으로 붙는다", r.rows[0].u === ROLE, JSON.stringify(r.rows));
    // 첫 시도에 바로 그 사용자로 붙어야 한다 — 다른 사용자로 실패한 뒤 재시도가 고쳐 붙은 것이면 읽기가 두 번이다.
    chk("R5 첫 시도에 붙었다(시크릿 읽기 한 번 — 재시도로 고쳐 붙은 것이 아니다)", smCalls === b + 1, `smCalls ${b}→${smCalls}`);
  }

  // ── R7 환경변수 이름 참조는 종전 그대로 ──
  {
    process.env[ENV_NAME] = "pw-env";
    const b = smCalls;
    await cap("org_db_source_upsert").handler({ name: SRC_ENV, driver: "postgres", url: urlFor(ROLE_ENV), auth_ref: ENV_NAME }, admin, { source: "web" });
    const p3 = await getPool(SRC_ENV);
    const r = await p3.query("SELECT current_user AS u");
    chk("R7 환경변수 참조로 접속된다", r.rows[0].u === ROLE_ENV, JSON.stringify(r.rows));
    chk("R7 환경변수 참조는 시크릿 풀이 아니고 저장소를 부르지 않는다", !(p3 instanceof SecretRefPgPool) && smCalls === b, `${p3?.constructor?.name} smCalls ${b}→${smCalls}`);
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  for (const s of [SRC, SRC_JSON, SRC_ENV, SRC_DENY]) {
    invalidatePool(s);
    await store.removeDbSource(s, ACTOR, "test").catch(() => {});
  }
  await store.updateRuntimeConfig({ allowed_db_hosts: rc0.allowed_db_hosts, allowed_db_secret_refs: rc0.allowed_db_secret_refs }, ACTOR, "test").catch(() => {});
  await new Promise((r) => setTimeout(r, 300)); // 풀 drain
  for (const r of [ROLE, ROLE_ENV]) {
    await itemsPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1`, [r]).catch(() => {});
    await itemsPool.query(`DROP ROLE IF EXISTS ${r}`).catch((e) => console.error(`역할 정리 실패(${r}): ${e.message}`));
  }
  await itemsPool.query(`DELETE FROM org_content_audit WHERE actor=$1`, [ACTOR]).catch(() => {});
  ss.__setSecretStoreDepsForTest(null);
  meta.close();
  sm.close();
  await itemsPool.end().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
