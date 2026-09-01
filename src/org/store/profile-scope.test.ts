// 리브 프로필 층 가르기(#2265) — 사양 엣지 표(scratchpad/spec-liv-profile-2265.md) 행마다 한 검사.
import test from "node:test";
import assert from "node:assert/strict";
import { viewForWorkspace, mergeForWorkspace, BY_WORKSPACE } from "./members.js";

const A = "ws-A", B = "ws-B";

test("① 빈 프로필 — 워크스페이스 층이 비어 있다", () => {
  const v = viewForWorkspace({}, A);
  assert.equal(v.welcome, undefined);
  assert.equal(v.onboarded_at, undefined);
});

test("② 옛 형태(최상위 welcome 만) — 폴백해서 보인다", () => {
  const v = viewForWorkspace({ welcome: { drawers: ["가"] } }, A);
  assert.deepEqual(v.welcome, { drawers: ["가"] });
});

test("③ 옛 값과 새 자리가 둘 다 있으면 새 자리가 이긴다", () => {
  const p = { welcome: { drawers: ["옛"] }, [BY_WORKSPACE]: { [A]: { welcome: { drawers: ["새"] } } } };
  assert.deepEqual(viewForWorkspace(p, A).welcome, { drawers: ["새"] });
});

test("④ 다른 워크스페이스 값을 빌려 오지 않는다 — 이 결함의 본체", () => {
  const p = { [BY_WORKSPACE]: { [A]: { welcome: { drawers: ["A것"] } } } };
  assert.equal(viewForWorkspace(p, B).welcome, undefined);
});

test("⑤ 계정 층은 어느 워크스페이스에서나 같다", () => {
  const p = { work: { asis: "세무" }, [BY_WORKSPACE]: { [A]: { welcome: {} } } };
  assert.deepEqual(viewForWorkspace(p, A).work, { asis: "세무" });
  assert.deepEqual(viewForWorkspace(p, B).work, { asis: "세무" });
});

test("⑥ ws-A 에 써도 ws-B 는 안 바뀐다 — 덮어쓰기 없음", () => {
  let p: Record<string, unknown> = mergeForWorkspace({}, { welcome: { drawers: ["A"] } }, A);
  p = mergeForWorkspace(p, { welcome: { drawers: ["B"] } }, B);
  assert.deepEqual(viewForWorkspace(p, A).welcome, { drawers: ["A"] });
  assert.deepEqual(viewForWorkspace(p, B).welcome, { drawers: ["B"] });
});

test("⑦ 계정 층 갱신은 최상위로 간다(워크스페이스 칸에 안 들어간다)", () => {
  const p = mergeForWorkspace({}, { work: { asis: "세무" }, welcome: { drawers: ["가"] } }, A);
  assert.deepEqual(p.work, { asis: "세무" });
  assert.equal((p as Record<string, Record<string, Record<string, unknown>>>)[BY_WORKSPACE][A].welcome !== undefined, true);
  assert.equal(p.welcome, undefined, "워크스페이스 키가 최상위에 남으면 안 된다");
});

test("⑧ 워크스페이스 컨텍스트가 없으면 종전대로 최상위에 읽고 쓴다 — 무회귀", () => {
  const p = mergeForWorkspace({ work: { asis: "x" } }, { welcome: { drawers: ["가"] } }, null);
  assert.deepEqual(p.welcome, { drawers: ["가"] });
  assert.equal(p[BY_WORKSPACE], undefined);
  assert.deepEqual(viewForWorkspace(p, null).welcome, { drawers: ["가"] });
});

test("⑨ 기존 사용자가 처음 쓸 때 옛 값이 새 자리로 승계된다 — 사라진 것처럼 보이면 안 된다", () => {
  const old = { welcome: { drawers: ["옛"] }, onboarded_at: "2026-01-01" };
  const p = mergeForWorkspace(old, { decisions: [{ what: "새 결정" }] }, A);
  const v = viewForWorkspace(p, A);
  assert.deepEqual(v.welcome, { drawers: ["옛"] }, "옛 welcome 이 승계돼야 한다");
  assert.equal(v.onboarded_at, "2026-01-01");
  assert.deepEqual(v.decisions, [{ what: "새 결정" }]);
});

test("⑩ 같은 워크스페이스에 두 번 쓰면 앞의 것이 보존된다(부분 갱신)", () => {
  let p = mergeForWorkspace({}, { welcome: { drawers: ["가"] } }, A);
  p = mergeForWorkspace(p, { onboarded_at: "2026-08-30" }, A);
  const v = viewForWorkspace(p, A);
  assert.deepEqual(v.welcome, { drawers: ["가"] });
  assert.equal(v.onboarded_at, "2026-08-30");
});

test("⑪ 승계가 끝나면 옛 최상위 자리를 비운다 — 다른 워크스페이스가 상속하면 안 된다", () => {
  const old = { welcome: { drawers: ["옛"], session_id: "box-1" }, onboarded_at: "2026-01-01" };
  const p = mergeForWorkspace(old, { decisions: [] }, A);
  assert.equal(p.welcome, undefined, "최상위 welcome 이 남으면 ws-B 가 상속한다");
  assert.equal(p.onboarded_at, undefined);
  // A 는 그대로 보이고, B 는 백지에서 시작한다
  assert.deepEqual(viewForWorkspace(p, A).welcome, { drawers: ["옛"], session_id: "box-1" });
  assert.equal(viewForWorkspace(p, B).welcome, undefined);
  assert.equal(viewForWorkspace(p, B).onboarded_at, undefined);
});
