// scripts/hub-layout.test.mjs — 프로젝트 상세 위젯 허브의 배치 모델(web/projects/detail-hub-layout.ts) 사양 테스트 (#3916 · #4164).
//  컴파일 산출물 public/app/projects/detail-hub-layout.js 를 그대로 import 한다(DOM 무의존 — block-editor-roundtrip.test.mjs 동형).
//  #4164 — 크기가 S·M·L·XL 네 칸에서 가로 w(1~3) × 세로 h(1~6) 자유 선택으로 바뀌었다. 옛 저장본은 칸 수 그대로 옮겨진다.
//  저장은 부작용(가짜 localStorage 의 키·값)으로 단언한다.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = await import(join(root, "public/app/projects/detail-hub-layout.js"));

const sig = (l) => l.items.map((x) => x.tool + ":" + x.w + "x" + x.h).join(",") + "|" + [...l.hidden].sort().join(",");
const cells = (items) => items.reduce((n, x) => n + x.w * x.h, 0);
const find = (l, tool) => l.items.find((x) => x.tool === tool);

// CSS grid-auto-flow: dense 의 배치를 흉내 — 순서대로, 위에서부터 왼쪽부터 처음 들어가는 자리에 앉힌다.
//  반환 = 쓰인 행 수와 빈 칸 수(마지막 행까지). 프리셋이 «빈틈 0» 이라는 약속을 칸 합이 아니라 실제 배치로 잰다.
function placeDense(items, cols = M.HUB_COLS) {
  const occ = [];
  const free = (r, c, w, h) => { for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (x >= cols || (occ[y] && occ[y][x])) return false; return true; };
  for (const it of items) {
    let placed = false;
    for (let r = 0; !placed; r++) for (let c = 0; c <= cols - it.w && !placed; c++) {
      if (!free(r, c, it.w, it.h)) continue;
      for (let y = r; y < r + it.h; y++) { occ[y] = occ[y] || []; for (let x = c; x < c + it.w; x++) occ[y][x] = it.tool; }
      placed = true;
    }
  }
  let holes = 0;
  for (let y = 0; y < occ.length; y++) for (let x = 0; x < cols; x++) if (!occ[y] || !occ[y][x]) holes++;
  return { rows: occ.length, holes };
}

// 가짜 localStorage — 부재(undefined)와 존재를 시나리오마다 갈아 끼운다. 모듈은 호출 시점에 전역을 읽는다.
function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m };
}
function withStorage(store, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prev = globalThis.localStorage;
  if (store) globalThis.localStorage = store; else delete globalThis.localStorage;
  try { return fn(); } finally { if (had) globalThis.localStorage = prev; else delete globalThis.localStorage; }
}

test("#1 기본 한 벌(#4164) — 본문 2×2 · 태스크 1×3(사이드바 폭 긴 목록) · 세션은 숨김 · 12칸 빈틈 0", () => {
  const d = M.HUB_DEFAULT;
  assert.deepEqual(new Set([...d.items.map((x) => x.tool), ...d.hidden]), new Set(M.HUB_TOOLS), "도구 여섯 = 보이는 것 ∪ 숨긴 것");
  assert.deepEqual(d.hidden, ["sessions"]);
  assert.deepEqual({ w: find(d, "tasks").w, h: find(d, "tasks").h }, { w: 1, h: 3 });
  assert.deepEqual({ w: find(d, "body").w, h: find(d, "body").h }, { w: 2, h: 2 });
  assert.equal(cells(d.items), 12);
  assert.deepEqual(placeDense(d.items), { rows: 4, holes: 0 });
});

test("#2~#5 정규화 — 모르는 도구 버림 · 모르는 크기는 그 도구의 기본 크기 · 중복은 처음 것 · 빠진 도구는 끝에(기본이 숨긴 세션만 숨김)", () => {
  const l = M.normalizeHubLayout({ items: [{ tool: "timeline", w: 2, h: 4 }, { tool: "ghost", w: 1, h: 1 }, { tool: "tasks", w: 9, h: 1 }, { tool: "tasks", w: 1, h: 1 }] });
  assert.deepEqual(l.items.slice(0, 2), [{ tool: "timeline", w: 2, h: 4 }, { tool: "tasks", w: 1, h: 3 }]);
  assert.deepEqual(l.items.slice(2).map((x) => x.tool), ["body", "folder", "knowledge"]);
  assert.deepEqual(l.items.slice(2).map((x) => [x.w, x.h]), [[2, 2], [1, 1], [1, 1]], "빠진 도구는 기본 크기");
  assert.deepEqual(l.hidden, ["sessions"], "저장본에 없는 세션은 기본처럼 숨김");
});

