// T2 OAuth 브로커 vault-seam E2E(#746) — 실 pg. 네트워크 OAuth 흐름(startConsent/finishConsent)이 의존하는
//  저장/연속성 시임을 검증: VaultOAuthProvider 왕복(토큰·클라정보·PKCE) + 암호화 at-rest + meta 토큰 미노출 +
//  프록시 호출경로(resolveMemberSecret 동일 슬롯) 픽업 + state 2-요청 연속성 + auth_mode 영속 + disconnect.
//  ⚠ 실제 인가서버 대상 code→token 교환은 별도 목-OAuth E2E(후속).
// 실행: npm run build && CONNECTOR_SECRET_KEY=$(openssl rand -hex 32) \
//        ITEMS_DATABASE_URL='postgresql://postgres@localhost/proxy_test?host=/tmp/pg746&port=54329' node scripts/integration/oauth-broker-pg.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.ITEMS_DATABASE_URL) { console.error("ITEMS_DATABASE_URL 미설정(스크래치 pg)"); process.exit(2); }
if (!process.env.CONNECTOR_SECRET_KEY) { console.error("CONNECTOR_SECRET_KEY 미설정"); process.exit(2); }
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const { initOrgSchema } = await import(path.join(DIST, "org/schema.js"));
const { itemsPool } = await import(path.join(DIST, "items/store.js"));
const store = await import(path.join(DIST, "org/store.js"));
const vault = await import(path.join(DIST, "org/member-secret-store.js"));
const oauth = await import(path.join(DIST, "org/oauth-broker.js"));
const proxy = await import(path.join(DIST, "capabilities/mcp-proxy.js"));

