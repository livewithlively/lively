// 웹 세션 회수 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖 — 그 체인은 DB 없는 유닛뿐).
//  CI 의 services:postgres 잡에서, 또는 로컬에서 수동 실행:
//    npm run build && ITEMS_DATABASE_URL=postgres://… node src/auth/session-revoke.pg-test.mjs
//
// 왜 실 DB 인가: revokeSession 은 CTE 로 **지우기 전의** 로그인 방식·보관 토큰을 돌려주면서 같은 문장에서 토큰을 지운다.
//  UPDATE 의 RETURNING 은 지운 뒤 값(NULL)을 주므로 CTE 를 빼면 id_token_hint 가 영영 안 붙는데, 소스 정규식이나
//  목 pg 로는 그 차이(옛 값 vs 새 값)와 «이미 끊긴 세션은 0행» 이 드러나지 않는다.
//
//  사양:
//   R1 1차 회수는 {authMethod, ssoIdTokenEnc} 를 옛 값 그대로 돌려준다
//   R2 그 행은 회수 시각이 찍히고 보관 토큰이 NULL 이 된다
//   R3 2차 회수(이미 끊긴 세션)는 null — 로그아웃을 두 번 눌러도 IdP 로 두 번 보내지 않는다
//   R4 비밀번호 로그인 세션(authMethod 없음)은 {authMethod:null, ssoIdTokenEnc:null}
//   R5 정비 스윕(reapEndedSessionTokens)은 만료된 세션의 보관 토큰만 지운다 — 살아 있는 세션의 토큰은 그대로
import crypto from "node:crypto";
const DIST = new URL("../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/db/client.js`);
const { initMemberAuth } = await import(`${DIST}/org/schema/member-auth.js`);
const { createSession, revokeSession, reapEndedSessionTokens } = await import(`${DIST}/auth/sessions.js`);

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const MID = "__session_revoke_pg_test__";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rowOf = async (sid) => (await itemsPool.query(
  `SELECT revoked_at, auth_method, sso_id_token_enc FROM web_session WHERE session_hash=$1`, [sha256(sid)])).rows[0] ?? null;

try {
  // 스키마 init 은 멱등이다 — 앞 스텝(initAllSchemas)이 없어도 이 파일 혼자 돈다.
  await initMemberAuth(itemsPool);

  {
    const { sessionId } = await createSession(MID, { authMethod: "oidc", ssoIdTokenEnc: "gcm$x" });
    const first = await revokeSession(sessionId);
    chk("R1 1차 회수가 옛 로그인 방식·보관 토큰을 돌려준다",
      first?.authMethod === "oidc" && first?.ssoIdTokenEnc === "gcm$x", `first=${JSON.stringify(first)}`);
    const row = await rowOf(sessionId);
    chk("R2a 회수 시각이 찍혔다", row?.revoked_at != null, `row=${JSON.stringify(row)}`);
    chk("R2b ★ 보관 토큰이 지워졌다(끝난 세션에 IdP 토큰을 남기지 않는다)",
      row !== null && row.sso_id_token_enc === null, `row=${JSON.stringify(row)}`);
    chk("R2c 로그인 방식 표시는 남는다", row?.auth_method === "oidc", `row=${JSON.stringify(row)}`);
    const second = await revokeSession(sessionId);
    chk("R3 2차 회수는 null", second === null, `second=${JSON.stringify(second)}`);
  }
  {
    const { sessionId } = await createSession(MID, {});
    const r = await revokeSession(sessionId);
    chk("R4 비밀번호 로그인 세션은 방식·토큰 모두 null",
      r !== null && r.authMethod === null && r.ssoIdTokenEnc === null, `r=${JSON.stringify(r)}`);
  }
  {
    // 로그아웃 없이 창을 닫은 세션 — 회수되지 않고 만료만 된다.
    const expired = await createSession(MID, { authMethod: "oidc", ssoIdTokenEnc: "gcm$left" });
    await itemsPool.query(`UPDATE web_session SET expires_at = now() - interval '1 day' WHERE session_hash=$1`, [sha256(expired.sessionId)]);
    const live = await createSession(MID, { authMethod: "oidc", ssoIdTokenEnc: "gcm$live" });
    const n = await reapEndedSessionTokens();
    chk("R5a 만료 세션의 보관 토큰을 지운다", n >= 1 && (await rowOf(expired.sessionId))?.sso_id_token_enc === null,
      `n=${n} row=${JSON.stringify(await rowOf(expired.sessionId))}`);
    chk("R5b 살아 있는 세션의 토큰은 그대로", (await rowOf(live.sessionId))?.sso_id_token_enc === "gcm$live",
      `row=${JSON.stringify(await rowOf(live.sessionId))}`);
  }
} catch (e) {
  bad("예외", e?.stack || String(e));
} finally {
  await itemsPool.query(`DELETE FROM web_session WHERE member_id=$1`, [MID]).catch(() => {});
  await itemsPool.end().catch(() => {});
}

console.log(`\nsession-revoke pg-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
