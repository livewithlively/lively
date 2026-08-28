// 순수 단위 체크(node:assert) — 요청에 얹은 테넌트 아웃박스 정비(#2246). DB·express 를 띄우지 않는다.
//
//  ⚠ **"정비했다"를 로그 문구로 재지 않는다.** 관측 가능한 부작용은 *그 테넌트의 정비 슬롯을 가져갔는가*다:
//   발사하면 시각이 기록되므로, 같은 시각으로 판정을 다시 물으면 거짓이 돌아온다. 아래 `swept()` 가 그것이다.
//  ⚠ 엣지 표는 <스크래치패드>/spec.md 의 E1~E11 — 행마다 최소 하나씩 있다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withTenant } from "../org/tenant-context.js";
import { outboxRequestSweepMiddleware, resetSweepDebounce, shouldSweep, sweepIntervalMs, sweptTenantIds,
  SWEEP_MIN_INTERVAL_MS } from "./outbox-request-sweep.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// dist 에서 도는 테스트라 소스는 cwd 기준으로 읽는다(이 레포 관용구 — housekeeping-tenancy.test.ts 와 같다).
const SRC = "src/sessions/outbox-request-sweep.ts";
const TENANT = { id: "11111111-1111-1111-1111-111111111111", slug: "acme" };

/** 그 테넌트의 정비 슬롯이 이미 나갔나(= 누군가 발사했나). 판정 자체가 기록이므로 **한 번만** 묻는다. */
const swept = (id: string, now: number): boolean => !shouldSweep(id, now);

/** 매니지드처럼 보이게 env 를 세우고 한 번 돌린다(끝나면 원복 — 다른 테스트가 이 값을 본다). */
function asManaged(fn: () => void): void {
  const keep = { b: process.env.LIVELY_TENANT_BINDING, i: process.env.LIVELY_TENANT_ID, m: process.env.LIVELY_TENANCY_MODE };
  process.env.LIVELY_TENANT_BINDING = "rls";
  delete process.env.LIVELY_TENANT_ID;
  delete process.env.LIVELY_TENANCY_MODE;
  try { fn(); } finally {
    if (keep.b === undefined) delete process.env.LIVELY_TENANT_BINDING; else process.env.LIVELY_TENANT_BINDING = keep.b;
    if (keep.i !== undefined) process.env.LIVELY_TENANT_ID = keep.i;
    if (keep.m !== undefined) process.env.LIVELY_TENANCY_MODE = keep.m;
  }
}

/** 미들웨어를 한 번 태우고 next 호출 횟수를 돌려준다. */
function run(env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv, tenant: typeof TENANT | null = TENANT): number {
  const mw = outboxRequestSweepMiddleware(env);
  let nexts = 0;
  const call = (): void => { mw({} as never, {} as never, (() => { nexts++; }) as never); };
  if (tenant) withTenant(tenant, call); else call();
  return nexts;
}

// ── E1 · P1 이중 실행 금지 ──────────────────────────────────────────────────────
t("[E1] 하우스키핑이 도는 배포에서는 정비하지 않는다 — 이중으로 돌면 안 된다", () => {
  resetSweepDebounce();
  // env 를 안 건드리면 requestScopedTenancy() 가 거짓이다(= 자가호스팅 단일 테넌트).
  const nexts = run();
  assert.equal(nexts, 1, "무동작이어도 요청은 흘러가야 한다");
  assert.equal(swept(TENANT.id, 0), false, "슬롯을 가져가지 않았어야 한다");
});

// ── E2 · P2 임의 선택 금지 ──────────────────────────────────────────────────────
t("[E2] 테넌트 컨텍스트가 없으면 **아무도** 정비하지 않는다 — 임의로 고르면 남의 것을 만진다", () => {
  resetSweepDebounce();
  let nexts = 0;
  asManaged(() => { nexts = run({} as NodeJS.ProcessEnv, null); });
  assert.equal(nexts, 1);
  //  ⚠ "TENANT 가 안 쓸렸다"만 보면 안 된다 — 컨텍스트가 없으면 그건 늘 참이라 아무것도 못 잡는다
  //   (실측: 그 형태의 단언은 '컨텍스트 없을 때 임의의 키로 쓸어버리는' 변이를 통과시켰다).
  assert.deepEqual(sweptTenantIds(), [], "슬롯을 가져간 테넌트가 하나도 없어야 한다");
});

// ── E3 · P5 첫 목격 즉시 ────────────────────────────────────────────────────────
t("[E3] 매니지드 + 컨텍스트 있음 + 처음 목격 → 정비한다(재기동 직후가 가장 필요한 순간이다)", () => {
  resetSweepDebounce();
  let nexts = 0;
  asManaged(() => { nexts = run(); });
  assert.equal(nexts, 1, "정비해도 요청은 흘러가야 한다");
  assert.equal(swept(TENANT.id, 0), true, "슬롯을 가져갔어야 한다");
});

