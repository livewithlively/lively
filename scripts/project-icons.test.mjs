// #4233 프로젝트 관련 작은 아이콘 다시 그리기(원준 2026-10-04 「project-icons-all-picker」에서 고른 18문항).
//  그림은 web/lib/icon-paths.ts 한 벌이다. 이 시험은 고른 그림이 그 표에 있고, 문항마다 고른 자리가 그 이름을 부르는지 본다.
//  그릴 수 있는 것(작은 부품 · 클래식 아이콘 모듈 · 대시보드 아이콘 모듈)은 값으로 불러 나온 path 를 본다.
//  큰 화면 함수 안의 자리는 줄의 글(이름표)로 자리를 찾아 그 줄이 부르는 그림 이름을 본다.
//
//  사양 · 엣지 표(spec-failfirst):
//   V1 고른 그림 일곱(projMini · projNone · projNew · sessMove · projGroup · sessNew · board)이 표에 있고 path 가 고른 것과 글자까지 같다
//   V2 프로젝트 그림(proj)은 5차 3안 그대로다. 쓰지 않게 된 group · folderRows 는 표에 없다
//   R1 크기 규칙(Q2): projGlyph(px) 는 13px 이하에서 작은 과녁(projMini), 14px 이상에서 과녁(proj)
//   R2 엣지: 모르는 크기(NaN)는 과녁, 0 은 작은 과녁. 경계 값은 PROJ_MINI_MAX_PX = 13 한 곳에 있다
//   Q1 홈 사이드바 프로젝트 카드 머리: 펼침과 닫힘 모두 과녁, 「프로젝트 없음」 카드는 점선 원
//   Q2 칩: 홈 고정 세션 둘째 줄(11px) · 프로젝트 단추(12px) · 세션 목록 사이드바 줄(16px) · 통합검색(13 · 15px) · 탭(15px) ·
//      휴지통 · 지난 세션 표(15px) · 가이드 그림(17px)이 크기 규칙을 따른다(값으로 부른 통합검색 · 휴지통 부품의 path 를 본다)
//   Q3 「프로젝트 없음」 · 「기타 (미분류)」 = 점선 원(projNone): 사이드바 · 휴지통 · 클래식 기타 폴더(값으로 부른다)
//   Q4 우측 사이드바 「프로젝트」 = 프로젝트 과녁(원준 2026-10-05 «독에는 아이콘은 왜 안 바꿨나»). 부품 표의 이름은 proj 이고
//      glyphAt(이름, px) 가 13px 이하 자리에서 projMini 로 바꾼다: 탭 머리(14) · 탭 목록(13) · 칸에 넣기(15) ·
//      칸 머리와 크게 보기 머리(13) · 빈 화면(26). 독 타일 · ＋ 앱 서랍(#4443)은 부품 표의 이름 그대로(큰 타일 = proj). 옛 projtask 는 표에도 부르는 곳에도 없다
//   Q4b 앱 = 각진 사각 넷(apps): 독 [모든 앱] · 앱 칸의 줄. 둥근 사각(grid)은 자료의 「아이콘으로 보기」에만 남는다
//   Q5 보드로 열기 · 보드에서 보기 · [보드] = board
//   Q6 진척시킨 프로젝트 = 과녁, 진척시킨 태스크 = 원 안의 체크 그대로(값으로 읽는다)
//   Q7 홈 사이드바 「프로젝트로 묶기」 토글 = projGroup
//   Q8 사이드바 새 프로젝트 줄 = projNew(새 폴더는 폴더, 새 리스트는 리스트)
//   Q9 세션 옮기기 = sessMove(속 빈 굵은 오른쪽 화살표, 원준 2026-10-04 «프로젝트 느낌은 빼고 옮기기만»). 칸(탭) 옮기기는 moveto 그대로
//      M1 옛 projMove 는 표에도 부르는 곳에도 없다 · M2 sessMove 는 얇은 화살표(goto)와 다른 그림이다
//   Q10 새 세션 = sessNew: 사이드바 [＋](값으로 부른다) · 우클릭 두 줄 · 탭 · 우측 사이드바 문 · 대시보드 · 클래식 · 프로젝트 화면
//   Q11 폴더 = 둥근 선 폴더(ICONS.folder), 정해 둔 색은 선 색(클래식 · 대시보드 팝오버를 값으로 부른다)
//   Q12 리스트 = 점과 줄 셋(ICONS.list), 색은 선 색, 이모지는 그대로(대시보드 · 클래식 · 일괄 · 사실 칩 · 분류체계)
//   Q13 즐겨찾기 = 별(ICONS.star), 켠 것은 안을 채운다(클래식 · 대시보드를 값으로 부른다). ⭐ 이모지가 없다
//   Q14 프로젝트 자료 = 폴더(세션 화면 [자료] · 프로젝트 화면 공유 폴더 · 폰 단추)
//   Q15 지난 세션 「프로젝트」 열에 Q2 그림이 선다
//   Q16 세션 옮기기(프로젝트 고르개) 줄에 Q2 그림이 서고, 떼기 줄은 점선 원
//   A  옛 그림이 그 자리에 남아 있지 않다(Lucide 폴더 · 채운 클래식 폴더 · 체크 두 줄 리스트 · 터미널과 더하기)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " : " + detail : ""}`); } };
const transpile = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = async (js) => import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const cut = (src, start, end) => { const i = src.indexOf(start); if (i < 0) return ""; const j = src.indexOf(end, i + start.length); return j < 0 ? src.slice(i) : src.slice(i, j + end.length); };
const lineOf = (src, needle) => src.split("\n").filter((l) => l.includes(needle)).join("\n");

