// #5712 — «로그인 토큰이 구성원의 비위험 권한을 따를지» 를 정하는 순수 판정들. DB 불요.
//  여기가 틀리면 둘 중 하나가 난다: (가) 좁게 구워 준 토큰으로 승인 · 재발급해 구성원 권한 전체를 따르는 토큰을 얻는다(확대),
//  (나) 정상 로그인 토큰이 따르지 않아 권한을 올릴 때마다 다시 로그인해야 한다(이 변경이 없애려는 일).
import assert from "node:assert/strict";
import { SCOPES, SAFE_SCOPES, DANGEROUS_SCOPES } from "../../auth/scopes.js";
import { holdsMemberSafeScopes, ceilingWithSafeFollow, ceilingFollowsSafe, grantableScopes } from "./grant-util.js";

// ── SAFE_SCOPES = SCOPES − 위험 ──
assert.deepEqual([...SAFE_SCOPES].sort(), [...SCOPES].filter((s) => !DANGEROUS_SCOPES.has(s)).sort(), "비위험 = 전체 − 위험");
assert.ok(!SAFE_SCOPES.includes("admin") && !SAFE_SCOPES.includes("runtime"), "admin · runtime 은 비위험이 아니다");
assert.ok(SAFE_SCOPES.includes("items") && SAFE_SCOPES.includes("db") && SAFE_SCOPES.includes("code"), "평소 권한이 든다");

// ── holdsMemberSafeScopes ──
const holds = (memberScopes: unknown, presented: string[], session = false) => holdsMemberSafeScopes({ memberScopes, presented, session });
// [H1] 웹 세션은 언제나 참 — 세션 scope 가 구성원 라이브 scope 그 자체다.
assert.equal(holds(["items", "context"], [], true), true, "H1 세션");
assert.equal(holds([], [], true), true, "H1 세션 — 권한이 없는 구성원도");
// [H2] 토큰이 구성원의 비위험 권한을 전부 쥐고 있으면 참(이미 따르는 토큰 = 데스크톱 앱 안에서 다시 로그인).
assert.equal(holds(["items", "context", "db"], ["items", "context", "db"]), true, "H2 전부 쥠");
// [H3] ★ 하나라도 빠지면 거짓 — 좁게 구워 준 토큰은 구성원 권한을 따르는 토큰을 낳지 못한다(확대 불가).
assert.equal(holds(["items", "context", "db"], ["items", "context"]), false, "H3 좁은 토큰");
assert.equal(holds(["items", "context"], ["context"]), false, "H3 좁은 토큰 2");
// [H4] 위험 scope 는 견주지 않는다 — 관리자인 구성원의 «관리자 기능 없는» 토큰도 비위험을 전부 쥐면 참.
assert.equal(holds(["items", "context", "admin", "runtime"], ["items", "context"]), true, "H4 위험 scope 는 무관");
// [H5] 구성원에게 비위험 권한이 하나도 없으면(견줄 것이 없다) 토큰 자격은 거짓 — 닫힌 쪽.
assert.equal(holds([], ["items"]), false, "H5 빈 구성원");
assert.equal(holds(["admin"], ["admin"]), false, "H5 위험 scope 만 가진 구성원");
// [H6] 손상된 구성원 scope(비배열 · 알 수 없는 값)는 없는 것으로 본다.
assert.equal(holds(null, ["items"]), false, "H6 비배열");
assert.equal(holds(["items", "root"], ["items"]), true, "H6 알 수 없는 값은 견주지 않는다");
// [H7] 토큰이 더 많이 쥐고 있어도(구성원이 그 사이 잃은 권한) 참 — 구성원이 가진 것을 전부 쥐었는가만 본다.
assert.equal(holds(["items"], ["items", "context", "db"]), true, "H7 넘치는 토큰");

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
