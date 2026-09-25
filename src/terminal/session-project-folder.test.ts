// 사양 기반 · fail-first(엣지 표 → 행마다 시험 하나). 사양: session-project-folder.ts 머리말.
import { strict as assert } from "node:assert";
import test from "node:test";
import { contextNodeId, folderAbsFromRow } from "./session-project-folder.js";

const row = (o: Partial<{ node_id: string | null; dir: string | null; root_key: string | null; subpath: string | null }>) => o;

// ── contextNodeId: (호출자 값, 행) × 기대 ────────────────────────────────────────
test("★ [N1] 호출자가 밝힌 node 가 먼저다 — 행의 node_id 와 달라도 호출자 값", () => {
  assert.equal(contextNodeId("mac-1", row({ node_id: "other" })), "mac-1");
});
test("★★ [N2] 호출자가 안 밝히면 세션 행의 node_id — 노드 세션의 pane 엔 LIVELY_NODE_ID 가 없다", () => {
  assert.equal(contextNodeId("", row({ node_id: "laibeulliui-macmini" })), "laibeulliui-macmini");
  assert.equal(contextNodeId(undefined, row({ node_id: "laibeulliui-macmini" })), "laibeulliui-macmini");
  assert.equal(contextNodeId(null, row({ node_id: "laibeulliui-macmini" })), "laibeulliui-macmini");
});
test("★ [N3] 둘 다 없으면 ''(중앙 세션) — 행 없음 · node_id null · 공백", () => {
  assert.equal(contextNodeId("", undefined), "");
  assert.equal(contextNodeId("", null), "");
  assert.equal(contextNodeId("   ", row({ node_id: null })), "");
  assert.equal(contextNodeId("", row({ node_id: "  " })), "");
});
test("★ [N4] 다듬기 — 양끝 공백을 걷고 128자로 자른다(호출자 값·행 값 모두)", () => {
  assert.equal(contextNodeId("  n1  ", undefined), "n1");
  assert.equal(contextNodeId("x".repeat(200), undefined).length, 128);
  assert.equal(contextNodeId("", row({ node_id: " " + "y".repeat(200) })).length, 128);
});
test("★ [N5] 호출자 값이 문자열이 아니어도 던지지 않는다(숫자·객체는 문자열로 다듬는다)", () => {
  assert.equal(contextNodeId(12, undefined), "12");
  assert.doesNotThrow(() => contextNodeId({}, undefined));
});

// ── folderAbsFromRow: (명시 바인딩, folder, 행) × 기대 ─────────────────────────────
const F = "project/4135";
test("★ [F1] 명시 바인딩(lively init)이 있으면 그것 — 행이 무엇이든", () => {
  assert.equal(folderAbsFromRow("/x/bind", F, row({ dir: "/y", root_key: "shared", subpath: F })), "/x/bind");
});
test("★★ [F2] 명시 바인딩이 없고 행이 «공유 루트 아래 그 프로젝트 폴더» 에서 돌면 행의 dir", () => {
  assert.equal(folderAbsFromRow(null, F, row({ dir: "/Users/lively/workspace/project/4135", root_key: "shared", subpath: F })), "/Users/lively/workspace/project/4135");
  assert.equal(folderAbsFromRow("", F, row({ dir: "/Users/lively/workspace/project/4135", root_key: "shared", subpath: F })), "/Users/lively/workspace/project/4135");
  assert.equal(folderAbsFromRow(undefined, F, row({ dir: "/Users/lively/workspace/project/4135", root_key: "shared", subpath: F })), "/Users/lively/workspace/project/4135");
});
test("★★ [F3] subpath 가 프로젝트 folder 와 다르면 null — 다른 폴더에서 도는 세션의 dir 을 프로젝트 폴더로 우기지 않는다", () => {
  assert.equal(folderAbsFromRow(null, F, row({ dir: "/w/project/9999", root_key: "shared", subpath: "project/9999" })), null);
  assert.equal(folderAbsFromRow(null, F, row({ dir: "/w/project/4135/sub", root_key: "shared", subpath: "project/4135/sub" })), null);
});
test("★ [F4] root_key 가 shared 가 아니면 null(개인 폴더·기록 세션 등)", () => {
  assert.equal(folderAbsFromRow(null, F, row({ dir: "/w/project/4135", root_key: "personal", subpath: F })), null);
  assert.equal(folderAbsFromRow(null, F, row({ dir: "/w/project/4135", root_key: null, subpath: F })), null);
});
test("★ [F5] 행이 없거나 dir 이 비면 null · folder 가 비면 null", () => {
  assert.equal(folderAbsFromRow(null, F, undefined), null);
  assert.equal(folderAbsFromRow(null, F, null), null);
  assert.equal(folderAbsFromRow(null, F, row({ dir: "", root_key: "shared", subpath: F })), null);
  assert.equal(folderAbsFromRow(null, "", row({ dir: "/w", root_key: "shared", subpath: "" })), null);
});
test("★ [F6] 공백은 걷고 비교한다 — subpath 양끝 공백 · 명시 바인딩 공백은 «없음»", () => {
  assert.equal(folderAbsFromRow("   ", F, row({ dir: "/w/p", root_key: "shared", subpath: " " + F + " " })), "/w/p");
});
