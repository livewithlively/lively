// [프로젝트] 사이드바 안 1(#4233, 원준 2026-09-25 «4. 안 1. 좋아.») — 엣지 표 P1~P15 · W1.
//  구조(즐겨찾기 · 폴더 › 하위 폴더 › 리스트)는 그대로, 묶음을 보여 주는 방식만 위키 사이드바와 같게 한다.
//  규칙은 순수 모듈(web/v2/proj-cards.ts) 한 벌이고, 화면(web/v2/side.ts renderProjects)은 DOM 바운드라 배선만 소스에서 못박는다.
//  ⚠ web 은 dist 로 굽히지 않는다 — 순수 모듈의 소스를 읽어 TypeScript 로 옮긴 뒤 불러온다(category-groups-sidebar.test.ts 와 같은 방식).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SIDE = readFileSync("web/v2/side.ts", "utf8");
type L = { id: number; name: string; folder_id?: number | null };
type F = { id: number; name: string; parent_id?: number | null; settings?: { kind?: string | null } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any = null;
async function load() {
  if (mod) return mod;
  const js = ts.transpileModule(readFileSync("web/v2/proj-cards.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  return mod;
}

//  기준 나무: 최상위 「제품군」(10) › 하위 「사업」(11) · 「제품」(12 › 「설계」 13) · 보관(14 › 15). 바로 든 리스트 1개. 폴더 밖 리스트 1개.
const FOLDERS: F[] = [
  { id: 10, name: "제품군", parent_id: null },
  { id: 11, name: "사업", parent_id: 10 },
  { id: 12, name: "제품", parent_id: 10 },
  { id: 13, name: "설계", parent_id: 12 },
  { id: 14, name: "보관함", parent_id: 10, settings: { kind: "archive" } },
  { id: 15, name: "보관 아래", parent_id: 14 },
];
const LISTS: L[] = [
  { id: 101, name: "GTM", folder_id: 11 },
  { id: 102, name: "브랜드", folder_id: 11 },
  { id: 201, name: "런칭", folder_id: 12 },
  { id: 202, name: "빈 리스트", folder_id: 12 },
  { id: 203, name: "UI", folder_id: 12 },
  { id: 301, name: "설계 리스트", folder_id: 13 },
  { id: 401, name: "바로 든 것", folder_id: 10 },
  { id: 501, name: "보관 리스트", folder_id: 14 },
  { id: 502, name: "보관 아래 리스트", folder_id: 15 },
  { id: 601, name: "밖", folder_id: null },
];
const OPEN = new Map<number, number>([[101, 3], [102, 0], [201, 5], [202, 0], [203, 2], [301, 1], [401, 4], [501, 9], [502, 9], [601, 1]]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function plan(over: Record<string, unknown> = {}): Promise<any> {
  const m = await load();
  return m.planProjCards({ lists: LISTS, folders: FOLDERS, openByList: OPEN, noneN: 3, favIds: new Set<number>(), sel: "", closed: new Set<string>(), more: new Set<string>(), ...over });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cardOf = (p: any, key: string) => p.groups.flatMap((g: any) => g.cards).find((c: any) => c.key === key);
const ids = (xs: L[]) => xs.map((x) => x.id);

test("P1 즐겨찾기는 리스트 순서로 고정 줄, 기타 수가 함께 온다", async () => {
  const p = await plan({ favIds: new Set([203, 101]) });
  assert.deepEqual(ids(p.favs), [101, 203]);
  assert.equal(p.noneN, 3);
});

test("P2 새 값 비었음: 미분류 0 이면 기타 줄 없음(0) · 즐겨찾기 없음이면 빈 배열", async () => {
  const p = await plan({ noneN: 0, favIds: null });
  assert.equal(p.noneN, 0);
  assert.deepEqual(p.favs, []);
});

test("P3 ★최상위 폴더 = 이름표, 하위 폴더마다 카드, 바로 든 리스트는 「그 밖의 리스트」 카드", async () => {
  const m = await load();
  const p = await plan();
  const top = p.groups.find((g: { folderId: number | null }) => g.folderId === 10);
  assert.equal(top.name, "제품군");
  assert.deepEqual(top.cards.map((c: { key: string; name: string }) => [c.key, c.name]), [["11", "사업"], ["12", "제품"], ["rest:10", m.PROJ_REST_NAME]]);
});

test("P4 하위 폴더가 없는 최상위 폴더는 카드 하나, 이름 「리스트」", async () => {
  const m = await load();
  const p = await plan({ folders: [{ id: 20, name: "혼자", parent_id: null }], lists: [{ id: 1, name: "a", folder_id: 20 }], openByList: new Map([[1, 1]]) });
  assert.deepEqual(p.groups.map((g: { name: string }) => g.name), ["혼자"]);
  assert.deepEqual(p.groups[0].cards.map((c: { key: string; name: string }) => [c.key, c.name]), [["rest:20", m.PROJ_LISTS_NAME]]);
});

test("P5 하위 폴더 안의 하위 폴더 리스트는 그 카드에 트리 순서로 든다(폴더 자신의 리스트 먼저)", async () => {
  const p = await plan();
  const c = cardOf(p, "12");
  assert.deepEqual([...ids(c.rows), ...ids(c.empties)], [201, 203, 301, 202]);
  assert.equal(c.count, 5 + 0 + 2 + 1);
});

test("P6 보관 폴더와 그 아래는 없다", async () => {
  const p = await plan();
  const all = p.groups.flatMap((g: { cards: { rows: L[]; empties: L[]; key: string }[] }) => g.cards);
  assert.ok(!all.some((c: { key: string }) => c.key === "14" || c.key === "15"));
  assert.ok(!all.some((c: { rows: L[]; empties: L[] }) => [...c.rows, ...c.empties].some((l) => l.id === 501 || l.id === 502)));
});

test("P7 열린 프로젝트 0 인 리스트는 줄이 아니라 empties", async () => {
  const c = cardOf(await plan(), "11");
  assert.deepEqual(ids(c.rows), [101]);
  assert.deepEqual(ids(c.empties), [102]);
});

test("P8 고른 리스트(즐겨찾기 아님) — 그 줄이 켜지고 그 줄까지 보이며, 접은 카드여도 편다", async () => {
  const p = await plan({ sel: "L301", closed: new Set(["12"]) });
  const c = cardOf(p, "12");
  assert.equal(p.onKey, "card:301");
  assert.equal(c.forced, 3);
  assert.equal(c.open, true);
  assert.equal(c.full, false);
});

test("P9 고른 리스트가 빈 리스트 — 그 카드를 끝까지 편다", async () => {
  const p = await plan({ sel: "L202" });
  assert.equal(cardOf(p, "12").full, true);
  assert.equal(cardOf(p, "12").forced, 0);
  assert.equal(p.onKey, "card:202");
});

test("P10 ★고른 리스트가 즐겨찾기 — 고정 줄만 켜진다(카드 줄은 안 켜지고 끌어당기지도 않는다)", async () => {
  const p = await plan({ sel: "L203", favIds: new Set([203]), closed: new Set(["12"]) });
  assert.equal(p.onKey, "fav:203");
  const c = cardOf(p, "12");
  assert.equal(c.forced, 0);
  assert.equal(c.open, false);
});

test("P11 폴더 밖 리스트 — 맨 끝 이름표 「폴더 밖」 + 카드 「리스트」", async () => {
  const m = await load();
  const p = await plan();
  const last = p.groups[p.groups.length - 1];
  assert.equal(last.folderId, null);
  assert.equal(last.name, m.PROJ_LOOSE_GROUP);
  assert.deepEqual(last.cards.map((c: { key: string; name: string }) => [c.key, c.name]), [[m.PROJ_ROOT_KEY, m.PROJ_LISTS_NAME]]);
  assert.deepEqual(ids(last.cards[0].rows), [601]);
});

test("P12 새 값 비었음: 폴더 0 · 리스트 0 → 이름표도 카드도 없다 · null 도 같다", async () => {
  assert.deepEqual((await plan({ lists: [], folders: [] })).groups, []);
  assert.deepEqual((await plan({ lists: null, folders: null })).groups, []);
});

test("P13 경계: 리스트가 하나도 없는 하위 폴더도 카드로 선다(rows 0 · empties 0)", async () => {
  const p = await plan({ folders: [...FOLDERS, { id: 16, name: "빈 폴더", parent_id: 10 }] });
  const c = cardOf(p, "16");
  assert.ok(c);
  assert.equal(c.rows.length, 0);
  assert.equal(c.empties.length, 0);
});

test("P14 접은 카드(고른 것 없음)는 닫힌다", async () => {
  const p = await plan({ closed: new Set(["11"]) });
  assert.equal(cardOf(p, "11").open, false);
  assert.equal(cardOf(p, "12").open, true);
});

test("P15 「N개 더」로 편 카드는 full", async () => {
  const p = await plan({ more: new Set(["rest:10"]) });
  assert.equal(cardOf(p, "rest:10").full, true);
  assert.equal(cardOf(p, "11").full, false);
});

test("W1 배선: renderProjects 가 카드 계획 · 줄 나누기 · 고정 줄 · 이름표를 쓰고, 접힘은 계정 저장소에 남는다 · 옛 들여쓰기 트리는 없다", () => {
  const a = SIDE.indexOf("function renderProjects(): void {");
  const b = SIDE.indexOf("\n}\n", a);
  const body = a >= 0 && b > a ? SIDE.slice(a, b) : "";
  assert.ok(body.length > 0, "renderProjects 가 있다");
  assert.match(body, /planProjCards\(\{ lists, folders, openByList, noneN, favIds: favLists, sel: projScopeKey\(\), closed: foldClosed, more: projMore \}\)/);
  assert.match(body, /fitWikiList\(listEl, order, sizes, forced, build\)/);
  assert.match(body, /el\('nav', \{ class: 'v2-kviews', 'aria-label': '즐겨찾기 · 기타' \}/);
  assert.match(body, /class: 'v2-app-group v2-kgroup v2-pgroup'/);
  assert.match(body, /class: 'v2-ksp v2-pcard'/);
  assert.match(body, /saveSet\(FOLD_CLOSED_STORE, foldClosed\)/);
  assert.doesNotMatch(body, /v2-ptf|padding-left:' \+/, "들여쓰기 트리(폴더 줄 · 깊이 들여쓰기)는 걷었다");
  assert.match(SIDE, /import \{ newItemPlan, newRowSlot, planProjCards, type ProjCard \} from '\.\/proj-cards\.js';/);
});

// ── 배포 뒤 격리 리뷰 지적(#4233): 폴더 안에 만들기 · 하위 폴더 링크 닿기 · 깊은 폴더 켜기 ──
test("P16 셋째 층 이하 폴더를 고르면 그 폴더를 담은 카드 머리가 켜진다 · 둘째 층은 자기 카드 · 최상위는 이름표", async () => {
  assert.equal((await plan({ sel: "F13" })).onKey, "folder:12");
  assert.equal((await plan({ sel: "F12" })).onKey, "folder:12");
  assert.equal((await plan({ sel: "F10" })).onKey, "folder:10");
  assert.equal((await plan({ sel: "F999" })).onKey, "folder:999", "모르는 폴더는 그대로(켤 줄이 없을 뿐)");
});

test("N1 ★폴더 안에 새 폴더 — parent_id 를 보낸다 · 폴더가 없으면 종전 그대로 이름만", async () => {
  const m = await load();
  assert.deepEqual(m.newItemPlan("folder", "새것", 10), { path: "/api/ui/v6/project-folders", body: { name: "새것", parent_id: 10 }, moveTo: null });
  assert.deepEqual(m.newItemPlan("folder", "새것", null), { path: "/api/ui/v6/project-folders", body: { name: "새것" }, moveTo: null });
});

test("N2 ★폴더 안에 새 리스트 — 만든 뒤 그 폴더로 옮긴다(moveTo) · 폴더가 없거나 0 이면 옮기지 않는다", async () => {
  const m = await load();
  assert.deepEqual(m.newItemPlan("list", "새 리스트", 12), { path: "/api/ui/v6/project-lists", body: { name: "새 리스트" }, moveTo: 12 });
  assert.equal(m.newItemPlan("list", "x", null).moveTo, null);
  assert.equal(m.newItemPlan("list", "x", 0).moveTo, null);
  assert.equal(m.newItemPlan("list", "x", undefined).moveTo, null);
  assert.deepEqual(m.newItemPlan("proj", "p", 12), { path: "/api/ui/v6/projects", body: { name: "p" }, moveTo: null });
});

test("N3 이름칸 자리 — 최상위 폴더면 이름표 아래, 하위 폴더면 그 카드 안, 모르거나 없으면 구역 맨 위", async () => {
  const m = await load();
  const p = await plan();
  assert.deepEqual(m.newRowSlot(p.groups, 10), { at: "label", folderId: 10 });
  assert.deepEqual(m.newRowSlot(p.groups, 12), { at: "card", key: "12" });
  assert.deepEqual(m.newRowSlot(p.groups, 999), { at: "top" });
  assert.deepEqual(m.newRowSlot(p.groups, null), { at: "top" });
  assert.deepEqual(m.newRowSlot([], 10), { at: "top" });
});

test("W2 배선: [정리]의 새 리스트 · 새 폴더가 그 폴더 id 를 넘기고, 만들기가 newItemPlan 과 폴더 옮기기를 쓰며, 이름칸은 그 자리에 선다", () => {
  assert.match(SIDE, /run: \(\) => openNew\('list', g\.folderId\)/);
  assert.match(SIDE, /run: \(\) => openNew\('folder', g\.folderId\)/);
  assert.match(SIDE, /function openNew\(kind: NewKind = 'proj', folderId: number \| null = null\): void \{ newKind = kind; newIn = folderId;/);
  assert.match(SIDE, /const plan = newItemPlan\(newKind, name, newIn\);\s*const made = await api\(plan\.path, \{ method: 'POST', body: JSON\.stringify\(plan\.body\) \}\)/);
  assert.match(SIDE, /if \(isList && plan\.moveTo != null\) \{\s*try \{\s*await api\('\/api\/ui\/v6\/project-lists\/' \+ made\.id \+ '\/folder', \{ method: 'POST', body: JSON\.stringify\(\{ folder_id: plan\.moveTo \}\) \}\);/);
  assert.match(SIDE, /\.\.\.\(newOpen && slot\.at === 'top' \? \[newProjRow\(\)\] : \[\]\),/);
  assert.match(SIDE, /newOpen && slot\.at === 'label' && slot\.folderId === g\.folderId \? \[newProjRow\(\)\]/);
  assert.match(SIDE, /newOpen && slot\.at === 'card' && slot\.key === c\.key \? \[newProjRow\(\)\]/);
});

test("W3 하위 폴더 카드의 [폴더 보기] 링크는 키보드(포커스)와 터치로 닿는다", () => {
  const CSS = readFileSync("public/styles/47-v2-rail.css", "utf8");
  assert.match(CSS, /\.v2-pcard > \.v2-ksp-h:focus-within \.v2-ksp-edit \{ display: inline-grid; \}/);
  assert.match(CSS, /@media \(hover: none\) \{\s*\.v2-pcard > \.v2-ksp-h \.v2-ksp-edit \{ display: inline-grid;/);
  assert.doesNotMatch(CSS, /\.v2-ptf/, "쓰지 않는 옛 폴더 줄 규칙은 걷었다");
});

// ── PR #1093 격리 리뷰 후속(가벼운 지적) ──
test("W4 폴더 옮기기가 실패하면 오류 표시를 단 토스트가 뜬다(삼키지 않는다)", () => {
  const at = SIDE.indexOf("await api('/api/ui/v6/project-lists/' + made.id + '/folder'");
  assert.ok(at > 0, "옮기기 요청이 있다");
  const tail = SIDE.slice(at, at + 600);
  assert.match(tail, /\} catch \(_\) \{ toast\('리스트는 만들었지만 폴더에 넣지 못했어요\.[^']*', true\); \}/);
});

test("W5 만들기 실패 때 이름칸이 이미 다시 그려졌으면(떨어진 노드) 고치지 않고 새로 그린다", () => {
  const at = SIDE.indexOf("function newProjRow(): HTMLElement {");
  const body = at >= 0 ? SIDE.slice(at, SIDE.indexOf("\n}\n", at)) : "";
  const c = body.indexOf("} catch (err: any) {");
  assert.ok(c > 0, "만들기 catch 가 있다");
  const catchBody = body.slice(c, c + 700);
  assert.match(catchBody, /newErr = '만들지 못했어요 — ' \+ \(err\?\.message \|\| err\);\s*(?:\/\/[^\n]*\n\s*)?if \(!inp\.isConnected\) \{ redraw\(\); return; \}/);
  assert.ok(catchBody.indexOf("if (!inp.isConnected)") < catchBody.indexOf("line.classList.remove('sending')"), "떨어진 노드를 만지기 전에 가른다");
});
