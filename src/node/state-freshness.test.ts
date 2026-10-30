// 노드 상태 보고의 신선도 계약 (#2600 T2 d6) — 근거·실측은 `state-freshness.ts` 머리말.
//
//  사양 엣지 표(행마다 테스트 1개):
//   보낼 것  P1 변화 있음 · P2 ★변화 없음(침묵이 아니라 박동) · P3 강제 · P4 위탁 태스크 추적 중 ·
//            P5 강제 + 변화 없음
//   받는 쪽  B1 스냅샷이 있으면 나이를 되돌린다 · B2 ★스냅샷이 아직 없으면 무시한다(fail-closed)
//   RPC 뒤   #3773 P10 아웃박스 걸음만 강제 push 면제(스크래치패드 `d6/pr1/spec.md` — 배선은 가드 S19a)
import assert from "node:assert/strict";
import test from "node:test";
import { beatRefreshes, pushesStateAfter, statePushKind } from "./state-freshness.js";

test("P1 세션 목록이 바뀌었으면 내용을 실어 보낸다", () => {
  assert.equal(statePushKind({ force: false, changed: true, tracked: 0 }), "state");
});

test("★★ P2 세션 목록이 그대로여도 **박동을 보낸다** — 침묵하면 게이트웨이 스냅샷이 12초 만에 낡는다", () => {
  assert.equal(statePushKind({ force: false, changed: false, tracked: 0 }), "beat");
});

test("P3 강제(접속 직후·RPC 응답 뒤)는 내용을 실어 보낸다", () => {
  assert.equal(statePushKind({ force: true, changed: false, tracked: 0 }), "state");
});

test("P4 위탁 태스크를 보는 중이면 내용을 실어 보낸다 — 같은 주기에 taskdone 을 얹는 종전 계약", () => {
  assert.equal(statePushKind({ force: false, changed: false, tracked: 1 }), "state");
});

test("P5 강제이면 변화가 없어도 내용이다", () => {
  assert.equal(statePushKind({ force: true, changed: false, tracked: 2 }), "state");
});

test("B1 스냅샷이 있으면 박동이 나이를 되돌린다", () => {
  assert.equal(beatRefreshes({ ts: 1 }), true);
});

test("★★ B2 스냅샷이 아직 없으면 박동을 무시한다 — 「본 적 없는 것」을 신선하다고 하면 빈 목록으로 소유가 넘어간다", () => {
  assert.equal(beatRefreshes(null), false);
  assert.equal(beatRefreshes(undefined), false);
});

test("★ #3773 P10 아웃박스 걸음(outboxStep) 뒤에는 강제 push 를 안 한다 — 준비 판정의 폴마다 전량 관측이 따라붙지 않게", () => {
  assert.equal(pushesStateAfter("outboxStep"), false);
});

test("#3773 P10 그 밖의 op 는 종전대로 강제 push 한다 — 모르는 op·빈 이름·대소문자만 다른 이름도(안 보내는 쪽으로 틀리지 않는다)", () => {
  for (const op of ["markActive", "create", "kill", "sendKeys", "injectFirstPrompt", "", "outboxstep", "unknownOp"]) {
    assert.equal(pushesStateAfter(op), true, `${JSON.stringify(op)} 뒤 강제 push 가 빠졌다 — 만들기·죽이기가 3초 늦게 보인다`);
  }
});
