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

// ── #4213 T13 — «처음 연결» 대화는 Claude 커넥터를 읽으므로 로그인된 claude 를 먼저 쓴다(사양 spec.md §D P1~P5). ──
test("P1 claude 를 원하고 로그인돼 있으면 순서와 무관하게 claude 로 연다", () => {
  assert.deepEqual(planLivKickoff(null, ["codex", "claude"], "claude"), { action: "create", harness: "claude" });
});
test("P2 원하는 하네스가 로그인돼 있지 않으면 가두지 않고 첫 하네스로 연다", () => {
  assert.deepEqual(planLivKickoff(null, ["codex"], "claude"), { action: "create", harness: "codex" });
});
test("P3 로그인된 하네스가 없으면 원해도 열지 않는다", () => {
  assert.deepEqual(planLivKickoff(null, [], "claude"), { action: "skip", reason: "ai-not-connected" });
});
test("P4 이미 연 세션이 있으면 원하는 하네스와 무관하게 다시 쓴다", () => {
  assert.deepEqual(planLivKickoff("box-1", ["codex", "claude"], "claude"), { action: "reuse", sessionId: "box-1" });
});
test("P5 원하는 것이 없거나 빈칸이면 종전대로 첫 하네스", () => {
  assert.deepEqual(planLivKickoff(null, ["codex", "claude"]), { action: "create", harness: "codex" });
  assert.deepEqual(planLivKickoff(null, ["codex", "claude"], "  "), { action: "create", harness: "codex" });
  assert.deepEqual(planLivKickoff(null, ["codex", "claude"], null), { action: "create", harness: "codex" });
});
