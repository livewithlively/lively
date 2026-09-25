// scripts/hub-model.test.mjs — 프로젝트 허브 위젯의 순수 모델(web/projects/detail-hub-model.ts) 사양 테스트 (#4135 5판 시안).
//  컴파일 산출물 public/app/projects/detail-hub-model.js 를 그대로 import 한다(DOM 무의존 — hub-layout.test.mjs 동형).
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = await import(join(root, "public/app/projects/detail-hub-model.js"));

const NOW = new Date(2026, 8, 25, 12, 0, 0).getTime();   // 2026-09-25 정오(로컬)
const d = (days) => { const x = new Date(NOW + days * 86400000); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };
const T = (id, status, extra = {}) => ({ id, name: "t" + id, status, ...extra });

test("#1 보기 설정 정규화 — 모르는 값·깨진 저장본은 기본(상태 묶기 · 전체 · 담당자)", () => {
  assert.deepEqual(M.normalizeTasksPref(null), M.TASKS_PREF_DEFAULT);
  assert.deepEqual(M.normalizeTasksPref({ group: "x", filter: 3, col: "tags" }), M.TASKS_PREF_DEFAULT);
  assert.deepEqual(M.normalizeTasksPref({ group: "none", filter: "mine", col: "due" }), { group: "none", filter: "mine", col: "due" });
});

test("#2 폭 → 열 — 1칸은 설정한 열 하나(기본 담당자), 2칸은 담당자·마감일, 3칸은 셋 다", () => {
  assert.deepEqual(M.taskColsFor(1, M.TASKS_PREF_DEFAULT), ["assignee"]);
  assert.deepEqual(M.taskColsFor(1, { ...M.TASKS_PREF_DEFAULT, col: "priority" }), ["priority"]);
  assert.deepEqual(M.taskColsFor(2, M.TASKS_PREF_DEFAULT), ["assignee", "due"]);
  assert.deepEqual(M.taskColsFor(3, M.TASKS_PREF_DEFAULT), ["assignee", "due", "priority"]);
});

test("#3 줄 예산 — 한 칸에 묶음 하나면 2줄 이상, 세 칸이면 열 줄 넘게, 세로가 늘면 단조 증가, 최소 1", () => {
  assert.ok(M.rowsBudget(1, 1) >= 2, String(M.rowsBudget(1, 1)));
  assert.ok(M.rowsBudget(3, 2) >= 12, String(M.rowsBudget(3, 2)));
  let prev = 0; for (let h = 1; h <= 6; h++) { const c = M.rowsBudget(h, 2); assert.ok(c >= prev); prev = c; }
  assert.equal(M.rowsBudget(1, 9), 1);
  // 실제 픽셀을 넘지 않는다: 줄 × 33 + 묶음 크롬 + 위젯 크롬 ≤ 칸 높이
  for (let h = 1; h <= 6; h++) for (const g of [1, 2]) assert.ok(M.rowsBudget(h, g) * M.HUB_ROW_PX + g * M.HUB_GROUP_PX + M.HUB_CHROME_PX <= h * 276 - 16 + M.HUB_ROW_PX, h + "×" + g);
});

test("#4 묶음별 줄 나누기 — 앞 묶음부터, 있는 묶음엔 최소 1줄, 넘치는 묶음은 «더» 줄 자리를 비운다", () => {
  assert.deepEqual(M.splitRows([2, 10], 9), [2, 6]);       // 진행 중 2 전부 + 할 일 7 중 6(마지막은 «더»)
  assert.deepEqual(M.splitRows([0, 5], 3), [0, 2]);        // 빈 묶음은 0
  assert.deepEqual(M.splitRows([5, 5], 2), [1, 1]);        // 한 줄뿐이면 그 줄이 «더»
  assert.deepEqual(M.splitRows([3, 3], 10), [3, 3]);       // 남으면 그대로
  assert.deepEqual(M.splitRows([], 5), []);
});

test("#5 마감 판정 — 이번 주 = 오늘부터 7일 안(지난 것 포함, 완료 제외) · 마감 지남 수", () => {
  const ts = [T(1, "todo", { due_date: d(-2) }), T(2, "todo", { due_date: d(3) }), T(3, "todo", { due_date: d(9) }), T(4, "done", { due_date: d(-1) }), T(5, "todo")];
  assert.deepEqual(M.dueThisWeek(ts, NOW).map((t) => t.id), [1, 2]);
  assert.equal(M.overdueCount(ts, NOW), 1);
});

