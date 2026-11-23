// #5712 비위험 권한 추종 — 로그인 토큰이 구성원의 지금 권한을 따르는가. **실제 Postgres 필요**(run-tests --pg).
//    npm run build && node --env-file=.env src/org/store/token-follow-safe.pg-test.mjs
//  목으로는 못 보는 것을 본다: 인증 쿼리(verifyDbToken)가 칸을 읽는 길 · 디바이스 로그인의 한 트랜잭션(consume + 발급) ·
//  칸이 아직 없는 롤 창(발급이 깨지지 않고 표시 없이 굽는다 · SAVEPOINT 뒤 트랜잭션이 살아 있다) · 칸이 생기는 순간의 한 번뿐인 백필 ·
//  승인 · 본인 발급 · 관리자 발급 핸들러가 «따라도 되는 자격» 을 실제로 가르는가(배선).
//  ★ G 구간은 칸을 **지우지 않고 이름을 바꿔 치워 두었다가 되돌린다** — 이 DB 의 다른 토큰에 달린 표시를 잃지 않는다.
import crypto from "node:crypto";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const da = await import(`${DIST}/org/auth/device-auth.js`);
const store = await import(`${DIST}/org/store.js`);
const { initOrgCore } = await import(`${DIST}/org/schema/core.js`);
const caps = await import(`${DIST}/capabilities/delivery/tokens-devices.js`);
const cap = (name) => [...caps.tokenMintCapabilities, ...caps.deviceAuthCapabilities].find((c) => c.name === name);

const s256 = (v) => crypto.createHash("sha256").update(v).digest("base64url");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());

const MID = "__follow_safe_pg_test__";
const LABEL = "pgtest-follow-safe";
const ALL_SAFE = ["items", "context", "db", "memory", "code"];
async function setMember(scopes, state = "active") {
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
       VALUES($1,'human','추종테스트','__follow_safe_pg_test__@example.invalid',$3,$2::jsonb)
     ON CONFLICT (tenant_id, id) DO UPDATE SET scopes=$2::jsonb, state=$3`,
    [MID, JSON.stringify(scopes), state],
  );
}
async function cleanup() {
  await itemsPool.query(`DELETE FROM pending_device_auth WHERE client_label=$2 OR member_id=$1`, [MID, LABEL]);
  await itemsPool.query(`DELETE FROM auth_token WHERE member_id=$1 OR user_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [MID]);
}
const flagOf = async (token) => (await itemsPool.query(`SELECT follow_safe_scopes AS f, scopes FROM auth_token WHERE token_hash=$1`, [sha(token)])).rows[0];
const eff = async (token) => (await store.verifyDbToken(token))?.scopes ?? null;
/** 디바이스 로그인 한 바퀴 — 개시 → 승인 → 수령. */
async function deviceLogin(approverScopes, includeControlPlane, followSafe) {
  const v = crypto.randomBytes(32).toString("base64url");
  const st = await da.startDeviceAuth(s256(v), LABEL, "https://x");
  await da.approveDeviceAuth(st.user_code, MID, approverScopes, includeControlPlane, followSafe);
  return da.pollDeviceAuth(st.device_code, v);
}
/** 옛 판이 구운 토큰을 흉내 낸다 — 새 칸을 건드리지 않고 행만 넣는다. createdBy 기본 = 본인(디바이스 로그인 · 본인 발급이 그렇게 적는다). */
async function legacyToken(label, o = {}) {
  const token = "lvk_" + crypto.randomBytes(24).toString("base64url");
  await itemsPool.query(
    `INSERT INTO auth_token(token_hash, user_id, scopes, label, member_id, follow_member_scopes, revoked_at, created_by, client_id, app_id)
       VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10)`,
    [sha(token), MID, JSON.stringify(o.scopes ?? ["items", "context"]), label, o.noMember ? null : MID, o.followAll === true, o.revoked ? new Date() : null,
     o.createdBy === undefined ? MID : o.createdBy, o.clientId ?? null, o.appId ?? null],
  );
  return token;
}
/** 요청 사용자 객체 — 게이트웨이가 토큰을 검증해 만드는 것과 같은 꼴(auth/bearer.ts: 검증 결과 + tokenSource:'db'). */
async function dbUser(token) {
  const { clientId, resource, expiresAt, appId, ...identity } = await store.verifyDbToken(token);
  return { ...identity, tokenSource: "db", ...(clientId ? { oauthClientId: clientId } : {}), ...(appId ? { appId } : {}) };
}
const sessionUser = (scopes) => ({ userId: MID, email: "", scopes, projects: ["*"], tokenSource: "session" });
/** 핸들러로 하는 디바이스 로그인 — 개시 → device_approve 핸들러 → 수령. */
async function deviceLoginVia(user, body = {}) {
  const v = crypto.randomBytes(32).toString("base64url");
  const st = await da.startDeviceAuth(s256(v), LABEL, "https://x");
  await cap("device_approve").handler({ user_code: st.user_code, ...body }, user);
  return da.pollDeviceAuth(st.device_code, v);
}
/** 새 칸을 치워 둔다(롤 창 흉내) / 되돌린다 — 지우지 않고 이름만 바꾼다. */
const SAVED = "follow_safe_scopes__pgtest_saved";
const hasCol = async (name) => (await itemsPool.query(
  `SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='auth_token' AND column_name=$1`, [name])).rowCount > 0;
