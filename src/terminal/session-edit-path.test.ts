// 세션 고치기 갈 길(#4632) — 이게 틀리면: 다른 컴퓨터에서 뜬 세션 · 쉬는 세션의 이름 바꾸기가 500 으로 조용히 실패하고(앱빌더가 박은
//  «"회의록" 앱 제작» 이 안 남아 AI 가 지은 「회의록 기획카드」 가 남는다), 반대로 초대 고침이 기록만 바뀌어 다시 켜질 때 되돌아간다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { sessionEditPath } from "./session-edit-path.js";

test("R1 화면이 준 좌표(또는 되찾은 좌표)의 노드가 켜져 있으면 노드로 — 종전 그대로", () => {
  assert.equal(sessionEditPath({ nodeId: "n1", nodeOnline: true, labelOnly: true, centralGone: null }), "node");
  assert.equal(sessionEditPath({ nodeId: "n1", nodeOnline: true, labelOnly: false, centralGone: null }), "node");
});
test("R2 노드가 꺼져 있고 이름만 바꾸면 기록에 적는다", () => {
  assert.equal(sessionEditPath({ nodeId: "n2", nodeOnline: false, labelOnly: true, centralGone: null }), "stored");
});
test("R3 노드가 꺼져 있어도 초대가 섞였으면 노드로 — 기록만으로 초대를 바꾸지 않는다", () => {
  assert.equal(sessionEditPath({ nodeId: "n2", nodeOnline: false, labelOnly: false, centralGone: null }), "node");
});
test("R4 좌표가 없고 중앙 tmux 가 확답으로 없으면(쉬는 세션) 이름만은 기록에", () => {
  assert.equal(sessionEditPath({ nodeId: "", nodeOnline: false, labelOnly: true, centralGone: true }), "stored");
});
test("R5 좌표가 없고 중앙에서 살아 있으면 중앙 — 종전 그대로", () => {
  assert.equal(sessionEditPath({ nodeId: "", nodeOnline: false, labelOnly: true, centralGone: false }), "central");
});
test("R6 살아 있는지 모르면(null) 살아 있다고 본다 — 중앙", () => {
  assert.equal(sessionEditPath({ nodeId: "", nodeOnline: false, labelOnly: true, centralGone: null }), "central");
});
test("R7 초대 고침은 중앙 tmux 가 없어도 기록으로 새지 않는다 — 중앙(종전)", () => {
  assert.equal(sessionEditPath({ nodeId: "", nodeOnline: false, labelOnly: false, centralGone: true }), "central");
});
