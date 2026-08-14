// #1473 T2 OAuth 인가서버 스토어 계층 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env dist-runner … 아래 한 줄이 정본:
//    npm run build && node --env-file=.env src/org/auth/oauth.pg-test.mjs
//
//  목 pg 로는 못 보는 것만 여기서 본다 — now() 기준 만료, 원자적 consume(RETURNING rowCount),
//  재사용 탐지에 따른 **연쇄 회수**, 트랜잭션 롤백. 순수 판정(권한 교집합·redirect_uri·CIMD·캐시 TTL)은
//  src/org/auth/oauth-unit.test.ts 와 src/auth/oauth-resource.test.ts 가 목 없이 덮는다.
import crypto from "node:crypto";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { initOAuthServer } = await import(`${DIST}/org/schema/oauth.js`);
const st = await import(`${DIST}/org/store/oauth.js`);
const { mintToken, verifyDbToken } = await import(`${DIST}/org/store/tokens.js`);
const { verifyClientSecret } = await import(`${DIST}/org/auth/oauth-clients.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));
const eq = (n, got, want) => chk(n, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const MID = "__oauth_pg_test__";
const CID = "__oauth_pg_client__";
const CID2 = "__oauth_pg_client2__";
const REDIR = "https://client.invalid/cb";
const SECRET = "s3cret-" + crypto.randomBytes(8).toString("hex");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function setMemberState(state) {
  await itemsPool.query(`UPDATE org_member SET state=$2 WHERE id=$1`, [MID, state]);
}
async function mkMember(scopes) {
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
       VALUES($1,'human','OAuth테스트','__oauth_pg_test__@example.invalid','active',$2::jsonb)
     ON CONFLICT (tenant_id, id) DO UPDATE SET scopes=$2::jsonb, state='active'`,
    [MID, JSON.stringify(scopes)],
  );
}
async function cleanup() {
  for (const c of [CID, CID2]) {
    await itemsPool.query(`DELETE FROM oauth_auth_code WHERE client_id=$1`, [c]);
    await itemsPool.query(`DELETE FROM oauth_auth_request WHERE client_id=$1`, [c]);
    await itemsPool.query(`DELETE FROM oauth_refresh WHERE client_id=$1`, [c]);
    await itemsPool.query(`DELETE FROM oauth_client WHERE client_id=$1`, [c]);
  }
  await itemsPool.query(`DELETE FROM auth_token WHERE member_id=$1 OR user_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM org_content_audit WHERE actor=$1`, [MID]).catch(() => {});
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [MID]);
}

// 인가요청 생성 → 승인 → 인가코드. 테스트 대부분이 이 앞부분을 공유한다.
async function freshCode(scopes = []) {
  const rid = await st.createAuthRequest({
    clientId: CID, redirectUri: REDIR, codeChallenge: "x".repeat(43),
    scopes, state: "st-1", resource: "https://gw.invalid/mcp",
  });
  const grant = await st.approveAuthRequest(rid, MID);
  return { rid, grant };
}