// ── 표를 값으로 읽는다 ──
const PATHS_SRC = read("web/lib/icon-paths.ts");
const paths = await load(transpile(PATHS_SRC)).catch(() => ({}));
const ICONS = paths.ICONS || {};
const has = (k) => Object.prototype.hasOwnProperty.call(ICONS, k);
const projGlyph = typeof paths.projGlyph === "function" ? paths.projGlyph : null;

// ── 그리기 흉내(값으로 부르는 모듈에 넘긴다) ──
class N {
  constructor(tag, attrs) { this.tag = tag; this.attrs = { ...(attrs || {}) }; this.kids = []; }
  append(...k) { for (const x of k.flat()) if (x != null && x !== false) this.kids.push(x); }
  appendChild(x) { this.kids.push(x); return x; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  get classList() { const n = this; return { add: (c) => { n.attrs.class = ((n.attrs.class || "") + " " + c).trim(); } }; }
}
const mk = (tag, attrs, ...kids) => { const n = new N(tag, attrs); n.append(...kids); return n; };
const dOf = (n) => { const p = n && n.kids && n.kids.find((k) => k && k.tag === "path"); return p ? p.attrs.d : undefined; };
const pathOf = (n) => (n && n.kids ? n.kids.find((k) => k && k.tag === "path") : undefined);
globalThis.__stub = { el: mk, sv: mk };
globalThis.__paths = paths;
const loadWithStubs = async (rel) => {
  const src = read(rel);
  if (!src) return null;
  const js = transpile(src)
    .replace(/import \{[^}]*\} from '\.\.\/core\.js';/, "const { el, sv } = globalThis.__stub;")
    .replace(/import \{[^}]*\} from '\.\.\/lib\/icon-paths\.js';/, "const { ICONS, projGlyph, iconPath } = globalThis.__paths;");
  return load(js).catch((e) => { console.error(`  (${rel} 를 불러오지 못했다: ${e.message})`); return null; });
};

