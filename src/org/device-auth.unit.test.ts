// device-auth 순수함수 유닛 (#880) — user_code 정규화/표시 계약(R3-F4). DB 불요(기본 npm test 체인).
//  정규화가 틀리면 사용자가 소문자·하이픈을 다르게 쳐서 lookup/approve 가 조용히 404 → 로그인 불가.
import assert from "node:assert/strict";
import { normalizeUserCode, formatUserCode } from "./device-auth.js";

// ── 정규화: 대문자화 + 영숫자만 + 8자 컷 ──
assert.equal(normalizeUserCode("mpqrstvw"), "MPQRSTVW", "소문자 → 대문자");
assert.equal(normalizeUserCode("MPQR-STVW"), "MPQRSTVW", "하이픈 제거");
assert.equal(normalizeUserCode("mpqr-stvw"), "MPQRSTVW", "소문자+하이픈");
assert.equal(normalizeUserCode("  MPQR STVW  "), "MPQRSTVW", "공백 제거");
assert.equal(normalizeUserCode("MPQRSTVWEXTRA"), "MPQRSTVW", "8자 초과 컷");
assert.equal(normalizeUserCode(""), "", "빈 값");
assert.equal(normalizeUserCode(null), "", "null 안전");
assert.equal(normalizeUserCode("ab!@#cd"), "ABCD", "특수문자 제거");

// ── 표시형: 8자만 4-4 그룹핑, 그 외 원형 ──
assert.equal(formatUserCode("MPQRSTVW"), "MPQR-STVW", "8자 → 4-4");
assert.equal(formatUserCode("ABC"), "ABC", "8자 아니면 원형");
assert.equal(formatUserCode(""), "", "빈 값 원형");

// ── 왕복: 표시형을 다시 정규화하면 저장형으로 복귀(사용자가 표시형을 그대로 입력해도 매치) ──
{
  const stored = "MPQRSTVW";
  assert.equal(normalizeUserCode(formatUserCode(stored)), stored, "표시↔저장 왕복");
}

console.log("device-auth unit tests: 12 passed");
