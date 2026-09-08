// 부트스트랩 재시도(#2578) — «시간이 해결하는» 오류만 백오프로 다시 시도하고, 나머지는 즉시 던진다.
//  실측 근거: 2026-09-03 EC2 — healthz 200 직후 bootstrap-admin 이 42703(undefined_column) 로 죽고 설치는 '완료'.
import assert from "node:assert/strict";
import { withBootstrapRetry, isRetryableBootstrapError } from "./lib/bootstrap-retry.mjs";

const pgErr = (code, message = `pg ${code}`) => Object.assign(new Error(message), { code });

// 가짜 시계 — sleep 이 시간을 앞당긴다(실제로 기다리지 않는다).
function clock() {
  let t = 0;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps };
}

// ── 판정표 ──
{
  for (const c of ["42703", "42P01", "42704", "42883", "57P03", "08006", "08001", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
    assert.ok(isRetryableBootstrapError(pgErr(c)), `${c} 는 재시도 대상`);
  }
  for (const c of ["42501", "28P01", "23505", "42601", "ENOENT"]) {
    assert.ok(!isRetryableBootstrapError(pgErr(c)), `${c} 는 기다려도 안 바뀐다 — 즉시 던져야 한다`);
  }
  assert.ok(!isRetryableBootstrapError(new Error("no code")), "code 없는 오류는 재시도 안 함");
  assert.ok(!isRetryableBootstrapError(null));
  // node net 의 AggregateError(여러 주소 시도) — 안쪽 code 를 본다.
  const agg = new AggregateError([Object.assign(new Error("connect"), { code: "ECONNREFUSED" })], "connect failed");
  assert.ok(isRetryableBootstrapError(agg), "AggregateError 안의 ECONNREFUSED");
  assert.ok(isRetryableBootstrapError(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } })), "cause.code");
}

// ── 42703 두 번 뒤 성공 → 3번 호출, 백오프 500 → 750 ──
{
  const c = clock();
  const logs = [];
  let calls = 0;
  const out = await withBootstrapRetry("t", async () => {
    calls++;
    if (calls < 3) throw pgErr("42703", 'column "tenant_id" does not exist');
    return { ok: true, calls };
  }, { now: c.now, sleep: c.sleep, log: (l) => logs.push(l), maxMs: 60_000 });
  assert.deepEqual(out, { ok: true, calls: 3 });
  assert.deepEqual(c.sleeps, [500, 750], "백오프 500ms ×1.5");
  assert.equal(logs.length, 2);
  assert.match(logs[0], /\[t\] 재시도 1 — 42703 column "tenant_id" does not exist/);
}

// ── 재시도 불가 오류는 즉시 던진다(1번 호출·sleep 0) ──
{
  const c = clock();
  let calls = 0;
  await assert.rejects(
    withBootstrapRetry("t", async () => { calls++; throw pgErr("42501", "permission denied"); }, { now: c.now, sleep: c.sleep, log: () => {} }),
    /permission denied/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(c.sleeps, []);
}

// ── 예산을 넘기면 마지막 오류를 그대로 던진다(무한 대기 금지) ──
{
  const c = clock();
  let calls = 0;
  await assert.rejects(
    withBootstrapRetry("t", async () => { calls++; throw pgErr("ECONNREFUSED", `try ${calls}`); }, { now: c.now, sleep: c.sleep, log: () => {}, maxMs: 3_000 }),
    (err) => err.code === "ECONNREFUSED" && /^try \d+$/.test(err.message),
  );
  // 500 + 750 + 1125 = 2375 ≤ 3000, 다음 1687 을 더하면 초과 → 4번 호출·3번 대기.
  assert.equal(calls, 4);
  assert.deepEqual(c.sleeps, [500, 750, 1125]);
  const total = c.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(total <= 3_000, `총 대기 ${total} ≤ 예산`);
}

// ── 백오프 상한 5s ──
{
  const c = clock();
  let calls = 0;
  await withBootstrapRetry("t", async () => { calls++; if (calls < 8) throw pgErr("42P01"); }, { now: c.now, sleep: c.sleep, log: () => {}, maxMs: 120_000 });
  assert.equal(Math.max(...c.sleeps), 5_000, "한 번의 대기는 5s 를 넘지 않는다(설치 로그가 멈춘 것처럼 보이지 않게)");
}

// ── env 상한: BOOTSTRAP_RETRY_MAX_MS=0 → 재시도 없음 · 빈 문자열은 기본값(run_as_service 가 빈 값으로 넘긴다) ──
{
  const c = clock();
  process.env.BOOTSTRAP_RETRY_MAX_MS = "0";
  let calls = 0;
  await assert.rejects(withBootstrapRetry("t", async () => { calls++; throw pgErr("42703"); }, { now: c.now, sleep: c.sleep, log: () => {} }));
  assert.equal(calls, 1, "0 이면 한 번만");
  process.env.BOOTSTRAP_RETRY_MAX_MS = "";
  const c2 = clock();
  let calls2 = 0;
  await withBootstrapRetry("t", async () => { calls2++; if (calls2 < 2) throw pgErr("42703"); }, { now: c2.now, sleep: c2.sleep, log: () => {} });
  assert.equal(calls2, 2, "빈 문자열은 기본 예산(60s) — 재시도된다");
  delete process.env.BOOTSTRAP_RETRY_MAX_MS;
}
console.log("bootstrap-retry ok");
