// 슬랙 다리(#1782) PG 통합 시험 — **실제 Postgres 필요**(기본 npm test 체인 밖 · node scripts/run-tests.mjs --pg).
//    npm run build && ITEMS_DATABASE_URL=postgres://postgres:test@localhost:5432/lively_test node src/org/slack-bridge/slack-bridge.pg-test.mjs
//
// 왜 이 계층인가: 한 번만 넘기기(열쇠 UNIQUE) · 신원 매핑(person_identity · 금고 · 이메일) · 동의 · 작업 행의 source/automation · 호출 기록 · 토큰이 어디에도
//  안 남는다는 약속은 전부 DB 의 사실이다. 슬랙은 가짜(로컬 HTTP + 소켓 모드 ws 서버)고, 다리는 진짜 맞추기 · 진짜 소켓 · 진짜 startAppJob(가짜 Lambda)으로 돈다.
//  엣지 표 N6 · N7 · I1~I11 · D1 · D5~D10 · K1~K6 · A-h · S1 (spec-1782) · I12 · I13 예전 범위 동의(#1644) · RW1~RW5 롤 창(run_as_human 칸이 아직 없을 때).
import "../../../scripts/test-apps-root.mjs";
import pg from "pg";
import http from "node:http";
import { WebSocketServer } from "ws";

const BASE = process.env.ITEMS_DATABASE_URL;
if (!BASE) { console.error("ITEMS_DATABASE_URL(슈퍼유저 DSN)이 필요합니다"); process.exit(2); }
const DB = "lively_pgt_slack_bridge_1782";
const dsnFor = (db) => { const u = new URL(BASE); u.pathname = "/" + db; return u.toString(); };
const su = new pg.Client({ connectionString: BASE }); await su.connect();
await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await su.query(`CREATE DATABASE ${DB}`);
const dbc = new pg.Client({ connectionString: dsnFor(DB) }); await dbc.connect();
await dbc.query("CREATE EXTENSION IF NOT EXISTS vector").catch(() => { /* pgvector 없는 로컬 PG */ });
process.env.ITEMS_DATABASE_URL = dsnFor(DB);
process.env.CONNECTOR_SECRET_KEY = "1782".repeat(16);
for (const k of ["LIVELY_APP_SERVER_POLICY", "LIVELY_APP_SERVER_TENANTS", "LIVELY_APP_SERVER_PREFIX", "LIVELY_APP_DOMAIN", "AWS_REGION", "LIVELY_APP_SERVER_REGION", "LIVELY_APP_SERVER_HOST"]) delete process.env[k];
process.env.LIVELY_APP_SERVER_EXEC_ROLE = "arn:aws:iam::111122223333:role/lvly-app-exec";
const D = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${D}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${D}/db/client.js`);
const { upsertApp, upsertGrant } = await import(`${D}/org/store/apps.js`);
const { setMemberSecret, GATEWAY_OWNER, memberOwner } = await import(`${D}/org/credentials/member-secret-store.js`);
const svc = await import(`${D}/apps/app-jobs.js`);
const js = await import(`${D}/apps/app-jobs-store.js`);
const { appServerPolicy } = await import(`${D}/apps/app-server-store.js`);
const mgr = await import(`${D}/org/slack-bridge/manager.js`);
const store = await import(`${D}/org/slack-bridge/store.js`);
const { setSlackApiForTest } = await import(`${D}/org/slack-bridge/slack-api.js`);
const { registry } = await import(`${D}/capabilities/index.js`);

let pass = 0, fail = 0;
const chk = (n, c, why = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why}`); } };
const q = async (sql, params = []) => (await itemsPool.query(sql, params)).rows;
const errOf = async (p) => { try { await p; return null; } catch (e) { return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 4000, what = "조건") => {
  const end = Date.now() + ms;
  for (;;) { if (await cond()) return true; if (Date.now() > end) throw new Error(`기다림 초과 — ${what}`); await sleep(20); }
};

// ── 토큰(가짜) — 시험 끝에 DB · 응답 어디에도 없는지 본다. 조각으로 이어 만든다(토큰 꼴 리터럴을 남기지 않는다 — secret-scan 의 slack 룰) ──
const tok = (...p) => p.join("-");
const APP_TOK = tok("xapp", "1", "A777", "1111", "appsecretAAAA");
const APP_TOK2 = tok("xapp", "1", "A777", "2222", "appsecretROTATED");
const APP_TOK_RATE = tok("xapp", "1", "A888", "3333", "appsecretRATE");
const BOT_TOK = tok("xoxb", "1111", "2222", "botsecretBBBB");
const BOT_TOK_BAD = tok("xoxb", "9999", "9999", "revokedCCCC");
const DAVE_TOK = tok("xoxp", "dave", "user");          // [Slack 연결] 한 사람의 유저 토큰(가짜) — auth.test 가 U_DAVE 를 돌려준다
const MALLORY_TOK = tok("xoxp", "mallory", "user");    // 위조자의 진짜(가짜 슬랙에서) 유저 토큰 — auth.test 가 U_MALLORY 를 돌려준다
const ALL_TOKENS = [APP_TOK, APP_TOK2, APP_TOK_RATE, BOT_TOK, BOT_TOK_BAD, DAVE_TOK, MALLORY_TOK];
const USER_TOKENS = { [DAVE_TOK]: "U_DAVE", [MALLORY_TOK]: "U_MALLORY" };

// ── 가짜 슬랙 — Web API(POST /api/<메서드>) + 소켓 모드(ws /link) ──
const calls = [];          // { method, token, body }
const sockets = [];        // { ws, app_id, ticket, acks[], closed }
const SLACK_USERS = {
  U_ALICE: { email: "alice@x.com" }, U_BOB: { email: "bob@x.com" }, U_NOMAP: { email: "stranger@x.com" },
  U_GONE: { email: "alice@x.com", deleted: true }, U_NOMAIL: {}, U_PROP: {},
};
const APP_OF_TOKEN = { [APP_TOK]: "A777", [APP_TOK2]: "A777", [APP_TOK_RATE]: "A888" };
let ticket = 0;
// 가짜 슬랙 파일(slack_bridge_file) — files.info 가 주는 정보와 파일 서버(GET /files-pri/…)가 주는 바이트.
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fileUrl = (id, name) => `http://127.0.0.1:${port}/files-pri/T1-${id}/${name}`;
const SLACK_FILES = {
  F0PNG00001: { name: "bc_답변.png", mimetype: "image/png", filetype: "png", size: PNG_1PX.length, channels: ["C0000000001"], bytes: PNG_1PX, type: "image/png" },
  F0TXT00001: { name: "메모.txt", mimetype: "text/plain", filetype: "text", size: 12, shares: { public: { C0000000002: [{ ts: "1.1" }] } }, bytes: Buffer.from("한도 4억 원"), type: "text/plain" },
  F0PDF00001: { name: "신청서.pdf", mimetype: "application/pdf", filetype: "pdf", size: 5000, channels: ["C0000000001"], bytes: Buffer.from("%PDF"), type: "application/pdf" },
  F0OUT00001: { name: "남의채널.png", mimetype: "image/png", filetype: "png", size: PNG_1PX.length, channels: ["C0000000009"], bytes: PNG_1PX, type: "image/png" },
  F0LOGIN001: { name: "로그인.png", mimetype: "image/png", filetype: "png", size: PNG_1PX.length, channels: ["C0000000001"], redirect: true },
};
const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url ?? "").startsWith("/files-pri/")) {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const id = /^\/files-pri\/T1-(F[A-Z0-9]+)\//.exec(req.url)?.[1] ?? "";
    calls.push({ method: "file.download", token, body: { file: id } });
    const f = SLACK_FILES[id];
    //  슬랙은 권한이 없으면 로그인 화면으로 넘긴다.
    if (!f || token !== BOT_TOK || f.redirect) { res.writeHead(302, { location: "https://slack.com/?redir=x" }); return res.end(); }
    res.writeHead(200, { "content-type": f.type }); return res.end(f.bytes);
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const method = (req.url ?? "").replace(/^\/api\//, "");
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    let body = {};
    if (String(req.headers["content-type"] ?? "").includes("json")) { try { body = JSON.parse(raw || "{}"); } catch { body = {}; } }
    else body = Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, token, body });
    const out = (j) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (method === "apps.connections.open") {
      const app = APP_OF_TOKEN[token];
      if (!app) return out({ ok: false, error: "invalid_auth" });
      ticket++;
      return out({ ok: true, url: `ws://127.0.0.1:${port}/link/?ticket=${ticket}&app_id=${app}` });
    }
    if (method === "auth.test" && USER_TOKENS[token]) return out({ ok: true, user_id: USER_TOKENS[token], team_id: "T1", team: "시험 회사" });
    if (token !== BOT_TOK) return out({ ok: false, error: "invalid_auth" });
    if (method === "auth.test") return out({ ok: true, user_id: "UBOT", bot_id: "BBOT", team_id: "T1", team: "시험 회사" });
    if (method === "users.info") {
      const u = SLACK_USERS[body.user];
      if (!u) return out({ ok: false, error: "user_not_found" });
      return out({ ok: true, user: { id: body.user, team_id: "T1", deleted: u.deleted === true, is_bot: false, profile: u.email ? { email: u.email } : {} } });
    }
    if (method === "chat.postMessage") {
      if (body.channel === "C0NOTIN00") return out({ ok: false, error: "not_in_channel" });
      return out({ ok: true, channel: body.channel, ts: "999.1", message: { ts: "999.1", text: body.text } });
    }
    if (["chat.postEphemeral", "chat.update", "reactions.add", "chat.getPermalink", "users.list"].includes(method)) return out({ ok: true, channel: body.channel, ts: body.ts ?? "1.1" });
    if (method === "files.info") {
      if (body.file === "F0NOSCOPE1") return out({ ok: false, error: "missing_scope", needed: "files:read" });
      const f = SLACK_FILES[body.file];
      if (!f) return out({ ok: false, error: "file_not_found" });
      const { bytes: _b, type: _t, redirect: _r, ...info } = f;
      return out({ ok: true, file: { id: body.file, mode: "hosted", url_private: fileUrl(body.file, "x"), url_private_download: fileUrl(body.file, "download/x"), ...info } });
    }
    return out({ ok: false, error: "unknown_method" });
  });
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => {
  const u = new URL(req.url ?? "/", "http://x");
  const rec = { ws, app_id: u.searchParams.get("app_id"), ticket: u.searchParams.get("ticket"), acks: [], closed: false };
  sockets.push(rec);
  ws.on("message", (d) => { try { const j = JSON.parse(String(d)); if (j.envelope_id) rec.acks.push(j.envelope_id); } catch { /* */ } });
  ws.on("close", () => { rec.closed = true; });
  ws.send(JSON.stringify({ type: "hello", connection_info: { app_id: rec.app_id }, num_connections: 1 }));
}));
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;
const api = { base: `http://127.0.0.1:${port}/api`, fetch: (u, i) => fetch(u, i), fileUrlOk: (u) => u.startsWith(`http://127.0.0.1:${port}/files-pri/`) };
setSlackApiForTest(api);

