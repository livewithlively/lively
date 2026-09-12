// 묶음 쓰기 경로의 판정(#1631) — **고아를 만들지 않는다** 를 표로 잠근다.
//  실행: npx tsx --test src/v6/category-group-store.test.ts  (빌드 경로: node dist/v6/category-group-store.test.js)
//
//  category.group_key 에는 FK 가 없다(묶음이 없어져도 카테고리는 안 죽어야 하므로). 그래서 «가리키는 묶음이
//  없는 group_key» 를 DB 가 안 막는다 — 막는 것은 쓰기 경로의 판정 셋이고, 그 셋을 순수 함수로 빼 둔 이유가
//  바로 이 파일이다(실 DB 계층은 *.itest.mjs 의 몫).
//
//  ── 엣지 표 (행마다 테스트 하나) ────────────────────────────────────────────────
//   ①  묶음 0개에서 시드                     → 직무 집합 그대로, skipped=false
//   ②  이미 묶음이 있으면 시드 안 함           → groups=[], skipped=true (멱등)
//   ③  없는 묶음 key 로 카테고리 생성/수정      → 거절 + 메시지에 **지금 있는 key 들**
//   ④  묶음 삭제 · 카테고리 남음 · 옮길 곳 없음  → 거절("카테고리 N개가 있습니다…")
//   ⑤  묶음 삭제 · 옮길 곳이 없는 묶음         → 같은 갈래로 거절(자기 자신도 «없는 묶음»)
//   ⑥  묶음 삭제 · reassignTo 정상            → 옮기고 삭제(ok)
//   ⑦  빈 묶음 삭제                          → 옮길 곳 없이도 ok
//   ⑧  group 해제(빈 문자열·null·공백)        → change=true, groupKey=null
//   ⑨  group 미지정(undefined)               → change=false (부분 수정에서 «안 건드림»)
//   ⑩  이름에서 key 슬러그(한글 포함)          → 항상 슬러그가 나온다
import test from "node:test";
import assert from "node:assert/strict";
import { planGroupAssign, planGroupRemoval, planGroupSeed, groupKeyFrom } from "./category-group-store.js";
import { GROUP_SETS } from "./category-groups.js";

const KEYS = ["build", "align", "metric"];

test("① 묶음이 하나도 없으면 그 사람 직무의 집합을 시드한다", () => {
  const plan = planGroupSeed({ existing: [], stage: "company", job: "개발" });
  assert.equal(plan.skipped, false);
  assert.deepEqual(plan.groups.map((g) => g.key), GROUP_SETS["개발"].map((g) => g.key));
  //  뜻이 함께 와야 한다 — 리브 2턴 지시문·화면 소제목이 이 문장을 그대로 싣는다.
  for (const g of plan.groups) assert.ok(g.hint.trim().length > 0, `${g.key}: 뜻이 비었다`);
  //  무대·직무를 모르면 default 집합 — 어느 경로로도 빈손이 없다.
  assert.equal(planGroupSeed({ existing: [] }).groups.length, GROUP_SETS.default.length);
});

test("② 이미 묶음이 있으면 아무것도 안 한다(멱등) — 사람이 고친 이름·순서를 덮지 않는다", () => {
  const plan = planGroupSeed({ existing: ["work"], stage: "company", job: "개발" });
  assert.equal(plan.skipped, true);
  assert.deepEqual(plan.groups, []);
});

test("③ 없는 묶음 key 로 카테고리를 넣으려 하면 거절 — 메시지에 지금 있는 key 들이 있다", () => {
  const plan = planGroupAssign({ group: "없는묶음", groupKeys: KEYS });
  assert.ok(plan.error, "없는 묶음은 거절돼야 한다");
  for (const k of KEYS) assert.match(plan.error!, new RegExp(k), `메시지에 '${k}' 가 없다 — 리브가 뭘로 고치나`);
  assert.equal(plan.groupKey, null, "거절했으면 값을 쓰지 않는다");
  //  있는 key 는 그대로 통과.
  assert.deepEqual(planGroupAssign({ group: "align", groupKeys: KEYS }), { change: true, groupKey: "align", error: null });
  //  앞뒤 공백은 다듬어서 판정한다(화면·에이전트가 붙여 넣는 값이다).
  assert.equal(planGroupAssign({ group: "  align  ", groupKeys: KEYS }).groupKey, "align");
  //  묶음이 하나도 없을 때도 «없다» 로 끝내지 않는다.
  assert.match(planGroupAssign({ group: "build", groupKeys: [] }).error ?? "", /하나도 없음/);
});

