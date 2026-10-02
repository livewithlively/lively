// 아웃박스 정체 감시 — 「예산을 다 쓰고도 큐가 줄지 않는다」의 판정표.
//
//  왜 이 감시가 필요한가: 드레인에 시간예산이 생기면서(connectors/push-budget.ts) 한 배치를 다 못 비운
//   실행이 **정상 종료(exit 0)** 가 됐다. 그게 이 fix 의 목적이지만, 대가로 「매 틱 예산을 다 쓰는데
//   큐는 그대로」인 상태가 크론 실패 알림에 걸리지 않는다 — 잡은 계속 ok 를 찍는다.
//
//  판정 축이 「pending 이 줄었나」가 아니라 「**예산을 다 쓰고도** 줄지 않았나」인 이유:
//   예산을 안 쓰고 끝난 실행은 큐를 끝까지 훑은 것이라, 그때 남은 행은 처리할 수 없는 것(부모 미푸시
//   defer 등)이다. 그건 설계된 잔여지 정체가 아니다 — 축을 넓히면 그 상시 잔여가 영구 오탐이 된다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextStallState, outboxPhaseOf, outboxAlertFor, tickOnce, stopOutboxWatch, STALL_TICKS } from "./outbox-watch.js";
import type { Observation } from "./outbox-watch.js";
import type { BoxAlert } from "./box-watch.js";
import { childDrainSummary } from "../connectors/sync-outcome.js";

const r = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const CRON = r("../scheduler/actions/connector.ts");
const BOOT = r("../boot/housekeeping.ts");
const DRAIN = r("../connectors/clickup-push.ts");

test("표 — 예산을 다 쓰고도 안 줄면 센다", () => {
  //  첫 관측: 예산을 다 썼다는 것만으로는 정체가 아니다(비교할 이전이 없다) — 세기 시작만 한다.
  assert.equal(nextStallState(null, { remaining: 500, budgetStopped: true, lastRunAt: "c" }).streak, 1, "첫 예산 소진을 안 세고 있다");
  //  전진했다 — 예산을 다 썼어도 큐가 줄면 정체가 아니다(정상 배압).
  assert.equal(nextStallState({ streak: 4, remaining: 500, lastRunAt: "p" }, { remaining: 420, budgetStopped: true, lastRunAt: "c" }).streak, 0,
    "큐가 줄었는데 정체로 세고 있다 — 백로그 소화 중에 알림이 나간다");
  //  제자리
  assert.equal(nextStallState({ streak: 1, remaining: 500, lastRunAt: "p" }, { remaining: 500, budgetStopped: true, lastRunAt: "c" }).streak, 2);
  //  늘었다 — 유입이 처리보다 빠른 것도 큐가 안 빠지는 것이다.
  assert.equal(nextStallState({ streak: 1, remaining: 500, lastRunAt: "p" }, { remaining: 540, budgetStopped: true, lastRunAt: "c" }).streak, 2);
});

