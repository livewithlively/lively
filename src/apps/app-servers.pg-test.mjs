// 앱 서버(#4484 앱 v2-5) PG 통합 시험 — **실제 Postgres 필요**(기본 npm test 체인 밖, CI services:postgres 스텝).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-servers.pg-test.mjs
//
// 사양 표 D(spec-4484.md) — 새 DB(initAllSchemas) 위에서 능력(app_save · app_server_deploy · app_visibility_set · app_revert · app_server_stop/resume ·
//  org_app_remove)을 그대로 부른다. 빌드는 **진짜 빌더**(SERVER_BUILDER_JS)를 이 기계의 node 로 돌리고(세션 컨테이너 대신), zip 은 작은 HTTP 서버가 받고,
//  Lambda 는 메모리 속 가짜(부른 것을 기록)다. 판 파일은 DB 저장소(S3 설정 없음).
//  D1 첫 배포 · D2 이름만 바꾼 판(빌드·코드 올리기 0) · D3 빌드 안 된 판 공개 409 → 빌드 뒤 공개(pub = cur 함수 판) · D4 남이 저장한 판은 내 세션에서 빌드하지 않는다
//  D5 시험 호출 실패 → 별칭 그대로 · D6 빌드 실패 → Lambda 0 · D7 다른 워크스페이스 태그 → 409 · D8 멈춤/다시 켜기 권한 · D9 감시(넘음 · 같음 · 조용한 함수 30분)
//  D10 빌드 있는 판으로 되돌리기 → cur 가 따라간다 · D11 앱 지우기 → 함수 · 로그 · 기록 · zip · D12 죽은 빌드 · D13 서버 선언 없음 400 · D14 앱 서버 꺼짐
//  격리 리뷰 뒤(R): R1 같은 파일의 두 앱 — zip 은 앱마다 · 하나를 지워도 다른 앱 되돌리기가 된다 · zip 이 없어지면 다시 빌드한다
//   R2 자동 멈춤 · 관리자 멈춤을 책임자가 «멈추기 → 다시 켜기» 로 못 푼다 · R3 남의 워크스페이스 함수는 멈추지도 지우지도 않는다
//   R4 함수를 못 지우면 줄을 남기고 하우스키핑이 다시 지운다 · R5 상한을 바꾸면 같은 코드도 새 설정의 판으로 · R6 화면 단추 길(세션 없음 → 만들기 세션)
//  #4792 워크스페이스 상한(W — 사양 엣지 표 spec-4792.md): W1 코드 크기 기록(C1 · C2 · U2) · W2 함수 수 상한(F2~F4 · F1 은 D1 이 함수 0개에서 지난다)
//   W3 동시 첫 배포(F5) · W4 코드 저장 상한 · 같은 빌드 재사용(C3 · C7) · W5 함수 없는 앱이 코드 상한(C6) · W6 보기 · 고치기 범위(U1 · U3)
//   W7 코드를 올린 뒤 실패해도 다시 잰다(C9) · W8 공개 길도 같은 판정(F7)
//   격리 리뷰 뒤: W9 동시 배포도 코드 상한을 넘지 않는다(자리 잡기) · W10 하우스키핑이 크기를 모르는 줄을 잰다 · W11 만든 직후 실패도 잰다
//   W12 zip 크기를 모르는 빌드는 저장소 크기로 채운다 · W13 첫 배포가 함수 없이 끝나면 빈 줄을 걷는다 · W14 되돌리기도 함수 수 상한을 알린다
//   W15 잠금을 기다리는 사이 줄이 사라지면 다시 잡는다 · X2 40일 된 빌드도 걷은 뒤 유예 · X8 잠긴 함수 · X9 남의 함수 · X10 지우기 실패
//   재검토 뒤: W16 기다리는 사이 앱이 지워지면 줄을 되살리지 않는다 · W17 있는 함수가 자리를 잡은 뒤 실패해도 실측 · W18 만들기 응답 실패(함수는 생김)도 실측
//   W19 하우스키핑의 늦은 측정이 배포가 적은 값을 덮지 않는다 · W20 못 재는 줄이 앞자리를 차지해도 다른 줄이 굶지 않는다
//   W21 남의 함수 크기는 우리 줄에 적지 않는다 · W22 함수가 있는지 확인 못 하면 줄을 지우지 않는다
//  #4791 서버 선언을 뺀 앱의 함수 정리(X — 사양 엣지 표 R1~R9): X1 표시 · 상태 retire_at · X2 7일 경계 · 걷기(빌드는 남김) · X3 되돌리면 다시 생김
//   X4 공개 판에 서버가 남아 있으면 표시 안 함 · X5 서버 선언이 돌아오면 표시를 걷음(X5b 다시 배포하면 곧바로) · X6 멈춘 함수는 걷지 않음 · X7 걷기 직전 다시 봄
import "../../scripts/test-apps-root.mjs";   // #4778 앱 폴더 자리를 임시 폴더로 — 앱을 만들고 지우는 시험이 실제 ~/apps 를 옮기지 않게
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
const { watchAppServers, resetWatchStateForTest, runAppServerHousekeeping, retireUnusedServers, refreshUnknownCodeBytes } = await import(`${D}/apps/app-server-watch.js`);
const { appServerPolicy, setServerStopped, claimServerRow } = await import(`${D}/apps/app-server-store.js`);
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
//  Lambda 는 만들기 · 코드 고치기 때 S3 에서 zip 을 읽는다 — 없으면 실제와 같은 오류(InvalidParameterValueException · NoSuchKey).
const zipOr = (k) => { const z = zips.get(k); if (!z) throw new AwsError(400, "InvalidParameterValueException", "Error occurred while GetObject. S3 Error Code: NoSuchKey. S3 Error Message: The specified key does not exist."); return z; };
const failDelete = new Set();   // R4 — 이 함수 지우기는 실패한다(AWS 오류 흉내)
let s3Denied = false;           // R1g — 다음 코드 올리기를 S3 권한 오류로(zip 은 있다)
let publishDelayMs = 0;         // W9 — 판 고정을 늦춰 «판정 뒤 · 실측 앞» 창을 넓힌다
let createFail = null;          // W13 — 다음 함수 만들기를 이 AWS 오류로
const readyFail = new Set();    // W11 — 이 함수는 만든 뒤 «Failed» 상태로 보인다(준비 기다리기가 실패)
let createThenFail = null;      // W18 — 다음 함수 만들기는 AWS 에선 되지만 응답은 이 오류로(시간 넘김 흉내)
let logFail = null;             // W17 — 다음 로그 그룹 맞추기를 이 AWS 오류로
const api = {
  getFunction: async (n) => { const f = fns.get(n); return f ? { Configuration: cfgOf(f), Tags: { ...f.tags } } : null; },
  //  판을 주면 그 판을 고정할 때의 설정(판은 바뀌지 않는다) — 없으면 $LATEST.
  getFunctionConfiguration: async (n, qual) => {
    const f = fns.get(n); if (!f) return null;
    if (readyFail.has(n)) return { ...cfgOf(f), State: "Failed", StateReason: "흉내 — 만든 뒤 실패" };
    if (qual && qual !== "$LATEST") { const v = f.versions.find((x) => x.Version === qual); return v ? JSON.parse(JSON.stringify(v.cfg)) : null; }
    return cfgOf(f);
  },
  createFunction: async (i) => {
    log.push(["createFunction", i]);
    if (createFail) { const e = createFail; createFail = null; throw e; }
    if (fns.has(i.FunctionName)) throw new AwsError(409, "ResourceConflictException", "exists");
    const z = zipOr(i.Code.S3Key);
    fns.set(i.FunctionName, { cfg: { FunctionName: i.FunctionName, Role: i.Role, Handler: i.Handler, Runtime: i.Runtime, MemorySize: i.MemorySize, Timeout: i.Timeout,
      Layers: i.Layers.map((a) => ({ Arn: a })), Environment: i.Environment, Architectures: i.Architectures, CodeSha256: shaB64(z), CodeSize: z.length, State: "Active", LastUpdateStatus: "Successful" },
      tags: { ...i.Tags }, versions: [], seq: 0, aliases: new Map(), conc: null });
    if (createThenFail) { const e = createThenFail; createThenFail = null; throw e; }
    return cfgOf(fns.get(i.FunctionName));
  },
  updateFunctionCode: async (n, code) => {
    log.push(["updateFunctionCode", n, code.S3Key]);
    if (s3Denied) { s3Denied = false; throw new AwsError(400, "InvalidParameterValueException", "Error occurred while GetObject. S3 Error Code: AccessDenied. S3 Error Message: Access Denied"); }
    const f = fns.get(n); const z = zipOr(code.S3Key); f.cfg.CodeSha256 = shaB64(z); f.cfg.CodeSize = z.length; return cfgOf(f);
  },
  updateFunctionConfiguration: async (n, i) => { log.push(["updateFunctionConfiguration", n, i]); const f = fns.get(n); Object.assign(f.cfg, i, i.Layers ? { Layers: i.Layers.map((a) => ({ Arn: a })) } : {}); return cfgOf(f); },
  publishVersion: async (n, i) => {
    log.push(["publishVersion", n, i.CodeSha256]);
    if (publishDelayMs) await new Promise((r) => setTimeout(r, publishDelayMs));
    const f = fns.get(n);
    if (i.CodeSha256 !== f.cfg.CodeSha256) throw new AwsError(412, "PreconditionFailedException", "sha");
    //  실제와 같게: 코드 · 설정이 마지막 판과 같으면 새 판을 만들지 않고 그 판을 돌려준다(설정이 바뀌면 새 판).
    const snap = cfgOf(f);
    const last = f.versions[f.versions.length - 1];
    if (last && JSON.stringify(last.cfg) === JSON.stringify(snap)) return { ...snap, Version: last.Version };
    const v = { Version: String(++f.seq), CodeSha256: f.cfg.CodeSha256, cfg: snap };
    f.versions.push(v);
    return { ...snap, Version: v.Version };
  },
  //  실제(ListVersionsByFunction)처럼 $LATEST 와 판마다 CodeSize — #4792 코드 저장 셈이 이 값을 더한다.
  listVersions: async (n) => { const f = fns.get(n); return f ? [{ Version: "$LATEST", CodeSize: f.cfg.CodeSize }, ...f.versions.map((v) => ({ Version: v.Version, CodeSize: v.cfg.CodeSize }))] : []; },
  putAlias: async (n, a, v) => { log.push(["putAlias", n, a, v]); fns.get(n).aliases.set(a, v); return { Name: a, FunctionVersion: v, AliasArn: `${n}:${a}` }; },
  invoke: async (n, qual) => {
    log.push(["invoke", n, qual]);
    if (invokeMode === "ok") return { status: 200, functionError: null, log: "START\nEND", payload: JSON.stringify({ statusCode: 200, body: "hi" }), executedVersion: qual };
    return { status: 200, functionError: "Unhandled", log: "INFO app is not ready after 2000ms url=http://127.0.0.1:8080/\nError: web application did not become ready", payload: JSON.stringify({ errorType: "Extension.Crash" }), executedVersion: qual };
  },
  deleteFunction: async (n, qual) => {
    log.push(["deleteFunction", n, qual ?? null]);
    if (!qual && failDelete.has(n)) throw new AwsError(500, "ServiceException", "흉내 — 지우기 실패");
    const f = fns.get(n); if (!f) return; if (qual) f.versions = f.versions.filter((v) => v.Version !== qual); else fns.delete(n);
  },
  putConcurrency: async (n, k) => { log.push(["putConcurrency", n, k]); fns.get(n).conc = k; },
  deleteConcurrency: async (n) => { log.push(["deleteConcurrency", n]); const f = fns.get(n); if (f) f.conc = null; },
  ensureLogGroup: async (g, d) => { log.push(["ensureLogGroup", g, d]); if (logFail) { const e = logFail; logFail = null; throw e; } },
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
chk("D1a 저장 응답이 «서버는 아직 빌드 안 됨» 을 알린다(저장은 빌드하지 않는다)", s1.server?.declared === true && s1.server?.state === "not_built" && seats.length === 0, JSON.stringify(s1.server));
const d1 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
const r1 = await serverRow();
const cf = calls("createFunction")[0]?.[1];
chk("D1b 배포 성공 · 빌드 1번(앨리스의 세션)", d1.status === "deployed" && seats.length === 1 && seats[0].memberId === "pgt-alice" && seats[0].sessionId === "box-pgt-alice-1", JSON.stringify({ d1, seats }));
chk("D1c 함수 만들기 — 역할 · 핸들러 · 런타임 · arm64 · 512MB · 30초 · 어댑터 레이어 · 환경 · 워크스페이스 태그 · S3 zip",
  cf && cf.FunctionName === FN && cf.Role === ROLE && cf.Handler === "lively-run.sh" && cf.Runtime === "nodejs22.x" && cf.Architectures[0] === "arm64" && cf.MemorySize === 512 && cf.Timeout === 30
  && cf.Layers.length === 1 && /LambdaAdapterLayerArm64:30$/.test(cf.Layers[0]) && cf.Environment.Variables.AWS_LAMBDA_EXEC_WRAPPER === "/opt/bootstrap" && cf.Environment.Variables.AWS_LWA_READINESS_CHECK_PROTOCOL === "tcp"
  && cf.Tags["lvly:tenant"] === SINGLE_TENANT_ID && cf.Code.S3Bucket === "fake-bucket" && zips.has(cf.Code.S3Key) && cf.Code.S3Key.includes("/z/srv/"), JSON.stringify(cf));
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
  const pc8 = calls("putConcurrency").length;
  const again = await call("app_server_stop", { app_id: "srv", reason: "다시" }, boss);
  const r8 = await serverRow();
  chk("D8d 이미 멈춘 함수를 또 멈추면 그대로 — AWS 를 다시 부르지 않고 · 멈춘 사람 · 까닭 · 종류를 덮지 않는다", again.changed === false && calls("putConcurrency").length === pc8
    && r8.stopped_by === "pgt-alice" && r8.stop_reason === "시험" && r8.stop_kind === "manual", JSON.stringify(r8));
  const wrote = await setServerStopped("srv", { by: "pgt-boss", kind: "manual", reason: "저장 계층에 바로" });
  const r8b = await serverRow();
  chk("D8f 저장 계층도 멈춘 줄을 덮지 않는다(두 번째 벽)", wrote === false && r8b.stopped_by === "pgt-alice" && r8b.stop_reason === "시험", JSON.stringify(r8b));
  const re = await call("app_server_resume", { app_id: "srv" }, alice, aliceCtx);
  chk("D8c 손으로 멈춘 책임자는 다시 켤 수 있다 → 동시 실행 설정 지움", re.changed === true && fns.get(FN).conc === null && (await serverRow()).stopped_at == null);
  //  자동 멈춤인지는 감시만 쓰는 칸으로 — 사람이 까닭에 무엇을 쓰든 손 멈춤은 손 멈춤이다.
  await call("app_server_stop", { app_id: "srv", reason: "auto: 흉내" }, alice, aliceCtx);
  let re2 = null; const e8 = await errOf((async () => { re2 = await call("app_server_resume", { app_id: "srv" }, alice, aliceCtx); })());
  chk("D8e 까닭 글에 «auto:» 를 써도 손 멈춤 — 멈춘 책임자가 다시 켠다(종류 칸으로 가른다)", !e8 && re2?.changed === true && fns.get(FN).conc === null, String(e8?.message));
  if (e8) await call("app_server_resume", { app_id: "srv" }, boss);
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
  chk("D9b 호출 > 상한 → 자동 멈춤 · 동시 실행 0 · 알림", w1.stopped[0] === "srv" && fns.get(FN).conc === 0 && r9.stop_kind === "auto" && r9.stopped_by === "auto" && notes.length === 1, JSON.stringify({ w1, r9 }));
  const e = await errOf(call("app_server_resume", { app_id: "srv" }, alice, aliceCtx));
  //  R2 — 책임자가 «멈추기» 로 기록을 자기 손 멈춤으로 바꾼 뒤 다시 켜는 길(격리 리뷰 재현)이 막혔나
  const over = await call("app_server_stop", { app_id: "srv", reason: "x" }, alice, aliceCtx);
  const e2 = await errOf(call("app_server_resume", { app_id: "srv" }, alice, aliceCtx));
  const r9b = await serverRow();
  chk("R2a 자동 멈춤 → 책임자 멈추기(그대로) → 책임자 다시 켜기 403 · 기록 그대로", e?.status === 403 && over.changed === false && e2?.status === 403 && r9b.stop_kind === "auto" && fns.get(FN).conc === 0,
    JSON.stringify({ e: e?.status, over, e2: e2?.status, r9b }));
  chk("D9c 자동 멈춤은 책임자가 못 켠다 · 관리자는 켠다", (await call("app_server_resume", { app_id: "srv" }, boss)).changed === true && fns.get(FN).conc === null);
  await call("app_server_stop", { app_id: "srv", reason: "관리자 확인 중" }, boss);
  await call("app_server_stop", { app_id: "srv", reason: "y" }, alice, aliceCtx);
  const e3 = await errOf(call("app_server_resume", { app_id: "srv" }, alice, aliceCtx));
  chk("R2b 관리자가 손으로 멈춘 것도 책임자가 «멈추기 → 다시 켜기» 로 못 푼다", e3?.status === 403 && (await serverRow()).stopped_by === "pgt-boss", String(e3?.message));
  await call("app_server_resume", { app_id: "srv" }, boss);
  resetWatchStateForTest();
  let asked = 0;
  const quiet = async (queries) => { asked++; return queries.map((x) => ({ id: x.id, values: [0], timestamps: [0] })); };
  await watchAppServers(policy, { api, metrics: quiet, now: () => 5_000_000 });
  const w2 = await watchAppServers(policy, { api, metrics: quiet, now: () => 5_000_000 + 10 * 60_000 });
  const w3 = await watchAppServers(policy, { api, metrics: quiet, now: () => 5_000_000 + 31 * 60_000 });
  chk("D9d 조용한 함수는 30분 뒤에 다시 본다(지표 비용)", asked === 2 && w2.checked === 0 && w3.checked === 1, JSON.stringify({ asked, w2, w3 }));
  //  실행 시간 합은 «호출 × 요청 시간 천장(60초)» 을 넘을 수 없다 — 호출 50번(× 60 = 3,000 = 기준)이면 묻지 않고, 51번이면 묻는다.
  resetWatchStateForTest();
  const metricsAsked = [];
  const rec = (n) => async (queries) => { metricsAsked.push(...queries.map((x) => x.metric)); return queries.map((x) => ({ id: x.id, values: [x.metric === "Invocations" ? n : 1000], timestamps: [0] })); };
  await watchAppServers(policy, { api, metrics: rec(50), now: () => 9_000_000 });
  const durAt50 = metricsAsked.filter((m) => m === "Duration").length;
  resetWatchStateForTest();
  await watchAppServers(policy, { api, metrics: rec(51), now: () => 9_500_000 });
  const durAt51 = metricsAsked.filter((m) => m === "Duration").length - durAt50;
  chk("D9e 호출 50번(경계)이면 실행 시간을 묻지 않고 · 51번이면 묻는다(지표 비용)", durAt50 === 0 && durAt51 === 1, JSON.stringify({ durAt50, durAt51 }));
  //  기준을 넘었는데 멈추지 못하면(여기선 함수가 남의 것으로 보임) — 관리자 · 책임자에게 «멈추지 못함» 을 알린다(조용히 넘어가지 않는다).
  resetWatchStateForTest();
  fns.get(FN).tags["lvly:tenant"] = "11111111-2222-3333-4444-555555555555";
  const fails9 = [];
  const w9 = await watchAppServers(policy, { api, metrics: mk(30_001, 1000), notify: async (a, title, body, kind) => { fails9.push(kind); }, now: () => 9_900_000 });
  fns.get(FN).tags["lvly:tenant"] = SINGLE_TENANT_ID;
  chk("D9f 기준을 넘었는데 멈추지 못하면 «멈추지 못함» 알림 · 멈춤 기록 없음", w9.stopped.length === 0 && fails9.includes("stop-failed") && fns.get(FN).conc === null && !(await serverRow()).stopped_at,
    JSON.stringify({ w9, fails9 }));
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

// ── 격리 리뷰 뒤(R) ──
const twin = (id, server = "require('http').createServer((q,s)=>s.end('twin')).listen(Number(process.env.PORT));") =>
  filesOf({ server }).map((f) => (f.path === "lively-app.json" ? { ...f, content: f.content.replace('"id":"srv"', `"id":"${id}"`) } : f));
const rowOf = async (id) => (await q(`SELECT * FROM org_app_server WHERE app_id=$1`, [id]))[0];
const waitFor = async (pred, ms = 5000) => { const until = Date.now() + ms; for (;;) { const v = await pred(); if (v || Date.now() > until) return v; await new Promise((r) => setTimeout(r, 50)); } };

// R1 같은 파일의 두 앱 — zip 은 앱마다 · 하나를 지워도 다른 앱 되돌리기가 된다 · zip 이 없어지면 다시 빌드한다
{
  await call("app_save", { files: twin("twin-a") }, alice, aliceCtx);
  const ta1 = await call("app_server_deploy", { app_id: "twin-a", wait_s: 120 }, alice, aliceCtx);
  const v1a = (await q(`SELECT current_version_no FROM org_app WHERE id='twin-a'`))[0].current_version_no;
  await call("app_save", { files: twin("twin-b") }, alice, aliceCtx);
  const tb1 = await call("app_server_deploy", { app_id: "twin-b", wait_s: 120 }, alice, aliceCtx);
  const kA = (await q(`SELECT zip_key, build_key FROM org_app_server_build WHERE app_id='twin-a' AND status='ok'`))[0];
  const kB = (await q(`SELECT zip_key, build_key FROM org_app_server_build WHERE app_id='twin-b' AND status='ok'`))[0];
  chk("R1a 같은 파일의 두 앱 — 빌드 지문은 같아도 zip 은 앱마다 따로", ta1.status === "deployed" && tb1.status === "deployed" && kA.build_key === kB.build_key
    && kA.zip_key !== kB.zip_key && zips.has(kA.zip_key) && zips.has(kB.zip_key), JSON.stringify({ kA, kB }));
  await call("app_save", { files: twin("twin-a", "require('http').createServer((q,s)=>s.end('a2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "twin-a", wait_s: 120 }, alice, aliceCtx);
  const v2a = (await q(`SELECT current_version_no FROM org_app WHERE id='twin-a'`))[0].current_version_no;
  const kA2 = (await rowOf("twin-a")).cur_build_key;
  await call("org_app_remove", { app_id: "twin-b" }, boss);
  chk("R1b 하나를 지우면 그 앱의 zip 만 — 다른 앱의 zip 은 그대로", !zips.has(kB.zip_key) && zips.has(kA.zip_key));
  const n0 = calls("updateFunctionCode").length;
  const rv = await call("app_revert", { app_id: "twin-a", version_no: v1a }, alice, aliceCtx);
  const ra = await waitFor(async () => { const r = await rowOf("twin-a"); return r.cur_build_key === kA.build_key ? r : null; });
  chk("R1c 남은 앱의 되돌리기 — 그 앱의 옛 zip 으로 cur 가 따라간다(NoSuchKey 없음)", rv.server?.state === "following" && !!ra && calls("updateFunctionCode").length === n0 + 1 && !ra.last_error,
    JSON.stringify(ra ?? await rowOf("twin-a")));
  //  zip 이 저장소에서 사라지면(사고 흉내) — 되돌리기는 서버를 그대로 두고 그 빌드를 못 쓰게 적는다 → 다음 배포가 다시 빌드한다(스스로 낫는다)
  await call("app_revert", { app_id: "twin-a", version_no: v2a }, alice, aliceCtx);
  await waitFor(async () => (await rowOf("twin-a")).cur_build_key === kA2);
  zips.delete(kA.zip_key);
  const uc1 = calls("updateFunctionCode").length;
  await call("app_revert", { app_id: "twin-a", version_no: v1a }, alice, aliceCtx);
  const bad = await waitFor(async () => { const b = (await q(`SELECT status, stage, error FROM org_app_server_build WHERE app_id='twin-a' AND build_key=$1`, [kA.build_key]))[0]; return b?.status === "failed" ? b : null; });
  const ucMiss = calls("updateFunctionCode").length - uc1;
  const seats0 = seats.length;
  const heal = await call("app_server_deploy", { app_id: "twin-a", wait_s: 120 }, alice, aliceCtx);
  const rh0 = await rowOf("twin-a");
  chk("R1d zip 이 없어지면 함수를 고치기 전에(zip 확인) 그 빌드를 실패로 적고 · 다음 배포가 다시 빌드해 올린다", bad?.stage === "zip" && /저장소에 없습니다/.test(String(bad?.error)) && ucMiss === 0
    && heal.status === "deployed" && heal.build.reused === false && seats.length === seats0 + 1 && zips.has(kA.zip_key) && rh0.cur_build_key === kA.build_key,
    JSON.stringify({ bad, ucMiss, heal: { status: heal.status, build: heal.build }, cur: rh0.cur_build_key }));
  //  R1e 두 번째 벽 — zip 확인을 지나도(저장소가 잠깐 잘못 답함) Lambda 가 NoSuchKey 면 그 빌드를 실패로 적는다
  await call("app_revert", { app_id: "twin-a", version_no: v2a }, alice, aliceCtx);
  await waitFor(async () => (await rowOf("twin-a")).cur_build_key === kA2);
  const realHead = async (key) => (zips.has(key) ? { size: zips.get(key).length } : null);
  const baseDeps = { api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession,
    presignPut: async (key) => `http://127.0.0.1:${zport}/${encodeURIComponent(key)}`, deleteZip: async (key) => { deletedZips.push(key); zips.delete(key); } };
  const sizeA = zips.get(kA.zip_key).length;
  setServerDepsForTest({ ...baseDeps, headZip: async (key) => (key === kA.zip_key ? { size: sizeA } : realHead(key)) });
  zips.delete(kA.zip_key);
  await call("app_revert", { app_id: "twin-a", version_no: v1a }, alice, aliceCtx);
  const bad2 = await waitFor(async () => { const b = (await q(`SELECT status, error FROM org_app_server_build WHERE app_id='twin-a' AND build_key=$1`, [kA.build_key]))[0]; return b?.status === "failed" ? b : null; });
  chk("R1e zip 확인을 지나도 Lambda 가 NoSuchKey 면 그 빌드를 실패로 적는다(두 번째 벽)", /올리지 못했습니다/.test(String(bad2?.error)) && (await rowOf("twin-a")).cur_build_key === kA2, JSON.stringify(bad2));
  setServerDepsForTest({ ...baseDeps, headZip: realHead });
  const heal2 = await call("app_server_deploy", { app_id: "twin-a", wait_s: 120 }, alice, aliceCtx);
  const rh = await rowOf("twin-a");
  chk("R1f 그 뒤 배포가 다시 빌드해 올린다", heal2.status === "deployed" && heal2.build.reused === false && rh.cur_build_key === kA.build_key, JSON.stringify({ status: heal2.status, build: heal2.build }));

  // R3 남의 워크스페이스 함수(태그)는 멈추지도 지우지도 않는다
  const fnA = rh.function_name;
  fns.get(fnA).tags["lvly:tenant"] = "11111111-2222-3333-4444-555555555555";
  const pc0 = calls("putConcurrency").length;
  const es = await errOf(call("app_server_stop", { app_id: "twin-a" }, alice, aliceCtx));
  chk("R3a 남의 워크스페이스 함수는 멈추지 않는다 → 409", es?.status === 409 && calls("putConcurrency").length === pc0 && fns.get(fnA).conc === null && !(await rowOf("twin-a")).stopped_at, String(es?.message));
  const del0 = calls("deleteFunction").filter((x) => x[1] === fnA && x[2] == null).length;
  await call("org_app_remove", { app_id: "twin-a" }, boss);
  chk("R3b 앱을 지워도 남의 함수는 지우지 않고 · 우리 줄만 지운다", fns.has(fnA) && calls("deleteFunction").filter((x) => x[1] === fnA && x[2] == null).length === del0
    && !(await rowOf("twin-a")), JSON.stringify(calls("deleteFunction").slice(-3)));
  fns.delete(fnA);
}

// R4 함수를 못 지우면 줄을 남기고 하우스키핑이 다시 지운다
{
  await call("app_save", { files: twin("orph") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "orph", wait_s: 120 }, alice, aliceCtx);
  const fnO = (await rowOf("orph")).function_name;
  failDelete.add(fnO);
  await call("org_app_remove", { app_id: "orph" }, boss);
  const kept = await rowOf("orph");
  chk("R4a 함수를 못 지우면 함수 줄을 남긴다(빌드 기록은 지움)", fns.has(fnO) && !!kept && (await q(`SELECT 1 FROM org_app_server_build WHERE app_id='orph'`)).length === 0, JSON.stringify(kept));
  failDelete.delete(fnO);
  const hk = await runAppServerHousekeeping({ api, metrics: async () => [], notify: async () => {} });
  chk("R4b 하우스키핑이 앱 없는 함수 줄을 다시 지운다(함수 · 로그 그룹 · 줄)", !fns.has(fnO) && !(await rowOf("orph")) && hk.orphans === 1
    && calls("deleteLogGroup").some((x) => x[1] === `/aws/lambda/${fnO}`), JSON.stringify(hk));
}

// R5 상한을 바꾸면 같은 코드도 새 설정의 함수 판으로(«다음 배포부터»)
{
  const r0 = await serverRow();
  await call("app_server_limits_set", { memory_mb: 1024 }, boss);
  const seats0 = seats.length;
  const uc0 = calls("updateFunctionConfiguration").length;
  const d = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  const r1 = await serverRow();
  const uc = calls("updateFunctionConfiguration").slice(uc0);
  chk("R5 상한을 바꾸면 빌드 없이 설정을 고쳐 새 함수 판 · 시험 호출 · cur", d.status === "deployed" && d.build.reused === true && seats.length === seats0
    && uc.some((x) => x[2].MemorySize === 1024) && r1.cur_lambda_version !== r0.cur_lambda_version && fns.get(FN).versions.find((v) => v.Version === r1.cur_lambda_version)?.cfg.MemorySize === 1024,
    JSON.stringify({ status: d.status, uc: uc.map((x) => x[2]), before: r0.cur_lambda_version, after: r1.cur_lambda_version }));
  await call("app_server_limits_set", { reset: true }, boss);
}

// R6 화면 단추 길 — 세션 없이 부르면 그 앱의 만들기 세션(그 판을 저장한 사람의 것일 때만)
{
  await call("app_save", { files: twin("scr") }, alice, aliceCtx);
  await q(`UPDATE org_app SET build_session='box-pgt-bob-1' WHERE id='scr'`);
  const seats0 = seats.length;
  const e1 = await errOf(call("app_server_deploy", { app_id: "scr", wait_s: 60 }, alice, { source: "web" }));
  chk("R6a 만들기 세션이 남(밥)의 것이면 거기서 빌드하지 않는다 → 409", e1?.status === 409 && seats.length === seats0, String(e1?.message));
  //  밥이 이 앱을 볼 수 있어야 «남이 저장한 판» 길을 탄다(나만 보는 앱이면 404) — 공개는 빌드가 있어야 해서 표시만 바꾼다.
  await q(`UPDATE org_app SET build_session='box-pgt-alice-1', visibility='all' WHERE id='scr'`);
  const e2 = await errOf(call("app_server_deploy", { app_id: "scr", wait_s: 60 }, bob, { source: "web" }));
  chk("R6b 앨리스가 저장한 판을 밥이 눌러도 앨리스의 세션에서 돌리지 않는다 → 409", e2?.status === 409 && seats.length === seats0, String(e2?.message));
  const ok = await call("app_server_deploy", { app_id: "scr", wait_s: 120 }, alice, { source: "web" });
  chk("R6c 저장한 사람이 화면에서 누르면 그 사람의 만들기 세션에서 빌드", ok.status === "deployed" && seats.length === seats0 + 1 && seats[seats.length - 1].sessionId === "box-pgt-alice-1",
    JSON.stringify({ status: ok.status, seat: seats[seats.length - 1] }));
  await call("org_app_remove", { app_id: "scr" }, boss);
}

// R7 쓸 빌드가 무효가 되면(zip 유실) 상태도 «올라가 있음» 이 아니다 — 화면이 다시 빌드하게
{
  await call("app_save", { files: twin("lost") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lost", wait_s: 120 }, alice, aliceCtx);
  const kL = (await q(`SELECT zip_key, build_key FROM org_app_server_build WHERE app_id='lost' AND status='ok'`))[0];
  const st0 = await call("app_server_status", { app_id: "lost" }, alice, aliceCtx);
  zips.delete(kL.zip_key);
  const ep = await errOf(call("app_visibility_set", { app_id: "lost", visibility: "all" }, alice, aliceCtx));
  const st1 = await call("app_server_status", { app_id: "lost" }, alice, aliceCtx);
  chk("R7 zip 이 사라진 빌드는 공개 409 · 상태도 «올라가 있지 않음»(화면이 다시 빌드를 건다)", st0.installed?.deployed_to_cur === true && ep?.status === 409
    && st1.installed?.deployed_to_cur === false && st1.installed?.build?.status === "failed", JSON.stringify({ ep: ep?.status, st1: st1.installed }));
  const heal = await call("app_server_deploy", { app_id: "lost", wait_s: 120 }, alice, aliceCtx);
  const st2 = await call("app_server_status", { app_id: "lost" }, alice, aliceCtx);
  chk("R7b 다시 빌드하면 «올라가 있음»", heal.status === "deployed" && st2.installed?.deployed_to_cur === true, JSON.stringify(st2.installed));

  // R1g S3 권한 오류는 zip 탓이 아니다 — 빌드를 무효로 적지 않는다(누를 때마다 처음부터 빌드하지 않게)
  const vL1 = (await q(`SELECT current_version_no FROM org_app WHERE id='lost'`))[0].current_version_no;
  await call("app_save", { files: twin("lost", "require('http').createServer((q,s)=>s.end('l2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lost", wait_s: 120 }, alice, aliceCtx);
  s3Denied = true;
  await call("app_revert", { app_id: "lost", version_no: vL1 }, alice, aliceCtx);
  const errSet = await waitFor(async () => { const r = await rowOf("lost"); return r.last_error ? r : null; });
  const b1 = (await q(`SELECT status FROM org_app_server_build WHERE app_id='lost' AND build_key=$1`, [kL.build_key]))[0];
  chk("R1g S3 권한 오류(AccessDenied)면 빌드는 그대로 ok · 오류만 남긴다", !!errSet && b1?.status === "ok" && !s3Denied, JSON.stringify({ b1, last_error: errSet?.last_error }));
  await call("org_app_remove", { app_id: "lost" }, boss);
}

// R8 이미 만들어진 표에도 stop_kind 칸이 붙는다(표를 만든 뒤에 더한 칸)
{
  await q(`ALTER TABLE org_app_server DROP COLUMN stop_kind`);
  await initAllSchemas({ quiet: true });
  const col = await q(`SELECT 1 FROM information_schema.columns WHERE table_name='org_app_server' AND column_name='stop_kind'`);
  chk("R8 옛 표에 스키마를 다시 돌리면 stop_kind 칸이 생긴다", col.length === 1);
}

// R9 빌드하는 동안 앱이 지워지면 — 나중에 올라온 zip 을 지운다(주인 없는 zip 을 남기지 않는다)
{
  await call("app_save", { files: twin("gone") }, alice, aliceCtx);
  const realHead = async (key) => (zips.has(key) ? { size: zips.get(key).length } : null);
  const baseDeps = { api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, headZip: realHead,
    presignPut: async (key) => `http://127.0.0.1:${zport}/${encodeURIComponent(key)}`, deleteZip: async (key) => { deletedZips.push(key); zips.delete(key); } };
  setServerDepsForTest({ ...baseDeps, spawnInSession: async (seat, argv) => {
    const c = await spawnInSession(seat, argv);
    setTimeout(() => { void q(`DELETE FROM org_app_server_build WHERE app_id='gone'`); }, 150);   // 앱 지우기가 빌드 기록을 걷는 것 흉내
    return c;
  } });
  const d9 = await call("app_server_deploy", { app_id: "gone", wait_s: 120 }, alice, aliceCtx);
  setServerDepsForTest({ ...baseDeps, spawnInSession });
  const leftZips = [...zips.keys()].filter((k) => k.includes("/z/gone/"));
  chk("R9 빌드 도중 기록이 지워지면 방금 올린 zip 을 지운다 · 함수에 올리지 않는다", d9.status === "failed" && leftZips.length === 0 && deletedZips.some((k) => k.includes("/z/gone/"))
    && !calls("createFunction").some((x) => x[1].FunctionName.includes("gone")), JSON.stringify({ status: d9.status, stage: d9.stage, error: d9.error, leftZips }));
  await call("org_app_remove", { app_id: "gone" }, boss);
}

// ── #4792 워크스페이스 상한(W) ──
const MiB = 1024 * 1024;
const codeOf = (name) => { const f = fns.get(name); return f ? (f.cfg.CodeSize ?? 0) + f.versions.reduce((n, v) => n + (v.cfg.CodeSize ?? 0), 0) : 0; };
const fnRows = async () => Number((await q(`SELECT count(*)::int AS n FROM org_app_server`))[0].n);
const codeBytes = async () => Number((await serverRow()).code_bytes);   // 날 SQL 은 BIGINT 를 글자로 준다
const srvCode = (tag) => filesOf({ server: `require('http').createServer((q,s)=>s.end('${tag}')).listen(Number(process.env.PORT));` });

// W1 배포가 끝나면 그 함수의 코드 크기 = AWS 가 알려 준 $LATEST + 남은 판 CodeSize 합(옛 판 정리 뒤) · 상태에 code_mb
{
  await call("app_save", { files: srvCode("w1") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  const cb = await codeBytes();
  const f = fns.get(FN);
  const st = await call("app_server_status", { app_id: "srv" }, alice, aliceCtx);
  chk("W1 배포 뒤 code_bytes = $LATEST + 남은 판 CodeSize 합 · 옛 판은 정리됐다 · 상태 code_mb", d.status === "deployed" && cb > 0 && cb === codeOf(FN)
    && f.versions.length <= 3 + 2 && st.function?.code_mb === Math.round((cb / MiB) * 10) / 10,
    JSON.stringify({ status: d.status, code_bytes: cb, want: codeOf(FN), versions: f.versions.length, code_mb: st.function?.code_mb }));
}

// W2 함수 수 상한 — 함수가 없는 앱은 빌드 전에 409 · 함수 있는 앱은 그대로 · 상한을 올리면 된다
{
  const n0 = await fnRows();
  await call("app_server_limits_set", { workspace_functions_max: n0 }, boss);
  await call("app_save", { files: twin("cap-new") }, alice, aliceCtx);
  const seats0 = seats.length, cf0 = calls("createFunction").length;
  const e = await errOf(call("app_server_deploy", { app_id: "cap-new", wait_s: 120 }, alice, aliceCtx));
  chk("W2a 함수 수 = 상한 · 새 앱 → 409(수 · 상한 · 고치는 길) · 빌드 0 · 함수 만들기 0 · 함수 줄 없음",
    e?.status === 409 && /상한/.test(String(e?.message)) && /workspace_functions_max/.test(String(e?.message)) && seats.length === seats0
    && calls("createFunction").length === cf0 && !(await rowOf("cap-new")), String(e?.message));
  await call("app_save", { files: srvCode("w2") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  chk("W2b 함수가 있는 앱은 상한에 닿아도 새 코드를 올린다", d.status === "deployed" && d.build.reused === false, JSON.stringify({ status: d.status, error: d.error }));
  await call("app_server_limits_set", { workspace_functions_max: n0 + 1 }, boss);
  const ok = await call("app_server_deploy", { app_id: "cap-new", wait_s: 120 }, alice, aliceCtx);
  chk("W2c 상한을 올리면 새 앱이 배포된다", ok.status === "deployed" && !!(await rowOf("cap-new")) && fns.has("lvly-app-cap-new-local"), JSON.stringify({ status: ok.status, error: ok.error }));
  await call("org_app_remove", { app_id: "cap-new" }, boss);
  await call("app_server_limits_set", { reset: true }, boss);
}

// W3 함수 수 = 상한−1 에 다섯 앱이 같은 때 줄을 잡아도 하나만 생긴다(세기와 만들기를 워크스페이스 자문 락으로 묶음)
{
  //  락이 없으면 한 판은 약 17% 확률로 초록이라(격리 리뷰 실측) 열 판을 돈다 — 한 판이라도 둘 넘게 생기면 빨강.
  const n0 = await fnRows();
  const ids = ["race-a", "race-b", "race-c", "race-d", "race-e"];
  const rounds = [];
  for (let k = 0; k < 10; k++) {
    const got = await Promise.all(ids.map((id) => claimServerRow(id, `lvly-app-${id}-local`, n0 + 1)));
    const made = (await q(`SELECT app_id FROM org_app_server WHERE app_id = ANY($1)`, [ids])).length;
    rounds.push({ made, ok: got.filter((g) => g.row).length === 1 && got.filter((g) => !g.row).every((g) => g.count === n0 + 1) });
    await q(`DELETE FROM org_app_server WHERE app_id = ANY($1)`, [ids]);
  }
  chk("W3 동시 첫 배포 다섯(열 판) → 함수 줄은 판마다 하나만 · 나머지는 줄 없이 지금 수(= 상한)를 받는다", rounds.every((r) => r.made === 1 && r.ok), JSON.stringify(rounds));
}

// W4 코드 저장 상한 — 다른 함수 합 + 이 함수 배포 뒤 > 상한이면 코드를 안 올린다 · 같은 빌드를 다시 쓰는 배포는 판정 없이 된다
{
  await call("app_server_limits_set", { workspace_code_mb: 100 }, boss);
  await q(`INSERT INTO org_app_server(app_id, function_name, code_bytes) VALUES ('ghost-big', 'lvly-app-ghost-big-local', $1)`, [100 * MiB]);
  const r0 = await serverRow();
  const uc0 = calls("updateFunctionCode").length, pv0 = calls("publishVersion").length;
  //  옛 판이 쌓인 함수를 비슷한 크기로 고치면 배포 뒤 크기가 그대로라 상한을 넘어도 된다(C4) — 늘어나는 배포를 만들려고 압축이 안 되는 150KB 를 싣는다.
  const bulk = crypto.randomBytes(150_000).toString("base64");
  await call("app_save", { files: filesOf({ server: `// ${bulk}\nrequire('http').createServer((q,s)=>s.end('w4')).listen(Number(process.env.PORT));` }) }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  const r1 = await serverRow();
  chk("W4a 코드 저장이 상한을 넘으면 409(까닭) · 코드 안 올림 · 판 고정 없음 · 별칭 그대로 · last_error", d.status === "failed" && /코드 저장/.test(String(d.error))
    && /workspace_code_mb/.test(String(d.error)) && calls("updateFunctionCode").length === uc0 && calls("publishVersion").length === pv0
    && r1.cur_lambda_version === r0.cur_lambda_version && fns.get(FN).aliases.get("cur") === r0.cur_lambda_version && /코드 저장/.test(String(r1.last_error)),
    JSON.stringify({ status: d.status, error: d.error, last_error: r1.last_error }));
  //  cur 가 이미 가리키는 빌드(지금 판과 같은 코드)를 다시 넣으면 새 코드가 없다 — 상한을 넘은 채로도 된다.
  await call("app_save", { files: srvCode("w2") }, alice, aliceCtx);
  const uc1 = calls("updateFunctionCode").length, pv1 = calls("publishVersion").length;
  const d2 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  chk("W4b 같은 빌드 재사용은 판정 없이 된다 · 코드 올리기 · 판 고정 0", d2.status === "deployed" && d2.build.reused === true
    && calls("updateFunctionCode").length === uc1 && calls("publishVersion").length === pv1, JSON.stringify({ status: d2.status, error: d2.error }));
}

// W5 함수가 없는 앱이 코드 저장 상한에 걸리면 — 함수를 만들지 않고 빈 함수 줄도 남기지 않는다(함수 수 한 칸을 차지하지 않게)
{
  await call("app_save", { files: twin("code-new") }, alice, aliceCtx);
  const cf0 = calls("createFunction").length;
  const d = await call("app_server_deploy", { app_id: "code-new", wait_s: 120 }, alice, aliceCtx);
  chk("W5 새 앱이 코드 상한에 걸림 → 실패(까닭) · 함수 만들기 0 · 함수 줄 없음 · 빌드는 남는다", d.status === "failed" && /코드 저장/.test(String(d.error))
    && calls("createFunction").length === cf0 && !(await rowOf("code-new")) && d.build?.status === "ok",
    JSON.stringify({ status: d.status, error: d.error, build: d.build?.status }));
}

// W8 공개 길도 같은 판정 — 빌드는 있고 함수는 없는 앱을 공개하면: 코드 상한이면 서버를 옮기지 못하고 줄도 안 남는다 · 함수 수 상한이면 줄을 안 만든다
{
  const cf0 = calls("createFunction").length;
  const pub = await call("app_visibility_set", { app_id: "code-new", visibility: "all" }, alice, aliceCtx);
  chk("W8a 공개는 되고 서버 옮기기는 코드 상한으로 실패 · 함수 만들기 0 · 줄 없음", pub.changed === true && pub.server?.ok === false && /코드 저장/.test(String(pub.server?.message))
    && calls("createFunction").length === cf0 && !(await rowOf("code-new")), JSON.stringify(pub.server));
  await q(`DELETE FROM org_app_server WHERE app_id='ghost-big'`);
  await call("app_server_limits_set", { reset: true }, boss);
  await call("app_server_limits_set", { workspace_functions_max: await fnRows() }, boss);
  await call("app_visibility_set", { app_id: "code-new", visibility: "me" }, alice, aliceCtx);
  const pub2 = await call("app_visibility_set", { app_id: "code-new", visibility: "all" }, alice, aliceCtx);
  chk("W8b 함수 수 상한이면 공개 뒤 서버 옮기기가 실패(까닭) · 함수 만들기 0 · 줄 없음", pub2.changed === true && pub2.server?.ok === false
    && /workspace_functions_max/.test(String(pub2.server?.message)) && calls("createFunction").length === cf0 && !(await rowOf("code-new")), JSON.stringify(pub2.server));
  await call("app_server_limits_set", { reset: true }, boss);
  await call("org_app_remove", { app_id: "code-new" }, boss);
}

// W6 보기 — 사용량 · 새 두 키 / 고치기 — 범위 밖은 400 · 범위 안은 반영
{
  const lim = await call("app_server_limits", {}, alice, aliceCtx);
  const n = await fnRows();
  chk("W6a app_server_limits — usage(functions · code_mb) · policy · min · ceiling 에 새 두 키", lim.usage?.functions === n && typeof lim.usage?.code_mb === "number"
    && lim.policy?.workspace_functions_max === 20 && lim.policy?.workspace_code_mb === 5120 && lim.min?.workspace_code_mb === 100
    && lim.ceiling?.workspace_functions_max === 200 && lim.ceiling?.workspace_code_mb === 20480, JSON.stringify({ usage: lim.usage, policy: lim.policy }));
  const bad = await Promise.all([{ workspace_functions_max: 0 }, { workspace_functions_max: 201 }, { workspace_code_mb: 99 }, { workspace_code_mb: 20481 }]
    .map((x) => errOf(call("app_server_limits_set", x, boss))));
  const good = await call("app_server_limits_set", { workspace_functions_max: 7, workspace_code_mb: 2048 }, boss);
  chk("W6b 범위 밖(0 · 201 · 99MB · 20481MB) 400 · 범위 안은 반영", bad.every((e) => e?.status === 400) && good.policy?.workspace_functions_max === 7 && good.policy?.workspace_code_mb === 2048,
    JSON.stringify({ bad: bad.map((e) => e?.status), policy: good.policy }));
  await call("app_server_limits_set", { reset: true }, boss);
}

// W7 코드를 올린 뒤 실패해도(시험 호출 실패) 그 함수의 코드 크기를 다시 잰다 — 낡은 값으로 상한을 세지 않게
{
  const b0 = await codeBytes();
  invokeMode = "notready";
  await call("app_save", { files: srvCode("w7-a-longer-body-so-the-zip-size-changes") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  invokeMode = "ok";
  const b1 = await codeBytes();
  chk("W7 시험 호출 실패(코드는 올라감) → code_bytes 를 다시 잰 값 = 가짜 Lambda 합 · 이전 값과 다르다", d.status === "failed" && d.stage === "smoke" && b1 === codeOf(FN) && b1 !== b0,
    JSON.stringify({ status: d.status, stage: d.stage, b0, b1, want: codeOf(FN) }));
}

const fnOf = (id) => `lvly-app-${id}-local`;
const verOf = async (id) => (await q(`SELECT current_version_no FROM org_app WHERE id=$1`, [id]))[0].current_version_no;
const baseDepsW = () => ({ api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession,
  presignPut: async (key) => `http://127.0.0.1:${zport}/${encodeURIComponent(key)}`, headZip: async (key) => (zips.has(key) ? { size: zips.get(key).length } : null),
  deleteZip: async (key) => { deletedZips.push(key); zips.delete(key); } });

// W9 코드 저장 상한 — 서로 다른 두 앱이 같은 때 올려도 합이 상한을 넘지 않는다(판정과 자리 잡기를 워크스페이스 락 안에서 · 격리 리뷰 재현)
{
  await call("app_save", { files: twin("cc-probe") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "cc-probe", wait_s: 120 }, alice, aliceCtx);
  const z = Number((await q(`SELECT zip_bytes FROM org_app_server_build WHERE app_id='cc-probe' AND status='ok'`))[0].zip_bytes);
  await call("org_app_remove", { app_id: "cc-probe" }, boss);
  await call("app_server_limits_set", { workspace_code_mb: 100 }, boss);
  const others0 = Number((await q(`SELECT coalesce(sum(code_bytes), 0)::float8 AS n FROM org_app_server`))[0].n);
  //  새 함수 하나는 배포 뒤 2z — 남는 칸을 3z 로 두면 하나는 들고 둘은 못 든다.
  await q(`INSERT INTO org_app_server(app_id, function_name, code_bytes) VALUES ('ghost-cc', 'lvly-app-ghost-cc-local', $1)`, [100 * MiB - others0 - 3 * z]);
  await call("app_save", { files: twin("cc-a") }, alice, aliceCtx);
  await call("app_save", { files: twin("cc-b") }, alice, aliceCtx);
  publishDelayMs = 600;
  const res = await Promise.all(["cc-a", "cc-b"].map((id) => call("app_server_deploy", { app_id: id, wait_s: 120 }, alice, aliceCtx)));
  publishDelayMs = 0;
  const sum = Number((await q(`SELECT coalesce(sum(code_bytes), 0)::float8 AS n FROM org_app_server`))[0].n);
  chk("W9 동시 배포 둘 — 하나만 올라가고 하나는 코드 상한으로 막힌다 · 합은 상한 이하", res.filter((r) => r.status === "deployed").length === 1
    && res.filter((r) => r.status === "failed" && /코드 저장/.test(String(r.error))).length === 1 && sum <= 100 * MiB,
    JSON.stringify({ z, res: res.map((r) => ({ status: r.status, error: r.error })), sum, cap: 100 * MiB }));
  await q(`DELETE FROM org_app_server WHERE app_id='ghost-cc'`);
  for (const id of ["cc-a", "cc-b"]) await call("org_app_remove", { app_id: id }, boss);
  await call("app_server_limits_set", { reset: true }, boss);
}

// W10 별칭이 있는데 코드 크기를 모르는 줄(0) — 하우스키핑이 AWS 에서 다시 잰다(칸을 더하기 전에 올린 함수 · 재기에 실패한 배포)
{
  await q(`UPDATE org_app_server SET code_bytes = 0 WHERE app_id='srv'`);
  const n = await refreshUnknownCodeBytes({ api });
  chk("W10 크기를 모르는 줄을 하우스키핑이 잰다 = $LATEST + 남은 판 합", n >= 1 && (await codeBytes()) === codeOf(FN) && codeOf(FN) > 0, JSON.stringify({ n, cb: await codeBytes(), want: codeOf(FN) }));
}

// W11 함수를 만든 직후 실패해도(준비 기다리기 실패) 그 함수의 코드 크기를 잰다 — 자리 잡기 값(배포 뒤 셈)이 아니라 실측으로
{
  readyFail.add(fnOf("own-a"));
  await call("app_save", { files: twin("own-a") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "own-a", wait_s: 120 }, alice, aliceCtx);
  readyFail.delete(fnOf("own-a"));
  const r = await rowOf("own-a");
  chk("W11 만든 직후 실패 → 줄은 남고(함수가 있다) code_bytes = 실측($LATEST 하나)", d.status === "failed" && !!r && fns.has(fnOf("own-a"))
    && Number(r.code_bytes) === codeOf(fnOf("own-a")) && codeOf(fnOf("own-a")) > 0, JSON.stringify({ status: d.status, cb: r && r.code_bytes, want: codeOf(fnOf("own-a")) }));
  await call("org_app_remove", { app_id: "own-a" }, boss);
}

// W12 zip 크기를 모르는 성공 빌드(옛 줄) — 다시 쓸 때 저장소에서 본 크기로 채운다(코드 저장 셈이 0 으로 새지 않게)
{
  //  배포가 쓰는 빌드는 «지금 판» 의 빌드다 — 지금 판을 먼저 올려 cur 와 같게 둔 뒤 그 빌드의 크기를 지운다.
  await call("app_save", { files: srvCode("w12") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  const cur = (await serverRow()).cur_build_key;
  await q(`UPDATE org_app_server_build SET zip_bytes = NULL WHERE app_id='srv' AND build_key=$1`, [cur]);
  const zk = (await q(`SELECT zip_key FROM org_app_server_build WHERE app_id='srv' AND build_key=$1`, [cur]))[0].zip_key;
  await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  const b = (await q(`SELECT zip_bytes FROM org_app_server_build WHERE app_id='srv' AND build_key=$1`, [cur]))[0];
  chk("W12 zip 크기 없는 빌드를 다시 쓰면 저장소 크기로 채운다", Number(b.zip_bytes) === zips.get(zk)?.length && Number(b.zip_bytes) > 0, JSON.stringify({ b, want: zips.get(zk)?.length }));
}

// W13 첫 배포가 함수를 하나도 못 만들고 끝나면(계정 한도 등) 빈 함수 줄을 걷는다 — 함수 수 한 칸을 계속 잡지 않게
{
  createFail = new AwsError(400, "CodeStorageExceededException", "Code storage limit exceeded");
  await call("app_save", { files: twin("cf-a") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "cf-a", wait_s: 120 }, alice, aliceCtx);
  chk("W13 함수 만들기 실패 → 실패 · 함수 없음 · 빈 줄 없음", d.status === "failed" && !fns.has(fnOf("cf-a")) && !(await rowOf("cf-a")) && createFail === null,
    JSON.stringify({ status: d.status, error: d.error }));
  await call("org_app_remove", { app_id: "cf-a" }, boss);
}

// W14 되돌리기가 함수 수 상한에 막히면 응답에 실패로 알린다(뒤에서 조용히 멈추지 않게 — 줄이 없어 last_error 를 적을 곳이 없다)
{
  await call("app_save", { files: twin("rv-cap") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "rv-cap", wait_s: 120 }, alice, aliceCtx);
  const v1 = await verOf("rv-cap");
  await call("app_save", { files: twin("rv-cap", "require('http').createServer((q,s)=>s.end('rv2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  fns.delete(fnOf("rv-cap"));
  await q(`DELETE FROM org_app_server WHERE app_id='rv-cap'`);   // 걷힌 함수 흉내
  await call("app_server_limits_set", { workspace_functions_max: await fnRows() }, boss);
  const cf0 = calls("createFunction").length;
  const rv = await call("app_revert", { app_id: "rv-cap", version_no: v1 }, alice, aliceCtx);
  await new Promise((r) => setTimeout(r, 300));
  chk("W14 되돌리기 응답 server 가 실패(함수 수 상한 · 고치는 길) · 함수 만들기 0 · 줄 없음", rv.server?.state === "failed" && /workspace_functions_max/.test(String(rv.server?.message))
    && calls("createFunction").length === cf0 && !(await rowOf("rv-cap")), JSON.stringify(rv.server));
  await call("app_server_limits_set", { reset: true }, boss);
  await call("org_app_remove", { app_id: "rv-cap" }, boss);
}

// W15 잠금을 기다리는 사이 줄이 사라지면(하우스키핑이 걷음) 잠금 다툼으로 409 를 내지 않고 줄을 다시 잡아 이어 간다
{
  await call("app_save", { files: twin("lk-a") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lk-a", wait_s: 120 }, alice, aliceCtx);
  await q(`UPDATE org_app_server SET lock_until = now() + interval '10 minutes' WHERE app_id='lk-a'`);
  let gone = false;
  setServerDepsForTest({ ...baseDepsW(), sleep: async () => { if (!gone) { gone = true; fns.delete(fnOf("lk-a")); await q(`DELETE FROM org_app_server WHERE app_id='lk-a'`); } } });
  await call("app_save", { files: twin("lk-a", "require('http').createServer((q,s)=>s.end('lk2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "lk-a", wait_s: 120 }, alice, aliceCtx);
  setServerDepsForTest(baseDepsW());
  chk("W15 기다리는 사이 줄이 사라지면 다시 잡아 배포한다(잠금 409 아님)", gone && d.status === "deployed" && !!(await rowOf("lk-a")) && fns.has(fnOf("lk-a")),
    JSON.stringify({ gone, status: d.status, error: d.error }));
  await call("org_app_remove", { app_id: "lk-a" }, boss);
}

// W16 잠금을 기다리는 사이 앱이 지워지면(앱 · 줄 · 함수가 사라짐) 줄을 되살리지 않는다 — 함수를 다시 만들지 않고 끝난다(재검토: 고아 쓸기가 걷을 함수를 만들었다)
{
  await call("app_save", { files: twin("lk-b") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lk-b", wait_s: 120 }, alice, aliceCtx);
  await q(`UPDATE org_app_server SET lock_until = now() + interval '10 minutes' WHERE app_id='lk-b'`);
  let gone = false;
  setServerDepsForTest({ ...baseDepsW(), sleep: async () => { if (!gone) { gone = true; fns.delete(fnOf("lk-b")); await q(`DELETE FROM org_app_server WHERE app_id='lk-b'`); await q(`DELETE FROM org_app WHERE id='lk-b'`); } } });
  await call("app_save", { files: twin("lk-b", "require('http').createServer((q,s)=>s.end('lk3')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  const cf0 = calls("createFunction").length;
  let d;
  try { d = await call("app_server_deploy", { app_id: "lk-b", wait_s: 120 }, alice, aliceCtx); } catch (e) { d = { status: "threw", error: String(e?.message) }; }
  setServerDepsForTest(baseDepsW());
  chk("W16 기다리는 사이 앱이 지워지면 줄을 되살리지 않는다 · 함수 만들기 0", gone && d.status !== "deployed" && !(await rowOf("lk-b")) && !fns.has(fnOf("lk-b"))
    && calls("createFunction").length === cf0, JSON.stringify({ gone, status: d.status, error: d.error }));
  for (const r of await q(`DELETE FROM org_app_server_build WHERE app_id='lk-b' RETURNING zip_key`)) if (r.zip_key) zips.delete(r.zip_key);
}

// W17 있는 함수의 배포가 코드 자리를 잡은 뒤 실패하면(로그 그룹 맞추기 실패) 잡아 둔 크기를 실측으로 덮는다(재검토: 과대 값이 남아 다른 앱을 막았다)
{
  await call("app_save", { files: twin("lg-a") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lg-a", wait_s: 120 }, alice, aliceCtx);
  await call("app_save", { files: twin("lg-a", "require('http').createServer((q,s)=>s.end('lg2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  logFail = new AwsError(503, "ServiceUnavailableException", "흉내 — 로그 그룹 실패");
  const d = await call("app_server_deploy", { app_id: "lg-a", wait_s: 120 }, alice, aliceCtx);
  const r = await rowOf("lg-a");
  chk("W17 자리 잡은 뒤 실패 → code_bytes = 실측(새 코드 몫이 남지 않음)", d.status === "failed" && logFail === null && !!r
    && Number(r.code_bytes) === codeOf(fnOf("lg-a")) && codeOf(fnOf("lg-a")) > 0, JSON.stringify({ status: d.status, error: d.error, cb: r && r.code_bytes, want: codeOf(fnOf("lg-a")) }));
  await call("org_app_remove", { app_id: "lg-a" }, boss);
}

// W18 첫 배포의 함수 만들기가 응답 없이 끝났는데 함수는 생겼으면 — 줄은 남고(함수가 있다) 잡아 둔 크기(배포 뒤 셈)를 실측으로 덮는다(재검토)
{
  createThenFail = new AwsError(503, "ServiceUnavailableException", "흉내 — 만들고 응답 없음");
  await call("app_save", { files: twin("cg-a") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "cg-a", wait_s: 120 }, alice, aliceCtx);
  const r = await rowOf("cg-a");
  chk("W18 만들기 응답 실패 · 함수는 생김 → 줄 남김 · code_bytes = 실측($LATEST 하나)", d.status === "failed" && createThenFail === null && fns.has(fnOf("cg-a")) && !!r
    && Number(r.code_bytes) === codeOf(fnOf("cg-a")) && codeOf(fnOf("cg-a")) > 0, JSON.stringify({ status: d.status, error: d.error, cb: r && r.code_bytes, want: codeOf(fnOf("cg-a")) }));
  await call("org_app_remove", { app_id: "cg-a" }, boss);
}

// W19 하우스키핑이 재는 사이 같은 앱의 배포가 값을 적었으면(자리 잡기 · 실측) 늦게 온 측정이 덮지 않는다(재검토)
{
  await q(`UPDATE org_app_server SET code_bytes = 0 WHERE app_id='srv'`);
  const racing = { ...api, listVersions: async (n) => { const v = await api.listVersions(n); if (n === FN) await q(`UPDATE org_app_server SET code_bytes = 4242 WHERE app_id='srv'`); return v; } };
  await refreshUnknownCodeBytes({ api: racing });
  const cb = await codeBytes();
  chk("W19 재는 사이 배포가 적은 값을 덮지 않는다", cb === 4242, JSON.stringify({ cb, stale: codeOf(FN) }));
  await q(`UPDATE org_app_server SET code_bytes = $1 WHERE app_id='srv'`, [codeOf(FN)]);
}

// W20 영영 못 재는 줄(함수가 AWS 에서 사라짐)이 고르는 순서의 앞자리에 있어도 다른 줄이 굶지 않는다 — 못 잰 줄은 뒤로 보낸다(재검토)
{
  await q(`INSERT INTO org_app_server(app_id, function_name, code_bytes, cur_lambda_version, updated_at) VALUES
    ('st-a', 'lvly-app-st-a-local', 0, '1', now() - interval '10 days'), ('st-b', 'lvly-app-st-b-local', 0, '1', now() - interval '9 days')`);
  const flaky = { ...api, listVersions: async (n) => {
    if (n === "lvly-app-st-a-local") throw new AwsError(404, "ResourceNotFoundException", "흉내 — 함수 없음");
    return n === "lvly-app-st-b-local" ? [{ Version: "$LATEST", CodeSize: 777 }] : api.listVersions(n);
  } };
  await refreshUnknownCodeBytes({ api: flaky }, 1);
  await refreshUnknownCodeBytes({ api: flaky }, 1);
  const b = Number((await q(`SELECT code_bytes FROM org_app_server WHERE app_id='st-b'`))[0].code_bytes);
  chk("W20 못 잰 줄은 뒤로 — 두 번째 틱엔 다음 줄을 잰다", b === 777, JSON.stringify({ b }));
  await q(`DELETE FROM org_app_server WHERE app_id IN ('st-a', 'st-b')`);
}

// W21 같은 이름의 남의 함수(다른 워크스페이스 태그)면 배포가 실패해도 그 함수의 크기를 우리 줄에 적지 않는다(재검토 M1 — 남의 코드가 우리 사용량에 얹힌다)
{
  fns.get(FN).tags["lvly:tenant"] = "11111111-2222-3333-4444-555555555555";
  await q(`UPDATE org_app_server SET code_bytes = 1234 WHERE app_id='srv'`);
  await call("app_save", { files: srvCode("w21") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  const cb = await codeBytes();
  fns.get(FN).tags["lvly:tenant"] = SINGLE_TENANT_ID;
  await q(`UPDATE org_app_server SET code_bytes = $1 WHERE app_id='srv'`, [codeOf(FN)]);
  chk("W21 남의 함수 → 실패 · 우리 줄의 code_bytes 그대로", d.status === "failed" && /다른 워크스페이스/.test(String(d.error)) && cb === 1234,
    JSON.stringify({ status: d.status, error: d.error, cb, foreign: codeOf(FN) }));
}

// W22 첫 배포의 함수 만들기가 실패하고 뒤이은 확인(함수 조회)도 실패하면 줄을 남긴다 — 함수가 있는지 모르는 채로 지우지 않는다(재검토 M1)
{
  createFail = new AwsError(400, "CodeStorageExceededException", "Code storage limit exceeded");
  let blind = false;
  const blindApi = { ...api,
    createFunction: async (i) => { try { return await api.createFunction(i); } catch (e) { blind = true; throw e; } },
    getFunction: async (n) => { if (blind) { blind = false; throw new AwsError(503, "ServiceUnavailableException", "흉내 — 조회 실패"); } return api.getFunction(n); } };
  setServerDepsForTest({ ...baseDepsW(), api: blindApi });
  await call("app_save", { files: twin("uk-a") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "uk-a", wait_s: 120 }, alice, aliceCtx);
  setServerDepsForTest(baseDepsW());
  chk("W22 만들기 실패 뒤 확인도 실패 → 실패 · 줄 남김(모르는 채로 지우지 않음)", d.status === "failed" && createFail === null && !blind && !fns.has(fnOf("uk-a"))
    && !!(await rowOf("uk-a")), JSON.stringify({ status: d.status, error: d.error, blind }));
  await call("org_app_remove", { app_id: "uk-a" }, boss);
}

// ── #4791 서버 선언을 뺀 앱의 함수 정리(X) ──
//  서버 선언(web)을 뺀 같은 앱 — 화면만 남은 판.
const noServer = (id) => twin(id).map((f) => {
  if (f.path !== "lively-app.json") return f;
  const m = JSON.parse(f.content); delete m.web; return { ...f, content: JSON.stringify(m) };
});
const retire = async (extra = {}) => retireUnusedServers(await appServerPolicy(), { api, ...extra });
const ageUnused = async (id, sql) => q(`UPDATE org_app_server SET unused_since = now() - interval '${sql}' WHERE app_id=$1`, [id]);

// X1 서버 판 → 서버 선언을 뺀 판 — 하우스키핑이 표시만 붙인다(바로 걷지 않는다) · 함수 그대로 · 상태에 retire_at(= 표시 + 7일)
{
  await call("app_save", { files: twin("ret-a") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "ret-a", wait_s: 120 }, alice, aliceCtx);
  const v1 = await verOf("ret-a");
  await call("app_save", { files: noServer("ret-a") }, alice, aliceCtx);
  const h = await retire();
  const r = await rowOf("ret-a");
  const st = await call("app_server_status", { app_id: "ret-a" }, alice, aliceCtx);
  const want = new Date(new Date(r.unused_since).getTime() + 7 * 86_400_000).toISOString();
  chk("X1 서버 선언을 뺀 판 → 표시만(unused_since) · 함수 그대로 · 상태 retire_at = 표시 + 7일", h.marked >= 1 && !!r.unused_since && fns.has(fnOf("ret-a"))
    && st.server_declared === false && st.function?.retire?.retire_at === want, JSON.stringify({ h, unused_since: r.unused_since, retire: st.function?.retire }));

  // X2 7일 − 1분이면 그대로 · 7일이면 함수 · 로그 그룹 · 함수 줄을 걷고 빌드 기록 · zip 은 남긴다
  await ageUnused("ret-a", "7 days - 1 minute");
  const h2 = await retire();
  const keptFn = fns.has(fnOf("ret-a"));
  await ageUnused("ret-a", "7 days");
  //  빌드한 지 30일이 지난 빌드여도 걷은 뒤엔 유예 — 같은 틱의 옛 빌드 정리가 지우지 않는다(격리 리뷰: 걷은 줄이 사라지면 별칭 참조도 사라졌다).
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '40 days' WHERE app_id='ret-a'`);
  const lg0 = calls("deleteLogGroup").filter((x) => x[1] === `/aws/lambda/${fnOf("ret-a")}`).length;
  const h3 = (await runAppServerHousekeeping({ api, metrics: async () => [], notify: async () => {} })).retire;
  const builds = await q(`SELECT zip_key FROM org_app_server_build WHERE app_id='ret-a' AND status='ok'`);
  chk("X2 7일 − 1분은 그대로 · 7일이면 함수 · 로그 그룹 · 줄을 걷고 빌드 기록 · zip 은 남는다", keptFn && !h2.retired.includes("ret-a") && h3.retired.includes("ret-a")
    && !fns.has(fnOf("ret-a")) && !(await rowOf("ret-a")) && calls("deleteLogGroup").filter((x) => x[1] === `/aws/lambda/${fnOf("ret-a")}`).length === lg0 + 1
    && builds.length >= 1 && builds.every((b) => zips.has(b.zip_key)), JSON.stringify({ keptFn, h2, h3, builds: builds.length }));

  // X3 걷은 뒤 서버 판으로 되돌리면 — 남은 빌드로 함수를 다시 만든다(빌드 없이)
  const seats0 = seats.length;
  await call("app_revert", { app_id: "ret-a", version_no: v1 }, alice, aliceCtx);
  const back = await waitFor(async () => { const x = await rowOf("ret-a"); return x?.cur_lambda_version ? x : null; });
  chk("X3 되돌리면 남은 빌드로 함수를 다시 만든다 · 빌드 0 · 표시 없음", !!back && fns.has(fnOf("ret-a")) && seats.length === seats0 && !back.unused_since,
    JSON.stringify({ back, seats: [seats0, seats.length] }));
  await call("org_app_remove", { app_id: "ret-a" }, boss);
}

// X4 지금 판은 서버를 뺐지만 공개 판에 서버 선언이 남아 있으면 — 쓰는 중(표시 안 함)
{
  await call("app_save", { files: twin("ret-b") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "ret-b", wait_s: 120 }, alice, aliceCtx);
  await call("app_visibility_set", { app_id: "ret-b", visibility: "all" }, alice, aliceCtx);
  await call("app_save", { files: noServer("ret-b") }, alice, aliceCtx);   // 공개 앱의 초안 — 공개 판은 서버 판 그대로
  await retire();
  const r = await rowOf("ret-b");
  chk("X4 공개 판에 서버 선언이 남아 있으면 표시하지 않는다", !!r && !r.unused_since && fns.has(fnOf("ret-b")), JSON.stringify(r));
  await call("org_app_remove", { app_id: "ret-b" }, boss);
}

// X5 표시가 붙은 뒤 서버 선언이 돌아오면 표시를 걷는다
{
  await call("app_save", { files: twin("ret-c") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "ret-c", wait_s: 120 }, alice, aliceCtx);
  await call("app_save", { files: noServer("ret-c") }, alice, aliceCtx);
  await retire();
  const marked = !!(await rowOf("ret-c")).unused_since;
  await call("app_save", { files: twin("ret-c") }, alice, aliceCtx);
  const h = await retire();
  const r = await rowOf("ret-c");
  chk("X5 서버 선언이 돌아오면 표시를 걷는다 · 함수 그대로", marked && h.cleared >= 1 && !r.unused_since && fns.has(fnOf("ret-c")), JSON.stringify({ marked, h, r: r.unused_since }));
  //  X5b 서버 판을 다시 올리면(별칭을 옮기면) 하우스키핑을 기다리지 않고 표시를 걷는다
  await call("app_save", { files: noServer("ret-c") }, alice, aliceCtx);
  await retire();
  const marked2 = !!(await rowOf("ret-c")).unused_since;
  await call("app_save", { files: twin("ret-c") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "ret-c", wait_s: 120 }, alice, aliceCtx);
  chk("X5b 표시가 붙은 함수에 서버 판을 다시 올리면 곧바로 표시를 걷는다", marked2 && d.status === "deployed" && !(await rowOf("ret-c")).unused_since, JSON.stringify({ marked2, status: d.status }));
  await call("org_app_remove", { app_id: "ret-c" }, boss);
}

// X6 멈춘 함수는 표시하지 않고 걷지도 않는다(붙어 있던 표시도 걷는다) — 지웠다 새로 만들어 멈춤을 피하지 않게
{
  await call("app_save", { files: twin("ret-d") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "ret-d", wait_s: 120 }, alice, aliceCtx);
  await call("app_server_stop", { app_id: "ret-d", reason: "시험" }, boss);
  await call("app_save", { files: noServer("ret-d") }, alice, aliceCtx);
  await ageUnused("ret-d", "30 days");
  const h = await retire();
  const r = await rowOf("ret-d");
  chk("X6 멈춘 함수 — 오래된 표시도 걷고 함수 · 줄 · 멈춤은 그대로", !h.retired.includes("ret-d") && !!r && !r.unused_since && !!r.stopped_at && fns.has(fnOf("ret-d")),
    JSON.stringify({ h, r: r && { unused_since: r.unused_since, stopped_at: r.stopped_at } }));
  await call("org_app_remove", { app_id: "ret-d" }, boss);
}

// X7 고른 뒤 · 잠그기 전에 서버 판이 돌아오면(경합) — 잠근 뒤 다시 보고 걷지 않는다
{
  await call("app_save", { files: twin("ret-e") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "ret-e", wait_s: 120 }, alice, aliceCtx);
  await call("app_save", { files: noServer("ret-e") }, alice, aliceCtx);
  await retire();
  await ageUnused("ret-e", "8 days");
  const h = await retire({ beforeRetire: async (id) => { if (id === "ret-e") await call("app_save", { files: twin("ret-e") }, alice, aliceCtx); } });
  const r = await rowOf("ret-e");
  chk("X7 걷기 직전 서버 판이 돌아왔으면 걷지 않는다(in-use)", !h.retired.includes("ret-e") && h.skipped.some((x) => x.app === "ret-e" && x.why === "in-use")
    && !!r && fns.has(fnOf("ret-e")), JSON.stringify(h));
  await call("org_app_remove", { app_id: "ret-e" }, boss);
}

//  걷을 준비 — 서버 판 배포 → 서버 선언을 뺀 판 → 표시 → 기한 지남
const readyToRetire = async (id) => {
  await call("app_save", { files: twin(id) }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: id, wait_s: 120 }, alice, aliceCtx);
  await call("app_save", { files: noServer(id) }, alice, aliceCtx);
  await retire();
  await ageUnused(id, "8 days");
};

// X8 배포가 잠금을 쥔 함수는 걷지 않는다(skipped locked) — 잠금을 빼앗지 않고 다음 틱에
{
  await readyToRetire("ret-f");
  await q(`UPDATE org_app_server SET lock_until = now() + interval '10 minutes' WHERE app_id='ret-f'`);
  const h = await retire();
  const r = await rowOf("ret-f");
  chk("X8 잠긴 함수는 걷지 않는다 · 함수 · 줄 · 잠금 그대로", h.skipped.some((x) => x.app === "ret-f" && x.why === "locked") && fns.has(fnOf("ret-f")) && !!r && !!r.lock_until,
    JSON.stringify(h));
  await q(`UPDATE org_app_server SET lock_until = NULL WHERE app_id='ret-f'`);
  await call("org_app_remove", { app_id: "ret-f" }, boss);
}

// X9 남의 워크스페이스 함수(태그)면 함수는 지우지 않고 우리 줄만 지운다
{
  await readyToRetire("ret-g");
  fns.get(fnOf("ret-g")).tags["lvly:tenant"] = "11111111-2222-3333-4444-555555555555";
  const del0 = calls("deleteFunction").filter((x) => x[1] === fnOf("ret-g") && x[2] == null).length;
  const h = await retire();
  chk("X9 남의 함수는 지우지 않고 줄만 지운다", h.retired.includes("ret-g") && fns.has(fnOf("ret-g")) && !(await rowOf("ret-g"))
    && calls("deleteFunction").filter((x) => x[1] === fnOf("ret-g") && x[2] == null).length === del0, JSON.stringify(h));
  fns.delete(fnOf("ret-g"));
  await call("org_app_remove", { app_id: "ret-g" }, boss);
}

// X10 함수 지우기가 실패하면 줄을 남기고 잠금을 푼다 — 다음 틱에 걷는다
{
  await readyToRetire("ret-h");
  failDelete.add(fnOf("ret-h"));
  const h1 = await retire();
  const r1 = await rowOf("ret-h");
  failDelete.delete(fnOf("ret-h"));
  const h2 = await retire();
  chk("X10 지우기 실패 → 줄 남김 · 잠금 풀림 → 다음 틱에 걷는다", h1.skipped.some((x) => x.app === "ret-h" && x.why === "error") && !!r1 && !r1.lock_until
    && h2.retired.includes("ret-h") && !fns.has(fnOf("ret-h")) && !(await rowOf("ret-h")), JSON.stringify({ h1, h2 }));
  await call("org_app_remove", { app_id: "ret-h" }, boss);
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
