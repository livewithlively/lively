import { strict as assert } from "node:assert";
import test from "node:test";
import {
  WORKER_POLICY_DEFAULT, cpuPercentBetween, decideWorkerBudget, normalizeWorkerPolicy, parsePsCpuSeconds, resolveWorkerPolicy,
  type WorkerPolicy,
} from "./worker-policy.js";

const policy = (patch: Partial<WorkerPolicy> = {}): WorkerPolicy => ({ ...WORKER_POLICY_DEFAULT, ...patch });
const usage = (activeTotal: number, activeForMember = 0, memoryMbTotal = 0) => ({ activeTotal, activeForMember, memoryMbTotal });
const OFF = { max_concurrent: 0, max_per_member: 0, max_memory_mb: 0 } as const;

// ── A. 상한의 의미 ──

test("E1 0은 무제한이다 — 상한을 끈 조직에서는 아무리 많아도 통과한다", () => {
  assert.equal(decideWorkerBudget(policy(OFF), usage(9999, 9999, 999_999), 512), null);
});

test("E2·E3 조직 동시 실행 상한은 '지금 + 1'이 넘을 때만 막는다 — 상한과 같아지는 것은 허용", () => {
  const p = policy({ ...OFF, max_concurrent: 20 });
  assert.equal(decideWorkerBudget(p, usage(19), 128), null, "19+1=20 은 상한과 같으므로 허용");
  assert.equal(decideWorkerBudget(p, usage(20), 128), "worker-budget-org-concurrency", "20+1=21 은 초과");
});

test("E4·E5 멤버당 상한도 같은 경계 규칙으로 자기 몫만 센다", () => {
  const p = policy({ ...OFF, max_per_member: 5 });
  assert.equal(decideWorkerBudget(p, usage(100, 4), 128), null, "조직 수가 무제한이면 남의 것 100개는 상관없다");
  assert.equal(decideWorkerBudget(p, usage(100, 5), 128), "worker-budget-member-concurrency");
});

test("E6·E7 메모리 합 상한은 '이미 쓰는 양 + 이번 요청'으로 판정한다", () => {
  const p = policy({ ...OFF, max_memory_mb: 4096 });
  assert.equal(decideWorkerBudget(p, usage(3, 1, 3584), 512), null, "3584+512=4096 은 상한과 같으므로 허용");
  assert.equal(decideWorkerBudget(p, usage(3, 1, 3585), 512), "worker-budget-org-memory", "4097 은 초과");
});

test("E8 여러 상한을 동시에 넘으면 조직 수를 먼저 알린다", () => {
  assert.equal(decideWorkerBudget(policy({ max_concurrent: 1, max_per_member: 1, max_memory_mb: 1 }), usage(9, 9, 9), 9),
    "worker-budget-org-concurrency");
});

test("E9 조직 수가 무제한이면 멤버 수를 메모리보다 먼저 알린다", () => {
  assert.equal(decideWorkerBudget(policy({ max_concurrent: 0, max_per_member: 1, max_memory_mb: 1 }), usage(9, 9, 9), 9),
    "worker-budget-member-concurrency");
});

test("E10 요청 메모리가 음수여도 이미 쓰는 합을 깎지 않는다", () => {
  const p = policy({ ...OFF, max_memory_mb: 100 });
  // 깎였다면 100-50=50 이 되어 여유가 생기고, 아래 두 번째 단언이 통과해 버린다.
  assert.equal(decideWorkerBudget(p, usage(1, 1, 100), -50), null, "100+0=100 은 상한과 같아 허용");
  assert.equal(decideWorkerBudget(p, usage(1, 1, 101), -50), "worker-budget-org-memory", "음수 요청이 상한을 넓히면 안 된다");
});

// ── B·C. 기본값과 정규화 ──

test("E11 정책 정규화는 음수·NaN·문자열·누락을 항목별 기본값으로 접는다", () => {
  const n = normalizeWorkerPolicy({ max_concurrent: -3, max_per_member: Number.NaN, max_memory_mb: "많이" });
  assert.equal(n.max_concurrent, WORKER_POLICY_DEFAULT.max_concurrent);
  assert.equal(n.max_per_member, WORKER_POLICY_DEFAULT.max_per_member);
  assert.equal(n.max_memory_mb, WORKER_POLICY_DEFAULT.max_memory_mb);
  assert.equal(n.cpu_percent_max, WORKER_POLICY_DEFAULT.cpu_percent_max, "누락된 항목도 기본값");
});

test("E12 정책 정규화는 소수를 내림한다", () => {
  const n = normalizeWorkerPolicy({ cpu_percent_max: 150.9, max_wall_sec: 60.7, max_concurrent: 3.9 });
  assert.equal(n.cpu_percent_max, 150);
  assert.equal(n.max_wall_sec, 60);
  assert.equal(n.max_concurrent, 3);
});