test("#6 크기별 묶음 — 1×1 내 것·열림 / 2×1 이번 주 마감 / 3×1 열림 한 묶음 / 그 밖 진행 중·할 일(완료는 어디에도 없다)", () => {
  const ts = [T(1, "in_progress", { assignee: "me" }), T(2, "todo", { assignee: "you" }), T(3, "todo", { assignee: "me", due_date: d(1) }), T(4, "done", { assignee: "me" })];
  const g11 = M.taskGroupsFor(ts, 1, 1, M.TASKS_PREF_DEFAULT, "me", NOW);
  assert.equal(g11.length, 1); assert.equal(g11[0].label, "내 것 · 열림"); assert.deepEqual(g11[0].tasks.map((t) => t.id), [1, 3]);
  const g11x = M.taskGroupsFor(ts, 1, 1, M.TASKS_PREF_DEFAULT, "", NOW);
  assert.equal(g11x[0].label, "열림"); assert.deepEqual(g11x[0].tasks.map((t) => t.id), [1, 2, 3]);
  const g21 = M.taskGroupsFor(ts, 2, 1, M.TASKS_PREF_DEFAULT, "me", NOW);
  assert.equal(g21[0].label, "이번 주 마감"); assert.deepEqual(g21[0].tasks.map((t) => t.id), [3]);
  const g13 = M.taskGroupsFor(ts, 1, 3, M.TASKS_PREF_DEFAULT, "me", NOW);
  assert.deepEqual(g13.map((g) => g.label), ["진행 중", "할 일"]); assert.deepEqual(g13[1].tasks.map((t) => t.id), [2, 3]);
  const g31 = M.taskGroupsFor(ts, 3, 1, M.TASKS_PREF_DEFAULT, "me", NOW);
  assert.equal(g31.length, 1); assert.equal(g31[0].label, "열림"); assert.deepEqual(g31[0].tasks.map((t) => t.id), [1, 2, 3], "3×1 은 한 묶음, 진행 중 먼저");
  const gNone = M.taskGroupsFor(ts, 2, 2, { group: "none", filter: "mine", col: "assignee" }, "me", NOW);
  assert.equal(gNone.length, 1); assert.deepEqual(gNone[0].tasks.map((t) => t.id), [1, 3]);
  for (const g of [...g11, ...g21, ...g13, ...g31, ...gNone]) assert.ok(g.tasks.every((t) => t.status !== "done"), "완료는 안 그린다");
});

test("#7 바닥 줄 글 — 1×1 «… N개 더», 1×N 마감 지남·완료 접힘, 2×1 이번 주, 그 밖 열림·마감 지남", () => {
  const ts = [T(1, "todo", { due_date: d(-3) }), T(2, "todo"), T(3, "todo"), T(4, "done")];
  assert.equal(M.tasksFootText(ts, 1, 1, 2, NOW), "… 1개 더");
  assert.equal(M.tasksFootText(ts, 1, 1, 3, NOW), "열림 3");
  assert.equal(M.tasksFootText(ts, 1, 1, 1, NOW, 18), "… 17개 더", "1×1 «더» 는 그 묶음(내 것·열림) 기준");
  assert.equal(M.tasksFootText(ts, 1, 3, 3, NOW), "마감 지남 1 · 완료 1 는 접힘");
  assert.equal(M.tasksFootText(ts, 2, 1, 1, NOW), "이번 주 마감 1 · 마감 지남 1");
  assert.equal(M.tasksFootText(ts, 3, 2, 3, NOW), "열림 3 · 마감 지남 1 · 완료 1 는 접힘");
});

test("#8 세션 — 태스크 색인(세션 하나에 태스크 하나) · 마지막 활동(초 단위 created 도 ms 로) · 정렬(순위 → 최근)", () => {
  const idx = M.sessionTaskIndex([{ id: 10, name: "A", sessions: [{ id: "s1" }, { id: "s2" }] }, { id: 11, name: "B", sessions: [{ id: "s1" }] }]);
  assert.deepEqual(idx.get("s1"), { id: 10, name: "A" }); assert.equal(idx.get("s3"), undefined);
  assert.equal(M.sessionLastActivity({ id: "x", created: 1790000000 }), 1790000000000);
  assert.equal(M.sessionLastActivity({ id: "x", created: 1790000000, lastBusy: 1790000500000 }), 1790000500000);
  const ss = [{ id: "a", created: 1 }, { id: "b", created: 3 }, { id: "c", created: 2 }];
  assert.deepEqual(M.sortSessions(ss, (s) => (s.id === "c" ? 0 : 1)).map((s) => s.id), ["c", "b", "a"]);
});

test("#9 세션 묶음 — 1×N 사용 중·최근 / 1행 한 묶음 / 2×2 이상 태스크 붙음·없음", () => {
  const ss = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const live = (s) => s.id === "a", has = (s) => s.id !== "c";
  assert.deepEqual(M.sessionGroupsFor(ss, 1, 3, live, has).map((g) => [g.label, g.sessions.length]), [["사용 중", 1], ["최근", 2]]);
  assert.deepEqual(M.sessionGroupsFor(ss, 3, 1, live, has).map((g) => [g.label, g.sessions.length]), [["세션", 3]]);
  assert.deepEqual(M.sessionGroupsFor(ss, 2, 2, live, has).map((g) => [g.label, g.sessions.length]), [["태스크에 붙은 세션", 2], ["태스크 없는 세션", 1]]);
});
