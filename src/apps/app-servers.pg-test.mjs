// 앱 서버(#4484 앱 v2-5) PG 통합 시험 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-servers.pg-test.mjs
//
// 사양 표 D(spec-4484.md) — 새 DB(initAllSchemas) 위에서 능력(app_save · app_server_deploy · app_visibility_set · app_revert · app_server_stop/resume ·
//  org_app_remove)을 그대로 부른다. 빌드는 **진짜 빌더**(SERVER_BUILDER_JS)를 이 기계의 node 로 돌리고(세션 컨테이너 대신), zip 은 작은 HTTP 서버가 받고,
//  Lambda 는 메모리 속 가짜(부른 것을 기록)다. 판 파일은 DB 저장소(S3 설정 없음).
//  D1 첫 배포 · D2 이름만 바꾼 판(빌드·코드 올리기 0) · D3 빌드 안 된 판 공개 409 → 빌드 뒤 공개(pub = cur 함수 판) · D4 남이 저장한 판은 내 세션에서 빌드하지 않는다
//  D5 시험 호출 실패 → 별칭 그대로 · D6 빌드 실패 → Lambda 0 · D7 다른 워크스페이스 태그 → 409 · D8 멈춤/다시 켜기 권한 · D9 감시(넘음 · 같음 · 조용한 함수 30분)
//  D10 빌드 있는 판으로 되돌리기 → cur 가 따라간다 · D11 앱 지우기 → 함수 · 로그 · 기록 · zip · D12 죽은 빌드 · D13 서버 선언 없음 400 · D14 앱 서버 꺼짐
import pg from "pg";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_servers_4484";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG */ });
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_APP_BUNDLE_BUCKET", "LIVELY_APP_BUNDLE_POLICY", "LIVELY_APP_SERVER_POLICY", "LIVELY_APP_SERVER_PREFIX"]) delete process.env[k];
const ROLE = "arn:aws:iam::111122223333:role/lvly-app-exec";
process.env.LIVELY_APP_SERVER_EXEC_ROLE = ROLE;
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { appServerCapabilities } = await import(`${D}/capabilities/app-servers.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const { setServerDepsForTest } = await import(`${D}/apps/app-server-deploy.js`);
const { SERVER_BUILDER_JS } = await import(`${D}/apps/app-server-builder.js`);
const { watchAppServers, resetWatchStateForTest, runAppServerHousekeeping } = await import(`${D}/apps/app-server-watch.js`);
const { appServerPolicy } = await import(`${D}/apps/app-server-store.js`);
const { AwsError } = await import(`${D}/net/aws/aws-json.js`);
const { SINGLE_TENANT_ID } = await import(`${D}/db/tenant-column.js`);

const all = [...appCapabilities, ...appServerCapabilities];
const cap = (n) => { const c = all.find((x) => x.name === n); if (!c) throw new Error(`능력 없음: ${n}`); return c; };
const call = (n, input, user, ctx = { source: "mcp" }) => cap(n).handler(input, user, ctx);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const alice = { userId: "pgt-alice", email: "a@x", scopes: ["memory"], projects: ["*"] };
const bob = { userId: "pgt-bob", email: "b@x", scopes: ["memory"], projects: ["*"] };
const boss = { userId: "pgt-boss", email: "boss@x", scopes: ["memory", "admin"], projects: ["*"] };
let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
for (const [id, scopes] of [["pgt-alice", ["memory"]], ["pgt-bob", ["memory"]], ["pgt-boss", ["memory", "admin"]]]) {
  await q(`INSERT INTO org_member(id, kind, display_name, state, scopes) VALUES($1,'human',$1,'active',$2::jsonb)`, [id, JSON.stringify(scopes)]);
}
//  세션 — 주인 판정(sessionOwnerOf)은 org_session_state.owner 를 본다.
await q(`INSERT INTO org_session_state(id, owner) VALUES ('box-pgt-alice-1','pgt-alice'), ('box-pgt-bob-1','pgt-bob')`);
const aliceCtx = { source: "mcp", session: "box-pgt-alice-1" };
const bobCtx = { source: "mcp", session: "box-pgt-bob-1" };

// ── zip 저장소(빌더가 PUT 하는 작은 서버) ──
const zips = new Map();
const zsrv = http.createServer((req, res) => {
  const parts = []; req.on("data", (d) => parts.push(d));
  req.on("end", () => { zips.set(decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)), Buffer.concat(parts)); res.writeHead(200); res.end(); });
});
await new Promise((r) => zsrv.listen(0, "127.0.0.1", r));
const zport = zsrv.address().port;
const shaB64 = (b) => crypto.createHash("sha256").update(b).digest("base64");

// ── 세션 실행 = 이 기계의 node(진짜 빌더) — 누구의 세션에서 돌았나 기록 ──
const seats = [];
const spawnInSession = async (seat, argv) => { seats.push(seat); return spawn(process.execPath, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, npm_config_offline: "true" } }); };

// ── 가짜 Lambda ──
const fns = new Map();
const log = [];
let invokeMode = "ok";
const cfgOf = (f) => JSON.parse(JSON.stringify(f.cfg));
const api = {
  getFunction: async (n) => { const f = fns.get(n); return f ? { Configuration: cfgOf(f), Tags: { ...f.tags } } : null; },
  getFunctionConfiguration: async (n) => { const f = fns.get(n); return f ? cfgOf(f) : null; },
  createFunction: async (i) => {
    log.push(["createFunction", i]);
    if (fns.has(i.FunctionName)) throw new AwsError(409, "ResourceConflictException", "exists");
    const z = zips.get(i.Code.S3Key);
    fns.set(i.FunctionName, { cfg: { FunctionName: i.FunctionName, Role: i.Role, Handler: i.Handler, Runtime: i.Runtime, MemorySize: i.MemorySize, Timeout: i.Timeout,
      Layers: i.Layers.map((a) => ({ Arn: a })), Environment: i.Environment, Architectures: i.Architectures, CodeSha256: z ? shaB64(z) : "?", State: "Active", LastUpdateStatus: "Successful" },
      tags: { ...i.Tags }, versions: [], aliases: new Map(), conc: null });
    return cfgOf(fns.get(i.FunctionName));
  },
  updateFunctionCode: async (n, code) => { log.push(["updateFunctionCode", n, code.S3Key]); const f = fns.get(n); f.cfg.CodeSha256 = shaB64(zips.get(code.S3Key)); return cfgOf(f); },
  updateFunctionConfiguration: async (n, i) => { log.push(["updateFunctionConfiguration", n, i]); const f = fns.get(n); Object.assign(f.cfg, i, i.Layers ? { Layers: i.Layers.map((a) => ({ Arn: a })) } : {}); return cfgOf(f); },
  publishVersion: async (n, i) => {
    log.push(["publishVersion", n, i.CodeSha256]);
    const f = fns.get(n);
    if (i.CodeSha256 !== f.cfg.CodeSha256) throw new AwsError(412, "PreconditionFailedException", "sha");
    const last = f.versions[f.versions.length - 1];
    if (last && last.CodeSha256 === f.cfg.CodeSha256) return { ...cfgOf(f), Version: last.Version };
    const v = { Version: String(f.versions.length + 1), CodeSha256: f.cfg.CodeSha256 };
    f.versions.push(v);
    return { ...cfgOf(f), Version: v.Version };
  },
  listVersions: async (n) => [{ Version: "$LATEST" }, ...(fns.get(n)?.versions ?? [])],
  putAlias: async (n, a, v) => { log.push(["putAlias", n, a, v]); fns.get(n).aliases.set(a, v); return { Name: a, FunctionVersion: v, AliasArn: `${n}:${a}` }; },
  invoke: async (n, qual) => {
    log.push(["invoke", n, qual]);
    if (invokeMode === "ok") return { status: 200, functionError: null, log: "START\nEND", payload: JSON.stringify({ statusCode: 200, body: "hi" }), executedVersion: qual };
    return { status: 200, functionError: "Unhandled", log: "INFO app is not ready after 2000ms url=http://127.0.0.1:8080/\nError: web application did not become ready", payload: JSON.stringify({ errorType: "Extension.Crash" }), executedVersion: qual };
  },
  deleteFunction: async (n, qual) => { log.push(["deleteFunction", n, qual ?? null]); const f = fns.get(n); if (!f) return; if (qual) f.versions = f.versions.filter((v) => v.Version !== qual); else fns.delete(n); },
  putConcurrency: async (n, k) => { log.push(["putConcurrency", n, k]); fns.get(n).conc = k; },
  deleteConcurrency: async (n) => { log.push(["deleteConcurrency", n]); const f = fns.get(n); if (f) f.conc = null; },
  ensureLogGroup: async (g, d) => { log.push(["ensureLogGroup", g, d]); },
  deleteLogGroup: async (g) => { log.push(["deleteLogGroup", g]); },
};
const deletedZips = [];
setServerDepsForTest({
  api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession,
  presignPut: async (key) => `http://127.0.0.1:${zport}/${encodeURIComponent(key)}`,
  headZip: async (key) => (zips.has(key) ? { size: zips.get(key).length } : null),
  deleteZip: async (key) => { deletedZips.push(key); zips.delete(key); },
});
const calls = (op) => log.filter((x) => x[0] === op);
const FN = "lvly-app-srv-local";

