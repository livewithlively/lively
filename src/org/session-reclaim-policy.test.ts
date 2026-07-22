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

console.log("session-reclaim-policy: all passed");
