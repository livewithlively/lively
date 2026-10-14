// 앱 서버 끝단(#4483 완료 조건 ① 의 로컬판) PG 통합 테스트 — **실제 Postgres 필요**(CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/lively-db-sdk.pg-test.mjs
//
// 한 프로세스에 셋을 띄운다: ① 게이트웨이 REST(registerWebUi — 진짜 인증·앱 서버 토큰·신원 검증) ② Drizzle 로 만든 Express 앱 서버
//  (public/sdk/lively-db.mjs + 매니페스트에서 만든 스키마) ③ 앞단 흉내(서명된 X-Lively-Identity 를 붙여 앱 서버를 부른다).
//  E1 앱 서버 — upsert · 조인 · 관계 조회 · 집계 · numeric 금액(정확한 합) · 외래키 · 묶음 트랜잭션, 검사기 거부 0
//  E2 묶음 — 둘째가 실패하면 첫째도 취소(전부 아니면 전무) · 몇 번째인지
//  E3 신원 — 없으면 401 · 다른 앱의 신원이면 401 · 동의 안 한 사람이면 403 · 앱 서버 토큰은 /mcp·터미널에서 403
//  E4 앱 서버 빈도 — 사람마다 따로 센다
import pg from "pg";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_sdk_4483";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE"]) delete process.env[k];

// 시험 서명 키(app-identity.test.ts 의 시험 벡터와 같은 시드) — 공개 키만 게이트웨이에 준다.
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const ID = await import(`${D}/apps/app-identity.js`);
const KEY = ID.ed25519FromSeed(Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"));
process.env.LIVELY_APP_IDENTITY_PUBKEYS = JSON.stringify({ "test-1": KEY.publicKeyB64 });

const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const express = (await import("express")).default;
const { registerWebUi } = await import(`${D}/web.js`);
const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
const { sessionOrBearer, bearerWithResourceMetadata } = await import(`${D}/auth/http-auth.js`);
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { upsertMember } = await import(`${D}/org/store/members.js`);
const { mintToken } = await import(`${D}/org/store/tokens.js`);
const { mintAppServerToken } = await import(`${D}/apps/app-server-auth.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const X = await import(`${D}/apps/app-sql-exec.js`);
const SDK = await import(new URL("../../public/sdk/lively-db.mjs", import.meta.url).href);
const cap = (n) => appCapabilities.find((c) => c.name === n);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const SINGLE = "00000000-0000-0000-0000-000000000000";
const now = () => Math.floor(Date.now() / 1000);
const identity = (sub, app = "crm-v2") => ID.signAppIdentity({ ws: SINGLE, app, var: "pub", sub, name: sub, iat: now(), exp: now() + 600 }, KEY.privateKey, "test-1");

const manifest = {
  id: "crm-v2", title: "컨택 v2", version: "0.1.0",
  permissions: { tools: ["store_sql", "store_sql_batch", "store_tables", "store_query"] },
  data: { tables: [
    { name: "contacts", columns: [
      { name: "name", type: "text", not_null: true },
      { name: "email", type: "varchar(200)", unique: true },
      { name: "stage", type: "enum", values: ["lead", "customer", "lost"], default: "lead", not_null: true },
    ] },
    { name: "orders", columns: [
      { name: "contact_id", type: "bigint", not_null: true, references: { table: "contacts", on_delete: "cascade" } },
      { name: "amount", type: "numeric(12,2)", not_null: true, check: "amount >= 0" },
      { name: "ordered_on", type: "date", default_expr: "current_date" },
    ] },
  ] },
  ui: { pages: [{ key: "main", title: "컨택", entry: "ui/index.html" }] },
};

const servers = [];
const listen = (app) => new Promise((resolve) => { const s = http.createServer(app); servers.push(s); s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${s.address().port}`)); });
let genDir = null;