// ── 표본 서버 앱 ──
const LOCK = JSON.stringify({ name: "srv", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "srv", version: "1.0.0" } } });
const filesOf = ({ title = "서버 앱", server = "require('http').createServer((q,s)=>s.end('v1')).listen(Number(process.env.PORT));", build = "require('fs').writeFileSync('built.txt','ok');", decl = {} } = {}) => [
  { path: "lively-app.json", content: JSON.stringify({ id: "srv", title, version: "1.0.0", permissions: { scopes: [], tools: [] }, data: { tables: [] }, ui: { pages: [{ key: "main", title, entry: "ui/index.html" }] }, web: { server: decl } }) },
  { path: "ui/index.html", content: "<p>서버 앱</p>" },
  { path: "package.json", content: JSON.stringify({ name: "srv", version: "1.0.0", private: true, scripts: { start: "node server.js", build: "node build.js" } }) },
  { path: "package-lock.json", content: LOCK },
  { path: "server.js", content: server },
  { path: "build.js", content: build },
];
const serverRow = async () => (await q(`SELECT * FROM org_app_server WHERE app_id='srv'`))[0];

// D13 서버 선언 없는 앱 → 400
await call("app_save", { files: [{ path: "lively-app.json", content: JSON.stringify({ id: "plain", title: "그냥 앱", version: "1.0.0", permissions: { scopes: [], tools: [] }, data: { tables: [] }, ui: { pages: [{ key: "main", title: "x", entry: "ui/index.html" }] } }) }, { path: "ui/index.html", content: "<p>x</p>" }] }, alice, aliceCtx);
{ const e = await errOf(call("app_server_deploy", { app_id: "plain" }, alice, aliceCtx)); chk("D13 서버 선언 없는 앱 → 400", e?.status === 400, String(e?.message)); }

