// MCP 프록시 상류 오류 스크럽 — PG 통합 시험. **실제 Postgres 필요**(서버 행·자격 금고·런타임 설정을 실제로 읽는다).
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/mcp/mcp-proxy-upstream-error.pg-test.mjs
//  (금고 암호화 키가 없으면 시험용 키를 쓴다.)
//
//  사양 행:
//   R1 상류가 initialize(연결) 단계에서 주입 자격을 응답 본문에 에코하며 실패하면, callProxyTool 이 던지는 오류에
//      그 자격이 남지 않고 [REDACTED] 와 상류 status([HTTP n])가 남는다.
//   R2 tools/call 단계에서 같은 에코로 실패해도 마찬가지다.
//   R3 관리자 새로고침(refreshProxySnapshot)이 initialize 단계에서 같은 에코로 실패해도 조직 자격이 남지 않는다.
//  oauth 서버(같은 로컬 서버가 인가 서버 메타데이터 · 토큰 끝점 · oauth 로 지키는 /oauth-mcp 를 함께 흉내 낸다 — SDK 의 실제 인증 흐름을 지난다):
//   R4 토큰 갱신이 거절되면(invalid_grant) 등록된 프록시 툴의 응답에 재연결 안내가 붙고, 옛 토큰 · 갱신 토큰이 남지 않는다.
//   R5 연결 중 SDK 가 토큰을 갱신한 뒤 initialize 가 **새** 토큰을 에코하며 실패해도, 툴 호출 오류에 새 토큰이 남지 않는다.
//   R6 같은 상황을 새로고침(refreshProxySnapshot)의 initialize 단계에서.
//   R7 갱신된 새 토큰이 tools/call 의 정상 응답 본문에 에코돼도 지운다.
//   R8 새로고침의 tools/list 단계에서 새 토큰을 에코하며 실패해도 지운다.
if (!process.env.CONNECTOR_SECRET_KEY?.trim()) process.env.CONNECTOR_SECRET_KEY = "proxy-scrub-pg-test-key".padEnd(64, "0");

import http from "node:http";

