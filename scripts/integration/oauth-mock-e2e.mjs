// T2 OAuth 네트워크 E2E(#746) — 실 pg + 목 인가서버(RFC 8414/7591). vault-seam 이 못 덮는 네트워크 경로 검증:
//  startConsent(디스커버리→DCR→PKCE·authorize URL 생성) + finishConsent(code→token 교환→vault 저장).
//  SDK auth() 가 SSRF-가드 fetch(makeSsrfFetch, allowed_internal_hosts=127.0.0.1)로 목 AS 에 실제 HTTP 호출.
//  ⚠ gateway_url 은 목(127.0.0.1)과 다른 host 여야 함 — 같으면 self-host 가드가 목 호출을 차단(콜백 문자열 구성에만 쓰임).
// 실행: npm run build && CONNECTOR_SECRET_KEY=$(openssl rand -hex 32) \
//        ITEMS_DATABASE_URL='postgresql://postgres@localhost/oauth_test?host=/tmp/pg746&port=54329' node scripts/integration/oauth-mock-e2e.mjs
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 미설정"); process.exit(2); }
if (!process.env.CONNECTOR_SECRET_KEY) { console.error("CONNECTOR_SECRET_KEY 미설정"); process.exit(2); }
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const { initOrgSchema } = await import(path.join(DIST, "org/schema.js"));
const { itemsPool } = await import(path.join(DIST, "items/store.js"));
const store = await import(path.join(DIST, "org/store.js"));
const vault = await import(path.join(DIST, "org/member-secret-store.js"));
const oauth = await import(path.join(DIST, "org/oauth-broker.js"));

const ok = (m) => console.log("ok  " + m);
let step = "";
let META = null;
let tokenHits = 0, registerHits = 0;

// ── 목 인가서버 — 404(protected-resource) → 원점 AS 폴백, AS 메타데이터·DCR·토큰. authorize 는 테스트가 브라우저 대신 code 를 직접 넘김. ──
const drain = (req) => new Promise((r) => { req.on("data", () => {}); req.on("end", r); });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const json = (obj, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "POST") await drain(req);
  if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) return void res.writeHead(404).end(); // RFC 9728 미지원 → 원점 폴백
  if (u.pathname === "/.well-known/oauth-authorization-server") return void json(META);
  if (u.pathname === "/register" && req.method === "POST") { registerHits++; return void json({ client_id: "mock-client-id", token_endpoint_auth_method: "none", redirect_uris: ["https://gw.example.com/oauth/callback"] }, 201); }
  if (u.pathname === "/token" && req.method === "POST") { tokenHits++; return void json({ access_token: `mock-AT-${tokenHits}`, refresh_token: "mock-RT-0", token_type: "Bearer", expires_in: 3600, scope: "read" }); }
  res.writeHead(404).end();
});

try {
  step = "① initOrgSchema + allowed_internal_hosts(127.0.0.1) + gateway_url(목과 다른 host)";
  await initOrgSchema();
  await store.updateRuntimeConfig({ allowed_internal_hosts: ["127.0.0.1"] }, "admin", "web");
  await store.updateOrgProfile({ gateway_url: "https://gw.example.com" }, "admin", "web");
  ok(step);

  step = "② 목 인가서버 기동(127.0.0.1:ephemeral)";
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  META = { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] };
  ok(step + ` (:${port})`);

  step = "③ oauth proxy 서버 등록(url=목/mcp, auth_mode=oauth)";
  await store.upsertMcpServer({ name: "mocksrv", transport: "http", url: `${origin}/mcp`, mode: "proxy", scope: "items", level: "L1", auth_kind: "mock_oauth", auth_mode: "oauth", enabled: true }, "admin", "web");
  ok(step);

  step = "④ startConsent — 디스커버리→DCR→PKCE·authorize URL 생성";
  const r = await oauth.startConsent("u1", "mocksrv", "u1");
  if (r.authorized) throw new Error("토큰 없는데 authorized=true");
  if (!r.authorizationUrl || !r.state) throw new Error("authorizationUrl/state 누락");
  const au = new URL(r.authorizationUrl);
  if (au.host !== `127.0.0.1:${port}` || au.pathname !== "/authorize") throw new Error("authorize URL 대상 불일치: " + r.authorizationUrl);
  if (!au.searchParams.get("code_challenge") || au.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE 챌린지 누락");
  if (au.searchParams.get("client_id") !== "mock-client-id") throw new Error("DCR client_id 미반영");
  if (au.searchParams.get("state") !== r.state) throw new Error("authorize state 불일치");
  if (registerHits < 1) throw new Error("DCR(/register) 미호출");
  // PKCE verifier 가 vault 에 저장됐는지(콜백이 찾을 수 있게)
  const pkceRows = (await itemsPool.query("SELECT count(*)::int n FROM member_secret WHERE owner=$1 AND kind=$2 AND scope_key LIKE 'oauth:pkce:%'", [vault.memberOwner("u1"), "mock_oauth"])).rows[0].n;
  if (pkceRows < 1) throw new Error("PKCE verifier 미저장");
  ok(step + ` (client_id 발급, PKCE 저장, /register ${registerHits}회)`);

  step = "⑤ finishConsent — code→token 교환→vault 저장";
  const done = await oauth.finishConsent(r.state, "mock-auth-code-xyz", "u1");
  if (!done.ok || done.memberId !== "u1" || done.serverName !== "mocksrv") throw new Error("finishConsent 결과 이상: " + JSON.stringify(done));
  if (tokenHits < 1) throw new Error("토큰엔드포인트(/token) 미호출");
  ok(step + ` (/token ${tokenHits}회)`);

  step = "⑥ 토큰이 u1 vault(프록시 resolveMemberSecret 슬롯)에 저장됨";
  const resolved = await vault.resolveMemberSecret("u1", "mock_oauth", { scopeKey: "" });
  const tk = oauth.decodeTokenBlob(resolved?.secret);
  if (!tk || !String(tk.access_token).startsWith("mock-AT-")) throw new Error("교환된 토큰이 vault 에 없음");
  ok(step + ` (access_token=${tk.access_token})`);

  step = "⑦ 1회용 PKCE verifier 정리(finishConsent 후)";
  const pkceLeft = (await itemsPool.query("SELECT count(*)::int n FROM member_secret WHERE owner=$1 AND kind=$2 AND scope_key LIKE 'oauth:pkce:%'", [vault.memberOwner("u1"), "mock_oauth"])).rows[0].n;
  if (pkceLeft !== 0) throw new Error(`PKCE verifier 미정리(${pkceLeft})`);
  ok(step);

  console.log("\nOAUTH-MOCK(T2) NETWORK E2E ALL GREEN");
} catch (e) {
  console.error("FAIL @ " + step + " — " + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  await new Promise((r) => server.close(r));
  await itemsPool.end();
}