// D1 첫 배포
const s1 = await call("app_save", { files: filesOf() }, alice, aliceCtx);
chk("D1a 저장 응답이 «서버는 아직 빌드 안 됨» 을 알린다(저장은 빌드하지 않는다)", s1.server?.declared === true && seats.length === 0, JSON.stringify(s1.server));
const d1 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
const r1 = await serverRow();
const cf = calls("createFunction")[0]?.[1];
chk("D1b 배포 성공 · 빌드 1번(앨리스의 세션)", d1.status === "deployed" && seats.length === 1 && seats[0].memberId === "pgt-alice" && seats[0].sessionId === "box-pgt-alice-1", JSON.stringify({ d1, seats }));
chk("D1c 함수 만들기 — 역할 · 핸들러 · 런타임 · arm64 · 512MB · 30초 · 어댑터 레이어 · 환경 · 워크스페이스 태그 · S3 zip",
  cf && cf.FunctionName === FN && cf.Role === ROLE && cf.Handler === "lively-run.sh" && cf.Runtime === "nodejs22.x" && cf.Architectures[0] === "arm64" && cf.MemorySize === 512 && cf.Timeout === 30
  && cf.Layers.length === 1 && /LambdaAdapterLayerArm64:30$/.test(cf.Layers[0]) && cf.Environment.Variables.AWS_LAMBDA_EXEC_WRAPPER === "/opt/bootstrap" && cf.Environment.Variables.AWS_LWA_READINESS_CHECK_PROTOCOL === "tcp"
  && cf.Tags["lvly:tenant"] === SINGLE_TENANT_ID && cf.Code.S3Bucket === "fake-bucket" && zips.has(cf.Code.S3Key), JSON.stringify(cf));
