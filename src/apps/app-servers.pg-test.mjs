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
//  #4801 코드를 우리 S3 에서 바로 읽기(V — 사양 엣지 표 spec-4801.md): V1 첫 배포가 빌드 기록의 판 번호로 바로 읽기 · V2 env 복사는 #4484 그대로
//   V3 복사로 만든 함수를 다음 배포가 바로 읽기로 옮긴다 · V4 이미 그 판을 읽으면 코드를 다시 안 올린다 · V5 같은 키에 다시 올라간 zip(판 바뀜) → 다시 빌드 · 새 판
//   V6 판 번호 없는 옛 빌드는 지금 판을 채워 쓴다 · V7 저장소가 판 번호를 안 주면 무효로 하지 않는다 · V8 남은 함수 판이 읽는 zip 은 30일 정리에서 뺀다(V8b 안 읽으면 지움)
//   V9 판 목록을 못 읽으면 이번엔 남긴다 · V11 앱 서버를 끈 배포에서 앱을 지우면 함수 · 기록 · zip 을 남긴다 · R4a/R4c 함수를 못 지우면 기록 · zip 도 남긴다
//   격리 리뷰 · 재검토: V12 판 목록 404 면 지운다 · V13 잠긴 앱은 건너뛴다 · V14 잠금 안 재확인(V14b 저장소 오류면 막지 않는다) · V15 Inactive 되살리기
//   (V15b Inactive + 지난 고치기 실패 · V15c 그 뒤 새 코드 · V15d 그 뒤 설정만 · V15e 그 뒤 같은 코드 · 같은 설정 — 모두 코드를 다시 올린다) · V16 건너뛴 후보 뒤도 훑는다 · V17 같은 시각 후보
//   V18 고른 뒤 별칭이 옮겨 온 빌드는 남긴다 · V19 고를 때 함수 줄 없던 앱에 줄이 생기면 남긴다 · V20 «아직 읽힘» 은 판 목록 한 번으로 거른다 · W11 실패 글 걷기
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
//  지역 · 스위치 · 레이어 · 런타임도 지운다 — 기대값(ap-northeast-2 · 기본 레이어 · nodejs22.x)이 그 셸의 env 에 흔들리지 않게(#4790 재검토 6).
for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_APP_BUNDLE_BUCKET", "LIVELY_APP_BUNDLE_POLICY", "LIVELY_APP_SERVER_POLICY", "LIVELY_APP_SERVER_PREFIX",
  "AWS_REGION", "LIVELY_APP_SERVER_REGION", "LIVELY_APP_BUNDLE_REGION", "LIVELY_APP_SERVER_TENANTS", "LIVELY_APP_SERVER_LAYER", "LIVELY_APP_SERVER_RUNTIME",
  "LIVELY_APP_SERVER_CODE_STORAGE"]) delete process.env[k];
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
const { watchAppServers, runAppServerHousekeeping, retireUnusedServers, refreshUnknownCodeBytes, pruneServerBuilds } = await import(`${D}/apps/app-server-watch.js`);
const { recordAppServerCall, flushAppServerUsage, resetUsageForTest, USAGE_BUCKET_SEC } = await import(`${D}/apps/app-server-usage.js`);
const { resetGuardLayerCacheForTest } = await import(`${D}/apps/app-server-layer.js`);
const { appServerPolicy, setServerStopped, claimServerRow } = await import(`${D}/apps/app-server-store.js`);
const { mintAppServerFunctionToken, revokeStaleFunctionTokens } = await import(`${D}/apps/app-server-auth.js`);
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
//  #4801 판 번호를 켠 버킷 흉내 — 올릴 때마다 새 판 번호(zipVer = 키의 지금 판 · zipByVer = 판마다 바이트). zips 는 «지금 객체» 그대로다(시험이 zips.delete 로
//   «zip 을 잃음» 을 흉내 낸다 — 그때는 판도 못 읽는 것으로 본다: 실제 S3 의 지움 표시보다 엄한 쪽).
const zips = new Map();
const zipVer = new Map();
const zipByVer = new Map();
let zseq = 0;
const zsrv = http.createServer((req, res) => {
  const parts = []; req.on("data", (d) => parts.push(d));
  req.on("end", () => {
    const k = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)); const b = Buffer.concat(parts); const v = `zv${++zseq}`;
    zips.set(k, b); zipVer.set(k, v); zipByVer.set(`${k}#${v}`, b);
    res.writeHead(200, { "x-amz-version-id": v }); res.end();
  });
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
//  #4801 Lambda 가 코드를 읽는 자리 — REFERENCE 면 그 판(판 번호가 없으면 지금 판으로 풀어 적는다) · COPY 면 지금 객체(ref 없음). 글은 2026-10-16 실제 AWS 원문.
const readCode = (code) => {
  if (code.S3ObjectStorageMode !== "REFERENCE") return { z: zipOr(code.S3Key), ref: null };
  const v = code.S3ObjectVersion ?? zipVer.get(code.S3Key);
  const z = zips.has(code.S3Key) ? zipByVer.get(`${code.S3Key}#${v}`) : null;
  if (!z) throw new AwsError(400, "InvalidParameterValueException", `The specified S3 object does not exist: s3://${code.S3Bucket}/${code.S3Key}${code.S3ObjectVersion ? ` (versionId=${code.S3ObjectVersion})` : ""}. Verify the object exists and the versionId is correct.`);
  return { z, ref: { S3Bucket: code.S3Bucket, S3Key: code.S3Key, S3ObjectVersion: v } };
};
//  고치기가 되면 LastUpdateStatus 가 Successful 로(실제 AWS — 지난 고치기의 실패 표시는 다음 고치기가 덮는다 · V15b~d).
const updated = (f) => { f.cfg.LastUpdateStatus = "Successful"; delete f.cfg.LastUpdateStatusReason; };
const listFail = new Set();     // #4801 V9 — 이 함수의 판 목록 읽기는 실패한다
const failDelete = new Set();   // R4 — 이 함수 지우기는 실패한다(AWS 오류 흉내)
let s3Denied = false;           // R1g — 다음 코드 올리기를 S3 권한 오류로(zip 은 있다) · "reference" 면 바로 읽기 권한 거절 글(#4801 R1h)
let publishDelayMs = 0;         // W9 — 판 고정을 늦춰 «판정 뒤 · 실측 앞» 창을 넓힌다
let createFail = null;          // W13 — 다음 함수 만들기를 이 AWS 오류로
const readyFail = new Set();    // W11 — 이 함수는 만든 뒤 «Failed» 상태로 보인다(준비 기다리기가 실패)
let createThenFail = null;      // W18 — 다음 함수 만들기는 AWS 에선 되지만 응답은 이 오류로(시간 넘김 흉내)
let logFail = null;             // W17 — 다음 로그 그룹 맞추기를 이 AWS 오류로
const api = {
  //  Code — REFERENCE 면 ResolvedS3Object(읽는 객체 · 판) · COPY 면 비어 있다(실제 GetFunction 과 같은 꼴 · #4801).
  //   판(qualifier)을 주면 그 판의 설정과 그 판이 읽는 코드 자리 — 재사용 판정이 본다(#4801).
  getFunction: async (n, qual) => {
    const f = fns.get(n); if (!f) return null;
    const at = qual && qual !== "$LATEST" ? f.versions.find((x) => x.Version === qual) : { cfg: f.cfg, ref: f.ref };
    return at ? { Configuration: JSON.parse(JSON.stringify(at.cfg)), Code: { RepositoryType: "S3", ResolvedS3Object: at.ref ? { ...at.ref } : null }, Tags: { ...f.tags } } : null;
  },
  //  판을 주면 그 판을 고정할 때의 설정(판은 바뀌지 않는다) — 없으면 $LATEST.
  getFunctionConfiguration: async (n, qual) => {
    const f = fns.get(n); if (!f) return null;
    //   실패 까닭엔 AWS 원문처럼 저장소 주소 · 계정 번호를 싣는다 — 사람에게 보이는 글에선 걷혀야 한다(W11 · #4801).
    if (readyFail.has(n)) return { ...cfgOf(f), State: "Failed", StateReason: "흉내 — 만든 뒤 실패: s3://fake-bucket/t/x/z/y.zip (acct 425515538094)" };
    if (qual && qual !== "$LATEST") { const v = f.versions.find((x) => x.Version === qual); return v ? JSON.parse(JSON.stringify(v.cfg)) : null; }
    return cfgOf(f);
  },
  createFunction: async (i) => {
    log.push(["createFunction", i]);
    if (createFail) { const e = createFail; createFail = null; throw e; }
    if (fns.has(i.FunctionName)) throw new AwsError(409, "ResourceConflictException", "exists");
    const { z, ref } = readCode(i.Code);
    fns.set(i.FunctionName, { cfg: { FunctionName: i.FunctionName, Role: i.Role, Handler: i.Handler, Runtime: i.Runtime, MemorySize: i.MemorySize, Timeout: i.Timeout,
      Layers: i.Layers.map((a) => ({ Arn: a })), Environment: i.Environment, Architectures: i.Architectures, CodeSha256: shaB64(z), CodeSize: z.length, State: "Active", LastUpdateStatus: "Successful" },
      ref, tags: { ...i.Tags }, versions: [], seq: 0, aliases: new Map(), conc: null });
    if (createThenFail) { const e = createThenFail; createThenFail = null; throw e; }
    return cfgOf(fns.get(i.FunctionName));
  },
  updateFunctionCode: async (n, code) => {
    log.push(["updateFunctionCode", n, code.S3Key, code]);
    if (s3Denied === "reference") {
      s3Denied = false;
      throw new AwsError(400, "InvalidParameterValueException", `Lambda service principal lambda.amazonaws.com does not have s3:GetObject and s3:GetObjectVersion permission on s3://${code.S3Bucket}/${code.S3Key}. Update the bucket policy to grant the Lambda service principal access and retry.`);
    }
    if (s3Denied) { s3Denied = false; throw new AwsError(400, "InvalidParameterValueException", "Error occurred while GetObject. S3 Error Code: AccessDenied. S3 Error Message: Access Denied"); }
    //  코드를 고치면 Inactive 함수도 되살아난다(AWS 문서 «restore access … and update the function» · #4801 V15). 고치기가 되면 지난 고치기의 실패도 걷힌다.
    const f = fns.get(n); const { z, ref } = readCode(code); f.cfg.CodeSha256 = shaB64(z); f.cfg.CodeSize = z.length; f.ref = ref; f.cfg.State = "Active"; updated(f); return cfgOf(f);
  },
  updateFunctionConfiguration: async (n, i) => { log.push(["updateFunctionConfiguration", n, i]); const f = fns.get(n); Object.assign(f.cfg, i, i.Layers ? { Layers: i.Layers.map((a) => ({ Arn: a })) } : {}); updated(f); return cfgOf(f); },
  publishVersion: async (n, i) => {
    log.push(["publishVersion", n, i.CodeSha256]);
    if (publishDelayMs) await new Promise((r) => setTimeout(r, publishDelayMs));
    const f = fns.get(n);
    if (i.CodeSha256 !== f.cfg.CodeSha256) throw new AwsError(412, "PreconditionFailedException", "sha");
    //  실제와 같게: 코드 · 설정이 마지막 판과 같으면 새 판을 만들지 않고 그 판을 돌려준다(설정이 바뀌면 새 판). 저장 방식 · 읽는 판만 바뀌어도
    //   새 판이다(#4801 — 2026-10-16 실측: 같은 zip 을 COPY 판 6 → REFERENCE 로 고치고 고정하면 판 7).
    const snap = cfgOf(f);
    const last = f.versions[f.versions.length - 1];
    if (last && JSON.stringify(last.cfg) === JSON.stringify(snap) && JSON.stringify(last.ref) === JSON.stringify(f.ref)) return { ...snap, Version: last.Version };
    const v = { Version: String(++f.seq), CodeSha256: f.cfg.CodeSha256, cfg: snap, ref: f.ref ? { ...f.ref } : null };
    f.versions.push(v);
    return { ...snap, Version: v.Version };
  },
  //  실제(ListVersionsByFunction)처럼 $LATEST 와 판마다 CodeSize — #4792 코드 저장 셈이 이 값을 더한다.
  //  #4801 판마다 CodeSha256 도(실제 ListVersionsByFunction 이 준다) — 옛 빌드 정리가 «남은 판이 아직 읽는 zip» 을 이 지문으로 가린다.
  listVersions: async (n) => {
    if (listFail.has(n)) throw new AwsError(500, "ServiceException", "흉내 — 판 목록 실패");
    const f = fns.get(n);
    return f ? [{ Version: "$LATEST", CodeSize: f.cfg.CodeSize, CodeSha256: f.cfg.CodeSha256 }, ...f.versions.map((v) => ({ Version: v.Version, CodeSize: v.cfg.CodeSize, CodeSha256: v.cfg.CodeSha256 }))] : [];
  },
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
  ensureLogGroup: async (g, d, tag) => { log.push(["ensureLogGroup", g, d, tag]); if (logFail) { const e = logFail; logFail = null; throw e; } },
  deleteLogGroup: async (g) => { log.push(["deleteLogGroup", g]); },
};
const deletedZips = [];
setServerDepsForTest({
  api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession, apiUrl: API_URL,
  presignPut: async (key) => `http://127.0.0.1:${zport}/${encodeURIComponent(key)}`,
  headZip: async (key) => (zips.has(key) ? { size: zips.get(key).length, versionId: zipVer.get(key) } : null),
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
  //  #4790 — 실행 역할의 쓰기 조건이 보는 태그 lvly-fn = 함수 이름 · TagResource 용 그룹 ARN(실행 역할의 계정 · 끝 :* 없이)
  && calls("ensureLogGroup")[0]?.[3]?.tags?.["lvly-fn"] === FN && calls("ensureLogGroup")[0]?.[3]?.arn === `arn:aws:logs:ap-northeast-2:111122223333:log-group:/aws/lambda/${FN}`
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
//  #4790 T1 같은 빌드를 다시 쓰는 배포도 로그 그룹 태그를 맞춘다(태그 전에 만든 함수 · 지워진 태그 — 태그가 없으면 그 함수 기록이 안 써진다)
{
  const lg = log.slice(before2).filter((x) => x[0] === "ensureLogGroup");
  chk("T1 같은 빌드 재사용 배포도 로그 그룹 태그를 맞춘다", lg.length === 1 && lg[0][3]?.tags?.["lvly-fn"] === FN, JSON.stringify(lg));
}

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

// G2d ★ 신원 공개 키가 없을 때 «새 앱» 의 첫 배포가 503 이면 함수 줄이 남지 않는다 — 줄을 잡기 전에 본다(#4792 함수 수 칸을 빈 줄이 차지하지 않게 ·
//  main 의 #4792 와 합치며 정한 순서 · 합치기 격리 리뷰가 «이 순서를 지키는 시험이 없다» 고 짚었다)
{
  const keepKeys = process.env.LIVELY_APP_IDENTITY_PUBKEYS;
  await call("app_save", { files: filesOf().map((f) => (f.path === "lively-app.json" ? { ...f, content: f.content.replace('"id":"srv"', '"id":"g2new"') } : f)) }, alice, aliceCtx);
  const before = Number((await q(`SELECT count(*)::int AS n FROM org_app_server`))[0].n);
  delete process.env.LIVELY_APP_IDENTITY_PUBKEYS;
  let r;
  try { r = await call("app_server_deploy", { app_id: "g2new", wait_s: 120 }, alice, aliceCtx); } finally { process.env.LIVELY_APP_IDENTITY_PUBKEYS = keepKeys; }
  const after = Number((await q(`SELECT count(*)::int AS n FROM org_app_server`))[0].n);
  const left = (await q(`SELECT 1 FROM org_app_server WHERE app_id='g2new'`))[0];
  chk("G2d ★ 공개 키 없음 → 새 앱의 첫 배포 실패 · 함수 줄이 남지 않는다(함수 수 칸을 안 차지한다)", r.status === "failed" && /공개 키/.test(String(r.error)) && !left && after === before,
    JSON.stringify({ status: r.status, error: r.error, row: !!left, before, after }));
  await call("org_app_remove", { app_id: "g2new" }, boss);
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
    && kA.zip_key !== kB.zip_key && zips.has(kA.zip_key) && zips.has(kB.zip_key),
    JSON.stringify({ a: { status: ta1.status, stage: ta1.stage, error: ta1.error, zip: zips.has(kA?.zip_key) }, b: { status: tb1.status, stage: tb1.stage, error: tb1.error, zip: zips.has(kB?.zip_key) }, kA, kB }));
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
  const zk = (await q(`SELECT zip_key FROM org_app_server_build WHERE app_id='orph' AND zip_key IS NOT NULL`)).map((x) => x.zip_key);
  await call("org_app_remove", { app_id: "orph" }, boss);
  const kept = await rowOf("orph");
  const keptBuilds = await q(`SELECT 1 FROM org_app_server_build WHERE app_id='orph'`);
  //  #4801 함수가 남은 동안은 그 함수가 읽는 zip · 빌드 기록도 남는다(함수가 우리 S3 를 바로 읽는다 — 지우면 나중에 그 함수가 멈춘다).
  chk("R4a 함수를 못 지우면 함수 줄 · 빌드 기록 · zip 을 남긴다(#4801 — 함수가 그 zip 을 읽는다)", fns.has(fnO) && !!kept && keptBuilds.length > 0
    && zk.length > 0 && zk.every((k) => zips.has(k) && !deletedZips.includes(k)), JSON.stringify({ kept: !!kept, builds: keptBuilds.length, zk }));
  //  #4485 — 함수를 못 지운 동안(pending)엔 그 함수가 쓰는 토큰도 살아 있다(앱 행이 없으니 쓸 수는 없다) · 고아 쓸기가 함수를 지울 때 함께 거둔다(R4d).
  const tkPending = await fnTokens("orph");
  chk("R4e 함수가 남은 동안엔 그 함수의 토큰도 남는다(지우기가 미뤄진 창)", tkPending.some((t) => !t.revoked_at), JSON.stringify(tkPending));
  //  그 사이 하우스키핑이 돌아도(함수 지우기는 또 실패) 옛 빌드 정리가 그 zip 을 고르지 않는다(앱은 없지만 함수 줄이 남았다).
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '40 days' WHERE app_id='orph'`);
  const hk0 = await runAppServerHousekeeping({ api, usage: async () => new Map(), notify: async () => {} });
  chk("R4c 함수가 남은 동안의 하우스키핑 — 정리가 그 앱의 zip · 기록을 지우지 않는다", fns.has(fnO) && hk0.orphans === 0
    && zk.every((k) => zips.has(k)) && (await q(`SELECT 1 FROM org_app_server_build WHERE app_id='orph'`)).length === keptBuilds.length, JSON.stringify(hk0));
  failDelete.delete(fnO);
  const hk = await runAppServerHousekeeping({ api, usage: async () => new Map(), notify: async () => {} });
  chk("R4b 하우스키핑이 앱 없는 함수 줄을 다시 지운다(함수 · 로그 그룹 · 줄) — 그 뒤에 빌드 기록 · zip 도 걷는다", !fns.has(fnO) && !(await rowOf("orph")) && hk.orphans === 1
    && calls("deleteLogGroup").some((x) => x[1] === `/aws/lambda/${fnO}`)
    && (await q(`SELECT 1 FROM org_app_server_build WHERE app_id='orph'`)).length === 0 && zk.every((k) => deletedZips.includes(k)), JSON.stringify(hk));
  const tkSwept = await fnTokens("orph");
  chk("R4d ★ 고아 쓸기가 함수를 지우며 그 앱의 함수 토큰도 회수(#4485 · 합치기 증분 리뷰)", tkSwept.length > 0 && tkSwept.every((t) => !!t.revoked_at), JSON.stringify(tkSwept));
}

// G3b ★ 토큰 지문이 없는 cur 판(v2-5 때 올린 판 흉내)은 같은 빌드 · 같은 설정이어도 재사용하지 않는다 — 새 판 · 새 토큰 지문(합치기 증분 리뷰:
//  이 조건을 지키는 DB 시험이 없었다 · 지우면 지문 없는 판에 별칭이 남아 앱 주소가 503 app_server_outdated)
{
  await call("app_save", { files: twin("g3b") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "g3b", wait_s: 120 }, alice, aliceCtx);
  const before = await rowOf("g3b");
  await q(`UPDATE org_app_server SET cur_token_hash = NULL WHERE app_id='g3b'`);
  const d = await call("app_server_deploy", { app_id: "g3b", wait_s: 120 }, alice, aliceCtx);
  const after = await rowOf("g3b");
  chk("G3b ★ 토큰 지문 없는 cur 판은 재사용하지 않는다 — 새 판 · 새 토큰 지문", d.status === "deployed" && !!before?.cur_lambda_version
    && after?.cur_lambda_version !== before.cur_lambda_version && !!after?.cur_token_hash && after.cur_token_hash !== before.cur_token_hash,
    JSON.stringify({ status: d.status, error: d.error, before: before?.cur_lambda_version, after: after?.cur_lambda_version, hash: !!after?.cur_token_hash }));
  await call("org_app_remove", { app_id: "g3b" }, boss);
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
  //  R1h(#4801) 바로 읽기의 권한 거절 글(버킷 정책 · 박스 역할이 빠짐)도 zip 탓이 아니다 — 빌드 그대로 ok · 마지막 오류는 플랫폼 문구(버킷 이름 · 키 없음)
  //   (앱은 이미 vL1 이라 되돌리기는 아무것도 안 한다 — 지금 판(vL1)을 배포해 cur(l2 빌드)에서 코드를 올리게 한다)
  await q(`UPDATE org_app_server SET last_error=NULL WHERE app_id='lost'`);
  s3Denied = "reference";
  const dh = await call("app_server_deploy", { app_id: "lost", wait_s: 120 }, alice, aliceCtx);
  const fired = s3Denied === false;
  s3Denied = false;   // 흉내가 다음 시험으로 새지 않게
  const errRef = await rowOf("lost");
  const b2 = (await q(`SELECT status FROM org_app_server_build WHERE app_id='lost' AND build_key=$1`, [kL.build_key]))[0];
  chk("R1h 바로 읽기 권한 거절 → 빌드 그대로 ok · 실패 글 · 마지막 오류는 플랫폼 권한 문구 · 버킷 · 키가 안 보인다", fired && dh.status === "failed" && b2?.status === "ok"
    && /플랫폼 쪽 AWS 권한/.test(String(dh.error)) && /플랫폼 쪽 AWS 권한/.test(String(errRef?.last_error))
    && !/fake-bucket|\/z\//.test(String(dh.error) + String(errRef?.last_error)), JSON.stringify({ fired, status: dh.status, error: dh.error, b2, last_error: errRef?.last_error }));
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
const baseDepsW = () => ({ api, bucket: "fake-bucket", pollMs: 1, sleep: async () => {}, spawnInSession, apiUrl: API_URL,
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
  //  W11b 실패 까닭(AWS 원문)의 판 묶음 버킷 주소 · 계정 번호는 사람에게 보이는 글에서 걷는다(#4801 격리 리뷰).
  chk("W11b 함수 상태 실패 글 — 저장소 주소 · 계정 번호를 걷는다(실패 글 · 마지막 오류)", /저장소 객체/.test(String(d.error))
    && !/fake-bucket|425515538094|s3:\/\//.test(String(d.error) + String(r?.last_error)), JSON.stringify({ error: d.error, last_error: r?.last_error }));
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
    getFunction: async (n, qual) => { if (blind) { blind = false; throw new AwsError(503, "ServiceUnavailableException", "흉내 — 조회 실패"); } return api.getFunction(n, qual); } };
  setServerDepsForTest({ ...baseDepsW(), api: blindApi });
  await call("app_save", { files: twin("uk-a") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "uk-a", wait_s: 120 }, alice, aliceCtx);
  setServerDepsForTest(baseDepsW());
  chk("W22 만들기 실패 뒤 확인도 실패 → 실패 · 줄 남김(모르는 채로 지우지 않음)", d.status === "failed" && createFail === null && !blind && !fns.has(fnOf("uk-a"))
    && !!(await rowOf("uk-a")), JSON.stringify({ status: d.status, error: d.error, blind }));
  await call("org_app_remove", { app_id: "uk-a" }, boss);
}

// #4790 T2 cur 가 이미 이 빌드인 배포(공개하기 · 다시 넣기 — 코드를 안 올리고 별칭만)는 로그 그룹을 못 맞춰도 별칭을 옮긴다 — 결과 warnings ·
//  logs_warning · 마지막 오류에 남긴다(이 길은 #4484 까지 Logs 를 안 불렀다). 다른 빌드로 가는 배포(되돌리기 포함)는 W17 처럼 실패로 남는다.
{
  await call("app_save", { files: twin("lg-r") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lg-r", wait_s: 120 }, alice, aliceCtx);
  const v0 = (await rowOf("lg-r"))?.cur_lambda_version;
  const pa0 = calls("putAlias").length;
  logFail = new AwsError(503, "ServiceUnavailableException", "흉내 — 로그 그룹 실패");
  const d = await call("app_server_deploy", { app_id: "lg-r", wait_s: 120 }, alice, aliceCtx);
  const r = await rowOf("lg-r");
  const pa = calls("putAlias").slice(pa0);
  chk("T2 재사용 배포 — 로그 그룹 실패여도 별칭을 옮긴다(cur → 같은 함수 판) · warnings · logs_warning · 마지막 오류", d.status === "deployed" && logFail === null && d.build?.reused === true
    && pa.length === 1 && pa[0][1] === fnOf("lg-r") && pa[0][2] === "cur" && pa[0][3] === v0
    && /흉내 — 로그 그룹 실패/.test(String(d.deploy?.logs_warning)) && /로그 그룹/.test(String(d.warnings?.[0])) && r?.cur_lambda_version === v0 && /로그 그룹/.test(String(r?.last_error)),
    JSON.stringify({ status: d.status, error: d.error, deploy: d.deploy, warnings: d.warnings, putAlias: pa, last_error: r?.last_error }));
  //  다음에 맞추면 마지막 오류가 걷힌다(별칭을 옮기며 지우고 · 다시 안 적는다).
  const d2 = await call("app_server_deploy", { app_id: "lg-r", wait_s: 120 }, alice, aliceCtx);
  chk("T2b 다음 재사용 배포가 로그 그룹을 맞추면 경고 · 마지막 오류가 없다", d2.status === "deployed" && d2.deploy?.logs_warning === undefined && d2.warnings === undefined && (await rowOf("lg-r"))?.last_error == null,
    JSON.stringify({ deploy: d2.deploy, last_error: (await rowOf("lg-r"))?.last_error }));
  //  재사용 길을 가장 자주 타는 것은 «공개하기» 다 — 그 응답(server)에도 최상위 warnings 가 보여야 한다(상태만 읽는 쪽 · 재검토).
  logFail = new AwsError(503, "ServiceUnavailableException", "흉내 — 로그 그룹 실패");
  const pub = await call("app_visibility_set", { app_id: "lg-r", visibility: "all" }, alice, aliceCtx);
  chk("T2c 공개하기(별칭만 옮김)도 로그 그룹 실패면 공개 · 서버 deployed · 응답 server.warnings", pub.changed === true && pub.server?.ok === true && pub.server?.state === "deployed"
    && logFail === null && /로그 그룹/.test(String(pub.server?.warnings?.[0])) && (await rowOf("lg-r"))?.pub_lambda_version === v0, JSON.stringify(pub.server));
  await call("org_app_remove", { app_id: "lg-r" }, boss);
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
  //  X2c 회수는 줄을 지우기 «전»(잠금을 쥔 채)에 — 줄이 있는 때 불렸는지 본다(합치기 격리 리뷰: 기다리던 배포의 새 토큰과 겹치지 않게)
  const seenRevoke = [];
  setServerDepsForTest({ ...baseDepsW(), revokeFunctionTokens: async (app, keep) => { seenRevoke.push({ app, row: !!(await rowOf(app)) }); return revokeStaleFunctionTokens(app, keep); } });
  const h3 = (await runAppServerHousekeeping({ api, usage: async () => new Map(), notify: async () => {} })).retire;
  setServerDepsForTest(baseDepsW());
  const builds = await q(`SELECT zip_key FROM org_app_server_build WHERE app_id='ret-a' AND status='ok'`);
  chk("X2 7일 − 1분은 그대로 · 7일이면 함수 · 로그 그룹 · 줄을 걷고 빌드 기록 · zip 은 남는다", keptFn && !h2.retired.includes("ret-a") && h3.retired.includes("ret-a")
    && !fns.has(fnOf("ret-a")) && !(await rowOf("ret-a")) && calls("deleteLogGroup").filter((x) => x[1] === `/aws/lambda/${fnOf("ret-a")}`).length === lg0 + 1
    && builds.length >= 1 && builds.every((b) => zips.has(b.zip_key)), JSON.stringify({ keptFn, h2, h3, builds: builds.length }));
  //  X2b ★ #4485 걷은 함수 판에 구운 앱 서버 토큰도 회수한다 — 줄과 함께 토큰 지문(cur · pub_token_hash)이 사라지면 남은 토큰을 거둘 자리가 없다
  //   (main 의 #4791 걷기와 #4485 함수 토큰을 합칠 때 찾은 틈).
  const retTok = await fnTokens("ret-a");
  chk("X2b ★ 걷으면 그 함수의 앱 서버 토큰도 전부 회수", retTok.length > 0 && retTok.every((t) => !!t.revoked_at), JSON.stringify(retTok));
  const retRevokes = seenRevoke.filter((x) => x.app === "ret-a");
  chk("X2c 걷기의 토큰 회수는 함수 줄을 지우기 전(줄이 있는 때 · 잠금을 쥔 채)", retRevokes.length >= 1 && retRevokes[0].row === true, JSON.stringify(seenRevoke));

  // X3 걷은 뒤 서버 판으로 되돌리면 — 남은 빌드로 함수를 다시 만든다(빌드 없이)
  const seats0 = seats.length;
  await call("app_revert", { app_id: "ret-a", version_no: v1 }, alice, aliceCtx);
  const back = await waitFor(async () => { const x = await rowOf("ret-a"); return x?.cur_lambda_version ? x : null; });
  chk("X3 되돌리면 남은 빌드로 함수를 다시 만든다 · 빌드 0 · 표시 없음", !!back && fns.has(fnOf("ret-a")) && seats.length === seats0 && !back.unused_since,
    JSON.stringify({ back, seats: [seats0, seats.length] }));
  const live3 = (await fnTokens("ret-a")).filter((t) => !t.revoked_at);
  chk("X3b 다시 만든 함수엔 새 토큰 하나 — 그 함수 판(cur)의 것", live3.length === 1 && live3[0].token_hash === back?.cur_token_hash,
    JSON.stringify({ live3, cur: back?.cur_token_hash }));
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

// ── #4801 코드를 우리 S3 에서 바로 읽기(V — 사양 엣지 표 spec-4801.md V1~V11) ──
//  저장소가 판 번호를 주는 길(실제 S3 · 판 번호 켠 버킷)로 바꿔 끼운다 — W · X 는 판 번호를 안 주는 저장소(baseDepsW)로 돌았다(V7 이 그 길을 따로 본다).
const headV = async (key) => (zips.has(key) ? { size: zips.get(key).length, versionId: zipVer.get(key) } : null);
const baseDepsV = () => ({ ...baseDepsW(), headZip: headV });
const putZip = (k, b) => { const v = `zv${++zseq}`; zips.set(k, b); zipVer.set(k, v); zipByVer.set(`${k}#${v}`, b); return v; };
const okBuilds = async (id) => q(`SELECT build_key, zip_key, zip_version, zip_sha256 FROM org_app_server_build WHERE app_id=$1 AND status='ok' ORDER BY started_at`, [id]);
const createOf = (fn) => calls("createFunction").filter((x) => x[1].FunctionName === fn).pop()?.[1];
const codeUps = (fn) => calls("updateFunctionCode").filter((x) => x[1] === fn);
const hkV = () => runAppServerHousekeeping({ api, usage: async () => new Map(), notify: async () => {} });
setServerDepsForTest(baseDepsV());

// V1 기본 env 첫 배포 — 함수가 빌드 기록의 판 번호(= 그때 저장소의 지금 판)로 zip 을 바로 읽는다
{
  await call("app_save", { files: twin("ref-a") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "ref-a", wait_s: 120 }, alice, aliceCtx);
  const [b] = await okBuilds("ref-a");
  const cf = createOf(fnOf("ref-a"));
  const f = fns.get(fnOf("ref-a"));
  chk("V1 첫 배포 — 만들기 Code = 바로 읽기 · 판 번호 = 빌드 기록 = 저장소의 지금 판 · 고정한 함수 판도 그 판을 읽는다",
    d.status === "deployed" && !!b?.zip_version && b.zip_version === zipVer.get(b.zip_key)
    && cf?.Code?.S3ObjectStorageMode === "REFERENCE" && cf.Code.S3ObjectVersion === b.zip_version && cf.Code.S3Key === b.zip_key && cf.Code.S3Bucket === "fake-bucket"
    && f?.ref?.S3ObjectVersion === b.zip_version && f.versions.at(-1)?.ref?.S3ObjectVersion === b.zip_version,
    JSON.stringify({ status: d.status, error: d.error, b, code: cf?.Code, ref: f?.ref }));
}

// V2 env 복사 — #4484 그대로 · V3 복사로 만든 함수를 다음 배포가 바로 읽기로 옮긴다 · V4 이미 그 판을 바로 읽으면 코드를 다시 안 올린다
{
  process.env.LIVELY_APP_SERVER_CODE_STORAGE = "copy";
  await call("app_save", { files: twin("cp-a") }, alice, aliceCtx);
  const d = await call("app_server_deploy", { app_id: "cp-a", wait_s: 120 }, alice, aliceCtx);
  delete process.env.LIVELY_APP_SERVER_CODE_STORAGE;
  const cf = createOf(fnOf("cp-a"));
  chk("V2 env 복사 — 만들기 Code 에 판 번호 · 모드 칸이 없고 함수가 복사로 읽는다", d.status === "deployed" && !!cf
    && !("S3ObjectVersion" in cf.Code) && !("S3ObjectStorageMode" in cf.Code) && fns.get(fnOf("cp-a")).ref === null && fns.get(fnOf("cp-a")).versions.at(-1)?.ref === null,
    JSON.stringify({ status: d.status, code: cf?.Code }));

  //  설정을 바꿔 «별칭만 옮기기» 가 아닌 배포를 만든다 — 같은 빌드 · 같은 코드 지문인데 $LATEST 는 복사다.
  await call("app_server_limits_set", { memory_mb: 1024 }, boss);
  const u0 = codeUps(fnOf("cp-a")).length;
  const d3 = await call("app_server_deploy", { app_id: "cp-a", wait_s: 120 }, alice, aliceCtx);
  const [b] = await okBuilds("cp-a");
  const ups = codeUps(fnOf("cp-a")).slice(u0);
  const r3 = await rowOf("cp-a");
  const v3 = fns.get(fnOf("cp-a")).versions.find((x) => x.Version === r3.cur_lambda_version);
  chk("V3 복사로 만든 함수 · 같은 코드 · 설정이 바뀐 배포 → 코드를 바로 읽기(판 번호)로 다시 올리고 새 함수 판이 그 판을 읽는다",
    d3.status === "deployed" && d3.build.reused === true && ups.length === 1 && ups[0][3].S3ObjectStorageMode === "REFERENCE" && ups[0][3].S3ObjectVersion === b.zip_version
    && v3?.ref?.S3ObjectVersion === b.zip_version && v3?.cfg.MemorySize === 1024,
    JSON.stringify({ status: d3.status, ups: ups.map((x) => x[3]), v3 }));

  await call("app_server_limits_set", { reset: true }, boss);
  const u1 = codeUps(fnOf("cp-a")).length;
  const d4 = await call("app_server_deploy", { app_id: "cp-a", wait_s: 120 }, alice, aliceCtx);
  const r4 = await rowOf("cp-a");
  const v4 = fns.get(fnOf("cp-a")).versions.find((x) => x.Version === r4.cur_lambda_version);
  chk("V4 이미 그 판을 바로 읽는 $LATEST · 같은 코드 · 설정이 바뀐 배포 → 코드 올리기 0 · 설정만 고친 새 함수 판",
    d4.status === "deployed" && codeUps(fnOf("cp-a")).length === u1 && r4.cur_lambda_version !== r3.cur_lambda_version && v4?.cfg.MemorySize === 512 && v4?.ref?.S3ObjectVersion === b.zip_version,
    JSON.stringify({ status: d4.status, ups: codeUps(fnOf("cp-a")).length - u1, before: r3.cur_lambda_version, after: r4.cur_lambda_version }));
  await call("org_app_remove", { app_id: "cp-a" }, boss);
}

// V5 zip 키의 지금 판이 기록과 다르면(누가 같은 키에 다시 올림) — Lambda 에 손대기 전에 그 빌드를 무효로 · 다시 빌드 · 새 판 번호로 cur 를 옮긴다
//  (별칭만 옮기는 재사용 길도 «그 함수 판이 지금 빌드의 판을 읽나» 를 본다 — 안 보면 30일 뒤 사라질 옛 판을 읽는 함수 판이 cur 로 남는다)
{
  const [b0] = await okBuilds("ref-a");
  const seats0 = seats.length;
  const uOther = putZip(b0.zip_key, zips.get(b0.zip_key));   // 같은 바이트를 같은 키에 다시 — 지금 판만 바뀐다
  const u0 = codeUps(fnOf("ref-a")).length;
  const d = await call("app_server_deploy", { app_id: "ref-a", wait_s: 120 }, alice, aliceCtx);
  const [b1] = await okBuilds("ref-a");
  const r = await rowOf("ref-a");
  const vcur = fns.get(fnOf("ref-a")).versions.find((x) => x.Version === r.cur_lambda_version);
  const ups = codeUps(fnOf("ref-a")).slice(u0);
  chk("V5 지금 판 ≠ 기록 → 다시 빌드(새 판 번호) · 코드를 그 판으로 다시 올림 · cur 함수 판이 새 판을 읽는다",
    d.status === "deployed" && d.build.reused === false && seats.length === seats0 + 1 && b1.build_key === b0.build_key
    && b1.zip_version === zipVer.get(b1.zip_key) && b1.zip_version !== b0.zip_version && b1.zip_version !== uOther
    && ups.length === 1 && ups[0][3].S3ObjectVersion === b1.zip_version && vcur?.ref?.S3ObjectVersion === b1.zip_version,
    JSON.stringify({ status: d.status, build: d.build, b0: b0.zip_version, b1: b1.zip_version, uOther, ups: ups.map((x) => x[3]), vcur: vcur?.ref }));
}

// V6 판 번호를 모르는 옛 빌드 기록(칸이 생기기 전) — 다시 쓸 때 저장소의 지금 판으로 채우고 함수에 그 판을 못 박는다
{
  const [b] = await okBuilds("ref-a");
  await q(`UPDATE org_app_server_build SET zip_version = NULL WHERE app_id='ref-a' AND build_key=$1`, [b.build_key]);
  const seats0 = seats.length;
  await call("app_server_limits_set", { memory_mb: 1024 }, boss);   // 별칭만 옮기기가 아닌 배포(새 함수 판)
  const d = await call("app_server_deploy", { app_id: "ref-a", wait_s: 120 }, alice, aliceCtx);
  await call("app_server_limits_set", { reset: true }, boss);
  const [b2] = await okBuilds("ref-a");
  const r = await rowOf("ref-a");
  const vcur = fns.get(fnOf("ref-a")).versions.find((x) => x.Version === r.cur_lambda_version);
  chk("V6 판 번호 없는 옛 빌드 → 다시 빌드하지 않고 기록에 지금 판을 채움 · 새 함수 판이 그 판을 읽는다",
    d.status === "deployed" && d.build.reused === true && seats.length === seats0 && b2.zip_version === zipVer.get(b2.zip_key) && vcur?.ref?.S3ObjectVersion === b2.zip_version,
    JSON.stringify({ status: d.status, error: d.error, b2, vcur: vcur?.ref }));
}

// V7 저장소가 판 번호를 안 준다(판 번호 끈 버킷) — 기록에 판 번호가 있어도 무효로 하지 않고 그대로 쓴다
{
  setServerDepsForTest(baseDepsW());
  const seats0 = seats.length;
  const [b] = await okBuilds("ref-a");
  const d = await call("app_server_deploy", { app_id: "ref-a", wait_s: 120 }, alice, aliceCtx);
  const [b2] = await okBuilds("ref-a");
  chk("V7 저장소가 판 번호를 안 줌 → 빌드 그대로 다시 씀(무효 · 다시 빌드 없음) · 기록 판 번호 그대로", d.status === "deployed" && d.build.reused === true && seats.length === seats0
    && b2?.build_key === b.build_key && b2.zip_version === b.zip_version, JSON.stringify({ status: d.status, build: d.build, b, b2 }));
  setServerDepsForTest(baseDepsV());
}

// V8 30일 지난 빌드라도 함수의 남은 판(별칭 밖)이 그 zip 을 읽으면 정리하지 않는다 → 그 판이 정리돼 아무도 안 읽으면 다음 정리에서 지운다(V8b)
{
  await call("app_save", { files: twin("pr-a", "require('http').createServer((q,s)=>s.end('p1')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "pr-a", wait_s: 120 }, alice, aliceCtx);
  const [bA] = await okBuilds("pr-a");
  await call("app_save", { files: twin("pr-a", "require('http').createServer((q,s)=>s.end('p2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "pr-a", wait_s: 120 }, alice, aliceCtx);
  const r = await rowOf("pr-a");
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '40 days' WHERE app_id='pr-a' AND build_key=$1`, [bA.build_key]);
  const readsA = fns.get(fnOf("pr-a")).versions.some((v) => v.CodeSha256 === bA.zip_sha256);
  const hk1 = await hkV();
  const keptA = (await okBuilds("pr-a")).some((x) => x.build_key === bA.build_key);
  chk("V8 30일 지남 · 별칭 밖 · 남은 함수 판(판 1)이 읽는 zip → 지우지 않는다", r.cur_build_key !== bA.build_key && readsA && keptA && zips.has(bA.zip_key) && !deletedZips.includes(bA.zip_key),
    JSON.stringify({ pruned: hk1.pruned, readsA, keptA }));
  //  옛 함수 판을 정리해(남길 판 1개) A 를 읽는 판이 없어지게 한다 — 새 빌드 C 를 올리면 판 1 · 2 가 정리된다.
  await call("app_server_limits_set", { keep_versions: 1 }, boss);
  await call("app_save", { files: twin("pr-a", "require('http').createServer((q,s)=>s.end('p3')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "pr-a", wait_s: 120 }, alice, aliceCtx);
  await call("app_server_limits_set", { reset: true }, boss);
  const f = fns.get(fnOf("pr-a"));
  const stillReads = f.cfg.CodeSha256 === bA.zip_sha256 || f.versions.some((v) => v.CodeSha256 === bA.zip_sha256);
  const hk2 = await hkV();
  chk("V8b 아무 판도 그 zip 을 안 읽게 되면 다음 정리가 zip 과 기록을 지운다", !stillReads && !(await okBuilds("pr-a")).some((x) => x.build_key === bA.build_key)
    && deletedZips.includes(bA.zip_key) && Number(hk2.pruned) >= 1, JSON.stringify({ stillReads, pruned: hk2.pruned }));
  await call("org_app_remove", { app_id: "pr-a" }, boss);
}

// V9 함수의 판 목록을 못 읽으면 이번 정리에선 그 함수의 빌드를 지우지 않는다 → 읽히면 지운다
{
  await call("app_save", { files: twin("pr-b", "require('http').createServer((q,s)=>s.end('q1')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "pr-b", wait_s: 120 }, alice, aliceCtx);
  const [bA] = await okBuilds("pr-b");
  await call("app_server_limits_set", { keep_versions: 1 }, boss);   // 두 번째 배포가 판 1(A)을 곧바로 정리 — A 는 아무도 안 읽는다
  await call("app_save", { files: twin("pr-b", "require('http').createServer((q,s)=>s.end('q2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "pr-b", wait_s: 120 }, alice, aliceCtx);
  await call("app_server_limits_set", { reset: true }, boss);
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '40 days' WHERE app_id='pr-b' AND build_key=$1`, [bA.build_key]);
  const f = fns.get(fnOf("pr-b"));
  const nobody = f.cfg.CodeSha256 !== bA.zip_sha256 && !f.versions.some((v) => v.CodeSha256 === bA.zip_sha256);
  listFail.add(fnOf("pr-b"));
  await hkV();
  const kept = (await okBuilds("pr-b")).some((x) => x.build_key === bA.build_key) && zips.has(bA.zip_key);
  listFail.delete(fnOf("pr-b"));
  await hkV();
  const gone = !(await okBuilds("pr-b")).some((x) => x.build_key === bA.build_key) && deletedZips.includes(bA.zip_key);
  chk("V9 판 목록 실패 → 이번엔 남김 · 읽히면 지움", nobody && kept && gone, JSON.stringify({ nobody, kept, gone }));
  await call("org_app_remove", { app_id: "pr-b" }, boss);
}

// V11 이 배포가 앱 서버를 끈 채 앱을 지우면(함수 줄 있음) — 함수 · 기록 · zip 을 남기고, 켜진 하우스키핑이 함수를 지운 뒤 함께 걷는다
{
  await call("app_save", { files: twin("off-a") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "off-a", wait_s: 120 }, alice, aliceCtx);
  const zk = (await okBuilds("off-a")).map((x) => x.zip_key);
  delete process.env.LIVELY_APP_SERVER_EXEC_ROLE;
  await call("org_app_remove", { app_id: "off-a" }, boss);
  process.env.LIVELY_APP_SERVER_EXEC_ROLE = ROLE;
  const kept = fns.has(fnOf("off-a")) && !!(await rowOf("off-a")) && (await q(`SELECT 1 FROM org_app_server_build WHERE app_id='off-a'`)).length > 0 && zk.every((k) => zips.has(k));
  const hk = await hkV();
  const gone = !fns.has(fnOf("off-a")) && !(await rowOf("off-a")) && (await q(`SELECT 1 FROM org_app_server_build WHERE app_id='off-a'`)).length === 0 && zk.every((k) => deletedZips.includes(k));
  chk("V11 앱 서버를 끈 배포에서 앱 지우기 → 함수 · 기록 · zip 남김 → 켜진 하우스키핑이 함께 걷는다", zk.length > 0 && kept && gone && hk.orphans >= 1, JSON.stringify({ kept, gone, orphans: hk.orphans }));
}

//  옛 빌드(A)를 만든다 — 첫 배포가 A, 둘째 배포가 B(cur). unref 면 둘째 배포 때 남길 판을 1개로 해 A 를 읽는 판(판 1)을 바로 정리한다.
const twoBuilds = async (id, unref) => {
  await call("app_save", { files: twin(id, `require('http').createServer((q,s)=>s.end('${id}-1')).listen(Number(process.env.PORT));`) }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: id, wait_s: 120 }, alice, aliceCtx);
  const [bA] = await okBuilds(id);
  if (unref) await call("app_server_limits_set", { keep_versions: 1 }, boss);
  await call("app_save", { files: twin(id, `require('http').createServer((q,s)=>s.end('${id}-2')).listen(Number(process.env.PORT));`) }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: id, wait_s: 120 }, alice, aliceCtx);
  if (unref) await call("app_server_limits_set", { reset: true }, boss);
  const f = fns.get(fnOf(id));
  const reads = f.cfg.CodeSha256 === bA.zip_sha256 || f.versions.some((v) => v.CodeSha256 === bA.zip_sha256);
  return { bA, reads };
};
const hasBuild = async (id, key) => (await okBuilds(id)).some((x) => x.build_key === key);

// V12 함수의 판 목록이 «함수 없음(404)» 이면 읽는 판도 없다 — 남은 판이 읽던 zip 이어도 지운다(V9 의 «못 읽음» 과 가른다)
{
  const { bA, reads } = await twoBuilds("pr-c", false);
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '40 days' WHERE app_id='pr-c' AND build_key=$1`, [bA.build_key]);
  const gone404 = { ...api, listVersions: async (n) => { if (n === fnOf("pr-c")) throw new AwsError(404, "ResourceNotFoundException", "Function not found"); return api.listVersions(n); } };
  await runAppServerHousekeeping({ api: gone404, usage: async () => new Map(), notify: async () => {} });
  chk("V12 판 목록이 404(함수 없음) → 읽는 판이 없다고 보고 지운다", reads && !(await hasBuild("pr-c", bA.build_key)) && deletedZips.includes(bA.zip_key), JSON.stringify({ reads }));
  await call("org_app_remove", { app_id: "pr-c" }, boss);
}

// V13 정리는 그 앱의 배포 잠금을 잡고 지운다 — 배포 · 걷기가 잠금을 쥐고 있으면 이번 틱엔 건너뛰고 · 풀리면 지운다
{
  const { bA, reads } = await twoBuilds("pr-d", true);
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '40 days' WHERE app_id='pr-d' AND build_key=$1`, [bA.build_key]);
  await q(`UPDATE org_app_server SET lock_until = now() + interval '5 minutes' WHERE app_id='pr-d'`);
  await hkV();
  const keptLocked = await hasBuild("pr-d", bA.build_key) && zips.has(bA.zip_key);
  const stillLocked = !!(await rowOf("pr-d")).lock_until;
  await q(`UPDATE org_app_server SET lock_until = NULL WHERE app_id='pr-d'`);
  await hkV();
  const gone = !(await hasBuild("pr-d", bA.build_key)) && deletedZips.includes(bA.zip_key);
  chk("V13 잠긴 앱의 옛 빌드는 건너뛴다(남의 잠금을 풀지 않는다) → 풀리면 지운다", !reads && keptLocked && stillLocked && gone && !(await rowOf("pr-d")).lock_until,
    JSON.stringify({ reads, keptLocked, stillLocked, gone }));
  await call("org_app_remove", { app_id: "pr-d" }, boss);
}

// V14 배포는 잠금 안에서 zip 을 한 번 더 본다 — 잠금 밖에서 본 뒤 지워졌으면(정리와 겹침) 그 판을 못 박지 않고 빌드를 무효로 · 함수는 그대로
{
  await call("app_save", { files: twin("rh-a", "require('http').createServer((q,s)=>s.end('r1')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "rh-a", wait_s: 120 }, alice, aliceCtx);
  const v1 = await verOf("rh-a");
  const [bA] = await okBuilds("rh-a");
  await call("app_save", { files: twin("rh-a", "require('http').createServer((q,s)=>s.end('r2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "rh-a", wait_s: 120 }, alice, aliceCtx);
  const cur0 = (await rowOf("rh-a")).cur_build_key;
  let seenA = 0;
  //  A 의 zip 을 처음 볼 때(잠금 밖 usableBuild)는 있고, 그다음(잠금 안)은 없다 — 그 사이 정리가 지운 것을 흉내 낸다.
  setServerDepsForTest({ ...baseDepsV(), headZip: async (key) => (key === bA.zip_key ? (seenA++ === 0 ? headV(key) : null) : headV(key)) });
  const u0 = calls("updateFunctionCode").length;
  const c0 = calls("createFunction").length;
  await call("app_revert", { app_id: "rh-a", version_no: v1 }, alice, aliceCtx);
  const bad = await waitFor(async () => { const b = (await q(`SELECT status, error FROM org_app_server_build WHERE app_id='rh-a' AND build_key=$1`, [bA.build_key]))[0]; return b?.status === "failed" ? b : null; });
  setServerDepsForTest(baseDepsV());
  const r = await rowOf("rh-a");
  chk("V14 잠금 안 재확인에서 zip 이 없어짐 → 코드 올리기 · 만들기 0 · 빌드 무효(다시 빌드하게) · cur 그대로", seenA >= 2 && !!bad && /방금 저장소에서 지워졌습니다/.test(String(bad.error))
    && calls("updateFunctionCode").length === u0 && calls("createFunction").length === c0 && r.cur_build_key === cur0, JSON.stringify({ seenA, bad, cur: r.cur_build_key === cur0 }));
  await call("org_app_remove", { app_id: "rh-a" }, boss);
}

// V14b 잠금 안 재확인이 저장소 오류(HEAD 실패)면 막지 않는다 — 잠금 밖 판정(usableBuild)과 같은 쪽(못 본 채 막으면 S3 가 흔들릴 때 모든 배포가 멈춘다)
{
  await call("app_save", { files: twin("rh-b", "require('http').createServer((q,s)=>s.end('b1')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "rh-b", wait_s: 120 }, alice, aliceCtx);
  const v1 = await verOf("rh-b");
  const [bA] = await okBuilds("rh-b");
  await call("app_save", { files: twin("rh-b", "require('http').createServer((q,s)=>s.end('b2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "rh-b", wait_s: 120 }, alice, aliceCtx);
  let seenA = 0;
  //  A 의 zip 을 처음 볼 때(잠금 밖)는 있고, 그다음(잠금 안)은 저장소가 답하지 않는다.
  setServerDepsForTest({ ...baseDepsV(), headZip: async (key) => { if (key === bA.zip_key && seenA++ > 0) throw new AwsError(503, "SlowDown", "흉내 — 저장소 흔들림"); return headV(key); } });
  const u0 = codeUps(fnOf("rh-b")).length;
  await call("app_revert", { app_id: "rh-b", version_no: v1 }, alice, aliceCtx);
  const r = await waitFor(async () => { const x = await rowOf("rh-b"); return x?.cur_build_key === bA.build_key ? x : null; });
  setServerDepsForTest(baseDepsV());
  chk("V14b 잠금 안 재확인이 저장소 오류 → 막지 않고 코드를 올려 cur 를 옮긴다 · 빌드는 무효로 안 적는다", seenA >= 2 && !!r && codeUps(fnOf("rh-b")).length === u0 + 1
    && (await okBuilds("rh-b")).some((b) => b.build_key === bA.build_key), JSON.stringify({ seenA, cur: r?.cur_build_key === bA.build_key, ups: codeUps(fnOf("rh-b")).length - u0 }));
  await call("org_app_remove", { app_id: "rh-b" }, boss);
}

// V15 Inactive(원본을 잃음 · 오래 쉼) 함수 — 같은 코드여도 다시 올려 되살린다(별칭만 옮기는 재사용 · 6분 기다리다 504 가 아니라)
{
  await call("app_save", { files: twin("in-a") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "in-a", wait_s: 120 }, alice, aliceCtx);
  const f = fns.get(fnOf("in-a"));
  f.cfg.State = "Inactive";
  for (const v of f.versions) v.cfg.State = "Inactive";
  const cur0 = (await rowOf("in-a")).cur_lambda_version;
  const u0 = codeUps(fnOf("in-a")).length;
  const d = await call("app_server_deploy", { app_id: "in-a", wait_s: 120 }, alice, aliceCtx);
  const r = await rowOf("in-a");
  chk("V15 Inactive 함수 · 같은 코드 → 코드를 다시 올려 되살림 · 새 함수 판으로 cur", d.status === "deployed" && d.build.reused === true && codeUps(fnOf("in-a")).length === u0 + 1
    && f.cfg.State === "Active" && r.cur_lambda_version !== cur0 && f.versions.find((v) => v.Version === r.cur_lambda_version)?.cfg.State === "Active",
    JSON.stringify({ status: d.status, error: d.error, ups: codeUps(fnOf("in-a")).length - u0, state: f.cfg.State, cur0, cur: r.cur_lambda_version }));
  await call("org_app_remove", { app_id: "in-a" }, boss);
}

//  V15b~e 지난 고치기가 실패한 채(LastUpdateStatus Failed)인 함수 — 그 표시가 다음 배포를 막지 않고, 배포는 코드를 다시 올려 제 고치기 결과로 정한다
//   (그때 보이는 코드 · 설정이 실제로 도는 것과 같은지 재 보지 않았으니 믿지 않는다 · 재검토).
const staleFail = (f) => Object.assign(f.cfg, { LastUpdateStatus: "Failed", LastUpdateStatusReason: "흉내 — 지난 고치기 실패" });
// V15b Inactive 이면서 지난 고치기도 실패 — 실패 표시에 먼저 걸려 502 가 아니라 코드를 다시 올려 되살린다
{
  await call("app_save", { files: twin("in-b") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "in-b", wait_s: 120 }, alice, aliceCtx);
  const f = fns.get(fnOf("in-b"));
  staleFail(f); f.cfg.State = "Inactive";
  for (const v of f.versions) v.cfg.State = "Inactive";
  const u0 = codeUps(fnOf("in-b")).length;
  const d = await call("app_server_deploy", { app_id: "in-b", wait_s: 120 }, alice, aliceCtx);
  chk("V15b Inactive + 지난 고치기 실패 → 코드를 다시 올려 되살림(Active · 고치기 성공)", d.status === "deployed" && codeUps(fnOf("in-b")).length === u0 + 1
    && f.cfg.State === "Active" && f.cfg.LastUpdateStatus === "Successful", JSON.stringify({ status: d.status, error: d.error, ups: codeUps(fnOf("in-b")).length - u0, cfg: [f.cfg.State, f.cfg.LastUpdateStatus] }));
  await call("org_app_remove", { app_id: "in-b" }, boss);
}
// V15c 지난 고치기 실패 뒤 새 코드 — 올리기 앞 기다림이 그 표시에 막히지 않는다
{
  await call("app_save", { files: twin("lf-a", "require('http').createServer((q,s)=>s.end('c1')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lf-a", wait_s: 120 }, alice, aliceCtx);
  const f = fns.get(fnOf("lf-a"));
  staleFail(f);
  await call("app_save", { files: twin("lf-a", "require('http').createServer((q,s)=>s.end('c2')).listen(Number(process.env.PORT));") }, alice, aliceCtx);
  const u0 = codeUps(fnOf("lf-a")).length;
  const d = await call("app_server_deploy", { app_id: "lf-a", wait_s: 120 }, alice, aliceCtx);
  chk("V15c 지난 고치기 실패 · 새 코드 → 코드를 올려 배포", d.status === "deployed" && codeUps(fnOf("lf-a")).length === u0 + 1 && f.cfg.LastUpdateStatus === "Successful",
    JSON.stringify({ status: d.status, error: d.error, ups: codeUps(fnOf("lf-a")).length - u0 }));
  await call("org_app_remove", { app_id: "lf-a" }, boss);
}
// V15d 지난 고치기 실패 뒤 같은 코드 · 설정만 다름 — 코드를 안 올리는 길의 기다림도 그 표시에 막히지 않고 설정을 고친다
{
  await call("app_save", { files: twin("lf-b") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lf-b", wait_s: 120 }, alice, aliceCtx);
  const f = fns.get(fnOf("lf-b"));
  //  누가 밖에서 메모리를 바꿔 두고(그 판도) 지난 고치기는 실패한 채 — 같은 빌드로 다시 배포하면 별칭만 옮기기는 못 하고(설정이 다르다) 설정을 고친다.
  staleFail(f); f.cfg.MemorySize = 1;
  for (const v of f.versions) v.cfg.MemorySize = 1;
  const u0 = codeUps(fnOf("lf-b")).length;
  const uc0 = calls("updateFunctionConfiguration").filter((x) => x[1] === fnOf("lf-b")).length;
  const d = await call("app_server_deploy", { app_id: "lf-b", wait_s: 120 }, alice, aliceCtx);
  const uc = calls("updateFunctionConfiguration").filter((x) => x[1] === fnOf("lf-b")).length - uc0;
  chk("V15d 지난 고치기 실패 · 같은 코드 · 설정만 다름 → 코드 다시 올리기 1 · 설정 고치기 1 · 배포", d.status === "deployed" && codeUps(fnOf("lf-b")).length === u0 + 1 && uc === 1
    && f.cfg.MemorySize !== 1 && f.cfg.LastUpdateStatus === "Successful", JSON.stringify({ status: d.status, error: d.error, ups: codeUps(fnOf("lf-b")).length - u0, uc, mem: f.cfg.MemorySize }));
  await call("org_app_remove", { app_id: "lf-b" }, boss);
}
// V15e 지난 고치기 실패 뒤 같은 코드 · $LATEST 설정도 바라는 값(cur 판만 옛 설정) — 실패 표시만 남은 $LATEST 를 그대로 못 박지 않고 코드를 다시 올린다
{
  await call("app_save", { files: twin("lf-c") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "lf-c", wait_s: 120 }, alice, aliceCtx);
  const f = fns.get(fnOf("lf-c"));
  //  cur 판은 옛 설정(그래서 별칭만 옮기기는 못 한다) · $LATEST 는 이미 바라는 설정 · 지난 고치기는 실패한 채.
  staleFail(f);
  for (const v of f.versions) v.cfg.MemorySize = 1;
  const u0 = codeUps(fnOf("lf-c")).length;
  const uc0 = calls("updateFunctionConfiguration").filter((x) => x[1] === fnOf("lf-c")).length;
  const d = await call("app_server_deploy", { app_id: "lf-c", wait_s: 120 }, alice, aliceCtx);
  const ucCalls = calls("updateFunctionConfiguration").filter((x) => x[1] === fnOf("lf-c")).slice(uc0);
  const uc = ucCalls.length;
  const r = await rowOf("lf-c");
  //  #4485 와 합친 뒤: 새로 못 박는 판에는 늘 새 앱 서버 토큰을 굽는다 — 설정 고치기는 환경 칸(토큰) 한 번뿐이고 다른 칸(메모리 · 시간 · 레이어 · 역할)은 그대로다.
  chk("V15e 지난 고치기 실패 · 같은 코드 · 설정 그대로 → 코드 다시 올리기 1 · 설정 고치기는 새 판의 토큰(환경 칸) 하나뿐 · 고친 뒤의 판을 못 박는다", d.status === "deployed"
    && codeUps(fnOf("lf-c")).length === u0 + 1 && uc === 1 && JSON.stringify(Object.keys(ucCalls[0]?.[2] ?? {})) === '["Environment"]'
    && f.cfg.LastUpdateStatus === "Successful"
    && f.versions.find((v) => v.Version === r?.cur_lambda_version)?.cfg.LastUpdateStatus === "Successful",
    JSON.stringify({ status: d.status, error: d.error, ups: codeUps(fnOf("lf-c")).length - u0, uc, fields: ucCalls.map((x) => Object.keys(x[2])), cur: r?.cur_lambda_version }));
  await call("org_app_remove", { app_id: "lf-c" }, boss);
}

// V16 건너뛴 후보(아직 읽히는 zip)가 앞자리에 있어도 뒤의 후보를 지운다 — 넘겨 가며 훑는다(쪽 크기 1 · 지울 수 1 로 좁혀 본다)
{
  const p = await twoBuilds("pg-a", false);   // P = 판 1 이 읽는다(남김)
  const dd = await twoBuilds("pg-b", true);   // D = 아무도 안 읽는다(지움)
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '90 days' WHERE app_id='pg-a' AND build_key=$1`, [p.bA.build_key]);
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '89 days' WHERE app_id='pg-b' AND build_key=$1`, [dd.bA.build_key]);
  const n = await pruneServerBuilds({ api }, 1, 10, 1);
  chk("V16 앞자리의 «아직 읽힘» 후보를 건너 뒤의 후보를 지운다(쪽 1 · 지울 수 1)", p.reads && !dd.reads && n === 1 && await hasBuild("pg-a", p.bA.build_key)
    && !(await hasBuild("pg-b", dd.bA.build_key)) && deletedZips.includes(dd.bA.zip_key) && !deletedZips.includes(p.bA.zip_key), JSON.stringify({ n, p: p.reads, d: dd.reads }));
  await call("org_app_remove", { app_id: "pg-a" }, boss);
  await call("org_app_remove", { app_id: "pg-b" }, boss);
}

// V17 같은 시각의 후보 둘 — 쪽 크기 1 로 넘겨도 둘째를 놓치지 않는다(키셋 = 시각 · 앱 · 빌드 키 · 시각은 마이크로초까지 · 재검토)
{
  const p = await twoBuilds("pt-a", false);   // 판 1 이 읽는다(남김)
  const dd = await twoBuilds("pt-b", true);   // 아무도 안 읽는다(지움)
  //  둘을 같은 시각(마이크로초 포함)으로 — 다른 후보보다 앞서게 오래전. 앱 id 순(pt-a < pt-b)이라 남길 후보가 먼저 온다.
  await q(`UPDATE org_app_server_build SET started_at = timestamptz '2020-01-01 00:00:00.123456+00' WHERE (app_id='pt-a' AND build_key=$1) OR (app_id='pt-b' AND build_key=$2)`,
    [p.bA.build_key, dd.bA.build_key]);
  const n = await pruneServerBuilds({ api }, 1, 10, 1);
  chk("V17 같은 시각 후보 둘(앞은 읽힘) — 쪽 1 로 넘겨 뒤 후보를 지운다", p.reads && !dd.reads && n === 1 && await hasBuild("pt-a", p.bA.build_key)
    && !(await hasBuild("pt-b", dd.bA.build_key)) && deletedZips.includes(dd.bA.zip_key), JSON.stringify({ n, p: p.reads, d: dd.reads }));
  await call("org_app_remove", { app_id: "pt-a" }, boss);
  await call("org_app_remove", { app_id: "pt-b" }, boss);
}

// V18 고른 뒤 · 잠그기 전에 별칭이 그 빌드로 옮겨 오면(되돌리기 · 공개) 지우지 않는다 — 잠금 안에서 별칭을 다시 본다
{
  const dd = await twoBuilds("pm-a", true);   // A = 아무 판도 안 읽는다(고를 땐 지울 후보)
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '40 days' WHERE app_id='pm-a' AND build_key=$1`, [dd.bA.build_key]);
  const cur0 = (await rowOf("pm-a")).cur_build_key;
  let moved = false;
  //  잠그기 전 거르기(판 목록 읽기) 때 다른 배포가 cur 를 A 로 옮긴 것처럼 — 줄만 바꾼다(흉내).
  const racing = { ...api, listVersions: async (n) => {
    if (n === fnOf("pm-a") && !moved) { moved = true; await q(`UPDATE org_app_server SET cur_build_key=$1 WHERE app_id='pm-a'`, [dd.bA.build_key]); }
    return api.listVersions(n);
  } };
  await pruneServerBuilds({ api: racing });
  const kept = await hasBuild("pm-a", dd.bA.build_key) && zips.has(dd.bA.zip_key);
  await q(`UPDATE org_app_server SET cur_build_key=$1 WHERE app_id='pm-a'`, [cur0]);
  await pruneServerBuilds({ api });
  const gone = !(await hasBuild("pm-a", dd.bA.build_key)) && deletedZips.includes(dd.bA.zip_key);
  chk("V18 고른 뒤 별칭이 옮겨 온 빌드 → 남김 → 별칭이 떠나면 지움", moved && !dd.reads && kept && gone, JSON.stringify({ moved, reads: dd.reads, kept, gone }));
  await call("org_app_remove", { app_id: "pm-a" }, boss);
}

// V19 고를 때 함수 줄이 없던 앱(앱이 사라짐)의 빌드 — 지우기 직전 그 앱 id 에 함수 줄이 생겼으면(같은 id 로 다시 만든 앱의 배포) 지우지 않는다
{
  //  사라진 앱의 빌드: 함수를 못 지운 채 앱을 지우고(R4a — 줄 · 빌드 · zip 이 남는다) 고아 쓸기가 함수 · 줄만 지우고 멈춘 것처럼 줄을 지운다.
  await call("app_save", { files: twin("gx-a") }, alice, aliceCtx);
  await call("app_server_deploy", { app_id: "gx-a", wait_s: 120 }, alice, aliceCtx);
  const [bG] = await okBuilds("gx-a");
  failDelete.add(fnOf("gx-a"));
  await call("org_app_remove", { app_id: "gx-a" }, boss);
  failDelete.delete(fnOf("gx-a"));
  fns.delete(fnOf("gx-a"));
  await q(`DELETE FROM org_app_server WHERE app_id='gx-a'`);
  //  앞 후보(함수가 있는 다른 앱의 옛 빌드) — 그 판 목록을 읽을 때 «같은 id 로 다시 만든 앱의 배포가 줄을 잡았다» 를 흉내 낸다.
  const dd = await twoBuilds("gx-b", true);
  await q(`UPDATE org_app_server_build SET started_at = timestamptz '2019-01-01 00:00:00+00' WHERE app_id='gx-b' AND build_key=$1`, [dd.bA.build_key]);
  let claimed = false;
  const racing = { ...api, listVersions: async (n) => {
    if (n === fnOf("gx-b") && !claimed) { claimed = true; await q(`INSERT INTO org_app_server (app_id, function_name) VALUES ('gx-a', $1)`, [fnOf("gx-a")]); }
    return api.listVersions(n);
  } };
  await pruneServerBuilds({ api: racing });
  const kept = await hasBuild("gx-a", bG.build_key) && zips.has(bG.zip_key);
  const tookB = !(await hasBuild("gx-b", dd.bA.build_key));
  await q(`DELETE FROM org_app_server WHERE app_id='gx-a'`);
  await pruneServerBuilds({ api });
  const gone = !(await hasBuild("gx-a", bG.build_key)) && deletedZips.includes(bG.zip_key);
  chk("V19 고를 때 줄 없던 앱에 줄이 생김 → 그 앱의 빌드 · zip 남김 → 줄이 없어지면 지움", claimed && tookB && kept && gone, JSON.stringify({ claimed, tookB, kept, gone }));
  await call("org_app_remove", { app_id: "gx-b" }, boss);
}

// V20 «아직 읽힘» 은 이 틱의 판 목록 한 번으로 먼저 거른다 — 같은 함수의 후보마다 잠그고 다시 읽지 않는다(재검토 · 앱이 많아지면 Lambda 제어면 몫)
{
  for (const tag of ["l1", "l2", "l3"]) {
    await call("app_save", { files: twin("lv-a", `require('http').createServer((q,s)=>s.end('${tag}')).listen(Number(process.env.PORT));`) }, alice, aliceCtx);
    await call("app_server_deploy", { app_id: "lv-a", wait_s: 120 }, alice, aliceCtx);
  }
  const old = (await okBuilds("lv-a")).slice(0, 2);   // 앞의 둘 — 셋째가 cur, 둘은 남긴 함수 판이 읽는다
  await q(`UPDATE org_app_server_build SET started_at = now() - interval '40 days' WHERE app_id='lv-a' AND build_key = ANY($1::text[])`, [old.map((b) => b.build_key)]);
  const f = fns.get(fnOf("lv-a"));
  const reads = old.length === 2 && old.every((b) => f.versions.some((v) => v.CodeSha256 === b.zip_sha256));
  let lists = 0;
  const counting = { ...api, listVersions: async (n) => { if (n === fnOf("lv-a")) lists++; return api.listVersions(n); } };
  await pruneServerBuilds({ api: counting });
  chk("V20 같은 함수의 «아직 읽힘» 후보 둘 → 판 목록 한 번 · 둘 다 남김", reads && lists === 1 && (await okBuilds("lv-a")).length === 3, JSON.stringify({ reads, lists }));
  await call("org_app_remove", { app_id: "lv-a" }, boss);
}
await call("org_app_remove", { app_id: "ref-a" }, boss);

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

// G6c ★ 함수 줄 없이 남은 함수 토큰(걷기가 회수를 못 한 채 줄을 지운 경우)도 앱을 지우면 거둔다(합치기 격리 리뷰)
{
  await call("app_save", { files: filesOf().map((f) => (f.path === "lively-app.json" ? { ...f, content: f.content.replace('"id":"srv"', '"id":"tok-left"') } : f)) }, alice, aliceCtx);
  await mintAppServerFunctionToken("tok-left", "pg-test");
  const live0 = (await fnTokens("tok-left")).filter((t) => !t.revoked_at).length;
  const noRow = !(await rowOf("tok-left"));
  await call("org_app_remove", { app_id: "tok-left" }, boss);
  const toks = await fnTokens("tok-left");
  chk("G6c ★ 함수 줄 없이 남은 함수 토큰도 앱을 지우면 회수", noRow && live0 === 1 && toks.length === 1 && toks.every((t) => !!t.revoked_at), JSON.stringify({ noRow, live0, toks }));
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
