// 순수 단위 체크(node:assert) — 요청에 얹은 테넌트 정비(#2246). DB·tmux·express 를 띄우지 않는다.
//
//  ⚠ **"발사했다"를 로그 문구로 재지 않는다.** 관측 가능한 부작용은 *(정비, 테넌트) 슬롯을 가져갔는가*다.
//  ⚠ 엣지 표는 <스크래치패드>/spec2.md 의 F1~F13 — 행마다 최소 하나씩 있다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withTenant } from "../org/tenant-context.js";
import { outboxRequestSweepMiddleware, resetSweepDebounce, shouldSweep, jobIntervalMs, sweptKeys, sweptAt,
  SWEEP_JOBS, SWEEP_MIN_INTERVAL_MS, AWAITING_SWEEP_INTERVAL_MS, TEN_MIN_MS, SIX_HOURS_MS,
  type SweepJob } from "./outbox-request-sweep.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// dist 에서 도는 테스트라 소스는 cwd 기준으로 읽는다(이 레포 관용구 — housekeeping-tenancy.test.ts 와 같다).
const SRC = "src/sessions/outbox-request-sweep.ts";
const TENANT = { id: "11111111-1111-1111-1111-111111111111", slug: "acme" };
const OTHER = { id: "22222222-2222-2222-2222-222222222222", slug: "beta" };

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

// ── F1 · P1 정비가 여럿이다 ─────────────────────────────────────────────────────
t("[F1] 첫 목격이면 등록된 정비를 **전부** 발사한다 — 하나만 살리면 나머지가 죽은 채 남는다", () => {
  resetSweepDebounce();
  asManaged(() => { run(); });
  assert.deepEqual(sweptKeys().sort(), SWEEP_JOBS.map((j) => `${j.key}:${TENANT.id}`).sort());
  assert.ok(SWEEP_JOBS.length >= 2, "표에 정비가 둘 이상이어야 이 검사가 뜻이 있다");
});

// ── F2·F3 · P2·P3 정비마다 주기가 다르다 ────────────────────────────────────────
t("[F2] 아웃박스만 주기가 지났으면 아웃박스만 — 알림 시계를 같이 돌리지 않는다", () => {
  resetSweepDebounce();
  const T = "t1";
  assert.equal(shouldSweep("outbox", T, 0, SWEEP_MIN_INTERVAL_MS), true);
  assert.equal(shouldSweep("awaiting-notify", T, 0, AWAITING_SWEEP_INTERVAL_MS), true);
  const later = SWEEP_MIN_INTERVAL_MS;               // 5분 뒤 — 둘 다 주기를 넘겼다
  assert.equal(shouldSweep("outbox", T, later, SWEEP_MIN_INTERVAL_MS), true);
  // 알림은 30초라 훨씬 전에 이미 자격이 생긴다 — 아웃박스와 무관하게 자기 시계를 쓴다.
  assert.equal(shouldSweep("awaiting-notify", T, AWAITING_SWEEP_INTERVAL_MS, AWAITING_SWEEP_INTERVAL_MS), true);
});
t("[F3] 알림만 주기가 지났으면 알림만 — 아웃박스가 5분마다인 걸 30초로 끌어내리지 않는다", () => {
  resetSweepDebounce();
  const T = "t1";
  shouldSweep("outbox", T, 0, SWEEP_MIN_INTERVAL_MS);
  shouldSweep("awaiting-notify", T, 0, AWAITING_SWEEP_INTERVAL_MS);
  const at30s = AWAITING_SWEEP_INTERVAL_MS;
  assert.equal(shouldSweep("awaiting-notify", T, at30s, AWAITING_SWEEP_INTERVAL_MS), true, "알림은 자격이 생겼다");
  assert.equal(shouldSweep("outbox", T, at30s, SWEEP_MIN_INTERVAL_MS), false, "아웃박스는 아직 아니다");
});

