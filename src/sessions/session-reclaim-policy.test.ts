// idle 세션 자동 회수 정책 테스트 (#1059 F).
//  회귀 대상 ①: 기본값 0 = **회수 끔(무회귀)** — 켜기 전엔 아무 세션도 자동으로 안 죽는다.
//  회귀 대상 ②: 관리탭(DB) 값이 env 시드/기본값을 **이긴다**(고객 박스는 SSH 가 없어 env 를 못 고친다).
//  회귀 대상 ③: 잡값·범위밖 클램프·정수화.
//  회귀 대상 ④: 캐시는 DB 가 죽어도 정책을 낸다(회수 판정이 정책 조회로 막히면 안 된다 — 절대 throw 안 함).
import assert from "node:assert/strict";
import {
  DEFAULT_SESSION_RECLAIM_POLICY, normalizeSessionReclaimPolicy, resolveSessionReclaimPolicy,
  sessionReclaimPolicySource, effectiveSessionReclaimPolicy, invalidateSessionReclaimPolicyCache,
  RECLAIM_TTL_MIN_MAX, RECLAIM_PRESSURE_PCT_MAX,
} from "./session-reclaim-policy.js";

// env 시드가 이 테스트에 새지 않게 정리(다른 테스트/셸에서 세팅됐을 수 있음).
//  ⚠ **새 노브를 추가하면 여기에도 추가한다** — 안 하면 그 env 가 세팅된 박스·CI 에서만 실패하는 flake 가 된다.
delete process.env.LIVELY_SESSION_IDLE_TTL_MIN;
delete process.env.LIVELY_SESSION_PRESSURE_PCT;
delete process.env.LIVELY_SESSION_PRESSURE_IDLE_MIN;
delete process.env.LIVELY_SESSION_PRESSURE_SWAP_PCT;

// ── 정책 해석: 기본값 = 0(회수 끔, 무회귀) ──
{
  assert.deepEqual(resolveSessionReclaimPolicy(null), DEFAULT_SESSION_RECLAIM_POLICY);
  assert.deepEqual(resolveSessionReclaimPolicy({}), DEFAULT_SESSION_RECLAIM_POLICY);
  assert.equal(DEFAULT_SESSION_RECLAIM_POLICY.idle_ttl_minutes, 0, "기본은 회수 끔");
  assert.equal(sessionReclaimPolicySource(null), "default");
  assert.equal(sessionReclaimPolicySource({}), "default");
}

// ── 관리탭(DB) 저장값이 이긴다 ──
{
  const db = resolveSessionReclaimPolicy({ idle_ttl_minutes: 180 });
  assert.equal(db.idle_ttl_minutes, 180, "관리탭 값이 기본값을 이겨야 한다");
  assert.equal(sessionReclaimPolicySource({ idle_ttl_minutes: 180 }), "db");
}

// ── 잡값 방어 — 범위 밖/비정상은 클램프/기본으로 ──
{
  assert.equal(normalizeSessionReclaimPolicy({ idle_ttl_minutes: "이상한값" }).idle_ttl_minutes, 0, "비수치 → 기본 0");
  assert.equal(normalizeSessionReclaimPolicy({ idle_ttl_minutes: -100 }).idle_ttl_minutes, 0, "음수 → 0 클램프");
  assert.equal(normalizeSessionReclaimPolicy({ idle_ttl_minutes: 999_999 }).idle_ttl_minutes, RECLAIM_TTL_MIN_MAX, "상한(30일) 클램프");
  assert.equal(normalizeSessionReclaimPolicy({ idle_ttl_minutes: 60.7 }).idle_ttl_minutes, 61, "반올림 정수화");
}

// ── env 시드: DB 없을 때만 쓰이고, DB 가 있으면 진다 ──
{
  process.env.LIVELY_SESSION_IDLE_TTL_MIN = "240";
  assert.equal(normalizeSessionReclaimPolicy(null).idle_ttl_minutes, 240, "DB 비면 env 시드가 기본값을 대체");
  assert.equal(sessionReclaimPolicySource(null), "env", "DB 비고 env 있으면 출처=env");
  assert.equal(normalizeSessionReclaimPolicy({ idle_ttl_minutes: 90 }).idle_ttl_minutes, 90, "DB > env");
  assert.equal(sessionReclaimPolicySource({ idle_ttl_minutes: 90 }), "db");
  delete process.env.LIVELY_SESSION_IDLE_TTL_MIN;
}

// ── 캐시: DB 가 죽어도 정책을 낸다(회수 판정이 막히면 안 됨 — throw 금지) ──
{
  invalidateSessionReclaimPolicyCache();
  const good = await effectiveSessionReclaimPolicy(async () => resolveSessionReclaimPolicy({ idle_ttl_minutes: 120 }));
  assert.equal(good.idle_ttl_minutes, 120);
  const cached = await effectiveSessionReclaimPolicy(async () => { throw new Error("DB down"); });
  assert.equal(cached.idle_ttl_minutes, 120, "DB 다운이어도 마지막 정책으로 계속 답해야 한다");
  invalidateSessionReclaimPolicyCache();
  const fallback = await effectiveSessionReclaimPolicy(async () => { throw new Error("DB down"); });
  assert.deepEqual(fallback, DEFAULT_SESSION_RECLAIM_POLICY, "캐시도 DB 도 없으면 기본값(0=끔) — 절대 throw 안 함");
  invalidateSessionReclaimPolicyCache();
}

