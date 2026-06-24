// P1: 유효 권한 = intersection(토큰 scope, 멤버 scope). 순수 함수라 DB 없이 검증.
import assert from "node:assert";
import { computeEffectiveScopes } from "./store.js";

// member_id 없는 서비스/레거시 토큰 → 토큰 scope 그대로(교집합 대상 없음).
assert.deepStrictEqual(
  computeEffectiveScopes({ memberId: null, memberState: null, tokenScopes: ["items", "context"], memberScopes: [] }),
  ["items", "context"],
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

console.log("token-scope.test ok");
