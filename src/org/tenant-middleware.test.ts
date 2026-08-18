import { strict as assert } from "node:assert";
import test from "node:test";
import { TENANT_AUTH_HEADER, TENANT_HEADER, TENANT_ID_HEADER, currentTenant } from "./tenant-context.js";
import { isTenantAgnosticPath, statusForReason, tenantContextMiddleware } from "./tenant-middleware.js";

const SECRET = "s".repeat(32);
const E = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv;

/** express 없이 미들웨어를 돌린다 — 응답은 캡처하고, next() 안에서 컨텍스트를 읽는다. */
function run(headers: Record<string, string>, env: NodeJS.ProcessEnv) {
  let nexted = false;
  let seen: { id: string; slug: string } | null = null;
  let status = 0;
  let body: unknown = null;
  const res = {
    status(c: number) { status = c; return this; },
    json(b: unknown) { body = b; return this; },
  };
  tenantContextMiddleware(env)(
    { headers } as never,
    res as never,
    () => { nexted = true; seen = currentTenant(); },
  );
  return { nexted, seen, status, body };
}

const ID = "11111111-2222-3333-4444-555555555555";
// ⚠ 헤더 이름을 문자열로 적지 않는다 — 구현과 테스트가 각자 다른 이름을 쓰면 테스트는 통과하는데
//  실제 요청은 거절된다(이 파일을 쓰다 실제로 밟았다).
const hdr = (over: Record<string, string> = {}) => ({
  [TENANT_AUTH_HEADER]: SECRET,
  [TENANT_HEADER]: "acme",
  [TENANT_ID_HEADER]: ID,
  ...over,
});

// ── OSS 무회귀 ──────────────────────────────────────────────────────────────

// ★★ 비밀이 없으면 이 미들웨어는 **아무것도 하지 않는다.** 자가호스팅에 한 줄도 영향이 없어야 한다.
test("★★ 비밀 미설정이면 그냥 통과시킨다(컨텍스트도 안 연다)", () => {
  const r = run(hdr(), E());
  assert.equal(r.nexted, true);
  assert.equal(r.seen, null, "단일 테넌트인데 컨텍스트가 열렸다");
  assert.equal(r.status, 0);
});

// ── 정상 경로 ───────────────────────────────────────────────────────────────

// ★★ `next()` 를 withTenant **안에서** 불러야 뒤의 모든 핸들러가 같은 비동기 체인에 들어온다.
//  밖에서 부르면 컨텍스트가 이 미들웨어에서 끝나고, 그 뒤는 전부 "테넌트 모름" 이 된다.
test("★★ next() 가 컨텍스트 안에서 불린다", () => {
  const r = run(hdr(), E({ LIVELY_TENANT_HEADER_SECRET: SECRET }));
  assert.equal(r.nexted, true);
  assert.deepEqual(r.seen, { id: ID, slug: "acme" });
});

test("컨텍스트는 미들웨어 밖으로 새지 않는다", () => {
  run(hdr(), E({ LIVELY_TENANT_HEADER_SECRET: SECRET }));
  assert.equal(currentTenant(), null, "요청이 끝났는데 컨텍스트가 남았다");
});

// ── 거절 ────────────────────────────────────────────────────────────────────

// ★ 인증 실패는 **통과시키지 않는다**. 통과시키면 그 요청이 "테넌트 모름" 으로 DB 에 닿는데,
//  그때 나오는 값은 0행이 아니라 단일 테넌트 폴백 경로의 것일 수 있다.
test("★ 비밀이 틀리면 401 이고 next() 를 안 부른다", () => {
  const r = run(hdr({ [TENANT_AUTH_HEADER]: "wrong" }), E({ LIVELY_TENANT_HEADER_SECRET: SECRET }));
  assert.equal(r.nexted, false);
  assert.equal(r.status, 401);
});

test("헤더가 아예 없어도 401 이다(통과가 아니다)", () => {
  const r = run({}, E({ LIVELY_TENANT_HEADER_SECRET: SECRET }));
  assert.equal(r.nexted, false);
  assert.equal(r.status, 401);
});

test("인증은 됐는데 식별 정보가 없으면 400", () => {
  const r = run(hdr({ [TENANT_ID_HEADER]: "" }), E({ LIVELY_TENANT_HEADER_SECRET: SECRET }));
  assert.equal(r.nexted, false);
  assert.equal(r.status, 400);
});

// ★★ 남의 샤드 요청을 조용히 처리하면 **두 게이트웨이가 같은 테넌트를 만진다**(크론 2벌,
//  tmux 옵션 writer 2벌). 그건 데이터 경합이라 400 보다 나쁘다 — 앞단 지도가 낡았다고 알린다.
test("★★ 내 샤드가 아니면 502 로 거절한다", () => {
  const env = E({ LIVELY_TENANT_HEADER_SECRET: SECRET, LIVELY_GATEWAY_SHARD_TENANTS: "other,another" });
  const r = run(hdr(), env);
  assert.equal(r.nexted, false);
  assert.equal(r.status, 502);
});

test("샤드에 속하면 통과한다", () => {
  const env = E({ LIVELY_TENANT_HEADER_SECRET: SECRET, LIVELY_GATEWAY_SHARD_TENANTS: "acme,other" });
  assert.equal(run(hdr(), env).nexted, true);
});

// ── 상태코드 매핑 ───────────────────────────────────────────────────────────

test("사유마다 다른 상태코드를 준다 — 로그만 보고 원인을 가를 수 있게", () => {
  const codes = new Set(["unauthenticated", "missing", "not-owned"].map(statusForReason));
  assert.equal(codes.size, 3, "사유가 같은 코드로 뭉개지면 진단이 안 된다");
});

// ── 비밀 유출 방어 ──────────────────────────────────────────────────────────

// ★ 거절 응답에 비밀이나 헤더 전체가 실리면, 잘못 배선된 앞단이 그걸 로그에 남긴다.
test("★ 거절 응답 본문에 비밀이 실리지 않는다", () => {
  const r = run(hdr({ [TENANT_AUTH_HEADER]: "wrong" }), E({ LIVELY_TENANT_HEADER_SECRET: SECRET }));
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  assert.ok(!JSON.stringify(r.body).includes("wrong"));
});

// ── 테넌트와 무관한 경로 ────────────────────────────────────────────────────
// ⚠ 목록이 넓어지면 그만큼 "테넌트를 모르는 상태"로 앱에 들어가는 문이 늘어난다.
//  헬스체크처럼 **아무 데이터도 안 만지는** 것만 넣는다.
test("★ healthz 는 컨텍스트 없이 통과한다(모니터링이 401 을 보면 안 된다)", () => {
  const r = run({}, E({ LIVELY_TENANT_HEADER_SECRET: SECRET }));
  assert.equal(r.status, 401, "기본은 여전히 거절이어야 한다");
  for (const p of ["/healthz", "/healthz?x=1", "/__router/healthz"]) {
    assert.equal(isTenantAgnosticPath(p), true, p);
  }
});

test("★★ 데이터 경로는 절대 무관 경로가 아니다", () => {
  for (const p of ["/api/ui/org/profile", "/mcp", "/", "/healthzz", "/api/healthz"]) {
    assert.equal(isTenantAgnosticPath(p), false, `${p} 가 통과하면 안 된다`);
  }
});
