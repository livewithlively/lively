// 리브 킥오프 판정(#1631) — 엣지 표 행마다 한 검사.
//  사양: reuse(이미 세션 있음) · skip(AI 미연결) · create(그 외, 첫 하네스로).
import test from "node:test";
import assert from "node:assert/strict";
import { planLivKickoff } from "./kickoff-plan.js";

test("① AI 가 하나도 안 이어져 있으면 세션을 열지 않는다 — 답 못 하는 창을 만들지 않는다", () => {
  assert.deepEqual(planLivKickoff(null, []), { action: "skip", reason: "ai-not-connected" });
});

test("② 로그인된 하네스가 있으면 그 첫 번째로 연다", () => {
  assert.deepEqual(planLivKickoff(null, ["claude", "codex"]), { action: "create", harness: "claude" });
  assert.deepEqual(planLivKickoff(null, ["codex"]), { action: "create", harness: "codex" });
});

test("③ 이미 세션이 있으면 재사용한다 — 처음 설정을 다시 눌러도 또 열지 않는다(멱등)", () => {
  assert.deepEqual(planLivKickoff("box-a-1", ["claude"]), { action: "reuse", sessionId: "box-a-1" });
});

test("④ 재사용은 AI 연결 여부보다 세다 — 이미 연 세션은 그대로 준다", () => {
  assert.deepEqual(planLivKickoff("box-a-1", []), { action: "reuse", sessionId: "box-a-1" });
});

test("⑤ 공백뿐인 하네스 이름은 없는 것으로 본다", () => {
  assert.deepEqual(planLivKickoff(null, ["   ", ""]), { action: "skip", reason: "ai-not-connected" });
  assert.deepEqual(planLivKickoff(null, ["  ", "codex"]), { action: "create", harness: "codex" });
});

test("⑥ 공백뿐인 priorSession 은 '없음'으로 본다", () => {
  assert.equal(planLivKickoff("   ", ["claude"]).action, "create");
});

// 배선 단언 — 세 갈래가 실제로 다 나오는지(vacuous 방지)
test("⑦ reuse·skip·create 가 모두 실제로 나온다", () => {
  const got = [planLivKickoff("s", []).action, planLivKickoff(null, []).action, planLivKickoff(null, ["claude"]).action];
  assert.deepEqual(got, ["reuse", "skip", "create"]);
});
