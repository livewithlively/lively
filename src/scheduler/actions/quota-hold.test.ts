// 한도 소진 쉬기(#5160) — 정책: 한 실행 계정(의뢰자×하네스)의 마지막 종결 배치가 «hit your … limit» 로 실패했으면
//  풀림 시각 전엔 새 배치를 내지 않고, 풀림 시각부터 낸다. 아래 번호는 엣지 표의 행이다.
//  틀렸을 때 두 방향 모두 나쁘다: 못 알아보면 종전처럼 5분마다 죽는 배치가 쌓이고(하루 413건 실측),
//  시각을 잘못 읽어 멀리 잡으면 한도가 풀린 뒤에도 증류가 조용히 멈춰 있다.
import { strict as assert } from "node:assert";
import { quotaHoldUntil, activeQuotaHold, FALLBACK_HOLD_MS } from "./quota-hold.js";

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);
const WEEKLY = "You've hit your weekly limit · resets 9pm (UTC)";

// ── 1~7 실측 문구 ──
//  1 org_task 8074 — 23:59Z 에 «resets 9pm (UTC)» → 그날 21:00Z 는 지났으니 다음 날.
assert.equal(iso(quotaHoldUntil(WEEKLY, at("2026-10-29T23:59:28Z"))), "2026-10-30T21:00:00.000Z");
//  2 같은 날 뒤쪽이면 그날.
assert.equal(iso(quotaHoldUntil(WEEKLY, at("2026-10-30T05:00:00Z"))), "2026-10-30T21:00:00.000Z");
//  3 org_task 7458 — 날짜가 있는 꼴.
assert.equal(iso(quotaHoldUntil("You've hit your weekly limit · resets Oct 30, 9pm (UTC)", at("2026-10-29T11:26:00Z"))), "2026-10-30T21:00:00.000Z");
//  4 agent_job #17 — 서울(06:00 KST = 전날 21:00Z).
assert.equal(iso(quotaHoldUntil("You've hit your weekly limit · resets Oct 24, 6am (Asia/Seoul)", at("2026-10-22T09:35:00Z"))), "2026-10-23T21:00:00.000Z");
//  5 분 · 세션 한도.
assert.equal(iso(quotaHoldUntil("You've hit your session limit · resets 3:30pm (Asia/Seoul)", at("2026-10-30T01:00:00Z"))), "2026-10-30T06:30:00.000Z");
//  6 12am = 자정, 12pm = 정오.
assert.equal(iso(quotaHoldUntil("You've hit your limit · resets 12am (UTC)", at("2026-10-30T10:00:00Z"))), "2026-10-31T00:00:00.000Z");
assert.equal(iso(quotaHoldUntil("You've hit your limit · resets 12pm (UTC)", at("2026-10-30T10:00:00Z"))), "2026-10-30T12:00:00.000Z");
//  7 해를 넘는 풀림.
assert.equal(iso(quotaHoldUntil("You've hit your weekly limit · resets Jan 2, 6am (UTC)", at("2026-12-30T10:00:00Z"))), "2027-01-02T06:00:00.000Z");

// ── 8 한도가 아니면 쉬지 않는다 ──
assert.equal(quotaHoldUntil("exit 1 (exit-code)", Date.now()), null);
assert.equal(quotaHoldUntil("API Error: 529 overloaded", Date.now()), null);
assert.equal(quotaHoldUntil("", Date.now()), null);
assert.equal(quotaHoldUntil(null, Date.now()), null);
assert.equal(quotaHoldUntil(undefined, Date.now()), null);

// ── 9 한도인데 시각을 못 읽으면 바닥(1시간) — 영영 멈추지도, 5분마다 다시 죽지도 않는다 ──
const t0 = at("2026-10-30T00:00:00Z");
assert.equal(quotaHoldUntil("You've hit your weekly limit", t0), t0 + FALLBACK_HOLD_MS, "풀림 문구가 없는 한도");
assert.equal(quotaHoldUntil("You've hit your weekly limit · resets 9pm (Mars/Olympus)", t0), t0 + FALLBACK_HOLD_MS, "모르는 시간대");
assert.equal(quotaHoldUntil("You've hit your weekly limit · resets Foo 3, 9pm (UTC)", t0), t0 + FALLBACK_HOLD_MS, "모르는 달");
assert.equal(quotaHoldUntil("You've hit your weekly limit · resets 13pm (UTC)", t0), t0 + FALLBACK_HOLD_MS, "깨진 시각");
assert.equal(quotaHoldUntil("You've hit your weekly limit · resets Mar 30, 9pm (UTC)", t0), t0 + FALLBACK_HOLD_MS, "다섯 달 뒤 풀림을 믿었다");
//  표시 시각이 실패 시각 바로 앞(분 단위 내림) — «내일 3pm» 으로 하루를 쉬면 회복이 24시간 늦는다.
const justAfter = at("2026-10-30T15:00:05Z");
assert.equal(quotaHoldUntil("You've hit your session limit · resets 3pm (UTC)", justAfter), justAfter + FALLBACK_HOLD_MS, "막 풀리는 중인데 하루를 쉬었다");

// ── 10~14 마지막 배치로 지금 쉴지 ──
const failedAt = "2026-10-29T23:59:28Z";
const reset = at("2026-10-30T21:00:00Z");
const limited = { status: "failed", text: WEEKLY + "\nexit 1 (exit-code)", finishedAt: failedAt };
//  10 직전 배치가 없다.
assert.equal(activeQuotaHold(null, at("2026-10-30T01:00:00Z")), null);
assert.equal(activeQuotaHold(undefined, at("2026-10-30T01:00:00Z")), null);
//  11 성공한 배치는 요약에 한도 얘기가 있어도 쉬는 근거가 아니다.
assert.equal(activeQuotaHold({ ...limited, status: "done" }, at("2026-10-30T01:00:00Z")), null);
//  12 풀림 시각 정각부터 낸다.
assert.equal(activeQuotaHold(limited, reset), null, "풀림 정각에도 쉬었다 — 한 주기 늦게 회복한다");
assert.equal(activeQuotaHold(limited, reset + 1), null);
//  13 풀림 전이면 쉰다.
assert.equal(activeQuotaHold(limited, reset - 1), reset);
assert.equal(activeQuotaHold(limited, at("2026-10-30T01:00:00Z")), reset);
assert.equal(activeQuotaHold({ ...limited, finishedAt: new Date(failedAt) }, at("2026-10-30T01:00:00Z")), reset, "Date 로 온 finished_at");
//  한도가 아닌 실패는 쉬지 않는다(다음 주기에 그대로 다시 낸다 — 종전 동작).
assert.equal(activeQuotaHold({ status: "failed", text: "exit 1 (exit-code)", finishedAt: failedAt }, at("2026-10-30T01:00:00Z")), null);
//  14 종결 시각이 없거나 깨졌다.
assert.equal(activeQuotaHold({ ...limited, finishedAt: null }, at("2026-10-30T01:00:00Z")), null);
assert.equal(activeQuotaHold({ ...limited, finishedAt: "not-a-date" }, at("2026-10-30T01:00:00Z")), null);

console.log("quota-hold.test ok");
