// #4233 「분류체계」 앱 — 맥락 관리의 카테고리 탭을 새 셸의 native 앱으로 뺐다(원준 2026-09-26 «그거 없애버리고 앱으로 따로 빼버리자»).
//
//  V: 잣대(web/lib/taxonomy-map.ts)를 값으로. 사양 엣지 표 한 행 = 단언 하나 이상.
//  S: 배선을 소스로. 앱 표 · 빌트인 패키지 · 렌더러 목록 · 셸 대장 · 라우터 · 사이드바 · 아이콘 두 벌 · CSS 링크 ·
//     맥락 관리에서 걷은 탭 · 옛 주소 · 위키 사이드바 편집 입구.
//  ⚠ 단언을 하나씩 끝까지 센다(첫 실패에서 멈추지 않는다). 수정 전 코드(origin/main)와 변이로 빨간불을 먼저 봤다.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
//  주석은 빼고 본다. 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const cut = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ""; const b = to ? src.indexOf(to, a + 1) : -1; return src.slice(a, b > a ? b : undefined); };

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` (got ${JSON.stringify(got)})`}`);

// ───────────────────────── V. 잣대 (web/lib/taxonomy-map.ts) ─────────────────────────
let lib = null;
try { lib = await import(pathToFileURL(join(root, "public/app/lib/taxonomy-map.js")).href); } catch { /* 없으면 V0 가 빨간불 */ }
ok(!!lib, "V0 잣대가 잎 모듈(lib/taxonomy-map.ts)에 있다");
if (lib) {
  const { countsByCategory, planTaxMap, barPct, fixReasons, fixList, typeCounts, canDeleteCat, isEmptyCat } = lib;
  const C = (id, o = {}) => ({ id, name: `c${id}`, should: "정의", state: "active", group_key: "g1", knowledge_count: 0, proposed_count: 0, ...o });

  // P — 프로젝트 수
  const cnt = countsByCategory([
    { id: 1, category_id: 7, project_count: 5 }, { id: 2, category_id: 7, project_count: 2 }, { id: 3, category_id: 9, project_count: 0 },
  ]);
  eq(cnt.get(7), { lists: 2, projects: 7 }, "P1 분류 7 = 목록 2 · 프로젝트 7");
  eq(cnt.get(9), { lists: 1, projects: 0 }, "P1 분류 9 = 목록 1 · 프로젝트 0");
  const p2 = countsByCategory([{ id: 1, category_id: null, project_count: 4 }, { id: 2, category_id: 0, project_count: 4 }, { id: 3, project_count: 4 }, { id: 4, category_id: 5 }]);
  eq([...p2.keys()], [5], "P2 category_id null · 0 · 없음은 어디에도 안 센다");
  eq(p2.get(5), { lists: 1, projects: 0 }, "P2 project_count 가 없으면 0 으로 센다");
  eq(countsByCategory([{ id: 1, category_id: "7", project_count: "3" }]).get(7), { lists: 1, projects: 3 }, "P3 문자열 id · 수도 숫자로 센다");
  eq([...countsByCategory(null).entries()], [], "P4 목록 null 이면 빈 결과");
  eq([...countsByCategory([]).entries()], [], "P4 목록 [] 이면 빈 결과");

  // M — 전체 지도
  //  이름 순(가 → 나)과 sort 순(g1 → g2)을 일부러 어긋나게 둔다. 같으면 sort 를 무시해도 통과한다(변이로 확인).
  const groups = [{ key: "g2", name: "가", sort: 2 }, { key: "g1", name: "나", sort: 1 }];
  const cats = [
    C(1, { knowledge_count: 5 }), C(2, { knowledge_count: 9 }), C(3, { knowledge_count: 5, name: "a" }),
    C(4, { group_key: "g2", knowledge_count: 1 }),
  ];
  const m1 = planTaxMap(cats, groups, new Map([[1, { lists: 1, projects: 8 }]]));
  eq(m1.map((c) => c.key), ["g1", "g2"], "M1 칸 순서는 묶음 sort 순");
  eq(m1[0].rows.map((r) => r.cat.id), [2, 1, 3], "M1 줄은 지식 많은 순 → 프로젝트 많은 순 → 이름 순");
  const cntEmpty = new Map([[11, { lists: 1, projects: 0 }]]);
  const m2 = planTaxMap([C(10), C(11)], [{ key: "g1", name: "작업", sort: 1 }], cntEmpty);
  eq(m2[0].empty.map((c) => c.id), [10], "M2 지식 0 · 목록 0 은 줄이 아니라 빈 분류");
  eq(m2[0].rows.map((r) => r.cat.id), [11], "M3 경계: 지식 0 · 목록 1(프로젝트 0)은 줄로 선다");
  const m4 = planTaxMap([C(20, { state: "deprecated", knowledge_count: 10 })], [{ key: "g1", name: "작업", sort: 1 }], new Map());
  eq([m4[0].rows.length, m4[0].archived.map((c) => c.id)], [0, [20]], "M4 치운 분류는 줄이 아니라 치운 분류 수");
  const m5 = planTaxMap([C(30, { group_key: null, knowledge_count: 1 }), C(31, { group_key: "zz", knowledge_count: 2 })], [{ key: "g1", name: "작업", sort: 1 }], new Map());
  eq([m5.map((c) => c.key), m5[1].rows.map((r) => r.cat.id)], [["g1", ""], [31, 30]], "M5 묶음 없음 · 모르는 묶음은 맨 끝 «묶음 없음» 칸");
  eq(planTaxMap([C(40, { knowledge_count: 1 })], [{ key: "g1", name: "작업", sort: 1 }], new Map()).map((c) => c.key), ["g1"], "M6 모두 묶음 안이면 «묶음 없음» 칸이 없다");
  eq(planTaxMap([], [], new Map()), [], "M7 분류 0 · 묶음 0 이면 빈 배열");
  eq(planTaxMap(null, null, new Map()), [], "M7 null 이어도 빈 배열");

  // B — 막대 폭
  eq([barPct(0, 10), barPct(1, 1000), barPct(10, 10), barPct(5, 0), barPct(5, 10)], [0, 3, 100, 0, 50], "B1 막대: 0 · 최소 3 · 최댓값 100 · 최댓값 0 이면 0 · 절반 50");

  // F — 손볼 것
  const none = new Map();
  ok(["", "   ", undefined].every((sh) => fixReasons(C(1, { should: sh, knowledge_count: 1 }), none).includes("nodef")), "F1 정의가 비었거나 공백뿐이거나 없으면 «정의 없음»");
  ok(fixReasons(C(1), none).includes("empty") && isEmptyCat(C(1), none), "F2 지식 0 · 목록 0 이면 «빈 분류»");
  ok(!fixReasons(C(1), new Map([[1, { lists: 1, projects: 0 }]])).includes("empty"), "F2b 경계: 지식 0 · 목록 1 은 빈 분류가 아니다");
  eq([fixReasons(C(1, { knowledge_count: 1 }), none), fixReasons(C(1, { knowledge_count: 1, proposed_count: 1 }), none)], [[], ["proposed"]], "F3 제안 0 은 이유 없음, 1 이면 «제안 대기»");
  const f4 = fixList([C(1, { should: "", proposed_count: 2 }), C(2, { knowledge_count: 3 })], none);
  eq([f4.length, f4[0].reasons], [1, ["nodef", "empty", "proposed"]], "F4 이유 셋을 가진 분류 하나 = 손볼 것 1(이유 3)");
  eq(fixList([C(1, { knowledge_count: 4, mismatch_count: 5 })], none), [], "F5 어긋남(mismatch)만 있으면 손볼 것이 아니다");
  eq(fixList([C(1, { state: "deprecated", should: "" })], none), [], "F6 치운 분류는 정의가 없어도 손볼 것이 아니다");

  // T — 지식 유형 수
  eq(typeCounts([{ type: "research" }, { type: "decision" }, { type: "reference" }, { type: "decision" }, { type: "reference" }, { type: null }, { type: "decision" }, { type: "reference" }]),
    [["decision", 3], ["reference", 3], ["research", 1], ["", 1]], "T1 유형은 많은 순, 같으면 key 순, 유형 없음은 같은 수에서 끝");
  eq(typeCounts([]), [], "T2 항목 0 이면 빈 배열");
  eq(typeCounts(null), [], "T2 null 이어도 빈 배열");

  // D — 지우기
  ok(canDeleteCat(C(1), none), "D1 지식 0 · 목록 0 이면 지울 수 있다");
  ok(!canDeleteCat(C(1, { knowledge_count: 1 }), none), "D2 경계: 지식 1 · 목록 0 이면 못 지운다");
  ok(!canDeleteCat(C(1), new Map([[1, { lists: 1, projects: 0 }]])), "D2 경계: 지식 0 · 목록 1 이면 못 지운다");
}

// ───────────────────────── S. 배선 ─────────────────────────
const APPS = read("web/v2/apps.ts");
const appsTable = cut(APPS, "export const APPS", "\n];");
const appRow = (appsTable.split("\n").find((l) => /key:\s*'taxonomy'/.test(l)) || "");
ok(/kind:\s*'native'/.test(appRow) && /route:\s*'taxonomy'/.test(appRow) && /icon:\s*'tags'/.test(appRow) && /title:\s*'분류체계'/.test(appRow),
  "W1 앱 표에 native 앱 「분류체계」(route taxonomy · 아이콘 tags)가 있다");
ok(/tags:\s*ICONS\.tags/.test(APPS) && /'tags'/.test(cut(APPS, "export interface AppDef", "\n}")), "W1 앱 아이콘 유니온 · 선 아이콘 표에 tags");
ok(/ROUTE_ALIAS[^=]*=\s*\{[^}]*categories:\s*'#\/taxonomy'/.test(APPS) && !/categories:\s*'context'/.test(code(APPS)), "W2 새 셸에서 #/categories 는 액자가 아니라 #/taxonomy 로 간다");
let mani = null; try { mani = JSON.parse(read("apps/builtin/taxonomy/lively-app.json")); } catch { /* 빨간불 */ }
ok(!!mani && mani.id === "taxonomy" && mani.system && mani.system.renderer === "taxonomy" && mani.system.route === "#/taxonomy"
  && mani.instances && mani.instances.multiplicity === "single", "W1 빌트인 패키지 apps/builtin/taxonomy(렌더러 taxonomy · 정본 주소 #/taxonomy · single)");
ok(/APP_SYSTEM_RENDERERS = \[[^\]]*"taxonomy"/.test(read("src/apps/manifest.ts")), "W1 서버 렌더러 목록에 taxonomy");
ok(/taxonomy:\s*\{\s*kind:\s*"app",\s*appId:\s*"taxonomy"/.test(read("web/v2/shell-surfaces.ts")), "W1 셸 대장에 taxonomy = 앱");
const MAIN = read("web/v2/main.ts");
const route = code(cut(MAIN, "async function renderRoute", "\nfunction markActive"));
ok(/page === 'taxonomy'/.test(route) && /renderTaxonomyApp\(tab\.center/.test(route) && /ensureSingletonAppInstance\('taxonomy'/.test(route) && /noteAppUse\('taxonomy'\)/.test(route),
  "W1 라우터가 #/taxonomy 를 셸에서 직접 그리고 최근 앱 · 인스턴스를 세운다");
ok(/const aliasTo = aliasRoute\(page, segs\);\s*if \(aliasTo\)/.test(route) && /export function aliasRoute\(/.test(APPS), "W2 라우터가 옛 주소를 새 앱 주소로 넘긴다(#/categories/<id> 는 그 분류로)");
ok(/if \(p === 'taxonomy'\) return 'taxonomy';/.test(read("web/v2/tabs.ts")), "W1 분류체계는 한 창(탭 키 하나)");
const SIDE = read("web/v2/side.ts");
ok(/last\.activeKey\(\) === 'taxonomy'\) \{[^}]*renderTaxonomySection\(\)/.test(SIDE), "W1 사이드바가 분류체계 갈래를 그린다(앱 소유 사이드바)");
const taxSide = code(cut(SIDE, "function renderTaxonomySection(", "\nfunction renderHomeApps"));
ok(/'전체 지도'/.test(taxSide) && /'손볼 것'/.test(taxSide) && /'묶음'/.test(taxSide) && /'정리'/.test(taxSide) && /fitWikiList\(/.test(taxSide) && /빈 분류/.test(taxSide),
  "W1 사이드바: 고정 두 줄 · 「묶음」 이름표와 [정리] · 높이에 맞춘 줄 나누기 · 빈 분류 접기");
ok(taxSide.length > 0 && !/team|담당/.test(taxSide), "W1 사이드바에 팀 · 담당이 없다");
ok(/tags:\s*\{[\s\S]*?frost:[\s\S]*?color:/.test(read("web/v2/glass-icon.ts")), "W1 유리 아이콘 표에 tags");
ok(/^\s*tags:\s*'M/m.test(read("web/v2/icons.ts")), "W1 선 아이콘 표에 tags");
const IDX = read("public/index.html");
ok(/49-v2-ctx\.css">\s*\n<link rel="stylesheet" href="\.\/styles\/49-v2-taxonomy\.css">/.test(IDX) && existsSync(join(root, "public/styles/49-v2-taxonomy.css")), "W1 앱 CSS 가 49-v2-ctx 뒤에 실린다");
const APPJS = code(read("web/v2/taxonomy.ts"));
ok(APPJS.length > 0 && !/merge|합치기/.test(APPJS), "W1 합치기(API 없음)는 단추도 없다");
ok(/canDeleteCat\(/.test(APPJS) && /\/delete'/.test(APPJS) && /state: 'deprecated'/.test(APPJS) && /group: g\.key/.test(APPJS) && /openCategoryForm\(/.test(APPJS),
  "W1 상세: 지우기(빈 분류만) · 치우기 · 묶음 옮기기 · 정의 고치기(폼)가 기존 API 로 간다");
ok(/지식/.test(APPJS) && /'프로젝트'/.test(APPJS) && !/'지'|'프'/.test(APPJS), "W1 막대 이름표는 「지식」 「프로젝트」 온전한 말(지 · 프 줄임 없음)");

// W2 — 맥락 관리에서 걷은 것 · 옛 주소 · 위키 편집 입구
const CTX = code(read("web/context.ts"));
ok(!/key: 'category'/.test(CTX) && !/renderCategoryList/.test(CTX) && !/categoryScreen/.test(CTX), "W2 맥락 관리에 카테고리 탭이 없다");
ok(/sub === 'category' \|\| sub === 'topics' \|\| sub === 'classify'\) \{ openTaxonomyApp\(\); return; \}/.test(CTX), "W2 #/context/category · topics · classify 는 새 앱으로");
//  분류기 옛 딥링크 넘기기(#4194)가 있는 판이면 그것이 새 앱 넘기기보다 먼저여야 한다(없는 판: stage 는 #4194 전이다).
const ciAt = CTX.indexOf("sub2 === 'classifiers'"), taxAt = CTX.indexOf("openTaxonomyApp()");
ok(taxAt > 0 && (ciAt < 0 || ciAt < taxAt), "W2 분류기 옛 딥링크(증류기로)가 있으면 새 앱 넘기기보다 먼저 가로챈다");
const CMAIN = code(read("web/main.ts"));
ok(/page === 'domainmap' \|\| page === 'categories'/.test(CMAIN) && /openTaxonomyApp\(/.test(CMAIN) && !/location\.replace\('#\/context\/topics'\)/.test(CMAIN),
  "W2 클래식 #/categories · #/domainmap 은 새 셸이면 앱으로(클래식 단독이면 종전 전체 페이지)");
ok(/\(window\.top \|\| window\)\.location\.hash = to/.test(read("web/taxonomy-link.ts")), "W2 액자 안 클래식 화면은 셸 창(window.top)을 옮긴다");
const wikiSide = code(cut(SIDE, "function renderWiki(", "\nfunction renderLegacy"));
ok(/v2-ksp-edit', href: '#\/taxonomy'/.test(wikiSide) && /v2-kedit', href: '#\/taxonomy'/.test(wikiSide) && !/#\/categories/.test(wikiSide),
  "W2 위키 사이드바 「분류 · 편집」 · 묶음 ✎ 은 분류체계 앱으로");
ok(/v2-kcat-edit'[\s\S]{0,400}'#\/taxonomy\/' \+ encodeURIComponent\(String\(c\.id\)\)/.test(wikiSide), "W2 위키 분류 줄의 ✎ 는 그 분류를 앱에서 연다");
ok(/openTaxonomyApp\(cat && cat\.id\)/.test(read("web/wiki-category.ts")), "W2 위키 분류 화면의 정의 편집은 그 분류를 앱에서 연다");

console.log(`\n#4233 분류체계 앱: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