// ── 가짜 Lambda(앱 백그라운드 작업이 부르는 자리) ──
const invokes = [];
const jobDeps = {
  policy: () => appServerPolicy(),
  env: () => ({ region: "ap-northeast-2", execRoleArn: process.env.LIVELY_APP_SERVER_EXEC_ROLE, awsAccountId: "111122223333", layerArn: "x", prefix: "lvly-app-", runtime: "nodejs22.x", arch: "arm64", codeStorage: "REFERENCE" }),
  invokeAsync: async (_env, fn, qualifier, payload) => { invokes.push({ fn, qualifier, payload }); },
  domain: () => "lvly.test", slug: () => "ws", now: () => Date.now(),
};
let slowMs = 0, running = 0, maxRunning = 0;
mgr.setSlackBridgeDepsForTest({
  api, allowSocketUrl: (u) => u.startsWith(`ws://127.0.0.1:${port}/`),
  startJob: async (input, user, ctx) => {
    running++; maxRunning = Math.max(maxRunning, running);
    try { if (slowMs) await sleep(slowMs); return await svc.startAppJob(input, user, ctx, jobDeps); } finally { running--; }
  },
  readSecret: mgr.readSecretOf, now: () => Date.now(), holder: "pgt", delayMs: () => 30,
});

// ── 사람 · 앱 · 금고 ──
for (const [id, email, scopes] of [
  ["alice", "alice@x.com", ["memory"]], ["bob", "bob@x.com", ["memory"]], ["carol", "carol@x.com", ["memory"]], ["dave", "dave@x.com", ["memory"]],
  ["runner", "", ["memory"]], ["boss", "boss@x.com", ["memory", "admin"]], ["mallory", "mallory@x.com", ["memory"]],
]) {
  await q(`INSERT INTO org_member(id, kind, display_name, email, state, scopes) VALUES($1,'human',$1,$2,'active',$3::jsonb)`, [id, email, JSON.stringify(scopes)]);
}
await q(`INSERT INTO person(id, display_name, kind) VALUES('carol','carol','human'), ('alice','alice','human') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO person_identity(person_id, system, external_id, origin, state) VALUES('carol','slack','U_CAROL','manual','confirmed'), ('alice','slack','U_PROP','observed','proposed')`);
await setMemberSecret(memberOwner("dave"), "slack_oauth", "", { secret: JSON.stringify({ access_token: DAVE_TOK }), meta: { slack_user_id: "U_DAVE", team_id: "T1" } }, "t");
const TOOLS = ["slack_bridge_call", "app_job_start", "store_query"];
const mkApp = async (id, tools = TOOLS) => {
  await upsertApp({ id, title: id === "policy" ? "정책 앱" : id, version: "1.0.0", manifest: { id, web: { server: {} }, permissions: { tools } }, source: { kind: "inline" }, content_hash: `h-${id}`, status: "active", enabled: true });
  await q(`INSERT INTO org_app_server(app_id, function_name, cur_lambda_version, cur_token_hash, cur_guard, pub_lambda_version, pub_token_hash, pub_guard)
           VALUES ($1, $2, '3', $3, 4, '3', $3, 4)`, [id, `lvly-app-${id}-ws`, `th-${id}`]);
};
await mkApp("policy");
await mkApp("other");
for (const m of ["alice", "carol", "dave", "runner", "mallory"]) await upsertGrant("policy", m, ["memory"], TOOLS);
await upsertGrant("other", "alice", ["memory"], TOOLS);
await q(`UPDATE org_profile SET gateway_url='https://gw.test'`).catch(() => {});
await setMemberSecret(GATEWAY_OWNER, "slack_bridge_app", "ops", { secret: APP_TOK }, "t");
await setMemberSecret(GATEWAY_OWNER, "slack_bridge_bot", "ops", { secret: BOT_TOK }, "t");
await setMemberSecret(GATEWAY_OWNER, "slack_bridge_bot", "nope", { secret: "not-a-token" }, "t");