// ── V. 고른 그림 ──
const PICKED = {
  projMini: "M11 4.5a8.5 8.5 0 1 0 8.5 8.5 M11 11.6a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8z M12.6 11.4 20.5 3.5 M17 3.5V7h3.5",
  projNone: "M13.11 3.57A8.5 8.5 0 0 1 17.17 5.26 M18.74 6.83A8.5 8.5 0 0 1 20.43 10.89 M20.43 13.11A8.5 8.5 0 0 1 18.74 17.17 M17.17 18.74A8.5 8.5 0 0 1 13.11 20.43 M10.89 20.43A8.5 8.5 0 0 1 6.83 18.74 M5.26 17.17A8.5 8.5 0 0 1 3.57 13.11 M3.57 10.89A8.5 8.5 0 0 1 5.26 6.83 M6.83 5.26A8.5 8.5 0 0 1 10.89 3.57 M12 11.3a.7.7 0 1 0 0 1.4a.7.7 0 1 0 0-1.4z",
  projNew: "M6.7 3.45 A5.95 5.95 0 1 0 12.65 9.4 M6.7 8.42 A0.98 0.98 0 1 0 6.7 10.38 A0.98 0.98 0 1 0 6.7 8.42 Z M7.82 8.28 L13.35 2.75 M10.9 2.75 L10.9 5.2 L13.35 5.2 M19 15v7 M15.5 18.5h7",
  sessMove: "M4 9h9V5l7 7-7 7v-4H4z",
  projGroup: "M5.18 1.61 A4.93 4.93 0 1 0 10.11 6.54 M5.18 5.728 A0.812 0.812 0 1 0 5.18 7.352 A0.812 0.812 0 1 0 5.18 5.728 Z M6.108 5.612 L10.69 1.03 M8.66 1.03 L8.66 3.06 L10.69 3.06 M11 17h10 M11 21h7 M5.2 13.5V19H8",
  sessNew: "M6.162 15.6 A7.02 7.02 0 1 0 3.12 12.558 L1.56 17.16 Z M19 14.5v7 M15.5 18h7",
  board: "M4 5h4v14H4z M10 5h4v8h-4z M16 5h4v11h-4z",
};
for (const [k, d] of Object.entries(PICKED)) ok(has(k) && ICONS[k] === d, `V1 고른 그림 ${k} 가 표에 있고 고른 path 와 같다`, has(k) ? String(ICONS[k]).slice(0, 30) : "표에 없음");
for (const [k] of Object.entries(PICKED)) ok(has(k) && !/[<>"]/.test(ICONS[k]) && /^M/.test(ICONS[k]), `V1 ${k} 는 선 하나의 path(d) 글이다(마크업 · 채움 없음)`);
ok(ICONS.proj === "M11 4.5a8.5 8.5 0 1 0 8.5 8.5 M11 9.3a3.7 3.7 0 1 0 3.7 3.7 M11 12.3a.7.7 0 1 0 0 1.4a.7.7 0 1 0 0-1.4z M12.3 11.7 21 3 M16.5 5v2.5H19 M19 2.5V5h2.5", "V2 프로젝트 그림(proj)은 5차 3안(과녁에 꽂힌 화살, 깃 두 겹) 그대로");
ok(!has("group") && !has("folderRows"), "V2 쓰지 않게 된 group · folderRows 가 표에 없다", ["group", "folderRows"].filter(has).join(","));

// ── R. 크기 규칙 ──
{
  const g = (px) => { try { return projGlyph ? projGlyph(px) : "!none"; } catch { return "!throw"; } };
  ok(typeof projGlyph === "function" && paths.PROJ_MINI_MAX_PX === 13, "R1 크기 규칙 projGlyph 와 경계 PROJ_MINI_MAX_PX = 13 이 표 모듈에 있다");
  for (const px of [11, 12, 13]) ok(g(px) === "projMini", `R1 ${px}px 자리는 작은 과녁(projMini)`, g(px));
  for (const px of [14, 15, 16, 17]) ok(g(px) === "proj", `R1 ${px}px 자리는 과녁(proj)`, g(px));
  ok(g(0) === "projMini" && g(Number.NaN) === "proj", "R2 0 은 작은 과녁, 모르는 크기(NaN)는 과녁", g(0) + "," + g(Number.NaN));
  ok(has(g(11)) && has(g(16)), "R2 규칙이 돌려주는 이름은 둘 다 표에 있다");
}

const SIDE = read("web/v2/side.ts"), CTX = read("web/v2/ctx-shell.ts"), PANES = read("web/v2/panes.ts"), PTASK = read("web/v2/panes-tasks.ts");
const BINS = read("web/v2/bins.ts"), OMNI = read("web/v2/omni.ts"), TABS = read("web/v2/tabs.ts"), PICK = read("web/v2/proj-pick.ts");

// ── Q1 홈 카드 머리 ──
{
  const head = cut(SIDE, "function projGrpHead(", "\n}\n");
  ok(/glyph\(g\.id \? 'proj' : 'projNone', 'v2-pg-ic'\)/.test(head) && !/folder-open|glyph\('folder'/.test(head), "Q1 홈 프로젝트 카드 머리 = 과녁(펼침 · 닫힘 같은 그림), 「프로젝트 없음」 카드 = 점선 원");
}

// ── Q2 칩: 값으로 부르는 부품 ──
let omniIcon = null, binProjIcon = null;
{
  const i = OMNI.indexOf("const KIND_PATH"), j = OMNI.indexOf("\nconst icon = ", i), k = j < 0 ? -1 : OMNI.indexOf(")));\n", j);
  try { if (i >= 0 && k > j) omniIcon = new Function("sv", "ICONS", "projGlyph", transpile(OMNI.slice(i, k + 5)) + "\nreturn icon;")(mk, ICONS, projGlyph); } catch (e) { console.error("  (통합검색 icon 을 부르지 못했다: " + e.message + ")"); }
  ok(typeof omniIcon === "function", "Q2 통합검색의 종류 그림(icon)을 값으로 부를 수 있다");
  if (omniIcon) {
    //  #4530 안 A — 종류 칩은 탭(글자)이 됐다. 13px 자리는 미리보기 칸의 종류 이름표(v2-opv-kic)다.
    ok(dOf(omniIcon("proj", "v2-opv-kic")) === ICONS.projMini, "Q2 통합검색 미리보기의 종류 이름표(13px)의 프로젝트 = 작은 과녁", String(dOf(omniIcon("proj", "v2-opv-kic"))).slice(0, 24));
    ok(dOf(omniIcon("proj", "v2-omni-kic")) === ICONS.proj, "Q2 통합검색 결과 줄(15px)의 프로젝트 = 과녁");
    ok(dOf(omniIcon("know", "v2-omni-kic")) === ICONS.wiki && dOf(omniIcon("proj", "v2-omni-kic", [ICONS.clock])) === ICONS.clock, "Q2 다른 종류와 따로 넘긴 그림(최근 검색의 시계)은 그대로");
  }
  const b = BINS.indexOf("const BIN_PROJ_PX"), e = b < 0 ? -1 : BINS.indexOf("\n", BINS.indexOf("const projIcon", b));
  try { if (b >= 0 && e > b) binProjIcon = new Function("sv", "ICONS", "projGlyph", transpile(BINS.slice(b, e + 1)) + "\nreturn projIcon;")(mk, ICONS, projGlyph); } catch (er) { console.error("  (휴지통 projIcon 을 부르지 못했다: " + er.message + ")"); }
  ok(typeof binProjIcon === "function", "Q2 휴지통 · 지난 세션의 프로젝트 그림(projIcon)을 값으로 부를 수 있다");
  if (binProjIcon) {
    ok(dOf(binProjIcon()) === ICONS.proj && dOf(binProjIcon(true)) === ICONS.proj, "Q2 휴지통 · 지난 세션(15px)의 프로젝트 = 과녁");
    ok(dOf(binProjIcon(false)) === ICONS.projNone, "Q3 휴지통 · 지난 세션의 「프로젝트 없음」 = 점선 원");
  }
  ok(!/folderIcon\(/.test(BINS), "Q2 휴지통에 옛 폴더 그림 부품(folderIcon)이 남아 있지 않다");
  const app = cut(SIDE, "function appRowEl(", "\n}\n");
  ok(/glyph\(inst\.project && !inst\.project\.self \? projGlyph\(11\) : 'projNone', 'v2-app-inst-ask-ic'\)/.test(app), "Q2 홈 고정 세션 둘째 줄(11px) = 작은 과녁, 프로젝트가 없으면 점선 원");
  ok(/glyph\(projGlyph\(12\), 'v2-app-inst-project-ic'\)/.test(app), "Q2 홈 고정 세션의 프로젝트 단추(12px) = 작은 과녁");
  ok(/l\.pid \? glyph\(projGlyph\(16\), 'v2-ptl-ic'\) : glyph\('projNone', 'v2-ptl-ic'\)/.test(cut(SIDE, "function renderSessions(", "\n}\n")), "Q2 세션 목록 사이드바의 프로젝트 줄(16px) = 과녁, 없으면 점선 원");
  ok(/k\.startsWith\('p:'\) \? \[ICONS\.proj\]/.test(TABS) && !/k\.startsWith\('p:'\) \? \[ICONS\.folder\]/.test(TABS), "Q2 탭(15px)의 프로젝트 = 과녁");
  ok(/guideIcon\('proj', 'gd-node-ic'\), el\('b', \{ text: '프로젝트: 가을 메뉴 출시' \}\)/.test(read("web/guide/figures.ts")), "Q2 가이드 그림의 「프로젝트: 가을 메뉴 출시」(17px) = 과녁");
}

// ── Q3 프로젝트 없음 · 기타 ──
let pjv = null, dash = null;
{
  ok(/glyph\('projNone', 'v2-ptl-ic'\), el\('span', \{ class: 'n', text: NO_PROJECT_NAME \}\)/.test(SIDE), "Q3 사이드바 「기타 (미분류)」 줄 = 점선 원");
  ok(/glyph\(p \? 'proj' : 'projNone', 'v2-pj-ic'\)/.test(cut(SIDE, "function projRow(", "\n}\n")), "Q3 프로젝트 트리의 「프로젝트 없는 세션」 줄 = 점선 원, 프로젝트 줄 = 과녁");
  pjv = await loadWithStubs("web/projects/icons.ts");
  ok(!!pjv && typeof pjv.pjvBundleIcon === "function", "Q3 클래식 아이콘 모듈을 값으로 부를 수 있다");
  if (pjv && pjv.pjvBundleIcon) {
    const none = pjv.pjvBundleIcon(null, "none"), p = pathOf(none);
    ok(dOf(none) === ICONS.projNone && p && p.attrs.fill === "none" && !p.attrs["stroke-dasharray"], "Q3 클래식 「기타 (미분류)」 = 점선 원(projNone, 그린 점선이라 dasharray 를 따로 두지 않는다)", String(dOf(none)).slice(0, 24));
  }
}

// ── Q4 우측 사이드바 「프로젝트」 = 프로젝트 과녁(크기에 맞춰 작은 과녁) ──
{
  const PARTS = read("web/v2/panes-parts.ts"), KIT = read("web/v2/panes-kit.ts"), DOCK = read("web/v2/pane-dock.ts");
  ok(/\{ type: 'tasks', name: '프로젝트', icon: 'proj'[,\s]/.test(PARTS), "Q4 우측 사이드바 부품 표의 「프로젝트」 그림 이름 = proj");
  const glyphAt = typeof paths.glyphAt === "function" ? paths.glyphAt : null;
  ok(!!glyphAt && glyphAt("proj", 13) === "projMini" && glyphAt("proj", 11) === "projMini", "Q4 glyphAt: proj 를 13px 이하 자리에서 그리면 작은 과녁(projMini)");
  ok(!!glyphAt && glyphAt("proj", 14) === "proj" && glyphAt("proj", 15) === "proj" && glyphAt("proj", 26) === "proj", "Q4 glyphAt: 14px 이상 자리에선 과녁(proj)");
  ok(!!glyphAt && glyphAt("wiki", 13) === "wiki" && glyphAt("folder", 11) === "folder" && glyphAt("apps", 26) === "apps", "Q4 glyphAt: proj 아닌 이름은 크기와 상관없이 그대로");
  ok(!!glyphAt && glyphAt("proj", NaN) === "proj", "Q4 glyphAt 엣지: 모르는 크기(NaN)는 과녁(projGlyph 와 같은 규칙)");
  let pnIconName = null;
  { const i = KIT.indexOf("const PN_NAME"), j = KIT.indexOf("\n", KIT.indexOf("export const pnIconName", i));
    try { if (i >= 0 && j > i) pnIconName = new Function(transpile(KIT.slice(i, j + 1).replace("export const pnIconName", "const pnIconName")) + "\nreturn pnIconName;")(); } catch { /* 빨간불 */ } }
  ok(typeof pnIconName === "function" && pnIconName("proj") === "proj" && pnIconName("projMini") === "projMini" && has("proj") && has("projMini"), "Q4 우측 사이드바 이름 proj · projMini 가 표의 그 그림으로 닿는다");
  const lead = PANES.split("\n").filter((l) => l.includes("'pn-tab-lead'") || l.includes("lead.replaceChildren("));
  ok(lead.length === 2 && lead.every((l) => /pnIcon\(glyphAt\(ic, 14\), 'pn-i sm'\)/.test(l)), "Q4 탭 머리(그릴 때 · 다시 그릴 때) = glyphAt(ic, 14)", lead.map((l) => l.trim().slice(0, 60)).join(" | "));
  ok(/pnIcon\(glyphAt\(tabIcon\(t\), 13\), 'pn-i sm'\)/.test(PANES), "Q4 탭 목록 줄(13px) = glyphAt(tabIcon(t), 13)");
  //  #4443(원준 10-05 «① 앱 서랍 + ② 의 키보드»): [＋] 는 13px 줄이 아니라 독 ⊞ 와 같은 타일 격자 — 독과 같은 큰 과녁.
  ok(/more: has\(d\.type\), ic: \(\) => dockTile\(d\.icon, d\.type\)/.test(PANES), "Q4 ＋ 앱 서랍 = 독과 같은 타일 — 부품 표의 이름(proj)을 64 칸 타일로(큰 과녁)");
  const adds = cut(PANES, "const adds: CtxRow[] = PART_DEFS", "}));");
  ok(/label: d\.name, icon: pnIconName\(glyphAt\(d\.icon, 15\)\)/.test(adds) && !/'layers'/.test(adds), "Q4 「칸에 넣기」 줄(15px) = 탭과 같은 이름을 glyphAt(d.icon, 15) 로(「프로젝트」가 layers 로 떨어지지 않는다)");
  ok(!/pnIcon\((ic|d\.icon|tabIcon\(t\)), /.test(PANES), "Q4 우측 사이드바 부품 그림을 크기 규칙 없이 그리는 자리가 없다");
  ok((PTASK.match(/pnIcon\(projGlyph\(13\), 'pn-i sm'\)/g) || []).length === 2 && /class: 'pn-tk-head-row' \}, pnIcon\(projGlyph\(13\)/.test(PTASK) && /class: 'pj-modal-h' \}, pnIcon\(projGlyph\(13\)/.test(PTASK), "Q4 「프로젝트」 칸 머리 · 크게 보기 머리(13px) = 작은 과녁(projGlyph(13))");
  ok((PTASK.match(/class: 'pn-empty' \}, pnIcon\(projGlyph\(26\), 'pn-i big'\)/g) || []).length === 2, "Q4 「프로젝트」 칸 빈 화면 둘(26px) = 과녁(projGlyph(26))");
  ok(/glyph: d\.icon,/.test(PANES) && /tile\(app\.glyph, appColor\(it\.type\)\)/.test(DOCK), "Q4 독 타일은 부품 표의 이름(proj)을 그대로 그린다(64 칸 타일이라 큰 과녁)");
  {
    const files = [];
    const walk = (dir) => { for (const n of readdirSync(join(root, dir))) { const p = dir + "/" + n; if (statSync(join(root, p)).isDirectory()) walk(p); else if (/\.ts$/.test(n)) files.push(p); } };
    walk("web");
    const callers = files.filter((f) => /['"]projtask['"]/.test(read(f)));
    ok(!has("projtask") && callers.length === 0, "Q4 옛 projtask(폴더 안 태스크)는 표에도 부르는 곳에도 없다", callers.join(","));
  }
  // Q4b 앱 = 각진 사각 넷
  ok(/class: 'pn-dock-ic' \}, tile\('apps', 'apps'\)/.test(DOCK) && !/tile\('grid'/.test(DOCK), "Q4b 독 [모든 앱] = apps(둥근 사각 grid 가 아니다)");
  ok(/\{ type: 'apps', name: '[^']+', icon: 'apps'/.test(PARTS) && /pnIcon\(hasUi \? 'apps' : 'chat', 'pn-i'\)/.test(PARTS) && !/'grid'/.test(PARTS), "Q4b 앱 칸의 탭과 앱 줄 = apps");
  ok(/view === 'icon' \? 'rows' : 'grid'/.test(read("web/v2/panes-files.ts")), "Q4b 자료의 「아이콘으로 보기」 단추는 grid 그대로(앱 뜻이 아니다)");
}

// ── Q5 보드 ──
{
  ok(/\{ label: '보드로 열기', icon: 'board'/.test(cut(CTX, "function projectMenu(", "\n}\n")), "Q5 우클릭 「보드로 열기」 = board");
  ok(/label: '보드에서 보기', icon: 'board'/.test(PTASK), "Q5 우측 사이드바 「보드에서 보기」 = board");
  ok(/pnIcon\('board', 'pn-i sm'\), el\('span', \{ text: '보드' \}\)/.test(PTASK), "Q5 우측 사이드바 [보드] 단추 = board");
  ok(!/icon: 'proj'|pnIcon\('proj', 'pn-i sm'\)/.test(PTASK + cut(CTX, "function projectMenu(", "\n}\n")), "Q5 보드로 가는 줄이 프로젝트 그림을 쓰지 않는다");
}

// ── Q6 진척시킨 프로젝트 · 태스크 ──
{
  const ACT = read("web/activity-view.ts");
  let map = null;
  { const s = cut(ACT, "const ACT_LNK_ICON = {", "\n};"); try { if (s) map = new Function("ICONS", s.replace("const ACT_LNK_ICON =", "return")) (ICONS); } catch { /* 빨간불 */ } }
  ok(!!map && Array.isArray(map.projectLevel) && map.projectLevel.length === 1 && map.projectLevel[0] === ICONS.proj, "Q6 진척시킨 프로젝트 그림 = 과녁(projectLevel)");
  ok(!!map && Array.isArray(map.project) && map.project.some((d) => /l2\.4 2\.4 4\.3-4\.9/.test(d)), "Q6 진척시킨 태스크 그림 = 원 안의 체크 그대로(project)");
  ok(/actLinkRow\(t\.level === 'project' \? 'projectLevel' : 'project', t\.level === 'project' \? '진척시킨 프로젝트' : '진척시킨 태스크'/.test(ACT), "Q6 프로젝트 단계면 projectLevel, 태스크면 project 를 고른다");
}

// ── Q7 묶기 토글 · Q8 새 프로젝트 ──
{
  ok(/icon\('projGroup', 'v2-axisbtn-ic'\)/.test(cut(SIDE, "function axisBtn(", "\n}\n")), "Q7 「프로젝트로 묶기」 토글 = projGroup");
  ok(/newKind === 'list' \? icon\('list', 'v2-pj-ic'\) : glyph\(newKind === 'folder' \? 'folder' : 'projNew', 'v2-pj-ic'\)/.test(cut(SIDE, "function newProjRow(", "\n}\n")), "Q8 새 프로젝트 줄 = projNew, 새 폴더 = folder, 새 리스트 = list");
}

// ── Q9 옮기기 ──
{
  ok(/label: s\.projectId \? '프로젝트 바꾸기·떼기' : '프로젝트 연결', icon: 'sessMove'/.test(cut(CTX, "function sessionMenu(", "\n}\n")), "Q9 우클릭 「프로젝트 바꾸기·떼기 · 프로젝트 연결」 = sessMove");
  ok(/icon\('sessMove', 'pn-i sm'\), el\('span', \{ class: 'pn-move-t', text: loose \? '프로젝트에 붙이기' : '세션 옮기기' \}\)/.test(PANES), "Q9 우측 사이드바 [세션 옮기기 · 프로젝트에 붙이기] = sessMove");
  ok(/label: `\$\{toZone\[z\]\} 보내기`, icon: 'moveto'/.test(PANES) && /label: '위치', icon: 'moveto'/.test(read("web/v2/pane-dock.ts")), "Q9 칸(탭) 옮기기는 moveto 그대로");
  {
    const files = [];
    const walk = (dir) => { for (const n of readdirSync(join(root, dir))) { const p = dir + "/" + n; if (statSync(join(root, p)).isDirectory()) walk(p); else if (/\.ts$/.test(n)) files.push(p); } };
    walk("web");
    const callers = files.filter((f) => /['"]projMove['"]/.test(read(f)));
    ok(!has("projMove") && callers.length === 0, "M1 옛 projMove(작은 과녁과 화살표)는 표에도 부르는 곳에도 없다", callers.join(","));
    ok(has("sessMove") && has("goto") && ICONS.sessMove !== ICONS.goto && /z$/i.test(ICONS.sessMove.trim()), "M2 sessMove 는 닫힌 굵은 화살표이고 얇은 화살표(goto)와 다른 그림이다");
  }
}

// ── Q10 새 세션 ──
{
  let newSessBtn = null;
  { const s = cut(SIDE, "function newSessBtn(", "\n}\n");
    try { if (s) newSessBtn = new Function("el", "sv", "iconPath", "hooks", transpile(s) + "\nreturn newSessBtn;")(mk, mk, (k) => ICONS[k] || "", {}); } catch { /* 빨간불 */ } }
  ok(typeof newSessBtn === "function" && dOf(newSessBtn(7).kids[0]) === ICONS.sessNew, "Q10 홈 · 트리의 프로젝트 줄 [새 세션] = sessNew(값으로 불러 본다)");
  ok(/label: '같은 프로젝트에 새 세션', icon: 'sessNew'/.test(cut(SIDE, "export function sessionCtxRows(", "\n}\n")), "Q10 세션 우클릭 「같은 프로젝트에 새 세션」 = sessNew");
  ok(/\{ label: '새 세션', icon: 'sessNew'/.test(cut(SIDE, "export function projectCtxRows(", "\n}\n")), "Q10 프로젝트 우클릭 「새 세션」 = sessNew");
  ok(/kind === 'new' \? \[ICONS\.sessNew\]/.test(TABS), "Q10 새 세션 탭 = sessNew");
  ok(/pnIcon\('sessNew', 'pn-i sm'\), el\('span', \{ text: '세션' \}\)/.test(PANES), "Q10 우측 사이드바 문의 [세션] = sessNew");
  dash = await loadWithStubs("web/dash/icons.ts");
  ok(!!dash && typeof dash.dashSessAddIcon === "function" && dOf(dash.dashSessAddIcon()) === ICONS.sessNew, "Q10 대시보드 [새 세션] = sessNew(값으로 불러 본다)");
  const SEL = read("web/projects/selection.ts");
  ok(/if \(kind === 'session'\) return svg\(sv\('path', \{ d: ICONS\.sessNew \}\)\)/.test(cut(SEL, "function pjvActIcon(", "\n}\n")), "Q10 클래식 프로젝트 줄 [새 세션] = sessNew");
  //  프로젝트 화면의 그림 표(HUB_ICON)는 main 에선 detail-hub-kit.ts, stage 에선 detail-hub.ts 에 있다. 새 세션 단추도 갈린다
  //   (main = 머리의 [세션], stage = 태스크 줄의 「이 태스크로 세션 열기」). 둘 중 그 브랜치에 있는 쪽을 본다.
  const HUB = read("web/projects/detail-hub-kit.ts") || read("web/projects/detail-hub.ts");
  ok(/sessNew: `<path d="\$\{ICONS\.sessNew\}"\/>`/.test(HUB)
    && (/hubIcon\('sessNew', 14\), el\('span', \{ text: '세션' \}\)/.test(read("web/projects/detail.ts")) || /hubIcon\(sess\.length \? 'term' : 'sessNew', 15\)/.test(read("web/projects/detail-hub.ts")))
    && !/termnew/.test(HUB.replace(/^\s*\/\/.*$/gm, "")), "Q10 프로젝트 화면의 새 세션 단추 = sessNew(터미널과 더하기 termnew 를 쓰지 않는다)");
}

// ── Q11 폴더 ──
{
  if (pjv && pjv.pjvBundleIcon) {
    const c = pjv.pjvBundleIcon("#e11d48"), p = pathOf(c);
    ok(dOf(c) === ICONS.folder && p && p.attrs.fill === "none" && p.attrs.stroke === "#e11d48", "Q11 클래식 폴더 = 둥근 선 폴더, 정해 둔 색은 선 색", p ? `${p.attrs.fill}/${p.attrs.stroke}` : "");
    const d = pathOf(pjv.pjvBundleIcon(undefined));
    ok(d && d.attrs.d === ICONS.folder && d.attrs.stroke === "var(--muted-2)", "Q11 색이 없는 클래식 폴더는 회색 선(var(--muted-2))");
  }
  ok(!!dash && typeof dash.dashProjFolderIcon === "function" && dOf(dash.dashProjFolderIcon()) === ICONS.folder, "Q11 대시보드 「내 프로젝트 설정」 폴더 = 둥근 선 폴더");
  const POP = read("web/dash/widget-projects-popovers.ts");
  ok(/dashProjFolderIcon\(\)/.test(POP) && !/dashFolderThumb\(\)/.test(POP), "Q11 프로젝트 팝오버는 채운 파일 폴더(dashFolderThumb)를 쓰지 않는다");
}

// ── Q12 리스트 ──
{
  if (dash && dash.dashListGlyph) {
    const g = dash.dashListGlyph({ color: "#0ea5e9" });
    ok(dOf(g) === ICONS.list && g.attrs.stroke === "#0ea5e9", "Q12 대시보드 리스트 = 점과 줄 셋, 리스트 색은 선 색");
    const e = dash.dashListGlyph({ settings: { icon: "🍎" } });
    ok(e && e.tag === "span" && e.attrs.text === "🍎", "Q12 이모지를 정한 리스트는 이모지 그대로");
  } else ok(false, "Q12 대시보드 dashListGlyph 를 값으로 부를 수 있다");
  ok(/n\.append\(sv\('path', \{ d: ICONS\.list \}\)\)/.test(cut(read("web/projects/sidebar.ts"), "function pjvListGlyph(", "\n}\n")), "Q12 클래식 사이드바 리스트 = 점과 줄 셋");
  ok(/if \(kind === 'list'\) return svg\(sv\('path', \{ d: ICONS\.list \}\)\)/.test(read("web/projects/selection.ts")), "Q12 클래식 일괄 바의 리스트 = 점과 줄 셋");
  ok(/list: `<path d="\$\{ICONS\.list\}"\/>`/.test(read("web/projects/detail-meta.ts")), "Q12 프로젝트 화면 사실 칩의 리스트 = 점과 줄 셋");
  ok(/icon\('list', 'v2-tx-ic'\)/.test(read("web/v2/taxonomy.ts")) && !/icon\('folder', 'v2-tx-ic'\)/.test(read("web/v2/taxonomy.ts")), "Q12 분류체계 리스트 카드 머리 = 점과 줄 셋");
}

// ── Q13 즐겨찾기 ──
{
  if (pjv && pjv.pjvTbIcon) {
    const on = pathOf(pjv.pjvTbIcon("star-on")), off = pathOf(pjv.pjvTbIcon("star"));
    ok(on && on.attrs.d === ICONS.star && on.attrs.fill === "currentColor", "Q13 클래식 켠 별 = 표의 별, 안을 채운다");
    ok(off && off.attrs.d === ICONS.star && !off.attrs.fill, "Q13 클래식 끈 별 = 표의 별, 선만");
  } else ok(false, "Q13 클래식 pjvTbIcon 을 값으로 부를 수 있다");
  if (dash && dash.dashStarIcon) {
    ok(dOf(dash.dashStarIcon(true)) === ICONS.star && dash.dashStarIcon(true).attrs.fill === "currentColor" && dash.dashStarIcon(false).attrs.fill === "none", "Q13 대시보드 별 = 표의 별, 켠 것은 채우고 끈 것은 선만");
  } else ok(false, "Q13 대시보드 dashStarIcon 을 값으로 부를 수 있다");
  ok(!/text: '⭐/.test(read("web/dash/widget-projects-popovers.ts")) && /el\('span', \{ class: 'dash-pop-fav', title: '즐겨찾기' \}, dashStarIcon\(true\)\)/.test(read("web/dash/widget-projects-popovers.ts")), "Q13 대시보드 프로젝트 팝오버의 즐겨찾기 표시는 별 그림이고 ⭐ 이모지 글이 없다");
}

// ── Q14 프로젝트 자료 ──
{
  const CHAT = read("web/session-chat.ts");
  ok(/sv\('path', \{ d: ICONS\.folder \}\)/.test(cut(CHAT, "const filesGoBtn = ", "\n  });")) || /sv\('path', \{ d: ICONS\.folder \}\)\)/.test(lineOf(CHAT, "ICONS.folder")), "Q14 세션 화면 [자료] = 둥근 폴더");
  ok(/folder: `<path d="\$\{ICONS\.folder\}"\/>`/.test(read("web/projects/detail-hub-kit.ts") || read("web/projects/detail-hub.ts")), "Q14 프로젝트 화면 공유 폴더 = 둥근 폴더(표의 folder)");
  ok(/const pnIcon = mkIcon\(\[ICONS\.folder\]\)/.test(read("web/v2/mobile.ts")) && /'자료·우측 사이드바 열기'/.test(read("web/v2/mobile.ts")), "Q14 폰 단추 = 둥근 폴더, 이름은 「자료·우측 사이드바 열기」");
}

// ── Q15 지난 세션 「프로젝트」 열 · Q16 세션 옮기기 ──
{
  ok(/el\('td', \{ class: 'c-in' \}, projIcon\(!!it\.projectId\), el\('span', \{ text: it\.projectId \? projName\(data, it\.projectId\) : NO_PROJECT_NAME \}\)\)/.test(cut(BINS, "export function renderPast(", "\n}\n")), "Q15 지난 세션 「프로젝트」 열에 프로젝트 그림(없으면 점선 원)");
  const body = cut(PICK, "function pickBody(", "\n}\n");
  const noCmt = (src) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  //  #4551(원준 2026-10-05) — 「프로젝트에서 떼기」 줄은 걷었다(떼어도 작업 폴더는 그대로라 목록에서만 갈 곳을 잃는다).
  ok(!/pick\(null\)/.test(noCmt(body)) && !/프로젝트에서 떼기/.test(noCmt(body)), "Q16 세션 옮기기에 「프로젝트에서 떼기」 줄이 없다 — 옮기기만 된다");
  ok(/ic\(ICONS\[projGlyph\(15\)\]\), el\('span', \{ class: 'n', text: r\.proj\.name \}\)/.test(body), "Q16 세션 옮기기 프로젝트 줄 = 15px 크기 규칙의 그림(과녁)");
  ok(/\.v2-pjpick-ic \{[^}]*stroke-width: var\(--ic-stroke\)/.test(read("public/styles/40-v2.css")), "Q16 고르개 줄 그림이 선 굵기 토큰(--ic-stroke)을 읽는다");
}

// ── A. 옛 그림이 그 자리에 남지 않는다 ──
{
  const LUCIDE = "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z";
  const CLASSIC = "M3 6.7C3 5.8 3.72 5.1 4.6 5.1h3.55c.46 0 .9.22 1.18.58l.86 1.1h8.2c.88 0 1.6.72 1.6 1.6v8.42c0 .88-.72 1.6-1.6 1.6H4.6C3.72 18.9 3 18.2 3 17.3V6.7z";
  const CHECK_LIST = "M4 7l1.6 1.6L8.4 5.6";
  const TERM_PLUS = "M20.6 2.6v5";
  const files = ["web/session-chat.ts", "web/projects/icons.ts", "web/projects/detail-meta.ts", "web/projects/sidebar.ts", "web/dash/icons.ts", "web/projects/selection.ts"];
  for (const f of files) {
    const s = read(f);
    ok(!s.includes(LUCIDE) && !s.includes(CLASSIC) && !s.includes(CHECK_LIST), `A ${f}: 옛 폴더(Lucide · 채운 클래식) · 체크 두 줄 리스트 그림이 없다`);
  }
  ok(!read("web/dash/icons.ts").includes(TERM_PLUS) && !cut(read("web/projects/selection.ts"), "if (kind === 'session')", "\n").includes(TERM_PLUS), "A 새 세션 단추에 옛 터미널과 더하기 그림이 없다");
  ok(!/glyph\(g\.open \? 'folder-open' : 'folder', 'v2-pg-ic'\)|glyph\(isOpen \? 'folder-open' : 'folder', 'v2-pj-ic'\)/.test(SIDE), "A 사이드바 프로젝트 줄에 폴더(열림 · 닫힘) 그림이 남지 않는다");
}

console.log(`\n#4233 프로젝트 관련 작은 아이콘: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
if (fail) process.exit(1);
