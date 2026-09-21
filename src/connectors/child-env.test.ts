import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv } from "./child-env.js";
import type { TenantBinding } from "./child-env-types.js";

test("바인딩 비활성이면 부모 환경을 그대로 반환하고 테넌트 관련 변수 세 개를 하나도 추가하지 않는다", () => {
  const parentEnv = { FOO: "bar" };
  const binding: TenantBinding = { active: false, tenantId: null };

  const result = buildChildEnv(parentEnv, binding);

  assert.equal(result.env.LIVELY_SKIP_SCHEMA_INIT, undefined);
  assert.equal(result.env.LIVELY_TENANT_BINDING, undefined);
  assert.equal(result.env.LIVELY_TENANT_ID, undefined);
  assert.equal(result.warn, undefined);
});

test("바인딩 활성 + 유효한 UUID면 테넌트 변수 세 개를 모두 얹고 부모의 기존 변수도 보존한다", () => {
  const parentEnv = { FOO: "bar" };
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const binding: TenantBinding = { active: true, tenantId };

  const result = buildChildEnv(parentEnv, binding);

  assert.equal(result.env.LIVELY_SKIP_SCHEMA_INIT, "1");
  assert.equal(result.env.LIVELY_TENANT_BINDING, "rls");
  assert.equal(result.env.LIVELY_TENANT_ID, tenantId);
  assert.equal(result.env.FOO, "bar");
  assert.equal(result.warn, undefined);
});

test("UUID 판정은 대소문자를 가리지 않아 대문자 UUID도 유효한 테넌트로 인정한다", () => {
  const tenantId = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
  const binding: TenantBinding = { active: true, tenantId };

  const result = buildChildEnv({}, binding);

  assert.equal(result.env.LIVELY_TENANT_BINDING, "rls");
  assert.equal(result.env.LIVELY_TENANT_ID, tenantId);
  assert.equal(result.warn, undefined);
});

test("바인딩 활성인데 tenantId 가 null 이면 테넌트 변수는 싣지 않고 SKIP_SCHEMA_INIT 만 실으며 경고를 반환한다", () => {
  const binding: TenantBinding = { active: true, tenantId: null };

  const result = buildChildEnv({}, binding);

  assert.equal(result.env.LIVELY_TENANT_BINDING, undefined);
  assert.equal(result.env.LIVELY_TENANT_ID, undefined);
  assert.equal(result.env.LIVELY_SKIP_SCHEMA_INIT, "1");
  assert.equal(typeof result.warn, "string");
  assert.notEqual(result.warn, "");
});

test("바인딩 활성인데 tenantId 가 빈 문자열이면 테넌트 변수는 싣지 않고 SKIP_SCHEMA_INIT 만 실으며 경고를 반환한다", () => {
  const binding: TenantBinding = { active: true, tenantId: "" };

  const result = buildChildEnv({}, binding);

  assert.equal(result.env.LIVELY_TENANT_BINDING, undefined);
  assert.equal(result.env.LIVELY_TENANT_ID, undefined);
  assert.equal(result.env.LIVELY_SKIP_SCHEMA_INIT, "1");
  assert.equal(typeof result.warn, "string");
  assert.notEqual(result.warn, "");
});

test("바인딩 활성인데 tenantId 가 UUID 형식이 아닌 임의 문자열이면 테넌트 변수는 싣지 않고 SKIP_SCHEMA_INIT 만 실으며 경고를 반환한다", () => {
  const binding: TenantBinding = { active: true, tenantId: "not-a-uuid" };

  const result = buildChildEnv({}, binding);

  assert.equal(result.env.LIVELY_TENANT_BINDING, undefined);
  assert.equal(result.env.LIVELY_TENANT_ID, undefined);
  assert.equal(result.env.LIVELY_SKIP_SCHEMA_INIT, "1");
  assert.equal(typeof result.warn, "string");
  assert.notEqual(result.warn, "");
});

test("바인딩 활성인데 tenantId 의 하이픈 위치가 틀리면 테넌트 변수는 싣지 않고 SKIP_SCHEMA_INIT 만 실으며 경고를 반환한다", () => {
  const binding: TenantBinding = {
    active: true,
    tenantId: "111111111-111-1111-1111-111111111111",
  };

  const result = buildChildEnv({}, binding);

  assert.equal(result.env.LIVELY_TENANT_BINDING, undefined);
  assert.equal(result.env.LIVELY_TENANT_ID, undefined);
  assert.equal(result.env.LIVELY_SKIP_SCHEMA_INIT, "1");
  assert.equal(typeof result.warn, "string");
  assert.notEqual(result.warn, "");
});

