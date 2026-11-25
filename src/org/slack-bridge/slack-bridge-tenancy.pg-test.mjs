// 슬랙 다리(#1782)의 워크스페이스 격리 PG 통합 시험 — **실제 Postgres(pgvector) 필요**(기본 npm test 체인 밖 · node scripts/run-tests.mjs --pg).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/org/slack-bridge/slack-bridge-tenancy.pg-test.mjs
//
// 왜 이 계층인가(격리 리뷰 막을 것 2): 다리의 이벤트 처리 · 상태 쓰기는 요청 밖(소켓 콜백)에서 돈다. 그 일이 맞추기를 돌던 워크스페이스로 가는지는
//  슈퍼유저 · 단일 워크스페이스로는 재지 못한다. 매니지드와 같은 조건 — 비특권 앱 역할 · ensureTenantPolicies 가 건 강제 행 보안 · 워크스페이스 둘 — 에서
//  진짜 맞추기 · 진짜 소켓 · 진짜 startAppJob 으로 돈다. 리졸버는 셀프호스트 등록부 모드처럼 «컨텍스트가 없으면 primary» 로 둔다 —
//  워크스페이스를 잃으면 오류가 아니라 primary 로 조용히 새는 쪽이라, primary 에 아무것도 안 생기는지로 그 회귀를 잡는다.
//
//  엣지 표(spec-1782 T): T1 같은 다리 id 를 두 워크스페이스가 써도 연결이 각자 하나 · T2 같은 event_id 가 둘에 와도 작업이 각자 하나(열쇠도 워크스페이스마다)
//   · T3 작업 · 열쇠 · 상태가 제 워크스페이스에만, primary 에는 없다 · T4 앱 호출은 제 워크스페이스의 다리 설정으로(남의 다리 채널로는 못 부른다)
//   · T5 한쪽 다리를 지워도 다른 쪽은 산다 · T6 한 워크스페이스의 맞추기가 오래 안 온 다른 워크스페이스(매니지드의 멈춘 워크스페이스)의 연결을 내리지 않는다.
import pg from "pg";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { WebSocketServer } from "ws";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_slack_bridge_rls_1782";
const ROLE = `lvly_app_${DB}`;            // org/tenancy/activate.ts appRoleName(current_database()) 과 같은 이름 — 정책이 이 역할에 걸린다
const ROLE_PW = "pgt-slackbridge";
const dsnFor = (db, role) => { const u = new URL(BASE); u.pathname = "/" + db; if (role) { u.username = role.name; u.password = role.pw; } return u.toString(); };
const D = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const J = JSON.stringify;
const TA = { id: "aaaaaaaa-1782-4000-8000-00000000000a", slug: "wa" };
const TB = { id: "bbbbbbbb-1782-4000-8000-00000000000b", slug: "wb" };

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 4000, what = "조건") => {
  const end = Date.now() + ms;
  for (;;) { if (await cond()) return true; if (Date.now() > end) throw new Error(`기다림 초과 — ${what}`); await sleep(20); }
};
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

// 토큰(가짜) — 조각으로 이어 만든다(secret-scan 의 slack 룰).
const tok = (...p) => p.join("-");
const APP_A = tok("xapp", "1", "A111", "1111", "tenantA");
const APP_B = tok("xapp", "1", "B222", "2222", "tenantB");
const BOT = tok("xoxb", "1111", "2222", "botsecretRLS");
const APP_OF = { [APP_A]: "A111", [APP_B]: "B222" };