const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { initAllSchemas } = await import(`${DIST}/boot/schemas.js`);
await initAllSchemas({ quiet: true });
const { itemsPool } = await import(`${DIST}/db/client.js`);
const store = await import(`${DIST}/org/store.js`);
const vault = await import(`${DIST}/org/credentials/member-secret-store.js`);
const proxy = await import(`${DIST}/mcp/mcp-proxy.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

const SERVER = "pg-proxy-scrub";
const KIND = "pgproxyscrub";
//  가짜 값은 조각을 이어 만든다(따옴표 안에 비밀 같은 글이 그대로 있으면 비밀 검사기가 진짜로 잡는다).
const SECRET = ["pgscrub", "token", "do-not-leak", "0123456789"].join("-");
//  oauth — 금고에 있던 옛 access token · 갱신 토큰, 토큰 끝점이 갱신으로 내주는 새 access token.
const OSERVER = "pg-proxy-scrub-oauth";
const OKIND = "pgproxyscruboauth";
const CALLER = "pg-proxy-scrub-user";
const OLD = ["pgscrub", "oauth", "old", "access", "0123456789"].join("-");
const REFRESH = ["pgscrub", "oauth", "refresh", "0123456789"].join("-");
const NEW = ["pgscrub", "oauth", "new", "access", "9876543210"].join("-");

//  상류: failPhase 가 initialize 면 첫 요청부터, tools/call 이면 그 요청에서 Authorization 헤더를 본문에 그대로 실어 500 으로 실패한다.
//  /oauth-mcp 는 새 토큰만 받는다(옛 토큰이면 401 → SDK 가 토큰 끝점으로 갱신을 시도한다). tokenMode=reject 면 갱신을 거절한다(invalid_grant).
//   새 토큰을 받은 뒤에는 oauthFail 단계에서 그 헤더를 에코하며 500 으로 실패한다("none" 이면 tools/call 결과 본문에 에코한다).
let failPhase = "initialize";
let tokenMode = "refresh";
let oauthFail = "initialize";
let BASE = "";
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const auth = req.headers.authorization ?? "";
    const echo = () => { res.writeHead(500, { "content-type": "text/plain" }); res.end(`upstream rejected credential: ${auth}`); };
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      json(200, { issuer: BASE, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
      return;
    }
    if (req.method === "POST" && path === "/token") {
      const form = new URLSearchParams(body);
      if (tokenMode === "reject" || form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== REFRESH) {
        json(400, { error: "invalid_grant", error_description: "refresh token expired" });
        return;
      }
      json(200, { access_token: NEW, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH });
      return;
    }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    let msg = {};
    try { msg = JSON.parse(body || "{}"); } catch { /* 본문 없음 */ }
    if (path === "/oauth-mcp") {
      if (auth !== `Bearer ${NEW}`) { res.writeHead(401, { "www-authenticate": "Bearer" }); res.end(); return; }
      if (msg.method === oauthFail) { echo(); return; }
      if (msg.method === "tools/list") { json(200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "anything", inputSchema: { type: "object" } }] } }); return; }
      if (msg.method === "tools/call") { json(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `you sent ${auth}` }] } }); return; }
    } else if (msg.method === failPhase) { echo(); return; }
    if (msg.method === "initialize") {
      json(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } });
      return;
    }
    res.writeHead(202); res.end(); // notifications/initialized 등
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
BASE = `http://127.0.0.1:${upstream.address().port}`;
const URL_ = `${BASE}/mcp`;

const leaked = (msg) => [SECRET, OLD, REFRESH, NEW].filter((s) => msg.includes(s));
//  금고의 oauth 토큰을 «만료돼 갱신이 필요한 옛 토큰» 으로 되돌린다(앞 행에서 SDK 가 새 토큰을 저장했거나 지웠다).
const seedOAuthTokens = () => vault.setMemberSecret(vault.memberOwner(CALLER), OKIND, "",
  { secret: JSON.stringify({ access_token: OLD, refresh_token: REFRESH, token_type: "Bearer" }) }, "admin");

const prevHosts = (await store.getRuntimeConfig()).allowed_internal_hosts ?? [];
//  콜백 주소(gateway_url)가 있어야 oauth 공급자를 만든다. 호스트를 127.0.0.1 로 두면 SSRF 가드가 «자기 자신» 으로 로컬 상류를 막으니 다른 이름을 쓴다.
const prevGateway = (await store.getOrgProfile()).gateway_url ?? null;
try {
  await store.updateRuntimeConfig({ allowed_internal_hosts: [...new Set([...prevHosts, "127.0.0.1"])] }, "admin", "web");
  await vault.setMemberSecret(vault.GATEWAY_OWNER, KIND, "", { secret: SECRET }, "admin");
  await store.upsertMcpServer({
    name: SERVER, transport: "http", url: URL_, mode: "proxy",
    scope: "items", level: "L0", auth_kind: KIND, pii_scrub: false, enabled: true,
  }, "admin", "web");

  const callTool = () => proxy.callProxyTool(SERVER, "anything", {}, CALLER);
  const refresh = () => proxy.refreshProxySnapshot(SERVER, "admin");
  for (const [row, phase, run] of [["R1", "initialize", callTool], ["R2", "tools/call", callTool], ["R3", "initialize", refresh]]) {
    failPhase = phase;
    const name = `${row} ${run === refresh ? "새로고침" : "툴 호출"} ${phase} 단계 상류 오류 — 주입 자격이 스크럽되고 [HTTP 500] 이 남는다`;
    try {
      await run();
      bad(name, "오류 없이 끝났다");
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes(SECRET)) bad(name, `자격이 오류에 남았다: ${msg}`);
      else if (!msg.includes("[REDACTED]") || !msg.includes("[HTTP 500]")) bad(name, `스크럽·status 표시가 없다: ${msg}`);
      else ok(name);
    }
  }

  // ── oauth 서버 ──
  await itemsPool.query(`INSERT INTO org_profile(id) VALUES(1) ON CONFLICT DO NOTHING`);
  await itemsPool.query(`UPDATE org_profile SET gateway_url=$1 WHERE id=1`, ["https://gateway.invalid"]);
  await vault.setMemberSecret(vault.GATEWAY_OWNER, OKIND, vault.CLIENT_SCOPE, { secret: JSON.stringify({ client_id: "pg-proxy-scrub-client" }) }, "admin");
  await store.upsertMcpServer({
    name: OSERVER, transport: "http", url: `${BASE}/oauth-mcp`, mode: "proxy",
    scope: "items", level: "L0", auth_kind: OKIND, auth_mode: "oauth", pii_scrub: false, enabled: true,
  }, "admin", "web");
  await store.setMcpToolsSnapshot(OSERVER, [{ name: "anything", inputSchema: { type: "object" } }], "admin");

  //  R4 — 등록된 툴 핸들러를 그대로 부른다(registerProxiedMcpTools 가 실패 문구를 만드는 자리).
  {
    const name = "R4 oauth 갱신 거절 — 등록된 프록시 툴 응답에 재연결 안내가 붙고 토큰이 남지 않는다";
    tokenMode = "reject"; oauthFail = "initialize";
    await seedOAuthTokens();
    const handlers = new Map();
    await proxy.registerProxiedMcpTools({ registerTool: (n, _cfg, h) => { handlers.set(n, h); } });
    const handler = handlers.get(proxy.proxyToolName(OSERVER, "anything"));
    if (!handler) bad(name, "oauth 프록시 툴이 등록되지 않았다");
    else {
      const out = await handler({}, { authInfo: { extra: { userId: CALLER, email: "", scopes: ["items"], projects: ["*"] } } });
      const text = String(out?.content?.[0]?.text ?? "");
      if (out?.isError !== true) bad(name, `실패로 답하지 않았다: ${text}`);
      else if (leaked(text).length) bad(name, `토큰이 응답에 남았다: ${text}`);
      else if (!text.includes(`me_oauth_connect {server: "${OSERVER}"}`)) bad(name, `재연결 안내가 없다: ${text}`);
      else ok(name);
    }
  }

  //  R5~R8 — 갱신은 성공하고(새 토큰을 금고에 저장) 새 토큰을 실은 요청이 그 헤더를 에코한다.
  tokenMode = "refresh";
  const oCall = () => proxy.callProxyTool(OSERVER, "anything", {}, CALLER);
  const oRefresh = () => proxy.refreshProxySnapshot(OSERVER, CALLER);
  for (const [row, phase, run] of [["R5", "initialize", oCall], ["R6", "initialize", oRefresh], ["R8", "tools/list", oRefresh]]) {
    oauthFail = phase;
    await seedOAuthTokens();
    const name = `${row} oauth ${run === oRefresh ? "새로고침" : "툴 호출"} — 연결 중 갱신된 새 토큰을 ${phase} 단계가 에코하며 실패해도 오류에 남지 않는다`;
    try {
      await run();
      bad(name, "오류 없이 끝났다");
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (leaked(msg).length) bad(name, `토큰이 오류에 남았다(${leaked(msg).map((s) => (s === NEW ? "새 토큰" : s === OLD ? "옛 토큰" : "그 밖")).join(", ")}): ${msg}`);
      else if (!msg.includes("[REDACTED]") || !msg.includes("[HTTP 500]")) bad(name, `스크럽·status 표시가 없다: ${msg}`);
      else ok(name);
    }
  }
  {
    const name = "R7 oauth 툴 호출 — 갱신된 새 토큰이 tools/call 의 정상 응답 본문에 에코돼도 지운다";
    oauthFail = "none";
    await seedOAuthTokens();
    try {
      const r = await oCall();
      const text = (r?.content ?? []).map((b) => String(b?.text ?? "")).join("\n");
      if (leaked(text).length) bad(name, `토큰이 응답에 남았다: ${text}`);
      else if (!text.includes("[REDACTED]")) bad(name, `스크럽 표시가 없다(상류가 에코하지 않았나): ${text}`);
      else ok(name);
    } catch (e) {
      bad(name, `호출이 실패했다: ${String(e?.message ?? e)}`);
    }
  }
} finally {
  await store.removeMcpServer(SERVER, "admin", "web").catch(() => {});
  await store.removeMcpServer(OSERVER, "admin", "web").catch(() => {});
  await vault.deleteMemberSecret(vault.GATEWAY_OWNER, KIND, "").catch(() => {});
  await vault.deleteMemberSecret(vault.GATEWAY_OWNER, OKIND, vault.CLIENT_SCOPE).catch(() => {});
  await vault.deleteMemberSecret(vault.memberOwner(CALLER), OKIND, "").catch(() => {});
  await vault.deleteMemberSecret(vault.memberOwner(CALLER), OKIND, vault.PKCE_SCOPE).catch(() => {});
  await itemsPool.query(`UPDATE org_profile SET gateway_url=$1 WHERE id=1`, [prevGateway]).catch(() => {});
  await store.updateRuntimeConfig({ allowed_internal_hosts: prevHosts }, "admin", "web").catch(() => {});
  upstream.close();
  await itemsPool.end();
}

console.log(`\nMCP-PROXY UPSTREAM-ERROR PG: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
