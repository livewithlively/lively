// 위탁 태스크 정책(#1101) — 값 해석·우선순위·캐시 엣지 전수.
//  정책: DB(관리탭) > env 시드 > 코드 기본값(5분). 0=끔. **켰다면 최소 1분**(너무 짧으면 멀쩡한 작업을 죽인다).
//  이 해석이 틀리면 관리탭에서 고른 값이 안 먹거나(운영자가 못 고침), 30초 같은 값이 통과해 정상 작업이 사살된다.
import { strict as assert } from "node:assert";
import {
  normalizeDelegatePolicy, resolveDelegatePolicy, delegatePolicySource,
  effectiveDelegatePolicy, invalidateDelegatePolicyCache,
  DEFAULT_DELEGATE_POLICY, STALL_MS_FLOOR, STALL_MS_MAX,
} from "./delegate-policy.js";

const ENV = "LIVELY_TASK_STALL_MS";
const withEnv = <T>(v: string | undefined, fn: () => T): T => {
  const old = process.env[ENV];
  if (v === undefined) delete process.env[ENV]; else process.env[ENV] = v;
  try { return fn(); } finally { if (old === undefined) delete process.env[ENV]; else process.env[ENV] = old; }
};
const stall = (raw: unknown): number => normalizeDelegatePolicy(raw).stall_ms;

// ── 미설정 → 코드 기본값(5분) ──
withEnv(undefined, () => {
  assert.equal(stall(null), DEFAULT_DELEGATE_POLICY.stall_ms, "DB 가 NULL 인데 기본값이 아니다");
  assert.equal(stall({}), DEFAULT_DELEGATE_POLICY.stall_ms, "DB 가 빈 객체인데 기본값이 아니다");
  assert.equal(stall(undefined), DEFAULT_DELEGATE_POLICY.stall_ms, "미설정인데 기본값이 아니다");
  assert.equal(resolveDelegatePolicy(null).stall_ms, DEFAULT_DELEGATE_POLICY.stall_ms, "resolve 가 normalize 와 다르다");

  // ── 끔: 0 과 음수 ──
  assert.equal(stall({ stall_ms: 0 }), 0, "0(명시적 끔)이 보존되지 않았다");
  assert.equal(stall({ stall_ms: -1 }), 0, "음수가 끔으로 수렴하지 않았다");

  // ── 켰다면 최소 1분(FLOOR) — 너무 짧은 값이 통과하면 멀쩡한 작업을 죽인다 ──
  assert.equal(stall({ stall_ms: 1 }), STALL_MS_FLOOR, "1ms 가 하한으로 올라가지 않았다 — 정상 작업이 즉시 사살된다");
  assert.equal(stall({ stall_ms: 59_999 }), STALL_MS_FLOOR, "하한 바로 아래가 올라가지 않았다");
  assert.equal(stall({ stall_ms: STALL_MS_FLOOR }), STALL_MS_FLOOR, "하한 정확값이 바뀌었다");

  // ── 정상 범위와 상한 ──
  assert.equal(stall({ stall_ms: 300_000 }), 300_000, "정상값이 바뀌었다");
  assert.equal(stall({ stall_ms: STALL_MS_MAX }), STALL_MS_MAX, "상한 정확값이 바뀌었다");
  assert.equal(stall({ stall_ms: STALL_MS_MAX + 1 }), STALL_MS_MAX, "상한 초과가 clamp 되지 않았다");

  // ── 잡값 → 기본값 ──
  assert.equal(stall({ stall_ms: "abc" }), DEFAULT_DELEGATE_POLICY.stall_ms, "문자 잡값이 기본값으로 접히지 않았다");
  assert.equal(stall("nope"), DEFAULT_DELEGATE_POLICY.stall_ms, "객체가 아닌 DB 값이 기본값으로 접히지 않았다");

  // ── 출처 판정 ──
  assert.equal(delegatePolicySource(null), "default", "미설정인데 default 가 아니다");
  assert.equal(delegatePolicySource({ stall_ms: 60_000 }), "db", "DB 값이 있는데 db 가 아니다");
});

// ── env 시드: DB 가 비었을 때만 쓰인다 ──
withEnv("600000", () => {
  assert.equal(stall({}), 600_000, "DB 가 비었는데 env 시드를 안 썼다");
  assert.equal(stall(null), 600_000, "DB 가 NULL 인데 env 시드를 안 썼다");
  // 핵심: **DB 가 env 를 이긴다** — 안 그러면 관리탭에서 고른 값이 .env 에 먹혀 운영자가 못 고친다.
  assert.equal(stall({ stall_ms: 180_000 }), 180_000, "DB 값이 env 시드에 졌다 — 관리탭이 창구가 되지 못한다");
  assert.equal(stall({ stall_ms: 0 }), 0, "DB 의 명시적 끔(0)이 env 시드에 졌다");
  assert.equal(delegatePolicySource(null), "env", "env 시드가 있는데 출처가 env 가 아니다");
  assert.equal(delegatePolicySource({ stall_ms: 60_000 }), "db", "DB 값이 있으면 env 가 있어도 db 여야 한다");
});
// env 도 하한을 받는다(.env 오설정으로 정상 작업을 죽이지 않게).
withEnv("1000", () => {
  assert.equal(stall({}), STALL_MS_FLOOR, "env 의 너무 짧은 값이 하한으로 올라가지 않았다");
});

