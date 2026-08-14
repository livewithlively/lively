import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import {
  clearTenantResolver, installTenantResolver, tenantBindingActive, tenantBindingSql,
} from "./client.js";

afterEach(() => clearTenantResolver());

// ── ★★ OSS 무회귀: 주입이 없으면 이 층은 존재하지 않는 것과 같다 ──────────────
// 자가호스팅은 리졸버를 주입하지 않는다 → 풀 파사드가 원래 풀을 그대로 위임하고,
//  트랜잭션도 추가되지 않는다(종전과 바이트 단위로 같은 동작).

test("★★ 기본(주입 없음) — 바인딩이 꺼져 있다", () => {
  assert.equal(tenantBindingActive(), false);
  assert.equal(tenantBindingSql(), null);
});

test("주입하면 켜지고, 해제하면 다시 꺼진다", () => {
  installTenantResolver(() => "t-1");
  assert.equal(tenantBindingActive(), true);
  clearTenantResolver();
  assert.equal(tenantBindingActive(), false);
});

// ── 바인딩 문장 ─────────────────────────────────────────────────────────────

test("테넌트 id 를 파라미터로 넘긴다 — SQL 문자열에 값을 박지 않는다", () => {
  installTenantResolver(() => "11111111-1111-1111-1111-111111111111");
  const b = tenantBindingSql()!;
  assert.deepEqual(b.params, ["11111111-1111-1111-1111-111111111111"]);
  assert.ok(!b.sql.includes("1111"), "값이 SQL 에 박히면 인젝션 표면이 생긴다");
});

// ★ SET LOCAL 이 아니면 커넥션 재사용 시 남의 컨텍스트를 물려받는다 — 실무 사고 유형이다.
test("★★ 트랜잭션 로컬로 심는다(set_config 세 번째 인자 true)", () => {
  installTenantResolver(() => "t-1");
  assert.match(tenantBindingSql()!.sql, /set_config\('app\.tenant_id', \$1, true\)/);
});

// ── 실패 방향 ───────────────────────────────────────────────────────────────

// ★★ 여기서 던지면 부팅 스키마·마이그레이션까지 막혀 기동이 불가능해진다.
//  컨텍스트 없는 접근을 막는 주체는 이 층이 아니라 **DB 의 정책**이다(`''::uuid` 에서 오류).
test("★★ 테넌트를 못 찾으면 던지지 않고 null 을 준다(막는 주체는 DB 정책이다)", () => {
  installTenantResolver(() => null);
  assert.equal(tenantBindingActive(), true, "켜져는 있다");
  assert.equal(tenantBindingSql(), null, "걸 문장이 없을 뿐이다");
});

test("리졸버는 호출 시점마다 다시 읽힌다 — 요청마다 다른 테넌트여야 하므로", () => {
  let who = "a";
  installTenantResolver(() => who);
  assert.deepEqual(tenantBindingSql()!.params, ["a"]);
  who = "b";
  assert.deepEqual(tenantBindingSql()!.params, ["b"]);
});
