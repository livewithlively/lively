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
//  #4485(v2-6 · 사양 표 G · H — spec-4485.md): G1 레이어 둘(웹 어댑터 + 검사 층) · 검사 층 환경 · 앱 값 · 토큰 · G2 공개 키 · 주소 없음 → 503(AWS 0)
//   G3 같은 빌드 · 같은 설정 → 판 재사용 · G4 판마다 새 토큰 · 안 가리키는 판의 토큰 회수 · 관리자 토큰은 그대로 · G5 시험 호출 = 검사 층 준비 판정(흘려 받기)
//   G6 실패한 배포의 새 토큰 회수 · 앱 지우기 → 함수 토큰 전부 회수 · H1~H4 자동 멈춤은 게이트웨이가 센 수(org_app_server_usage)
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
//  #4485 — 검사 층이 볼 신원 공개 키(시험 키 쌍) · 앱 서버가 부를 라이블리 주소.
const ID_SEED = crypto.createHash("sha256").update("pgt-4485").digest();
const ID_PUB = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), ID_SEED]), format: "der", type: "pkcs8" })).export({ format: "jwk" }).x;
process.env.LIVELY_APP_IDENTITY_PUBKEYS = JSON.stringify({ k1: ID_PUB });
const API_URL = "https://pgt-local.app.lvly.test";
const sha256hex = (v) => crypto.createHash("sha256").update(v).digest("hex");
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
const { appServerCapabilities } = await import(`${D}/capabilities/app-servers.js`);
const { appStoreCapabilities } = await import(`${D}/capabilities/app-store.js`);
const { itemsPool } = await import(`${D}/db/client.js`);
const { setServerDepsForTest } = await import(`${D}/apps/app-server-deploy.js`);
const { SERVER_BUILDER_JS } = await import(`${D}/apps/app-server-builder.js`);
const { watchAppServers, runAppServerHousekeeping } = await import(`${D}/apps/app-server-watch.js`);
const { recordAppServerCall, flushAppServerUsage, resetUsageForTest, USAGE_BUCKET_SEC } = await import(`${D}/apps/app-server-usage.js`);
const { resetGuardLayerCacheForTest } = await import(`${D}/apps/app-server-layer.js`);
const { appServerPolicy, setServerStopped } = await import(`${D}/apps/app-server-store.js`);
const { AwsError } = await import(`${D}/net/aws/aws-json.js`);
const { SINGLE_TENANT_ID } = await import(`${D}/db/tenant-column.js`);