const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`DROP ROLE IF EXISTS ${ROLE}`);
let dbc = null, itemsPool = null, server = null, wss = null, mgr = null;
try {
  await su.query(`CREATE DATABASE ${DB}`);
  await su.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  const OWNER = dsnFor(DB);
  dbc = new pg.Client({ connectionString: OWNER }); await dbc.connect();
  await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG */ });
  const childEnv = { ...process.env, ITEMS_DATABASE_URL: OWNER };
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "LIVELY_TENANT_BINDING", "LIVELY_TENANT_ID", "EMBEDDINGS_PROVIDER"]) delete childEnv[k];
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { initAllSchemas } = await import(${J(`${D}/boot/schemas.js`)});
    await initAllSchemas({ quiet: true });
    const { ensureTenantPolicies } = await import(${J(`${D}/org/tenancy/activate.js`)});
    const r = await ensureTenantPolicies();
    const { itemsPool } = await import(${J(`${D}/db/client.js`)});
    await itemsPool.end();
    process.stdout.write("\\n@@policies " + JSON.stringify(r) + "\\n");
    process.exit(0);`], { env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 300_000 });
  const policies = JSON.parse(/^@@policies (.+)$/m.exec(out)?.[1] ?? "null");
  await dbc.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
  await dbc.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
  const owner = async (sql, params = []) => (await dbc.query(sql, params)).rows;
  const pol = await owner(`SELECT tablename FROM pg_policies WHERE policyname='tenant_isolation' AND tablename IN ('org_slack_bridge','org_slack_bridge_event','org_slack_bridge_call','org_app_job')`);
  chk("배선 — 다리 표 셋과 작업 표에 워크스페이스 정책이 걸렸다(새 표가 정책 도입부에 자동으로 잡힌다)", pol.length === 4 && policies?.tables > 0, J(pol));

  process.env.ITEMS_DATABASE_URL = dsnFor(DB, { name: ROLE, pw: ROLE_PW });
  process.env.CONNECTOR_SECRET_KEY = "1782".repeat(16);
  for (const k of ["LIVELY_APP_DDL_DATABASE_URL", "LIVELY_OWNER_DATABASE_URL", "LIVELY_APP_DB_ROLE", "LIVELY_APP_TABLE_FUSE", "EMBEDDINGS_PROVIDER",
    "LIVELY_APP_SERVER_POLICY", "LIVELY_APP_SERVER_TENANTS", "LIVELY_APP_SERVER_PREFIX", "LIVELY_APP_DOMAIN", "AWS_REGION", "LIVELY_APP_SERVER_REGION", "LIVELY_APP_SERVER_HOST"]) delete process.env[k];
  process.env.LIVELY_APP_SERVER_EXEC_ROLE = "arn:aws:iam::111122223333:role/lvly-app-exec";
  const client = await import(`${D}/db/client.js`);
  itemsPool = client.itemsPool;
  const { currentTenant, withTenant } = await import(`${D}/org/tenant-context.js`);
  const { SINGLE_TENANT_ID } = await import(`${D}/db/tenant-column.js`);
  //  등록부 모드와 같은 리졸버 — 컨텍스트를 잃으면 primary 로 간다(오류가 아니라 조용히 새는 쪽).
  client.installTenantResolver(() => currentTenant()?.id ?? SINGLE_TENANT_ID);
  const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
  const inT = (t, fn) => withTenant(t, fn);

  const { upsertApp, upsertGrant } = await import(`${D}/org/store/apps.js`);
  const { setMemberSecret, GATEWAY_OWNER } = await import(`${D}/org/credentials/member-secret-store.js`);
  const svc = await import(`${D}/apps/app-jobs.js`);
  const { appServerPolicy } = await import(`${D}/apps/app-server-store.js`);
  mgr = await import(`${D}/org/slack-bridge/manager.js`);
  const { setSlackApiForTest } = await import(`${D}/org/slack-bridge/slack-api.js`);
  const { registry } = await import(`${D}/capabilities/index.js`);
  const cap = (n) => registry.get(n);

  // ── 가짜 슬랙 ──
  const calls = [];
  const sockets = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const method = (req.url ?? "").replace(/^\/api\//, "");
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      let body = {};
      if (String(req.headers["content-type"] ?? "").includes("json")) { try { body = JSON.parse(raw || "{}"); } catch { body = {}; } }
      else body = Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, token, body });
      const outJ = (j) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      if (method === "apps.connections.open") {
        const app = APP_OF[token];
        return app ? outJ({ ok: true, url: `ws://127.0.0.1:${port}/link/?app_id=${app}` }) : outJ({ ok: false, error: "invalid_auth" });
      }
      if (token !== BOT) return outJ({ ok: false, error: "invalid_auth" });
      if (method === "auth.test") return outJ({ ok: true, user_id: "UBOT", bot_id: "BBOT", team_id: "T1", team: "시험" });
      if (method === "users.info") return outJ({ ok: true, user: { id: body.user, team_id: "T1", profile: { email: "alice@x.com" } } });
      return outJ({ ok: true, channel: body.channel, ts: "9.9" });
    });
  });
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => {
    const u = new URL(req.url ?? "/", "http://x");
    const rec = { ws, app_id: u.searchParams.get("app_id"), acks: [], closed: false };
    sockets.push(rec);
    ws.on("message", (d) => { try { const j = JSON.parse(String(d)); if (j.envelope_id) rec.acks.push(j.envelope_id); } catch { /* */ } });
    ws.on("close", () => { rec.closed = true; });
    ws.send(JSON.stringify({ type: "hello", connection_info: { app_id: rec.app_id } }));
  }));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const api = { base: `http://127.0.0.1:${port}/api`, fetch: (u, i) => fetch(u, i) };
  setSlackApiForTest(api);
  const jobDeps = {
    policy: () => appServerPolicy(),
    env: () => ({ region: "ap-northeast-2", execRoleArn: process.env.LIVELY_APP_SERVER_EXEC_ROLE, awsAccountId: "111122223333", layerArn: "x", prefix: "lvly-app-", runtime: "nodejs22.x", arch: "arm64", codeStorage: "REFERENCE" }),
    invokeAsync: async () => {}, domain: () => "lvly.test", slug: () => "ws", now: () => Date.now(),
  };
  let clockSkew = 0;
  mgr.setSlackBridgeDepsForTest({
    api, allowSocketUrl: (u) => u.startsWith(`ws://127.0.0.1:${port}/`),
    startJob: (input, user, ctx) => svc.startAppJob(input, user, ctx, jobDeps),
    readSecret: mgr.readSecretOf, now: () => Date.now() + clockSkew, holder: "pgt-rls", delayMs: () => 30,
  });

  // ── 사람(신원 전역) · 금고(신원 전역) · 워크스페이스마다 앱 · 서버 · 동의 · 다리 ──
  //  구성원 행은 매니지드처럼 워크스페이스마다 따로 둔다(공용 DB 의 테넌트 정책이 구성원 표에도 걸리는 배포 — getMember 가 지금 워크스페이스의 행만 본다).
  //   primary 에도 같은 이메일의 앨리스를 둔다 — 매핑이 워크스페이스 조건 없이 읽으면 그 행(또는 남의 워크스페이스 행)을 집는 회귀를 잡는다.
  for (const tid of [TA.id, TB.id, SINGLE_TENANT_ID]) {
    for (const [id, email, scopes] of [["alice", "alice@x.com", ["memory"]], ["boss", "boss@x.com", ["memory", "admin"]]]) {
      await owner(`INSERT INTO org_member(tenant_id, id, kind, display_name, email, state, scopes) VALUES($1,$2,'human',$2,$3,'active',$4::jsonb)`,
        [tid, tid === TB.id && id === "alice" ? "alice-b" : id, email, JSON.stringify(scopes)]);
    }
  }
  await setMemberSecret(GATEWAY_OWNER, "slack_bridge_app", "a", { secret: APP_A }, "t");
  await setMemberSecret(GATEWAY_OWNER, "slack_bridge_app", "b", { secret: APP_B }, "t");
  await setMemberSecret(GATEWAY_OWNER, "slack_bridge_bot", "x", { secret: BOT }, "t");
  const boss = { userId: "boss", email: "boss@x.com", scopes: ["memory", "admin"], projects: ["*"] };
  const CH = { [TA.id]: "C0000000AAA", [TB.id]: "C0000000BBB" };
  for (const t of [TA, TB]) {
    await inT(t, async () => {
      await upsertApp({ id: "policy", title: `정책 앱 ${t.slug}`, version: "1.0.0", manifest: { id: "policy", web: { server: {} }, permissions: { tools: ["slack_bridge_call"] } }, source: { kind: "inline" }, content_hash: `h-${t.slug}`, status: "active", enabled: true });
      await q(`INSERT INTO org_app_server(app_id, function_name, cur_lambda_version, cur_token_hash, cur_guard, pub_lambda_version, pub_token_hash, pub_guard)
               VALUES ('policy', $1, '3', $2, 4, '3', $2, 4)`, [`lvly-app-policy-${t.slug}`, `th-${t.slug}`]);
      await upsertGrant("policy", t === TB ? "alice-b" : "alice", ["memory"], ["slack_bridge_call"]);
      //  같은 다리 id(ops) — 연결 열쇠가 워크스페이스로 갈리는지(T1).
      await cap("org_slack_bridge_set").handler({ id: "ops", app_id: "policy", route: "/api/slack/event", app_token_ref: `slack_bridge_app:${t === TA ? "a" : "b"}`,
        bot_token_ref: "slack_bridge_bot:x", channels: [CH[t.id]] }, boss, {});
    });
  }

  // ── T1 연결 — 같은 다리 id 인데 워크스페이스마다 하나씩 ──
  await until(() => sockets.filter((s) => !s.closed).length === 2, 4000, "소켓 둘");
  await until(async () => (await inT(TA, async () => mgr.liveBridgeStatus("ops")?.connected)) && (await inT(TB, async () => mgr.liveBridgeStatus("ops")?.connected)), 4000, "둘 다 연결됨");
  const appA = await inT(TA, async () => mgr.liveBridgeStatus("ops")?.slack?.app_id);
  const appB = await inT(TB, async () => mgr.liveBridgeStatus("ops")?.slack?.app_id);
  chk("T1 같은 다리 id(ops)를 두 워크스페이스가 써도 연결은 각자 하나 · 제 슬랙 앱", appA === "A111" && appB === "B222" && sockets.filter((s) => !s.closed).map((s) => s.app_id).sort().join() === "A111,B222", `${appA} ${appB}`);
  chk("T1' 밖(컨텍스트 없음)에서는 어느 워크스페이스의 연결도 보이지 않는다", mgr.liveBridgeStatus("ops") === null);

  // ── T2 같은 event_id 가 두 워크스페이스에 — 작업이 각자 하나 ──
  const sockOf = (app) => sockets.filter((s) => !s.closed && s.app_id === app).at(-1);
  const ev = (channel, id = "EvSAME", ts = "100.1") => ({ envelope_id: `env-${channel}-${id}`, type: "events_api",
    payload: { token: "v", team_id: "T1", type: "event_callback", event_id: id, event: { type: "message", channel, user: "U_ALICE", text: `글 ${channel}`, ts } } });
  const send = async (app, env) => { const s = sockOf(app); s.ws.send(JSON.stringify(env)); await until(() => s.acks.includes(env.envelope_id), 4000, `ack ${env.envelope_id}`); };
  await send("A111", ev(CH[TA.id]));
  await send("B222", ev(CH[TB.id]));
  const jobsIn = (t) => inT(t, () => q(`SELECT id, requester, source, body FROM org_app_job ORDER BY id`));
  await until(async () => (await jobsIn(TA)).length === 1 && (await jobsIn(TB)).length === 1, 5000, "작업 각자 하나");
  const ja = (await jobsIn(TA))[0], jb = (await jobsIn(TB))[0];
  chk("T2 같은 event_id 가 둘에 와도 작업이 각자 하나 · 제 채널의 글",
    JSON.parse(ja.body).event.channel === CH[TA.id] && JSON.parse(jb.body).event.channel === CH[TB.id] && ja.source === "slack-bridge" && jb.source === "slack-bridge");
  chk("T2' 같은 이메일이라도 제 워크스페이스의 구성원으로 — A 는 alice · B 는 alice-b", ja.requester === "alice" && jb.requester === "alice-b", `${ja.requester} ${jb.requester}`);

  // ── T3 작업 · 열쇠 · 상태가 제 워크스페이스에만 — primary 에는 없다 ──
  await sleep(1300);   // 상태 쓰기(1초 모아 쓰기)가 지나가게
  const byTenant = async (table) => Object.fromEntries((await owner(`SELECT tenant_id::text AS t, count(*)::int AS n FROM ${table} GROUP BY 1`)).map((r) => [r.t, r.n]));
  const jobsT = await byTenant("org_app_job"), evT = await byTenant("org_slack_bridge_event"), brT = await byTenant("org_slack_bridge");
  chk("T3 작업 행 — 워크스페이스마다 하나 · primary 없음", jobsT[TA.id] === 1 && jobsT[TB.id] === 1 && !jobsT[SINGLE_TENANT_ID], J(jobsT));
  chk("T3 열쇠 행 — 워크스페이스마다(같은 event_id 가 서로 막지 않는다) · primary 없음", evT[TA.id] >= 1 && evT[TB.id] >= 1 && !evT[SINGLE_TENANT_ID], J(evT));
  chk("T3 다리 행 — primary 에 생기지 않았다", brT[TA.id] === 1 && brT[TB.id] === 1 && !brT[SINGLE_TENANT_ID], J(brT));
  const stA = (await owner(`SELECT status FROM org_slack_bridge WHERE tenant_id=$1`, [TA.id]))[0]?.status;
  const stB = (await owner(`SELECT status FROM org_slack_bridge WHERE tenant_id=$1`, [TB.id]))[0]?.status;
  chk("T3 상태 — 소켓 콜백이 적은 상태가 제 워크스페이스의 다리에(넘긴 수 · 슬랙 앱)",
    stA?.forwarded === 1 && stB?.forwarded === 1 && stA?.slack?.app_id === "A111" && stB?.slack?.app_id === "B222", J({ stA, stB }));

  // ── T4 앱 호출은 제 워크스페이스의 다리 설정으로 ──
  const srv = { userId: "alice-b", email: "", scopes: ["memory"], projects: ["*"], appId: "policy", appServer: true, appAddress: "pub" };
  const okB = await inT(TB, () => cap("slack_bridge_call").handler({ bridge: "ops", method: "chat.postMessage", args: { channel: CH[TB.id], text: "B 답" } }, srv));
  const crossB = await inT(TB, () => errOf(cap("slack_bridge_call").handler({ bridge: "ops", method: "chat.postMessage", args: { channel: CH[TA.id], text: "A 채널로" } }, srv)));
  chk("T4 B 의 앱은 B 다리(B 채널)로 답한다 · A 다리의 채널로는 못 부른다(403)", okB.ok === true && crossB?.status === 403, String(crossB?.message));
  const logT = await byTenant("org_slack_bridge_call");
  chk("T4 호출 기록도 제 워크스페이스에 · primary 없음", logT[TB.id] === 1 && !logT[TA.id] && !logT[SINGLE_TENANT_ID], J(logT));

  // ── T5 한쪽 다리를 지워도 다른 쪽은 산다 ──
  await inT(TA, () => cap("org_slack_bridge_remove").handler({ id: "ops" }, boss, {}));
  await until(() => sockets.filter((s) => s.app_id === "A111").every((s) => s.closed), 3000, "A 연결 내림");
  await send("B222", ev(CH[TB.id], "EvAFTER", "200.2"));
  await until(async () => (await jobsIn(TB)).length === 2, 4000, "B 둘째 작업");
  chk("T5 A 를 지워도 B 연결은 살고 넘긴다", (await inT(TB, async () => mgr.liveBridgeStatus("ops")?.connected)) === true && (await jobsIn(TA)).length === 1);

  // ── T6 매니지드의 멈춘 워크스페이스 — 맞추기가 오래 안 와도 다른 워크스페이스의 맞추기가 그 연결을 내리지 않는다(슬랙으로는 계속 쓰인다) ──
  await inT(TA, () => cap("org_slack_bridge_set").handler({ id: "ops", app_id: "policy", route: "/api/slack/event", app_token_ref: "slack_bridge_app:a", bot_token_ref: "slack_bridge_bot:x", channels: [CH[TA.id]] }, boss, {}));
  await until(() => sockets.some((s) => s.app_id === "A111" && !s.closed), 3000, "A 다시 연결");
  clockSkew = 6 * 60 * 60_000;    // B 만 계속 맞추고 A 는 6시간 동안 맞추기가 오지 않았다(CP 틱은 깨어 있는 워크스페이스에만)
  for (let i = 0; i < 3; i++) await inT(TB, () => mgr.reconcileSlackBridges());
  await sleep(150);
  chk("T6 B 의 맞추기는 A 의 연결을 건드리지 않는다", sockets.some((s) => s.app_id === "A111" && !s.closed)
    && (await inT(TA, async () => mgr.liveBridgeStatus("ops")?.connected)) === true);
  const beforeA = (await jobsIn(TA)).length;
  await send("A111", ev(CH[TA.id], "EvQUIET", "300.3"));
  await until(async () => (await jobsIn(TA)).length === beforeA + 1, 4000, "멈춘 A 의 이벤트");
  chk("T6' 맞추기가 오지 않는 동안에도 A 에 온 슬랙 글은 A 의 작업이 된다", true);
  clockSkew = 0;
} catch (e) {
  fail++;
  console.error("FAIL (예외)", e);
  //  진단 — 실패한 자리의 다리 상태 · 열쇠 결과(워크스페이스별, 소유자 연결로).
  try {
    console.error("진단 org_slack_bridge:", JSON.stringify((await dbc.query(`SELECT tenant_id, id, status FROM org_slack_bridge`)).rows));
    console.error("진단 org_slack_bridge_event:", JSON.stringify((await dbc.query(`SELECT tenant_id, bridge_id, event_key, outcome FROM org_slack_bridge_event`)).rows));
  } catch (d) { console.error("진단 실패", d); }
} finally {
  try { mgr?.stopAllSlackBridges(); mgr?.setSlackBridgeDepsForTest(null); } catch { /* */ }
  for (const s of wss?.clients ?? []) s.terminate();
  if (server) await new Promise((ok) => server.close(ok));
  await itemsPool?.end().catch(() => {});
  await dbc?.end().catch(() => {});
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