async function stashColumn() {
  if (await hasCol(SAVED)) throw new Error(`치워 둔 칸(${SAVED})이 남아 있다 — 앞선 실행이 되돌리지 못했다. 손으로 확인하라.`);
  await itemsPool.query(`ALTER TABLE auth_token RENAME COLUMN follow_safe_scopes TO ${SAVED}`);
}
async function restoreColumn() {
  if (!(await hasCol(SAVED))) return;
  await itemsPool.query(`ALTER TABLE auth_token DROP COLUMN IF EXISTS follow_safe_scopes`);
  await itemsPool.query(`ALTER TABLE auth_token RENAME COLUMN ${SAVED} TO follow_safe_scopes`);
}

try {
  await cleanup();

  // ── A. 디바이스 로그인(웹 세션 승인 · «관리자 기능 허용» 끔) → 비위험 권한은 구성원의 지금 권한을 따른다 ──
  await setMember(["items", "context"]);
  const a = await deviceLogin(["items", "context"], false, true);
  chk("A1 발급 — 응답 scope 는 발급 때 권한(items · context)", a.ok === true && same(a.scopes, ["items", "context"]), JSON.stringify(a));
  const aRow = await flagOf(a.token);
  chk("A2 토큰 행 — follow_safe_scopes=true · scopes 는 발급 때 기록 그대로", aRow?.f === true && same(aRow.scopes, ["items", "context"]), JSON.stringify(aRow));
  chk("A3 지금 유효 권한 = 구성원 권한", same(await eff(a.token), ["items", "context"]));
  await setMember(["items", "context", "db", "code"]);
  chk("A4 ★ 관리자가 권한을 올리면 다시 로그인하지 않아도 다음 요청부터 닿는다", same(await eff(a.token), ["items", "context", "db", "code"]), JSON.stringify(await eff(a.token)));
  await setMember(["items"]);
  chk("A5 내린 권한은 곧바로 빠진다", same(await eff(a.token), ["items"]), JSON.stringify(await eff(a.token)));
  await setMember(["items", "context", "admin", "runtime"]);
  chk("A6 ★ 관리자로 승격돼도 «관리자 기능 허용» 을 켜지 않은 토큰엔 admin · runtime 이 없다", same(await eff(a.token), ["items", "context"]), JSON.stringify(await eff(a.token)));
  await setMember(["items", "context"], "inactive");
  chk("A7 비활성 구성원 → 토큰 거부", (await store.verifyDbToken(a.token)) === null);

  // ── B. «관리자 기능 허용» 을 켠 로그인 → 실린 위험 scope 만, 구성원이 가질 때만 ──
  await setMember(["items", "context", "admin"]);
  const b = await deviceLogin(["items", "context", "admin"], true, true);
  chk("B1 발급 — admin 이 실린다", b.ok === true && same(b.scopes, ["items", "context", "admin"]), JSON.stringify(b));
  chk("B2 유효 권한에 admin", same(await eff(b.token), ["items", "context", "admin"]));
  await setMember(["items", "context", "admin", "runtime", "db"]);
  chk("B3 비위험(db)은 따르고, 실리지 않은 runtime 은 없다", same(await eff(b.token), ["items", "context", "admin", "db"]), JSON.stringify(await eff(b.token)));
  await setMember(["items", "context", "db"]);
  chk("B4 구성원이 admin 을 잃으면 곧바로 빠진다", same(await eff(b.token), ["items", "context", "db"]), JSON.stringify(await eff(b.token)));
  await setMember(["items", "context", "db", "admin"]);
  chk("B5 다시 얻으면 돌아온다(토큰에 실려 있다)", same(await eff(b.token), ["items", "context", "db", "admin"]), JSON.stringify(await eff(b.token)));

  // ── C. 좁은 토큰으로 한 승인 → 따르지 않는다(확대 불가 — 종전 그대로) ──
  await setMember(["items", "context", "db"]);
  const c = await deviceLogin(["items"], false, false);
  const cRow = await flagOf(c.token);
  chk("C1 발급 scope = 승인자 범위 · 표시 없음", c.ok === true && same(c.scopes, ["items"]) && cRow?.f === false, JSON.stringify({ c, cRow }));
  await setMember(["items", "context", "db", "code", "memory"]);
  chk("C2 ★ 구성원 권한이 늘어도 좁은 토큰은 그대로", same(await eff(c.token), ["items"]), JSON.stringify(await eff(c.token)));
  //  옛 판 게이트웨이가 승인한 행(상한 = 승인 때 권한 그대로 · followSafe 인자 없음)을 새 판이 수령 — 종전 뜻으로 읽는다.
  await setMember(["items", "context"]);
  const c2 = await deviceLogin(["items", "context"], false);
  chk("C3 옛 판이 승인한 행 → 표시 없이 굽는다(종전 결과)", c2.ok === true && same(c2.scopes, ["items", "context"]) && (await flagOf(c2.token))?.f === false, JSON.stringify(c2));
  //  비위험 권한을 전부 쥔 승인자의 상한은 «따른다» 와 같은 뜻이다(그 자격은 이미 구성원의 비위험 권한 전체를 쥐고 있다).
  await setMember(ALL_SAFE);
  const c3 = await deviceLogin(ALL_SAFE, false);
  chk("C4 비위험을 전부 쥔 승인자 → 따른다", c3.ok === true && (await flagOf(c3.token))?.f === true, JSON.stringify(c3));

  // ── D. mintToken 가드 · 발급 응답 · 감사 ──
  let dErr = null;
  try { await store.mintToken({ userId: MID, scopes: ["items"], memberId: null, followSafeScopes: true }, "pgtest", "pgtest"); } catch (e) { dErr = e; }
  chk("D1 memberId 없는 토큰에 켜면 던진다", dErr instanceof Error && /구성원 토큰/.test(dErr.message), String(dErr?.message));
  const d2 = await store.mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: LABEL, followSafeScopes: true }, "pgtest", "pgtest");
  const d3 = await store.mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: LABEL }, "pgtest", "pgtest");
  chk("D2 응답 followSafeScopes — 켠 것 true · 안 켠 것 false · 행도 같다",
    d2.followSafeScopes === true && d3.followSafeScopes === false && (await flagOf(d2.token))?.f === true && (await flagOf(d3.token))?.f === false);
  const au = await itemsPool.query(`SELECT after FROM org_content_audit WHERE entity='auth_token' AND op='mint' AND entity_key=$1 ORDER BY id DESC LIMIT 2`, [MID]);
  const afters = au.rows.map((r) => r.after);
  chk("D3 감사 — 켠 발급에만 followSafeScopes 가 남는다", afters[1]?.followSafeScopes === true && !("followSafeScopes" in (afters[0] ?? {})), JSON.stringify(afters));

  // ── E. OAuth 발급분 · 앱 토큰은 칸이 켜져 있어도 듣지 않는다(동의 화면 · 앱 동의가 범위를 정한다) ──
  await setMember(["items", "context", "db"]);
  const e1 = await store.mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: LABEL, clientId: "pgtest-client" }, "pgtest", "pgtest");
  await itemsPool.query(`UPDATE auth_token SET follow_safe_scopes=true WHERE token_hash=$1`, [e1.tokenHash]);
  chk("E1 OAuth 토큰(client_id)은 칸이 켜져도 발급 범위 그대로", same(await eff(e1.token), ["items"]), JSON.stringify(await eff(e1.token)));
  const e2 = await store.mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: LABEL, appId: "__pgtest_no_such_app__" }, "pgtest", "pgtest");
  await itemsPool.query(`UPDATE auth_token SET follow_safe_scopes=true WHERE token_hash=$1`, [e2.tokenHash]);
  chk("E2 앱 토큰(app_id)도 발급 범위 그대로", same(await eff(e2.token), ["items"]), JSON.stringify(await eff(e2.token)));

  // ── F. 관리 화면 목록(listTokens) — 따르는지를 말한다 ──
  const boxTok = await store.mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: `central-box:${LABEL}`, followMemberScopes: true }, "pgtest", "pgtest");
  const list = await store.listTokens();
  const metaOf = (h) => list.find((t) => t.token_hash === h)?.follows_member;
  chk("F1 follows_member — 로그인 토큰 'safe' · 박스 토큰 'all' · 그 밖 null",
    metaOf(sha(a.token)) === "safe" && metaOf(boxTok.tokenHash) === "all" && metaOf(sha(c.token)) === null && metaOf(d3.tokenHash) === null,
    JSON.stringify([metaOf(sha(a.token)), metaOf(boxTok.tokenHash), metaOf(sha(c.token)), metaOf(d3.tokenHash)]));

  // ── H. 핸들러 배선 — «구성원을 따라도 되는 자격» 을 실제 요청 사용자로 가른다 ──
  await setMember(["items", "context", "db"]);
  //  H1 웹 세션으로 승인 → 따른다.
  const h1 = await deviceLoginVia(sessionUser(["items", "context", "db"]));
  chk("H1 device_approve(웹 세션) → 따르는 토큰", h1.ok === true && (await flagOf(h1.token))?.f === true, JSON.stringify(h1));
  //  H2 그 토큰(이미 구성원을 따른다)으로 승인 → 따른다(데스크톱 앱 안에서 다시 로그인).
  const h1User = await dbUser(h1.token);
  const h2 = await deviceLoginVia(h1User);
  chk("H2 따르는 토큰의 신원에 followsMemberSafe · 그 자격으로 승인 → 따르는 토큰", h1User.followsMemberSafe === true && h2.ok === true && (await flagOf(h2.token))?.f === true, JSON.stringify({ u: h1User.followsMemberSafe, h2 }));
  //  H3 ★ 관리자가 scope 를 골라 구운 토큰 — 지금 구성원 권한과 **똑같아도** 따르는 토큰을 낳지 못한다.
  const adminUser = { userId: "__follow_safe_pg_admin__", email: "", scopes: ["admin"], projects: ["*"], tokenSource: "session" };
  const fixed = await cap("org_token_mint").handler({ memberId: MID, scopes: ["items", "context", "db"], label: LABEL }, adminUser);
  const fixedUser = await dbUser(fixed.token);
  const h3 = await deviceLoginVia(fixedUser);
  chk("H3 org_token_mint(scope 지정) → 응답 followsMember false · 신원에 표시 없음", fixed.followsMember === false && fixedUser.followsMemberSafe === undefined, JSON.stringify({ f: fixed.followsMember, u: fixedUser.followsMemberSafe }));
  chk("H3b ★ 그 토큰으로 승인 → 따르지 않는다(발급 범위에 묶임)", h3.ok === true && (await flagOf(h3.token))?.f === false, JSON.stringify(h3));
  const h3self = await cap("org_token_mint_self").handler({}, fixedUser);
  chk("H3c ★ 그 토큰으로 본인 발급 → 따르지 않는다", (await flagOf(h3self.token))?.f === false, JSON.stringify(h3self.scopes));
  await setMember(["items", "context", "db", "code", "memory"]);
  chk("H3d 구성원 권한이 늘어도 셋 다 발급 범위 그대로", same(await eff(fixed.token), ["items", "context", "db"]) && same(await eff(h3.token), ["items", "context", "db"]) && same(await eff(h3self.token), ["items", "context", "db"]),
    JSON.stringify([await eff(fixed.token), await eff(h3.token), await eff(h3self.token)]));
  //  H4 관리자가 scope 를 고르지 않고 구운 토큰 → 따른다(위험 scope 는 그때 실린 것만).
  await setMember(["items", "context"]);
  const dflt = await cap("org_token_mint").handler({ memberId: MID, label: LABEL }, adminUser);
  await setMember(["items", "context", "db", "admin"]);
  chk("H4 org_token_mint(scope 생략) → 응답 followsMember true · 올린 db 가 닿고 admin 은 없다", dflt.followsMember === true && same(await eff(dflt.token), ["items", "context", "db"]), JSON.stringify([dflt.followsMember, await eff(dflt.token)]));
  //  H5 웹 세션의 본인 발급 → 따른다. «관리 권한 포함» 을 켜면 실린 admin 만.
  const self1 = await cap("org_token_mint_self").handler({}, sessionUser(["items", "context", "db", "admin"]));
  const self2 = await cap("org_token_mint_self").handler({ includeControlPlane: true }, sessionUser(["items", "context", "db", "admin"]));
  await setMember(["items", "context", "db", "code", "admin", "runtime"]);
  chk("H5 org_token_mint_self(웹 세션) → 따른다 · 끈 것은 admin 없음 · 켠 것은 admin 만(runtime 없음)",
    (await flagOf(self1.token))?.f === true && same(await eff(self1.token), ["items", "context", "db", "code"]) && same(await eff(self2.token), ["items", "context", "db", "code", "admin"]),
    JSON.stringify([await eff(self1.token), await eff(self2.token)]));
  //  H6 ★ OAuth 발급분 · 앱 토큰으로 한 승인 · 본인 발급 → 따르지 않는다(구성원의 비위험 권한을 전부 쥐고 있어도).
  await setMember(ALL_SAFE);
  const oauthTok = await store.mintToken({ userId: MID, scopes: ALL_SAFE, memberId: MID, label: LABEL, clientId: "pgtest-client" }, "pgtest", "pgtest");
  const oauthUser = await dbUser(oauthTok.token);
  const h6a = await cap("org_token_mint_self").handler({}, oauthUser);
  chk("H6 OAuth 토큰 신원 — oauthClientId 있음 · followsMemberSafe 없음 · 본인 발급 → 따르지 않는다",
    oauthUser.oauthClientId === "pgtest-client" && oauthUser.followsMemberSafe === undefined && (await flagOf(h6a.token))?.f === false, JSON.stringify({ u: oauthUser, f: (await flagOf(h6a.token))?.f }));
  const appUser = { ...sessionUser(ALL_SAFE), tokenSource: "db", followsMemberSafe: true, appId: "__pgtest_app__" };
  const h6b = await cap("org_token_mint_self").handler({}, appUser);
  chk("H6b 앱 토큰 신원으로 본인 발급 → 따르지 않는다", (await flagOf(h6b.token))?.f === false);
  //  H7 상한이 비위험 전부인 토큰(컨트롤플레인이 굽는 꼴)은 그 자체로 구성원을 따른다 → 그 자격의 승인도 따른다.
  const wide = await cap("org_token_mint").handler({ memberId: MID, scopes: ALL_SAFE, label: LABEL }, adminUser);
  const wideUser = await dbUser(wide.token);
  const h7 = await deviceLoginVia(wideUser);
  chk("H7 상한이 비위험 전부인 토큰 → 신원에 followsMemberSafe · 승인 → 따르는 토큰", wideUser.followsMemberSafe === true && (await flagOf(h7.token))?.f === true, JSON.stringify({ u: wideUser.followsMemberSafe }));

  // ── G. 칸이 아직 없는 롤 창 + 칸이 생기는 순간의 한 번뿐인 백필 ──
  //  옛 판이 구운 토큰들(칸을 모르는 행). 칸을 치우기 전에 넣어 둔다.
  await setMember(["items", "context"]);
  const lgDevice = await legacyToken("device-cli");
  const lgSelf = await legacyToken("추종테스트 (self)");
  const lgSelfAdm = await legacyToken("추종테스트 (self +admin)", { scopes: ["items", "context", "admin"] });
  const lgAdminMint = await legacyToken("추종테스트", { createdBy: "__follow_safe_pg_admin__" });          // 관리자가 구워 준 토큰 — 라벨로 가려낼 수 없다
  const lgAdminSelfLabel = await legacyToken("남이 붙인 (self)", { createdBy: "__follow_safe_pg_admin__" });  // 관리자가 같은 라벨을 달아 구운 토큰
  const lgAdminDeviceLabel = await legacyToken("device-cli", { createdBy: "__follow_safe_pg_admin__" });
  const lgNoCreator = await legacyToken("device-cli", { createdBy: null });
  const lgOauth = await legacyToken("device-cli", { clientId: "pgtest-client" });
  const lgApp = await legacyToken("device-cli", { appId: "__pgtest_app__" });
  const lgRevoked = await legacyToken("device-cli", { revoked: true });
  const lgNoMember = await legacyToken("device-cli", { noMember: true });
  const lgBox = await legacyToken("central-box:x", { followAll: true });
  await stashColumn();
  let winToken = null, winTx = null, winList = null, winDevice = null, winErr = null;
  try {
    try {
      //  칸이 없을 때: 인증 · 목록은 돌고(종전 판정), 켠 발급은 표시 없이 굽는다(깨지지 않는다).
      await setMember(["items", "context", "db"]);
      winList = await store.listTokens();
      winToken = await store.mintToken({ userId: MID, scopes: ["items", "context"], memberId: MID, label: "device-cli", followSafeScopes: true }, MID, "pgtest");
      //  트랜잭션 안 발급(디바이스 로그인과 같은 꼴) — 실패한 INSERT 뒤에도 트랜잭션이 살아 있어야 한다(SAVEPOINT).
      const client = await itemsPool.connect();
      try {
        await client.query("BEGIN");
        const t = await store.mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: LABEL, followSafeScopes: true }, MID, "pgtest", client);
        const still = await client.query("SELECT 1 AS one");
        await client.query("COMMIT");
        winTx = { follow: t.followSafeScopes, alive: still.rows[0]?.one === 1, token: t.token };
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
      winDevice = await deviceLogin(["items", "context", "db"], false, true);
    } catch (e) { winErr = e; }
    chk("G1 롤 창 — 목록 · 발급 · 디바이스 로그인이 던지지 않는다", winErr === null, winErr?.stack || String(winErr));
    chk("G2 롤 창 — 켠 발급은 표시 없이 굽는다(응답 false) · 목록은 follows_member null", winToken?.followSafeScopes === false && (winList ?? []).some((t) => t.token_hash === sha(lgDevice) && t.follows_member === null),
      JSON.stringify({ f: winToken?.followSafeScopes }));
    chk("G3 롤 창 — 트랜잭션 안 발급도 되고 그 트랜잭션은 계속 쓸 수 있다(커밋됨)", winTx?.follow === false && winTx?.alive === true && same(await eff(winTx.token), ["items"]), JSON.stringify(winTx));
    chk("G4 롤 창 — 디바이스 로그인 성공 · 토큰은 종전 판정(발급 때 권한)", winDevice?.ok === true && same(await eff(winDevice.token), ["items", "context", "db"]), JSON.stringify(winDevice));
    chk("G5 롤 창 — 옛 토큰의 판정은 종전 그대로(올린 db 가 닿지 않는다) · 박스 토큰은 전부 추종 그대로",
      same(await eff(lgDevice), ["items", "context"]) && same(await eff(lgBox), ["items", "context", "db"]), JSON.stringify([await eff(lgDevice), await eff(lgBox)]));
    //  부팅 때의 스키마 초기화 그대로 — 칸을 만들고 그 순간 한 번 백필한다.
    await initOrgCore(itemsPool);
    const f = async (t) => (await flagOf(t))?.f;
    chk("G6 ★ 백필 — 이미 깔린 본인 로그인 토큰(device-cli · self · self +admin)에 표시가 붙는다",
      (await f(lgDevice)) === true && (await f(lgSelf)) === true && (await f(lgSelfAdm)) === true, JSON.stringify([await f(lgDevice), await f(lgSelf), await f(lgSelfAdm)]));
    chk("G7 백필 — 롤 창에 구운 device-cli 토큰도 붙는다", (await f(winToken.token)) === true && (await f(winDevice.token)) === true);
    chk("G8 백필 제외 — 관리자가 구워 준 토큰 · 회수된 토큰 · 구성원 없는 토큰 · 박스 토큰(전부 추종) · 그 밖의 라벨",
      (await f(lgAdminMint)) === false && (await f(lgRevoked)) === false && (await f(lgNoMember)) === false && (await f(lgBox)) === false && (await f(winTx.token)) === false,
      JSON.stringify([await f(lgAdminMint), await f(lgRevoked), await f(lgNoMember), await f(lgBox), await f(winTx.token)]));
    chk("G8b ★ 백필 제외 — 남(관리자)이 같은 라벨로 구운 토큰 · 만든 사람 기록이 없는 토큰 · OAuth 발급분 · 앱 토큰",
      (await f(lgAdminSelfLabel)) === false && (await f(lgAdminDeviceLabel)) === false && (await f(lgNoCreator)) === false && (await f(lgOauth)) === false && (await f(lgApp)) === false,
      JSON.stringify([await f(lgAdminSelfLabel), await f(lgAdminDeviceLabel), await f(lgNoCreator), await f(lgOauth), await f(lgApp)]));
    chk("G9 ★ 백필 뒤 — 다시 로그인하지 않은 옛 토큰에 올린 권한(db)이 닿는다", same(await eff(lgDevice), ["items", "context", "db"]) && same(await eff(lgSelf), ["items", "context", "db"]),
      JSON.stringify([await eff(lgDevice), await eff(lgSelf)]));
    await setMember(["items", "context", "db", "admin", "runtime"]);
    chk("G10 백필 뒤 — 위험 scope 는 넓어지지 않는다(self 는 없음 · self +admin 은 실린 admin 만)",
      same(await eff(lgSelf), ["items", "context", "db"]) && same(await eff(lgSelfAdm), ["items", "context", "db", "admin"]), JSON.stringify([await eff(lgSelf), await eff(lgSelfAdm)]));
    //  백필은 칸을 만드는 순간 한 번뿐이다 — 사람이 끈 표시를 다음 부팅이 되살리지 않는다.
    await itemsPool.query(`UPDATE auth_token SET follow_safe_scopes=false WHERE token_hash=$1`, [sha(lgDevice)]);
    await initOrgCore(itemsPool);
    chk("G11 다시 부팅해도 끈 표시는 꺼진 채다(백필은 한 번뿐)", (await f(lgDevice)) === false);
  } finally {
    await restoreColumn();   // 치워 둔 칸을 되돌린다 — 이 DB 의 다른 토큰 표시는 시험 전 그대로다.
  }
  chk("G12 칸 되돌림 — follow_safe_scopes 있음 · 치워 둔 칸 없음", (await hasCol("follow_safe_scopes")) && !(await hasCol(SAVED)));

  await cleanup();
} catch (e) {
  bad("예외", e?.stack || String(e));
  await restoreColumn().catch(() => {});
  await cleanup().catch(() => {});
} finally {
  await itemsPool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