const all = [...appCapabilities, ...appServerCapabilities, ...appStoreCapabilities];
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
const layers = [];   // #4485 검사 층 레이어 판(가짜 Lambda 의 계정)
const failDelete = new Set();   // R4 — 이 함수 지우기는 실패한다(AWS 오류 흉내)
let s3Denied = false;           // R1g — 다음 코드 올리기를 S3 권한 오류로(zip 은 있다)
const api = {
  getFunction: async (n) => { const f = fns.get(n); return f ? { Configuration: cfgOf(f), Tags: { ...f.tags } } : null; },
  //  판을 주면 그 판을 고정할 때의 설정(판은 바뀌지 않는다) — 없으면 $LATEST.
  getFunctionConfiguration: async (n, qual) => {
    const f = fns.get(n); if (!f) return null;
    if (qual && qual !== "$LATEST") { const v = f.versions.find((x) => x.Version === qual); return v ? JSON.parse(JSON.stringify(v.cfg)) : null; }
    return cfgOf(f);
  },
  createFunction: async (i) => {
    log.push(["createFunction", i]);
    if (fns.has(i.FunctionName)) throw new AwsError(409, "ResourceConflictException", "exists");
    const z = zipOr(i.Code.S3Key);
    fns.set(i.FunctionName, { cfg: { FunctionName: i.FunctionName, Role: i.Role, Handler: i.Handler, Runtime: i.Runtime, MemorySize: i.MemorySize, Timeout: i.Timeout,
      Layers: i.Layers.map((a) => ({ Arn: a })), Environment: i.Environment, Architectures: i.Architectures, CodeSha256: shaB64(z), State: "Active", LastUpdateStatus: "Successful" },
      tags: { ...i.Tags }, versions: [], seq: 0, aliases: new Map(), conc: null });
    return cfgOf(fns.get(i.FunctionName));
  },
  updateFunctionCode: async (n, code) => {
    log.push(["updateFunctionCode", n, code.S3Key]);
    if (s3Denied) { s3Denied = false; throw new AwsError(400, "InvalidParameterValueException", "Error occurred while GetObject. S3 Error Code: AccessDenied. S3 Error Message: Access Denied"); }
    const f = fns.get(n); f.cfg.CodeSha256 = shaB64(zipOr(code.S3Key)); return cfgOf(f);
  },
  updateFunctionConfiguration: async (n, i) => { log.push(["updateFunctionConfiguration", n, i]); const f = fns.get(n); Object.assign(f.cfg, i, i.Layers ? { Layers: i.Layers.map((a) => ({ Arn: a })) } : {}); return cfgOf(f); },
  publishVersion: async (n, i) => {
    log.push(["publishVersion", n, i.CodeSha256]);
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
  listVersions: async (n) => [{ Version: "$LATEST" }, ...(fns.get(n)?.versions ?? [])],
  putAlias: async (n, a, v) => { log.push(["putAlias", n, a, v]); fns.get(n).aliases.set(a, v); return { Name: a, FunctionVersion: v, AliasArn: `${n}:${a}` }; },
  //  #4485 흘려 받기 — 함수는 응답 흘려 보내기 모드라 본문이 «HTTP 통합 틀»(앞머리 + NUL 8 + 본문)이다(2026-10-16 실측).
  invokeStream: async (n, qual, payloadJson) => {
    const ev = JSON.parse(payloadJson);
    log.push(["invoke", n, qual, ev.rawPath]);
    const chunk = (b) => ({ type: "chunk", data: Buffer.from(b) });
    const done = (l) => ({ type: "complete", errorCode: null, errorDetails: null, log: l });
    async function* events() {
      if (invokeMode === "notready") {
        yield chunk(JSON.stringify({ errorType: "Extension.Crash", errorMessage: "exit status 1" }));
        yield done("Error: \"web application did not become ready within 20s (AWS_LWA_READINESS_CHECK_TIMEOUT_SECONDS); failing initialization\"\nREPORT RequestId: x\tDuration: 20049.17 ms\tBilled Duration: 20050 ms\tStatus: error\tError Type: Extension.Crash");
        return;
      }
      const guard = invokeMode === "noguard" ? {} : { "x-lively-guard": "ready" };
      yield chunk(Buffer.concat([Buffer.from(JSON.stringify({ statusCode: 200, headers: { "content-type": "application/json", ...guard }, cookies: [] })), Buffer.alloc(8)]));
      yield chunk(JSON.stringify({ guard: 1, app: "ready" }));
      yield done("REPORT RequestId: x\tDuration: 3.00 ms\tBilled Duration: 4 ms\t");
    }
    return { status: 200, executedVersion: qual, contentType: invokeMode === "notready" ? "application/octet-stream" : "application/vnd.awslambda.http-integration-response", events: events() };
  },
  listLayerVersions: async (l) => { log.push(["listLayerVersions", l]); return layers.filter((x) => x.layer === l).map((x) => ({ LayerVersionArn: x.arn, Version: x.v, Description: x.desc })); },
  publishLayerVersion: async (l, i) => {
    const v = layers.filter((x) => x.layer === l).length + 1;
    const arn = `arn:aws:lambda:ap-northeast-2:111122223333:layer:${l}:${v}`;
    layers.push({ layer: l, v, arn, desc: i.description, zip: i.zip });
    log.push(["publishLayerVersion", l, i.description]);
    return { LayerVersionArn: arn, Version: v, Description: i.description };
  },
  deleteFunction: async (n, qual) => {
    log.push(["deleteFunction", n, qual ?? null]);
    if (!qual && failDelete.has(n)) throw new AwsError(500, "ServiceException", "흉내 — 지우기 실패");
    const f = fns.get(n); if (!f) return; if (qual) f.versions = f.versions.filter((v) => v.Version !== qual); else fns.delete(n);
  },
  putConcurrency: async (n, k) => { log.push(["putConcurrency", n, k]); fns.get(n).conc = k; },
  deleteConcurrency: async (n) => { log.push(["deleteConcurrency", n]); const f = fns.get(n); if (f) f.conc = null; },
  ensureLogGroup: async (g, d) => { log.push(["ensureLogGroup", g, d]); },
  deleteLogGroup: async (g) => { log.push(["deleteLogGroup", g]); },
};
const deletedZips = [];
setServerDepsForTest({
  api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession, apiUrl: API_URL,
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
chk("D1c 함수 만들기 — 역할 · 핸들러 · 런타임 · arm64 · 512MB · 30초 · 워크스페이스 태그 · S3 zip",
  cf && cf.FunctionName === FN && cf.Role === ROLE && cf.Handler === "lively-run.sh" && cf.Runtime === "nodejs22.x" && cf.Architectures[0] === "arm64" && cf.MemorySize === 512 && cf.Timeout === 30
  && cf.Tags["lvly:tenant"] === SINGLE_TENANT_ID && cf.Code.S3Bucket === "fake-bucket" && zips.has(cf.Code.S3Key) && cf.Code.S3Key.includes("/z/srv/"), JSON.stringify(cf));
const v1env = cf?.Environment?.Variables ?? {};
const fnTokens = async (app) => q(`SELECT token_hash, revoked_at FROM auth_token WHERE label=$1 ORDER BY created_at`, [`app-server-fn:${app}`]);
chk("G1 ★ 레이어 둘(웹 어댑터 + 검사 층 — 올린 판) · 검사 층 환경 · 앱 값(주소 · 워크스페이스 · 공개 키) · 토큰은 이 앱의 살아 있는 함수 토큰",
  cf?.Layers.length === 2 && /LambdaAdapterLayerArm64:30$/.test(cf.Layers[0]) && cf.Layers[1] === layers[0]?.arn && layers.length === 1 && /sha256:[0-9a-f]{32}/.test(layers[0].desc)
  && v1env.AWS_LAMBDA_EXEC_WRAPPER === "/opt/lively/bootstrap" && v1env.AWS_LWA_PORT === "8099" && v1env.PORT === "8080" && v1env.AWS_LWA_INVOKE_MODE === "response_stream"
  && v1env.AWS_LWA_READINESS_CHECK_PATH === "/_lively/guard/ready" && v1env.LIVELY_API_URL === API_URL && v1env.LIVELY_APP_ID === "srv" && v1env.LIVELY_TENANT_ID === SINGLE_TENANT_ID
  && v1env.LIVELY_APP_IDENTITY_PUBKEYS === process.env.LIVELY_APP_IDENTITY_PUBKEYS && /^lvk_/.test(v1env.LIVELY_APP_TOKEN ?? "")
  && (await fnTokens("srv")).some((t) => t.token_hash === sha256hex(v1env.LIVELY_APP_TOKEN) && !t.revoked_at),
  JSON.stringify({ layers: cf?.Layers, env: Object.keys(v1env), published: layers.length }));
chk("D1d 로그 그룹(보관 14일) → 판 고정(코드 지문 조건) → 그 판으로 시험 호출 → 별칭 cur(나만 보는 앱이라 pub 없음)",
  calls("ensureLogGroup")[0]?.[1] === `/aws/lambda/${FN}` && calls("ensureLogGroup")[0]?.[2] === 14 && calls("publishVersion").length === 1
  && calls("publishVersion")[0][2] === shaB64(zips.get(cf.Code.S3Key)) && calls("invoke")[0]?.[2] === "1" && calls("invoke")[0]?.[3] === "/_lively/guard/ready"
  && calls("putAlias").length === 1 && calls("putAlias")[0][2] === "cur",
  JSON.stringify(log.map((x) => x[0])));
chk("D1e 기록 — cur = 1판 · 함수 판 1 · 빌드 ok · 그 판의 토큰 지문", r1?.cur_lambda_version === "1" && r1?.cur_version_no === s1.version_no && r1?.pub_lambda_version == null
  && r1?.cur_token_hash === sha256hex(v1env.LIVELY_APP_TOKEN)
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

// G3 · G4 토큰 — D2 는 같은 빌드라 판을 재사용(새 토큰 없음) · D3 의 새 판은 새 토큰 · 공개(pub = cur)는 그 판의 토큰을 이어받는다 · 옛 판 토큰은 회수
{
  const toks = await fnTokens("srv");
  const live = toks.filter((t) => !t.revoked_at);
  chk("G3 · G4 ★ 판마다 새 토큰 · 안 가리키는 판(1판)의 토큰은 회수 · cur · pub 가 같은 판이면 토큰도 하나", toks.length === 2 && live.length === 1
    && live[0].token_hash === r3.cur_token_hash && r3.pub_token_hash === r3.cur_token_hash && toks[0].revoked_at && toks[0].token_hash === sha256hex(v1env.LIVELY_APP_TOKEN),
    JSON.stringify({ toks, cur: r3.cur_token_hash, pub: r3.pub_token_hash }));
  const vcfg = fns.get(FN).versions.find((v) => v.Version === r3.cur_lambda_version)?.cfg;
  chk("G7 새 판에 구운 토큰 = 기록한 지문($LATEST 의 옛 토큰을 그대로 두지 않았다)", sha256hex(vcfg?.Environment?.Variables?.LIVELY_APP_TOKEN ?? "") === r3.cur_token_hash, JSON.stringify(Object.keys(vcfg?.Environment?.Variables ?? {})));
}
// G4b 관리자가 바깥 서버용으로 받은 토큰(app_server_token_mint)은 함수 토큰 회수가 건드리지 않는다
const adminTok = await call("app_server_token_mint", { app_id: "srv" }, boss);

// G2 ★ 공개 키 없음 · 라이블리 주소 없음 → 503 · 함수에 손대지 않는다
{
  const keep = process.env.LIVELY_APP_IDENTITY_PUBKEYS;
  const n0 = log.length;
  delete process.env.LIVELY_APP_IDENTITY_PUBKEYS;
  const g2 = await call("app_server_deploy", { app_id: "srv", wait_s: 60 }, alice, aliceCtx);
  process.env.LIVELY_APP_IDENTITY_PUBKEYS = "{\"k1\":\"short\"}";
  const g2b = await call("app_server_deploy", { app_id: "srv", wait_s: 60 }, alice, aliceCtx);
  process.env.LIVELY_APP_IDENTITY_PUBKEYS = keep;
  setServerDepsForTest({ api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession, apiUrl: undefined,
    presignPut: async (key) => `http://127.0.0.1:${zport}/${encodeURIComponent(key)}`, headZip: async (key) => (zips.has(key) ? { size: zips.get(key).length } : null),
    deleteZip: async (key) => { deletedZips.push(key); zips.delete(key); } });
  const prevPub = process.env.PUBLIC_URL; delete process.env.PUBLIC_URL;
  const g2c = await call("app_server_deploy", { app_id: "srv", wait_s: 60 }, alice, aliceCtx);
  if (prevPub !== undefined) process.env.PUBLIC_URL = prevPub;
  setServerDepsForTest({ api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession, apiUrl: API_URL,
    presignPut: async (key) => `http://127.0.0.1:${zport}/${encodeURIComponent(key)}`, headZip: async (key) => (zips.has(key) ? { size: zips.get(key).length } : null),
    deleteZip: async (key) => { deletedZips.push(key); zips.delete(key); } });
  const touched = log.slice(n0).filter((x) => ["createFunction", "updateFunctionCode", "updateFunctionConfiguration", "publishVersion", "invoke", "putAlias"].includes(x[0]));
  chk("G2 ★ 공개 키 없음 · 깨진 키 · 라이블리 주소 못 정함 → 실패 · AWS 함수에 손대지 않음", g2.status === "failed" && /공개 키/.test(String(g2.error)) && g2b.status === "failed"
    && g2c.status === "failed" && /LIVELY_API_URL/.test(String(g2c.error)) && touched.length === 0, JSON.stringify({ g2: g2.error, g2b: g2b.error, g2c: g2c.error, touched }));
}

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

// G5 · G6 ★ 시험 호출에 검사 층 표지가 없으면 실패 — 별칭 그대로 · 새로 구운 토큰은 회수
{
  const r0 = await serverRow();
  const live0 = (await fnTokens("srv")).filter((t) => !t.revoked_at).length;
  invokeMode = "noguard";
  await call("app_save", { files: filesOf({ server: "require('http').createServer((q,s)=>s.end('ng')).listen(Number(process.env.PORT));" }) }, alice, aliceCtx);
  const g5 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  invokeMode = "ok";
  const r5g = await serverRow();
  const toks = await fnTokens("srv");
  chk("G5 · G6 검사 층 표지 없는 시험 호출 → stage smoke · 별칭 그대로 · 이번 판 토큰 회수(살아 있는 수 그대로)", g5.status === "failed" && g5.stage === "smoke" && /검사 층/.test(String(g5.error))
    && r5g.cur_lambda_version === r0.cur_lambda_version && toks.filter((t) => !t.revoked_at).length === live0 && toks.length === live0 + 2,
    JSON.stringify({ g5: { status: g5.status, stage: g5.stage, error: g5.error }, toks: toks.length, live0 }));
  const admin = (await q(`SELECT revoked_at FROM auth_token WHERE label='app-server:srv'`))[0];
  chk("G4b 관리자가 받은 바깥 서버용 토큰은 그대로", !!adminTok?.token && admin && !admin.revoked_at, JSON.stringify(admin));
}

// D5 시험 호출 실패 → 별칭 그대로 · last_error
{
  const cur0 = (await serverRow()).cur_lambda_version;
  invokeMode = "notready";
  await call("app_save", { files: filesOf({ server: "require('http').createServer((q,s)=>s.end('np')).listen(3999);" }) }, alice, aliceCtx);
  const d5 = await call("app_server_deploy", { app_id: "srv", wait_s: 120 }, alice, aliceCtx);
  const r5 = await serverRow();
  chk("D5 시험 호출 실패 → stage smoke · 기록 끝부분 · 별칭 그대로 · last_error", d5.status === "failed" && d5.stage === "smoke" && /did not become ready/.test(String(d5.log)) && /PORT/.test(String(d5.error))
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

// D9 · H 감시(#4485) — 자동 멈춤은 게이트웨이가 센 수(org_app_server_usage · 아직 안 적은 수 포함)를 본다
{
  resetUsageForTest();
  const notes = [];
  const notify = async (a, title) => { notes.push(title); };
  const policy = await appServerPolicy();
  const T0 = 1_800_000_000_000;
  const bucketOf = (ms) => Math.floor(ms / 1000 / USAGE_BUCKET_SEC) * USAGE_BUCKET_SEC;
  const putUsage = (ms, calls, billedMs, rejected = 0) => q(
    `INSERT INTO org_app_server_usage(app_id, bucket, calls, billed_ms, rejected) VALUES ('srv', to_timestamp($1), $2, $3, $4)
     ON CONFLICT (tenant_id, app_id, bucket) DO UPDATE SET calls=EXCLUDED.calls, billed_ms=EXCLUDED.billed_ms, rejected=EXCLUDED.rejected`, [bucketOf(ms), calls, billedMs, rejected]);
  const clearUsage = () => q(`DELETE FROM org_app_server_usage`);
  await putUsage(T0, 30_000, 1000);
  const w0 = await watchAppServers(policy, { api, notify, now: () => T0 });
  chk("D9a · H1 경계 — 5분 호출 = 상한이면 멈추지 않는다", w0.checked === 1 && w0.stopped.length === 0 && fns.get(FN).conc === null, JSON.stringify(w0));
  await putUsage(T0, 30_001, 1000);
  const w1 = await watchAppServers(policy, { api, notify, now: () => T0 });
  const r9 = await serverRow();
  chk("D9b · H1 호출 > 상한 → 자동 멈춤 · 동시 실행 0 · 알림", w1.stopped[0] === "srv" && fns.get(FN).conc === 0 && r9.stop_kind === "auto" && r9.stopped_by === "auto" && notes.length === 1, JSON.stringify({ w1, r9 }));
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
  //  H2 실행 시간 합(Billed Duration) > 상한(3,000초) → 멈춤 · 경계 = 상한이면 그대로
  await clearUsage();
  await putUsage(T0, 10, 3_000_000);
  const h2a = await watchAppServers(policy, { api, notify, now: () => T0 });
  await putUsage(T0, 10, 3_000_001);
  const h2b = await watchAppServers(policy, { api, notify, now: () => T0 });
  chk("H2 실행 시간 합 = 3,000초 그대로 · 넘으면 멈춤", h2a.stopped.length === 0 && h2b.stopped[0] === "srv", JSON.stringify({ h2a, h2b }));
  await call("app_server_resume", { app_id: "srv" }, boss);
  //  H3 앞 칸과 지금 칸 중 큰 쪽 · 아직 안 적은(이 프로세스에 쌓인) 수도 더한다 · 11분 지난 칸은 안 본다
  await clearUsage();
  await putUsage(T0 - USAGE_BUCKET_SEC * 1000, 30_001, 1000);
  const h3a = await watchAppServers(policy, { api, notify, now: () => T0 });
  await call("app_server_resume", { app_id: "srv" }, boss);
  await clearUsage();
  await putUsage(T0 - 2 * USAGE_BUCKET_SEC * 1000 - 60_000, 99_999, 1000);   // 앞앞 칸 — 지난 것
  await putUsage(T0, 29_999, 1000);
  recordAppServerCall("srv", { billedMs: 1 }, T0); recordAppServerCall("srv", { billedMs: 1 }, T0);   // 아직 안 적은 두 번 → 30,001
  const h3b = await watchAppServers(policy, { api, notify, now: () => T0 });
  chk("H3 앞 칸이 넘으면 멈춤 · 지난 칸은 안 본다 · 아직 안 적은 수까지 더해 넘으면 멈춤", h3a.stopped[0] === "srv" && h3b.stopped[0] === "srv", JSON.stringify({ h3a, h3b }));
  await call("app_server_resume", { app_id: "srv" }, boss);
  resetUsageForTest();
  //  H4 상한으로 거절한 수는 호출 수가 아니다 · 적기(flush)가 같은 칸에 더한다
  await clearUsage();
  for (let i = 0; i < 3; i++) recordAppServerCall("srv", { rejected: true }, T0);
  recordAppServerCall("srv", { billedMs: 7, error: true }, T0);
  const flushed = await flushAppServerUsage();
  const urow = (await q(`SELECT calls, billed_ms::int AS billed_ms, errors, rejected FROM org_app_server_usage WHERE app_id='srv'`))[0];
  await putUsage(T0, 10, 1000, 50_000);
  const h4 = await watchAppServers(policy, { api, notify, now: () => T0 });
  chk("H4 거절은 rejected 로(호출 수 아님) · 적기가 한 칸에 더한다 · 거절이 많아도 멈추지 않는다", flushed >= 1 && urow?.calls === 1 && urow?.billed_ms === 7 && urow?.errors === 1 && urow?.rejected === 3 && h4.stopped.length === 0,
    JSON.stringify({ flushed, urow, h4 }));
  //  기준을 넘었는데 멈추지 못하면(여기선 함수가 남의 것으로 보임) — 관리자 · 책임자에게 «멈추지 못함» 을 알린다(조용히 넘어가지 않는다).
  fns.get(FN).tags["lvly:tenant"] = "11111111-2222-3333-4444-555555555555";
  await putUsage(T0, 30_001, 1000);
  const fails9 = [];
  const w9 = await watchAppServers(policy, { api, notify: async (a, title, body, kind) => { fails9.push(kind); }, now: () => T0 });
  fns.get(FN).tags["lvly:tenant"] = SINGLE_TENANT_ID;
  chk("D9f 기준을 넘었는데 멈추지 못하면 «멈추지 못함» 알림 · 멈춤 기록 없음", w9.stopped.length === 0 && fails9.includes("stop-failed") && fns.get(FN).conc === null && !(await serverRow()).stopped_at,
    JSON.stringify({ w9, fails9 }));
  await clearUsage();
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
  const hk = await runAppServerHousekeeping({ api, usage: async () => new Map(), notify: async () => {} });
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
  const baseDeps = { api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession, apiUrl: API_URL,
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
  const hk = await runAppServerHousekeeping({ api, usage: async () => new Map(), notify: async () => {} });
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

// R5b(#4485 Q1) 동시 처리 상한 — 저장은 준 값 그대로 · 쓰는 값은 앱 ≤ 워크스페이스 · 워크스페이스를 올리면 저장한 앱 값이 살아난다
{
  const a = await call("app_server_limits_set", { max_inflight_workspace: 50, max_inflight_app: 500 }, boss);
  const b = await call("app_server_limits_set", { max_inflight_workspace: 600 }, boss);
  chk("R5b 동시 처리 상한 — 저장은 500 그대로 · 쓰는 값 50 · 워크스페이스 600 이면 500",
    a.workspace_setting?.max_inflight_app === 500 && a.policy?.max_inflight_app === 50 && b.workspace_setting?.max_inflight_app === 500 && b.policy?.max_inflight_app === 500,
    JSON.stringify({ a: { set: a.workspace_setting, use: a.policy?.max_inflight_app }, b: { set: b.workspace_setting, use: b.policy?.max_inflight_app } }));
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
  const baseDeps = { api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, headZip: realHead, apiUrl: API_URL,
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

// D11 앱 지우기 → 함수 · 로그 · 기록 · zip
{
  const zipKeys = (await q(`SELECT zip_key FROM org_app_server_build WHERE app_id='srv' AND zip_key IS NOT NULL`)).map((x) => x.zip_key);
  await call("org_app_remove", { app_id: "srv" }, boss);
  const left = await q(`SELECT 1 FROM org_app_server WHERE app_id='srv' UNION ALL SELECT 1 FROM org_app_server_build WHERE app_id='srv'`);
  chk("D11 앱 지우기 → 함수 지움 · 로그 그룹 지움 · 기록 0 · zip 지움", !fns.has(FN) && calls("deleteLogGroup").some((x) => x[1] === `/aws/lambda/${FN}`) && left.length === 0
    && zipKeys.length > 0 && zipKeys.every((k) => deletedZips.includes(k)), JSON.stringify({ left, zipKeys: zipKeys.length, deleted: deletedZips.length }));
  const toks = await fnTokens("srv");
  chk("G6b ★ 앱 지우기 → 이 앱의 함수 토큰 전부 회수(같은 id 로 다시 만들어도 옛 토큰이 살아나지 않게)", toks.length > 0 && toks.every((t) => !!t.revoked_at), JSON.stringify(toks));
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
