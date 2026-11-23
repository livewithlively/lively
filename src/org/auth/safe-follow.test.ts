// #5712 — «로그인 토큰이 구성원의 비위험 권한을 따를지» 를 정하는 순수 판정들. DB 불요.
//  여기가 틀리면 둘 중 하나가 난다: (가) 범위가 고정된 자격(좁게 구운 토큰 · OAuth · 앱 토큰)으로 승인 · 재발급해 구성원 권한 전체를 따르는 토큰을 얻는다(확대),
//  (나) 정상 로그인 토큰이 따르지 않아 권한을 올릴 때마다 다시 로그인해야 한다(이 변경이 없애려는 일).
import assert from "node:assert/strict";
import { SCOPES, SAFE_SCOPES, DANGEROUS_SCOPES } from "../../auth/scopes.js";
import { credentialFollowsMember, ceilingWithSafeFollow, ceilingFollowsSafe, grantableScopes, FOLLOW_SAFE_MARK } from "./grant-util.js";

// ── SAFE_SCOPES = SCOPES − 위험 ──
assert.deepEqual([...SAFE_SCOPES].sort(), [...SCOPES].filter((s) => !DANGEROUS_SCOPES.has(s)).sort(), "비위험 = 전체 − 위험");
assert.ok(!SAFE_SCOPES.includes("admin") && !SAFE_SCOPES.includes("runtime"), "admin · runtime 은 비위험이 아니다");
assert.ok(SAFE_SCOPES.includes("items") && SAFE_SCOPES.includes("db") && SAFE_SCOPES.includes("code"), "평소 권한이 든다");

// ── credentialFollowsMember — 이 자격으로 굽는 로그인 토큰이 구성원을 따라도 되나 ──
// [H1] 웹 세션은 참 — 세션 scope 가 구성원 라이브 scope 그 자체다.
assert.equal(credentialFollowsMember({ tokenSource: "session" }), true, "H1 세션");
// [H2] 구성원을 따르는 DB 토큰은 참(데스크톱 앱 안에서 다시 로그인할 때의 승인 자격).
assert.equal(credentialFollowsMember({ tokenSource: "db", followsMemberSafe: true }), true, "H2 따르는 토큰");
// [H3] ★ 범위가 고정된 DB 토큰은 거짓 — 관리자가 scope 를 골라 구운 토큰은 그때 구성원 권한과 같았더라도 따르는 토큰을 낳지 못한다.
assert.equal(credentialFollowsMember({ tokenSource: "db" }), false, "H3 고정 범위 토큰");
assert.equal(credentialFollowsMember({ tokenSource: "db", followsMemberSafe: false }), false, "H3 명시적 false");
// [H4] ★ OAuth 발급분은 따르는 표시가 있어도 거짓 — 동의 화면에서 본 범위가 계약이다.
assert.equal(credentialFollowsMember({ tokenSource: "db", followsMemberSafe: true, oauthClientId: "client-1" }), false, "H4 OAuth");
// [H5] ★ 앱 토큰 · 앱 서버가 실어 온 신원 · 도구 상한이 걸린 토큰도 거짓 — 앱 동의가 범위를 정한다.
assert.equal(credentialFollowsMember({ tokenSource: "db", followsMemberSafe: true, appId: "notes" }), false, "H5 앱 토큰");
assert.equal(credentialFollowsMember({ tokenSource: "db", followsMemberSafe: true, appServer: true }), false, "H5 앱 서버 신원");
assert.equal(credentialFollowsMember({ tokenSource: "db", followsMemberSafe: true, toolCeiling: [] }), false, "H5 도구 상한");
assert.equal(credentialFollowsMember({ tokenSource: "session", appId: "notes" }), false, "H5 앱 표시가 붙은 신원은 세션이어도 거짓");
// [H6] 정적 토큰 · 출처를 모르는 자격 · 자격 없음은 거짓(닫힌 쪽).
assert.equal(credentialFollowsMember({ tokenSource: "static", followsMemberSafe: true }), false, "H6 정적 토큰");
assert.equal(credentialFollowsMember({ followsMemberSafe: true }), false, "H6 출처 없음");
assert.equal(credentialFollowsMember(undefined), false, "H6 자격 없음");

// [H7] 앱 주소로 들어온 신원(앱 화면)은 세션 꼴이어도 거짓.
assert.equal(credentialFollowsMember({ tokenSource: "session", appAddress: "pub" }), false, "H7 앱 주소 신원");

// ── 상한에 «구성원을 따른다» 표지 싣기 · 읽기 ──
// [C1] 실으면 표지 하나가 붙고 scope 는 승인자 것 그대로다(늘지 않는다).
{
  const c = ceilingWithSafeFollow(["items", "admin"]);
  assert.deepEqual(c, ["items", "admin", FOLLOW_SAFE_MARK], "C1 승인자 scope + 표지");
  assert.equal(ceilingFollowsSafe(c), true, "C1 읽으면 참");
}
// [C2] 표지가 없는 상한은 거짓.
assert.equal(ceilingFollowsSafe(["items", "context", "memory"]), false, "C2 승인 때 권한 그대로");
assert.equal(ceilingFollowsSafe([]), false, "C2 빈 상한");
// [C3] ★ 비위험 scope 를 **전부** 가진 상한도 표지가 없으면 거짓 — scope 의 수로 뜻을 미루어 읽지 않는다
//  (비위험을 전부 쥔 OAuth · 앱 자격의 승인이 따르는 토큰을 낳지 않는다).
assert.equal(ceilingFollowsSafe([...SAFE_SCOPES]), false, "C3 전부 가진 승인자");
assert.equal(ceilingFollowsSafe([...SCOPES]), false, "C3 위험 scope 까지 전부");
// [C4] 알 수 없는 값은 상한에 실리지 않는다. 표지는 scope 가 아니다.
assert.ok(!ceilingWithSafeFollow(["root", "items"]).includes("root"), "C4 알 수 없는 scope");
assert.ok(!(SCOPES as readonly string[]).includes(FOLLOW_SAFE_MARK), "C4 표지는 scope 목록에 없다");
// [C5] ★ 표지가 발급 기록을 넓히지 않는다 — 발급 scope 는 구성원 라이브 ∩ 상한이다(옛 판 게이트웨이가 이 상한을 읽어도 종전 결과).
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context", "db", "admin"], allowed: ceilingWithSafeFollow(["items", "context"]), allowDangerous: true }),
  ["items", "context"], "C5 승인자에게 없던 db · admin 은 실리지 않는다");
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context", "admin"], allowed: ceilingWithSafeFollow(["items", "context", "admin"]), allowDangerous: false }),
  ["items", "context"], "C5 «관리자 기능 허용» 을 끄면 admin 은 빠진다");
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context", "admin"], allowed: ceilingWithSafeFollow(["items", "context", "admin"]), allowDangerous: true }),
  ["items", "context", "admin"], "C5 켜면 실린다");

console.log("safe-follow unit tests: passed");