// ── 캐시: 5초 tick 루프가 매번 DB 를 치지 않게 ──
{
  invalidateDelegatePolicyCache();
  let calls = 0;
  const load = async () => { calls++; return normalizeDelegatePolicy({ stall_ms: 120_000 }); };
  let clock = 1_000_000;
  const now = () => clock;

  const a = await effectiveDelegatePolicy(load, 30_000, now);
  assert.equal(a.stall_ms, 120_000);
  assert.equal(calls, 1, "첫 호출이 load 를 안 불렀다");

  clock += 29_000;                                        // TTL 이내
  await effectiveDelegatePolicy(load, 30_000, now);
  assert.equal(calls, 1, "TTL 이내인데 DB 를 또 쳤다 — 5초 tick 마다 조회하게 된다");

  clock += 2_000;                                         // TTL 경과
  await effectiveDelegatePolicy(load, 30_000, now);
  assert.equal(calls, 2, "TTL 이 지났는데 갱신하지 않았다");

  // 저장 즉시 반영 — 관리탭에서 바꾼 값이 다음 tick 에 보여야 한다.
  invalidateDelegatePolicyCache();
  await effectiveDelegatePolicy(load, 30_000, now);
  assert.equal(calls, 3, "무효화 후에도 옛 캐시를 썼다 — 관리탭 저장이 즉시 반영되지 않는다");
}

// ── 조회 실패 fail-safe: 절대 throw 하지 않는다(정책 조회로 stall 판정이 막히면 안 된다) ──
{
  invalidateDelegatePolicyCache();
  const boom = async (): Promise<never> => { throw new Error("DB down"); };
  const noCache = await effectiveDelegatePolicy(boom, 30_000, () => 1);
  assert.equal(noCache.stall_ms, DEFAULT_DELEGATE_POLICY.stall_ms, "캐시도 없고 DB 도 죽었을 때 기본값으로 안 떨어졌다");

  let clock = 2_000_000;
  await effectiveDelegatePolicy(async () => normalizeDelegatePolicy({ stall_ms: 900_000 }), 30_000, () => clock);
  clock += 60_000;                                        // TTL 경과 후 DB 실패
  const kept = await effectiveDelegatePolicy(boom, 30_000, () => clock);
  assert.equal(kept.stall_ms, 900_000, "DB 실패 시 마지막 성공값을 안 지켰다");
  invalidateDelegatePolicyCache();
}

// ── #1675 ①③ 실패 뒤처리 노브 — 보존 상한·TTL·자격 실패 시 크론 정지 ──
//  이 축이 틀리면 어니스트 2026-08-12 가 재현된다(실패 세션 무제한 누적 → 스왑 고갈 → 박스 다운).
{
  const d = normalizeDelegatePolicy(null);
  assert.equal(d.keep_failed_sessions, 5, "검시용 보존 기본이 5건이 아니다");
  assert.equal(d.failed_session_ttl_min, 120, "보존 TTL 기본이 2시간이 아니다");
  assert.equal(d.auth_fail_stop_cron, true, "자격 실패 시 크론 자동 정지가 기본으로 꺼져 있다 — 24시간 방치가 재현된다");

  // 0 은 **의미 있는 선택**이다(즉시 전량 회수 / TTL 무제한) — 잡값의 착지점이 아니어야 한다.
  assert.equal(normalizeDelegatePolicy({ keep_failed_sessions: 0 }).keep_failed_sessions, 0, "0(즉시 정리)을 못 고른다");
  assert.equal(normalizeDelegatePolicy({ failed_session_ttl_min: 0 }).failed_session_ttl_min, 0, "0(무제한)을 못 고른다");
  // ★ 그래서 null/빈문자열은 0 이 아니라 **기본값**으로 가야 한다(loose 를 안 쓴 이유).
  //   여기가 뒤집히면 DB 에 null 이 한 번 들어간 순간 그 박스는 조용히 '보존 0건'이 된다.
  for (const junk of [null, "", false, [], "잡값"]) {
    assert.equal(normalizeDelegatePolicy({ keep_failed_sessions: junk }).keep_failed_sessions, 5,
      `잡값(${JSON.stringify(junk)})이 0 으로 해석됐다 — 검시 대상이 조용히 사라진다`);
  }

  // 범위 클램프.
  assert.equal(normalizeDelegatePolicy({ keep_failed_sessions: 99_999 }).keep_failed_sessions, 200, "보존 상한 클램프");
  assert.equal(normalizeDelegatePolicy({ keep_failed_sessions: -3 }).keep_failed_sessions, 0, "음수는 0(즉시 정리)");
  assert.equal(normalizeDelegatePolicy({ failed_session_ttl_min: 99_999 }).failed_session_ttl_min, 10_080, "TTL 상한(7일) 클램프");

  // 토글은 명시적으로 끌 수 있어야 한다(오탐이 걱정되는 운영).
  assert.equal(normalizeDelegatePolicy({ auth_fail_stop_cron: false }).auth_fail_stop_cron, false, "자동 정지를 끌 수 없다");

  // 부분 저장이 다른 축을 건드리면 안 된다 — 관리탭은 버튼마다 일부 필드만 보낸다.
  const partial = normalizeDelegatePolicy({ stall_ms: 600_000 });
  assert.equal(partial.keep_failed_sessions, 5, "stall 만 저장했는데 보존 상한이 바뀌었다");
  assert.equal(partial.auth_fail_stop_cron, true, "stall 만 저장했는데 자동 정지가 꺼졌다");
}

console.log("delegate-policy.test: ok (해석·우선순위·캐시 엣지 + #1675 실패 뒤처리)");