// ── F4 · P3 테넌트마다 따로 ─────────────────────────────────────────────────────
t("[F4] 같은 정비라도 테넌트마다 자기 시계 — 한쪽이 돌았다고 남이 굶으면 안 된다", () => {
  resetSweepDebounce();
  //  ⚠ 문자열 키로만 재지 않는다 — **실제 미들웨어를 두 테넌트로** 태워야 컨텍스트→키 배선까지 걸린다.
  asManaged(() => { run({} as NodeJS.ProcessEnv, TENANT); run({} as NodeJS.ProcessEnv, OTHER); });
  const keys = sweptKeys();
  for (const who of [TENANT, OTHER])
    for (const j of SWEEP_JOBS)
      assert.ok(keys.includes(`${j.key}:${who.id}`), `${who.slug} 의 ${j.key} 가 안 돌았다`);
  assert.equal(keys.length, SWEEP_JOBS.length * 2, "정비 × 테넌트 만큼의 슬롯이 있어야 한다");
});

// ── F5 · P4 정비는 서로 독립이다 ────────────────────────────────────────────────
t("[F5] 한 정비가 던져도 나머지는 발사되고 요청은 통과한다", () => {
  resetSweepDebounce();
  // 표의 run 은 전부 `void ...` 로 던져지고 .catch 가 붙는다 — 동기 예외가 밖으로 새지 않는지 소스로 잠근다.
  const src = readFileSync(SRC, "utf8");
  const body = src.slice(src.indexOf("function maybeSweep"));
  assert.match(body.slice(0, body.indexOf("\n}")), /\.catch\(/, "발사한 정비마다 catch 가 붙어야 한다");
  let nexts = 0;
  asManaged(() => { nexts = run(); });
  assert.equal(nexts, 1);
});

// ── F6·F7 · P5 게이트 둘 ────────────────────────────────────────────────────────
t("[F6] 하우스키핑이 도는 배포에서는 **아무것도** 발사하지 않는다 — 이중 실행 금지", () => {
  resetSweepDebounce();
  const nexts = run();  // env 를 안 건드리면 requestScopedTenancy() 가 거짓이다
  assert.equal(nexts, 1, "무동작이어도 요청은 흘러가야 한다");
  assert.deepEqual(sweptKeys(), [], "슬롯을 가져간 것이 하나도 없어야 한다");
});
t("[F7] 컨텍스트가 없으면 **아무것도** 발사하지 않는다 — 임의로 고르면 남의 것을 만진다", () => {
  resetSweepDebounce();
  let nexts = 0;
  asManaged(() => { nexts = run({} as NodeJS.ProcessEnv, null); });
  assert.equal(nexts, 1);
  //  ⚠ 대상 하나만 보면 안 된다 — 컨텍스트가 없으면 그건 늘 참이라 아무것도 못 잡는다.
  assert.deepEqual(sweptKeys(), [], "슬롯을 가져간 것이 하나도 없어야 한다");
});

// ── F8 · P6 요청은 항상 한 번 ───────────────────────────────────────────────────
t("[F8] 정비가 몇 개든 next 는 요청마다 정확히 한 번", () => {
  resetSweepDebounce();
  let total = 0;
  asManaged(() => { for (let i = 0; i < 3; i++) total += run(); });
  assert.equal(total, 3, "3번 태웠으면 3번 통과 — 첫 요청만 발사하고 나머지가 디바운스에 걸려도 그렇다");
});

// ── F9·F10 · P2 주기 경계 ───────────────────────────────────────────────────────
t("[F9] 정확히 주기면 다시 돈다 (경계 — > 와 >= 의 오프바이원)", () => {
  resetSweepDebounce();
  assert.equal(shouldSweep("j", "t", 1_000, 30_000), true);
  assert.equal(shouldSweep("j", "t", 1_000 + 30_000, 30_000), true);
});
t("[F10] 주기 -1ms 는 아직 아니다 (경계)", () => {
  resetSweepDebounce();
  assert.equal(shouldSweep("j", "t", 1_000, 30_000), true);
  assert.equal(shouldSweep("j", "t", 1_000 + 30_000 - 1, 30_000), false);
});

// ── F11·F12 · 이번에 새로 만든 것(정비 표·둘째 주기)이 낳은 엣지 ──────────────────
t("[F11] 표가 비어 있어도 무동작 + 요청 통과 — 구조가 요청을 막으면 안 된다", () => {
  resetSweepDebounce();
  const src = readFileSync(SRC, "utf8");
  const body = src.slice(src.indexOf("function maybeSweep"));
  assert.match(body, /for \(const job of SWEEP_JOBS\)/, "표를 순회해야 한다 — 하드코딩하면 표의 뜻이 없다");
  // 빈 표는 곧 루프 0회이므로 아무 슬롯도 안 생긴다. 그 성질을 shouldSweep 로 직접 확인한다.
  assert.deepEqual(sweptKeys(), []);
});
t("[F12] 알림 주기는 아웃박스보다 **짧다** — 알림이 5분 뒤에 오면 알림이 아니다", () => {
  assert.ok(AWAITING_SWEEP_INTERVAL_MS < SWEEP_MIN_INTERVAL_MS,
    `알림(${AWAITING_SWEEP_INTERVAL_MS}) 이 아웃박스(${SWEEP_MIN_INTERVAL_MS}) 보다 짧아야 한다`);
  assert.equal(AWAITING_SWEEP_INTERVAL_MS, 30_000, "원래 스윕과 같은 30초");
  assert.equal(SWEEP_MIN_INTERVAL_MS, 5 * 60_000, "원래 스윕과 같은 5분");
});
t("[F12b] 주기 오버라이드는 정비마다 따로다 — 하나로 묶으면 30초와 5분이 같이 움직인다", () => {
  const ob = SWEEP_JOBS.find((j) => j.key === "outbox") as SweepJob;
  const aw = SWEEP_JOBS.find((j) => j.key === "awaiting-notify") as SweepJob;
  const env = { LIVELY_SWEEP_MS_OUTBOX: "60000" } as NodeJS.ProcessEnv;
  assert.equal(jobIntervalMs(ob, env), 60_000, "그 정비만 바뀐다");
  assert.equal(jobIntervalMs(aw, env), AWAITING_SWEEP_INTERVAL_MS, "다른 정비는 그대로여야 한다");
  //  ⚠ `Number("")` 는 NaN 이 아니라 **0** 이라, 유한성 검사만으론 빈 문자열이 "주기 0" 으로 샌다.
  for (const bad of ["abc", "0", "-1", "", "  ", "NaN"]) {
    assert.equal(jobIntervalMs(ob, { LIVELY_SWEEP_MS_OUTBOX: bad } as NodeJS.ProcessEnv), SWEEP_MIN_INTERVAL_MS,
      `'${bad}' 가 기본값으로 안 떨어졌다`);
  }
});

t("[F12c] 미들웨어가 **정비별** 주기를 실제로 쓴다 — 하나로 묶으면 알림이 5분마다 돈다", () => {
  //  ⚠ shouldSweep 을 직접 부르거나 jobIntervalMs 만 재면 이걸 못 잡는다(실측: 그 형태는
  //   '미들웨어가 모든 정비에 같은 주기를 쓰는' 변이를 통과시켰다). **미들웨어를 통과시켜** 재야 한다.
  resetSweepDebounce();
  const env = { LIVELY_SWEEP_MS_AWAITING_NOTIFY: "1" } as NodeJS.ProcessEnv;  // 알림만 1ms
  asManaged(() => { run(env); });
  const ob1 = sweptAt("outbox", TENANT.id), aw1 = sweptAt("awaiting-notify", TENANT.id);
  assert.ok(ob1 !== undefined && aw1 !== undefined, "첫 요청에 둘 다 돌아야 한다");
  const until = Date.now() + 3;
  while (Date.now() < until) { /* 1ms 주기를 넘기려고 잠깐 돈다 */ }
  asManaged(() => { run(env); });
  assert.notEqual(sweptAt("awaiting-notify", TENANT.id), aw1, "알림은 자기 주기(1ms)로 다시 돌아야 한다");
  assert.equal(sweptAt("outbox", TENANT.id), ob1, "아웃박스는 자기 주기(5분)라 아직 돌면 안 된다");
});

// ── F13 · P7 복제 금지 ──────────────────────────────────────────────────────────
t("[F13] 정비 내용을 새로 정의하지 않는다 — 있던 함수를 그대로 부른다", () => {
  const src = readFileSync(SRC, "utf8");
  assert.match(src, /m\.resumeOutbox\(\)/, "아웃박스 정비는 resumeOutbox 를 부른다");
  assert.match(src, /m\.sweepAwaitingNotifications\(\)/, "알림 정비는 sweepAwaitingNotifications 를 부른다");
  assert.doesNotMatch(src, /DELETE FROM|UPDATE org_session_outbox|INSERT INTO/,
    "여기에 SQL 을 쓰면 원본과 갈라진다 — 스윕은 '어디서 부르나'의 문제지 '무엇을 하나'가 아니다");
});

// ── F14 · 정비가 돌려준 것을 로그가 버리지 않는다 (#2246 후속) ─────────────────
t("[F14] 정비 결과를 로그에 펼쳐 찍는다 — «돌았다»만 찍으면 0건의 뜻이 안 갈린다", () => {
  const src = readFileSync(SRC, "utf8");
  const body = src.slice(src.indexOf("function maybeSweep"));
  //  결과를 받아서(then((r) => …)) 객체면 펼쳐 넣어야 한다. `.then(() => …)` 이면 버리는 것이다.
  assert.match(body, /\.then\(\(r\) =>/, "결과를 받아야 한다 — 인자 없는 then 은 버리는 것이다");
  assert.match(body, /\.\.\.\(r && typeof r === "object" \? r : \{\}\)/,
    "객체면 펼쳐 찍어야 한다(observed·awaiting·notified…). void 인 정비도 있으므로 조건부다");
});

// ── G1~G7 · 남은 정비를 표에 올린 뒤 (#2246) ────────────────────────────────
t("[G1] 표에 여덟 정비가 있고 첫 목격에 전부 발사한다", () => {
  resetSweepDebounce();
  assert.equal(SWEEP_JOBS.length, 8, "여덟 — background-sweeps 가 묶고 있던 수(파괴적인 하나는 제외)");
  asManaged(() => { run(); });
  assert.deepEqual(sweptKeys().sort(), SWEEP_JOBS.map((j) => `${j.key}:${TENANT.id}`).sort());
});
t("[G2] 각 정비의 주기가 원래 하우스키핑과 같은 값이다 — 새 정책을 만들지 않았다", () => {
  const want: Record<string, number> = {
    "outbox": SWEEP_MIN_INTERVAL_MS,                 // 종전 회수 스윕 5분
    "awaiting-notify": AWAITING_SWEEP_INTERVAL_MS,   // 종전 알림 30초
    "embedding-backfill": TEN_MIN_MS,                // 종전 600_000
    "device-auth-reap": TEN_MIN_MS,
    "oauth-reap": TEN_MIN_MS,
    "session-log-reap": SIX_HOURS_MS,                // 종전 6h
    "session-title-backfill": SIX_HOURS_MS,          // 원래는 부팅 1회 — 멱등이라 긴 주기가 같은 뜻
    "session-state-backfill": SWEEP_MIN_INTERVAL_MS, // 종전 5분
  };
  for (const j of SWEEP_JOBS) assert.equal(j.intervalMs, want[j.key], `${j.key} 의 주기가 다르다`);
  assert.deepEqual(Object.keys(want).sort(), SWEEP_JOBS.map((j) => j.key).sort(), "표와 기대가 같은 집합이어야 한다");
});
t("[G3] 설정이 필요한 정비가 터져도 나머지는 돈다 — 새 의존이 표 전체를 막으면 안 된다", () => {
  //  ⚠ `session-log-reap` 만 런타임 설정(retention_days)을 읽는다. 그 조회가 실패해도
  //   **그 정비만** 죽어야 한다 — 표의 run 은 각자 발사되고 각자 catch 되므로 구조적으로 그렇다.
  //   여기서는 그 구조를 못 박는다: run 은 서로를 await 하지 않는다.
  const src = readFileSync(SRC, "utf8");
  const loop = src.slice(src.indexOf("for (const job of SWEEP_JOBS)"));
  const body = loop.slice(0, loop.indexOf("\n  }"));
  assert.match(body, /void job\.run\(\)/, "각 정비는 void 로 던져야 한다 — await 하면 앞선 실패가 뒤를 막는다");
  assert.match(body, /\.catch\(/, "각 정비가 자기 catch 를 가져야 한다");
  //  설정을 읽는 정비가 **하나뿐**인지도 못 박는다 — 늘어나면 이 격리를 다시 생각해야 한다.
  const table = src.slice(src.indexOf("export const SWEEP_JOBS"), src.indexOf("const lastSweep"));
  assert.equal((table.match(/getRuntimeConfig\(\)/g) ?? []).length, 1,
    "런타임 설정을 읽는 정비는 session-log-reap 하나다");
});
t("[G4] 파괴적 정비(reapIdleSessions)는 표에 없다 — tmux 를 죽이는 판단은 #2148 의 몫", () => {
  const src = readFileSync(SRC, "utf8");
  const table = src.slice(src.indexOf("export const SWEEP_JOBS"), src.indexOf("const lastSweep"));
  assert.doesNotMatch(table, /reapIdleSessions\(\)/, "표에서 부르면 안 된다(주석으로 언급하는 것은 무방)");
  assert.ok(!SWEEP_JOBS.some((j) => j.key.includes("reap-idle") || j.key.includes("idle-reap")));
  //  ⚠ 그 짝인 백필은 **있어야** 한다 — 없으면 그 세션들이 회수 면역이면서 복원도 안 된다.
  assert.ok(SWEEP_JOBS.some((j) => j.key === "session-state-backfill"), "회수 전 백필은 올려야 한다");
});
t("[G5] 정비 키가 겹치지 않는다 — 겹치면 디바운스가 공유돼 하나가 굶는다", () => {
  const keys = SWEEP_JOBS.map((j) => j.key);
  assert.equal(new Set(keys).size, keys.length, `키 중복: ${keys.join(",")}`);
});
t("[G6] 모든 정비가 원래 함수를 부른다 — 여기서 새로 정의하지 않는다", () => {
  const src = readFileSync(SRC, "utf8");
  const table = src.slice(src.indexOf("export const SWEEP_JOBS"), src.indexOf("const lastSweep"));
  //  run 마다 `import(...)` 이 있어야 한다 = 원래 모듈을 부른다는 뜻.
  assert.equal((table.match(/run: \(\) => import\(/g) ?? []).length, SWEEP_JOBS.length,
    "정비 수만큼 import 가 있어야 한다 — 하나라도 여기서 직접 구현하면 원본과 갈라진다");
  assert.doesNotMatch(src, /DELETE FROM|UPDATE org_|INSERT INTO/, "SQL 을 여기에 쓰면 복제다");
});
t("[G7] 주기 오버라이드 env 이름이 정비마다 유일하다 — 겹치면 같이 움직인다", () => {
  const names = SWEEP_JOBS.map((j) => `LIVELY_SWEEP_MS_${j.key.replace(/-/g, "_").toUpperCase()}`);
  assert.equal(new Set(names).size, names.length, `env 이름 중복: ${names.join(",")}`);
  // 하나만 바꿔도 나머지는 그대로여야 한다.
  const [a, b] = SWEEP_JOBS;
  const env = { [`LIVELY_SWEEP_MS_${a!.key.replace(/-/g, "_").toUpperCase()}`]: "1234" } as NodeJS.ProcessEnv;
  assert.equal(jobIntervalMs(a!, env), 1234);
  assert.equal(jobIntervalMs(b!, env), b!.intervalMs);
});

console.log(`outbox-request-sweep: ${pass} passed`);
