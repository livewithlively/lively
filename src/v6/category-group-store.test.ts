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
//   ⑧  group 해제(빈 문자열·null·공백)        → **묶음이 있으면 거절**(하드 규칙), 0개면 해제
//   ⑨  group 미지정(undefined)               → change=false (부분 수정에서 «안 건드림»)
//   ⑩  이름에서 key 슬러그(한글 포함)          → 항상 슬러그가 나온다
import test from "node:test";
import assert from "node:assert/strict";
import { planGroupAssign, planGroupRemoval, planGroupSeed, groupKeyFrom } from "./category-group-store.js";
import { GROUP_SETS } from "./category-groups.js";

const KEYS = ["build", "align", "metric"];

test("① 묶음이 하나도 없으면 그 사람 직무의 집합을 시드한다", () => {
  const plan = planGroupSeed({ existing: [], stage: "company", job: "개발·데이터" });
  assert.equal(plan.skipped, false);
  assert.deepEqual(plan.groups.map((g) => g.name), GROUP_SETS["개발·데이터"].map((g) => g.name));
  //  옛 판 답(직무 9종)으로 남아 있는 사람도 같은 집합을 받는다 — 별칭이 끊기면 옛 사용자만 기본으로 떨어진다.
  assert.deepEqual(planGroupSeed({ existing: [], stage: "company", job: "개발" }).groups.map((g) => g.name),
    GROUP_SETS["개발·데이터"].map((g) => g.name));
  //  뜻이 함께 와야 한다 — 리브 2턴 지시문·화면 소제목이 이 문장을 그대로 싣는다.
  for (const g of plan.groups) assert.ok(g.hint.trim().length > 0, `${g.key}: 뜻이 비었다`);
  //  무대·직무를 모르면 default 집합 — 어느 경로로도 빈손이 없다.
  assert.equal(planGroupSeed({ existing: [] }).groups.length, GROUP_SETS.default.length);
});

test("② 이미 묶음이 있으면 아무것도 안 한다(멱등) — 사람이 고친 이름·순서를 덮지 않는다", () => {
  const plan = planGroupSeed({ existing: ["g1"], stage: "company", job: "개발·데이터" });
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

test("⑧ 빈 문자열·null 은 «해제» 뜻이지만, 묶음이 있으면 거절된다 — 셋 중 하나에 반드시 든다", () => {
  for (const v of ["", "   ", null]) {
    const p = planGroupAssign({ group: v, groupKeys: KEYS });
    assert.equal(p.change, false, `해제가 통과했다(${JSON.stringify(v)})`);
    assert.match(String(p.error), /묶음 밖으로 뺄 수 없습니다/);
    //  묶음이 아직 0개인 워크스페이스에서는 그 말이 뜻을 잃으므로 종전대로 통과한다.
    assert.deepEqual(planGroupAssign({ group: v, groupKeys: [] }), { change: true, groupKey: null, error: null });
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

// ── 하드 규칙(#1631, 원준 2026-09-12): «모든 카테고리가 하드하게 셋 중 하나로 들어간다» ──────────
//  지시문으로 부탁하는 것과 서버가 막는 것은 다르다. 리브도 사람도 REST 도 planGroupAssign 한 자리를 지난다.
test("⑪ 묶음이 있는데 묶음 없이 만들려 하면 거절한다 — «반드시 하나»", () => {
  const p = planGroupAssign({ group: undefined, groupKeys: ["g1", "g2", "g3"], creating: true });
  assert.equal(p.change, false);
  assert.match(String(p.error), /반드시 들어갑니다/);
  assert.match(String(p.error), /g1/);
});
test("⑫ 묶음이 아직 0개면 종전대로 만들 수 있다 — 옛 워크스페이스를 세우지 않는다", () => {
  assert.deepEqual(planGroupAssign({ group: undefined, groupKeys: [], creating: true }),
    { change: false, groupKey: null, error: null });
});
test("⑬ 이미 든 카테고리를 묶음 밖으로 빼는 것(해제)은 거절한다", () => {
  for (const g of [null, ""]) {
    const p = planGroupAssign({ group: g, groupKeys: ["g1", "g2", "g3"] });
    assert.equal(p.change, false, `해제가 통과했다(${JSON.stringify(g)})`);
    assert.match(String(p.error), /묶음 밖으로 뺄 수 없습니다/);
  }
});
test("⑭ 묶음이 0개인 워크스페이스에서는 해제가 그대로 통한다(뺄 묶음 자체가 없다)", () => {
  assert.deepEqual(planGroupAssign({ group: null, groupKeys: [] }),
    { change: true, groupKey: null, error: null });
});
test("⑮ 고치기(만들기 아님)는 group 을 안 줘도 통과한다 — 이름만 고치는 길을 막지 않는다", () => {
  assert.deepEqual(planGroupAssign({ group: undefined, groupKeys: ["g1"] }),
    { change: false, groupKey: null, error: null });
});
