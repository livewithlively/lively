// idle 세션 자동 회수 정책 테스트 (#1059 F).
//  회귀 대상 ①: 기본값 0 = **회수 끔(무회귀)** — 켜기 전엔 아무 세션도 자동으로 안 죽는다.
//  회귀 대상 ②: 관리탭(DB) 값이 env 시드/기본값을 **이긴다**(고객 박스는 SSH 가 없어 env 를 못 고친다).
//  회귀 대상 ③: 잡값·범위밖 클램프·정수화.
//  회귀 대상 ④: 캐시는 DB 가 죽어도 정책을 낸다(회수 판정이 정책 조회로 막히면 안 된다 — 절대 throw 안 함).
import assert from "node:assert/strict";
import {
  DEFAULT_SESSION_RECLAIM_POLICY, normalizeSessionReclaimPolicy, resolveSessionReclaimPolicy,
  sessionReclaimPolicySource, effectiveSessionReclaimPolicy, invalidateSessionReclaimPolicyCache,
  RECLAIM_TTL_MIN_MAX,
} from "./session-reclaim-policy.js";

// env 시드가 이 테스트에 새지 않게 정리(다른 테스트/셸에서 세팅됐을 수 있음).
delete process.env.LIVELY_SESSION_IDLE_TTL_MIN;

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

// ── #1220 압박 회수 축 — 기본은 '끔'이어야 하고(무회귀), 임계는 0~99 로 갇혀야 한다 ──
//  왜 상한이 99 인가: 100 은 '사용률이 100% 이상일 때만' 이라 사실상 절대 발동 안 함 = 0(끔)과 뜻이 겹친다.
//  운영자가 100 을 '가장 보수적으로 켜기'로 오해하고 넣으면 **켰다고 믿는데 안 켜진** 최악의 상태가 된다.
{
  assert.equal(DEFAULT_SESSION_RECLAIM_POLICY.pressure_used_pct, 0, "압박 회수 기본은 끔(무회귀)");
  assert.equal(DEFAULT_SESSION_RECLAIM_POLICY.pressure_idle_minutes, 60, "켰을 때의 완화 기준 기본은 60분");
  assert.equal(normalizeSessionReclaimPolicy({ pressure_used_pct: 100 }).pressure_used_pct, 99, "100 은 99 로 클램프(절대 발동 안 하는 값 금지)");
  assert.equal(normalizeSessionReclaimPolicy({ pressure_used_pct: -5 }).pressure_used_pct, 0, "음수는 0(끔)");
  assert.equal(normalizeSessionReclaimPolicy({ pressure_used_pct: "잡값" }).pressure_used_pct, 0, "잡값은 기본값으로");
  assert.equal(normalizeSessionReclaimPolicy({}).pressure_used_pct, 0, "필드가 아예 없는 구 설정 = 끔(종전 동작)");
  // 두 축은 독립이다 — 압박만 켜고 평시는 꺼 두는 운영이 성립해야 한다.
  const only = normalizeSessionReclaimPolicy({ pressure_used_pct: 90 });
  assert.equal(only.idle_ttl_minutes, 0, "압박만 켜도 평시는 꺼진 채 유지");
  assert.equal(only.pressure_used_pct, 90);
}

console.log("session-reclaim-policy: all passed");
