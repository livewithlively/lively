// #880 device-auth 스토어 계층 PG 통합 테스트 — **실제 Postgres 필요**(기본 npm test 체인 밖 — 그 체인은 목 유닛뿐).
//  CI 의 services:postgres 잡(#885)에서, 또는 로컬에서 수동 실행:
//    npm run build && node --env-file=.env src/org/auth/device-auth.pg-test.mjs
//  승인→폴→발급 · scope 교집합 · double-mint 차단 · approver_scopes 상한(세탁) · PKCE 바인딩 · deny · lookup 정규화를
//  실제 DB 트랜잭션으로 검증한다(목 pg 로는 원자성·now()·RETURNING rowCount 를 못 본다 — R2-NEW2).
import crypto from "node:crypto";
const DIST = new URL("../../../dist", import.meta.url).href.replace(/\/$/, "");
const { itemsPool } = await import(`${DIST}/items/store.js`);
const da = await import(`${DIST}/org/auth/device-auth.js`);

const s256 = (v) => crypto.createHash("sha256").update(v).digest("base64url");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const chk = (n, c, why) => (c ? ok(n) : bad(n, why || ""));

const MID = "__device_pg_test__";
async function mkMember(scopes) {
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, state, scopes)
       VALUES($1,'human','디바이스테스트','__device_pg_test__@example.invalid','active',$2::jsonb)
     ON CONFLICT (id) DO UPDATE SET scopes=$2::jsonb, state='active'`,
    [MID, JSON.stringify(scopes)],
  );
}
async function cleanup() {
  await itemsPool.query(`DELETE FROM pending_device_auth WHERE client_label='pgtest' OR member_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM auth_token WHERE member_id=$1`, [MID]);
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [MID]);
}

try {
  await cleanup();

  // ① 승인(control-plane 없음) → 폴 → 발급. member LIVE=[items,context,admin] → 발급=[items,context](admin 제거).
  await mkMember(["items", "context", "admin"]);
  {
    const v = crypto.randomBytes(32).toString("base64url");
    const st = await da.startDeviceAuth(s256(v), "pgtest", "https://x");
    const ap = await da.approveDeviceAuth(st.user_code, MID, ["items", "context", "admin"], false);
    chk("① approve 성공", ap === true, `ap=${ap}`);
    const pr = await da.pollDeviceAuth(st.device_code, v);
    chk("① 폴→발급 성공", pr.ok === true && typeof pr.token === "string" && pr.token.startsWith("lvk_"), JSON.stringify(pr));
    chk("① scope 교집합·admin 제거(control-plane off)",
      pr.ok && JSON.stringify([...pr.scopes].sort()) === JSON.stringify(["context", "items"]), JSON.stringify(pr.scopes));
    const tok = await itemsPool.query(`SELECT scopes FROM auth_token WHERE token_hash=$1`, [crypto.createHash("sha256").update(pr.token).digest("hex")]);
    chk("① 토큰 DB 저장(sha256)", tok.rowCount === 1, `rows=${tok.rowCount}`);
    const pr2 = await da.pollDeviceAuth(st.device_code, v);
    chk("① 재폴 → consumed(expired_token) · double-mint 0", pr2.ok === false && pr2.error === "expired_token", JSON.stringify(pr2));
    const cnt = await itemsPool.query(`SELECT COUNT(*)::int AS n FROM auth_token WHERE member_id=$1`, [MID]);
    chk("① 토큰 정확히 1개(orphan 0)", cnt.rows[0].n === 1, `n=${cnt.rows[0].n}`);
  }

  // ② control-plane opt-in → admin 실림
  {
    const v = crypto.randomBytes(32).toString("base64url");
    const st = await da.startDeviceAuth(s256(v), "pgtest", "https://x");
    await da.approveDeviceAuth(st.user_code, MID, ["items", "context", "admin"], true);
    const pr = await da.pollDeviceAuth(st.device_code, v);
    chk("② control-plane on → admin 포함", pr.ok && pr.scopes.includes("admin"), JSON.stringify(pr.scopes));
  }

  // ③ approver_scopes 가 상한 — 승인자 scope 가 좁으면 발급도 좁다(세탁 불가).
  {
    const v = crypto.randomBytes(32).toString("base64url");
    const st = await da.startDeviceAuth(s256(v), "pgtest", "https://x");
    await da.approveDeviceAuth(st.user_code, MID, ["items"], true); // control-plane 요청해도 approver 에 admin 없음
    const pr = await da.pollDeviceAuth(st.device_code, v);
    chk("③ approver_scopes 상한(세탁 차단)", pr.ok && JSON.stringify(pr.scopes) === JSON.stringify(["items"]), JSON.stringify(pr.scopes));
  }

  // ④ deny → 폴 → access_denied
  {
    const v = crypto.randomBytes(32).toString("base64url");
    const st = await da.startDeviceAuth(s256(v), "pgtest", "https://x");
    await da.denyDeviceAuth(st.user_code);
    const pr = await da.pollDeviceAuth(st.device_code, v);
    chk("④ deny → access_denied", pr.ok === false && pr.error === "access_denied", JSON.stringify(pr));
  }

  // ⑤ 틀린 verifier 는 approved 행도 소비 못 함(개시자 바인딩)
  {
    const v = crypto.randomBytes(32).toString("base64url");
    const st = await da.startDeviceAuth(s256(v), "pgtest", "https://x");
    await da.approveDeviceAuth(st.user_code, MID, ["items"], false);
    const wrong = await da.pollDeviceAuth(st.device_code, "WRONG_VERIFIER");
    chk("⑤ 틀린 verifier → invalid_verifier(소비 안 함)", wrong.ok === false && wrong.error === "invalid_verifier", JSON.stringify(wrong));
    const right = await da.pollDeviceAuth(st.device_code, v);
    chk("⑤ 진짜 개시자는 여전히 발급받음", right.ok === true, JSON.stringify(right));
  }

  // ⑥ lookup — pending 만·정규화(소문자·하이픈 무관)
  {
    const v = crypto.randomBytes(32).toString("base64url");
    const st = await da.startDeviceAuth(s256(v), "pgtest", "https://x");
    const lo = await da.lookupDeviceAuth(st.user_code.toLowerCase().slice(0, 4) + "-" + st.user_code.slice(4));
    chk("⑥ lookup 정규화(소문자·하이픈)", lo && da.normalizeUserCode(lo.user_code) === st.user_code, JSON.stringify(lo));
  }

  await cleanup();
} catch (e) {
  bad("예외", e?.stack || String(e));
  await cleanup().catch(() => {});
} finally {
  await itemsPool.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
