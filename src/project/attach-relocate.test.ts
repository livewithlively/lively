// 첫 지시 첨부의 좌표 표기 파싱·치환(#3787) — 순수부만. 실제 이동은 DB·fs 라 여기서 안 잰다.
import assert from "node:assert/strict";
import test from "node:test";
import { refsInPrompt, rewriteRefs } from "./attach-relocate.js";

test("좌표 표기를 등장 순서대로, 중복 없이 뽑는다", () => {
  const p = "봐줘\n\n첨부한 자료:\n- a.png  [lively:personal:m1/uploads/a.png]\n- b.md  [lively:project:7/b.md]\n- a 다시  [lively:personal:m1/uploads/a.png]";
  assert.deepEqual(refsInPrompt(p), ["personal:m1/uploads/a.png", "project:7/b.md"]);
});

test("좌표가 없으면 빈 배열 — 구 클라이언트(맨 경로)는 건드리지 않는다", () => {
  assert.deepEqual(refsInPrompt("첨부한 자료(프로젝트 #7 공유 폴더):\n- b.md"), []);
});

test("옮긴 것만 바꾸고 **표시 이름은 그대로** 둔다", () => {
  const p = "- a.png  [lively:personal:m1/uploads/a.png]\n- b.md  [lively:project:7/b.md]";
  const out = rewriteRefs(p, new Map([["personal:m1/uploads/a.png", "project:9/a.png"]]));
  assert.equal(out, "- a.png  [lively:project:9/a.png]\n- b.md  [lively:project:7/b.md]");
});

test("옮긴 게 없으면 원문 그대로(불필요한 재작성 없음)", () => {
  const p = "- a.png  [lively:personal:m1/uploads/a.png]";
  assert.equal(rewriteRefs(p, new Map()), p);
});