try {
  X.resetAppSqlLimits({ ...process.env });
  const admin = { userId: "pgt-admin", email: "a@x", scopes: ["admin", "items"] };
  await upsertMember({ id: "pgt-admin", display_name: "관리자", state: "active", scopes: ["admin", "items"] }, "pgt");
  await upsertMember({ id: "pgt-user", display_name: "사용자", state: "active", scopes: ["items"] }, "pgt");
  await upsertMember({ id: "pgt-other", display_name: "동의 안 함", state: "active", scopes: ["items"] }, "pgt");
  const inst = await cap("org_app_install").handler({ source: { kind: "inline", files: [
    { path: "lively-app.json", content: JSON.stringify(manifest) }, { path: "ui/index.html", content: "<p>x</p>" }] } }, admin, { source: "mcp" });
  chk("E0 설치 — 표 둘 · 외래키 · 앱 역할", inst.tables?.created?.join() === "contacts,orders" && inst.tables?.sql_role?.ok === true
    && inst.tables?.constraints?.some((c) => c.kind === "foreign_key"), JSON.stringify(inst.tables));
  await cap("me_app_grant").handler({ app_id: "crm-v2" }, { userId: "pgt-user", scopes: ["items"] }, { source: "mcp" });
  const { token: appToken } = await mintAppServerToken("crm-v2", "pgt-admin");

  // ① 게이트웨이
  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  const verifier = new BearerVerifier();
  registerWebUi(gw, verifier);
  // 터미널·파일·프로젝트·프리뷰·노드 라우트가 쓰는 인증 미들웨어(sessionOrBearer 기본값)와 /mcp 의 것을 그대로 건 탐침 경로
  gw.get("/probe/plain", sessionOrBearer(verifier), (_req, res) => res.json({ ok: true }));
  gw.get("/probe/mcp", bearerWithResourceMetadata(verifier), (_req, res) => res.json({ ok: true }));
  const GW = await listen(gw);

  // ② 앱 서버 — 매니페스트에서 만든 Drizzle 스키마 + SDK
  const cache = new URL("../../node_modules/.cache/", import.meta.url);
  mkdirSync(cache, { recursive: true });
  genDir = mkdtempSync(path.join(cache.pathname, "lively-db-e2e-"));
  writeFileSync(path.join(genDir, "schema.mjs"), SDK.generateDrizzleSchema(manifest));
  const schema = await import(pathToFileURL(path.join(genDir, "schema.mjs")).href);
  const { eq, sql, desc } = await import("drizzle-orm");
  const { db, batch } = SDK.createLivelyDb({ url: GW, token: appToken, schema });
  const appSrv = express();
  appSrv.use(express.json());
  appSrv.use(SDK.livelyIdentity());
  // Express 4 는 async 핸들러의 거절을 오류 처리기로 넘기지 않는다 — 앱이 흔히 쓰는 감싸기
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
  appSrv.post("/contacts", wrap(async (req, res) => {
    const [c] = await db.insert(schema.contacts).values(req.body)
      .onConflictDoUpdate({ target: schema.contacts.email, set: { name: sql`excluded.name` } }).returning();
    res.json(c);
  }));
  appSrv.post("/orders", wrap(async (req, res) => {
    const { contactId, amount, stage } = req.body;
    const [o] = await batch([
      db.insert(schema.orders).values({ contactId, amount }).returning(),
      db.update(schema.contacts).set({ stage }).where(eq(schema.contacts.id, contactId)),
    ]);
    res.json(o[0]);
  }));
  appSrv.get("/contacts/:id", wrap(async (req, res) => {
    res.json(await db.query.contacts.findFirst({ where: eq(schema.contacts.id, Number(req.params.id)), with: { orders: { orderBy: [desc(schema.orders.amount)] } } }));
  }));
  appSrv.get("/report", wrap(async (_req, res) => {
    res.json(await db.select({ name: schema.contacts.name, total: sql`coalesce(sum(${schema.orders.amount}), 0)`, n: sql`count(${schema.orders.id})` })
      .from(schema.contacts).leftJoin(schema.orders, eq(schema.orders.contactId, schema.contacts.id)).groupBy(schema.contacts.id).orderBy(schema.contacts.id));
  }));
  appSrv.use((err, _req, res, _next) => { const le = SDK.livelyErrorOf(err); res.status(le?.status || 500).json({ error: le?.message ?? String(err?.message ?? err), index: le?.index }); });
  const APP = await listen(appSrv);

  // ③ 앞단 흉내 — 서명된 신원을 붙여 앱 서버를 부른다
  const as = (sub) => async (method, p, body) => {
    const r = await fetch(APP + p, { method, headers: { "content-type": "application/json", ...(sub ? { "x-lively-identity": identity(sub) } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const user = as("pgt-user");

  // ── E1 ──
  X.appSqlStats(true);
  const kim = await user("POST", "/contacts", { name: "김", email: "kim@x" });
  const kim2 = await user("POST", "/contacts", { name: "김민", email: "kim@x" });                  // upsert — 같은 행, 이름만
  const lee = await user("POST", "/contacts", { name: "이", email: "lee@x" });
  const o1 = await user("POST", "/orders", { contactId: kim.body.id, amount: "10.10", stage: "customer" });
  const o2 = await user("POST", "/orders", { contactId: kim.body.id, amount: "20.65", stage: "customer" });
  const o3 = await user("POST", "/orders", { contactId: lee.body.id, amount: "0.10", stage: "lead" });
  const detail = await user("GET", `/contacts/${kim.body.id}`);
  const report = await user("GET", "/report");
  chk("E1 upsert — 같은 이메일은 같은 행(id 같음) · 이름이 바뀐다 · enum 기본값 lead",
    kim.status === 200 && kim2.body.id === kim.body.id && kim2.body.name === "김민" && kim.body.stage === "lead", JSON.stringify([kim, kim2]));
  chk("E1b 묶음 주문 — numeric 금액 글자 그대로 · 날짜 기본값(current_date) · 단계가 같은 트랜잭션에서 바뀐다",
    o1.status === 200 && o1.body.amount === "10.10" && /^\d{4}-\d{2}-\d{2}$/.test(o1.body.orderedOn ?? "") && o3.status === 200, JSON.stringify([o1, o3]));
  //  관계 조회(db.query … with)는 Drizzle 이 중첩 행을 JSON 으로 받아 numeric 이 수를 거친다 — 끝 0 이 빠진다("10.1").
  //   node-postgres 드라이버도 같다(json 을 JSON.parse). 금액을 글자 그대로 받으려면 select·조인(E1b·E1d)으로.
  chk("E1c 관계 조회 — 주문이 금액 큰 순으로 붙고 단계는 customer(관계 안의 numeric 은 Drizzle 표준대로 JSON 을 거친다)",
    detail.status === 200 && detail.body.stage === "customer" && detail.body.orders.map((o) => o.amount).join() === "20.65,10.1", JSON.stringify(detail));
  chk("E1d 조인·집계 — numeric 합이 정확하다(10.10 + 20.65 = 30.75, 부동소수 오차 없음)",
    report.status === 200 && JSON.stringify(report.body) === JSON.stringify([{ name: "김민", total: "30.75", n: "2" }, { name: "이", total: "0.10", n: "1" }]), JSON.stringify(report));
  const st = X.appSqlStats();
  chk("E1e 검사기 거부 0 · 실행 오류 0 · 묶음 셈", st.errors === 0 && st.batches === 3 && st.plan_us.n >= 10, JSON.stringify({ errors: st.errors, batches: st.batches, plan: st.plan_us }));

  // ── E2 묶음 원자성 · 외래키 · check ──
  const before = (await user("GET", "/report")).body;
  const badBatch = await user("POST", "/orders", { contactId: 999999, amount: "5.00", stage: "customer" });          // 첫째(주문)가 외래키 위반
  const negBatch = await user("POST", "/orders", { contactId: lee.body.id, amount: "-1", stage: "customer" });        // check 위반
  const after = (await user("GET", "/report")).body;
  const leeNow = await user("GET", `/contacts/${lee.body.id}`);
  chk("E2 묶음 실패 — 409 · 몇 번째인지 · 다른 문장(단계 바꾸기)도 취소돼 lee 는 여전히 lead · 합계 그대로",
    badBatch.status === 409 && badBatch.body.index === 0 && negBatch.status === 409 && leeNow.body.stage === "lead" && JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify({ badBatch, negBatch, stage: leeNow.body.stage }));

  // ── E3 신원 ──
  const noId = await as(null)("GET", "/report");
  const otherApp = await fetch(APP + "/report", { headers: { "x-lively-identity": identity("pgt-user", "memo") } }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const noGrant = await as("pgt-other")("GET", "/report");
  // 위조 — 서명은 그대로 두고 payload 의 사람만 바꾼다(관리자인 척)
  const [v1, kid, pay, sig] = identity("pgt-user").split(".");
  const forgedPay = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pay, "base64url").toString("utf8")), sub: "pgt-admin" })).toString("base64url");
  const forged = await fetch(APP + "/report", { headers: { "x-lively-identity": [v1, kid, forgedPay, sig].join(".") } }).then((r) => r.status);
  chk("E3 신원 — 없으면 401 · 다른 앱의 신원 401 · 동의 안 한 사람 403 · 서명이 틀리면 401",
    noId.status === 401 && otherApp.status === 401 && noGrant.status === 403 && forged === 401, JSON.stringify({ noId, otherApp, noGrant, forged }));
  const withApp = { authorization: `Bearer ${appToken}`, "x-lively-identity": identity("pgt-user") };
  const direct = await fetch(GW + "/api/ui/store/sql", { method: "POST", headers: { "content-type": "application/json", ...withApp },
    body: JSON.stringify({ sql: "SELECT count(*)::int AS n FROM contacts" }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const notMine = await fetch(GW + "/api/ui/knowledge/search?q=x", { headers: withApp }).then((r) => r.status);
  chk("E3b 앱 서버 토큰 + 신원 — 앱 데이터는 된다(사람 대리) · 동의에 없는 도구는 403",
    direct.status === 200 && direct.body.rows?.[0]?.n === 2 && notMine === 403, JSON.stringify({ direct, notMine }));
  const plain = await fetch(GW + "/probe/plain", { headers: withApp }).then((r) => r.status);
  const mcp = await fetch(GW + "/probe/mcp", { headers: withApp }).then((r) => r.status);
  const memberTok = (await mintToken({ userId: "pgt-user", memberId: "pgt-user", scopes: ["items"] }, "pgt")).token;
  const memberPlain = await fetch(GW + "/probe/plain", { headers: { authorization: `Bearer ${memberTok}` } }).then((r) => r.status);
  const memberMcp = await fetch(GW + "/probe/mcp", { headers: { authorization: `Bearer ${memberTok}` } }).then((r) => r.status);
  chk("E3c 앱 서버 토큰은 앱 도구 게이트를 안 타는 경로(터미널·파일 등의 sessionOrBearer · /mcp)에서 403 · 구성원 토큰은 종전 그대로 200",
    plain === 403 && mcp === 403 && memberPlain === 200 && memberMcp === 200, JSON.stringify({ plain, mcp, memberPlain, memberMcp }));

  // ── E4 앱 서버 빈도 — 사람마다 ──
  X.resetAppSqlLimits({ ...process.env, LIVELY_APP_SQL_RATE: "0.001", LIVELY_APP_SQL_BURST: "3", LIVELY_APP_SQL_SERVER_RATE: "1000", LIVELY_APP_SQL_SERVER_BURST: "100" });
  const burst = [];
  for (let i = 0; i < 4; i++) burst.push((await user("GET", "/report")).status);
  await upsertMember({ id: "pgt-user2", display_name: "둘째", state: "active", scopes: ["items"] }, "pgt");
  await cap("me_app_grant").handler({ app_id: "crm-v2" }, { userId: "pgt-user2", scopes: ["items"] }, { source: "mcp" });
  const other = (await as("pgt-user2")("GET", "/report")).status;
  chk("E4 앱 서버 빈도는 사람마다 — 한 사람의 4번째는 429, 다른 사람은 된다", JSON.stringify(burst) === "[200,200,200,429]" && other === 200, JSON.stringify({ burst, other }));
} catch (e) {
  fail++; console.error("FAIL (예외)", e);
} finally {
  for (const s of servers) s.close();
  if (genDir) rmSync(genDir, { recursive: true, force: true });
  X.resetAppSqlLimits({ ...process.env });
  await X.closeAppSqlPool();
  await itemsPool.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