const cap = (name) => registry.get(name);
const boss = { userId: "boss", email: "boss@x.com", scopes: ["memory", "admin"], projects: ["*"] };
const setBridge = (input) => cap("org_slack_bridge_set").handler(input, boss, {});
const C1 = "C0000000001", C2 = "C0000000002", C9 = "C0000000009";

// envelope 만들기
let evn = 0;
const evEnv = (event, o = {}) => ({ envelope_id: `env-${++evn}`, type: "events_api", payload: { token: "verif-tok", team_id: "T1", api_app_id: "A777", type: "event_callback", event_id: `Ev${evn}`, event_time: 1700000000, event, ...o } });
const message = (user, text, o = {}) => evEnv({ type: "message", channel: C1, user, text, ts: `${100 + evn}.1`, ...o });
const mention = (user, o = {}) => evEnv({ type: "app_mention", channel: C1, user, text: "<@UBOT> 확인", ts: `${100 + evn}.2`, ...o });
const sockOf = () => sockets.filter((s) => !s.closed && s.app_id === "A777").at(-1);
const send = async (env) => { const s = sockOf(); s.ws.send(JSON.stringify(env)); await until(() => s.acks.includes(env.envelope_id), 4000, `ack ${env.envelope_id}`); };
const jobs = async () => q(`SELECT id, app_id, requester, route, source, body, unattended, automation, label FROM org_app_job ORDER BY id`);
const settle = async (n) => { await until(async () => (await q(`SELECT count(*)::int AS n FROM org_slack_bridge_event WHERE outcome IS NOT NULL`))[0].n >= n, 4000, `처리 ${n}건`); };
const ephemerals = () => calls.filter((c) => c.method === "chat.postEphemeral");