test("E13 정책 정규화는 터무니없이 큰 값을 항목별 최대치로 접는다", () => {
  const n = normalizeWorkerPolicy({ max_concurrent: 1e9, max_per_member: 1e9, max_memory_mb: 1e12, cpu_percent_max: 1e6, max_wall_sec: 1e12 });
  assert.equal(n.max_concurrent, 4096);
  assert.equal(n.max_per_member, 4096);
  assert.equal(n.max_memory_mb, 1_048_576);
  assert.equal(n.cpu_percent_max, 6400);
  assert.equal(n.max_wall_sec, 2_592_000);
});

test("E14 정책 행이 없으면(신규 조직·구 행) 기본값이다", () => {
  assert.deepEqual(resolveWorkerPolicy(null), WORKER_POLICY_DEFAULT);
  assert.deepEqual(resolveWorkerPolicy(undefined), WORKER_POLICY_DEFAULT);
});

test("E15 정책이 객체가 아니면(배열·문자열) 기본값이다", () => {
  assert.deepEqual(resolveWorkerPolicy([]), WORKER_POLICY_DEFAULT);
  assert.deepEqual(resolveWorkerPolicy("policy"), WORKER_POLICY_DEFAULT);
});

test("E16 기본값의 CPU·수명 감시는 꺼져 있다 — 켜지 않은 조직에서 멀쩡한 worker를 죽이지 않는다", () => {
  assert.equal(WORKER_POLICY_DEFAULT.cpu_percent_max, 0);
  assert.equal(WORKER_POLICY_DEFAULT.max_wall_sec, 0);
});

// ── D. CPU 사용률 ──

test("E17 CPU 사용률은 누적 시간 증분을 실제 경과로 나눈다", () => {
  assert.equal(cpuPercentBetween({ cpuSec: 10, atMs: 1_000 }, { cpuSec: 11, atMs: 2_000 }), 100);
  assert.equal(cpuPercentBetween({ cpuSec: 10, atMs: 1_000 }, { cpuSec: 10.5, atMs: 2_000 }), 50);
});

test("E18 코어를 여러 개 쓰면 100%를 넘겨 읽는다(코어 수로 나누지 않는다)", () => {
  assert.equal(cpuPercentBetween({ cpuSec: 10, atMs: 1_000 }, { cpuSec: 14, atMs: 2_000 }), 400);
});

test("E19 경과가 0이거나 뒤로 갔으면 판정하지 않는다", () => {
  assert.equal(cpuPercentBetween({ cpuSec: 10, atMs: 2_000 }, { cpuSec: 11, atMs: 2_000 }), null);
  assert.equal(cpuPercentBetween({ cpuSec: 10, atMs: 2_000 }, { cpuSec: 11, atMs: 1_000 }), null);
});

test("E20 누적 CPU 시간이 감소했으면 판정하지 않는다 — 표본 유실·pid 재사용이지 사용률이 아니다", () => {
  assert.equal(cpuPercentBetween({ cpuSec: 10, atMs: 1_000 }, { cpuSec: 9, atMs: 2_000 }), null);
});

// ── E. ps 파싱 ──

test("E21 ps 누적 CPU 시간 표기를 초로 읽는다(소수 초 보존)", () => {
  assert.equal(parsePsCpuSeconds(" 0:05.32 "), 5.32);
  assert.equal(parsePsCpuSeconds("1:02:03"), 3_723);
  assert.equal(parsePsCpuSeconds("2-03:04:05"), 183_845);
});

test("E22 ps 표기를 못 읽으면 null 이다 — 감시를 끄되 worker 를 죽이지 않는다", () => {
  for (const bad of ["", "   ", "abc", "5", "1:2:3:4", "-1:00", "x:y"]) {
    assert.equal(parsePsCpuSeconds(bad), null, `${JSON.stringify(bad)} 는 읽히면 안 된다`);
  }
});

// ── 배선 계약(사양 A5) — 사용량은 '자기 자신을 뺀' 값이어야 한다 ──
// worker-service 는 workerBudgetUsage(instance.id, owner) 로 이 인스턴스의 기존 run 을 제외해 넘긴다.
// 그 제외가 사라지면 재시작·복구가 자기 자신 때문에 상한에 걸린다 — 그 시나리오를 여기서 못박는다.

test("A5 재시작은 자기 자신의 기존 run 을 빼고 세므로 상한 1에서도 되살아난다", () => {
  const p = policy({ ...OFF, max_concurrent: 1 });
  // 조직에 살아 있는 run 은 이 인스턴스의 것 하나뿐 → 제외하면 0 → 0+1=1 ≤ 1 허용
  assert.equal(decideWorkerBudget(p, usage(0), 128), null);
  // 자기 자신을 빼지 않고 넘겼다면 1+1=2 > 1 로 거부됐을 것이다(정책이 복구를 막는 자충수).
  assert.equal(decideWorkerBudget(p, usage(1), 128), "worker-budget-org-concurrency");
});
