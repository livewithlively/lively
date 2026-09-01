// 테넌트별 TTL 캐시 계약 (#2055) — **한 프로세스가 여러 테넌트를 서비스한다**는 사실이 이 표의 전부다.
//
//  계기(실측 2026-08-27, 프로덕션): 정책 캐시가 모듈 전역 한 칸이라, 갓 만든 테넌트가 읽은 기본값 0/0 이
//  30초 동안 **정상 테넌트(1536)에도 적용**됐다. 코어는 0 이면 cgspawn 갈래를 안 타므로 매니지드의
//  «세션 = 컨테이너 1개» 격리가 조용히 꺼졌다 — 세션은 멀쩡히 뜨고 격리만 사라지는 무증상 저하다.
//  e2e 가 «간헐적으로» 빨간불이던 정체가 이것이고, 간헐적이었던 이유는 TTL 30초 창에 걸려야 재현되기 때문이다.
import assert from "node:assert/strict";
import { tenantTtlCache } from "./tenant-ttl-cache.js";
import { withTenant } from "./tenant-context.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn(); pass++; console.log(`ok  ${name}`);
};
const T = (id: string) => ({ id, slug: id });

await t("★ A1 남의 값에 오염되지 않는다 — 이 파일이 존재하는 이유", async () => {
  const c = tenantTtlCache<number>(30_000, () => -1);
  const a = await withTenant(T("t1"), () => c.get(async () => 0));      // 설정 없는 테넌트(기본값)
  const b = await withTenant(T("t2"), () => c.get(async () => 1536));   // 정상 테넌트
  assert.equal(a, 0);
  assert.equal(b, 1536, "전역 한 칸이면 여기서 0 이 나온다 — 그게 프로덕션에서 벌어진 일이다");
});

await t("★ A2 캐시는 살아 있다 — 세션 생성마다 DB 를 때리면 고친 게 아니다", async () => {
  let hits = 0;
  const c = tenantTtlCache<number>(30_000, () => -1);
  const load = async (): Promise<number> => { hits++; return 7; };
  await withTenant(T("t1"), () => c.get(load));
  await withTenant(T("t1"), () => c.get(load));
  assert.equal(hits, 1, "같은 테넌트의 두 번째 조회는 캐시가 먹는다");
});

await t("A3 TTL 이 지나면 다시 읽는다", async () => {
  let now = 1_000;
  let hits = 0;
  const c = tenantTtlCache<number>(100, () => -1, () => now);
  const load = async (): Promise<number> => { hits++; return 7; };
  await withTenant(T("t1"), () => c.get(load));
  now += 50;  await withTenant(T("t1"), () => c.get(load));
  assert.equal(hits, 1);
  now += 100; await withTenant(T("t1"), () => c.get(load));
  assert.equal(hits, 2);
});

await t("★ A4 load 가 실패하면 **이 테넌트의** 마지막 값으로 버틴다 — 남의 값을 주지 않는다", async () => {
  let now = 1_000;
  const c = tenantTtlCache<number>(100, () => -1, () => now);
  await withTenant(T("t1"), () => c.get(async () => 11));
  await withTenant(T("t2"), () => c.get(async () => 22));
  now += 200;
  const a = await withTenant(T("t1"), () => c.get(async () => { throw new Error("db down"); }));
  assert.equal(a, 11, "t2 의 22 가 새어 나오면 안 된다");
});

await t("A5 한 번도 못 읽었고 load 도 실패하면 fallback — 조회 실패가 호출자를 막지 않는다", async () => {
  const c = tenantTtlCache<number>(100, () => -1);
  const a = await withTenant(T("t9"), () => c.get(async () => { throw new Error("db down"); }));
  assert.equal(a, -1);
});

await t("★ A6 invalidate 는 **그 테넌트만** 지운다 — 남의 캐시를 날리면 그쪽이 DB 를 때린다", async () => {
  let hits = 0;
  const c = tenantTtlCache<number>(30_000, () => -1);
  const load = async (): Promise<number> => { hits++; return 5; };
  await withTenant(T("t1"), () => c.get(load));
  await withTenant(T("t2"), () => c.get(load));
  assert.equal(hits, 2);
  withTenant(T("t1"), () => c.invalidate());
  await withTenant(T("t2"), () => c.get(load));
  assert.equal(hits, 2, "t2 는 그대로 캐시가 산다");
  await withTenant(T("t1"), () => c.get(load));
  assert.equal(hits, 3, "t1 만 다시 읽는다");
});

await t("A7 단일 테넌트 배포(컨텍스트 없음)에서도 종전처럼 동작한다 — 셀프호스트 무회귀", async () => {
  let hits = 0;
  const c = tenantTtlCache<number>(30_000, () => -1);
  const load = async (): Promise<number> => { hits++; return 3; };
  assert.equal(await c.get(load), 3);
  assert.equal(await c.get(load), 3);
  assert.equal(hits, 1);
});

await t("★ A8 가짜 시계를 넘겨도 캐시가 산다 — 호출마다 새 캐시를 만들면 캐시를 없앤 것이다", async () => {
  // 실측으로 밟았다: 처음엔 ttlMs·now 가 기본과 다르면 그 호출만 별도 캐시로 돌렸는데,
  //  delegate-policy 테스트가 «TTL 이내인데 DB 를 또 쳤다» 로 정확히 그걸 잡았다(5초 tick 마다 DB).
  let now = 1_000, hits = 0;
  const c = tenantTtlCache<number>(30_000, () => -1);
  const load = async (): Promise<number> => { hits++; return 9; };
  await withTenant(T("t1"), () => c.get(load, 30_000, () => now));
  now += 29_000;
  await withTenant(T("t1"), () => c.get(load, 30_000, () => now));
  assert.equal(hits, 1, "TTL 이내면 캐시가 먹는다");
  now += 2_000;
  await withTenant(T("t1"), () => c.get(load, 30_000, () => now));
  assert.equal(hits, 2, "TTL 이 지나면 다시 읽는다");
});

console.log(`\n${pass} passed`);
