// per-session cgroup 메모리 격리 정책 테스트 (#1059 D).
//  회귀 대상 ①: 관리탭(DB) 값이 env 시드/기본값을 **이긴다**(고객 박스는 SSH 가 없어 env 를 못 고친다 — storage_policy 와 같은 교리).
//  회귀 대상 ②: 기본값 0/0 = **무제한(무회귀)** — 캡을 안 건 박스는 종전 동작(cap-gated).
//  회귀 대상 ③: 'high ≤ max' 불변식 — high>max 는 하드 kill 전에 소프트 스로틀이 안 걸려 무의미 → high 를 max 로 내린다.
//  회귀 대상 ④: 캐시는 DB 가 죽어도 정책을 낸다(세션 생성이 정책 조회로 막히면 안 된다 — 절대 throw 안 함).
import assert from "node:assert/strict";
import {
  DEFAULT_SESSION_MEMORY_POLICY, normalizeSessionMemoryPolicy, resolveSessionMemoryPolicy,
  sessionMemoryPolicySource, effectiveSessionMemoryPolicy, invalidateSessionMemoryPolicyCache,
} from "./session-memory-policy.js";

// env 시드가 이 테스트에 새지 않게 정리(다른 테스트/셸에서 세팅됐을 수 있음).
delete process.env.LIVELY_SESSION_MEM_HIGH_MB;
delete process.env.LIVELY_SESSION_MEM_MAX_MB;

// ── 정책 해석: 기본값 = 0/0(무제한, 무회귀) ──
{
  assert.deepEqual(resolveSessionMemoryPolicy(null), DEFAULT_SESSION_MEMORY_POLICY);
  assert.deepEqual(resolveSessionMemoryPolicy({}), DEFAULT_SESSION_MEMORY_POLICY);
  assert.equal(DEFAULT_SESSION_MEMORY_POLICY.per_session_high_mb, 0);
  assert.equal(DEFAULT_SESSION_MEMORY_POLICY.per_session_max_mb, 0);
  assert.equal(sessionMemoryPolicySource(null), "default");
  assert.equal(sessionMemoryPolicySource({}), "default");
}

// ── 관리탭(DB) 저장값이 이긴다 ──
{
  const db = resolveSessionMemoryPolicy({ per_session_high_mb: 3072, per_session_max_mb: 4096 });
  assert.equal(db.per_session_high_mb, 3072, "관리탭 값이 기본값을 이겨야 한다");
  assert.equal(db.per_session_max_mb, 4096);
  // 안 건드린 항목은 기본값(0) 유지 — max 만 설정, high 는 무제한.
  const partial = resolveSessionMemoryPolicy({ per_session_max_mb: 2048 });
  assert.equal(partial.per_session_max_mb, 2048);
  assert.equal(partial.per_session_high_mb, 0, "안 건드린 high 는 기본 0(무제한)");
  assert.equal(sessionMemoryPolicySource({ per_session_max_mb: 2048 }), "db");
}

// ── 잡값 방어 — 범위 밖/비정상은 클램프/시드로 ──
{
  assert.equal(normalizeSessionMemoryPolicy({ per_session_max_mb: "이상한값" }).per_session_max_mb, 0, "비수치 → 기본 0");
  assert.equal(normalizeSessionMemoryPolicy({ per_session_max_mb: -100 }).per_session_max_mb, 0, "음수 → 0 클램프");
  assert.equal(normalizeSessionMemoryPolicy({ per_session_max_mb: 9_999_999 }).per_session_max_mb, 1_048_576, "상한(1TB) 클램프");
}

// ── 'high ≤ max' 불변식 — 뒤집힌 입력이면 high 를 max 로 내린다 ──
{
  const flipped = normalizeSessionMemoryPolicy({ per_session_high_mb: 8000, per_session_max_mb: 4096 });
  assert.equal(flipped.per_session_max_mb, 4096);
  assert.equal(flipped.per_session_high_mb, 4096, "high>max 면 high 를 max 로 끌어내린다");
  // max=0(무제한)이면 high 는 그대로(내릴 대상 없음 — high 만 소프트 캡).
  const highOnly = normalizeSessionMemoryPolicy({ per_session_high_mb: 5000, per_session_max_mb: 0 });
  assert.equal(highOnly.per_session_high_mb, 5000, "max 무제한이면 high 는 그대로");
}

// ── env 시드: DB 없을 때만 쓰이고, DB 가 있으면 진다 ──
{
  process.env.LIVELY_SESSION_MEM_MAX_MB = "2000";
  assert.equal(normalizeSessionMemoryPolicy(null).per_session_max_mb, 2000, "DB 비면 env 시드가 기본값을 대체");
  assert.equal(sessionMemoryPolicySource(null), "env", "DB 비고 env 있으면 출처=env");
  // DB 값이 있으면 env 를 이긴다.
  assert.equal(normalizeSessionMemoryPolicy({ per_session_max_mb: 4096 }).per_session_max_mb, 4096, "DB > env");
  assert.equal(sessionMemoryPolicySource({ per_session_max_mb: 4096 }), "db");
  delete process.env.LIVELY_SESSION_MEM_MAX_MB;
}

// ── 캐시: DB 가 죽어도 정책을 낸다(세션 생성이 막히면 안 됨 — throw 금지) ──
{
  invalidateSessionMemoryPolicyCache();
  const good = await effectiveSessionMemoryPolicy(async () => resolveSessionMemoryPolicy({ per_session_max_mb: 4096 }));
  assert.equal(good.per_session_max_mb, 4096);
  // 캐시 유효 구간 — DB 가 터져도 마지막 값을 낸다.
  const cached = await effectiveSessionMemoryPolicy(async () => { throw new Error("DB down"); });
  assert.equal(cached.per_session_max_mb, 4096, "DB 다운이어도 마지막 정책으로 계속 답해야 한다");
  // 캐시 비우고 DB 도 죽으면 → 기본값(그래도 throw 하지 않는다).
  invalidateSessionMemoryPolicyCache();
  const fallback = await effectiveSessionMemoryPolicy(async () => { throw new Error("DB down"); });
  assert.deepEqual(fallback, DEFAULT_SESSION_MEMORY_POLICY, "캐시도 DB 도 없으면 기본값 — 절대 throw 안 함");
  invalidateSessionMemoryPolicyCache();
}

console.log("session-memory-policy: all passed");
