// NAS 접속 PG 통합 시험 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/net/nas/nas-access.pg-test.mjs
//  (금고 암호화 키가 없으면 이 시험이 시험용 키를 쓴다 — 실제 키는 필요 없다.)
//
// 왜 이 계층인가: 아래 불변식은 금고(member_secret)의 실제 칸 · 실제 웹 세션 · 실제 토큰이 있어야 참·거짓이 갈린다.
//  «폴백하지 않는다» 를 목으로 보면 목이 폴백을 안 하는 것만 보게 된다. 주소 가드 · 색인 키 · 오류 분류 · 매니지드 차단은
//  DB 없이 nas-access.test · capabilities/nas-files.test 가 본다.
//
//  사양 행:
//   R1 로그인은 구성원 본인 칸만 — 관리자(게이트웨이) 칸에 nas_ftp(공용 계정)가 있어도 폴백하지 않는다(404). 본인 칸을 넣으면 그 아이디
//   R2 서버 주소는 관리자 칸만 — 구성원 칸의 nas_ftp_server 만 있으면 503(미설정), 둘 다 있으면 관리자 칸의 host·port
//   R3 내려받기(실제 서버 listen(0)) — 쿠키 없음 401 · 그 구성원의 유효한 Bearer 만 401 · 유효한 쿠키여도 p 에 `..` 마디면 400
//   R4 매니지드 게이트웨이에서는 로그인한 쿠키 · 정상 경로여도 내려받기가 자체 호스팅 안내(501)
//   R5 nas_find — 이전 색인이 있는데 다시 만들기가 실패하면(DNS 실패 — 원문에 호스트 이름) 이전 결과로 답하고,
//      last_error 는 분류 문구이며 응답 어디에도 원문 조각이 없다
//      (호스트는 RFC 6761 의 .invalid — 리졸버가 늘 «없음» 으로 답하는 이름이라 네트워크 상태와 무관하게 조회가 실패한다)
if (!process.env.CONNECTOR_SECRET_KEY?.trim()) process.env.CONNECTOR_SECRET_KEY = "1678".repeat(16);
delete process.env.LIVELY_TENANT_HEADER_SECRET; // 매니지드 판정의 근거 — R4 에서만 켠다

const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { initAllSchemas } = await import(`${DIST}/boot/schemas.js`);
const store = await import(`${DIST}/org/credentials/member-secret-store.js`);
const nas = await import(`${DIST}/net/nas/nas-access.js`);
const { registerNasDownloadRoute } = await import(`${DIST}/net/nas/nas-download-route.js`);
const { nasFileCapabilities } = await import(`${DIST}/capabilities/nas-files.js`);
const { createSession } = await import(`${DIST}/auth/sessions.js`);
const tok = await import(`${DIST}/org/store/tokens.js`);
const express = (await import("express")).default;

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
// 던져도 다음 행으로 넘어간다 — 한 행의 실패가 뒤 행들의 판정을 가리지 않게(실패는 그 행의 FAIL 로 남는다)
const settle = (fn) => Promise.resolve().then(fn).then((v) => ({ v }), (e) => ({ e }));

const MID = "__nas1678_member__";
const G = store.GATEWAY_OWNER;
const M = store.memberOwner(MID);
const ACTOR = MID;
const NAS_HOST = "nas-pg1678.invalid";
const RAW_FRAGMENTS = ["ENOTFOUND", "EAI_AGAIN", "getaddrinfo", "nas-pg1678"];

async function cleanup() {
  for (const owner of [G, M]) for (const kind of [nas.NAS_SERVER_KIND, nas.NAS_LOGIN_KIND]) await store.deleteMemberSecret(owner, kind, "");
  await itemsPool.query(`DELETE FROM web_session WHERE member_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM auth_token WHERE member_id=$1 OR user_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE actor=$1`, [ACTOR]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [MID]);
}

