// 수집 실행 세션 크기 정책(#4213 T11) — 사양 S1 의 P 행(스크래치 사양 spec-t11-metrics.md · 지식 connect-collect-tobe-claude-connector-4213).
//  회귀 대상: 기본 1,024/640 · DB > env > 기본 · 경계(256·128·8192) · 예약 ≤ 상한 · 조회 실패에도 던지지 않는다.
import assert from "node:assert/strict";
import {
  DEFAULT_COLLECT_SESSION_POLICY, normalizeCollectSessionPolicy, resolveCollectSessionPolicy, collectSessionPolicySource,
  effectiveCollectSessionPolicy, invalidateCollectSessionPolicyCache,
} from "./session-memory-policy.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const clearEnv = (): void => { delete process.env.LIVELY_COLLECT_MEM_MB; delete process.env.LIVELY_COLLECT_MEM_REQUEST_MB; };
clearEnv();

await t("P1 기본 — 1024/640 · 출처 default", () => {
  assert.deepEqual(resolveCollectSessionPolicy({}), { max_mb: 1024, request_mb: 640 });
  assert.deepEqual(resolveCollectSessionPolicy(null), { max_mb: 1024, request_mb: 640 });
  assert.deepEqual(DEFAULT_COLLECT_SESSION_POLICY, { max_mb: 1024, request_mb: 640 });
  assert.equal(collectSessionPolicySource({}), "default");
});
await t("P2 env 시드 — DB 가 비면 env", () => {
  process.env.LIVELY_COLLECT_MEM_MB = "2048"; process.env.LIVELY_COLLECT_MEM_REQUEST_MB = "900";
  try {
    assert.deepEqual(resolveCollectSessionPolicy({}), { max_mb: 2048, request_mb: 900 });
    assert.equal(collectSessionPolicySource({}), "env");
  } finally { clearEnv(); }
});
await t("P3 DB 칸이 이기고, DB 에 없는 칸은 env", () => {
  process.env.LIVELY_COLLECT_MEM_MB = "2048"; process.env.LIVELY_COLLECT_MEM_REQUEST_MB = "900";
  try {
    assert.deepEqual(resolveCollectSessionPolicy({ max_mb: 1536 }), { max_mb: 1536, request_mb: 900 });
    assert.equal(collectSessionPolicySource({ max_mb: 1536 }), "db");
  } finally { clearEnv(); }
});
await t("P4 예약은 상한을 넘지 않는다 — 상한으로 내린다", () => {
  assert.deepEqual(normalizeCollectSessionPolicy({ max_mb: 512, request_mb: 640 }), { max_mb: 512, request_mb: 512 });
  //  상한만 기본 예약(640) 밑으로 내려도 같다
  assert.deepEqual(normalizeCollectSessionPolicy({ max_mb: 384 }), { max_mb: 384, request_mb: 384 });
});
await t("P5 경계 하한 — 256/128 그대로", () => {
  assert.deepEqual(normalizeCollectSessionPolicy({ max_mb: 256, request_mb: 128 }), { max_mb: 256, request_mb: 128 });
});
await t("P6 경계 밖 하한 — 255/127 은 256/128 로 접는다", () => {
  assert.deepEqual(normalizeCollectSessionPolicy({ max_mb: 255, request_mb: 127 }), { max_mb: 256, request_mb: 128 });
});
await t("P7 잡값 — 숫자 아닌 값·null 은 기본으로", () => {
  assert.deepEqual(normalizeCollectSessionPolicy({ max_mb: "abc", request_mb: null }), { max_mb: 1024, request_mb: 640 });
  assert.deepEqual(normalizeCollectSessionPolicy("junk"), { max_mb: 1024, request_mb: 640 });
});
await t("P8 경계 상한 — 8192 그대로 · 8193 은 8192", () => {
  assert.deepEqual(normalizeCollectSessionPolicy({ max_mb: 8192, request_mb: 8192 }), { max_mb: 8192, request_mb: 8192 });
  assert.deepEqual(normalizeCollectSessionPolicy({ max_mb: 8193, request_mb: 8193 }), { max_mb: 8192, request_mb: 8192 });
});
await t("P12 조회가 실패해도 던지지 않는다 — 처음이면 기본값, 읽은 적 있으면 마지막 값", async () => {
  invalidateCollectSessionPolicyCache();
  let calls = 0;
  const boom = async () => { calls++; throw new Error("db down"); };
  assert.deepEqual(await effectiveCollectSessionPolicy(boom), { max_mb: 1024, request_mb: 640 });
  assert.equal(calls, 1, "조회를 실제로 시도했다(배선)");
  let clock = 1_000_000;
  const now = () => clock;
  assert.deepEqual(await effectiveCollectSessionPolicy(async () => ({ max_mb: 1536, request_mb: 700 }), 30_000, now), { max_mb: 1536, request_mb: 700 });
  clock += 31_000;   // 만료 — 다시 읽는데 실패하면 마지막 값
  assert.deepEqual(await effectiveCollectSessionPolicy(boom, 30_000, now), { max_mb: 1536, request_mb: 700 });
  //  저장 직후 무효화 — TTL 안이라도 다음 조회가 새 값을 읽는다(무효화가 없으면 캐시 값이 나온다)
  assert.deepEqual(await effectiveCollectSessionPolicy(async () => ({ max_mb: 1792, request_mb: 640 }), 30_000, now), { max_mb: 1792, request_mb: 640 });
  clock += 1_000;
  assert.deepEqual(await effectiveCollectSessionPolicy(async () => ({ max_mb: 2048, request_mb: 800 }), 30_000, now), { max_mb: 1792, request_mb: 640 }, "TTL 안이면 캐시");
  invalidateCollectSessionPolicyCache();
  assert.deepEqual(await effectiveCollectSessionPolicy(async () => ({ max_mb: 2048, request_mb: 800 }), 30_000, now), { max_mb: 2048, request_mb: 800 });
});

console.log(`collect-session-policy: ${pass} passed`);
