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

// ★★ 실측(E2E)으로 밟은 구멍 — 게이트웨이 부팅에서만 꽂으면 **DB 를 만지는 다른 진입점**이
//  바인딩 없이 돈다(deploy/bootstrap-admin.mjs 가 그랬다). 고정 모드는 env 하나로 결정되므로
//  leaf 가 스스로 켤 수 있고, 그러면 모든 진입점이 자동으로 덮인다.
test("★★ 고정 바인딩은 모듈 로드에서 자가 설치된다(모든 진입점을 덮는다)", async () => {
  const id = "33333333-4444-4555-8666-777777777777";
  const prevMode = process.env.LIVELY_TENANT_BINDING, prevId = process.env.LIVELY_TENANT_ID;
  process.env.LIVELY_TENANT_BINDING = "rls";
  process.env.LIVELY_TENANT_ID = id;
  try {
    // 모듈 캐시를 우회해 새로 평가한다(자가 설치가 로드 시점에 도는지 보려면 새 인스턴스가 필요하다).
    const fresh = await import(`./client.js?fresh=${Date.now()}`);
    assert.equal(fresh.tenantBindingActive(), true, "로드만으로 켜져야 한다");
    assert.deepEqual(fresh.tenantBindingSql()?.params, [id]);
  } finally {
    if (prevMode === undefined) delete process.env.LIVELY_TENANT_BINDING; else process.env.LIVELY_TENANT_BINDING = prevMode;
    if (prevId === undefined) delete process.env.LIVELY_TENANT_ID; else process.env.LIVELY_TENANT_ID = prevId;
  }
});

test("★ 형식이 틀린 id 면 자가 설치하지 않는다(잘못된 소속으로 도는 것보다 안 켜지는 게 낫다)", async () => {
  const prev = process.env.LIVELY_TENANT_ID;
  process.env.LIVELY_TENANT_BINDING = "rls";
  process.env.LIVELY_TENANT_ID = "not-a-uuid";
  try {
    const fresh = await import(`./client.js?bad=${Date.now()}`);
    assert.equal(fresh.tenantBindingActive(), false);
  } finally {
    delete process.env.LIVELY_TENANT_BINDING;
    if (prev === undefined) delete process.env.LIVELY_TENANT_ID; else process.env.LIVELY_TENANT_ID = prev;
  }
});
