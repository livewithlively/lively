// P1: 유효 권한 = intersection(토큰 scope, 멤버 scope). 순수 함수라 DB 없이 검증.
import assert from "node:assert";
import { computeEffectiveScopes } from "./store.js";

// member_id 없는 서비스/레거시 토큰 → 토큰 scope 그대로(교집합 대상 없음).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items", "context"], memberScopes: [] }),
  ["items", "context"],
);

// ── #1780 v2 §7-1(사양 H4) — 멤버 없는 앱 토큰은 **앱이 라이브 상한** ──
// 앱 켜짐·active → 토큰 scope 그대로.
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [], appId: "bot", appLive: true }),
  ["items"],
);
// 앱 꺼짐/비active/행 없음(null) → 거부.
for (const live of [false, null, undefined] as const) {
  assert.strictEqual(
    computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [], appId: "bot", appLive: live }),
    null, `멤버 없는 앱 토큰은 appLive=${String(live)} 면 거부`,
  );
}
// 멤버 연결 앱 토큰(v1 앱 세션)은 앱 상태와 무관하게 종전 멤버 축(무회귀).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: "jang", memberState: "active", tokenScopes: ["items", "context"], memberScopes: ["items"], appId: "browser", appLive: false }),
  ["items"],
);
// 앱도 멤버도 없는 서비스 토큰은 appLive 를 보지 않는다(무회귀).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [], appId: null, appLive: null }),
  ["items"],
);

// 활성 멤버 → 교집합(토큰이 멤버 이하).
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "jang", memberState: "active",
    tokenScopes: ["items", "context", "admin"], memberScopes: ["items", "context", "admin", "runtime"],
  }),
  ["items", "context", "admin"],
);

// 멤버가 admin 없음 → 토큰의 admin 탈락(멤버=라이브 상한 = 강등 즉시 반영).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: "x", memberState: "active", tokenScopes: ["items", "admin"], memberScopes: ["items"] }),
  ["items"],
);

// 비활성 멤버 → 거부(null = 퇴사 즉시 무효).
assert.strictEqual(
  computeEffectiveScopes({ memberId: "x", memberState: "inactive", tokenScopes: ["items"], memberScopes: ["items"] }),
  null,
);

// 멤버 삭제(LEFT JOIN → state=null) but member_id 보유 → 거부.
assert.strictEqual(
  computeEffectiveScopes({ memberId: "ghost", memberState: null, tokenScopes: ["items"], memberScopes: [] }),
  null,
);

// 손상/위조 scope(비허용 값) 제거 — 양쪽 모두.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "x", memberState: "active",
    tokenScopes: ["items", "bogus", "admin"], memberScopes: ["items", "admin", "bogus"],
  }),
  ["items", "admin"],
);

// ── #2174 멤버 추종(followMemberScopes) ────────────────────────────────────────
//  정책: 추종 표시가 붙은 토큰은 scope 를 발급 시점에 박제하지 않고 **멤버의 현재 권한을 그대로** 쓴다.
//   왜 필요했나 — 종전엔 강등만 즉시 반영되고 승격은 토큰 재발급을 요구했다. 그런데 세션이 쓰는 토큰은 사람이
//   들고 다니는 게 아니라 박스에 심긴 것이라, 그 재발급이 **사람 눈에 안 보이는 경로**다. 거기가 실패하면
//   관리자가 올린 권한이 영영 도달하지 않는다(2026-08-28 실측 — 격리 박스에서 토큰 파일만 안 갱신됨).
//  아래 행들은 사양 엣지 표와 1:1 이다. 지켜야 할 불변식은 "멤버가 상한" 과 "내리는 방향은 종전 그대로".

// [1] 승격이 재발급 없이 닿는다 — 이 변경의 목적. 발급 당시엔 admin 이 없던 토큰이다.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "yoon", memberState: "active",
    tokenScopes: ["items", "context"], memberScopes: ["items", "context", "admin", "runtime"],
    followMemberScopes: true,
  }),
  ["items", "context", "admin", "runtime"],
);