chk("D1d 로그 그룹(보관 14일) → 판 고정(코드 지문 조건) → 그 판으로 시험 호출 → 별칭 cur(나만 보는 앱이라 pub 없음)",
  calls("ensureLogGroup")[0]?.[1] === `/aws/lambda/${FN}` && calls("ensureLogGroup")[0]?.[2] === 14 && calls("publishVersion").length === 1
  && calls("publishVersion")[0][2] === shaB64(zips.get(cf.Code.S3Key)) && calls("invoke")[0]?.[2] === "1" && calls("putAlias").length === 1 && calls("putAlias")[0][2] === "cur",
  JSON.stringify(log.map((x) => x[0])));
chk("D1e 기록 — cur = 1판 · 함수 판 1 · 빌드 ok", r1?.cur_lambda_version === "1" && r1?.cur_version_no === s1.version_no && r1?.pub_lambda_version == null
  && (await q(`SELECT status FROM org_app_server_build WHERE app_id='srv'`))[0]?.status === "ok", JSON.stringify(r1));

// D2 이름만 바꾼 판 → 빌드 0 · 코드 올리기 0 · 시험 호출 0
const before2 = log.length;
await call("app_save", { files: filesOf({ title: "서버 앱 · 이름만" }) }, alice, aliceCtx);
const d2 = await call("app_server_deploy", { app_id: "srv", wait_s: 60 }, alice, aliceCtx);
const ops2 = log.slice(before2).map((x) => x[0]);
chk("D2 이름만 바꾼 판 — 빌드 · 코드 올리기 · 판 고정 · 시험 호출 없이 별칭만", d2.status === "deployed" && d2.build.reused === true && seats.length === 1
  && !ops2.includes("updateFunctionCode") && !ops2.includes("publishVersion") && !ops2.includes("invoke"), JSON.stringify(ops2));

// D3 빌드 안 된 판 공개 → 409 · 빌드 뒤 공개 → pub = cur
await call("app_save", { files: filesOf({ server: "require('http').createServer((q,s)=>s.end('v2')).listen(Number(process.env.PORT));" }) }, alice, aliceCtx);
{
  const e = await errOf(call("app_visibility_set", { app_id: "srv", visibility: "all" }, alice, aliceCtx));
  const app = (await q(`SELECT visibility, published_version_no FROM org_app WHERE id='srv'`))[0];
  chk("D3a 빌드 안 된 판 공개 → 409 · 공개 안 됨", e?.status === 409 && app.visibility === "me" && app.published_version_no == null, String(e?.message));
}
const d3 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
const pub3 = await call("app_visibility_set", { app_id: "srv", visibility: "all" }, alice, aliceCtx);
const r3 = await serverRow();
chk("D3b 빌드 뒤 공개 — pub 별칭이 cur 와 같은 함수 판 · 시험 호출 다시 안 함", d3.status === "deployed" && seats.length === 2 && pub3.changed === true && pub3.server?.ok === true
  && r3.pub_lambda_version === r3.cur_lambda_version && r3.pub_build_key === r3.cur_build_key && fns.get(FN).aliases.get("pub") === r3.cur_lambda_version,
  JSON.stringify({ pub3: pub3.server, r3 }));
const builtKeyV2 = r3.cur_build_key;
const v2no = (await q(`SELECT current_version_no FROM org_app WHERE id='srv'`))[0].current_version_no;

// D4 남이 저장한 판 — 내 세션에서 빌드하지 않는다
await call("app_save", { files: filesOf({ server: "require('http').createServer((q,s)=>s.end('bob')).listen(Number(process.env.PORT));" }) }, bob, bobCtx);
{
  const seats0 = seats.length;
  const e = await errOf(call("app_server_deploy", { app_id: "srv", wait_s: 60 }, alice, aliceCtx));
  chk("D4a 밥이 저장한 판을 앨리스가 배포 → 409 · 앨리스 세션에서 아무것도 안 돌았다", e?.status === 409 && seats.length === seats0, String(e?.message));
  const db = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, bob, bobCtx);
  chk("D4b 밥이 자기 세션에서 빌드 · 배포", db.status === "deployed" && seats.length === seats0 + 1 && seats[seats.length - 1].memberId === "pgt-bob", JSON.stringify(db));
  const da = await call("app_server_deploy", { app_id: "srv", wait_s: 60 }, alice, aliceCtx);
  chk("D4c 빌드가 있으면 앨리스도 올린다(빌드 없이)", da.status === "deployed" && da.build.reused === true && seats.length === seats0 + 1, JSON.stringify(da.build));
  const r4 = await serverRow();
  chk("D4d 밥의 초안 배포는 cur 만 — 공개 판(pub)은 그대로", r4.pub_build_key === builtKeyV2 && r4.cur_build_key !== builtKeyV2, JSON.stringify(r4));
}

