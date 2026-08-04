// #1473 T2 — OAuth 2.1 인가서버 **전 구간 HTTP 통합**(실 게이트웨이 프로세스 + 실 Postgres).
//  ②계층(itest): `node scripts/run-tests.mjs --itest` 또는 수동:
//    npm run build && node --env-file=.env scripts/oauth-flow.itest.mjs
//
//  이 계층이 아니면 못 잡는 것: 라우터 마운트 순서·메타데이터 경로·302 왕복·form 파싱·쿠키 세션·
//  SDK 의 PKCE 검증·발급 토큰으로 실제 /mcp 가 열리는지. 스토어 유닛(oauth.pg-test.mjs)은 그 위층을 못 본다.
//
//  검증 순서 = MCP 클라이언트가 실제로 밟는 순서다:
//   ① 인증 없이 /mcp → 401 + WWW-Authenticate 의 resource_metadata
//   ② 그 주소로 PRM 조회 → authorization_servers
//   ③ AS 메타데이터 조회(RFC 8414) → authorize/token/register 엔드포인트 + S256 지원
//   ④ DCR 등록 → ⑤ /authorize → 동의 화면 → 로그인 → 승인 → code
//   ⑥ /token(PKCE) → 액세스+리프레시 → ⑦ 그 토큰으로 /mcp 초기화 성공
//   ⑧ 리프레시 회전 → ⑨ 남의 자원(resource) 요청은 invalid_target
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const b64url = (b) => Buffer.from(b).toString("base64url");
const s256 = (v) => crypto.createHash("sha256").update(v).digest("base64url");

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MID = "__oauth_itest__";
const EMAIL = "__oauth_itest__@example.invalid";
const PASSWORD = "itest-pw-" + crypto.randomBytes(6).toString("hex");
const REDIR = "https://client.invalid/cb";