test("바인딩 활성인데 tenantId 가 길이 모자란 16진 문자열이면 테넌트 변수는 싣지 않고 SKIP_SCHEMA_INIT 만 실으며 경고를 반환한다", () => {
  const binding: TenantBinding = { active: true, tenantId: "1111-1111-1111" };

  const result = buildChildEnv({}, binding);

  assert.equal(result.env.LIVELY_TENANT_BINDING, undefined);
  assert.equal(result.env.LIVELY_TENANT_ID, undefined);
  assert.equal(result.env.LIVELY_SKIP_SCHEMA_INIT, "1");
  assert.equal(typeof result.warn, "string");
  assert.notEqual(result.warn, "");
});

test("호출 후에도 원본 부모 환경 객체엔 새 변수가 생기지 않는다", () => {
  // 호출부가 process.env 를 그대로 넘기므로, 원본 객체를 건드리면 프로세스 전역 환경이 오염된다.
  const parentEnv = { FOO: "bar" };
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const binding: TenantBinding = { active: true, tenantId };

  buildChildEnv(parentEnv, binding);

  assert.deepEqual(parentEnv, { FOO: "bar" });
});

// 🔴 회귀 락 — invalid 분기에서 부모 환경에 남아 있던 바인딩 변수가 spread 로 새면, 자식이 그 옛 값으로
//  스스로 바인딩을 켜서 **부모가 지금 걸 값과 다른 워크스페이스**에 쓴다(2026-09-21 blind 리뷰 지적).
test("바인딩 활성인데 id 가 유효하지 않으면 부모에 남아 있던 테넌트 변수도 자식에서 제거한다", () => {
  const parent = {
    PATH: "/usr/bin",
    LIVELY_TENANT_BINDING: "rls",
    LIVELY_TENANT_ID: "11111111-1111-1111-1111-111111111111",
  } as NodeJS.ProcessEnv;
  const { env, warn } = buildChildEnv(parent, { active: true, tenantId: null });
  assert.equal(env.LIVELY_TENANT_BINDING, undefined);
  assert.equal(env.LIVELY_TENANT_ID, undefined);
  assert.equal(env.LIVELY_SKIP_SCHEMA_INIT, "1");
  assert.equal(env.PATH, "/usr/bin");
  assert.ok(typeof warn === "string" && warn.length > 0);
  // 부모 객체는 그대로여야 한다(삭제가 원본을 건드리면 게이트웨이 자신의 바인딩이 꺼진다).
  assert.equal(parent.LIVELY_TENANT_BINDING, "rls");
});

test("바인딩 실패 원인을 구분해 알린다 — id 없음과 형식 오류는 다른 사고다", () => {
  const none = buildChildEnv({}, { active: true, tenantId: null }).warn ?? "";
  const bad = buildChildEnv({}, { active: true, tenantId: "not-a-uuid" }).warn ?? "";
  assert.notEqual(none, bad);
});

// 이 함수의 핵심 안전 속성 — 자식을 **부모와 같은 워크스페이스**에 못 박는다. 부모 env 에 다른 id 가
//  남아 있어도 지금 걸 값이 이겨야 한다(스프레드 순서를 뒤집는 변이를 잡는다).
test("부모 env 에 다른 테넌트 값이 있어도 지금 바인딩 값이 이긴다", () => {
  const parent = {
    LIVELY_TENANT_BINDING: "legacy",
    LIVELY_TENANT_ID: "99999999-9999-9999-9999-999999999999",
  } as NodeJS.ProcessEnv;
  const { env } = buildChildEnv(parent, { active: true, tenantId: "abcdef01-2345-6789-abcd-ef0123456789" });
  assert.equal(env.LIVELY_TENANT_BINDING, "rls");
  assert.equal(env.LIVELY_TENANT_ID, "abcdef01-2345-6789-abcd-ef0123456789");
});

// 비활성 분기도 복사본을 돌려준다 — 부모 객체를 그대로 주면 호출부 변형이 process.env 를 오염시킨다.
test("바인딩 비활성이면 부모와 같은 내용이지만 다른 객체를 돌려준다", () => {
  const parent = { FOO: "bar" } as NodeJS.ProcessEnv;
  const { env } = buildChildEnv(parent, { active: false, tenantId: null });
  assert.equal(env.FOO, "bar");
  assert.notEqual(env, parent);
});