test("④ 카테고리가 남아 있는 묶음은 옮길 곳 없이 못 지운다", () => {
  const plan = planGroupRemoval({ inUse: 3, reassignTo: null, groupKeys: KEYS });
  assert.equal(plan.ok, false);
  assert.match(plan.error ?? "", /카테고리 3개가 있습니다/);
  assert.match(plan.error ?? "", /옮길 묶음을 정해 주세요/);
  assert.equal(plan.reassignTo, null);
  //  빈 문자열·공백도 «안 정한 것» 이다.
  assert.equal(planGroupRemoval({ inUse: 1, reassignTo: "   ", groupKeys: KEYS }).ok, false);
});

test("⑤ 옮길 곳이 없는 묶음이면 같은 갈래로 거절한다(자기 자신도 후보에 없다)", () => {
  const plan = planGroupRemoval({ inUse: 2, reassignTo: "유령", groupKeys: KEYS });
  assert.equal(plan.ok, false);
  assert.match(plan.error ?? "", /카테고리 2개가 있습니다/);
  assert.match(plan.error ?? "", /'유령' 라는 묶음이 없습니다/);
  //  호출부는 **지울 묶음을 뺀** 목록을 준다 — 그래서 자기 자신으로 옮기는 것도 여기서 걸린다.
  assert.equal(planGroupRemoval({ inUse: 2, reassignTo: "gone", groupKeys: KEYS }).ok, false);
});

test("⑥ 옮길 묶음을 주면 전부 옮기고 지운다", () => {
  assert.deepEqual(planGroupRemoval({ inUse: 4, reassignTo: "metric", groupKeys: KEYS }),
    { ok: true, reassignTo: "metric", error: null });
});

test("⑦ 빈 묶음은 옮길 곳 없이도 지운다", () => {
  assert.deepEqual(planGroupRemoval({ inUse: 0, reassignTo: null, groupKeys: KEYS }),
    { ok: true, reassignTo: null, error: null });
  //  비어 있으면 옮길 곳을 줘도 옮길 것이 없다.
  assert.equal(planGroupRemoval({ inUse: 0, reassignTo: "metric", groupKeys: KEYS }).reassignTo, null);
});

test("⑧ 빈 문자열·null 은 «해제» 다 — 어느 묶음에도 안 든다", () => {
  for (const v of ["", "   ", null]) {
    assert.deepEqual(planGroupAssign({ group: v, groupKeys: KEYS }), { change: true, groupKey: null, error: null },
      `해제 입력(${JSON.stringify(v)})이 해제로 안 읽힌다`);
  }
});

test("⑨ 값을 안 주면 안 건드린다 — 이름만 고치는 부분 수정이 소속을 지우면 안 된다", () => {
  assert.deepEqual(planGroupAssign({ groupKeys: KEYS }), { change: false, groupKey: null, error: null });
  assert.deepEqual(planGroupAssign({ group: undefined, groupKeys: KEYS }), { change: false, groupKey: null, error: null });
});

test("⑩ 이름에서 key 를 뽑는다 — 한글 이름도 빈손으로 안 끝난다", () => {
  assert.equal(groupKeyFrom("Build & Ship"), "build-ship");
  assert.equal(groupKeyFrom("  Metric  "), "metric");
  const ko = groupKeyFrom("내가 만든 것");
  assert.match(ko, /^g-[0-9a-f]{10}$/, "ascii 로 안 떨어지는 이름은 해시로 내린다");
  assert.equal(groupKeyFrom("내가 만든 것"), ko, "같은 이름은 같은 key(안정적이어야 카테고리가 계속 가리킨다)");
  assert.equal(groupKeyFrom("   "), "", "이름이 비면 key 도 없다(호출부가 400 을 낸다)");
});