// ── #1220 압박 회수 축 — 기본은 '끔'이어야 하고(무회귀), 임계는 0~RECLAIM_PRESSURE_PCT_MAX 로 갇혀야 한다 ──
//  ⚠ 상한의 근거가 #1675 ⑤ 에서 바뀌었다. 종전 이유는 "100 은 절대 발동 안 하니 금지"(0 과 뜻이 겹침)였고,
//   지금은 그보다 **훨씬 이른 선**이다: earlyoom 이 94%(-m 6)에서 먼저 죽이므로 그 이상은 전부 '켰다고 믿는데
//   안 켜진' 값이다. 어니스트 2026-08-12 가 정확히 그랬다(95 로 켜고 한 번도 발동 못 함).
//   두 파일(정책 상수 ↔ deploy/lib/common.sh)의 정합은 deploy/reclaim-before-earlyoom.test.mjs 가 지킨다.
{
  assert.equal(DEFAULT_SESSION_RECLAIM_POLICY.pressure_used_pct, 0, "압박 회수 기본은 끔(무회귀)");
  assert.equal(DEFAULT_SESSION_RECLAIM_POLICY.pressure_idle_minutes, 60, "켰을 때의 완화 기준 기본은 60분");
  assert.ok(RECLAIM_PRESSURE_PCT_MAX < 94, "압박 임계 상한이 earlyoom 발동선(94%) 이상이면 그 값은 영영 안 돈다");
  assert.equal(normalizeSessionReclaimPolicy({ pressure_used_pct: 100 }).pressure_used_pct, RECLAIM_PRESSURE_PCT_MAX,
    "100 은 상한으로 클램프(절대 발동 안 하는 값 금지)");
  // 어니스트가 실제로 쓰던 값 — update 만 받아도 '작동하는 값'으로 접혀야 한다.
  assert.equal(normalizeSessionReclaimPolicy({ pressure_used_pct: 95 }).pressure_used_pct, RECLAIM_PRESSURE_PCT_MAX,
    "95(어니스트 설정)가 그대로 남았다 — earlyoom 뒤에 서는 설정이 계속 유지된다");
  assert.equal(normalizeSessionReclaimPolicy({ pressure_used_pct: -5 }).pressure_used_pct, 0, "음수는 0(끔)");
  assert.equal(normalizeSessionReclaimPolicy({ pressure_used_pct: "잡값" }).pressure_used_pct, 0, "잡값은 기본값으로");
  assert.equal(normalizeSessionReclaimPolicy({}).pressure_used_pct, 0, "필드가 아예 없는 구 설정 = 끔(종전 동작)");
  // 두 축은 독립이다 — 압박만 켜고 평시는 꺼 두는 운영이 성립해야 한다.
  const only = normalizeSessionReclaimPolicy({ pressure_used_pct: 90 });
  assert.equal(only.idle_ttl_minutes, 0, "압박만 켜도 평시는 꺼진 채 유지");
  assert.equal(only.pressure_used_pct, 90);
}

// ── #1675 ⑤ 스왑 축 — 물리 축과 **독립**이고, earlyoom 과 경합하지 않아 99 까지 열려 있다 ──
{
  assert.equal(DEFAULT_SESSION_RECLAIM_POLICY.pressure_swap_pct, 0, "스왑 압박 회수 기본은 끔(무회귀)");
  assert.equal(normalizeSessionReclaimPolicy({}).pressure_swap_pct, 0, "구 설정(필드 부재)에서 스왑 축이 켜졌다");
  // 물리 축 상한(90)에 갇히면 안 된다 — earlyoom 은 -s 100 으로 스왑을 아예 안 본다.
  assert.equal(normalizeSessionReclaimPolicy({ pressure_swap_pct: 99 }).pressure_swap_pct, 99,
    "스왑 임계 99 가 물리 축 상한으로 잘렸다 — 두 축의 제약 근거가 다르다");
  assert.equal(normalizeSessionReclaimPolicy({ pressure_swap_pct: 100 }).pressure_swap_pct, 99, "100 은 99 로 클램프");
  assert.equal(normalizeSessionReclaimPolicy({ pressure_swap_pct: -1 }).pressure_swap_pct, 0, "음수는 0(끔)");
  // 스왑만 켜는 운영이 성립해야 한다 — 어니스트는 물리 82%였고 그 축으로는 무엇을 골라도 안 걸렸다.
  const swapOnly = normalizeSessionReclaimPolicy({ pressure_swap_pct: 90 });
  assert.equal(swapOnly.pressure_used_pct, 0, "스왑만 켰는데 물리 축이 함께 켜졌다");
  assert.equal(swapOnly.idle_ttl_minutes, 0, "스왑만 켰는데 평시 회수가 함께 켜졌다");
  assert.equal(swapOnly.pressure_swap_pct, 90);
}

console.log("session-reclaim-policy: all passed");