test("표 — 예산을 안 썼으면 정체가 아니다(설계된 잔여와 정체를 가르는 축)", () => {
  //  ★ 이 줄이 이 감시의 전제 — 예산을 안 쓰고 끝났다 = 큐를 끝까지 훑었다 = 남은 건 처리 불가능한 것.
  assert.equal(nextStallState({ streak: 9, remaining: 4, lastRunAt: "p" }, { remaining: 4, budgetStopped: false, lastRunAt: "c" }).streak, 0,
    "부모 미푸시 defer 같은 상시 잔여를 정체로 세고 있다 — 영구 오탐이 된다");
  assert.equal(nextStallState(null, { remaining: 4, budgetStopped: false, lastRunAt: "c" }).streak, 0);
  //  남은 게 없으면 예산 소진 여부와 무관하게 정체가 아니다(마지막 행 직후 경계에서 나올 수 있는 모양).
  assert.equal(nextStallState({ streak: 2, remaining: 0, lastRunAt: "p" }, { remaining: 0, budgetStopped: true, lastRunAt: "c" }).streak, 0,
    "빈 큐를 정체로 보고 있다");
  //  🔴 드레인이 잔여를 못 셌을 때(-1)는 **중립이다 — 0 으로 되돌리면 「해소」로 승격된다**(clickup-push.countPending).
  //   종전 이 표는 0 을 기대해 그 버그를 잠그고 있었다: 정체 중 count 가 한 번 실패하면 거짓 해소 알림이 나간다.
  assert.equal(nextStallState({ streak: 2, remaining: 500, lastRunAt: "p" }, { remaining: -1, budgetStopped: true, lastRunAt: "c" }).streak, 2,
    "못 센 값(-1)에 카운터를 되돌린다 — 거짓 해소 알림이 나간다");
  assert.equal(nextStallState(null, { remaining: -1, budgetStopped: true, lastRunAt: "c" }).streak, 0, "이전이 없으면 0 에서 시작한다");
  //  첫 관측이 못 센 값이면 baseline 에 -1 이 남는다(sentinel). 그게 다음 관측에서 «이전 없음» 과 같게
  //   동작해야 한다 — 훗날 비중립 분기가 prev.remaining 을 다르게 읽으면(<= · 차분) 조용히 깨지는 자리다.
  assert.equal(
    nextStallState({ streak: 0, remaining: -1, lastRunAt: "p" }, { remaining: 400, budgetStopped: true, lastRunAt: "c" }).streak,
    nextStallState(null, { remaining: 400, budgetStopped: true, lastRunAt: "c" }).streak,
    "첫 관측이 못 센 값이면 다음 관측은 첫 관측처럼 세야 한다");
  //  🔴 baseline 도 유지해야 한다 — -1 을 저장하면 다음 전진 판정이 `400 < -1` 이라 영영 거짓이 되어,
  //   큐가 실제로 줄고 있는데도 제자리로 세어 같은 거짓 경보가 순서만 바꿔 되살아난다.
  assert.equal(nextStallState({ streak: 2, remaining: 500, lastRunAt: "p" }, { remaining: -1, budgetStopped: true, lastRunAt: "c" }).remaining, 500,
    "못 센 값을 baseline 으로 저장한다 — 이후 전진이 영영 감지되지 않는다");
});

test("표 — 상한에 닿아야 정체로 판정한다(한 번의 예산 소진은 정상이다)", () => {
  assert.equal(outboxPhaseOf(STALL_TICKS - 1), "ok", "상한 전인데 이미 정체로 본다 — 백로그마다 알림이 나간다");
  assert.equal(outboxPhaseOf(STALL_TICKS), "stalled", "상한에 닿았는데 정상으로 본다");
  assert.equal(outboxPhaseOf(STALL_TICKS + 5), "stalled");
  assert.equal(outboxPhaseOf(0), "ok");
  assert.ok(STALL_TICKS >= 2, "상한이 1 이면 한 번의 예산 소진이 곧 알림이다 — 백로그 소화가 알림으로 보인다");
});

test("전이 — 문제로 넘어갈 때와 복구될 때만 말한다(늑대소년 방지)", () => {
  const cur = { remaining: 500, budgetStopped: true, streak: STALL_TICKS };
  //  첫 관측이 정상이면 침묵(기동할 때마다 알림이 오면 안 된다)
  assert.equal(outboxAlertFor(null, "ok", cur), null, "첫 관측 정상인데 알린다");
  //  같은 상태 반복은 침묵
  assert.equal(outboxAlertFor("ok", "ok", cur), null, "정상 유지인데 알린다");
  assert.equal(outboxAlertFor("stalled", "stalled", cur), null, "정체 유지인데 매 tick 알린다 — 늑대소년");
  //  전이만 말한다
  const bad = outboxAlertFor("ok", "stalled", cur);
  assert.equal(bad?.severity, "warn", "정체 전이를 안 알리거나 심각도가 다르다");
  assert.match(bad!.text, /500/, "남은 건수가 본문에 없다 — 받는 사람이 크기를 모른다");
  const good = outboxAlertFor("stalled", "ok", { remaining: 0, budgetStopped: false, streak: 0 });
  assert.equal(good?.severity, "ok", "복구를 안 알린다");
  //  순수 함수로서의 방어 — 상태기계에서는 도달하지 않는다(재기동 시 카운터가 0 부터라 첫 관측의 phase 는 항상 ok).
  //   그 «재기동 후 STALL_TICKS 만큼 다시 센다» 는 한계는 outbox-watch.ts 머리말에 적혀 있다.
  assert.equal(outboxAlertFor(null, "stalled", cur)?.severity, "warn");
});

