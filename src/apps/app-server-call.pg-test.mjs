// server 실행기 — 앱 선언 MCP 도구를 앱 서버 라우트로(#5053 앱 v2-42) PG 통합 시험 — **실제 Postgres 필요**(CI services:postgres 스텝 — .github/workflows/test.yml 에 등록).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/apps/app-server-call.pg-test.mjs
//
//  무엇을 보나 — 한 줄 끝까지: **세션 머리글 없는 OAuth 토큰**(진짜 인가 흐름)으로 실제 /mcp 에 붙어 server 도구를 부르면 → server 실행기 → 게이트웨이가
//   부르기 행(org_app_call)을 만들고 함수를 흘려 받기로 부른다(가짜 Lambda — 이벤트를 HTTP 로 바꾸는 웹 어댑터 몫만) → **진짜 검사 층(GUARD_JS · 공개 키 없음)** 이
//   실제 /api/app-calls/<부르기>/claim 을 부른다 → 가짜 앱이 받은 머리글을 적고, 받은 돌기 신원으로 **실제 앱 서버 문**(sessionOrBearer appServer — 능력 REST 와 같은 문)을
//   다시 부른다 → 답이 도구 결과가 된다. DB 는 행 격리 정책을 켠 채 앱 역할(NOSUPERUSER · NOBYPASSRLS)로 붙는다(#5050 pg 시험과 같은 꼴).
//  사양 엣지 표(spec-5053) E1~E13 — 태스크 엣지 표 8행: ① 동의 없음(E1) ② 초안 도구(E2) ③ 인자(E3) ④ 앱이 받는 머리글(E13 · 검사 층 단위 시험 D1) ⑤ 같은 비밀 두 번(E5)
//   ⑥ 30초 넘김(E6) ⑦ 응답 상한(E7) ⑧ 서버 꺼짐 · 미배포(E8) + 돌기 신원 주체(E10) · #5081 이 읽는 모양(E11) · 정비(E12).
//  BG1~BG7 30초 넘는 도구(run.background — 결정 상민 2026-10-29): 백그라운드 작업(#4486)으로 돌리고 대신 기다림 — 가짜 Lambda 의 비동기 부르기가 이벤트를
//   **진짜 검사 층의 작업 길**(claim · 결과 보고)로 넘긴다 · 진행 알림 · 못 끝나면 작업 번호 → app_job_get · 작업의 권한 상한(부른 연결의 권한).
import "../../scripts/test-apps-root.mjs";   // #4778 앱 폴더 자리를 임시 폴더로
import pg from "pg";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_app_server_call_5053";
const ROLE = `lvly_app_${DB}`;            // org/tenancy/activate.ts appRoleName(current_database()) 과 같은 이름 — 정책이 이 역할에 걸린다
const ROLE_PW = crypto.randomBytes(16).toString("hex");
const dsnFor = (db, user) => { const u = new URL(BASE); u.pathname = "/" + db; if (user) { u.username = user.name; u.password = user.pw; } return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`DROP ROLE IF EXISTS ${ROLE}`);
const OWNER_DSN = dsnFor(DB);
const D = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
let dbc = null, itemsPool = null, gwServer = null, appServer = null, guard = null;

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const J = (x) => JSON.stringify(x);
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
//  A = 기본 워크스페이스(신원 전역 표가 사는 자리 — #5050 pg 시험 머리말).
const TA = "00000000-0000-0000-0000-000000000000";
let CUR = TA;