// D5 시험 호출 실패 → 별칭 그대로 · last_error
{
  const cur0 = (await serverRow()).cur_lambda_version;
  invokeMode = "notready";
  await call("app_save", { files: filesOf({ server: "require('http').createServer((q,s)=>s.end('np')).listen(3999);" }) }, alice, aliceCtx);
  const d5 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  const r5 = await serverRow();
  chk("D5 시험 호출 실패 → stage smoke · 기록 끝부분 · 별칭 그대로 · last_error", d5.status === "failed" && d5.stage === "smoke" && /not ready/.test(String(d5.log))
    && r5.cur_lambda_version === cur0 && !!r5.last_error && fns.get(FN).aliases.get("cur") === cur0, JSON.stringify({ d5: { status: d5.status, stage: d5.stage }, r5 }));
  invokeMode = "ok";
}

// D6 빌드 실패 → Lambda 0
{
  const n0 = log.length;
  await call("app_save", { files: filesOf({ build: "process.exit(5);" }) }, alice, aliceCtx);
  const d6 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  chk("D6 빌드 실패 → stage build · Lambda 호출 0", d6.status === "failed" && d6.stage === "build" && log.length === n0, JSON.stringify({ stage: d6.stage, ops: log.slice(n0).map((x) => x[0]) }));
}

// D7 같은 이름 함수가 다른 워크스페이스 태그 → 코드 안 올림
{
  fns.get(FN).tags["lvly:tenant"] = "11111111-2222-3333-4444-555555555555";
  const n0 = calls("updateFunctionCode").length;
  await call("app_save", { files: filesOf({ server: "require('http').createServer((q,s)=>s.end('v7')).listen(Number(process.env.PORT));" }) }, alice, aliceCtx);
  const d7 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  chk("D7 다른 워크스페이스 태그 → 실패 · 코드 안 올림", d7.status === "failed" && /다른 워크스페이스/.test(String(d7.error)) && calls("updateFunctionCode").length === n0, String(d7.error));
  fns.get(FN).tags["lvly:tenant"] = SINGLE_TENANT_ID;
}

// D8 멈춤 · 다시 켜기 권한
{
  const e1 = await errOf(call("app_server_stop", { app_id: "srv" }, bob, bobCtx));
  chk("D8a 책임자 · 관리자가 아니면 멈출 수 없다", e1?.status === 403, String(e1?.message));
  await call("app_server_stop", { app_id: "srv", reason: "시험" }, alice, aliceCtx);
  chk("D8b 멈춤 → 동시 실행 0 · 기록", fns.get(FN).conc === 0 && (await serverRow()).stopped_by === "pgt-alice");
  const re = await call("app_server_resume", { app_id: "srv" }, alice, aliceCtx);
  chk("D8c 손으로 멈춘 책임자는 다시 켤 수 있다 → 동시 실행 설정 지움", re.changed === true && fns.get(FN).conc === null && (await serverRow()).stopped_at == null);
}

// D9 감시
{
  resetWatchStateForTest();
  const notes = [];
  const policy = await appServerPolicy();
  const mk = (inv, durMs) => async (queries) => queries.map((x) => ({ id: x.id, values: [x.metric === "Invocations" ? inv : durMs], timestamps: [0] }));
  const w0 = await watchAppServers(policy, { api, metrics: mk(30_000, 1000), notify: async (a, title) => { notes.push(title); }, now: () => 1_000_000 });
  chk("D9a 호출 = 상한이면 멈추지 않는다", w0.checked === 1 && w0.stopped.length === 0 && fns.get(FN).conc === null);
  const w1 = await watchAppServers(policy, { api, metrics: mk(30_001, 1000), notify: async (a, title) => { notes.push(title); }, now: () => 1_000_000 + 60_000 });
  const r9 = await serverRow();
  chk("D9b 호출 > 상한 → 자동 멈춤 · 동시 실행 0 · 알림", w1.stopped[0] === "srv" && fns.get(FN).conc === 0 && String(r9.stop_reason).startsWith("auto:") && notes.length === 1, JSON.stringify({ w1, r9 }));
  const e = await errOf(call("app_server_resume", { app_id: "srv" }, alice, aliceCtx));
  chk("D9c 자동 멈춤은 책임자가 못 켠다 · 관리자는 켠다", e?.status === 403 && (await call("app_server_resume", { app_id: "srv" }, boss)).changed === true);
  resetWatchStateForTest();
  let asked = 0;
  const quiet = async (queries) => { asked++; return queries.map((x) => ({ id: x.id, values: [0], timestamps: [0] })); };
  await watchAppServers(policy, { api, metrics: quiet, now: () => 5_000_000 });
  const w2 = await watchAppServers(policy, { api, metrics: quiet, now: () => 5_000_000 + 10 * 60_000 });
  const w3 = await watchAppServers(policy, { api, metrics: quiet, now: () => 5_000_000 + 31 * 60_000 });
  chk("D9d 조용한 함수는 30분 뒤에 다시 본다(지표 비용)", asked === 2 && w2.checked === 0 && w3.checked === 1, JSON.stringify({ asked, w2, w3 }));
}