let child = null;
try {
  if (!process.env.ITEMS_DATABASE_URL) throw new Error("ITEMS_DATABASE_URL 필요(--env-file 로 주입)");

  // ── 구성원 + 로컬 비밀번호 시드(동의 화면 로그인용) ──
  const { itemsPool } = await import(`${ROOT}/dist/db/client.js`);
  const { initAllSchemas } = await import(`${ROOT}/dist/boot/schemas.js`);
  const { setMemberPassword } = await import(`${ROOT}/dist/auth/local-accounts.js`);
  await initAllSchemas({ quiet: true });
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
       VALUES($1,'human','OAuth통합테스트',$2,'active','["items","context","admin"]'::jsonb)
     ON CONFLICT (id) DO UPDATE SET state='active', email=$2, scopes='["items","context","admin"]'::jsonb`,
    [MID, EMAIL]);
  await setMemberPassword(MID, PASSWORD, { mustChange: false, actor: "itest" });

  // ── 게이트웨이 기동 ──
  const port = await freePort();
  const BASE = `http://localhost:${port}`;
  child = spawn(process.execPath, [`${ROOT}/dist/index.js`], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PUBLIC_URL: BASE, LIVELY_NO_SCHEDULER: "1", LOG_LEVEL: "error" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = "";
  child.stdout.on("data", (d) => { boot += d; });
  child.stderr.on("data", (d) => { boot += d; });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) { up = true; break; } } catch { /* 아직 */ }
    await sleep(500);
  }
  if (!up) throw new Error(`게이트웨이 기동 실패:\n${boot.slice(-2000)}`);

  const F = (p, init) => fetch(p.startsWith("http") ? p : BASE + p, { redirect: "manual", ...init });

  // ── ① 인증 없이 /mcp → 401 + 인가서버 발견 경로 ──
  const unauth = await F("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
  chk("① 미인증 /mcp → 401", unauth.status === 401, `status=${unauth.status}`);
  const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
  chk("① ★ 401 이 PRM 주소를 가리킨다", prmUrl === `${BASE}/.well-known/oauth-protected-resource/mcp`, `wwwAuth=${wwwAuth}`);

  // ── ② PRM(경로형 + 루트 별칭) ──
  const prm = await (await F(prmUrl)).json();
  chk("② PRM: resource = <base>/mcp", prm.resource === `${BASE}/mcp`, JSON.stringify(prm));
  chk("② PRM: authorization_servers 가 채워진다", Array.isArray(prm.authorization_servers) && prm.authorization_servers.length === 1, JSON.stringify(prm));
  const prmRootRes = await F("/.well-known/oauth-protected-resource");
  chk("② ★ 루트 별칭도 200(origin 을 자원으로 보는 클라이언트 대비)", prmRootRes.status === 200, `status=${prmRootRes.status}`);
  const prmRoot = await prmRootRes.json();
  // ★ 별칭이 정본과 **한 글자라도** 다르면 안 된다 — issuer 는 문자열 동등 비교 대상이라(RFC 8414/9207)
  //  말미 슬래시 하나로 클라이언트가 "다른 인가서버"로 판정한다. 실제로 첫 구현이 여기서 어긋났다.
  chk("② ★ 루트 별칭 문서 == 정본 문서(드리프트 금지)", JSON.stringify(prmRoot) === JSON.stringify(prm),
    `root=${JSON.stringify(prmRoot)}\n      canonical=${JSON.stringify(prm)}`);

  // ── ③ AS 메타데이터(RFC 8414) ──
  const as = await (await F("/.well-known/oauth-authorization-server")).json();
  chk("③ ★ PRM 이 가리킨 issuer 와 AS 메타데이터의 issuer 가 문자열까지 일치",
    as.issuer === prm.authorization_servers[0], `as=${as.issuer} prm=${prm.authorization_servers[0]}`);
  chk("③ ★ code_challenge_methods_supported=S256(없으면 클라이언트가 진행을 거부)",
    Array.isArray(as.code_challenge_methods_supported) && as.code_challenge_methods_supported.includes("S256"));
  chk("③ authorization/token/registration 엔드포인트 광고",
    as.authorization_endpoint === `${BASE}/authorize` && as.token_endpoint === `${BASE}/token` && as.registration_endpoint === `${BASE}/register`,
    JSON.stringify(as));

  // ── ④ DCR ──
  const reg = await F("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIR], client_name: "OAuth itest", token_endpoint_auth_method: "none" }),
  });
  const client = await reg.json();
  chk("④ DCR 등록 201", reg.status === 201, `status=${reg.status} body=${JSON.stringify(client)}`);
  chk("④ client_id 발급", typeof client.client_id === "string" && client.client_id.length > 0);

  // ── ⑤ 인가 → 동의 → 승인 ──
  const verifier = b64url(crypto.randomBytes(32));
  const authUrl = `/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}`
    + `&redirect_uri=${encodeURIComponent(REDIR)}&code_challenge=${s256(verifier)}&code_challenge_method=S256`
    + `&scope=${encodeURIComponent("items context admin")}&state=st-42&resource=${encodeURIComponent(`${BASE}/mcp`)}`;
  const authRes = await F(authUrl);
  chk("⑤ /authorize → 동의 화면으로 302", authRes.status === 302, `status=${authRes.status}`);
  const consentLoc = authRes.headers.get("location") ?? "";
  chk("⑤ 동의 URL 형태", consentLoc.startsWith("/oauth/consent?rid="), consentLoc);

  const consentGet = await F(consentLoc);
  const consentHtml = await consentGet.text();
  chk("⑤ 미인증이면 로그인 폼", consentGet.status === 200 && consentHtml.includes('name="action" value="login"'), `status=${consentGet.status}`);

  const rid = new URL(consentLoc, BASE).searchParams.get("rid");
  const loginRes = await F("/oauth/consent", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ rid, action: "login", email: EMAIL, password: PASSWORD }).toString(),
  });
  chk("⑤ 로그인 → 303(PRG)", loginRes.status === 303, `status=${loginRes.status}`);
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  chk("⑤ 세션 쿠키 발급", cookie.includes("lively_sess="), cookie);

  const consent2 = await (await F(consentLoc, { headers: { cookie } })).text();
  chk("⑤ ★ 동의 화면이 부여 권한을 보여준다", consent2.includes("부여되는 권한") && consent2.includes("(items)"), consent2.slice(0, 400));
  chk("⑤ ★ 외부 앱에는 admin 을 주지 않는다(요청했지만 목록에 없음)", !consent2.includes("(admin)"));

  const approve = await F("/oauth/consent", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ rid, action: "approve" }).toString(),
  });
  chk("⑤ 승인 → 클라이언트로 302", approve.status === 302, `status=${approve.status}`);
  const back = new URL(approve.headers.get("location"));
  chk("⑤ code + state 회신", !!back.searchParams.get("code") && back.searchParams.get("state") === "st-42", back.href);
  const code = back.searchParams.get("code");

  // ── ⑥ 토큰 교환(PKCE) ──
  const tokenForm = (extra) => new URLSearchParams({ client_id: client.client_id, ...extra }).toString();
  const wrongPkce = await F("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm({ grant_type: "authorization_code", code, code_verifier: "wrong-verifier", redirect_uri: REDIR }),
  });
  chk("⑥ ★ 틀린 code_verifier → 거부", wrongPkce.status === 400, `status=${wrongPkce.status}`);

  const tokRes = await F("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIR, resource: `${BASE}/mcp` }),
  });
  const tok = await tokRes.json();
  chk("⑥ 토큰 교환 200", tokRes.status === 200, `status=${tokRes.status} body=${JSON.stringify(tok)}`);
  chk("⑥ 액세스+리프레시+만료", !!tok.access_token && !!tok.refresh_token && tok.expires_in === 3600, JSON.stringify(tok));
  chk("⑥ ★ 실제 발급 scope 회신(admin 제외)", tok.scope === "items context", `scope=${tok.scope}`);

  // ── ⑦ 발급 토큰으로 /mcp 가 실제로 열린다 ──
  const mcp = await F("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tok.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-itest", version: "0" } },
    }),
  });
  const mcpBody = await mcp.text();
  chk("⑦ ★ OAuth 토큰으로 MCP initialize 성공", mcp.status === 200 && mcpBody.includes("serverInfo"), `status=${mcp.status} body=${mcpBody.slice(0, 300)}`);

  // ── ⑧ 리프레시 회전 ──
  const ref1 = await F("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm({ grant_type: "refresh_token", refresh_token: tok.refresh_token }),
  });
  const tok2 = await ref1.json();
  chk("⑧ 리프레시 200 + 새 리프레시로 회전", ref1.status === 200 && tok2.refresh_token && tok2.refresh_token !== tok.refresh_token,
    `status=${ref1.status} body=${JSON.stringify(tok2)}`);
  const ref2 = await F("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenForm({ grant_type: "refresh_token", refresh_token: tok.refresh_token }),
  });
  chk("⑧ ★ 회전된 옛 리프레시 재사용 → 거부", ref2.status === 400, `status=${ref2.status}`);
  const afterReplay = await F("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok2.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
  });
  chk("⑧ ★ 재사용 감지 → 그 조합 토큰 전량 회수(방금 받은 액세스도 죽는다)", afterReplay.status === 401, `status=${afterReplay.status}`);

  // ── ⑨ 남의 자원 지정은 거부(RFC 8707 invalid_target) ──
  const badTarget = await F(`/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}`
    + `&redirect_uri=${encodeURIComponent(REDIR)}&code_challenge=${s256(verifier)}&code_challenge_method=S256`
    + `&state=st-9&resource=${encodeURIComponent("https://evil.invalid/mcp")}`);
  const badLoc = badTarget.headers.get("location") ?? "";
  chk("⑨ ★ 남의 자원 요청 → invalid_target 으로 리다이렉트",
    badTarget.status === 302 && badLoc.startsWith(REDIR) && badLoc.includes("error=invalid_target"), `status=${badTarget.status} loc=${badLoc}`);

  // ── ⑩ 무회귀 — 종전 lvk_ 토큰(만료·클라이언트·대상 전부 없음)은 그대로 통한다. ──
  //  로컬 하네스(Claude Code·CLI)가 쓰는 경로다. audience 검사나 만료 검사가 이걸 막으면 전 사용자가 끊긴다.
  {
    const { mintToken } = await import(`${ROOT}/dist/org/store/tokens.js`);
    const legacy = await mintToken({ userId: MID, scopes: ["items", "context"], memberId: MID, label: "itest-legacy" });
    const r = await F("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${legacy.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "0" } } }),
    });
    chk("⑩ ★ 종전 lvk_ Bearer 무회귀(로컬 하네스 경로)", r.status === 200, `status=${r.status}`);
  }

  // 정리
  await itemsPool.query(`DELETE FROM oauth_auth_code WHERE client_id=$1`, [client.client_id]);
  await itemsPool.query(`DELETE FROM oauth_auth_request WHERE client_id=$1`, [client.client_id]);
  await itemsPool.query(`DELETE FROM oauth_refresh WHERE client_id=$1`, [client.client_id]);
  await itemsPool.query(`DELETE FROM oauth_client WHERE client_id=$1`, [client.client_id]);
  await itemsPool.query(`DELETE FROM auth_token WHERE member_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM web_session WHERE member_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [MID]).catch(() => {});
  await itemsPool.end();
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  if (child) child.kill("SIGTERM");
}

console.log(`\noauth flow itest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