test("파싱 — 자식 stdout 마지막 줄에서 드레인 수치를 꺼낸다", () => {
  const line = '{"level":30,"pushed":80,"remaining":420,"budgetStopped":true,"msg":"run-push 완료"}';
  assert.deepEqual(childDrainSummary(`{"level":30,"msg":"시작"}\n${line}`), { remaining: 420, budgetStopped: true });
  //  err 객체가 실린 stdout(성공 경로가 아님)에서도 마지막 줄만 본다
  assert.deepEqual(childDrainSummary(`{"level":40,"msg":"경고"}\n${line}`), { remaining: 420, budgetStopped: true });
  //  모양이 다르면 undefined — **0 으로 뭉개지 않는다**(모르는 것을 «큐가 비었다» 로 읽으면 정체를 놓친다)
  assert.equal(childDrainSummary('{"level":30,"msg":"완료"}'), undefined, "필드가 없는데 값을 지어냈다");
  assert.equal(childDrainSummary("not json"), undefined);
  assert.equal(childDrainSummary(""), undefined);
  assert.equal(childDrainSummary(undefined), undefined);
  assert.equal(childDrainSummary({ stdout: `x\n${line}` }), undefined, "문자열이 아닌 입력에서 값을 만들어 냈다");
  //  타입이 어긋나면 버린다(문자열 "420" 을 숫자로 받아들이면 비교가 조용히 틀어진다)
  assert.equal(childDrainSummary('{"remaining":"420","budgetStopped":true}'), undefined);
});

test("배선 — 드레인이 남은 건수를 반환값에 싣는다", () => {
  //  `/remaining/` 만으로는 주석·로그 줄에도 걸려 return 에서 빠져도 통과한다.
  assert.match(DRAIN, /return \{[^}]*\bremaining\b/, "remaining 이 반환값에 없다 — 감시가 볼 값이 없다");
});

