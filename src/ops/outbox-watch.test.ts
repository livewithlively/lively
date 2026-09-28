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
import { nextStallStreak, outboxPhaseOf, outboxAlertFor, STALL_TICKS } from "./outbox-watch.js";
import { childDrainSummary } from "../connectors/sync-outcome.js";

const r = (p: string): string => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const CRON = r("../scheduler/actions/connector.ts");
const BOOT = r("../boot/housekeeping.ts");
const DRAIN = r("../connectors/clickup-push.ts");

test("표 — 예산을 다 쓰고도 안 줄면 센다", () => {
  //  첫 관측: 예산을 다 썼다는 것만으로는 정체가 아니다(비교할 이전이 없다) — 세기 시작만 한다.
  assert.equal(nextStallStreak(null, { remaining: 500, budgetStopped: true }), 1, "첫 예산 소진을 안 세고 있다");
  //  전진했다 — 예산을 다 썼어도 큐가 줄면 정체가 아니다(정상 배압).
  assert.equal(nextStallStreak({ streak: 4, remaining: 500 }, { remaining: 420, budgetStopped: true }), 0,
    "큐가 줄었는데 정체로 세고 있다 — 백로그 소화 중에 알림이 나간다");
  //  제자리
  assert.equal(nextStallStreak({ streak: 1, remaining: 500 }, { remaining: 500, budgetStopped: true }), 2);
  //  늘었다 — 유입이 처리보다 빠른 것도 큐가 안 빠지는 것이다.
  assert.equal(nextStallStreak({ streak: 1, remaining: 500 }, { remaining: 540, budgetStopped: true }), 2);
});

test("표 — 예산을 안 썼으면 정체가 아니다(설계된 잔여와 정체를 가르는 축)", () => {
  //  ★ 이 줄이 이 감시의 전제 — 예산을 안 쓰고 끝났다 = 큐를 끝까지 훑었다 = 남은 건 처리 불가능한 것.
  assert.equal(nextStallStreak({ streak: 9, remaining: 4 }, { remaining: 4, budgetStopped: false }), 0,
    "부모 미푸시 defer 같은 상시 잔여를 정체로 세고 있다 — 영구 오탐이 된다");
  assert.equal(nextStallStreak(null, { remaining: 4, budgetStopped: false }), 0);
  //  남은 게 없으면 예산 소진 여부와 무관하게 정체가 아니다(마지막 행 직후 경계에서 나올 수 있는 모양).
  assert.equal(nextStallStreak({ streak: 2, remaining: 0 }, { remaining: 0, budgetStopped: true }), 0,
    "빈 큐를 정체로 보고 있다");
  //  드레인이 잔여를 못 셌을 때(-1) — 모르는 것을 정체로 단정하지 않는다(clickup-push.countPending).
  assert.equal(nextStallStreak({ streak: 2, remaining: 500 }, { remaining: -1, budgetStopped: true }), 0,
    "못 센 값(-1)을 정체로 세고 있다");
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
  //  첫 관측이 이미 정체면 알린다(기동 시점에 이미 막혀 있던 것을 다음 주기까지 묻어두지 않는다)
  assert.equal(outboxAlertFor(null, "stalled", cur)?.severity, "warn", "기동 시 이미 정체인데 침묵한다");
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

test("배선 — 드레인이 남은 건수를 센다", () => {
  assert.match(DRAIN, /remaining/, "드레인이 remaining 을 안 낸다 — 감시가 볼 값이 없다");
});

test("배선 — push 액션이 요약에 드레인 수치를 구조화해 싣는다", () => {
  assert.match(CRON, /childDrainSummary\(/, "요약에 drain 이 없다 — 감시가 tail 문자열을 파싱해야 한다");
});

test("배선 — 감시가 기동 단계에 등록돼 있다", () => {
  assert.match(BOOT, /startOutboxWatch/, "감시를 아무도 켜지 않는다 — 코드가 있어도 영영 안 돈다");
});
