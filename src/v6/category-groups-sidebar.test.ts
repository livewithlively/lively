// 새 셸 위키 사이드바의 묶음 카드(#1631, 2026-09-14) — 엣지 표 W1~W7(scratchpad/spec.md).
//  계기(실측 lively-agent-2-6a84 DB): 묶음 세 칸과 그 안의 분류가 있었는데, 사람이 보는 새 셸 사이드바(web/v2/side.ts)가
//   묶음을 한 번도 안 불러 «상위 카테고리가 아예 없다» 로 보였다. 묶음을 그리는 건 클래식 wiki-side.ts 뿐이었다.
//  규칙은 순수 모듈(web/v2/wiki-cards.ts) 한 벌이고, 화면 모듈은 DOM 바운드라 배선만 소스에서 못박는다(레포 선례: liv-kickoff-chat-view).
//  ⚠ web 은 dist 로 굽히지 않는다 — 순수 모듈의 **소스를 읽어 TypeScript 로 옮긴 뒤** 불러온다(어느 실행 경로에서도 같은 파일을 본다).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SIDE = readFileSync("web/v2/side.ts", "utf8");
type Cat = { id: number; name: string; key: string; knowledge_count?: number; group?: string | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any = null;
async function load() {
  if (mod) return mod;
  const js = ts.transpileModule(readFileSync("web/v2/wiki-cards.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  return mod;
}
const G = [{ key: "g1", name: "콘텐츠" }, { key: "g2", name: "집행" }, { key: "g3", name: "시장" }];
const byCount = (a: Cat, b: Cat) => (b.knowledge_count ?? 0) - (a.knowledge_count ?? 0);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function plan(over: Record<string, unknown>): Promise<any[]> {
  const m = await load();
  return m.planWikiCards({ cats: [], groups: [], searching: false, hit: () => true, rank: byCount, activeCat: 0, closed: new Set<string>(), ...over });
}

test("W1 묶음이 없으면 종전 한 카드(머리 없음, rank 순) · 분류가 없으면 카드도 없다", async () => {
  const cats: Cat[] = [{ id: 1, name: "a", key: "a", knowledge_count: 1 }, { id: 2, name: "b", key: "b", knowledge_count: 5 }];
  const p = await plan({ cats });
  assert.equal(p.length, 1);
  assert.equal(p[0].head, null);
  assert.equal(p[0].key, (await load()).WIKI_SINGLE_KEY);
  assert.deepEqual(p[0].cats.map((c: Cat) => c.id), [2, 1]);
  assert.deepEqual(await plan({ cats: [], groups: G }), []);
});

test("W2 묶음이 있으면 묶음 순서대로 카드 한 장씩 — 빈 묶음도 선다(세 칸이 있다는 것 자체가 보여 줄 구조)", async () => {
  const cats: Cat[] = [{ id: 1, name: "브랜드 자산", key: "brand", group: "g1" }, { id: 2, name: "견적·계약", key: "quote", group: "g2" }];
  const p = await plan({ cats, groups: G });
  assert.deepEqual(p.map((c) => c.head?.name), ["콘텐츠", "집행", "시장"]);
  assert.deepEqual(p.map((c) => c.cats.length), [1, 1, 0]);
  assert.ok(p.every((c) => c.open), "기본은 펼침");
});

test("W3 묶음이 비었거나 없는 묶음을 가리키는 분류는 맨 아래 «묶음을 정해 주세요» 한 장 — 없으면 그 카드도 없다", async () => {
  const cats: Cat[] = [{ id: 1, name: "업무 프로젝트", key: "work" }, { id: 2, name: "고아", key: "orphan", group: "g9" }, { id: 3, name: "브랜드 자산", key: "brand", group: "g1" }];
  const m = await load();
  const p = await plan({ cats, groups: G });
  const last = p[p.length - 1];
  assert.equal(last.key, m.WIKI_LOOSE_KEY);
  assert.equal(last.head.fix, true);
  assert.deepEqual(last.cats.map((c: Cat) => c.id).sort(), [1, 2]);
  assert.ok(!(await plan({ cats: [cats[2]], groups: G })).some((c) => c.key === m.WIKI_LOOSE_KEY));
});

test("W4 찾는 중엔 맞는 분류가 없는 묶음 카드를 빼고, 남은 카드는 접어 뒀어도 편다", async () => {
  const cats: Cat[] = [{ id: 1, name: "브랜드 자산", key: "brand", group: "g1" }, { id: 2, name: "견적·계약", key: "quote", group: "g2" }];
  const p = await plan({ cats, groups: G, searching: true, hit: (c: Cat) => c.name.includes("견적"), closed: new Set(["g:g2"]) });
  assert.deepEqual(p.map((c) => c.head?.name), ["집행"]);
  assert.equal(p[0].open, true);
});

test("W5 접은 카드는 접히고, 지금 보는 분류가 든 카드는 접어 뒀어도 편다", async () => {
  const cats: Cat[] = [{ id: 1, name: "브랜드 자산", key: "brand", group: "g1" }, { id: 2, name: "견적·계약", key: "quote", group: "g2" }];
  const p = await plan({ cats, groups: G, closed: new Set(["g:g1", "g:g2"]), activeCat: 2 });
  assert.equal(p.find((c) => c.key === "g:g1").open, false);
  assert.equal(p.find((c) => c.key === "g:g2").open, true);
});

test("W6 lively-agent-2-6a84 재현(2026-09-14 DB) — 콘텐츠 1 · 집행 3 · 시장 0 · 묶음을 정해 주세요 5", async () => {
  const cats: Cat[] = [
    { id: 1, name: "업무 프로젝트", key: "work-projects" }, { id: 2, name: "리서치·자료", key: "research" },
    { id: 3, name: "사람·조직", key: "people-org" }, { id: 4, name: "운영·행정", key: "ops-admin" }, { id: 5, name: "개인", key: "personal" },
    { id: 6, name: "브랜드 자산", key: "brand-assets", group: "g1" }, { id: 7, name: "인쇄·제작", key: "print-production", group: "g2" },
    { id: 8, name: "견적·계약", key: "quote-contract", group: "g2" }, { id: 9, name: "정산·세금", key: "settlement-tax", group: "g2" },
  ];
  const p = await plan({ cats, groups: G });
  assert.deepEqual(p.map((c) => [c.head?.name, c.cats.length]), [["콘텐츠", 1], ["집행", 3], ["시장", 0], ["묶음을 정해 주세요", 5]]);
});

test("W7 배선 — 새 셸 사이드바가 묶음을 부르고 이 계획대로 그린다(이 배선이 없어서 사람 눈엔 묶음이 없었다)", () => {
  assert.match(SIDE, /import \{ planWikiCards[^}]*\} from '\.\/wiki-cards\.js';/, "사이드바가 카드 계획 모듈을 안 쓴다");
  assert.match(SIDE, /api\('\/api\/ui\/category-groups'\)/, "사이드바가 묶음을 한 번도 부르지 않는다");
  const a = SIDE.indexOf("function renderWiki(): void {");
  const b = SIDE.indexOf("function renderLegacy(): void {");
  assert.ok(a >= 0 && b > a, "renderWiki 를 찾지 못했다 — 검사가 아무것도 안 본다");
  const body = SIDE.slice(a, b);
  assert.match(body, /loadWikiGroups\(\);/, "renderWiki 가 묶음을 불러오지 않는다");
  assert.match(body, /planWikiCards\(\{ cats: all, groups: wikiGroups \|\| \[\]/, "renderWiki 가 카드 계획을 안 쓴다");
});

// ── 첫 화면 줄 나누기(#4233, 원준 2026-09-25) — 엣지 표 A1~A11(scratchpad/spec-4233-wiki-alloc.md) ──
//  원준: "3개 카테고리는 전부 다 보이는 게 맞고 · 안에 하위 카테고리 일부라도 보이게 · 처음 들어왔을 때 스크롤 없이 한 눈에".
//  높이 → 줄 수 예산은 화면(side.ts fitWikiList)이 재고, 나누는 규칙은 순수 함수 한 벌(allocWikiRows)이다.
const SIZES = { g1: 18, g2: 5, g3: 2 };   // dev 실측(2026-09-25) — 문서가 있는 분류 수: 작업 18 · 주고받은 것 5 · 자료 2
const ORDER = ["g1", "g2", "g3"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function alloc(over: Record<string, any>): Promise<Record<string, number>> {
  return (await load()).allocWikiRows({ sizes: SIZES, order: ORDER, budget: 0, ...over });
}
const total = (a: Record<string, number>) => Object.values(a).reduce((x, y) => x + y, 0);

test("A1 1440×900(예산 13) — 작업 6 · 주고받은 것 5(전부) · 자료 2(전부): 작은 묶음은 끝까지, 큰 묶음은 5줄 이상", async () => {
  assert.deepEqual(await alloc({ budget: 13 }), { g1: 6, g2: 5, g3: 2 });
});

test("A2 작은 창(예산 9) — 채우면 큰 묶음이 2줄이 되므로 채우지 않는다: 5 · 2 · 2", async () => {
  assert.deepEqual(await alloc({ budget: 9 }), { g1: 5, g2: 2, g3: 2 });
});

test("A3 예산이 최소치보다 작으면 최소치(묶음마다 2줄)를 그대로 — 묶음이 아예 안 보이는 것보다 넘치는 게 낫다", async () => {
  assert.deepEqual(await alloc({ budget: 3 }), { g1: 2, g2: 2, g3: 2 });
});

test("A4 예산이 넉넉해도 분류 수를 넘지 않는다", async () => {
  assert.deepEqual(await alloc({ budget: 100 }), { g1: 18, g2: 5, g3: 2 });
});

test("A5 지금 보는 분류는 가려지지 않는다 — 큰 묶음 11번째를 보는 중이면 그 묶음은 11줄 이상(작은 묶음 채우기도 그 밑으론 안 뺏는다)", async () => {
  const a = await alloc({ budget: 13, forced: { g1: 11 } });
  assert.ok(a.g1 >= 11, `g1=${a.g1}`);
  assert.deepEqual(a, { g1: 11, g2: 2, g3: 2 });
});

test("A6 펼친 묶음이 없으면 빈 결과", async () => {
  assert.deepEqual(await alloc({ order: [], budget: 13 }), {});
});

test("A7 분류 0개 · 1개 묶음은 그 수만큼 — 최소 2줄을 억지로 채우지 않는다", async () => {
  assert.deepEqual(await alloc({ sizes: { a: 0, b: 1 }, order: ["a", "b"], budget: 10 }), { a: 0, b: 1 });
});

test("A8 경계 — 작은 묶음이 정확히 3개 숨으면 채우고, 4개 숨으면 안 채운다", async () => {
  //  큰 묶음 30(넉넉) · 작은 묶음 5 → 최소 2 뒤 3개 숨음 → 채움
  assert.deepEqual(await alloc({ sizes: { big: 30, s: 5 }, order: ["big", "s"], budget: 12 }), { big: 7, s: 5 });
  //  작은 묶음 6 → 4개 숨음 → 안 채움
  assert.deepEqual(await alloc({ sizes: { big: 30, s: 6 }, order: ["big", "s"], budget: 12 }), { big: 10, s: 2 });
});

test("A9 경계 — 채운 뒤 큰 묶음이 정확히 5면 채우고, 4면 안 채운다", async () => {
  //  예산 10: 최소 2·2 → 남은 6 은 큰 묶음(8) → 8·2 → 3개 숨은 작은 묶음을 채우면 큰 묶음 5 → 채움
  assert.deepEqual(await alloc({ sizes: { big: 20, s: 5 }, order: ["big", "s"], budget: 10 }), { big: 5, s: 5 });
  //  예산 9: → 7·2 → 채우면 4 → 안 채움
  assert.deepEqual(await alloc({ sizes: { big: 20, s: 5 }, order: ["big", "s"], budget: 9 }), { big: 7, s: 2 });
});

test("A10 동률 — 남은 수가 같은 두 묶음에 한 줄이 남으면 앞 묶음이 받는다(합은 예산을 안 넘는다)", async () => {
  const a = await alloc({ sizes: { x: 10, y: 10 }, order: ["x", "y"], budget: 5 });
  assert.deepEqual(a, { x: 3, y: 2 });
  assert.equal(total(a), 5);
});

test("A11 배선 — 가로 탭·«N개 더 보기» 캡이 사라지고, 고정 두 줄·줄 나누기·편집 입구가 선다", () => {
  const a = SIDE.indexOf("function renderWiki(): void {");
  const b = SIDE.indexOf("function renderLegacy(): void {");
  assert.ok(a >= 0 && b > a, "renderWiki 를 찾지 못했다 — 검사가 아무것도 안 본다");
  const body = SIDE.slice(a, b);
  assert.match(SIDE, /import \{ planWikiCards, allocWikiRows \} from '\.\/wiki-cards\.js';/);
  assert.match(SIDE, /allocWikiRows\(\{ sizes, order, budget, forced \}\)/, "높이로 정한 예산을 규칙 함수에 넘기지 않는다");
  assert.match(body, /fitWikiList\(listEl, order, sizes, forced, build\);/, "renderWiki 가 첫 화면 맞춤을 안 한다");
  assert.doesNotMatch(SIDE, /WIKI_CARD_MAX|wikiViewRow|'최근', '최근/, "옛 가로 뷰 줄·카드 캡이 남아 있다");
  assert.match(body, /fixRow\('#\/knowledge', 'wiki', '전체 문서'/, "고정 줄 「전체 문서」가 없다");
  assert.match(body, /fixRow\('#\/knowledge\?indexed=1', 'pin', '인덱스'/, "고정 줄 「인덱스」가 없다");
  //  #4233(원준 2026-09-26) — 편집 입구의 목적지가 맥락 관리(#/categories)에서 「분류체계」 앱(#/taxonomy)으로 바뀌었다.
  assert.equal((body.match(/href: '#\/taxonomy'/g) ?? []).length, 2, "분류 편집 입구(소제목 [편집] · 묶음 ✎) 두 곳");
  assert.doesNotMatch(body, /#\/categories/, "맥락 관리의 옛 카테고리 주소로 보내지 않는다");
  const css = readFileSync("public/styles/47-v2-rail.css", "utf8");
  assert.match(css, /\.v2-ksp \{ flex: none;/, "묶음 카드가 목록 칸 안에서 눌리지 않게(flex: none) — 행이 반쯤 잘리던 원인");
});