// D10 빌드 있는 판으로 되돌리기 → cur 가 따라간다
{
  const seats0 = seats.length;
  const before = (await serverRow()).cur_build_key;
  const rv = await call("app_revert", { app_id: "srv", version_no: v2no }, alice, aliceCtx);
  let r10 = await serverRow();
  for (let i = 0; i < 50 && r10.cur_build_key !== builtKeyV2; i++) { await new Promise((r) => setTimeout(r, 100)); r10 = await serverRow(); }
  chk("D10 되돌린 판의 빌드로 cur 가 따라간다(빌드 없음)", before !== builtKeyV2 && rv.server?.following === true && r10.cur_build_key === builtKeyV2 && seats.length === seats0,
    JSON.stringify({ before, cur: r10.cur_build_key, want: builtKeyV2, seats: [seats0, seats.length] }));
}

// D12 죽은 빌드 → 하우스키핑이 실패로
{
  await q(`INSERT INTO org_app_server_build(app_id, build_key, status, started_at, lease_until) VALUES ('srv', $1, 'building', now() - interval '1 hour', now() - interval '10 minutes')`, ["f".repeat(64)]);
  const hk = await runAppServerHousekeeping({ api, metrics: async () => [], notify: async () => {} });
  const b = (await q(`SELECT status, stage FROM org_app_server_build WHERE build_key=$1`, ["f".repeat(64)]))[0];
  chk("D12 죽은 빌드(lease 지남) → failed · interrupted", b.status === "failed" && b.stage === "interrupted" && hk.stale_builds >= 1, JSON.stringify({ b, hk }));
}

// D11 앱 지우기 → 함수 · 로그 · 기록 · zip
{
  const zipKeys = (await q(`SELECT zip_key FROM org_app_server_build WHERE app_id='srv' AND zip_key IS NOT NULL`)).map((x) => x.zip_key);
  await call("org_app_remove", { app_id: "srv" }, boss);
  const left = await q(`SELECT 1 FROM org_app_server WHERE app_id='srv' UNION ALL SELECT 1 FROM org_app_server_build WHERE app_id='srv'`);
  chk("D11 앱 지우기 → 함수 지움 · 로그 그룹 지움 · 기록 0 · zip 지움", !fns.has(FN) && calls("deleteLogGroup").some((x) => x[1] === `/aws/lambda/${FN}`) && left.length === 0
    && zipKeys.length > 0 && zipKeys.every((k) => deletedZips.includes(k)), JSON.stringify({ left, zipKeys: zipKeys.length, deleted: deletedZips.length }));
}

// D14 앱 서버 꺼짐 — 배포 503 · 공개는 그대로 된다
{
  delete process.env.LIVELY_APP_SERVER_EXEC_ROLE;
  await call("app_save", { files: filesOf().map((f) => (f.path === "lively-app.json" ? { ...f, content: f.content.replace('"id":"srv"', '"id":"srv2"') } : f)) }, alice, aliceCtx);
  const e = await errOf(call("app_server_deploy", { app_id: "srv2" }, alice, aliceCtx));
  const pubOk = await call("app_visibility_set", { app_id: "srv2", visibility: "all" }, alice, aliceCtx);
  chk("D14 앱 서버가 꺼진 배포 — 배포 503 · 서버 앱도 공개는 된다(화면은 돈다)", e?.status === 503 && pubOk.changed === true && pubOk.server == null, String(e?.message));
  process.env.LIVELY_APP_SERVER_EXEC_ROLE = ROLE;
}

zsrv.close();
await itemsPool.end().catch(() => {});
await dbc.end(); await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); await su.end();
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
