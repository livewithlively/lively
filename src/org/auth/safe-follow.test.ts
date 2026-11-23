// #5712 — «로그인 토큰이 구성원의 비위험 권한을 따를지» 를 정하는 순수 판정들. DB 불요.
//  여기가 틀리면 둘 중 하나가 난다: (가) 범위가 고정된 자격(좁게 구운 토큰 · OAuth · 앱 토큰)으로 승인 · 재발급해 구성원 권한 전체를 따르는 토큰을 얻는다(확대),
//  (나) 정상 로그인 토큰이 따르지 않아 권한을 올릴 때마다 다시 로그인해야 한다(이 변경이 없애려는 일).
import assert from "node:assert/strict";
import { SCOPES, SAFE_SCOPES, DANGEROUS_SCOPES } from "../../auth/scopes.js";
import { credentialFollowsMember, ceilingWithSafeFollow, ceilingFollowsSafe, grantableScopes } from "./grant-util.js";

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

// ── 상한에 «비위험은 구성원을 따른다» 싣기 · 읽기 ──
// [C1] 실으면 비위험 전부가 들고, 승인자의 위험 scope 는 그대로 남는다(늘지 않는다).
{
  const c = ceilingWithSafeFollow(["items", "admin"]);
  assert.deepEqual([...c].sort(), [...SAFE_SCOPES, "admin"].sort(), "C1 비위험 전부 + admin");
  assert.ok(!c.includes("runtime"), "C1 승인자에게 없던 runtime 은 생기지 않는다");
  assert.equal(ceilingFollowsSafe(c), true, "C1 읽으면 참");
}
// [C2] 싣지 않은 상한(승인 때 권한 그대로)은 비위험을 전부 가진 경우가 아니면 거짓.
assert.equal(ceilingFollowsSafe(["items", "context", "memory"]), false, "C2 승인 때 권한 그대로");
assert.equal(ceilingFollowsSafe([]), false, "C2 빈 상한");
assert.equal(ceilingFollowsSafe(["admin", "runtime"]), false, "C2 위험 scope 만");
// [C3] 비위험을 전부 가진 상한은 실은 것과 구분되지 않는다 — 그 승인자는 이미 구성원의 비위험 권한 전체를 쥐고 있었다(같은 뜻).
assert.equal(ceilingFollowsSafe([...SAFE_SCOPES]), true, "C3 전부 가진 승인자");
// [C4] 알 수 없는 값은 상한에 실리지 않는다.
assert.ok(!ceilingWithSafeFollow(["root", "items"]).includes("root"), "C4 알 수 없는 scope");
// [C5] ★ 넓힌 상한이 발급 기록을 넓히지 않는다 — 발급 scope 는 구성원 라이브와 교집합이다(옛 판 게이트웨이가 이 상한을 읽어도 종전 결과).
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context", "admin"], allowed: ceilingWithSafeFollow(["items", "context"]), allowDangerous: true }),
  ["items", "context"], "C5 승인자에게 없던 admin 은 실리지 않는다");
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context", "admin"], allowed: ceilingWithSafeFollow(["items", "context", "admin"]), allowDangerous: false }),
  ["items", "context"], "C5 «관리자 기능 허용» 을 끄면 admin 은 빠진다");
assert.deepEqual(grantableScopes({ memberScopes: ["items", "context", "admin"], allowed: ceilingWithSafeFollow(["items", "context", "admin"]), allowDangerous: true }),
  ["items", "context", "admin"], "C5 켜면 실린다");

console.log("safe-follow unit tests: passed");