try {
  await initOAuthServer(itemsPool);  // CREATE TABLE IF NOT EXISTS + 컬럼 추가(멱등)
  await cleanup();
  await mkMember(["items", "context", "admin"]);
  await st.saveClient({
    clientId: CID, kind: "static", clientName: "PG 테스트 클라이언트",
    clientSecretHash: sha(SECRET), redirectUris: [REDIR], actor: "pgtest",
  });
  await st.saveClient({ clientId: CID2, kind: "static", clientName: "공개", redirectUris: [REDIR], actor: "pgtest" });

  // ── B. 토큰 만료는 DB now() 기준 ──
  {
    const a = await mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: "pgtest-noexp" });
    const v = await verifyDbToken(a.token);
    chk("B1 만료 없음 → 통과", v !== null && v.expiresAt === null, `v=${JSON.stringify(v)}`);

    const b = await mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: "pgtest-future", expiresInSec: 600 });
    const vb = await verifyDbToken(b.token);
    chk("B2 만료 미래 → 통과 + 만료값 반환", vb !== null && typeof vb.expiresAt === "number" && vb.expiresAt > Math.floor(Date.now() / 1000), `v=${JSON.stringify(vb)}`);

    const c = await mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: "pgtest-past", expiresInSec: 600 });
    await itemsPool.query(`UPDATE auth_token SET expires_at = now() - interval '1 second' WHERE token_hash=$1`, [c.tokenHash]);
    chk("B3 ★ 만료 과거 → 거부", (await verifyDbToken(c.token)) === null);

    const d = await mintToken({ userId: MID, scopes: ["items"], memberId: MID, label: "pgtest-edge", expiresInSec: 600 });
    await itemsPool.query(`UPDATE auth_token SET expires_at = now() WHERE token_hash=$1`, [d.tokenHash]);
    chk("B4 만료 == 현재(경계) → 거부", (await verifyDbToken(d.token)) === null);

    // 바인딩 3종이 실제로 저장되는가(배선 단언 — 컬럼이 안 채워지면 audience 검사가 통째로 무력화된다)
    const e = await mintToken({
      userId: MID, scopes: ["items"], memberId: MID, label: "pgtest-bind",
      clientId: CID, resource: "https://gw.invalid/mcp", expiresInSec: 600,
    });
    const ve = await verifyDbToken(e.token);
    chk("B5 client_id·resource 왕복 저장", ve?.clientId === CID && ve?.resource === "https://gw.invalid/mcp", `v=${JSON.stringify(ve)}`);
  }

  // ── I. 클라이언트 비밀 게이트 ──
  eq("I1 문서기반(CIMD) 식별자 → 비밀 불요", await verifyClientSecret("https://x.invalid/c.json", undefined), "ok");
  eq("I2 올바른 비밀 → ok", await verifyClientSecret(CID, SECRET), "ok");
  eq("I3 ★ 틀린 비밀 → mismatch", await verifyClientSecret(CID, SECRET + "x"), "mismatch");
  eq("I4 ★ 비밀 누락 → missing", await verifyClientSecret(CID, undefined), "missing");
  eq("I5 비밀 없이 등록된 공개 클라이언트 → ok", await verifyClientSecret(CID2, undefined), "ok");
  eq("I6 미등록 → unknown(다음 단계에서 거부)", await verifyClientSecret("__no_such_client__", "x"), "unknown");

  // ── L. 동의 승인은 1회용 ──
  {
    const rid = await st.createAuthRequest({
      clientId: CID, redirectUri: REDIR, codeChallenge: "y".repeat(43), scopes: [], state: null, resource: null,
    });
    const first = await st.approveAuthRequest(rid, MID);
    chk("L1 정상 승인 → 인가코드 발급", !!first?.code);
    chk("L2 ★ 같은 요청 재승인(뒤로가기·더블클릭) → 거부", (await st.approveAuthRequest(rid, MID)) === null);
  }

  // ── J. 인가코드 교환 ──
  {
    const { grant } = await freshCode([]);           // 요청 scope 미지정 → 멤버 상한 − 위험
    eq("J1a 발급 권한 = 멤버 LIVE ∩ 요청 − 위험", grant.scopes, ["items", "context"]);
    const t = await st.redeemAuthCode({ clientId: CID, code: grant.code, redirectUri: REDIR });
    chk("J1b 정상 교환 → 액세스+리프레시", !!t?.accessToken && !!t?.refreshToken && t.expiresIn === 3600);
    const v = await verifyDbToken(t.accessToken);
    chk("J1c 발급 토큰이 실제로 인증된다(배선)", v !== null && v.clientId === CID, `v=${JSON.stringify(v)}`);

    // J2 — 같은 코드 재사용 = 도난 신호 → 그 (클라이언트, 멤버) 조합 토큰 전량 회수
    chk("J2a ★ 인가코드 재사용 → 거부", (await st.redeemAuthCode({ clientId: CID, code: grant.code, redirectUri: REDIR })) === null);
    chk("J2b ★ 재사용 감지 시 기존 액세스 토큰까지 회수", (await verifyDbToken(t.accessToken)) === null);
    const refreshDead = await itemsPool.query(
      `SELECT revoked_at FROM oauth_refresh WHERE token_hash=$1`, [sha(t.refreshToken)]);
    chk("J2c ★ 리프레시도 함께 회수", refreshDead.rows[0]?.revoked_at != null);
  }
  {
    const { grant } = await freshCode(["items"]);
    eq("J1d 요청 scope 가 좁으면 그만큼만", grant.scopes, ["items"]);
    chk("J3 ★ 다른 클라이언트가 교환 시도 → 거부",
      (await st.redeemAuthCode({ clientId: CID2, code: grant.code, redirectUri: REDIR })) === null);
    chk("J3' 원래 클라이언트는 여전히 교환 가능(J3 가 코드를 태우지 않았다)",
      (await st.redeemAuthCode({ clientId: CID, code: grant.code, redirectUri: REDIR })) !== null);
  }
  {
    const { grant } = await freshCode([]);
    chk("J4 ★ redirect_uri 불일치 → 거부",
      (await st.redeemAuthCode({ clientId: CID, code: grant.code, redirectUri: "https://other.invalid/cb" })) === null);
  }
  {
    const { grant } = await freshCode([]);
    await setMemberState("inactive");
    chk("J5 ★ 구성원 비활성 → 발급 거부", (await st.redeemAuthCode({ clientId: CID, code: grant.code }) ) === null);
    await setMemberState("active");
  }

  // ── K. 리프레시 회전 ──
  {
    const { grant } = await freshCode([]);
    const t1 = await st.redeemAuthCode({ clientId: CID, code: grant.code, redirectUri: REDIR });
    const t2 = await st.redeemRefreshToken({ clientId: CID, refreshToken: t1.refreshToken });
    chk("K1a 정상 회전 → 새 액세스+새 리프레시", !!t2?.accessToken && t2.refreshToken !== t1.refreshToken);
    const oldRow = await itemsPool.query(
      `SELECT revoked_at, rotated_to FROM oauth_refresh WHERE token_hash=$1`, [sha(t1.refreshToken)]);
    chk("K1b 옛 리프레시는 죽고 회전 사슬이 남는다",
      oldRow.rows[0]?.revoked_at != null && oldRow.rows[0]?.rotated_to === sha(t2.refreshToken));

    eq("K3 권한 축소 요청 → 축소 반영",
      (await st.redeemRefreshToken({ clientId: CID, refreshToken: t2.refreshToken, requestedScopes: ["items"] }))?.scopes, ["items"]);

    // K2 — 회전된 옛 리프레시 재사용 = 도난 신호
    const alive = await st.redeemAuthCode({ clientId: CID, code: (await freshCode([])).grant.code, redirectUri: REDIR });
    chk("K2a ★ 회전된 리프레시 재사용 → 거부",
      (await st.redeemRefreshToken({ clientId: CID, refreshToken: t1.refreshToken })) === null);
    chk("K2b ★ 재사용 감지 시 그 조합의 살아있던 토큰까지 회수", (await verifyDbToken(alive.accessToken)) === null);
  }
  {
    // K4 — 권한 확대 요청은 원래 발급분을 넘지 못한다.
    const { grant } = await freshCode(["items"]);
    const t = await st.redeemAuthCode({ clientId: CID, code: grant.code, redirectUri: REDIR });
    eq("K4 ★ 권한 확대 요청 → 원래 이하",
      (await st.redeemRefreshToken({ clientId: CID, refreshToken: t.refreshToken, requestedScopes: ["items", "db", "admin"] }))?.scopes, ["items"]);
  }

  // ── 클라이언트 해제는 즉시 kill-switch ──
  {
    const { grant } = await freshCode([]);
    const t = await st.redeemAuthCode({ clientId: CID, code: grant.code, redirectUri: REDIR });
    chk("Z1 해제 전 토큰 유효", (await verifyDbToken(t.accessToken)) !== null);
    await st.disableClient(CID, "pgtest");
    chk("Z2 ★ 클라이언트 해제 → 발급된 토큰 즉시 무효", (await verifyDbToken(t.accessToken)) === null);
    chk("Z3 ★ 해제된 클라이언트는 조회에서 사라진다", (await st.getClient(CID)) === null);
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await cleanup().catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\noauth pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
