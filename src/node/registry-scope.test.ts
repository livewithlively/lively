// 순수 단위 체크(node:assert) — 노드 레지스트리 테넌트 스코프(#2044). 근거는 registry-scope.ts 머리말.
// 실행: npm run build && node dist/node/registry-scope.test.js
//
// 사양 엣지 표(입력 조합 × 기대)의 **행마다 테스트 1개**. 표는 스크래치패드 spec.md 와 같은 것:
//   스코프  S1 단일 · S2 fixed · S3 registry · S4 중앙(다른 테넌트) · S5 접두사 필터 ·
//           S6 테넌트 id 가 서로 접두사(경계값) · S7 소속 값 부재(새 값이 빈 경우)
//   업그레이드 U1 단일(헤더 없음 수락) · U2 중앙(서명 O) · U3 서명 X/불일치 · U4 정보 부족 · U5 샤드 불일치
import assert from "node:assert/strict";
import { scopeKey, sharedGatewayMode, nodeUpgradeTenant, SCOPE_SEP } from "./registry-scope.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const SECRET = "s".repeat(32);
const TID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

/** 배포 모양별 env — 실배포 조합만 쓴다(lvly-cloud deploy/lvly-gw.sh · boot/tenancy-env.ts). */
const ENV = {
  selfhost: {} as NodeJS.ProcessEnv,
  fixed: { LIVELY_TENANT_BINDING: "rls", LIVELY_TENANT_ID: TID } as NodeJS.ProcessEnv,
  registry: { LIVELY_TENANT_BINDING: "rls", LIVELY_TENANCY_MODE: "registry" } as NodeJS.ProcessEnv,
  central: { LIVELY_TENANT_BINDING: "rls", LIVELY_TENANT_HEADER_SECRET: SECRET } as NodeJS.ProcessEnv,
};
const hdr = (o: Record<string, string>): Record<string, string | string[] | undefined> => o;
const signed = (slug: string, id: string): Record<string, string> =>
  ({ "x-lvly-tenant-auth": SECRET, "x-lvly-tenant": slug, "x-lvly-tenant-id": id });

// ── ① 스코프(맵 키) ─────────────────────────────────────────────────────────
t("S1 워크스페이스 1개면 나누지 않는다 — 소속 값을 줘도 키가 흔들리지 않는다(무회귀의 핵심)", () => {
  assert.equal(sharedGatewayMode(ENV.selfhost), false);
  assert.equal(scopeKey("macbook-pro", null, ENV.selfhost), scopeKey("macbook-pro", TID, ENV.selfhost));
});
t("S2 공용 저장소 + 프로세스당 1워크스페이스(fixed)도 나누지 않는다", () => {
  assert.equal(sharedGatewayMode(ENV.fixed), false);
  assert.equal(scopeKey("mac", TID, ENV.fixed), scopeKey("mac", OTHER, ENV.fixed));
});
t("S3 셀프호스트 다중 워크스페이스(registry)도 나누지 않는다 — 노드 연결엔 소속 신호가 없다", () => {
  assert.equal(sharedGatewayMode(ENV.registry), false);
  assert.equal(scopeKey("mac", TID, ENV.registry), scopeKey("mac", OTHER, ENV.registry));
});
t("S4 ★ 공유 게이트웨이는 나눈다 — 호스트명이 같아도 워크스페이스가 다르면 다른 자리다", () => {
  assert.equal(sharedGatewayMode(ENV.central), true);
  assert.notEqual(
    scopeKey("macbook-pro", TID, ENV.central),
    scopeKey("macbook-pro", OTHER, ENV.central),
    "겹치면 뒤에 붙은 노드가 앞 노드를 재연결로 오인해 끊는다",
  );
});
t("S5 노드 이름을 비우면 그 소속의 접두사 — 순회가 이걸로 남의 소속을 거른다", () => {
  const p = scopeKey("", TID, ENV.central);
  assert.ok(scopeKey("mac", TID, ENV.central).startsWith(p), "제 소속은 걸려야 한다");
  assert.ok(!scopeKey("mac", OTHER, ENV.central).startsWith(p), "남의 소속은 안 걸려야 한다");
});
t("S6 경계값: 한 소속 값이 다른 값의 접두사여도 서로 안 걸린다", () => {
  const short = "abc", long = "abcd";            // long 이 short 로 시작한다
  const pShort = scopeKey("", short, ENV.central);
  assert.ok(!scopeKey("mac", long, ENV.central).startsWith(pShort),
    "경계 문자가 없으면 abc 의 순회가 abcd 의 노드를 함께 훑는다");
  assert.ok(scopeKey("mac", short, ENV.central).startsWith(pShort));
});
t("S7 소속 값이 비어도 던지지 않는다 — 다만 소속 있는 것과는 다른 자리다", () => {
  assert.doesNotThrow(() => scopeKey("mac", null, ENV.central));
  assert.doesNotThrow(() => scopeKey("mac", undefined, ENV.central));
  assert.notEqual(scopeKey("mac", null, ENV.central), scopeKey("mac", TID, ENV.central));
});

// ── ② 업그레이드 수락 판정 ──────────────────────────────────────────────────
t("U1 워크스페이스 1개: 헤더가 없어도 받는다(소속 없음) — 종전 경로 그대로", () => {
  const v = nodeUpgradeTenant(hdr({}), ENV.selfhost);
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.tenant, null);
});
t("U2 ★ 공유 게이트웨이: 앞단이 서명한 헤더면 그 소속으로 연다 — 이게 없어 매니지드 노드가 못 붙었다", () => {
  const v = nodeUpgradeTenant(hdr(signed("acme", TID)), ENV.central);
  assert.equal(v.ok, true);
  assert.deepEqual(v.ok && v.tenant, { id: TID, slug: "acme" });
});
t("U3 공유 게이트웨이: 서명이 없거나 틀리면 거부 — 헤더를 지어내면 임의 워크스페이스가 된다", () => {
  const none = nodeUpgradeTenant(hdr({ "x-lvly-tenant": "acme", "x-lvly-tenant-id": TID }), ENV.central);
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.reason, "unauthenticated");
  const wrong = nodeUpgradeTenant(hdr({ ...signed("acme", TID), "x-lvly-tenant-auth": "x".repeat(32) }), ENV.central);
  assert.equal(wrong.ok, false);
  assert.equal(!wrong.ok && wrong.reason, "unauthenticated");
});
t("U4 공유 게이트웨이: 서명은 맞는데 소속 정보가 없으면 거부(앞단 매핑 파손)", () => {
  const v = nodeUpgradeTenant(hdr({ "x-lvly-tenant-auth": SECRET }), ENV.central);
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.reason, "missing");
});
t("U5 샤딩: 내 샤드가 아니면 거부 — 두 게이트웨이가 같은 워크스페이스를 만지지 않게", () => {
  const v = nodeUpgradeTenant(hdr(signed("acme", TID)), { ...ENV.central, LIVELY_GATEWAY_SHARD_TENANTS: "other" });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.reason, "not-owned");
});

// ── 배선 단언 — 관측 장치가 죽어 있으면 위 전부가 조용히 통과한다 ────────────
t("W1 경계 문자는 슬러그·UUID 문자집합과 겹치지 않는다(한 글자)", () => {
  assert.equal(SCOPE_SEP.length, 1);
  assert.ok(!/[A-Za-z0-9-]/.test(SCOPE_SEP));
});

console.log(`\n${pass} passed`);