let step = "";
const ok = (m) => console.log("ok  " + m);
const TOKENS = { access_token: "at-LIVE-abcdefgh", refresh_token: "rt-LIVE-ijklmnop", token_type: "bearer", expires_in: 3600, scope: "read" };
try {
  step = "① initOrgSchema + org profile gateway_url(콜백 URL 소스)";
  await initOrgSchema();
  await store.updateOrgProfile({ gateway_url: "https://gw.example.com" }, "admin", "web");
  if ((await store.getOrgProfile()).gateway_url !== "https://gw.example.com") throw new Error("gateway_url 저장 실패");
  ok(step);

  step = "② auth_mode 영속 — oauth proxy 서버 upsert + bearer 기본 null";
  await store.upsertMcpServer({ name: "notion", transport: "http", url: "https://mcp.notion.com/mcp", mode: "proxy", scope: "items", level: "L1", auth_kind: "notion_oauth", auth_mode: "oauth", enabled: true }, "admin", "web");
  const srv = await store.getMcpServer("notion");
  if (srv.auth_mode !== "oauth" || srv.auth_kind !== "notion_oauth") throw new Error("auth_mode 왕복 실패 " + JSON.stringify(srv));
  await store.upsertMcpServer({ name: "bearersrv", transport: "http", url: "https://x.example.com/mcp", mode: "proxy", auth_kind: "x_tok", enabled: true }, "admin", "web");
  if ((await store.getMcpServer("bearersrv")).auth_mode !== null) throw new Error("bearer 기본 auth_mode 는 null 이어야");
  ok(step);

  step = "③ VaultOAuthProvider 왕복 — clientInfo·tokens·PKCE 저장/재로드";
  const p = new oauth.VaultOAuthProvider({ memberId: "u1", serverName: "notion", authKind: "notion_oauth", tokenScopeKey: "", redirectUrl: "https://gw.example.com/oauth/callback", actor: "u1" });
  await p.saveClientInformation({ client_id: "cid-123", client_secret: "csecret-xyz", redirect_uris: ["https://gw.example.com/oauth/callback"] });
  const ci = await p.clientInformation();
  if (!ci || ci.client_id !== "cid-123") throw new Error("clientInformation 왕복 실패");
  await p.saveTokens(TOKENS);
  const tk = await p.tokens();
  if (!tk || tk.access_token !== TOKENS.access_token || tk.refresh_token !== TOKENS.refresh_token) throw new Error("tokens 왕복 실패");
  await p.saveCodeVerifier("verifier-ABCDEFGHIJKLMNOP");
  if ((await p.codeVerifier()) !== "verifier-ABCDEFGHIJKLMNOP") throw new Error("codeVerifier 왕복 실패");
  ok(step);

  step = "④ 암호화 at-rest + meta 토큰 미노출(평문 meta 로 토큰 유출 금지)";
  const row = (await itemsPool.query("SELECT secret_enc, meta FROM member_secret WHERE owner=$1 AND kind=$2 AND scope_key=$3", [vault.memberOwner("u1"), "notion_oauth", ""])).rows[0];
  if (!row || !String(row.secret_enc).startsWith("gcm$")) throw new Error("토큰이 암호화 저장되지 않음");
  const meta = row.meta || {};
  if (typeof meta.expires_at !== "number") throw new Error("meta.expires_at 없음");
  if ("access_token" in meta || "refresh_token" in meta) throw new Error("평문 meta 에 토큰 유출!");
  ok(step);

  step = "⑤ 프록시 호출경로 연속성 — resolveMemberSecret(동일 슬롯)이 토큰 블롭 픽업";
  const resolved = await vault.resolveMemberSecret("u1", "notion_oauth", { scopeKey: "" });
  const decoded = oauth.decodeTokenBlob(resolved?.secret);
  if (!decoded || decoded.access_token !== TOKENS.access_token) throw new Error("프록시 경로가 토큰을 못 읽음");
  ok(step);

  step = "⑥ state 2-요청 연속성 — start provider 의 state 로 callback provider 가 동일 PKCE verifier 조회";
  const pA = new oauth.VaultOAuthProvider({ memberId: "u2", serverName: "notion", authKind: "notion_oauth", tokenScopeKey: "", redirectUrl: "https://gw.example.com/oauth/callback" });
  const stateTok = pA.state();
  await pA.saveCodeVerifier("verifier-U2-QRSTUVWXYZ012345");
  const sp = oauth.verifyState(stateTok);
  if (sp.m !== "u2" || sp.s !== "notion") throw new Error("state 문맥 불일치");
  const pB = new oauth.VaultOAuthProvider({ memberId: sp.m, serverName: sp.s, authKind: "notion_oauth", tokenScopeKey: sp.k, redirectUrl: "https://gw.example.com/oauth/callback", state: stateTok });
  if ((await pB.codeVerifier()) !== "verifier-U2-QRSTUVWXYZ012345") throw new Error("callback provider 가 PKCE verifier 를 못 찾음(nonce 연속성 실패)");
  ok(step);

  step = "⑦ providerForServer — gateway_url 기반 콜백 redirectUrl 구성";
  const pf = await oauth.providerForServer("u1", srv, "u1");
  if (pf.redirectUrl !== "https://gw.example.com/oauth/callback") throw new Error("redirectUrl 구성 실패: " + pf.redirectUrl);
  if (!(await pf.tokens())) throw new Error("providerForServer 가 기존 토큰을 못 읽음");
  ok(step);

  step = "⑧ OAuth 분기 가드(#2) — callerId 없음/미연결은 per-user 로 차단(통합 폴백 사칭 없음)";
  // callProxyTool 은 callUpstream 의 oauth 분기를 탄다. 두 경우 모두 상류 접속 '전에' 차단(네트워크 없음).
  let g1 = false;
  try { await proxy.callProxyTool("notion", "search", {}, null); } catch (e) { if (/개인 연결/.test(String(e.message))) g1 = true; else throw e; }
  if (!g1) throw new Error("callerId=null 이 차단되지 않음");
  let g2 = false;
  try { await proxy.callProxyTool("notion", "search", {}, "u_noconn"); } catch (e) { if (/미연결/.test(String(e.message))) g2 = true; else throw e; }
  if (!g2) throw new Error("미연결 멤버가 차단되지 않음(통합 폴백 사칭 위험)");
  ok(step);

  step = "⑨ disconnect — 토큰 삭제";
  const del = await vault.deleteMemberSecret(vault.memberOwner("u1"), "notion_oauth", "");
  if (!del) throw new Error("토큰 삭제 실패");
  if (await (new oauth.VaultOAuthProvider({ memberId: "u1", serverName: "notion", authKind: "notion_oauth", tokenScopeKey: "", redirectUrl: "https://gw.example.com/oauth/callback" }).tokens())) throw new Error("삭제 후에도 토큰 조회됨");
  ok(step);

  console.log("\nOAUTH-BROKER(T2) VAULT-SEAM ALL GREEN");
} catch (e) {
  console.error("FAIL @ " + step + " — " + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  await itemsPool.end();
}
