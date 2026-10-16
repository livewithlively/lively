// 처음 설정 완료 표식의 진행 표식(org/liv/welcome-marks.ts) — 값으로 잠근다(#4213 T13 · 격리 리뷰 2026-10-17).
//
//  사양 — 엣지 표:
//   K1 앞선 welcome 없음 · 세션 없음          → 옮길 것 없음(새 갈래·빈 표식으로 시작)
//   K2 같은 세션을 다시 쓴다                   → 진행 표식 다섯과 갈래를 옮긴다
//   K3 T13 전에 끝낸 사람(갈래 없음)이 다시 반영 → 갈래를 «처음 연결» 로 바꾸지 않는다(2턴이 90분 늦지 않게)
//   D1 처음 수집 끝 — 처음 설정을 끝낸 칸 없음  → 찍을 자리가 없다
//   D2 처음 수집 끝 — 처음 찍음                → 그 시각
//   D3 처음 수집 끝 — 이미 찍힘                → 처음 시각을 지킨다(밀리지 않는다)
import test from "node:test";
import assert from "node:assert/strict";
import { carryWelcomeProgress, withCollectDone } from "./welcome-marks.js";

const W = (o: Record<string, unknown> = {}) => ({ done_at: "2026-10-17T00:00:00.000Z", ...o }) as never;

test("K1 앞선 welcome 없음 · 세션 없음 — 옮길 것 없음", () => {
  assert.deepEqual(carryWelcomeProgress(null), {});
  assert.deepEqual(carryWelcomeProgress(undefined), {});
  assert.deepEqual(carryWelcomeProgress(W({ session_id: null, collect_done_at: "x", flow: "connect" })), {}, "세션이 없으면 새로 연다 — 옛 표식을 끌고 가지 않는다");
});

test("K2 같은 세션을 다시 쓴다 — 진행 표식 다섯과 갈래를 옮긴다", () => {
  const prior = W({ session_id: "s1", flow: "connect", collect_done_at: "c", distill_at: "d", distill_gave_up_at: null, distill_note: "n", distill_reopened_at: "r", stage: "company" });
  assert.deepEqual(carryWelcomeProgress(prior),
    { flow: "connect", collect_done_at: "c", distill_at: "d", distill_gave_up_at: null, distill_note: "n", distill_reopened_at: "r" });
});

test("K3 갈래가 없던 사람이 다시 반영해도 «처음 연결» 로 바뀌지 않는다", () => {
  const merged = { flow: "connect", ...carryWelcomeProgress(W({ session_id: "s-old" })) };
  assert.equal(merged.flow, undefined, "옛 세션에 «처음 연결» 갈래가 새로 찍힌다 — 아무도 처음 수집 끝을 안 찍어 2턴이 90분 늦는다");
  assert.equal(JSON.parse(JSON.stringify(merged)).flow, undefined, "저장된 값에도 갈래가 없다");
});

test("D1~D3 처음 수집 끝 — 칸이 없으면 그대로 · 처음 시각만", () => {
  const at = new Date("2026-10-17T03:00:00.000Z");
  assert.equal(withCollectDone(null, at), null, "D1");
  assert.equal(withCollectDone(W(), at)?.collect_done_at, "2026-10-17T03:00:00.000Z", "D2");
  const first = W({ collect_done_at: "2026-10-17T01:00:00.000Z" });
  assert.equal(withCollectDone(first, at), first, "D3 이미 찍힌 표식은 그대로(같은 값)");
});
