import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import { currentTenant, ownsTenant, requireTenant, resolveTenantFromHeaders, shardTenants, withTenant } from "./tenant-context.js";

afterEach(() => { delete process.env.LIVELY_GATEWAY_SHARD_TENANTS; });

// ── OSS 무회귀: 컨텍스트를 안 쓰면 아무것도 달라지지 않는다 ────────────────────

test("기본(컨텍스트 밖) — currentTenant 는 null 이다(종전 동작)", () => {
  assert.equal(currentTenant(), null);
});

test("requireTenant 는 컨텍스트가 없으면 던진다 — 기본값으로 때우지 않는다", () => {
  // "모르면 첫 번째 테넌트" 같은 폴백은 조용히 남의 데이터를 준다. 배선 버그는 500 으로 드러나야 한다.
  assert.throws(() => requireTenant(), /테넌트 컨텍스트가 없습니다/);
});

test("withTenant 안에서는 그 테넌트가 보인다", () => {
  withTenant({ id: "t1", slug: "acme" }, () => {
    assert.equal(currentTenant()?.slug, "acme");
    assert.equal(requireTenant().id, "t1");
  });
  assert.equal(currentTenant(), null, "블록을 나오면 다시 없어야 한다");
});

test("중첩되면 안쪽이 이긴다", () => {
  withTenant({ id: "t1", slug: "a" }, () => {
    withTenant({ id: "t2", slug: "b" }, () => {
      assert.equal(currentTenant()?.slug, "b");
    });
    assert.equal(currentTenant()?.slug, "a", "안쪽을 나오면 바깥이 복원돼야 한다");
  });
});

// ★★ 이 파일의 존재 이유 — 동시 요청이 서로의 테넌트를 덮으면 그게 곧 **데이터 유출**이다.
//  전역 변수로 구현하면 이 테스트가 깨진다(await 사이에 다른 요청이 값을 바꿔 놓는다).
test("★★ 동시 요청이 서로의 컨텍스트를 오염시키지 않는다", async () => {
  const seen: string[] = [];
  const oneRequest = async (slug: string, delayMs: number): Promise<string> =>
    withTenant({ id: `id-${slug}`, slug }, async () => {
      // await 를 여러 번 넘어도(= 다른 요청에게 실행권이 넘어가도) 내 테넌트를 유지해야 한다.
      await new Promise((r) => setTimeout(r, delayMs));
      const mid = requireTenant().slug;
      await new Promise((r) => setTimeout(r, delayMs));
      const end = requireTenant().slug;
      assert.equal(mid, slug, `중간에 ${slug} 가 ${mid} 로 바뀌었다`);
      assert.equal(end, slug, `끝에 ${slug} 가 ${end} 로 바뀌었다`);
      seen.push(end);
      return end;
    });

  // 일부러 지연을 엇갈리게 줘서 서로의 await 사이에 끼어들게 만든다.
  const out = await Promise.all([
    oneRequest("acme", 12),
    oneRequest("beta", 3),
    oneRequest("gamma", 7),
    oneRequest("delta", 1),
  ]);
  assert.deepEqual(out, ["acme", "beta", "gamma", "delta"]);
  assert.equal(new Set(seen).size, 4, "네 요청이 서로 다른 테넌트로 끝나야 한다");
});

// ── 샤드 소속 ───────────────────────────────────────────────────────────────

test("샤드 미설정 = 전부 담당(단일 샤드가 기본)", () => {
  assert.equal(shardTenants({} as NodeJS.ProcessEnv), null);
  assert.equal(ownsTenant("anything", {} as NodeJS.ProcessEnv), true);
});

test("빈 값·공백·쉼표만이면 미설정과 같다", () => {
  for (const raw of ["", "   ", ",", " , , "]) {
    assert.equal(shardTenants({ LIVELY_GATEWAY_SHARD_TENANTS: raw } as NodeJS.ProcessEnv), null, `raw=${JSON.stringify(raw)}`);
  }
});

test("샤드를 설정하면 그 목록만 담당한다", () => {
  const env = { LIVELY_GATEWAY_SHARD_TENANTS: "acme, beta" } as NodeJS.ProcessEnv;
  assert.deepEqual([...shardTenants(env)!].sort(), ["acme", "beta"]);
  assert.equal(ownsTenant("acme", env), true);
  assert.equal(ownsTenant("beta", env), true);
  assert.equal(ownsTenant("gamma", env), false);
});

