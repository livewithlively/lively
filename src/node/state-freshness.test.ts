// 노드 상태 보고의 신선도 계약 (#2600 T2 d6) — 근거·실측은 `state-freshness.ts` 머리말.
//
//  사양 엣지 표(행마다 테스트 1개):
//   보낼 것  P1 변화 있음 · P2 ★변화 없음(침묵이 아니라 박동) · P3 강제 · P4 위탁 태스크 추적 중 ·
//            P5 강제 + 변화 없음
//   받는 쪽  B1 스냅샷이 있으면 나이를 되돌린다 · B2 ★스냅샷이 아직 없으면 무시한다(fail-closed)
import assert from "node:assert/strict";
import test from "node:test";
import { beatRefreshes, statePushKind } from "./state-freshness.js";

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