// [2] 멤버가 상한이다 — 추종이어도 멤버에게 없는 권한은 나오지 않는다(증폭 불가).
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "yoon", memberState: "active",
    tokenScopes: ["items", "admin"], memberScopes: ["items"],
    followMemberScopes: true,
  }),
  ["items"],
);

// [3] 내리는 방향은 종전 그대로 즉시 — 이 행이 회귀하면 강등이 안 먹는 보안 사고다.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "yoon", memberState: "active",
    tokenScopes: ["items", "context", "admin"], memberScopes: ["items"],
    followMemberScopes: true,
  }),
  ["items"],
);

// [4][5] 비활성·삭제 멤버는 추종이어도 거부(멤버 축이 죽으면 토큰도 죽는다).
for (const state of ["inactive", null] as const) {
  assert.strictEqual(
    computeEffectiveScopes({
      memberId: "gone", memberState: state, tokenScopes: ["items"], memberScopes: ["items", "admin"],
      followMemberScopes: true,
    }),
    null, `추종 토큰도 memberState=${String(state)} 면 거부해야 한다`,
  );
}

// [6] ★ member_id 가 없으면 따라갈 대상이 없다 → 토큰 scope 그대로(서비스/레거시 토큰 무회귀).
//  이 행이 없으면, 플래그가 잘못 켜진 서비스 토큰이 빈 멤버 scope 를 따라가 **조용히 권한 0** 이 된다
//  (거부도 아니고 오류도 아닌 '아무것도 못 하는 토큰' — 원인 찾기가 가장 어려운 형태다).
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: null, memberState: null, tokenScopes: ["items", "context"], memberScopes: [],
    followMemberScopes: true,
  }),
  ["items", "context"],
);

// [7] ★ 멤버 없는 앱 토큰은 **앱이 상한**이다 — 추종 플래그가 그 규칙을 앞지르지 않는다.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [],
    appId: "bot", appLive: true, followMemberScopes: true,
  }),
  ["items"],
);
for (const live of [false, null] as const) {
  assert.strictEqual(
    computeEffectiveScopes({
      memberId: null, memberState: null, tokenScopes: ["items"], memberScopes: [],
      appId: "bot", appLive: live, followMemberScopes: true,
    }),
    null, `추종 플래그가 켜져도 appLive=${String(live)} 면 거부해야 한다`,
  );
}

// [8] 경계값 — 박제된 scope 가 **비어 있어도** 추종이면 멤버 전체가 나온다.
//  (교집합이었다면 빈 배열이다. 이 행이 곧 '박제를 안 본다'의 직접 증거다.)
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "yoon", memberState: "active",
    tokenScopes: [], memberScopes: ["items", "admin"],
    followMemberScopes: true,
  }),
  ["items", "admin"],
);

// [9] 추종이 아닌 토큰(플래그 없음/false)은 종전 교집합 그대로 — 무회귀.
for (const flag of [undefined, false] as const) {
  assert.deepStrictEqual(
    computeEffectiveScopes({
      memberId: "yoon", memberState: "active",
      tokenScopes: ["items", "admin"], memberScopes: ["items", "admin", "runtime"],
      followMemberScopes: flag,
    }),
    ["items", "admin"], `followMemberScopes=${String(flag)} 는 종전 교집합이어야 한다`,
  );
}

// [10] 허용되지 않은 값(JSONB 손상·마이그레이션·위조)은 추종 경로에서도 떨군다.
assert.deepStrictEqual(
  computeEffectiveScopes({
    memberId: "x", memberState: "active",
    tokenScopes: [], memberScopes: ["items", "bogus", "admin"],
    followMemberScopes: true,
  }),
  ["items", "admin"],
);

console.log("token-scope.test ok");