// 호출 시점에 읽어야 재배포 없이 샤드를 바꿀 여지가 남는다(세션 spawn 훅에서 얻은 교훈).
test("샤드 값은 호출 시점에 읽는다", () => {
  assert.equal(ownsTenant("acme"), true);
  process.env.LIVELY_GATEWAY_SHARD_TENANTS = "other";
  assert.equal(ownsTenant("acme"), false);
  delete process.env.LIVELY_GATEWAY_SHARD_TENANTS;
  assert.equal(ownsTenant("acme"), true);
});

// ── 헤더 해소 ───────────────────────────────────────────────────────────────

const H = (o: Record<string, string>) => o as Record<string, string | string[] | undefined>;
const SECRET = "s3cr3t-router-key";
const envWith = (extra: Record<string, string> = {}) =>
  ({ LIVELY_TENANT_HEADER_SECRET: SECRET, ...extra }) as NodeJS.ProcessEnv;

test("비밀이 없으면 disabled — 자가호스팅은 이 경로가 없는 것과 같다", () => {
  const r = resolveTenantFromHeaders(H({ "x-lvly-tenant": "acme" }), {} as NodeJS.ProcessEnv);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false ? r.reason : null, "disabled");
});

test("정상 — 비밀이 맞고 slug·id 가 있으면 해소된다", () => {
  const r = resolveTenantFromHeaders(H({
    "x-lvly-tenant-auth": SECRET, "x-lvly-tenant": "acme", "x-lvly-tenant-id": "uuid-1",
  }), envWith());
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok === true ? r.tenant : null, { id: "uuid-1", slug: "acme" });
});

// ★★ 이 파일의 두 번째 존재 이유 — 헤더는 누구나 붙일 수 있다. 비밀 없이 통과하면
//  게이트웨이에 직접 닿는 무엇이든 남의 테넌트로 위장할 수 있다(라우터 우회 = 캡 집행 우회이기도 하다).
test("★★ 비밀이 없거나 틀리면 거부한다 — 헤더만으로는 절대 신뢰하지 않는다", () => {
  for (const auth of [undefined, "", "wrong", SECRET + "x", SECRET.slice(0, -1)]) {
    const h: Record<string, string> = { "x-lvly-tenant": "victim", "x-lvly-tenant-id": "uuid-v" };
    if (auth !== undefined) h["x-lvly-tenant-auth"] = auth;
    const r = resolveTenantFromHeaders(H(h), envWith());
    assert.equal(r.ok, false, `auth=${JSON.stringify(auth)} 인데 통과했다`);
    assert.equal(r.ok === false ? r.reason : null, "unauthenticated");
  }
});

test("slug 형식이 이상하거나 id 가 없으면 거부 — 이 값은 로그·경로·오류에 실린다", () => {
  for (const slug of ["../x", "a b", "A-UP", "", "a;id", "a/b"]) {
    const r = resolveTenantFromHeaders(H({
      "x-lvly-tenant-auth": SECRET, "x-lvly-tenant": slug, "x-lvly-tenant-id": "uuid-1",
    }), envWith());
    assert.equal(r.ok, false, `허용되면 안 됨: ${slug}`);
  }
  const noId = resolveTenantFromHeaders(H({ "x-lvly-tenant-auth": SECRET, "x-lvly-tenant": "acme" }), envWith());
  assert.equal(noId.ok, false);
});

// 샤딩에서 남의 샤드 요청을 조용히 처리하면 두 게이트웨이가 같은 테넌트를 만진다(크론·tmux 옵션 경합).
test("★ 내 샤드가 아니면 거절한다 — 조용히 처리하지 않는다", () => {
  const env = envWith({ LIVELY_GATEWAY_SHARD_TENANTS: "beta,gamma" });
  const mine = resolveTenantFromHeaders(H({
    "x-lvly-tenant-auth": SECRET, "x-lvly-tenant": "beta", "x-lvly-tenant-id": "uuid-b",
  }), env);
  assert.equal(mine.ok, true);
  const theirs = resolveTenantFromHeaders(H({
    "x-lvly-tenant-auth": SECRET, "x-lvly-tenant": "acme", "x-lvly-tenant-id": "uuid-a",
  }), env);
  assert.equal(theirs.ok, false);
  assert.equal(theirs.ok === false ? theirs.reason : null, "not-owned");
});

test("헤더가 배열로 와도(중복 전송) 첫 값을 쓴다", () => {
  const r = resolveTenantFromHeaders({
    "x-lvly-tenant-auth": [SECRET, "junk"], "x-lvly-tenant": ["acme"], "x-lvly-tenant-id": ["uuid-1"],
  }, envWith());
  assert.equal(r.ok, true);
});
