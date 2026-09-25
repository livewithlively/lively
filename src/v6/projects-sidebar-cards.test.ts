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
  assert.match(SIDE, /import \{ planProjCards, type ProjCard \} from '\.\/proj-cards\.js';/);
});
