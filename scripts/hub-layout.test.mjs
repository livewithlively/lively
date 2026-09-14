// scripts/hub-layout.test.mjs — 프로젝트 상세 위젯 허브의 배치 모델(web/projects/detail-hub-layout.ts) 사양 테스트 (#3916).
//  컴파일 산출물 public/app/projects/detail-hub-layout.js 를 그대로 import 한다(DOM 무의존 — block-editor-roundtrip.test.mjs 동형).
//  사양·엣지 표: 세션 스크래치패드 spec.md (23행) — 행마다 최소 하나의 단언. 저장은 부작용(가짜 localStorage 의 키·값)으로 단언한다.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = await import(join(root, "public/app/projects/detail-hub-layout.js"));

const sig = (l) => l.items.map((x) => x.tool + ":" + x.size).join(",");
const CELLS = { s: 1, m: 2, l: 4, xl: 3 };

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

test("#1 기본 한 벌 — 도구 여섯 전부 · 12칸을 정확히 채움 · 숨김 없음", () => {
  assert.deepEqual(new Set(M.HUB_DEFAULT.items.map((x) => x.tool)), new Set(M.HUB_TOOLS));
  assert.equal(M.HUB_DEFAULT.items.reduce((n, x) => n + CELLS[x.size], 0), 12);
  assert.deepEqual(M.HUB_DEFAULT.hidden, []);
});

test("#2~#5 정규화 — 모르는 도구 버림 · 모르는 크기는 기본 크기 · 중복은 처음 것 · 빠진 도구는 끝에(숨기지 않음)", () => {
  const l = M.normalizeHubLayout({ items: [{ tool: "sessions", size: "xl" }, { tool: "ghost", size: "s" }, { tool: "tasks", size: "huge" }, { tool: "tasks", size: "s" }] });
  assert.deepEqual(l.items.slice(0, 2), [{ tool: "sessions", size: "xl" }, { tool: "tasks", size: "l" }]);
  assert.deepEqual(l.items.slice(2).map((x) => x.tool), ["body", "folder", "knowledge", "timeline"]);
  assert.deepEqual(l.items.slice(2).map((x) => x.size), ["s", "m", "s", "xl"], "빠진 도구는 기본 크기");
  assert.deepEqual(l.hidden, []);
  assert.equal(l.items.length, 6);
});

test("#6~#7 정규화 — 숨김의 모르는 도구는 버리고, 보이는 목록에 있는 도구의 숨김은 무시한다", () => {
  const l = M.normalizeHubLayout({ items: [{ tool: "tasks", size: "l" }], hidden: ["nope", "timeline", "tasks"] });
  assert.deepEqual(l.hidden, ["timeline"]);
  assert.ok(!l.items.some((x) => x.tool === "timeline"));
  assert.ok(l.items.some((x) => x.tool === "tasks"), "items 가 이긴다");
});

test("#8 정규화 — null · 문자열 · items 가 객체여도 기본 한 벌, 예외 없음", () => {
  for (const raw of [null, undefined, "garbage", 42, { items: { tool: "tasks" } }, { items: null, hidden: "x" }, []]) {
    const l = M.normalizeHubLayout(raw);
    assert.equal(sig(l), sig(M.HUB_DEFAULT), String(raw));
    assert.deepEqual(l.hidden, []);
  }
});

