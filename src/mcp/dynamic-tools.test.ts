// 커넥터 통합(P1·P2·P3, #746) 순수 로직 단위 체크 — 등급→vault 폴백 정책 + JSON스키마 위생(기존).
// 실행: npm run build && node dist/mcp/dynamic-tools.test.js
//  runHttpProxyTool 의 네트워크/DB 경로는 실 pg 통합(scripts/integration/connector-proxy-pg.mjs)에서.
import assert from "node:assert/strict";
import { proxyAuthFallback, assertSafeJsonSchema, buildProxyAuthHeaders } from "./dynamic-tools.js";
import { credentialHeaderNames } from "../net/ssrf.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// P1·P2 — 등급이 vault 자격 폴백 정책을 정한다: L2(집행)만 per-user 필수(통합 폴백 금지).
t("proxyAuthFallback: L0/L1/null → true(통합 폴백 허용)", () => {
  assert.equal(proxyAuthFallback("L0"), true);
  assert.equal(proxyAuthFallback("L1"), true);
  assert.equal(proxyAuthFallback(null), true);
  assert.equal(proxyAuthFallback(undefined), true);
});
t("proxyAuthFallback: L2 및 예상밖 값 → false(allow-list, fail-closed)", () => {
  assert.equal(proxyAuthFallback("L2"), false);
  assert.equal(proxyAuthFallback("L3"), false); // 예상 밖 값도 폴백 금지(fail-closed)
  assert.equal(proxyAuthFallback("admin" as unknown as string), false);
});

// P1 — vault 해소 결과 → 인증 헤더(순수). 기본 Bearer + 커스텀 헤더명/prefix.
t("buildProxyAuthHeaders: 기본 Authorization: Bearer", () => {
  const b = buildProxyAuthHeaders(undefined, "glpat-XYZ");
  assert.equal(b.headerName, "Authorization");
  assert.equal(b.headers.Authorization, "Bearer glpat-XYZ");
});
t("buildProxyAuthHeaders: 커스텀 헤더명(PRIVATE-TOKEN)·빈 prefix", () => {
  const b = buildProxyAuthHeaders({ auth_header: "PRIVATE-TOKEN", token_prefix: "" }, "glpat-XYZ");
  assert.equal(b.headerName, "PRIVATE-TOKEN");
  assert.equal(b.headers["PRIVATE-TOKEN"], "glpat-XYZ");
});

// B14 확장 — 크로스-오리진 리다이렉트 시 벗길 자격 헤더 집합(커스텀 헤더명 포함).
t("credentialHeaderNames: Authorization·cookie 항상 + 커스텀(소문자화)", () => {
  const s = credentialHeaderNames(["PRIVATE-TOKEN"]);
  assert.ok(s.has("authorization") && s.has("cookie") && s.has("private-token"));
  assert.ok(!s.has("user-agent"));
});

// 기존 JSON 스키마 위생(회귀) — $ref·프로토타입 오염·과대·비-object 거부.
t("assertSafeJsonSchema: 정상 object 통과", () => {
  assertSafeJsonSchema({ type: "object", properties: { q: { type: "string" } } });
});
t("assertSafeJsonSchema: $ref·프로토타입 오염·비object 거부", () => {
  assert.throws(() => assertSafeJsonSchema({ $ref: "#/x" }));
  // own 속성 '__proto__' (리터럴이 아니라 JSON.parse 로 만들어야 stringify 에 포함됨 — 실제 위협 형태)
  assert.throws(() => assertSafeJsonSchema(JSON.parse('{"properties":{"__proto__":{"type":"string"}}}')));
  assert.throws(() => assertSafeJsonSchema({ type: "array" }));
});

console.log(`\ndynamic-tools tests: ${pass} passed`);