test("#2b 옛 저장본(v1 S·M·L·XL) — 칸 수 그대로 옮기고, 거기 있던 세션은 보이는 채로 남긴다(사람이 고른 배치를 존중)", () => {
  const l = M.normalizeHubLayout({ v: 1, hidden: [], items: [
    { tool: "tasks", size: "l" }, { tool: "sessions", size: "s" }, { tool: "body", size: "s" },
    { tool: "folder", size: "m" }, { tool: "knowledge", size: "s" }, { tool: "timeline", size: "xl" }] });
  assert.deepEqual(l.items.map((x) => [x.tool, x.w, x.h]), [
    ["tasks", 2, 2], ["sessions", 1, 1], ["body", 1, 1], ["folder", 2, 1], ["knowledge", 1, 1], ["timeline", 3, 1]]);
  assert.deepEqual(l.hidden, []);
  assert.equal(l.v, 2);
  assert.equal(find(M.normalizeHubLayout({ items: [{ tool: "tasks", size: "huge" }] }), "tasks").h, 3, "모르는 옛 크기는 기본 크기");
});

test("#6~#7 정규화 — 숨김의 모르는 도구는 버리고, 보이는 목록에 있는 도구의 숨김은 무시한다", () => {
  const l = M.normalizeHubLayout({ items: [{ tool: "tasks", w: 2, h: 2 }], hidden: ["nope", "timeline", "tasks"] });
  assert.deepEqual(l.hidden.filter((x) => x !== "sessions"), ["timeline"]);
  assert.ok(!l.items.some((x) => x.tool === "timeline"));
  assert.ok(l.items.some((x) => x.tool === "tasks"), "items 가 이긴다");
});

test("#8 정규화 — null · 문자열 · items 가 객체여도 기본 한 벌, 예외 없음", () => {
  for (const raw of [null, undefined, "garbage", 42, { items: { tool: "tasks" } }, { items: null, hidden: "x" }, []]) {
    assert.equal(sig(M.normalizeHubLayout(raw)), sig(M.HUB_DEFAULT), String(raw));
  }
});

test("#9~#12 순서 — 자기 앞은 변화 없음 · 없는 도구는 같은 객체 · 없는 앞 도구면 맨 뒤 · 앞/뒤 이동 · 원본 불변", () => {
  const base = M.applyHubPreset("tasks");
  const before = sig(base);
  assert.equal(sig(M.moveHubItem(base, "tasks", "tasks")), before, "#9");
  assert.equal(M.moveHubItem(base, "ghost", "tasks"), base, "#10 같은 객체");
  const toEndByMissing = M.moveHubItem(base, "timeline", "ghost");
  assert.equal(toEndByMissing.items[toEndByMissing.items.length - 1].tool, "timeline", "#11");
  const front = M.moveHubItem(base, "timeline", "tasks");
  assert.equal(front.items[0].tool, "timeline", "#12 앞");
  assert.equal(front.items.length, 6);
  const end = M.moveHubItem(base, "tasks", null);
  assert.equal(end.items[end.items.length - 1].tool, "tasks", "#12 뒤");
  assert.equal(sig(base), before, "원본 불변");
});

test("#13 크기(#4164) — 가로 1~3 × 세로 1~6 안의 아무 조합이나 되고, 범위 밖·정수 아님은 그대로 · 원본 불변", () => {
  const base = M.normalizeHubLayout(M.HUB_DEFAULT);
  for (const [w, h] of [[1, 6], [3, 6], [2, 1], [1, 1], [3, 3]]) {
    const r = find(M.resizeHubItem(base, "tasks", w, h), "tasks");
    assert.deepEqual([r.w, r.h], [w, h], w + "×" + h);
  }
  for (const [w, h] of [[0, 1], [4, 1], [1, 0], [1, 7], [1.5, 2], ["2", 2]]) {
    assert.deepEqual(M.resizeHubItem(base, "tasks", w, h), base, "범위 밖 " + w + "×" + h);
  }
  assert.deepEqual([find(base, "tasks").w, find(base, "tasks").h], [1, 3]);
});