test("#9~#12 순서 — 자기 앞은 변화 없음 · 없는 도구는 같은 객체 · 없는 앞 도구면 맨 뒤 · 앞/뒤 이동 · 원본 불변", () => {
  const base = M.normalizeHubLayout(M.HUB_DEFAULT);
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

test("#13 크기 — 아는 크기만 바뀌고 모르는 크기는 그대로 · 원본 불변", () => {
  const base = M.normalizeHubLayout(M.HUB_DEFAULT);
  assert.equal(M.resizeHubItem(base, "folder", "xl").items.find((x) => x.tool === "folder").size, "xl");
  assert.equal(M.resizeHubItem(base, "folder", "huge").items.find((x) => x.tool === "folder").size, "m");
  assert.equal(base.items.find((x) => x.tool === "folder").size, "m");
});

test("#14~#15 숨기기·되살리기 — 두 번 숨기면 같은 객체 · 모르는 도구는 그대로 · 되살리면 기본 크기로 끝에", () => {
  const base = M.normalizeHubLayout(M.HUB_DEFAULT);
  const hidden = M.hideHubItem(base, "knowledge");
  assert.deepEqual(hidden.hidden, ["knowledge"]);
  assert.ok(!hidden.items.some((x) => x.tool === "knowledge"));
  assert.equal(M.hideHubItem(hidden, "knowledge"), hidden);
  assert.equal(sig(M.hideHubItem(base, "ghost")), sig(base));
  assert.equal(M.showHubItem(base, "knowledge"), base, "숨기지 않은 것은 같은 객체");
  const shown = M.showHubItem(M.resizeHubItem(hidden, "tasks", "s"), "knowledge");
  assert.deepEqual(shown.hidden, []);
  assert.deepEqual(shown.items[shown.items.length - 1], { tool: "knowledge", size: "s" });
});

test("#16~#17 프리셋 — 넷 다 도구 여섯 · 적용하면 숨김이 풀림 · 판별 왕복 · 숨김 있으면 null · 모르는 id 는 기본", () => {
  assert.equal(M.HUB_PRESETS.length, 4);
  const ids = new Set();
  for (const p of M.HUB_PRESETS) {
    ids.add(p.id);
    assert.deepEqual(new Set(p.items.map((x) => x.tool)), new Set(M.HUB_TOOLS), p.id);
    const applied = M.applyHubPreset(p.id);
    assert.deepEqual(applied.hidden, []);
    assert.equal(M.matchHubPreset(applied), p.id);
  }
  assert.equal(ids.size, 4, "id 고유");
  assert.equal(M.matchHubPreset(M.hideHubItem(M.normalizeHubLayout(M.HUB_DEFAULT), "body")), null);
  assert.equal(M.matchHubPreset(M.resizeHubItem(M.normalizeHubLayout(M.HUB_DEFAULT), "tasks", "s")), null, "크기 하나 달라도 아니다");
  assert.equal(sig(M.applyHubPreset("no-such")), sig(M.HUB_DEFAULT));
});

test("#18 좁은 폭 — L·XL 은 M, S·M 은 그대로, 넓으면 그대로", () => {
  assert.equal(M.effectiveHubSize("l", true), "m");
  assert.equal(M.effectiveHubSize("xl", true), "m");
  assert.equal(M.effectiveHubSize("s", true), "s");
  assert.equal(M.effectiveHubSize("m", true), "m");
  assert.equal(M.effectiveHubSize("xl", false), "xl");
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

test("#20 깨진 JSON 저장본 — 기본 한 벌로 선다", () => {
  const st = fakeStorage(); st.setItem("lively_hub_layout", "{not json");
  withStorage(st, () => {
    const r = M.loadHubLayout(1);
    assert.equal(sig(r.layout), sig(M.HUB_DEFAULT));
  });
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
    M.saveHubLayout(7, M.resizeHubItem(custom, "tasks", "xl"), "project");
    assert.equal(M.loadHubLayout(7).layout.items.find((x) => x.tool === "tasks").size, "xl");
    assert.equal(M.loadHubLayout(8).layout.items.find((x) => x.tool === "tasks").size, "s", "전역은 그대로");
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
  assert.deepEqual(one.items, [{ tool: "sessions", size: "s" }]);
  assert.equal(one.hidden.length, 5);
  assert.equal(M.normalizeHubLayout(l).items.length, 0, "정규화도 전부 숨김을 존중한다(강제로 되살리지 않는다)");
});