try {
  await su.query(`CREATE DATABASE ${DB}`);
  await su.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  dbc = new pg.Client({ connectionString: OWNER_DSN }); await dbc.connect();
  await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG */ });
  const childEnv = { ...process.env, ITEMS_DATABASE_URL: OWNER_DSN };
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID"]) delete childEnv[k];
  const policyOut = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { initAllSchemas } = await import(${J(`${D}/boot/schemas.js`)});
    await initAllSchemas({ quiet: true });
    const { ensureTenantPolicies } = await import(${J(`${D}/org/tenancy/activate.js`)});
    const r = await ensureTenantPolicies();
    const { itemsPool } = await import(${J(`${D}/db/client.js`)});
    await itemsPool.end();
    process.stdout.write("\\n@@policies " + JSON.stringify(r) + "\\n");
    process.exit(0);`], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 300_000 });
  const policies = (() => { try { return JSON.parse(/^@@policies (.+)$/m.exec(policyOut)?.[1] ?? "null"); } catch { return null; } })();
  await dbc.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);

  process.env.ITEMS_DATABASE_URL = dsnFor(DB, { name: ROLE, pw: ROLE_PW });
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_MCP_SESSIONED", "LIVELY_APP_SERVER_EXEC_ROLE", "LIVELY_APP_DOMAIN"]) delete process.env[k];
  const client = await import(`${D}/db/client.js`);
  itemsPool = client.itemsPool;
  client.installTenantResolver(() => CUR);

  const express = (await import("express")).default;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { BearerVerifier } = await import(`${D}/auth/bearer.js`);
  const { bearerWithResourceMetadata, sessionOrBearer } = await import(`${D}/auth/http-auth.js`);
  const { resetResourceIdCache } = await import(`${D}/auth/resource-id.js`);
  const { registerMcpTransport } = await import(`${D}/boot/mcp-transport.js`);
  const { buildToolCandidates } = await import(`${D}/capabilities/index.js`);
  const { setToolCandidates } = await import(`${D}/mcp/mcp-surface.js`);
  const { appCapabilities } = await import(`${D}/capabilities/apps.js`);
  const { upsertMember } = await import(`${D}/org/store/members.js`);
  const { mintToken } = await import(`${D}/org/store/tokens.js`);
  const oauth = await import(`${D}/org/store/oauth.js`);
  const { registerServerExecutor } = await import(`${D}/apps/app-mcp-server-executor.js`);
  const { appMcpExecutorKinds } = await import(`${D}/apps/app-mcp-executors.js`);
  const callSvc = await import(`${D}/apps/app-server-call.js`);
  const cs = await import(`${D}/apps/app-server-call-store.js`);
  const { callCredential, parseCallCredential } = await import(`${D}/apps/app-server-call-plan.js`);
  const { mintAppServerFunctionToken, resolveAppServerPrincipal } = await import(`${D}/apps/app-server-auth.js`);
  const { jobCallerOf } = await import(`${D}/apps/app-jobs.js`);
  const { registerAppJobRoutes } = await import(`${D}/apps/app-jobs-routes.js`);
  const { GUARD_JS } = await import(`${D}/apps/app-server-guard.js`);
  const { HTTP_INTEGRATION_CT } = await import(`${D}/apps/app-server-stream.js`);
  const { acquireInflight, inflightNow, resetInflightForTest } = await import(`${D}/apps/app-server-usage.js`);
  const { resolveJobRunPrincipal, startAppJob } = await import(`${D}/apps/app-jobs.js`);
  const { appServerPolicy } = await import(`${D}/apps/app-server-store.js`);
  const { setAppServerPolicy } = await import(`${D}/apps/app-server-store.js`);
  const { AwsError } = await import(`${D}/net/aws/aws-json.js`);
  const { SINGLE_TENANT_ID } = await import(`${D}/db/tenant-column.js`);
  setToolCandidates(buildToolCandidates());   // 부팅(index.ts)과 같게 — 빌트인 이름 충돌 검사가 실제 표면을 본다
  const offServer = registerServerExecutor();   // 부팅(index.ts)과 같게
  chk("G0 배선 — 워크스페이스 A 는 기본 워크스페이스 자리 · 정책 자식 프로세스가 정책을 걸었다 · server 실행기가 등록됐다",
    TA === SINGLE_TENANT_ID && Number(policies?.tables) > 0 && appMcpExecutorKinds().includes("server"), J({ SINGLE_TENANT_ID, policies, kinds: appMcpExecutorKinds() }));
  const role = (await itemsPool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
  const callRel = (await dbc.query(`SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE relname='org_app_call' AND relkind='r'`)).rows[0];
  const callPols = (await dbc.query(`SELECT polname FROM pg_policy WHERE polrelid='org_app_call'::regclass`)).rows.map((r) => r.polname);
  chk("G1 앱 역할은 슈퍼유저 · BYPASSRLS 가 아니고, 새 표 org_app_call 에도 FORCE RLS · tenant_isolation 이 자동으로 걸렸다",
    role?.rolsuper === false && role?.rolbypassrls === false && callRel?.on === true && callRel?.forced === true && callPols.includes("tenant_isolation"), J({ role, callRel, callPols }));

  // ── 게이트웨이 — 실제 /mcp · 검사 층 콜백(claim) · 앱 서버 문(능력 REST 와 같은 sessionOrBearer appServer) ──
  const verifier = new BearerVerifier();
  const gw = express();
  gw.use(express.json({ limit: "1mb" }));
  registerAppJobRoutes(gw, verifier);
  const whoSeen = [];
  gw.get("/api/test/whoami", sessionOrBearer(verifier, { appServer: true }), (req, res) => { const u = req.auth?.extra; whoSeen.push(u); res.json(u); });
  //  앱 코드가 작업을 시작하는 문(SDK livelyJobs().start · POST /api/ui/app-jobs 와 같은 startAppJob) — 가짜 함수 실행면(jobDeps)으로.
  let spawnDeps = null;
  gw.post("/api/test/app-jobs", sessionOrBearer(verifier, { appServer: true }), async (req, res) => {
    try { res.json(await startAppJob(req.body, req.auth?.extra, {}, spawnDeps)); } catch (e) { res.status(e?.status ?? 500).json({ message: String(e?.message ?? e) }); }
  });
  registerMcpTransport(gw, bearerWithResourceMetadata(verifier));
  gwServer = http.createServer(gw);
  await new Promise((r) => gwServer.listen(0, "127.0.0.1", r));
  const GW = `http://127.0.0.1:${gwServer.address().port}`;
  process.env.PUBLIC_URL = GW;
  resetResourceIdCache();

  // ── 사람 · 토큰 ──
  const MEMBER_SCOPES = ["items", "context", "memory"];
  for (const [id, nm, sc] of [["alice", "앨리스", MEMBER_SCOPES], ["bob", "밥", MEMBER_SCOPES], ["dana", "다나", MEMBER_SCOPES], ["carol", "캐럴", MEMBER_SCOPES],
    ["boss", "관리자", [...MEMBER_SCOPES, "admin"]]]) {
    await upsertMember({ id, display_name: nm, state: "active", scopes: sc }, "pgt");
  }
  const CID = "pgt-mcp-client-5053", REDIR = "https://client.invalid/cb";
  await oauth.saveClient({ clientId: CID, kind: "static", clientName: "시험 커넥터", redirectUris: [REDIR] });
  const oauthToken = async (member) => {
    const rid = await oauth.createAuthRequest({ clientId: CID, redirectUri: REDIR, codeChallenge: "x".repeat(43), scopes: [], state: "s", resource: `${GW}/mcp` });
    const g = await oauth.approveAuthRequest(rid, member);
    if (!g) throw new Error(`OAuth 승인 실패(${member})`);
    const r = await oauth.redeemAuthCode({ clientId: CID, code: g.code, redirectUri: REDIR, resource: `${GW}/mcp` });
    if (!r?.accessToken) throw new Error(`OAuth 코드 교환 실패(${member})`);
    return r.accessToken;
  };
  const tok = { alice: await oauthToken("alice"), bob: await oauthToken("bob"), dana: await oauthToken("dana") };
  tok.carol = (await mintToken({ userId: "carol", memberId: "carol", scopes: ["memory"] }, "pgt")).token;   // 좁은 토큰 — memory 하나
  const mcp = async (t) => {
    const c = new Client({ name: "pgt", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${GW}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
    return {
      list: async () => (await c.listTools()).tools,
      call: async (name, args = {}) => { try { return await c.callTool({ name, arguments: args }); } catch (e) { return { thrown: String(e?.message ?? e) }; } },
      //  진행 알림을 받겠다고 하고 부른다(SDK 가 progressToken 을 싣는다 · 진행이 오면 기다림을 늘린다).
      callWithProgress: async (name, args, onprogress) => {
        try { return await c.callTool({ name, arguments: args }, undefined, { onprogress, timeout: 120_000, resetTimeoutOnProgress: true }); } catch (e) { return { thrown: String(e?.message ?? e) }; }
      },
      close: () => c.close().catch(() => undefined),
    };
  };
  const textOf = (r) => (r?.content ?? []).map((b) => b.text ?? "").join("");
  const codeOf = (r) => r?._meta?.["lively/code"];

  // ── 앱 — 실제 설치 능력. 서버를 선언한 판(web.server) · server 도구 여럿 ──
  const cap = (n) => appCapabilities.find((c) => c.name === n);
  const ctx = { source: "mcp" };
  const P = (id, admin = false) => ({ userId: id, email: `${id}@x.invalid`, scopes: admin ? [...MEMBER_SCOPES, "admin"] : MEMBER_SCOPES });
  //  동의는 앱이 선언한 권한(permissions)의 부분집합만 준다 — memory · items 를 선언해 둔다(돌기 신원의 권한 = 토큰 ∩ 동의 ∩ 구성원을 보려고).
  const files = (id, title, tools) => [{ path: "lively-app.json", content: J({ id, title, version: "0.1.0", permissions: { scopes: ["memory", "items"] }, web: { server: true }, mcp_tools: tools }) }];
  const S = (name, route, o = {}) => ({ name, description: `${name} — 앱이 쓴 설명`, level: "L0", run: { kind: "server", route }, ...o });
  const WIKI = [
    S("ask_policy", "POST /api/tools/ask?src=mcp", { input: { type: "object", properties: { q: { type: "string", description: "물을 말" }, n: { type: "integer" } }, required: ["q"] } }),
    S("big_answer", "/api/tools/big"), S("slow_tool", "/api/tools/slow"), S("fail_tool", "/api/tools/fail"), S("png_tool", "/api/tools/png"),
    S("after_tool", "/api/tools/after"), S("propose_tool", "/api/tools/ask", { level: "L1" }),
    S("ask_bg", "POST /api/tools/ask", { level: "L1", input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, run: { kind: "server", route: "POST /api/tools/ask", background: true } }),
    S("slow_bg", "/api/tools/slow", { level: "L1", run: { kind: "server", route: "/api/tools/slow", background: true } }),
    S("fail_bg", "/api/tools/fail", { level: "L1", run: { kind: "server", route: "/api/tools/fail", background: true } }),
    S("spawn_tool", "/api/tools/spawn", { level: "L1" }),
    S("spawn_bg", "/api/tools/spawn", { level: "L1", run: { kind: "server", route: "/api/tools/spawn", background: true } }),
  ];
  const badInstall = await errOf(cap("org_app_install").handler({ source: { kind: "inline", files: [{ path: "lively-app.json", content: J({ id: "nosrv", title: "서버 없음", version: "0.1.0", mcp_tools: [S("x_q", "/x")] }) }] } }, P("boss", true), ctx));
  chk("B3 설치 — 서버를 선언하지 않은 판의 server 도구는 400(자리와 까닭)", badInstall?.status === 400 && /\[mcp_tools\.0\]/.test(badInstall.message) && /web\.server/.test(badInstall.message), String(badInstall?.message));
  await cap("org_app_install").handler({ source: { kind: "inline", files: files("wiki", "정책 위키", WIKI) } }, P("boss", true), ctx);
  await cap("org_app_install").handler({ source: { kind: "inline", files: files("other", "다른 앱", [S("other_q", "/q")]) } }, P("boss", true), ctx);
  //  다나가 초안을 고친다 — 초안에만 있는 도구(draft_only) · 같은 도구(ask_policy)는 다나에게 초안 판(cur)으로.
  await cap("app_save").handler({ files: files("wiki", "정책 위키(고치는 중)", [...WIKI, S("draft_only", "/api/tools/ask")]) }, P("dana"), ctx);
  for (const m of ["alice", "dana", "carol"]) await cap("me_app_grant").handler({ app_id: "wiki" }, P(m), ctx);
  const wikiRow = (await itemsPool.query(`SELECT visibility, draft_by, published_version_no FROM org_app WHERE id='wiki'`)).rows[0];
  chk("E0 배선 — wiki 는 공개 앱에 다나의 초안이 걸렸다", wikiRow?.visibility === "all" && wikiRow?.draft_by === "dana" && wikiRow?.published_version_no != null, J(wikiRow));

  // ── 함수 자리 — 판 cur 7 · pub 6 · 함수에 구운 앱 서버 토큰 · 검사 층 5 판(배포가 적는 칸) ──
  const fn = await mintAppServerFunctionToken("wiki", "pgt");
  const otherFn = await mintAppServerFunctionToken("other", "pgt");
  await itemsPool.query(`INSERT INTO org_app_server(app_id, function_name, cur_lambda_version, cur_token_hash, cur_guard, pub_lambda_version, pub_token_hash, pub_guard)
     VALUES('wiki','lvly-app-wiki-ws','7',$1,5,'6',$1,5)`, [fn.tokenHash]);
  const setSrv = (sql, p = []) => itemsPool.query(`UPDATE org_app_server SET ${sql} WHERE app_id='wiki'`, p);
  const SRV_OK = `cur_lambda_version='7', pub_lambda_version='6', cur_token_hash='${fn.tokenHash}', pub_token_hash='${fn.tokenHash}', cur_guard=5, pub_guard=5, stopped_at=NULL, stop_reason=NULL`;

  // ── 가짜 앱 — 받은 것을 적고, 받은 돌기 신원으로 앱 서버 문을 다시 부른다 ──
  const appSeen = [];
  const late = [];
  const appPort = await freePort();
  const callBack = async (identity) => {
    const r = await fetch(`${GW}/api/test/whoami`, { headers: { authorization: `Bearer ${fn.token}`, "x-lively-identity": identity } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  appServer = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const u = new URL(req.url ?? "/", "http://x");
      appSeen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const id = String(req.headers["x-lively-identity"] ?? "");
      if (u.pathname === "/api/tools/ask") {
        const me = await callBack(id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(J({ answer: "연차는 15일", got: body ? JSON.parse(body) : null, query: u.search, me }));
        return;
      }
      if (u.pathname === "/api/tools/spawn") {
        //  받은 돌기 신원으로 작업 하나를 시작하고(그 작업은 /api/tools/ask — 작업 돌기 신원으로 whoami) 끝날 때까지 기다려 그대로 돌려준다.
        const r = await fetch(`${GW}/api/test/app-jobs`, { method: "POST", headers: { authorization: `Bearer ${fn.token}`, "x-lively-identity": id, "content-type": "application/json" },
          body: J({ route: "/api/tools/ask", body: { q: "자식" }, wait: 10 }) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(J({ child: { status: r.status, body: await r.json().catch(() => null) } }));
        return;
      }
      if (u.pathname === "/api/tools/big") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end("가".repeat(100_000)); return; }   // 300,000바이트
      if (u.pathname === "/api/tools/slow") { await sleep(4500); if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); } return; }
      if (u.pathname === "/api/tools/fail") { res.writeHead(404, { "content-type": "application/json" }); res.end(J({ message: "그런 정책은 없습니다" })); return; }
      if (u.pathname === "/api/tools/png") { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); return; }
      if (u.pathname === "/api/tools/after") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(J({ ok: true }));
        //  답한 «뒤» 에 같은 돌기 신원으로 다시 부른다 — 게이트웨이가 답을 다 받았으면 막혀야 한다.
        setTimeout(() => { callBack(id).then((x) => late.push(x), (e) => late.push({ status: -1, err: String(e) })); }, 400);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => appServer.listen(appPort, "127.0.0.1", r));

  // ── 진짜 검사 층 — 공개 키 없이(claim 길은 키를 쓰지 않는다 · #5052 ① (나)) ──
  const guardPort = await freePort();
  guard = spawn(process.execPath, ["-e", GUARD_JS], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { PATH: process.env.PATH ?? "", PORT: String(appPort), LIVELY_GUARD_PORT: String(guardPort), LIVELY_TENANT_ID: TA, LIVELY_APP_ID: "wiki",
      LIVELY_API_URL: GW, LIVELY_APP_TOKEN: fn.token, LIVELY_REQUEST_TIMEOUT_S: "30", LIVELY_APP_IDENTITY_PUBKEYS: "" },
  });
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise((r) => { const s = net.connect(guardPort, "127.0.0.1"); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
    if (ok) break;
    await sleep(25);
  }

  // ── 가짜 Lambda — 웹 어댑터 몫(이벤트 → 검사 층으로 HTTP · 답 → HTTP 통합 흐름)만 ──
  const invokes = [];
  let lambdaMode = "ok";
  const toGuard = (ev) => new Promise((resolve, reject) => {
    const body = ev.body ? Buffer.from(ev.body, ev.isBase64Encoded ? "base64" : "utf8") : Buffer.alloc(0);
    const path = ev.rawPath + (ev.rawQueryString ? `?${ev.rawQueryString}` : "");
    const r = http.request({ host: "127.0.0.1", port: guardPort, method: ev.requestContext.http.method, path, headers: { ...ev.headers, "content-length": String(body.length) }, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, chunks }));
      res.on("error", reject);
    });
    r.on("error", reject);
    r.end(body);
  });
  const streamOf = (g) => {
    const headers = {};
    for (const [k, v] of Object.entries(g.headers)) if (k !== "transfer-encoding" && k !== "connection" && k !== "keep-alive") headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    const prelude = Buffer.concat([Buffer.from(J({ statusCode: g.statusCode, headers, cookies: [] }), "utf8"), Buffer.alloc(8)]);
    return {
      status: 200, executedVersion: "x", contentType: HTTP_INTEGRATION_CT,
      events: (async function* () {
        yield { type: "chunk", data: prelude };
        for (const c of g.chunks) yield { type: "chunk", data: c };
        yield { type: "complete", errorCode: null, errorDetails: null, log: "START\nREPORT RequestId: r1\tDuration: 12.00 ms\tBilled Duration: 13 ms\tMemory Size: 512 MB\n" };
      })(),
    };
  };
  const fakeApi = {
    invokeStream: async (name, qualifier, payloadJson) => {
      const ev = JSON.parse(payloadJson);
      invokes.push({ name, qualifier, ev });
      if (lambdaMode === "throttle") throw new AwsError(429, "TooManyRequestsException", "Rate exceeded");
      if (lambdaMode === "timeout") throw new AwsError(0, "Timeout", "lambda 시간 초과");
      //  이벤트가 claim 창(60초)이 지나 함수에 닿았다 — 검사 층이 게이트웨이의 409 expired 를 받아 앱에 닿기 전에 거절한다(E5g).
      if (lambdaMode === "late") await itemsPool.query(`UPDATE org_app_call SET created_at = now() - interval '61 seconds' WHERE id=$1`, [parseCallCredential(ev.headers["x-lively-identity"])?.id]);
      //  흐름이 첫 조각에서 깨진다 — 게이트웨이 쪽 뜻밖의 예외(E7b).
      if (lambdaMode === "boom") return { status: 200, executedVersion: "x", contentType: HTTP_INTEGRATION_CT, events: (async function* () { throw new Error("흐름이 깨졌다(시험)"); })() };
      return streamOf(await toGuard(ev));
    },
  };
  const records = [];
  const FAKE_ENV = { host: "lambda", region: "ap-northeast-2", execRoleArn: "arn:aws:iam::111122223333:role/lvly-app-exec", awsAccountId: "111122223333", layerArn: "x", prefix: "lvly-app-", runtime: "nodejs22.x", arch: "arm64", codeStorage: "REFERENCE" };
  let envOn = true;
  //  백그라운드 작업 — 비동기 부르기는 받아 두고(202) 따로 돈다: 이벤트를 진짜 검사 층에 넘기고(작업 길: claim · 앱 · 결과 보고) 기다리지 않는다.
  const asyncInvokes = [];
  const jobDeps = {
    policy: () => appServerPolicy(),
    env: () => (envOn ? FAKE_ENV : null),
    invokeAsync: async (_env, name, qualifier, payload) => {
      asyncInvokes.push({ name, qualifier, payload });
      void toGuard(payload).catch(() => undefined);
    },
    domain: () => null,
    slug: () => "ws",
    now: () => Date.now(),
  };
  const BASE_DEPS = { env: () => (envOn ? FAKE_ENV : null), api: () => fakeApi, domain: () => null, slug: () => "ws", record: (appId, r) => records.push({ appId, ...r }),
    jobDeps: () => jobDeps, bgWaitSec: 30, bgQuietWaitSec: 30, bgProgressSec: 1 };
  spawnDeps = jobDeps;
  callSvc.setServerCallDepsForTest(BASE_DEPS);
  //  id 는 BIGSERIAL — 날 쿼리에선 글자로 온다(저장 모듈은 번호로 고친다). 대조하려고 번호로.
  const callRows = async () => (await itemsPool.query(`SELECT * FROM org_app_call ORDER BY id`)).rows.map((x) => ({ ...x, id: Number(x.id) }));
  const sortedJ = (o) => J(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))));

  // ── E1 동의 없는 사람 — 부르기 전 거부(엣지 표 1) ──
  const Bb = await mcp(tok.bob);
  const r1 = await Bb.call("ask_policy", { q: "휴가" });
  chk("E1 ★ 동의 없는 사람 — consent_required + 동의 주소 · 앱 서버를 부르지 않는다(부르기 0 · 부르기 행 0)",
    r1.isError === true && codeOf(r1) === "consent_required" && /#\/app-grant\/wiki/.test(r1._meta?.["lively/consent_url"] ?? "") && invokes.length === 0 && (await callRows()).length === 0, J(r1));

  // ── E3 인자 위반 — 부르기 전 400(엣지 표 3) ──
  const A = await mcp(tok.alice);
  const r3a = await A.call("ask_policy", { n: 1 });
  const r3b = await A.call("ask_policy", { q: 123 });
  chk("E3 ★ 입력 스키마 위반(빠진 칸 · 틀린 형) — 부르기 전에 거절 · 앱 서버 호출 0 · 부르기 행 0",
    (r3a.isError === true || !!r3a.thrown) && (r3b.isError === true || !!r3b.thrown) && invokes.length === 0 && (await callRows()).length === 0, J({ r3a, r3b }));

  //  처리 중 자리 — 부르기가 어떻게 끝나든(성공 · 앱 오류 · 검사 층 거절 · 시간 넘김 · 조절 · 뜻밖의 예외) 돌려준다(E8c).
  const slots = [];
  const noteSlot = (label) => slots.push({ label, app: inflightNow("wiki").app, ws: inflightNow().workspace });

  // ── E13 · E4 · E9 · E10 · E11 — 한 줄 끝까지 ──
  const t13 = Date.now();
  const r13 = await A.call("ask_policy", { q: "휴가 규정", n: 2, extra: "버려질 칸" });
  const ms13 = Date.now() - t13;
  noteSlot("ok");
  const out13 = (() => { try { return JSON.parse(textOf(r13)); } catch { return null; } })();
  const seen13 = appSeen.at(-1);
  const inv13 = invokes.at(-1);
  chk("E13 ★ OAuth 연결(세션 머리글 없음) → server 실행기 → 진짜 검사 층(공개 키 없음) → 앱 → 결과 — 인자는 그 판의 입력으로 검사한 값 · 라우트의 쿼리 그대로",
    !r13.isError && out13?.answer === "연차는 15일" && sortedJ(out13?.got) === sortedJ({ q: "휴가 규정", n: 2 }) && out13?.query === "?src=mcp", J({ r13, ms13 }));
  const lv = seen13 ? Object.keys(seen13.headers).filter((k) => k.startsWith("x-lively-")).sort() : [];
  chk("E4 ★ 앱이 받는 머리글 = x-lively-member · x-lively-member-name · x-lively-variant · x-lively-identity(돌기 신원) — 그 밖 x-lively-* 없음(엣지 표 4)",
    seen13?.headers["x-lively-member"] === "alice" && decodeURIComponent(String(seen13?.headers["x-lively-member-name"])) === "앨리스" && seen13?.headers["x-lively-variant"] === "pub"
      && parseCallCredential(seen13?.headers["x-lively-identity"])?.kind === "run" && J(lv) === J(["x-lively-identity", "x-lively-member", "x-lively-member-name", "x-lively-variant"])
      && seen13?.method === "POST" && seen13?.url === "/api/tools/ask?src=mcp", J({ headers: seen13?.headers }));
  chk("E9a 공개 판을 보는 사람(앨리스) — 별칭 pub 의 함수를 부른다 · 이벤트의 우리 머리글은 부르기 신원 하나",
    inv13?.name === "lvly-app-wiki-ws" && inv13?.qualifier === "pub" && parseCallCredential(inv13?.ev.headers["x-lively-identity"])?.kind === "call"
      && Object.keys(inv13?.ev.headers ?? {}).filter((k) => k.startsWith("x-lively-")).length === 1, J(inv13 && { name: inv13.name, q: inv13.qualifier, h: inv13.ev.headers }));
  const me13 = out13?.me;
  chk("E10a ★ 앱이 돌기 신원으로 앱 서버 문을 다시 부르면 — 부른 사람(앨리스) ∩ 동의 · appServer · 그 앱 · 그 부르기 번호 · 주소의 판 pub",
    me13?.status === 200 && me13.body?.userId === "alice" && me13.body?.appServer === true && me13.body?.appId === "wiki" && me13.body?.appAddress === "pub"
      && Number.isSafeInteger(me13.body?.appCallId) && Array.isArray(me13.body?.scopes) && me13.body.scopes.every((s) => MEMBER_SCOPES.includes(s)), J(me13));
  chk("E11 #5081 — 그 주체는 ai-runs 가 «앱 서버의 사람 대리»(requesterOf → {member: 앨리스, kind: app_server})로 읽는 모양이다(사람 = 부른 사람 · appServer=true · 작업 번호 없음)",
    me13?.body?.userId === "alice" && me13?.body?.appServer === true && me13?.body?.appJobId === undefined, J(me13?.body));
  const row13 = (await callRows()).at(-1);
  chk("E4b 부르기 행 — done · 도구 · 부른 사람 · 이름 · 판 · 별칭 · L0 · 권한(토큰 ∩ 동의) · 200 · 인자 · 답은 적지 않는다 · 비밀은 sha256 만",
    row13?.status === "done" && row13?.tool === "ask_policy" && row13?.purpose === "mcp_tool" && row13?.requester === "alice" && row13?.requester_name === "앨리스"
      && row13?.variant === "pub" && row13?.alias === "pub" && row13?.level === "L0" && row13?.status_code === 200 && row13?.id === me13?.body?.appCallId
      && /^[0-9a-f]{64}$/.test(row13?.call_hash ?? "") && /^[0-9a-f]{64}$/.test(row13?.run_hash ?? "") && !J(row13).includes("휴가")
      && Array.isArray(row13?.scopes) && row13.scopes.includes("memory"), J(row13));
  chk("E6c 호출 셈 — 사람 요청과 같은 자리로 센다(오류 아님 · 청구 시간 = REPORT)", records.some((r) => r.appId === "wiki" && r.billedMs === 13 && r.error === false), J(records));

  // ── E10b 좁은 토큰 — 주체의 권한은 그 연결이 가진 만큼까지 ──
  const C = await mcp(tok.carol);
  const r10 = await C.call("ask_policy", { q: "x" });
  const me10 = (() => { try { return JSON.parse(textOf(r10)).me; } catch { return null; } })();
  chk("E10b 좁은 토큰(memory 하나)으로 부르면 — 앱 서버가 다시 부를 때의 주체 권한도 memory 를 넘지 않는다(구성원 · 동의가 더 넓어도)",
    !r10.isError && me10?.status === 200 && me10.body?.userId === "carol" && J(me10.body?.scopes) === J(["memory"]), J({ r10, me10 }));

  // ── E10c 답한 뒤의 호출은 막힌다 ──
  const r10c = await A.call("after_tool", {});
  for (let i = 0; i < 40 && !late.length; i++) await sleep(50);
  chk("E10c ★ 앱이 답한 «뒤» 같은 돌기 신원으로 다시 부르면 401(게이트웨이가 답을 다 받아 부르기를 끝냈다)",
    !r10c.isError && late[0]?.status === 401 && /끝난 부르기/.test(J(late[0]?.body)), J({ r10c, late }));

  // ── E2 초안 도구 · E9b 초안 판 ──
  const al = (await A.list()).map((x) => x.name);
  const Dn = await mcp(tok.dana);
  const dl = (await Dn.list()).map((x) => x.name);
  const n2 = invokes.length;
  const r2 = await Dn.call("ask_policy", { q: "초안에서" });
  const inv2 = invokes.at(-1);
  const me2 = (() => { try { return JSON.parse(textOf(r2)).me; } catch { return null; } })();
  chk("E2 ★ 초안에만 있는 server 도구는 남(앨리스)의 tools/list 에 없다 · 고친 사람(다나)에겐 있다(엣지 표 2)", al.includes("ask_policy") && !al.includes("draft_only") && dl.includes("draft_only"), J({ al: al.filter((x) => /_q|draft|ask|tool|answer/.test(x)), dl: dl.filter((x) => /draft|ask/.test(x)) }));
  chk("E9b 초안을 고친 사람 — 별칭 cur 의 함수 · 앱이 받는 판 draft · 다시 부른 주체의 주소 판 draft",
    !r2.isError && invokes.length === n2 + 1 && inv2?.qualifier === "cur" && appSeen.at(-1)?.headers["x-lively-variant"] === "draft" && me2?.body?.appAddress === "draft", J({ r2, q: inv2?.qualifier, me2 }));

  // ── E7 응답 상한(엣지 표 7) ──
  const r7 = await A.call("big_answer", {});
  const t7 = textOf(r7);
  const row7 = (await callRows()).at(-1);
  chk("E7 ★ 앱 답이 256KiB 를 넘으면 — 앞부분 + 잘림 표시 · 전체 크기(300,000바이트) · 흐름은 끝까지 읽었다(행의 bytes)",
    !r7.isError && r7._meta?.["lively/truncated"] === true && r7._meta?.["lively/bytes"] === 300000 && /잘렸습니다/.test(t7) && /전체 300000바이트/.test(t7)
      && Buffer.byteLength(t7) < 270 * 1024 && t7.startsWith("가가가") && row7?.bytes === 300000 && row7?.status === "done", J({ meta: r7._meta, len: Buffer.byteLength(t7), row: row7?.bytes }));

  // ── 앱의 오류 · 글이 아닌 답 ──
  const rf = await A.call("fail_tool", {});
  noteSlot("app-4xx");
  const rp = await A.call("png_tool", {});
  chk("E13b 앱이 4xx 로 답하면 도구 오류 app_error(앱의 글) · 그림을 보내면 app_bad_result",
    rf.isError && codeOf(rf) === "app_error" && /그런 정책은 없습니다/.test(textOf(rf)) && /HTTP 404/.test(textOf(rf)) && rp.isError && codeOf(rp) === "app_bad_result", J({ rf, rp }));

  // ── E6 시간 넘김(엣지 표 6) — 요청 시간 3초(정책) · 앱은 4.5초 ──
  await setAppServerPolicy({ timeout_s: 3 }, { actor: "pgt" });
  const t6 = Date.now();
  const r6 = await A.call("slow_tool", {});
  const ms6 = Date.now() - t6;
  noteSlot("guard-504");
  const row6 = (await callRows()).at(-1);
  chk("E6 ★ 30초(여기선 정책 3초)를 넘기면 검사 층이 끊고(504) → 도구 오류 app_server_timeout · 시간을 말한다 · 행 failed · 셈은 오류",
    r6.isError && codeOf(r6) === "app_server_timeout" && /3초/.test(textOf(r6)) && ms6 >= 2800 && ms6 < 4400 && row6?.status === "failed" && row6?.status_code === 504
      && records.at(-1)?.error === true, J({ r6, ms6, row6: row6 && { status: row6.status, code: row6.status_code, error: row6.error }, rec: records.at(-1) }));
  await setAppServerPolicy({}, { actor: "pgt" });
  lambdaMode = "timeout";
  const r6b = await A.call("ask_policy", { q: "x" });
  noteSlot("lambda-timeout");
  lambdaMode = "throttle";
  const r6c = await A.call("ask_policy", { q: "x" });
  noteSlot("throttle");
  lambdaMode = "ok";
  chk("E6b 함수 부르기 자체가 시간을 넘기면 app_server_timeout · 조절(429)이면 app_server_throttled — 둘 다 행 failed",
    codeOf(r6b) === "app_server_timeout" && codeOf(r6c) === "app_server_throttled" && (await callRows()).slice(-2).every((x) => x.status === "failed"), J({ r6b, r6c }));

  // ── E5g 검사 층이 앱에 닿기 전에 거절 · E7b 뜻밖의 예외 · E8c 자리 반납 ──
  const nSeen5g = appSeen.length;
  lambdaMode = "late";
  const r5g = await A.call("ask_policy", { q: "늦게 닿음" });
  noteSlot("guard-denied");
  const rec5g = records.at(-1);
  lambdaMode = "boom";
  const r7b = await A.call("ask_policy", { q: "깨진 흐름" });
  noteSlot("boom");
  lambdaMode = "ok";
  const [row5g, row7b] = (await callRows()).slice(-2);
  chk("E5g 함수에 늦게 닿은 이벤트(claim 409 expired) — 검사 층이 앱 전에 거절 → 도구 오류 app_server_identity · 행 failed(guard:denied · 시작 안 함) · 앱 오류로 세지 않는다",
    r5g.isError && codeOf(r5g) === "app_server_identity" && appSeen.length === nSeen5g && row5g?.status === "failed" && row5g?.error === "guard:denied"
      && row5g?.status_code === 409 && row5g?.claimed_at === null && rec5g?.error === false, J({ r5g, row5g: row5g && { s: row5g.status, e: row5g.error, c: row5g.status_code }, rec5g }));
  chk("E7b 게이트웨이 쪽 뜻밖의 예외 — 도구 오류 executor_failed(속사정 감춤) · 행 failed(gateway) · 셈은 오류",
    r7b.isError && codeOf(r7b) === "executor_failed" && !/깨졌다/.test(textOf(r7b)) && row7b?.status === "failed" && row7b?.error === "gateway" && records.at(-1)?.error === true,
    J({ r7b, row7b: row7b && { s: row7b.status, e: row7b.error } }));
  chk("E8c 처리 중 자리 — 성공 · 앱 4xx · 검사 층 504 · 함수 시간 넘김 · 조절 · 검사 층 거절 · 뜻밖의 예외 뒤 모두 돌려준다(앱 0 · 워크스페이스 0)",
    slots.length === 7 && slots.every((x) => x.app === 0 && x.ws === 0), J(slots));

  // ── E8 서버 꺼짐 · 미배포 · 옛 판 · 멈춤 · 바쁨(엣지 표 8) ──
  const e8 = [];
  const callE8 = async (label, prep, undo) => {
    await prep();
    const nInv = invokes.length, nRows = (await callRows()).length;
    const r = await A.call("ask_policy", { q: "x" });
    await undo();
    e8.push({ label, code: codeOf(r), isError: r.isError, text: textOf(r).slice(0, 80), invoked: invokes.length - nInv, rows: (await callRows()).length - nRows });
  };
  await callE8("off", async () => { envOn = false; }, async () => { envOn = true; });
  await callE8("not_deployed", () => setSrv(`pub_lambda_version=NULL`), () => setSrv(SRV_OK));
  await callE8("guard4", () => setSrv(`pub_guard=4`), () => setSrv(SRV_OK));
  await callE8("no_token", () => setSrv(`pub_token_hash=NULL`), () => setSrv(SRV_OK));
  await callE8("stopped", () => setSrv(`stopped_at=now(), stop_reason='자동 멈춤 — 5분 호출 상한'`), () => setSrv(SRV_OK));
  let held = null;
  await callE8("busy", async () => { await setAppServerPolicy({ max_inflight_app: 1 }, { actor: "pgt" }); held = acquireInflight("wiki", { workspace: 1000, app: 1 }); },
    async () => { if (typeof held === "function") held(); await setAppServerPolicy({}, { actor: "pgt" }); });
  const want8 = { off: "app_server_off", not_deployed: "app_server_not_deployed", guard4: "app_server_outdated", no_token: "app_server_outdated", stopped: "app_server_stopped", busy: "app_server_busy" };
  chk("E8 ★ 서버 꺼짐 · 미배포 · 옛 검사 층(4 판) · 토큰 없음 · 멈춤 · 바쁨 — 안내 오류(코드) · 앱 서버를 부르지 않는다 · 부르기 행 0",
    e8.length === 6 && e8.every((x) => x.isError && x.code === want8[x.label] && x.invoked === 0 && x.rows === 0) && /멈춰 있습니다/.test(e8.find((x) => x.label === "stopped")?.text ?? ""), J(e8));
  const rOk = await A.call("ask_policy", { q: "되돌린 뒤" });
  chk("E8b 되돌리면 다시 된다(시험이 남긴 상태 없음)", !rOk.isError, J(rOk));

  // ── E5 같은 부르기 비밀 두 번 · 위조 · 남의 앱 · 늦음 · 동의 철회(엣지 표 5) ──
  const nApp = appSeen.length;
  const replay = await toGuard(inv13.ev);
  const replayBody = (() => { try { return JSON.parse(Buffer.concat(replay.chunks).toString("utf8")); } catch { return null; } })();
  chk("E5 ★ 같은 부르기 비밀(같은 이벤트)을 함수에 두 번 — 검사 층이 게이트웨이 claim 409 를 받아 409 · 앱에 닿지 않는다",
    replay.statusCode === 409 && replay.headers["x-lively-guard"] === "denied" && replayBody?.error === "call_replayed" && appSeen.length === nApp, J({ s: replay.statusCode, replayBody }));
  const fnUser = (await verifier.verifyAccessToken(fn.token)).extra;
  const otherUser = (await verifier.verifyAccessToken(otherFn.token)).extra;
  const fresh = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "ask_policy", requester: "alice", requesterName: "앨리스", variant: "pub", alias: "pub", functionName: "lvly-app-wiki-ws", level: "L0", scopes: ["memory"], timeoutS: 30 });
  const forged = await errOf(callSvc.onCallClaim(fresh.row.id, jobCallerOf(fnUser), "x".repeat(43)));
  const foreign = await errOf(callSvc.onCallClaim(fresh.row.id, jobCallerOf(otherUser), fresh.secret));
  const claimed = await callSvc.onCallClaim(fresh.row.id, jobCallerOf(fnUser), fresh.secret);
  const twice = await errOf(callSvc.onCallClaim(fresh.row.id, jobCallerOf(fnUser), fresh.secret));
  chk("E5b claim — 위조 비밀 401 · 남의 앱 토큰 404 · 맞으면 돌기 신원 · 사람 · 이름 · 판 · 요청 시간 · 두 번째는 409 claimed",
    forged?.status === 401 && foreign?.status === 404 && parseCallCredential(claimed.run)?.kind === "run" && claimed.member === "alice" && claimed.member_name === "앨리스"
      && claimed.variant === "pub" && claimed.timeout_s === 30 && twice?.status === 409 && twice?.body?.reason === "claimed", J({ forged: forged?.status, foreign: foreign?.status, claimed, twice: twice?.body }));
  //  «한 번만» 은 DB 조건(status='dispatched' · 그 비밀 · 60초 창)이 정한다 — 판정 함수를 거치지 않고 저장 모듈로 두 번 넘겨 본다.
  const twin = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "t", requester: "alice", requesterName: null, variant: "pub", alias: "pub", functionName: "f", level: "L0", scopes: [], timeoutS: 30 });
  const twinHash = (await itemsPool.query(`SELECT call_hash FROM org_app_call WHERE id=$1`, [twin.row.id])).rows[0].call_hash;
  const [c1, c2] = [await cs.claimAppCall(twin.row.id, twinHash, "a".repeat(64)), await cs.claimAppCall(twin.row.id, twinHash, "b".repeat(64))];
  const twin2 = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "t", requester: "alice", requesterName: null, variant: "pub", alias: "pub", functionName: "f", level: "L0", scopes: [], timeoutS: 30 });
  const wrongHash = await cs.claimAppCall(twin2.row.id, "0".repeat(64), "c".repeat(64));
  await cs.endAppCall(twin2.row.id, { status: "failed", error: "시험" });
  chk("E5f DB 조건 — 같은 부르기를 두 번 넘기면 둘째는 null(먼저 단 돌기 신원 그대로) · 다른 비밀 지문으로는 못 넘긴다",
    c1?.status === "running" && c2 === null && (await cs.getAppCall(twin.row.id))?.run_hash === "a".repeat(64) && wrongHash === null, J({ c1: c1?.status, c2 }));
  const stale = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "ask_policy", requester: "alice", requesterName: null, variant: "pub", alias: "pub", functionName: "f", level: "L0", scopes: [], timeoutS: 30 });
  await itemsPool.query(`UPDATE org_app_call SET created_at = now() - interval '61 seconds' WHERE id=$1`, [stale.row.id]);
  const lateClaim = await errOf(callSvc.onCallClaim(stale.row.id, jobCallerOf(fnUser), stale.secret));
  chk("E5c 부른 지 60초가 넘은 부르기의 claim 은 409 expired(늦게 닿은 이벤트는 시작하지 않는다) · 경계 59초는 받는다",
    lateClaim?.status === 409 && lateClaim?.body?.reason === "expired", J(lateClaim?.body));
  const edge = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "ask_policy", requester: "alice", requesterName: null, variant: "pub", alias: "pub", functionName: "f", level: "L0", scopes: [], timeoutS: 30 });
  await itemsPool.query(`UPDATE org_app_call SET created_at = now() - interval '59 seconds' WHERE id=$1`, [edge.row.id]);
  const edgeClaim = await errOf(callSvc.onCallClaim(edge.row.id, jobCallerOf(fnUser), edge.secret));
  chk("E5d 경계 — 59초는 시작한다", edgeClaim === null, J(edgeClaim?.body ?? edgeClaim?.message));
  const gone = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "ask_policy", requester: "carol", requesterName: null, variant: "pub", alias: "pub", functionName: "f", level: "L0", scopes: [], timeoutS: 30 });
  await cap("me_app_revoke").handler({ app_id: "wiki" }, P("carol"), ctx);
  const goneClaim = await errOf(callSvc.onCallClaim(gone.row.id, jobCallerOf(fnUser), gone.secret));
  const goneRow = await cs.getAppCall(gone.row.id);
  chk("E5e 부른 뒤 claim 전에 동의를 거두면 409 requester_gone · 행 failed", goneClaim?.status === 409 && goneClaim?.body?.reason === "requester_gone" && goneRow?.status === "failed", J({ b: goneClaim?.body, s: goneRow?.status }));

  // ── E10d 돌기 신원 판정 — 직접 ──
  const run = claimed.run;
  const ok10 = await resolveAppServerPrincipal(fnUser, run);
  const asCall = await errOf(resolveAppServerPrincipal(fnUser, callCredential("call", fresh.row.id, fresh.secret)));
  const wrongApp = await errOf(resolveAppServerPrincipal(otherUser, run));
  const expired = await errOf(callSvc.resolveCallRunPrincipal(fnUser, run, Date.now() + 61_000));
  const notYet = await errOf(callSvc.resolveCallRunPrincipal(fnUser, callCredential("run", stale.row.id, "z".repeat(43))));
  chk("E10d 돌기 신원 → 주체(앨리스 · appCallId · scopes ⊆ 행의 권한) · 부르기 신원을 게이트웨이에 401 · 남의 앱 토큰 401 · 요청 시간 + 30초 지나면 401 · 틀린 비밀 401",
    ok10.userId === "alice" && ok10.appCallId === fresh.row.id && ok10.appServer === true && J(ok10.scopes) === J(["memory"])
      && asCall?.status === 401 && wrongApp?.status === 401 && expired?.status === 401 && /시간이 지난/.test(expired?.message ?? "") && notYet?.status === 401,
    J({ ok10, asCall: asCall?.message, wrongApp: wrongApp?.message, expired: expired?.message, notYet: notYet?.message }));
  await cap("me_app_revoke").handler({ app_id: "wiki" }, P("alice"), ctx);
  const revoked = await errOf(resolveAppServerPrincipal(fnUser, run));
  await cap("me_app_grant").handler({ app_id: "wiki" }, P("alice"), ctx);
  await upsertMember({ id: "alice", display_name: "앨리스", state: "inactive", scopes: MEMBER_SCOPES }, "pgt");
  const disabled = await errOf(resolveAppServerPrincipal(fnUser, run));
  await upsertMember({ id: "alice", display_name: "앨리스", state: "active", scopes: MEMBER_SCOPES }, "pgt");
  await cs.endAppCall(fresh.row.id, { status: "done" });
  const ended = await errOf(resolveAppServerPrincipal(fnUser, run));
  chk("E10e 도는 동안 동의를 거두면 403 · 떠난(비활성) 사람 403 · 부르기가 끝나면 401",
    revoked?.status === 403 && disabled?.status === 403 && ended?.status === 401, J({ revoked: revoked?.message, disabled: disabled?.message, ended: ended?.message }));
  //  도는 동안 동의 범위 · 구성원 권한이 «줄면» — 다시 부를 때마다 지금의 동의 · 구성원 권한과 다시 겹친다(행에 적힌 권한을 그대로 믿지 않는다).
  const wide = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "ask_policy", requester: "alice", requesterName: null, variant: "pub", alias: "pub", functionName: "f", level: "L0", scopes: ["memory", "items"], timeoutS: 30 });
  const wideRun = (await callSvc.onCallClaim(wide.row.id, jobCallerOf(fnUser), wide.secret)).run;
  const s0 = (await resolveAppServerPrincipal(fnUser, wideRun)).scopes;
  const g0 = (await itemsPool.query(`SELECT scopes FROM org_app_grant WHERE app_id='wiki' AND member_id='alice' AND revoked_at IS NULL`)).rows[0]?.scopes;
  await itemsPool.query(`UPDATE org_app_grant SET scopes='["memory"]'::jsonb WHERE app_id='wiki' AND member_id='alice' AND revoked_at IS NULL`);
  const sGrant = (await resolveAppServerPrincipal(fnUser, wideRun)).scopes;
  await itemsPool.query(`UPDATE org_app_grant SET scopes=$1::jsonb WHERE app_id='wiki' AND member_id='alice' AND revoked_at IS NULL`, [J(g0)]);
  await upsertMember({ id: "alice", display_name: "앨리스", state: "active", scopes: MEMBER_SCOPES.filter((x) => x !== "memory") }, "pgt");
  const sMember = (await resolveAppServerPrincipal(fnUser, wideRun)).scopes;
  await upsertMember({ id: "alice", display_name: "앨리스", state: "active", scopes: MEMBER_SCOPES }, "pgt");
  await cs.endAppCall(wide.row.id, { status: "done" });
  chk("E10f 도는 동안 동의 범위가 줄면(memory 만) 주체도 memory 만 · 구성원 권한에서 memory 가 빠지면 주체에서도 빠진다",
    J([...s0].sort()) === J(["items", "memory"]) && J(sGrant) === J(["memory"]) && J(sMember) === J(["items"]), J({ s0, g0, sGrant, sMember }));

  // ── BG 30초 넘는 도구(run.background) ──
  const jobRows = async () => (await itemsPool.query(`SELECT id, status, source, label, requester, scope_ceiling, error FROM org_app_job ORDER BY id`)).rows.map((x) => ({ ...x, id: Number(x.id) }));
  const nAsync = asyncInvokes.length;
  const rb1 = await A.call("ask_bg", { q: "긴 질문" });
  const ob1 = (() => { try { return JSON.parse(textOf(rb1)); } catch { return null; } })();
  const jb1 = (await jobRows()).at(-1);
  const seenB1 = appSeen.at(-1);
  chk("BG1 ★ background 도구 — 백그라운드 작업으로 돌고(비동기 부르기 · 진짜 검사 층의 작업 길) 게이트웨이가 기다려 답을 도구 결과로 · 작업 행 source mcp-tool · 부른 사람",
    !rb1.isError && ob1?.answer === "연차는 15일" && sortedJ(ob1?.got) === sortedJ({ q: "긴 질문" }) && asyncInvokes.length === nAsync + 1 && asyncInvokes.at(-1)?.qualifier === "6"
      && jb1?.status === "done" && jb1?.source === "mcp-tool" && jb1?.requester === "alice" && /ask_bg/.test(jb1?.label ?? "") && seenB1?.headers["x-lively-job"] === String(jb1?.id),
    J({ rb1, jb1, q: asyncInvokes.at(-1)?.qualifier, job: seenB1?.headers["x-lively-job"] }));
  chk("BG1b 작업 안의 앱이 작업 돌기 신원으로 다시 부르면 — 부른 사람(앨리스) · appServer · 그 작업 번호 · 권한은 상한(부른 연결의 권한 ∩ 동의) 안 · 작업 행에 상한이 적혔다",
    ob1?.me?.status === 200 && ob1.me.body?.userId === "alice" && ob1.me.body?.appServer === true && ob1.me.body?.appJobId === jb1?.id
      && Array.isArray(jb1?.scope_ceiling) && ob1.me.body.scopes.every((x) => jb1.scope_ceiling.includes(x)), J({ me: ob1?.me, ceiling: jb1?.scope_ceiling }));
  await cap("me_app_grant").handler({ app_id: "wiki" }, P("carol"), ctx);   // E5e 가 거둔 동의를 되돌린다
  const Cb = await mcp(tok.carol);
  const rb2 = await Cb.call("ask_bg", { q: "좁은 토큰" });
  const ob2 = (() => { try { return JSON.parse(textOf(rb2)); } catch { return null; } })();
  chk("BG2 ★ 좁은 토큰(memory 하나)으로 background 도구 — 작업의 돌기 신원도 memory 를 넘지 않는다(동기 길과 같은 상한 · 구성원 · 동의가 더 넓어도)",
    !rb2.isError && ob2?.me?.body?.userId === "carol" && J(ob2?.me?.body?.scopes) === J(["memory"]) && J((await jobRows()).at(-1)?.scope_ceiling) === J(["memory"]), J({ rb2, me: ob2?.me }));
  await Cb.close();
  const prog = [];
  const tb3 = Date.now();
  const rb3 = await A.callWithProgress("slow_bg", {}, (p) => prog.push({ ...p, at: Date.now() - tb3 }));
  chk("BG3 ★ 기다리는 동안 진행 알림(progressToken 을 실은 요청) — 1초마다 · 작업 번호와 경과 · 끝나면 결과(앱은 4.5초)",
    !rb3.isError && J(JSON.parse(textOf(rb3) || "null")) === "{}" && prog.length >= 3 && prog.every((p) => typeof p.progress === "number" && /도구의 작업 #\d+/.test(p.message ?? "")) && Date.now() - tb3 >= 4000,
    J({ rb3, prog }));
  callSvc.setServerCallDepsForTest({ ...BASE_DEPS, bgWaitSec: 2 });
  const rb4 = await A.call("slow_bg", {});
  callSvc.setServerCallDepsForTest(BASE_DEPS);
  const jobId4 = rb4._meta?.["lively/job_id"];
  chk("BG4 ★ 기다림(여기선 2초) 안에 못 끝나면 — 오류가 아니라 작업 번호 · app_job_get 안내 · _meta lively/job_id · lively/pending",
    !rb4.isError && rb4._meta?.["lively/pending"] === true && Number.isSafeInteger(jobId4) && textOf(rb4).includes(`app_job_get {"id": ${jobId4}, "wait": 25}`), J(rb4));
  const rb4b = await A.call("app_job_get", { id: jobId4, wait: 25 });
  const ob4b = (() => { try { return JSON.parse(textOf(rb4b)); } catch { return null; } })();
  chk("BG4b 안내대로 app_job_get 을 부르면 — 그 사람의 작업이라 결과까지(done · 라우트 답)", ob4b?.id === jobId4 && ob4b?.status === "done" && ob4b?.result?.status_code === 200, J(ob4b));
  //  같은 4.5초 작업 — 진행 알림을 받을 수 없는 요청(progressToken 없음)은 짧게, 실은 요청은 길게 기다린다.
  callSvc.setServerCallDepsForTest({ ...BASE_DEPS, bgWaitSec: 8, bgQuietWaitSec: 2 });
  const tq9 = Date.now();
  const rq9 = await A.call("slow_bg", {});
  const msq9 = Date.now() - tq9;
  const tp9 = Date.now();
  const rp9 = await A.callWithProgress("slow_bg", {}, () => undefined);
  const msp9 = Date.now() - tp9;
  callSvc.setServerCallDepsForTest(BASE_DEPS);
  chk("BG9 진행 알림을 받을 수 없는 요청(progressToken 없음)은 짧게(여기선 2초) 기다리고 작업 번호 — 실은 요청은 길게(여기선 8초까지) 기다려 결과",
    !rq9.isError && rq9._meta?.["lively/pending"] === true && msq9 < 4000 && !rp9.isError && rp9._meta?.["lively/pending"] !== true && J(JSON.parse(textOf(rp9) || "null")) === "{}" && msp9 >= 4000,
    J({ rq9: rq9._meta, msq9, rp9: rp9._meta, msp9 }));
  const rb5 = await A.call("fail_bg", {});
  chk("BG5 background 라우트가 4xx 로 답하면 — 도구 오류 app_error(앱의 글 · 상태) · 작업 failed",
    rb5.isError && codeOf(rb5) === "app_error" && /그런 정책은 없습니다/.test(textOf(rb5)) && /HTTP 404/.test(textOf(rb5)) && (await jobRows()).at(-1)?.status === "failed", J(rb5));
  const nJobs = (await jobRows()).length;
  await setSrv(`pub_lambda_version=NULL`);
  const rb6 = await A.call("ask_bg", { q: "x" });
  await setSrv(SRV_OK);
  chk("BG6 서버가 없으면 background 도 같은 안내 오류(app_server_not_deployed) · 작업을 만들지 않는다", rb6.isError && codeOf(rb6) === "app_server_not_deployed" && (await jobRows()).length === nJobs, J(rb6));
  await setSrv(`pub_guard=4`);
  const rb7 = await A.call("ask_bg", { q: "옛 검사 층" });
  const rs7 = await A.call("ask_policy", { q: "옛 검사 층" });
  await setSrv(SRV_OK);
  chk("BG7 검사 층 4 판 함수 — background 는 된다(작업 길은 4 판부터) · 동기 도구는 다시 올리라고 한다(5 판부터)",
    !rb7.isError && rs7.isError && codeOf(rs7) === "app_server_outdated", J({ rb7: rb7.isError ? rb7 : "ok", rs7 }));
  //  상한 칸이 비어 있는 mcp-tool 작업(있으면 안 되는 상태) — 돌기 신원에 아무 권한도 주지 않는다(닫힘).
  const { jobCredential } = await import(`${D}/apps/app-jobs-plan.js`);
  const runSecret = "Q".repeat(43);
  const runHash = crypto.createHash("sha256").update(runSecret, "utf8").digest("hex");
  const bad = (await itemsPool.query(`INSERT INTO org_app_job(app_id, requester, variant, alias, function_name, lambda_version, route, body, timeout_s, source, status, run_hash, claimed_at)
     VALUES('wiki','alice','pub','pub','lvly-app-wiki-ws','6','/x','{}',60,'mcp-tool','running',$1,now()) RETURNING id`, [runHash])).rows[0];
  const pBad = await resolveJobRunPrincipal(fnUser, jobCredential("run", Number(bad.id), runSecret));
  await itemsPool.query(`UPDATE org_app_job SET source='app-server' WHERE id=$1`, [bad.id]);
  const pOther = await resolveJobRunPrincipal(fnUser, jobCredential("run", Number(bad.id), runSecret));
  chk("BG8 상한 칸이 빈 mcp-tool 작업의 돌기 신원은 권한 0(닫힘) · 다른 작업(source 가 다름)은 종전대로 사람 ∩ 동의",
    J(pBad.scopes) === "[]" && pOther.scopes.length > 0, J({ bad: pBad.scopes, other: pOther.scopes }));
  await itemsPool.query(`UPDATE org_app_job SET status='done', ended_at=now() WHERE id=$1`, [bad.id]);

  //  상한을 물려준다 — 좁은 토큰(memory 하나)으로 부른 도구 안에서 앱이 작업을 시작해도, 그 작업(과 background 작업 안의 작업)은 memory 까지만.
  const childOf = (r) => { try { return JSON.parse(textOf(r)).child; } catch { return null; } };
  const meOf = (child) => child?.body?.result?.json?.me?.body;
  const Cc = await mcp(tok.carol);
  const rs10 = await Cc.call("spawn_tool", {});
  const rb10 = await Cc.call("spawn_bg", {});
  await Cc.close();
  const ra10 = await A.call("spawn_tool", {});
  const [cs10, cb10, ca10] = [childOf(rs10), childOf(rb10), childOf(ra10)];
  const rowOf = async (id) => (await itemsPool.query(`SELECT source, scope_ceiling, parent_id FROM org_app_job WHERE id=$1`, [id])).rows[0];
  const [js10, jb10] = [await rowOf(cs10?.body?.id), await rowOf(cb10?.body?.id)];
  chk("BG10 ★ 좁은 토큰으로 부른 도구 안에서 앱이 작업을 시작하면 — 그 작업도 memory 까지만(동기 부르기 · background 작업 안 둘 다 · 상한을 물려받고 mcp-tool 로 적힌다)",
    !rs10.isError && !rb10.isError && cs10?.body?.status === "done" && cb10?.body?.status === "done"
      && meOf(cs10)?.userId === "carol" && J(meOf(cs10)?.scopes) === J(["memory"]) && J(meOf(cb10)?.scopes) === J(["memory"])
      && js10?.source === "mcp-tool" && J(js10?.scope_ceiling) === J(["memory"]) && jb10?.source === "mcp-tool" && J(jb10?.scope_ceiling) === J(["memory"]) && jb10?.parent_id != null,
    J({ cs10: cs10?.body?.status ?? cs10, cb10: cb10?.body?.status ?? cb10, me: [meOf(cs10)?.scopes, meOf(cb10)?.scopes], js10, jb10 }));
  chk("BG10b 넓은 토큰(앨리스)이면 물려받은 상한도 넓다 — 동의 범위(memory · items) 그대로(상한이 권한을 더 깎지 않는다)",
    !ra10.isError && J([...(meOf(ca10)?.scopes ?? [])].sort()) === J(["items", "memory"]), J({ ca10: meOf(ca10) }));

  // ── E12 정비 ──
  const st1 = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "t", requester: "alice", requesterName: null, variant: "pub", alias: "pub", functionName: "f", level: "L0", scopes: [], timeoutS: 3 });
  await itemsPool.query(`UPDATE org_app_call SET status='running', claimed_at = now() - interval '40 seconds' WHERE id=$1`, [st1.row.id]);
  const st2 = await cs.insertAppCall({ appId: "wiki", purpose: "mcp_tool", tool: "t", requester: "alice", requesterName: null, variant: "pub", alias: "pub", functionName: "f", level: "L0", scopes: [], timeoutS: 30 });
  await itemsPool.query(`UPDATE org_app_call SET status='running', claimed_at = now() - interval '40 seconds' WHERE id=$1`, [st2.row.id]);
  await itemsPool.query(`UPDATE org_app_call SET ended_at = now() - interval '8 days' WHERE id=$1`, [row13.id]);
  const sw = await callSvc.sweepAppCalls();
  const after = new Map((await callRows()).map((x) => [x.id, x]));
  chk("E12 정비 — 요청 시간 + 30초가 지난 도는 줄 · 60초 넘게 시작 못 한 줄을 닫고(failed) · 아직 시간 안인 줄은 그대로 · 끝난 지 7일 지난 줄은 지운다",
    after.get(st1.row.id)?.status === "failed" && after.get(st2.row.id)?.status === "running" && after.get(stale.row.id)?.status === "failed" && !after.has(row13.id)
      && sw.expired >= 2 && sw.pruned === 1, J({ sw, st1: after.get(st1.row.id)?.status, st2: after.get(st2.row.id)?.status, stale: after.get(stale.row.id)?.status }));

  chk("G2 배선 — 가짜 Lambda 가 실제로 불렸고 · 진짜 검사 층이 실제 claim 을 불렀고 · 앱 서버 문이 실제로 주체를 풀었다",
    invokes.length >= 8 && appSeen.length >= 6 && whoSeen.length >= 3 && whoSeen.every((u) => u?.appServer === true) && asyncInvokes.length >= 5,
    J({ invokes: invokes.length, app: appSeen.length, who: whoSeen.length, async: asyncInvokes.length }));
  callSvc.setServerCallDepsForTest({});
  resetInflightForTest();
  offServer();
  for (const c of [A, Bb, C, Dn]) await c.close();
} catch (e) {
  fail++;
  console.error("FAIL 시험 도중 예외 —", e?.stack ?? e);
} finally {
  try { guard?.kill("SIGKILL"); } catch { /* 이미 끝났다 */ }
  if (appServer) await new Promise((r) => { appServer.closeAllConnections?.(); appServer.close(() => r()); });
  if (gwServer) await new Promise((r) => { gwServer.closeAllConnections?.(); gwServer.close(() => r()); });
  if (itemsPool) await itemsPool.end().catch(() => undefined);
  if (dbc) await dbc.end().catch(() => undefined);
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await su.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
  await su.end().catch(() => undefined);
}
console.log(`\napp-server-call pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