test("#14~#15 숨기기·되살리기 — 두 번 숨기면 같은 객체 · 모르는 도구는 그대로 · 되살리면 그 도구의 기본 크기로 끝에", () => {
  const base = M.normalizeHubLayout(M.HUB_DEFAULT);
  const hidden = M.hideHubItem(base, "knowledge");
  assert.deepEqual(hidden.hidden, ["sessions", "knowledge"]);
  assert.ok(!hidden.items.some((x) => x.tool === "knowledge"));
  assert.equal(M.hideHubItem(hidden, "knowledge"), hidden);
  assert.equal(sig(M.hideHubItem(base, "ghost")), sig(base));
  assert.equal(M.showHubItem(base, "knowledge"), base, "숨기지 않은 것은 같은 객체");
  const shown = M.showHubItem(base, "sessions");
  assert.deepEqual(shown.hidden, []);
  assert.deepEqual(shown.items[shown.items.length - 1], { tool: "sessions", w: 1, h: 1 });
});

test("#16~#17 프리셋 — 넷 다 도구 여섯을 덮고 12칸 빈틈 0 · 적용·판별 왕복 · 크기 하나 달라도 아니다 · 모르는 id 는 기본", () => {
  assert.equal(M.HUB_PRESETS.length, 4);
  const ids = new Set();
  for (const p of M.HUB_PRESETS) {
    ids.add(p.id);
    assert.deepEqual(new Set([...p.items.map((x) => x.tool), ...p.hidden]), new Set(M.HUB_TOOLS), p.id);
    assert.equal(cells(p.items), 12, p.id + " 12칸");
    assert.equal(placeDense(p.items).holes, 0, p.id + " 빈틈 0");
    const applied = M.applyHubPreset(p.id);
    assert.deepEqual([...applied.hidden].sort(), [...p.hidden].sort());
    assert.equal(M.matchHubPreset(applied), p.id);
  }
  assert.equal(ids.size, 4, "id 고유");
  assert.equal(M.matchHubPreset(M.hideHubItem(M.normalizeHubLayout(M.HUB_DEFAULT), "body")), null);
  assert.equal(M.matchHubPreset(M.resizeHubItem(M.normalizeHubLayout(M.HUB_DEFAULT), "tasks", 1, 4)), null, "크기 하나 달라도 아니다");
  assert.equal(sig(M.applyHubPreset("no-such")), sig(M.HUB_DEFAULT));
});

test("#18 크기 → 뷰 — 1×1 한눈 · 1×N·2×1 목록 · 3×1 띠 · 2×2 이상 전체 · 좁은 폭은 한눈 아니면 목록", () => {
  const V = (w, h, n) => M.hubView(w, h, n);
  assert.equal(V(1, 1), "glance");
  for (const [w, h] of [[1, 2], [1, 3], [1, 6], [2, 1]]) assert.equal(V(w, h), "list", w + "×" + h);
  assert.equal(V(3, 1), "band");
  for (const [w, h] of [[2, 2], [2, 6], [3, 2], [3, 6]]) assert.equal(V(w, h), "full", w + "×" + h);
  assert.equal(V(1, 1, true), "glance");
  for (const [w, h] of [[2, 2], [3, 1], [1, 4]]) assert.equal(V(w, h, true), "list", "좁은 폭 " + w + "×" + h);
});

test("#18b 목록 줄 수 — 1행은 종전처럼 다섯, 세로가 늘면 줄도 는다(1×3 태스크는 열여섯 줄 이상)", () => {
  assert.equal(M.hubListCap(1), 5);
  let prev = 0;
  for (let h = 1; h <= M.HUB_MAX_H; h++) { const c = M.hubListCap(h); assert.ok(c >= prev, "단조"); prev = c; }
  assert.ok(M.hubListCap(3) >= 16, String(M.hubListCap(3)));
  assert.ok(M.hubListCap(3) * 39 + 146 <= 3 * 276, "1×3 에 실제로 들어가는 줄 수를 넘지 않는다(잘림 없음)");
});

test("#19 localStorage 부재 — 복원은 기본·전역, 저장·되돌리기·범위 전환은 예외 없이 넘어간다", () => {
  withStorage(null, () => {
    const r = M.loadHubLayout(3625);
    assert.equal(r.scope, "global");
    assert.equal(sig(r.layout), sig(M.HUB_DEFAULT));
    assert.doesNotThrow(() => M.saveHubLayout(3625, r.layout, "project"));
    assert.doesNotThrow(() => M.resetHubLayout(3625, "global"));
    assert.doesNotThrow(() => M.setHubScope(3625, "project", r.layout));
    assert.equal(M.setHubScope(3625, "global", r.layout).scope, "global");
  });
});

