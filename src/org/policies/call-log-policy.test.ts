// 감사로그 보관기간 정책 + 삭제 테스트 (#1082). 사양·엣지 표 = spec 표 D/E.
//
//  회귀 대상 ①: **보관기간이 없어 호출 기록이 무기한 쌓이던 것.** 누가 언제 무슨 툴을 썼는지가 사람 단위로 남는 표다.
//  회귀 대상 ②: **0(영구 보관)은 유효한 선택지다.** 0 을 '미설정'으로 오인해 기본값 90 으로 덮으면 관리자가 명시한
//   영구 보관이 조용히 사라진다(D2).
//  회귀 대상 ③: **0 일 때 삭제를 시도하면 안 된다**(E2) — 기간 0 의 경계가 곧 "전부 오래됨"이라 전량 삭제가 된다.
//   그래서 '반환값 0' 이 아니라 **쿼리 호출 0건**(부작용)으로 단언한다.
//  회귀 대상 ④: 관리탭 값이 설치 시 값을 이긴다(D8) — 고객 박스는 .env 를 못 고친다.
import assert from "node:assert/strict";
import {
  DEFAULT_CALL_LOG_POLICY, normalizeCallLogPolicy, resolveCallLogPolicy, callLogPolicySource,
} from "./call-log-policy.js";
import { pruneCallLog, type QueryablePool } from "./call-log-prune.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): void => {
  const r = fn();
  if (r instanceof Promise) throw new Error("동기 테스트만 — 비동기는 아래 별도 블록");
  pass++;
  console.log(`ok  ${name}`);
};
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 호출을 기록하는 가짜 풀 — "무엇이 실제로 실행됐나"를 부작용으로 관측한다.
function spyPool(): QueryablePool & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[]) { calls.push({ sql, params }); return { rowCount: 3 }; },
  };
}

// ── D. 보관기간 해석 ──
t("D1 미설정이면 기본 90일", () => {
  assert.equal(resolveCallLogPolicy(null).retention_days, 90);
  assert.equal(resolveCallLogPolicy({}).retention_days, 90);
  assert.equal(DEFAULT_CALL_LOG_POLICY.retention_days, 90);
});

t("D2 0 은 유효값(영구 보관) — 기본값으로 덮이면 안 된다", () => {
  assert.equal(normalizeCallLogPolicy({ retention_days: 0 }).retention_days, 0);
});

t("D3 음수는 0으로 접힌다", () => {
  assert.equal(normalizeCallLogPolicy({ retention_days: -5 }).retention_days, 0);
});

t("D4 상한(3650)을 넘으면 상한으로 접힌다 — 경계값은 그대로", () => {
  assert.equal(normalizeCallLogPolicy({ retention_days: 99_999 }).retention_days, 3650);
  assert.equal(normalizeCallLogPolicy({ retention_days: 3650 }).retention_days, 3650);
});

t("D5 소수는 정수로", () => {
  assert.equal(normalizeCallLogPolicy({ retention_days: 30.7 }).retention_days, 31);
});

t("D6 잡값은 기본값으로", () => {
  assert.equal(normalizeCallLogPolicy({ retention_days: "구십" }).retention_days, 90);
  assert.equal(normalizeCallLogPolicy({ retention_days: null }).retention_days, 90);
  assert.equal(normalizeCallLogPolicy("문자열").retention_days, 90);
});

t("D7 설치 시 값(.env)이 있으면 그 값", () => {
  process.env.MCP_CALL_LOG_RETENTION_DAYS = "30";
  try {
    assert.equal(resolveCallLogPolicy(null).retention_days, 30);
    assert.equal(callLogPolicySource(null), "env");
  } finally { delete process.env.MCP_CALL_LOG_RETENTION_DAYS; }
});

t("D8 관리탭 값이 설치 시 값을 이긴다", () => {
  process.env.MCP_CALL_LOG_RETENTION_DAYS = "30";
  try {
    assert.equal(resolveCallLogPolicy({ retention_days: 7 }).retention_days, 7);
    assert.equal(callLogPolicySource({ retention_days: 7 }), "db");
  } finally { delete process.env.MCP_CALL_LOG_RETENTION_DAYS; }
});

t("D9 출처 — 아무것도 없으면 기본값", () => {
  assert.equal(callLogPolicySource(null), "default");
  assert.equal(callLogPolicySource({}), "default");
});

// ── E. 삭제 실행 ──
await ta("E1 기간이 있으면 그 경계로 삭제한다", async () => {
  const pool = spyPool();
  const n = await pruneCallLog(90, pool);
  assert.equal(pool.calls.length, 1);
  assert.equal(n, 3);
  assert.equal(pool.calls[0].params[0], "90"); // 경계가 정책값 그대로 전달됐나
  assert.ok(pool.calls[0].sql.includes("DELETE"));
});

await ta("E2 0(영구 보관)이면 삭제를 시도조차 하지 않는다", async () => {
  const pool = spyPool();
  const n = await pruneCallLog(0, pool);
  assert.equal(pool.calls.length, 0, "0인데 삭제 쿼리가 실행됐다 — 전량 삭제 위험");
  assert.equal(n, 0);
});

await ta("E3 음수·잡값도 삭제를 시도하지 않는다", async () => {
  for (const bad of [-1, NaN, Infinity]) {
    const pool = spyPool();
    await pruneCallLog(bad, pool);
    assert.equal(pool.calls.length, 0, `${bad} 인데 삭제 쿼리가 실행됐다`);
  }
});

await ta("E4 한 번에 지우는 양에 상한이 걸린다", async () => {
  const pool = spyPool();
  await pruneCallLog(90, pool);
  const limit = Number(pool.calls[0].params[1]);
  assert.ok(Number.isFinite(limit) && limit > 0 && limit <= 100_000, `상한이 없거나 과도하다: ${limit}`);
});

console.log(`\n${pass} passed`);