// ── E4·E5 · P3 주기 (경계값) ────────────────────────────────────────────────────
t("[E4] 주기 -1ms 는 아직 아니다 (경계)", () => {
  resetSweepDebounce();
  assert.equal(shouldSweep("t", 1_000), true);
  assert.equal(shouldSweep("t", 1_000 + SWEEP_MIN_INTERVAL_MS - 1), false);
});
t("[E5] 정확히 주기면 다시 정비한다 (경계 — > 와 >= 의 오프바이원)", () => {
  resetSweepDebounce();
  assert.equal(shouldSweep("t", 1_000), true);
  assert.equal(shouldSweep("t", 1_000 + SWEEP_MIN_INTERVAL_MS), true);
});

// ── E6 · P4 독립 ────────────────────────────────────────────────────────────────
t("[E6] 디바운스는 테넌트마다 따로다 — 한쪽이 정비했다고 남이 굶으면 안 된다", () => {
  resetSweepDebounce();
  assert.equal(shouldSweep("A", 1_000), true);
  assert.equal(shouldSweep("B", 1_000), true, "B 는 자기 시계를 갖는다");
  assert.equal(shouldSweep("A", 1_000), false);
});

// ── E7 · P3 동시 요청 ───────────────────────────────────────────────────────────
t("[E7] 같은 tick 에 들어온 두 요청은 한 번만 정비한다 — 판정과 기록이 한 호출 안에 있다", () => {
  resetSweepDebounce();
  assert.deepEqual([shouldSweep("t", 5_000), shouldSweep("t", 5_000)], [true, false]);
});

// ── E8 · P6 요청은 항상 통과 ────────────────────────────────────────────────────
t("[E8] 정비 경로가 어떻든 next 는 요청마다 정확히 한 번 — 정비 실패가 서비스 실패가 되면 안 된다", () => {
  resetSweepDebounce();
  let total = 0;
  asManaged(() => { for (let i = 0; i < 3; i++) total += run(); });
  assert.equal(total, 3, "3번 태웠으면 3번 통과 — 첫 요청만 정비하고 나머지는 디바운스에 걸려도 그렇다");
});

// ── E9·E10 · P9 신규 도입 변수(주기 오버라이드)의 부재·이상 ──────────────────────
//  ⚠ 이 두 행은 **이번에 새로 만든 것**이 낳은 엣지다. 원래 기능 관점의 표에는 없었다.
t("[E9] 주기 설정이 없으면 기본 5분 — 종전 하우스키핑 스윕과 같은 자를 쓴다", () => {
  assert.equal(SWEEP_MIN_INTERVAL_MS, 5 * 60_000);
  assert.equal(sweepIntervalMs({} as NodeJS.ProcessEnv), SWEEP_MIN_INTERVAL_MS);
});
t("[E10] 주기 설정이 쓰레기·0·음수·빈값이면 조용히 기본값 — 정비가 설정 오타로 멈추면 안 된다", () => {
  //  ⚠ 미들웨어를 태워서 재면 안 된다: 미들웨어는 env 에서 온 주기를 쓰는데 관측은 기본 주기로 묻게 돼
  //   **서로 다른 자**를 대는 꼴이 된다(실측: 그 형태는 env 를 그대로 신뢰하는 변이를 통과시켰다).
  //  ⚠ ""(빈 문자열)이 핵심 행이다 — `Number("")` 는 NaN 이 아니라 **0** 이라 유한성 검사만으론 안 걸린다.
  for (const bad of ["abc", "0", "-1", "", "  ", "NaN"]) {
    assert.equal(sweepIntervalMs({ LIVELY_OUTBOX_SWEEP_MS: bad } as NodeJS.ProcessEnv), SWEEP_MIN_INTERVAL_MS,
      `'${bad}' 가 기본값으로 안 떨어졌다`);
  }
  assert.equal(sweepIntervalMs({ LIVELY_OUTBOX_SWEEP_MS: "60000" } as NodeJS.ProcessEnv), 60_000,
    "제대로 된 값은 그대로 쓴다 — 무조건 기본값으로 떨구면 오버라이드가 죽은 손잡이가 된다");
});

// ── E11 · P8 복제 금지 ──────────────────────────────────────────────────────────
t("[E11] 정비 내용을 새로 정의하지 않는다 — 있던 resumeOutbox 를 그대로 부른다", () => {
  const src = readFileSync(SRC, "utf8");
  assert.match(src, /resumeOutbox\(\)/, "회수·청소·재-kick 을 한 벌로 가져오려면 그 함수를 불러야 한다");
  assert.doesNotMatch(src, /DELETE FROM|UPDATE org_session_outbox/,
    "여기에 SQL 을 새로 쓰면 원본과 갈라진다 — 스윕은 '어디서 부르나'의 문제지 '무엇을 하나'가 아니다");
});

console.log(`outbox-request-sweep: ${pass} passed`);