try {
  // ── N6 · N7 다리 저장 검사(DB) ──
  {
    const e1 = await errOf(setBridge({ id: "ops", app_id: "policy", route: "/api/slack/event", app_token_ref: "slack_bridge_app:ops", bot_token_ref: "slack_bridge_bot:missing" }));
    chk("N6a 금고 칸이 비었으면 400", e1?.status === 400 && /값이 없습니다/.test(e1.message), String(e1?.message));
    const e2 = await errOf(setBridge({ id: "ops", app_id: "policy", route: "/api/slack/event", app_token_ref: "slack_bridge_app:ops", bot_token_ref: "slack_bridge_bot:nope" }));
    chk("N6b 접두가 틀리면 400(값은 말하지 않는다)", e2?.status === 400 && /xoxb/.test(e2.message) && !e2.message.includes("not-a-token"), String(e2?.message));
    const e3 = await errOf(setBridge({ id: "ops", app_id: "policy", route: "/api/slack/event", app_token_ref: "slack_bridge_app:ops", bot_token_ref: "slack_bridge_bot:ops", run_as: "ghost" }));
    chk("N6c run_as 가 없는 구성원이면 400", e3?.status === 400 && /run_as/.test(e3.message), String(e3?.message));
    const e4 = await errOf(setBridge({ id: "ops", app_id: "nope-app", route: "/x", app_token_ref: "slack_bridge_app:ops", bot_token_ref: "slack_bridge_bot:ops" }));
    chk("N6d 없는 앱이면 400", e4?.status === 400 && /앱 없음/.test(e4.message), String(e4?.message));
    const off = await setBridge({ id: "later", app_id: "policy", route: "/x", app_token_ref: "slack_bridge_app:later", bot_token_ref: "slack_bridge_bot:later", enabled: false });
    chk("N7 끈 다리는 금고 칸이 비어도 저장된다", off.created === true && off.bridge.enabled === false);
    const ok = await setBridge({ id: "ops", app_id: "policy", route: "POST /api/slack/event", app_token_ref: "slack_bridge_app:ops", bot_token_ref: "slack_bridge_bot:ops", channels: [C1, C2], react: "eyes" });
    chk("N1' 저장 — 라우트 정규화 · 경고 없음", ok.created === true && ok.bridge.route === "/api/slack/event" && ok.warnings.length === 0, JSON.stringify(ok.warnings));
    const e5 = await errOf(setBridge({ id: "ops2", app_id: "other", route: "/x", app_token_ref: "slack_bridge_app:ops", bot_token_ref: "slack_bridge_bot:ops" }));
    chk("N6e 같은 앱 수준 토큰 칸을 다른 다리가 쓰면 409", e5?.status === 409, String(e5?.message));
    const w = await setBridge({ id: "warn", app_id: "other", route: "/x", app_token_ref: "slack_bridge_app:warn", bot_token_ref: "slack_bridge_bot:ops", enabled: false, bot_messages: true });
    chk("N6f bot_messages + run_as 없음 → 경고", w.warnings.some((x) => /run_as/.test(x)), JSON.stringify(w.warnings));
    await cap("org_slack_bridge_remove").handler({ id: "warn" }, boss, {});
  }

  // ── 연결 — 저장이 곧바로 맞춘다 ──
  await until(() => sockets.some((s) => s.app_id === "A777" && !s.closed), 4000, "소켓 연결");
  await until(() => mgr.liveBridgeStatus("ops")?.connected === true, 4000, "연결됨");
  chk("연결 — 소켓 모드로 붙고 상태가 «연결됨» · 봇 신원을 안다",
    mgr.liveBridgeStatus("ops")?.slack?.bot_user_id === "UBOT" && calls.some((c) => c.method === "apps.connections.open" && c.token === APP_TOK));

  // ── B1 사람 글(이메일 매핑) → 작업 · 받음 표시 ──
  await send(message("U_ALICE", "카드 한도 질문"));
  await settle(1);
  let J = await jobs();
  const j1 = J[0];
  const b1 = j1 ? JSON.parse(j1.body) : null;
  chk("B1 작업 — source slack-bridge · 그 사람 · 라우트 · 본문(이벤트 · 다리 · 사람)",
    J.length === 1 && j1.source === "slack-bridge" && j1.requester === "alice" && j1.route === "/api/slack/event" && j1.app_id === "policy"
      && b1.kind === "events_api" && b1.bridge === "ops" && b1.event.text === "카드 한도 질문" && b1.actor.via === "email" && b1.actor.slack_user === "U_ALICE"
      && j1.automation === false && j1.unattended === false, JSON.stringify(J));
  chk("B1 작업 이름표 · 열쇠 기록(forwarded · 작업 번호)", j1?.label === "슬랙 message"
    && (await q(`SELECT outcome, job_id FROM org_slack_bridge_event WHERE bridge_id='ops'`)).some((r) => r.outcome === "forwarded" && Number(r.job_id) === Number(j1.id)));
  await until(() => calls.some((c) => c.method === "reactions.add"), 3000, "받음 표시");
  const r1 = calls.find((c) => c.method === "reactions.add");
  chk("D10 받음 표시 — 그 글에 reactions.add(eyes) · 봇 토큰", r1.body.name === "eyes" && r1.body.channel === C1 && r1.token === BOT_TOK);
  chk("배선 — 앱 함수가 실제로 불렸다(가짜 Lambda)", invokes.length >= 1);

  // ── D1 같은 이벤트 재전송 → 작업 하나 ──
  {
    const env = message("U_ALICE", "재전송 시험");
    await send(env);
    await settle(2);
    const again = { ...env, envelope_id: "env-retry", retry_attempt: 1, retry_reason: "timeout" };
    await send(again);
    await sleep(150);
    J = await jobs();
    chk("D1 같은 event_id 가 다시 와도 작업은 하나", J.filter((j) => JSON.parse(j.body).event.text === "재전송 시험").length === 1);
    chk("D1 duplicates 셈", (mgr.liveBridgeStatus("ops")?.duplicates ?? 0) >= 1);
  }

  // ── 거르기 — 고르지 않은 채널 · 봇 자신 ──
  {
    const before = (await jobs()).length;
    await send(message("U_ALICE", "다른 채널", { channel: C9 }));
    await send(message("UBOT", "봇 자신", { bot_id: "BBOT" }));
    await sleep(150);
    chk("E4 · E5 고르지 않은 채널 · 봇 자신의 글은 작업이 없다", (await jobs()).length === before);
    chk("거른 수 · 까닭", (mgr.liveBridgeStatus("ops")?.filtered ?? 0) >= 2 && /채널|봇/.test(mgr.liveBridgeStatus("ops")?.last_filtered ?? ""));
  }

  // ── I1~I3 신원 길 ──
  {
    await send(message("U_CAROL", "캐롤"));
    await send(message("U_DAVE", "데이브"));
    await send(message("U_PROP", "제안된 신원뿐"));
    await sleep(300);
    J = await jobs();
    const by = (t) => J.find((j) => JSON.parse(j.body).event.text === t);
    chk("I1 확인된 구성원 신원 → via identity", by("캐롤")?.requester === "carol" && JSON.parse(by("캐롤").body).actor.via === "identity");
    chk("I3 [Slack 연결] 한 계정 → via slack_login", by("데이브")?.requester === "dave" && JSON.parse(by("데이브").body).actor.via === "slack_login");
    chk("I2 제안(proposed) 신원은 믿지 않는다 — 이메일도 없으면 작업 없음", !by("제안된 신원뿐"));
  }

  // ── I5 지운 사람 · 이메일 없는 사람(같은 이메일 구성원 둘은 DB 가 막는다 — org_member_email_lc_uniq) ──
  {
    const before = (await jobs()).length;
    await send(message("U_GONE", "지운 사람(이메일은 앨리스)"));
    await send(message("U_NOMAIL", "이메일 없음"));
    await sleep(300);
    chk("I5 슬랙에서 지운 사람 · 이메일을 못 읽은 사람 → 작업 없음", (await jobs()).length === before);
  }

  // ── I3b · I3c 위조한 [Slack 연결] 칸 — 구성원이 me_credential_set 으로 meta 에 남의 슬랙 id 를 적어도 그 사람의 글을 가로채지 못한다(격리 리뷰 막을 것 1) ──
  {
    const forged = await cap("me_credential_set").handler(
      { kind: "slack_oauth", secret: JSON.stringify({ access_token: MALLORY_TOK }), meta: { slack_user_id: "U_ALICE", team_id: "T1" } },
      { userId: "mallory", email: "mallory@x.com", scopes: ["memory"], projects: ["*"] }, {});
    const row = (await q(`SELECT owner, meta FROM member_secret WHERE kind='slack_oauth' AND owner='member:mallory'`))[0];
    chk("I3b 배선 — 위조 칸이 실제 도구로 만들어졌다(meta 에 앨리스의 슬랙 id)", !!forged && row?.meta?.slack_user_id === "U_ALICE");
    const before = (await jobs()).length;
    await send(message("U_ALICE", "위조 시험"));
    await until(async () => (await jobs()).length === before + 1, 3000, "위조 시험 작업");
    const jf = (await jobs()).at(-1);
    chk("I3b 위조 칸은 믿지 않는다 — 앨리스의 글은 앨리스로(이메일 길)", jf.requester === "alice" && JSON.parse(jf.body).actor.via === "email", `${jf.requester} ${JSON.parse(jf.body).actor.via}`);
    chk("I3b 배선 — 그 칸의 토큰으로 슬랙에 실제로 물었다(auth.test)", calls.some((c) => c.method === "auth.test" && c.token === MALLORY_TOK));
    await send(message("U_DAVE", "데이브 다시"));
    await until(async () => (await jobs()).some((j) => JSON.parse(j.body).event?.text === "데이브 다시"), 3000, "데이브 작업");
    const jd = (await jobs()).find((j) => JSON.parse(j.body).event?.text === "데이브 다시");
    chk("I3c 진짜 연결은 그대로 — via slack_login", jd.requester === "dave" && JSON.parse(jd.body).actor.via === "slack_login");
  }

  // ── E17 · D11 태그한 글 · 같은 글 두 이벤트 → 작업 하나 ──
  {
    const before = (await jobs()).length;
    const ts = "777.7";
    await send(message("U_ALICE", "<@UBOT> 태그 시험", { ts }));
    await send(mention("U_ALICE", { ts, text: "<@UBOT> 태그 시험" }));
    await sleep(250);
    const J2 = (await jobs()).slice(before);
    chk("E17 사람이 태그한 글 — message 는 거르고 app_mention 하나만 작업", J2.length === 1 && JSON.parse(J2[0].body).event.type === "app_mention", JSON.stringify(J2.map((j) => JSON.parse(j.body).event.type)));
    const ts2 = "778.8";
    const dup0 = mgr.liveBridgeStatus("ops")?.duplicates ?? 0;
    await send(message("U_ALICE", "태그 없는 글", { ts: ts2 }));
    await send(mention("U_ALICE", { ts: ts2, text: "태그 없는 글" }));
    await sleep(250);
    const J3 = (await jobs()).slice(before + 1);
    chk("D11 같은 글(채널 · ts)이 두 이벤트로 와도 작업 하나 · duplicates", J3.length === 1 && (mgr.liveBridgeStatus("ops")?.duplicates ?? 0) === dup0 + 1, `${J3.length}`);
  }

  // ── D12 처리 동시성 상한 — 한꺼번에 와도 연결마다 동시에 넷까지 · 다 처리 ──
  {
    const before = (await jobs()).length;
    slowMs = 120; maxRunning = 0;
    const s = sockOf();
    const envs = Array.from({ length: 10 }, (_, i) => message("U_ALICE", `몰림 ${i}`));
    for (const e of envs) s.ws.send(JSON.stringify(e));
    await until(() => envs.every((e) => s.acks.includes(e.envelope_id)), 3000, "몰림 ack");
    await until(async () => (await jobs()).length === before + 10, 8000, "몰림 처리");
    slowMs = 0;
    chk("D12 동시에 넷까지만 · 열 개 모두 작업", maxRunning <= 4 && maxRunning >= 2, `max ${maxRunning}`);
  }

  // ── I6 · I7 · I8 · I11 안내 ──
  {
    const before = (await jobs()).length;
    const e0 = ephemerals().length;
    await send(message("U_NOMAP", "모르는 사람의 평범한 글"));
    await sleep(200);
    chk("I7 매핑 없음 + 평범한 글 → 작업 없음 · 안내 없음", (await jobs()).length === before && ephemerals().length === e0);
    const m = mention("U_NOMAP", { thread_ts: "50.5" });
    await send(m);
    await until(() => ephemerals().length === e0 + 1, 3000, "안내");
    const eph = ephemerals().at(-1);
    chk("I6 매핑 없음 + 태그 → 그 사람에게만 안내(스레드) · 작업 없음",
      eph.body.user === "U_NOMAP" && eph.body.channel === C1 && eph.body.thread_ts === "50.5" && /라이블리 계정/.test(eph.body.text) && (await jobs()).length === before);
    await send(mention("U_BOB"));
    await until(() => ephemerals().length === e0 + 2, 3000, "동의 안내");
    const e2 = ephemerals().at(-1);
    chk("I8 동의 없음 + 태그 → 동의 링크 안내 · 작업 없음",
      e2.body.user === "U_BOB" && /정책 앱/.test(e2.body.text) && e2.body.text.includes("https://gw.test/ui/#/app-grant/policy") && (await jobs()).length === before, e2.body.text);
    await send(mention("U_BOB"));
    await sleep(250);
    chk("I11 같은 안내는 10분에 한 번", ephemerals().length === e0 + 2);
  }

  // ── I12 · I13 #1644 예전 범위 동의 — 동의가 앱의 지금 선언을 덮지 못하면 작업을 시작하지 않고 «다시 동의» 를 안내한다 · 다시 동의하면 시작한다 ──
  //  이게 틀리면: 앱이 동의 뒤에 넓어졌을 때(새 도구 · scope) 슬랙에서 부른 앱 코드 · 작업 AI 가 그 사람의 예전 동의로 돌아 새 기능만 막히거나 조용히 빠진다.
  {
    //  앱 판을 이 코어가 읽는 매니페스트로 바꾼다(제목 · 판 칸 — 이 시험의 앱 행은 일부러 파서가 못 읽는 꼴이라 지금까지는 판정이 끼어들지 않았다).
    //   web.server 는 작업 도구 넷을 함의하는데 앨리스의 동의(TOOLS 셋)엔 app_job_get · app_jobs · app_job_cancel 이 없다 — 동의 뒤에 앱이 넓어진 모양.
    const original = (await q(`SELECT manifest FROM org_app WHERE id='policy'`))[0].manifest;
    await q(`UPDATE org_app SET manifest=$1::jsonb WHERE id='policy'`, [JSON.stringify({ id: "policy", title: "정책 앱", version: "1.0.0", web: { server: {} }, permissions: { tools: TOOLS } })]);
    try {
      const before = (await jobs()).length;
      const e0 = ephemerals().length;
      await send(mention("U_ALICE", { thread_ts: "60.6" }));
      await until(() => ephemerals().length === e0 + 1, 3000, "다시 동의 안내");
      const eph = ephemerals().at(-1);
      //  한 이벤트에 열쇠 행이 여럿일 수 있다(event_id · envelope_id — 같은 글 열쇠) — 맨 마지막 행이 아니라 걸러진 까닭이 적힌 행을 본다.
      const outcome = (await q(`SELECT outcome FROM org_slack_bridge_event WHERE bridge_id='ops' AND outcome LIKE 'filtered:%' ORDER BY id DESC LIMIT 1`))[0]?.outcome ?? "";
      chk("I12 예전 범위 동의 + 태그 → 작업 없음 · 그 사람에게만 «다시 동의» 안내(스레드 · 동의 링크) · 걸러진 까닭에 덮지 못한 도구",
        eph.body.user === "U_ALICE" && eph.body.thread_ts === "60.6" && /예전 범위/.test(eph.body.text) && eph.body.text.includes("https://gw.test/ui/#/app-grant/policy?v=pub")
          && (await jobs()).length === before && /예전 범위/.test(outcome) && /app_job_get/.test(outcome), JSON.stringify({ text: eph.body.text, outcome }));
      await upsertGrant("policy", "alice", ["memory"], [...TOOLS, "app_job_get", "app_jobs", "app_job_cancel"]);
      await send(mention("U_ALICE", { thread_ts: "61.6" }));
      await until(async () => (await jobs()).length === before + 1, 3000, "다시 동의 뒤 작업");
      chk("I13 다시 동의(선언 전체) 뒤 같은 태그가 작업을 시작한다", (await jobs()).at(-1).requester === "alice");
    } finally {
      await q(`UPDATE org_app SET manifest=$1::jsonb WHERE id='policy'`, [JSON.stringify(original)]);
    }
  }

  // ── I9 · I10 워크플로 · 봇 글 · A-h 물려받기 ──
  {
    const before = (await jobs()).length;
    const wf = () => message(undefined, "업무 요청 접수", { user: undefined, bot_id: "BWF", subtype: "bot_message" });
    await send(wf());
    await sleep(150);
    chk("I9a bot_messages 꺼짐 → 작업 없음", (await jobs()).length === before);
    await setBridge({ id: "ops", bot_messages: true });
    await send(wf());
    await sleep(200);
    chk("I9b run_as 없음 → 작업 없음 · 안내 없음", (await jobs()).length === before);
    const runSet = await setBridge({ id: "ops", run_as: "runner" });
    chk("N9 run_as 경고 — bot_ids 가 비었으면 알린다", runSet.warnings.some((x) => /bot_ids/.test(x)), JSON.stringify(runSet.warnings));
    const bossRun = await setBridge({ id: "ops", run_as: "boss", bot_ids: ["BWF"] });
    chk("N9b run_as 가 높은 권한이면 알린다", bossRun.warnings.some((x) => /높은 권한/.test(x)), JSON.stringify(bossRun.warnings));
    await setBridge({ id: "ops", run_as: "runner" });
    await send(message(undefined, "다른 봇", { user: undefined, bot_id: "BOTHER", subtype: "bot_message" }));
    await sleep(150);
    chk("E19 고르지 않은 봇의 글은 넘기지 않는다", (await jobs()).length === before);
    await send(wf());
    await until(async () => (await jobs()).length === before + 1, 3000, "run_as 작업");
    const jr = (await jobs()).at(-1);
    chk("I10 run_as 이름 · 자동화 · 사람이 보지 않음 표시 · via run_as",
      jr.requester === "runner" && jr.automation === true && jr.unattended === true && JSON.parse(jr.body).actor.via === "run_as" && JSON.parse(jr.body).actor.slack_user === null, JSON.stringify(jr));
    const child = await svc.startAppJob({ route: "/api/child", body: {} },
      { userId: "runner", email: "", scopes: ["memory"], projects: ["*"], appId: "policy", appServer: true, appAddress: "pub", appJobId: Number(jr.id) }, {}, jobDeps);
    chk("A-h 자동화 작업 안에서 시작한 작업은 자동화를 물려받는다", (await js.appJobAutomation(Number(child.id))) === true && (await js.appJobAutomation(Number((await jobs())[0].id))) === false);
    //  run_as_human — 사람이 양식을 내는 워크플로를 bot_ids 로 고르고 켜면 run_as 작업에 자동화 · 사람이 보지 않음 표시를 달지 않는다(공용 시트를 쓸 수 있다).
    const noIds = await errOf(setBridge({ id: "ops", bot_ids: [], run_as_human: true }));
    chk("N10 run_as_human 은 bot_ids 없이 켜지 못한다", noIds?.status === 400 && /bot_ids/.test(noIds.message), String(noIds?.message));
    const offWarn = (await setBridge({ id: "ops", bot_ids: ["BWF"] })).warnings;
    chk("N10b run_as_human 꺼짐 + bot_messages → 자동화(공용 시트 · API 키) 경고", offWarn.some((x) => /run_as_human/.test(x)), JSON.stringify(offWarn));
    const humanSet = await setBridge({ id: "ops", run_as_human: true });
    chk("N10c run_as_human 이 저장 · 보기에 실린다", humanSet.bridge.run_as_human === true && !humanSet.warnings.some((x) => /자동화로 표시/.test(x)), JSON.stringify(humanSet));
    await send(message(undefined, "업무 요청 접수 2", { user: undefined, bot_id: "BWF", subtype: "bot_message" }));
    await until(async () => (await jobs()).length === before + 3, 3000, "run_as_human 작업");
    const jh = (await jobs()).at(-1);
    chk("I10b run_as_human — run_as 이름 그대로 · 자동화 · 사람이 보지 않음 표시 없음 · via run_as",
      jh.requester === "runner" && jh.automation === false && jh.unattended === false && JSON.parse(jh.body).actor.via === "run_as", JSON.stringify(jh));
    await setBridge({ id: "ops", bot_messages: false, run_as: null, bot_ids: [], run_as_human: false });
  }

  // ── E12 버튼 ──
  {
    const before = (await jobs()).length;
    await send({ envelope_id: "env-btn", type: "interactive", payload: {
      token: "verif-tok", type: "block_actions", trigger_id: "trig-77", user: { id: "U_ALICE", team_id: "T1" }, team: { id: "T1" },
      channel: { id: C1 }, container: { type: "message", channel_id: C1, message_ts: "999.1" }, message: { ts: "999.1" }, actions: [{ action_id: "approve", value: "p-1" }],
    } });
    await until(async () => (await jobs()).length === before + 1, 3000, "버튼 작업");
    const jb = (await jobs()).at(-1);
    const bb = JSON.parse(jb.body);
    chk("E12 버튼 → interactive 작업 · 누른 사람 · payload(검증 토큰 뺌)",
      bb.kind === "interactive" && jb.requester === "alice" && bb.payload.actions[0].value === "p-1" && !jb.body.includes("verif-tok") && jb.label === "슬랙 block_actions");
  }

  // ── K slack_bridge_call ──
  {
    const call = cap("slack_bridge_call");
    const srv = (app = "policy", member = "alice", extra = {}) => ({ userId: member, email: "", scopes: ["memory"], projects: ["*"], appId: app, appServer: true, appAddress: "pub", ...extra });
    const k1 = await errOf(call.handler({ bridge: "ops", method: "chat.postMessage", args: { channel: C1, text: "x" } }, { userId: "alice", email: "", scopes: ["memory"], projects: ["*"] }));
    const k1b = await errOf(call.handler({ bridge: "ops", method: "chat.postMessage", args: { channel: C1, text: "x" } }, { userId: "alice", email: "", scopes: ["memory"], projects: ["*"], appId: "policy" }));
    chk("K1 앱 아닌 사람 · 앱 화면(서버 아님) → 403", k1?.status === 403 && k1b?.status === 403);
    const k2 = await errOf(call.handler({ bridge: "ops", method: "chat.postMessage", args: { channel: C1, text: "x" } }, srv("other")));
    const k2b = await errOf(call.handler({ bridge: "ghost", method: "chat.postMessage", args: { channel: C1, text: "x" } }, srv()));
    chk("K2 남의 앱의 다리 · 없는 다리 → 똑같이 404", k2?.status === 404 && k2b?.status === 404 && /다리 없음/.test(k2.message));
    const posted0 = calls.filter((c) => c.method === "chat.postMessage").length;
    const r = await call.handler({ bridge: "ops", method: "chat.postMessage", args: { channel: C1, text: "1차 답: 한도는 …", thread_ts: "101.1" } }, srv("policy", "alice", { appJobId: 1 }));
    const sent = calls.filter((c) => c.method === "chat.postMessage").at(-1);
    chk("K4 봇 토큰으로 슬랙에 나갔다 · 응답 그대로", calls.filter((c) => c.method === "chat.postMessage").length === posted0 + 1
      && sent.token === BOT_TOK && sent.body.text === "1차 답: 한도는 …" && r.ok === true && r.response.ts === "999.1" && r.error === null);
    const log = (await q(`SELECT * FROM org_slack_bridge_call WHERE bridge_id='ops' ORDER BY id DESC LIMIT 1`))[0];
    chk("K5 호출 기록 — 메서드 · 채널 · ts · 사람 · 작업 · 결과 · 보낸 글 없음",
      log.method === "chat.postMessage" && log.channel === C1 && log.ts === "101.1" && log.ok === true && log.member === "alice" && Number(log.job_id) === 1 && !JSON.stringify(log).includes("1차 답"));
    await setBridge({ id: "ops", channels: [C1, C2, "C0NOTIN00"] });
    const rf = await call.handler({ bridge: "ops", method: "chat.postMessage", args: { channel: "C0NOTIN00", text: "x" } }, srv());
    chk("K4b 슬랙의 실패는 ok:false · error 로(던지지 않는다)", rf.ok === false && rf.error === "not_in_channel");
    const c4 = await errOf(call.handler({ bridge: "ops", method: "chat.postMessage", args: { channel: C9, text: "x" } }, srv()));
    chk("C4a' 다리 채널 밖 → 403 · 슬랙에 안 나감", c4?.status === 403 && !calls.some((c) => c.body.channel === C9 && c.method === "chat.postMessage"));
    const c1 = await errOf(call.handler({ bridge: "ops", method: "admin.users.remove", args: {} }, srv()));
    chk("C1' 허용 밖 메서드 → 400", c1?.status === 400);
    //  K6 분당 상한 — 새 다리(다른 슬랙 앱)로 잰다.
    await setMemberSecret(GATEWAY_OWNER, "slack_bridge_app", "rate", { secret: APP_TOK_RATE }, "t");
    await setBridge({ id: "rate", app_id: "policy", route: "/api/slack/event", app_token_ref: "slack_bridge_app:rate", bot_token_ref: "slack_bridge_bot:ops" });
    let okCount = 0, limited = null;
    for (let i = 0; i < 125 && !limited; i++) {
      try { await call.handler({ bridge: "rate", method: "chat.getPermalink", args: { channel: C1, message_ts: "1.1" } }, srv()); okCount++; }
      catch (e) { limited = e; }
    }
    chk("K6 분당 120 번까지 · 121 번째 429", okCount === 120 && limited?.status === 429, `${okCount} ${limited?.status}`);
    await setBridge({ id: "ops", enabled: false });
    const k3 = await errOf(call.handler({ bridge: "ops", method: "chat.postMessage", args: { channel: C1, text: "x" } }, srv()));
    chk("K3 꺼진 다리 → 409", k3?.status === 409);
    await until(() => mgr.liveBridgeStatus("ops") === null, 3000, "끈 다리의 연결 내림");
    chk("D6b 다리를 끄면 연결을 내리고 상태가 stopped", (await store.getBridge("ops")).status.state === "stopped" && sockets.filter((s) => s.app_id === "A777").every((s) => s.closed));
    await setBridge({ id: "ops", enabled: true });
    await until(() => mgr.liveBridgeStatus("ops")?.connected === true, 4000, "다시 켬");
  }

  // ── F slack_bridge_file — 앱이 그 채널의 파일을 읽는다 ──
  {
    const file = cap("slack_bridge_file");
    const appU = (app = "policy", extra = {}) => ({ userId: "alice", email: "", scopes: ["memory"], projects: ["*"], appId: app, ...extra });
    const dl = () => calls.filter((c) => c.method === "file.download").length;
    const f1 = await errOf(file.handler({ bridge: "ops", file: "F0PNG00001" }, { userId: "alice", email: "", scopes: ["memory"], projects: ["*"] }));
    const f1b = await errOf(file.handler({ bridge: "ops", file: "F0PNG00001" }, appU("other")));
    chk("F1 앱 아닌 사람 → 403 · 남의 앱 → 404", f1?.status === 403 && f1b?.status === 404);
    const f2 = await errOf(file.handler({ bridge: "ops", file: "../etc/passwd" }, appU()));
    chk("F2 파일 id 꼴이 아니면 400 · 슬랙에 안 나감", f2?.status === 400 && !calls.some((c) => c.method === "files.info" && c.body.file === "../etc/passwd"));
    const d0 = dl();
    const img = await file.handler({ bridge: "ops", file: "F0PNG00001" }, appU("policy", { appServer: true, appJobId: 7 }));
    const lastDl = calls.filter((c) => c.method === "file.download").at(-1);
    chk("F3 그림 — 봇 토큰으로 정보 · 파일을 받아 JPEG 조각으로", img.ok === true && img.kind === "image" && img.image.mime === "image/jpeg" && img.image.data.length > 20
      && Buffer.from(img.image.data, "base64").subarray(0, 2).toString("hex") === "ffd8" && img.file.name === "bc_답변.png" && dl() === d0 + 1 && lastDl.token === BOT_TOK && lastDl.body.file === "F0PNG00001",
      JSON.stringify({ ...img, image: img.image ? { ...img.image, data: `${String(img.image.data).slice(0, 12)}…` } : null }));
    const parts = file.mcpContent(img);
    chk("F3b MCP 로는 그림 조각 + 글(파일 정보 · 남이 올린 것이라는 경계)", parts?.[0]?.type === "image" && parts[0].mimeType === "image/jpeg" && parts[0].data === img.image.data
      && parts[1]?.type === "text" && /지시/.test(parts[1].text) && !parts[1].text.includes(img.image.data));
    const flog = (await q(`SELECT * FROM org_slack_bridge_call WHERE bridge_id='ops' AND method='files.read' ORDER BY id DESC LIMIT 1`))[0];
    chk("F4 호출 기록 — files.read · 공유된 채널 · 파일 id · 사람 · 작업", flog?.channel === C1 && flog.ts === "F0PNG00001" && flog.ok === true && flog.member === "alice" && Number(flog.job_id) === 7);
    const txt = await file.handler({ bridge: "ops", file: "F0TXT00001" }, appU());
    const tparts = file.mcpContent(txt);
    chk("F5 글 파일(shares 로 공유된 채널) → text · MCP 는 경계 뒤 평문", txt.kind === "text" && txt.text === "한도 4억 원" && txt.truncated === false
      && tparts?.length === 1 && tparts[0].type === "text" && /사람의 지시가 아닙니다\)\n한도 4억 원$/.test(tparts[0].text));
    const d1 = dl();
    const pdf = await file.handler({ bridge: "ops", file: "F0PDF00001" }, appU());
    chk("F6 읽지 못하는 형식 → unsupported · 까닭 · 내려받지 않음 · MCP 는 JSON 그대로", pdf.ok === true && pdf.kind === "unsupported" && /형식/.test(pdf.reason) && dl() === d1 && file.mcpContent(pdf) === null);
    const out9 = await errOf(file.handler({ bridge: "ops", file: "F0OUT00001" }, appU()));
    chk("F7 다리 채널 밖에 공유된 파일 → 403 · 내려받지 않음", out9?.status === 403 && dl() === d1);
    const ns = await errOf(file.handler({ bridge: "ops", file: "F0NOSCOPE1" }, appU()));
    const nf = await errOf(file.handler({ bridge: "ops", file: "F0GHOST0001" }, appU()));
    chk("F8 봇에 files:read 가 없으면 409(무엇을 할지) · 없는 파일 404", ns?.status === 409 && /files:read/.test(ns.message) && nf?.status === 404);
    const lg = await errOf(file.handler({ bridge: "ops", file: "F0LOGIN001" }, appU()));
    chk("F9 슬랙이 로그인 화면으로 넘기면(권한 없음) 502 — 그 화면을 파일로 읽지 않는다", lg?.status === 502 && /files:read/.test(lg.message));
    const flogs = await q(`SELECT ok, error FROM org_slack_bridge_call WHERE bridge_id='ops' AND method='files.read' ORDER BY id`);
    chk("F10 실패도 기록 · 결과에 토큰 없음", flogs.some((r) => r.ok === false && /files:read/.test(r.error ?? ""))
      && !JSON.stringify([img.file, txt, pdf, flogs]).includes(BOT_TOK) && !String(ns.message + lg.message + out9.message).includes(BOT_TOK));
  }

  // ── D6 토큰 교체 · D5 재시작 · D7 같은 토큰 값 · D8 봇 토큰 거절 ──
  {
    const n0 = sockets.filter((s) => s.app_id === "A777").length;
    await setMemberSecret(GATEWAY_OWNER, "slack_bridge_app", "ops", { secret: APP_TOK2 }, "t");
    const rr = await mgr.reconcileSlackBridges();
    await until(() => sockets.filter((s) => s.app_id === "A777").length === n0 + 1 && mgr.liveBridgeStatus("ops")?.connected === true, 4000, "토큰 교체 뒤 다시 붙음");
    chk("D6 금고의 토큰을 갈면 다시 붙는다(새 토큰으로)", rr.restarted >= 1 && calls.some((c) => c.method === "apps.connections.open" && c.token === APP_TOK2), JSON.stringify(rr));
    mgr.stopAllSlackBridges();
    await until(() => sockets.filter((s) => s.app_id === "A777").every((s) => s.closed), 3000, "내림");
    await mgr.reconcileSlackBridges();
    await until(() => mgr.liveBridgeStatus("ops")?.connected === true, 4000, "재시작 뒤 붙음");
    chk("D5 게이트웨이 재시작(연결을 다 내리고 맞추기) → 다시 붙는다", sockets.filter((s) => s.app_id === "A777" && !s.closed).length === 1);
    //  재시작 뒤에도 같은 이벤트는 다시 작업이 되지 않는다(열쇠는 DB 에 있다).
    const before = (await jobs()).length;
    const env = message("U_ALICE", "재시작 뒤 첫 글");
    await send(env);
    await until(async () => (await jobs()).length === before + 1, 3000, "작업");
    mgr.stopAllSlackBridges();
    await mgr.reconcileSlackBridges();
    await until(() => mgr.liveBridgeStatus("ops")?.connected === true, 4000, "다시");
    await send({ ...env, envelope_id: "env-after-restart", retry_attempt: 2 });
    await sleep(200);
    chk("D1' 재시작을 건너 같은 event_id 가 와도 작업은 하나", (await jobs()).length === before + 1);
    //  D7 다른 칸에 같은 앱 토큰 값 — 둘째 다리는 붙지 않고 오류 상태.
    await setMemberSecret(GATEWAY_OWNER, "slack_bridge_app", "copy", { secret: APP_TOK2 }, "t");
    const nA = sockets.filter((s) => s.app_id === "A777").length;
    await setBridge({ id: "zcopy", app_id: "other", route: "/x", app_token_ref: "slack_bridge_app:copy", bot_token_ref: "slack_bridge_bot:ops" });
    await sleep(300);
    const zs = (await store.getBridge("zcopy")).status;
    chk("D7 같은 앱 토큰 값을 다른 칸에 넣은 다리 → 연결 안 함 · 오류 상태", zs.state === "error" && /같은 앱 수준 토큰/.test(zs.last_error ?? "") && sockets.filter((s) => s.app_id === "A777").length === nA, JSON.stringify(zs));
    await cap("org_slack_bridge_remove").handler({ id: "zcopy" }, boss, {});
    //  D8 봇 토큰을 슬랙이 거절 — 봇 신원을 모르면 붙지 않는다.
    await setMemberSecret(GATEWAY_OWNER, "slack_bridge_bot", "bad", { secret: BOT_TOK_BAD }, "t");
    await setBridge({ id: "rate", bot_token_ref: "slack_bridge_bot:bad" });
    await until(() => mgr.liveBridgeStatus("rate")?.state === "waiting", 4000, "rate 대기");
    chk("D8 auth.test 가 거절하면 붙지 않고 기다린다(까닭 auth.test)", /auth\.test/.test(mgr.liveBridgeStatus("rate")?.last_error ?? "") && mgr.liveBridgeStatus("rate")?.connected === false);
    await cap("org_slack_bridge_remove").handler({ id: "rate" }, boss, {});
  }

  // ── 목록 · 지우기 · S1 비밀 ──
  {
    const list = await cap("org_slack_bridges").handler({}, boss, {});
    const ops = list.bridges.find((b) => b.id === "ops");
    chk("목록 — 상태 · 최근 호출 · 다리용 매니페스트(소켓 모드) · 만들기 링크 · 순서",
      ops && ops.status.connected === true && ops.status_from === "this_gateway" && ops.recent_calls.length >= 1 && list.manifest.settings.socket_mode_enabled === true
        && /^https:\/\/api\.slack\.com\/apps\?new_app=1/.test(list.create_url) && list.setup.length >= 5);
    const dump = JSON.stringify(list) + JSON.stringify(await q(`SELECT body, result FROM org_app_job`)) + JSON.stringify(await q(`SELECT * FROM org_slack_bridge`))
      + JSON.stringify(await q(`SELECT * FROM org_slack_bridge_call`)) + JSON.stringify(await q(`SELECT * FROM org_slack_bridge_event`)) + JSON.stringify(invokes);
    const leaked = ALL_TOKENS.filter((t) => dump.includes(t) || dump.includes(t.slice(-12)));
    chk("S1 토큰 값이 작업 본문 · 상태 · 호출 기록 · 열쇠 표 · 앱 함수 부르기 · 목록 응답 어디에도 없다", leaked.length === 0, leaked.join(","));
    chk("S1' 슬랙 검증 토큰도 작업 본문에 없다", !dump.includes("verif-tok"));
    const rm = await cap("org_slack_bridge_remove").handler({ id: "ops" }, boss, {});
    await until(() => mgr.liveBridgeStatus("ops") === null, 3000, "지운 다리 내림");
    chk("지우기 — 연결 내림 · 열쇠 기록도 지움 · 호출 기록은 남김", rm.removed === true && !(await store.getBridge("ops"))
      && (await q(`SELECT count(*)::int AS n FROM org_slack_bridge_event WHERE bridge_id='ops'`))[0].n === 0
      && (await q(`SELECT count(*)::int AS n FROM org_slack_bridge_call WHERE bridge_id='ops'`))[0].n >= 1);
    const e = await errOf(cap("org_slack_bridge_remove").handler({ id: "ops" }, boss, {}));
    chk("없는 다리 지우기 → 404", e?.status === 404);
  }

  // ── 롤 창 — run_as_human 칸이 아직 없을 때(매니지드 롤은 새 게이트웨이를 먼저 띄우고 마이그레이션을 맨 끝에 돌린다) ──
  //  RW1 조회 · RW2 맞추기 · RW3 꺼진 값 저장은 돈다(칸 없이) · RW4 켜려는 저장만 503(조용히 꺼진 채 남지 않게) · RW5 칸이 생기면 그대로 켜진다.
  {
    const rollIn = (over = {}) => ({
      id: "roll", app_id: "policy", route: "POST /api/slack/event", enabled: false,
      app_token_ref: { owner: "gateway", kind: "slack_bridge_app", scope_key: "ops" }, bot_token_ref: { owner: "gateway", kind: "slack_bridge_bot", scope_key: "ops" },
      events: [], channels: [], bot_messages: true, bot_ids: ["BWF"], run_as: "runner", run_as_human: false, react: null, note: "앞", ...over,
    });
    await store.upsertBridge(rollIn(), "boss");
    await dbc.query(`ALTER TABLE org_slack_bridge DROP COLUMN run_as_human`);
    try {
      const list = await errOf(store.listBridges().then((rows) => { throw { rows }; }));
      const one = await errOf(store.getBridge("roll").then((row) => { throw { row }; }));
      chk("RW1 칸이 없어도 목록 · 한 건 읽기가 돈다(run_as_human 은 false)",
        Array.isArray(list?.rows) && list.rows.some((r) => r.id === "roll" && r.run_as_human === false) && one?.row?.id === "roll" && one.row.run_as_human === false && one.row.note === "앞",
        JSON.stringify(list?.rows ?? list?.message) + " / " + JSON.stringify(one?.row ?? one?.message));
      const rec = await errOf(mgr.reconcileSlackBridges().then((out) => { throw { out }; }));
      chk("RW2 칸이 없어도 맞추기가 던지지 않는다", !!rec?.out && typeof rec.out.active === "number", String(rec?.message ?? JSON.stringify(rec)));
      const saved = await errOf(store.upsertBridge(rollIn({ note: "뒤" }), "boss").then((row) => { throw { row }; }));
      chk("RW3 칸이 없어도 꺼진 값(false) 저장은 된다", saved?.row?.note === "뒤" && saved.row.run_as_human === false && (await q(`SELECT note FROM org_slack_bridge WHERE id='roll'`))[0]?.note === "뒤",
        String(saved?.message ?? JSON.stringify(saved)));
      const on = await errOf(store.upsertBridge(rollIn({ run_as_human: true, note: "켬" }), "boss"));
      chk("RW4 칸이 없을 때 켜려는 저장은 503 이고 행은 그대로다", on?.status === 503 && (await q(`SELECT note FROM org_slack_bridge WHERE id='roll'`))[0]?.note === "뒤", String(on?.status) + " " + String(on?.message));
    } finally {
      await dbc.query(`ALTER TABLE org_slack_bridge ADD COLUMN IF NOT EXISTS run_as_human BOOLEAN NOT NULL DEFAULT false`);
    }
    const after = await store.upsertBridge(rollIn({ run_as_human: true }), "boss");
    chk("RW5 칸이 생기면 켠 값이 저장 · 읽기에 실린다", after.run_as_human === true && (await store.getBridge("roll"))?.run_as_human === true);
    await store.removeBridge("roll");
  }
} catch (e) {
  fail++;
  console.error("FAIL (예외)", e);
} finally {
  mgr.stopAllSlackBridges();
  mgr.setSlackBridgeDepsForTest(null);
  setSlackApiForTest(null);
  for (const s of wss.clients) s.terminate();
  await new Promise((ok) => server.close(ok));
  await itemsPool.end().catch(() => {});
  await dbc.end();
  await su.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await su.end();
}
console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