test("배선 — 판정 입력이 로그 레벨과 무관하게 나간다", () => {
  const CLI = r("../connectors/run-push.ts");
  assert.match(CLI, /process\.stdout\.write\(JSON\.stringify\(res\)/,
    "요약이 logger 로만 나간다 — LOG_LEVEL 이 warn 이상이면 감시가 조용히 눈먼다");
});

test("배선 — push 액션이 요약에 드레인 수치를 구조화해 싣는다", () => {
  assert.match(CRON, /childDrainSummary\(/, "요약에 drain 이 없다 — 감시가 tail 문자열을 파싱해야 한다");
});

test("배선 — 감시가 기동 단계에 scheduler 게이트로 등록돼 있다", () => {
  //  import 줄만 남아도 통과하던 것을 단계 등록까지로 조인다. gate 가 scheduler 여야 다중 인스턴스에서
  //   중복 발송이 안 된다(cron-watch 와 같은 게이트).
  assert.match(BOOT, /name: "outbox-watch", gate: "scheduler"/,
    "감시를 아무도 켜지 않거나 게이트가 다르다 — 코드가 있어도 영영 안 돌거나 중복 발송한다");
});

// ── 상태기계(tickOnce) — 순수 함수가 맞아도 상태 보관이 틀리면 결과는 같다 ──
//  cron-watch.test.ts 의 관례를 그대로 따른다. 실제로 -1 버그는 순수 함수 단위에선 «의도대로» 보이고
//  이 조합에서만 드러났다.
const alertsOf = (): { sent: BoxAlert[]; deps: (o: Observation, accept?: boolean) => Parameters<typeof tickOnce>[0] } => {
  const sent: BoxAlert[] = [];
  return {
    sent,
    deps: (o, accept = true) => ({
      observe: async () => o,
      send: async (a) => { sent.push(a); return accept; },
    }),
  };
};
const stall = (remaining: number, at: string): Observation => ({ remaining, budgetStopped: true, lastRunAt: at });

test("상태기계 — 예산 소진이 상한만큼 이어지면 한 번 알리고, 이어지는 동안은 조용하다", async () => {
  stopOutboxWatch();
  const { sent, deps } = alertsOf();
  for (let i = 0; i < STALL_TICKS; i++) await tickOnce(deps(stall(500, `t${i}`)));
  assert.equal(sent.length, 1, `상한(${STALL_TICKS})에 닿을 때 정확히 한 번 알려야 한다`);
  assert.equal(sent[0]!.severity, "warn");
  await tickOnce(deps(stall(500, "t9")));
  assert.equal(sent.length, 1, "정체가 이어지는 동안 또 알린다 — 늑대소년");
  //  줄기 시작하면 해소
  await tickOnce(deps({ remaining: 0, budgetStopped: false, lastRunAt: "t10" }));
  assert.equal(sent.length, 2, "해소를 안 알린다");
  assert.equal(sent[1]!.severity, "ok");
});

test("상태기계 — 같은 실행을 다시 봐도 카운터가 오르지 않는다", async () => {
  stopOutboxWatch();
  const { sent, deps } = alertsOf();
  //  잡 주기가 감시 주기보다 길면 같은 요약을 여러 틱 재관측한다 — 실행 1회가 「상한 연속」이 되면 안 된다.
  for (let i = 0; i < STALL_TICKS + 3; i++) await tickOnce(deps(stall(500, "같은-실행")));
  assert.equal(sent.length, 0, "같은 실행을 여러 번 세어 정체로 판정했다");
});

test("상태기계 — 못 센 값(-1)이 끼어도 거짓 해소를 내지 않고 카운터가 이어진다", async () => {
  stopOutboxWatch();
  const { sent, deps } = alertsOf();
  for (let i = 0; i < STALL_TICKS; i++) await tickOnce(deps(stall(500, `a${i}`)));
  assert.equal(sent.length, 1);
  await tickOnce(deps({ remaining: -1, budgetStopped: true, lastRunAt: "b1" }));
  assert.equal(sent.length, 1, "집계 실패 한 번에 「정체 해소 … -1건」을 보냈다");
  await tickOnce(deps(stall(500, "b2")));
  assert.equal(sent.length, 1, "중립 뒤 같은 정체인데 다시 알린다");
});

test("상태기계 — 집계 실패 뒤 큐가 줄면 조용해야 한다(재게이트가 프로브로 재현한 순서)", async () => {
  stopOutboxWatch();
  const { sent, deps } = alertsOf();
  //  500,500 으로 세다가 한 번 못 세고(-1), 그 뒤 실제로 줄어드는(400→300) 시퀀스.
  //  baseline 에 -1 이 저장되면 400 이 «전진» 으로 안 읽혀 warn+ok 쌍이 나갔다.
  await tickOnce(deps(stall(500, "r1")));
  await tickOnce(deps(stall(500, "r2")));
  await tickOnce(deps({ remaining: -1, budgetStopped: true, lastRunAt: "r3" }));
  await tickOnce(deps(stall(400, "r4")));
  await tickOnce(deps(stall(300, "r5")));
  assert.equal(sent.length, 0, "큐가 줄고 있는데 정체·해소 알림이 나갔다");
});

test("상태기계 — 못 보낸 문제의 복구는 보내지 않는다", async () => {
  stopOutboxWatch();
  const { sent, deps } = alertsOf();
  for (let i = 0; i < STALL_TICKS; i++) await tickOnce(deps(stall(500, `c${i}`), false));
  assert.equal(sent.length, 1, "시도는 한다");
  await tickOnce(deps({ remaining: 0, budgetStopped: false, lastRunAt: "c9" }, false));
  assert.equal(sent.length, 1, "문제를 못 알렸으면 복구도 보내지 않는다");
});
