import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import { clearTenantResolver, tenantBindingActive } from "./client.js";
import { installTenantBinding, resolveBindingMode } from "./tenant-binding-boot.js";

afterEach(() => clearTenantResolver());
const E = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;
const UUID = "11111111-2222-3333-4444-555555555555";

// ── OSS 무회귀 ──────────────────────────────────────────────────────────────

test("★★ 미설정이면 주입하지 않는다 — 자가호스팅은 종전과 완전히 같다", () => {
  assert.deepEqual(resolveBindingMode(E()), { mode: "off" });
  installTenantBinding(E());
  assert.equal(tenantBindingActive(), false);
});

test("off 를 명시해도 같다", () => {
  assert.deepEqual(resolveBindingMode(E({ LIVELY_TENANT_BINDING: "off" })), { mode: "off" });
});

// ★ 오타로 조용히 안 켜지면 그게 곧 유출이다 — 값이 이상하면 기동을 실패시킨다.
test("★★ 값이 이상하면 off 로 떨어지지 않고 던진다", () => {
  for (const bad of ["rsl", "true", "1", "on", "RLS!"]) {
    assert.throws(() => resolveBindingMode(E({ LIVELY_TENANT_BINDING: bad })), /잘못됐습니다/, `허용되면 안 됨: ${bad}`);
  }
});

// ── fixed 모드 — 공용 DB 로 먼저 옮기고 게이트웨이 통합은 나중에 ──────────────

test("테넌트 id 를 주면 fixed 모드", () => {
  assert.deepEqual(resolveBindingMode(E({ LIVELY_TENANT_BINDING: "rls", LIVELY_TENANT_ID: UUID })), { mode: "fixed", tenantId: UUID });
});

// ★★ 형식이 틀린 값으로 뜨면 그 게이트웨이의 **모든 쿼리**가 잘못된 소속으로 돈다 — 500 보다 나쁘다.
test("★★ 테넌트 id 가 UUID 형식이 아니면 기동을 중단시킨다", () => {
  for (const bad of ["not-a-uuid", "1111", "'; DROP TABLE x; --", "11111111-2222-3333-4444-5555555555"]) {
    assert.throws(() => resolveBindingMode(E({ LIVELY_TENANT_BINDING: "rls", LIVELY_TENANT_ID: bad })), /UUID 형식/, `허용되면 안 됨: ${bad}`);
  }
});

test("fixed 를 배선하면 바인딩이 켜지고 그 값을 준다", () => {
  const msg = installTenantBinding(E({ LIVELY_TENANT_BINDING: "rls", LIVELY_TENANT_ID: UUID }));
  assert.equal(tenantBindingActive(), true);
  assert.match(msg, /고정/);
  assert.ok(!msg.includes(UUID), "로그에 전체 id 를 그대로 찍지 않는다(앞 8자만)");
});

// ── request 모드 ────────────────────────────────────────────────────────────

test("테넌트 id 가 없으면 request 모드(공유 게이트웨이)", () => {
  assert.deepEqual(resolveBindingMode(E({ LIVELY_TENANT_BINDING: "rls" })), { mode: "request" });
});

test("request 를 배선하면 켜지고, 컨텍스트가 없으면 null 을 준다(던지지 않는다)", () => {
  const msg = installTenantBinding(E({ LIVELY_TENANT_BINDING: "rls" }));
  assert.equal(tenantBindingActive(), true);
  assert.match(msg, /요청별/);
});
