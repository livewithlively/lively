// 세션 고치기 갈 길 · 기록만 바꾸기 관문(#4632) — 이게 틀리면: 다른 컴퓨터에서 뜬 세션 · 쉬는 세션의 이름 바꾸기가 500 으로 조용히 실패하고
//  (앱빌더가 박은 «"회의록" 앱 제작» 이 안 남아 AI 가 지은 「회의록 기획카드」 가 남는다), 초대 고침이 기록만 바뀌어 다시 켜질 때 되돌아가고,
//  남의 세션 · 이어진 옛 행의 이름이 기록에 적힌다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { cleanEditLabel, sessionEditPath, storedLabelRefusal } from "./session-edit-path.js";

const p = (o: Partial<Parameters<typeof sessionEditPath>[0]> = {}) =>
  sessionEditPath({ nodeId: "", rowNode: "", nodeOnline: false, labelOnly: true, centralGone: null, ...o });

test("R1 되찾은 좌표의 노드가 켜져 있으면 노드로 — 종전 그대로", () => {
  assert.equal(p({ nodeId: "n1", rowNode: "n1", nodeOnline: true }), "node");
  assert.equal(p({ nodeId: "n1", rowNode: "n1", nodeOnline: true, labelOnly: false }), "node");
});
test("R2 기록의 노드가 꺼져 있고 이름만 바꾸면 기록에 적는다", () => {
  assert.equal(p({ nodeId: "n2", rowNode: "n2" }), "stored");
});
test("R3 노드가 꺼져 있어도 초대가 섞였으면 노드로 — 기록만으로 초대를 바꾸지 않는다", () => {
  assert.equal(p({ nodeId: "n2", rowNode: "n2", labelOnly: false }), "node");
});
test("R8 화면이 준 좌표가 기록의 좌표와 다르면(낡은 · 엉뚱한 좌표) 꺼져 있어도 기록으로 새지 않는다 — 노드(종전)", () => {
  assert.equal(p({ nodeId: "n9", rowNode: "n2" }), "node");
  assert.equal(p({ nodeId: "n9", rowNode: "" }), "node");
});
test("R4 좌표가 없고 중앙 tmux 가 확답으로 없으면(쉬는 세션) 이름만은 기록에", () => {
  assert.equal(p({ centralGone: true }), "stored");
});
test("R5 좌표가 없고 중앙에서 살아 있으면 중앙 — 종전 그대로", () => {
  assert.equal(p({ centralGone: false }), "central");
});
test("R6 살아 있는지 모르면(null) 살아 있다고 본다 — 중앙", () => {
  assert.equal(p({ centralGone: null }), "central");
});
test("R7 초대 고침은 중앙 tmux 가 없어도 기록으로 새지 않는다 — 중앙(종전)", () => {
  assert.equal(p({ centralGone: true, labelOnly: false }), "central");
});

const row = (o: Record<string, unknown> = {}) => ({ owner: "wonjoon", superseded_by: null, ...o }) as { owner: string; superseded_by?: string | null };
test("G1 주인 · 이어지지 않은 행 · 이름 있음 = 막지 않는다", () => {
  assert.equal(storedLabelRefusal(row(), "wonjoon", '"회의록" 앱 제작', false), null);
});
test("G2 남의 세션은 403 — 초대받은 사람도 이름은 못 바꾼다", () => {
  assert.equal(storedLabelRefusal(row(), "sangmin", "x", false)?.status, 403);
  assert.equal(storedLabelRefusal(row({ owner: "" }), "", "x", false)?.status, 403, "빈 신원은 빈 주인과 같아도 주인이 아니다");
});
test("G3 기록이 없으면 404 · 못 읽었으면 503(없는 게 아니다)", () => {
  assert.equal(storedLabelRefusal(undefined, "wonjoon", "x", false)?.status, 404);
  assert.equal(storedLabelRefusal(undefined, "wonjoon", "x", true)?.status, 503);
});
test("G4 다른 세션으로 이어진 옛 행은 409", () => {
  assert.equal(storedLabelRefusal(row({ superseded_by: "box-new" }), "wonjoon", "x", false)?.status, 409);
});
test("G5 다듬으니 빈 이름은 400 · 다듬기는 탭 · 줄바꿈 → 공백 · 80자", () => {
  assert.equal(storedLabelRefusal(row(), "wonjoon", cleanEditLabel(" \n\t "), false)?.status, 400);
  assert.equal(cleanEditLabel(' "회의록"\t앱\n제작 '), '"회의록" 앱 제작');
  assert.equal(cleanEditLabel("가".repeat(100)).length, 80);
  assert.equal(cleanEditLabel(undefined), "");
});
