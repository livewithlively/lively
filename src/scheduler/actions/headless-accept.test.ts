// 배치 접수 판정(#3994 T5) — 사양 엣지 표 B·C2·C3 (스크래치패드 spec.md).
//  틀렸을 때 두 방향 모두 나쁘다: 접수 안 된 배치에 «봤음» 을 찍으면 그 자료·지식이 **아무도 안 본 채
//  영구히 숨는다**(#968 실측 942건). 반대로 접수된 배치에 안 찍으면 같은 집합이 매 tick 다시 올라와
//  배치가 영원히 반복된다(실측 64% 재독).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { acceptedTaskId } from "./headless-accept.js";

// ── B1~B3 접수됨 ──
assert.equal(acceptedTaskId({ status: "ok", summary: { task_id: 2216 } }), 2216);
assert.equal(acceptedTaskId({ status: "ok", summary: { task_id: "2216" } }), "2216", "문자열 id 를 버렸다 — 열쇠가 있는데 표식을 안 남긴다");
assert.equal(acceptedTaskId({ status: "ok", summary: { task_id: 7, queued: true } }), 7,
  "큐에 남은 배치도 접수는 된 것이다 — 표식을 안 찍으면 다음 tick 이 같은 집합을 또 낸다");

// ── B4~B8 ★ 접수 아님 — 여기서 열쇠를 내주면 자료가 조용히 사라진다 ──
assert.equal(acceptedTaskId({ status: "ok", summary: { skipped: "이전 실행 아직 진행 중", task_id: 100 } }), null,
  "중첩 스킵에 표식을 찍었다 — 그 task_id 는 이전 태스크의 것이라 되돌리기조차 안 걸린다");
assert.equal(acceptedTaskId({ status: "error", summary: { task_id: 5 } }), null, "실패한 접수에 표식을 찍었다");
assert.equal(acceptedTaskId({ status: "ok", summary: {} }), null, "task_id 없는 결과에 표식을 찍었다(되돌릴 열쇠가 없다)");
assert.equal(acceptedTaskId({ status: "ok" }), null, "summary 자체가 없는 결과를 접수로 봤다 — 새 축이 비어 있는 경우");
assert.equal(acceptedTaskId(null), null);
assert.equal(acceptedTaskId(undefined), null);

// ── B9 경계값 — 잡값이 열쇠가 되면 영구 유실 ──
assert.equal(acceptedTaskId({ status: "ok", summary: { task_id: Number.NaN } }), null, "NaN id 를 열쇠로 썼다");
assert.equal(acceptedTaskId({ status: "ok", summary: { task_id: "   " } }), null, "공백 문자열 id 를 열쇠로 썼다");
assert.equal(acceptedTaskId({ status: "ok", summary: { task_id: null } }), null);
assert.equal(acceptedTaskId({ status: "ok", summary: { task_id: 0 } }), null, "0 을 유효한 열쇠로 봤다 — org_task id 는 1부터다");

// ── 표 C2·C3 ★ 배선 — 증류·분류 두 곳이 이 판정을 실제로 쓰는가 ──
//  #968 에서 분류기는 결과와 무관하게 표식을 찍었고, 증류 레인은 accepted 를 계산해 두고도 안 썼다.
const root = process.cwd();
for (const f of ["src/scheduler/actions/classify.ts", "src/scheduler/actions/distill.ts"]) {
  const src = readFileSync(path.join(root, f), "utf8");
  assert.ok(src.includes("acceptedTaskId"), `${f} 가 접수 판정을 안 쓴다 — 접수 안 된 배치의 대상이 숨는다`);
}
const classify = readFileSync(path.join(root, "src/scheduler/actions/classify.ts"), "utf8");
assert.ok(!/await markClassifierSeen\(c\.id, inbox\.map\(\(x\) => x\.name\)\);/.test(classify),
  "분류기가 여전히 결과와 무관하게 «봤음» 을 찍는다");
const store = readFileSync(path.join(root, "src/node/task-store.ts"), "utf8");
assert.ok(/DELETE FROM org_classifier_seen WHERE task_id/.test(store),
  "작업이 실패해도 분류기 표식을 안 되돌린다 — 실패한 배치의 지식이 인박스에서 영구히 빠진다");

console.log("headless-accept.test: ok");