let server = null;
try {
  await initAllSchemas({ quiet: true });
  await cleanup();

  // ── R1 로그인은 구성원 본인 칸만 ──────────────────────────────────────────────────────────
  await store.setMemberSecret(G, nas.NAS_SERVER_KIND, "", { meta: { host: NAS_HOST, port: 21 } }, ACTOR);
  await store.setMemberSecret(G, nas.NAS_LOGIN_KIND, "", { secret: "shared-pw", meta: { username: "shared" } }, ACTOR);
  {
    const r = await settle(() => nas.resolveNasAccess(MID));
    chk("R1a ★ 관리자 칸에 공용 nas_ftp 가 있어도 본인 칸이 없으면 404(폴백 없음)",
      r.e instanceof nas.NasConfigError && r.e.status === 404, `got=${r.e ? `${r.e.name} ${r.e.status}` : JSON.stringify(r.v?.login?.username)}`);
  }
  await store.setMemberSecret(M, nas.NAS_LOGIN_KIND, "", { secret: "mine-pw", meta: { username: "mine" } }, ACTOR);
  {
    const r = await settle(() => nas.resolveNasAccess(MID));
    chk("R1b 본인 칸을 넣으면 그 아이디·비밀번호", r.v?.login?.username === "mine" && r.v?.login?.password === "mine-pw",
      `got=${r.e ? r.e.message : r.v?.login?.username}`);
  }

  // ── R2 서버 주소는 관리자 칸만 ────────────────────────────────────────────────────────────
  await store.deleteMemberSecret(G, nas.NAS_SERVER_KIND, "");
  await store.setMemberSecret(M, nas.NAS_SERVER_KIND, "", { meta: { host: "10.66.0.1", port: 21 } }, ACTOR);
  {
    const r = await settle(() => nas.resolveNasAccess(MID));
    chk("R2a ★ 구성원 칸의 nas_ftp_server 만 있으면 미설정(503) — 구성원이 정한 주소로 붙지 않는다",
      r.e instanceof nas.NasConfigError && r.e.status === 503, `got=${r.e ? `${r.e.name} ${r.e.status}` : JSON.stringify(r.v?.server)}`);
  }
  await store.setMemberSecret(G, nas.NAS_SERVER_KIND, "", { meta: { host: NAS_HOST, port: 2121 } }, ACTOR);
  {
    const r = await settle(() => nas.resolveNasAccess(MID));
    chk("R2b 관리자 칸과 구성원 칸이 둘 다 있으면 관리자 칸의 host·port",
      r.v?.server?.host === NAS_HOST && r.v?.server?.port === 2121, `got=${r.e ? r.e.message : JSON.stringify(r.v?.server)}`);
  }

  // ── R3·R4 내려받기 라우트 ─────────────────────────────────────────────────────────────────
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
       VALUES($1,'human','NAS 시험','nas1678@example.invalid','active',$2::jsonb)
     ON CONFLICT (tenant_id, id) DO UPDATE SET kind='human', state='active', scopes=$2::jsonb`,
    [MID, JSON.stringify(["memory"])],
  );
  const { sessionId } = await createSession(MID);
  const minted = await tok.mintToken({ userId: MID, scopes: ["memory"], label: "nas1678", memberId: MID }, ACTOR, "pgtest");
  const app = express();
  registerNasDownloadRoute(app);
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}${nas.NAS_DOWNLOAD_PATH}`;
  const p = (raw) => Buffer.from(raw, "latin1").toString("base64url");
  const get = async (raw, headers = {}) => {
    const res = await fetch(`${base}?p=${p(raw)}`, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const cookie = { cookie: `lively_sess=${sessionId}` };
  {
    const r = await get("/docs/a.txt");
    chk("R3a 쿠키 없음 401", r.status === 401, `status=${r.status}`);
  }
  {
    const valid = await tok.verifyDbToken(minted.token);
    chk("R3b0 (배선) 그 Bearer 토큰은 유효한 토큰이다", valid !== null, "verifyDbToken=null");
    const r = await get("/docs/a.txt", { authorization: `Bearer ${minted.token}` });
    chk("R3b ★ 유효한 Bearer 만 있으면 401 — AI 세션의 토큰으로 본문을 받지 못한다", r.status === 401, `status=${r.status}`);
  }
  {
    const r = await get("/a/../b", cookie);
    chk("R3c 유효한 쿠키여도 p 에 .. 마디면 400", r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);
    const passed = await get("/docs/a.txt", cookie);
    chk("R3c0 (배선) 같은 쿠키·정상 경로는 인증·경로 검사를 지난다(그 뒤 NAS 접속 실패 502)", passed.status === 502,
      `status=${passed.status} body=${JSON.stringify(passed.body)}`);
  }
  process.env.LIVELY_TENANT_HEADER_SECRET = "nas1678-managed";
  try {
    const r = await get("/docs/a.txt", cookie);
    chk("R4 ★ 매니지드에서는 로그인한 쿠키·정상 경로여도 자체 호스팅 안내(501)",
      r.status === 501 && r.body?.error === nas.NAS_MANAGED_OFF, `status=${r.status} body=${JSON.stringify(r.body)}`);
  } finally {
    delete process.env.LIVELY_TENANT_HEADER_SECRET;
  }

  // ── R5 nas_find — 이전 색인 + 다시 만들기 실패 ────────────────────────────────────────────
  {
    const find = nasFileCapabilities.find((c) => c.name === "nas_find");
    const user = { userId: MID, email: "nas1678@example.invalid", scopes: ["memory"], projects: ["*"], tokenSource: "db" };
    const key = nas.nasIndexKey(MID, "mine", { host: NAS_HOST, port: 2121 });
    const entry = { raw: "/계약/2024 약정서.pdf", path: "/계약/2024 약정서.pdf", type: "file", size: 10, mtime: "2024-01-01" };
    await nas.nasIndexCache.build(key, async () => ({ entries: [entry], dirs: 1, truncated: null, failedDirs: 0 }));
    const r = await settle(() => find.handler({ q: "약정서", refresh: true }, user));
    const out = r.v;
    chk("R5a 이전 색인으로 답한다", out?.total === 1 && out?.items?.[0]?.path === entry.path,
      `got=${r.e ? `${r.e.status} ${r.e.message}` : JSON.stringify(out)}`);
    const lastError = out?.index?.last_error;
    chk("R5b 다시 만들기 실패는 last_error 로 알린다(분류 문구)", typeof lastError === "string" && lastError.length > 0, `last_error=${lastError}`);
    const text = JSON.stringify(out ?? r.e?.message ?? "");
    const leaked = RAW_FRAGMENTS.filter((f) => text.includes(f));
    chk("R5c ★ 응답 어디에도 원문(DNS 오류·호스트 이름)이 없다", leaked.length === 0, `leaked=${leaked.join(",")} last_error=${lastError}`);
    nas.nasIndexCache.drop(key);
  }
} catch (e) {
  bad("예외", e?.stack ?? String(e));
} finally {
  if (server) await new Promise((r) => server.close(() => r()));
  await cleanup().catch((e) => console.error("cleanup 실패:", e?.message ?? e));
  await itemsPool.end().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