test("#20 깨진 JSON 저장본 — 기본 한 벌로 선다 · 옛 v1 저장본은 읽혀서 칸 수 그대로", () => {
  const st = fakeStorage(); st.setItem("lively_hub_layout", "{not json");
  withStorage(st, () => { assert.equal(sig(M.loadHubLayout(1).layout), sig(M.HUB_DEFAULT)); });
  const st2 = fakeStorage();
  st2.setItem("lively_hub_layout", JSON.stringify({ v: 1, items: [{ tool: "tasks", size: "xl" }], hidden: [] }));
  withStorage(st2, () => { assert.deepEqual([find(M.loadHubLayout(1).layout, "tasks").w, find(M.loadHubLayout(1).layout, "tasks").h], [3, 1]); });
});

test("#21~#22 범위 — 전역 저장은 전역 키에만 · project 범위인데 프로젝트 키가 없으면 전역을 읽음 · 켜면 복사, 끄면 프로젝트 키 제거", () => {
  const st = fakeStorage();
  withStorage(st, () => {
    const custom = M.applyHubPreset("sessions");
    M.saveHubLayout(7, custom, "global");
    assert.ok(st._m.has("lively_hub_layout"), "전역 키에 저장");
    assert.ok(!st._m.has("lively_hub_layout_7") && !st._m.has("lively_hub_scope_7"), "프로젝트 키는 안 생긴다");
    assert.equal(sig(M.loadHubLayout(7).layout), sig(custom));
    assert.equal(sig(M.loadHubLayout(8).layout), sig(custom), "다른 프로젝트도 같은 전역 한 벌");
    // #21 — 범위만 project 로 찍혀 있고 프로젝트 키가 없다(옛 저장본·손상) → 전역을 읽는다
    st.setItem("lively_hub_scope_9", JSON.stringify("project"));
    assert.equal(M.loadHubLayout(9).scope, "project");
    assert.equal(sig(M.loadHubLayout(9).layout), sig(custom));
    // #22 — 켜면 지금 배치가 프로젝트로 복사되고, 그 뒤 프로젝트 수정은 전역을 건드리지 않는다
    const on = M.setHubScope(7, "project", custom);
    assert.equal(on.scope, "project");
    assert.ok(st._m.has("lively_hub_layout_7"));
    M.saveHubLayout(7, M.resizeHubItem(custom, "tasks", 1, 6), "project");
    assert.equal(find(M.loadHubLayout(7).layout, "tasks").h, 6);
    assert.equal(find(M.loadHubLayout(8).layout, "tasks").h, 2, "전역은 그대로");
    // 끄면 프로젝트 키가 사라지고 전역으로 돌아온다
    const off = M.setHubScope(7, "global", M.loadHubLayout(7).layout);
    assert.equal(off.scope, "global");
    assert.ok(!st._m.has("lively_hub_layout_7") && !st._m.has("lively_hub_scope_7"));
    assert.equal(sig(off.layout), sig(custom));
    // 되돌리기 — 그 범위에 기본 한 벌
    assert.equal(sig(M.resetHubLayout(7, "global")), sig(M.HUB_DEFAULT));
    assert.equal(sig(M.loadHubLayout(8).layout), sig(M.HUB_DEFAULT));
  });
});

test("#23 경계 — 도구 여섯을 전부 숨기면 items 가 비고 match 는 null, 하나 되살리면 그것만 선다", () => {
  let l = M.normalizeHubLayout(M.HUB_DEFAULT);
  for (const t of M.HUB_TOOLS) l = M.hideHubItem(l, t);
  assert.equal(l.items.length, 0);
  assert.equal(l.hidden.length, 6);
  assert.equal(M.matchHubPreset(l), null);
  const one = M.showHubItem(l, "sessions");
  assert.deepEqual(one.items, [{ tool: "sessions", w: 1, h: 1 }]);
  assert.equal(one.hidden.length, 5);
  assert.equal(M.normalizeHubLayout(l).items.length, 0, "정규화도 전부 숨김을 존중한다(강제로 되살리지 않는다)");
});
