// #3870 «곁칸 탭 관리» — 곁칸·아래 칸 탭 줄의 규칙(web/lib/pane-tabs.ts) + 셸 배선(web/v2/panes.ts).
//
//  신고(원준 2026-09-30): "곁칸에 여러 탭이 떠 있을 때 닫는 방식이 너무 불편함. 하나 닫고 하나씩 다 찾으러 다녀야 함.
//   UI 도 별로이고 아이콘이 중앙이 맞는지도 헷갈림. 사파리나 크롬 탭들 닫거나 열거나 끌거나 드래그하는 거 최대한 참고해서."
//
//  1부 — 순수 규칙(값 비교, 엣지 표의 행마다 하나 이상). 2부 — 셸이 그 규칙을 실제로 부르는지(소스 배선).
//  화면 기하(× 와 아이콘의 중심)·끌기는 pane-tabstrip-runtime.test.mjs 가 실제 크롬에서 잰다.
//  fail-first(2026-09-30): 1부는 규칙 여덟 줄을 하나씩 깨서(왼쪽 이웃 착지 · `<=`→`<` · 고정 무시 · 경계 없는 placeKey · `>`→`>=` ·
//   64 경계 · 켜진 탭 최소 · 더미 상한) 빨간불을 봤고,
//   2부는 변경 전 panes.ts(git show HEAD)에 물려 빨간불을 봤다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SRC = process.env.PANE_TABS_SRC || path.join(root, "web/lib/pane-tabs.ts");
const out = mkdtempSync(path.join(tmpdir(), "pane-tabs-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [SRC, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" });
const L = await import(path.join(out, path.basename(SRC).replace(/\.ts$/, ".js")));

let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
const J = (v) => JSON.stringify(v);
const eq = (got, want, n) => check(J(got) === J(want), n, `기대 ${J(want)} · 실제 ${J(got)}`);

// ── 1부: 순수 규칙 ────────────────────────────────────────────────────────────
// 최근에 본 순서
eq(L.touchRecent(["a", "b", "c"], "c"), ["c", "a", "b"], "R1 본 탭이 맨 앞으로 — 같은 열쇠는 하나만");
eq(L.touchRecent(["a", "b"], "z", 2), ["z", "a"], "R2 길이는 cap 으로 자른다");

// 닫은 뒤 켤 탭 (C1–C5)
const tools = ["files", "tasks", "knowledge", "apps"];
//  자료에서 파일 두 개를 차례로 열어 보고(자료 → 뷰어1 → 자료 → 뷰어2) 뷰어2 를 닫는다 → 자료로 돌아간다.
const list1 = [...tools, "editor", "editor#2"];
eq(L.landingAfterClose(list1, "editor#2", ["editor#2", "files", "editor"]), "files",
  "C1 켜진 탭을 닫으면 가장 최근에 보던 탭(자료)으로 — 종전 규칙(왼쪽 이웃)이면 editor 였다");
eq(L.landingAfterClose(["a", "b", "c", "d"], "b", []), "c", "C2 본 기록이 비었으면 오른쪽 이웃(크롬 — 닫힌 자리로 미끄러져 오는 탭)");
eq(L.landingAfterClose(["a", "b", "c", "d"], "b", ["b"]), "c", "C2b 기록에 닫힌 탭 자신뿐이어도 오른쪽 이웃");
eq(L.landingAfterClose(["a", "b", "c"], "c", []), "b", "C3 맨 끝을 닫으면 왼쪽");
eq(L.landingAfterClose(["a"], "a", ["a"]), null, "C4 마지막 탭을 닫으면 칸이 빈다");
eq(L.landingAfterClose(["a", "b", "c"], "a", ["a", "zz", "c"]), "c", "C5 최근 기록 중 이미 없는 탭(zz)은 건너뛴다");

// 한꺼번에 닫기 (B1–B6)
const pinned = new Set(["files"]);
const o = { keep: (k) => pinned.has(k) || k === "sessapp", isFile: (k) => k.startsWith("editor") };
const list2 = ["files", "tasks", "editor", "sessapp", "editor#2", "web"];
eq(L.bulkTargets(list2, "editor", "others", o), ["tasks", "editor#2", "web"], "B1 다른 탭 닫기 — 고정 탭·붙은 앱은 남는다");
eq(L.bulkTargets(list2, "editor", "right", o), ["editor#2", "web"], "B2 오른쪽 탭 닫기 — 붙은 앱은 건너뛴다");
eq(L.bulkTargets(list2, null, "files", o), ["editor", "editor#2"], "B3 파일 탭 모두 닫기 — 뷰어만");
eq(L.bulkTargets(list2, null, "all", o), ["tasks", "editor", "editor#2", "web"], "B4 모두 닫기 — 고정·붙은 앱 빼고");
eq(L.bulkTargets(list2, "nope", "right", o), [], "B5 없는 탭의 오른쪽은 없다");
eq(L.bulkTargets(list2, "web", "right", o), [], "B6 맨 끝 탭의 오른쪽은 없다");

// 끌어 옮기기 (D1–D3 의 규칙 부분)
const P2 = new Set(["p1", "p2"]);
eq(L.normalizePins(["a", "p2", "b", "p1"], P2), ["p2", "p1", "a", "b"], "D0 고정 탭은 맨 앞에 모인다(서로 순서는 지킨다)");
eq(L.normalizePins(["a", "b"], new Set()), ["a", "b"], "D0b 고정 탭이 없으면 그대로");
eq(L.placeKey(["p1", "p2", "a", "b", "c"], "c", 0, P2), ["p1", "p2", "c", "a", "b"], "D2 고정 안 한 탭은 고정 탭 앞으로 못 간다");
eq(L.placeKey(["p1", "p2", "a", "b"], "p1", 3, P2), ["p2", "p1", "a", "b"], "D2b 고정 탭은 고정 탭 뒤로 못 간다");
eq(L.placeKey(["a", "b", "c"], "a", 2, new Set()), ["b", "c", "a"], "D1a 같은 줄 안 — 맨 끝으로");
eq(L.placeKey(["a", "b"], "n", 1, new Set()), ["a", "n", "b"], "D3a 없는 탭은 그 자리에 끼운다(다른 칸에서 온 탭)");
eq(L.placeKey(["a", "b"], "n", Number.NaN, new Set()), ["a", "b", "n"], "D3b 자리를 모르면 맨 끝");
const rects = [{ left: 0, width: 60 }, { left: 60, width: 80 }, { left: 140, width: 40 }, { left: 180, width: 100 }];
eq(L.dragSlot(rects, 0, 90, 0, 3), 1, "D1 오른쪽 끝(60+90=150)이 이웃 가운데(100)를 넘으면 그 자리 — 다음 이웃 가운데(160)는 못 넘었다");
eq(L.dragSlot(rects, 0, 40, 0, 3), 0, "D1b 정확히 같으면(60+40=100) 제자리 — 경계");
eq(L.dragSlot(rects, 0, 30, 0, 3), 0, "D1c 못 넘으면 제자리");
eq(L.dragSlot(rects, 3, -30, 0, 3), 2, "D1e 왼쪽으로 — 왼쪽 끝(180-30=150)이 이웃 가운데(160)를 넘으면 그 자리");
eq(L.dragSlot([{ left: 0, width: 50 }, { left: 50, width: 50 }, { left: 100, width: 150 }], 2, -100, 1, 2), 1,
  "D2e 넓은 탭을 줄 끝(고정 경계 lo=1, 왼쪽 끝 = 50)까지 끌면 그 자리에 선다 — 가운데끼리 비교하면 못 갔다");
eq(L.dragSlot(rects, 0, 400, 0, 3), 3, "D1d 끝까지 끌면 맨 끝");
eq(L.dragSlot(rects, 3, -400, 1, 3), 1, "D2c 고정 경계(lo=1) 앞으로는 못 간다");
eq(L.dragSlot(rects, 0, 400, 0, 1), 1, "D2d 고정 경계(hi=1) 뒤로는 못 간다");
eq(L.dropSlot(rects, 10), 0, "D3c 다른 칸 — 첫 탭 가운데보다 왼쪽이면 맨 앞");
eq(L.dropSlot(rects, 150), 2, "D3d 다른 칸 — 두 탭 사이");
eq(L.dropSlot(rects, 999), 4, "D3e 다른 칸 — 맨 끝");

// 폭 (W1–W6)
const M = L.TAB_METRICS;
eq([M.icon, M.minLabel, M.max, M.activeMax, M.activeMin], [34, 64, 184, 220, 120], "W0 치수 — 아이콘 34 · 이름 남기는 최소 64 · 최대 184/220 · 켜진 탭 최소 120");
const T = (natural, active = false, pin = false) => ({ natural, active, pinned: pin });
//  곁칸 기본 폭의 기본 네 탭 — 실측 자연 폭(자료 65 · 프로젝트 87 · 지식 65 · 앱 54 = 271).
const four = [T(65, true), T(87), T(65), T(54)];
let p = L.planTabs(four, 271);
eq([p.mode, p.widths, p.overflow], ["full", [65, 87, 65, 54], false], "W1 합 == 줄 폭(경계) — 이름을 다 편다(종전엔 켜진 탭 하나 빼고 전부 아이콘이었다)");
p = L.planTabs(four, 270);
check(p.mode !== "full" && p.widths.reduce((a, b) => a + b, 0) <= 270, "W1b 1px 모자라면 다 펴지 않는다", J(p));
p = L.planTabs([T(90, true), T(60), T(200), T(150)], 360);
eq(p.mode, "shrink", "W2 모자라면 줄인다");
eq([p.widths[0], p.widths[1]], [90, 60], "W2b 켜진 탭(90)·짧은 이름(60)은 그대로 — 긴 이름부터 깎는다");
eq(p.widths, [90, 60, 105, 105], "W2c 긴 이름 둘은 같은 폭(105)으로 깎여 줄(360)을 꼭 채운다(물높이) — 자리를 남기지도 넘치지도 않는다");
const tight = [T(100, true), T(150), T(150), T(150)];
p = L.planTabs(tight, 100 + 3 * 64);
eq([p.mode, p.widths], ["shrink", [100, 64, 64, 64]], "W3 64px 로 딱 들어가면(경계) 이름을 남긴다");
p = L.planTabs(tight, 100 + 3 * 64 - 1);
eq([p.mode, p.widths, p.overflow], ["icons", [100, 34, 34, 34], false], "W3b 1px 모자라면 켜진 탭만 이름 — 나머지는 아이콘(34)");
p = L.planTabs([T(200, true), ...Array(9).fill(0).map(() => T(150))], 243);
eq([p.mode, p.widths[0], p.overflow], ["icons", 120, true], "W4 그래도 넘치면 켜진 탭은 120 까지만 양보하고 줄이 미끄러진다(«한…» 이 되지 않게)");
p = L.planTabs([T(90, true), ...Array(9).fill(0).map(() => T(150))], 243);
eq([p.widths[0], p.overflow], [90, true], "W4b 켜진 탭 이름이 120 보다 짧으면 그 폭 그대로");
p = L.planTabs([T(90, false, true), T(120, true), T(80)], 1000);
eq(p.widths, [34, 120, 80], "W5 고정 탭은 넓어도 아이콘(34)");
p = L.planTabs([T(300, true), T(300)], 1000);
eq(p.widths, [220, 184], "W6 긴 이름도 켜진 탭 220 · 나머지 184 까지만");

// 닫은 탭 다시 열기 (U1–U5)
let st = L.pushClosed([], [{ key: "a", zone: "side", at: 4 }]);
st = L.pushClosed(st, [{ key: "c", zone: "side", at: 6 }, { key: "b", zone: "side", at: 5 }]);
st = L.pushClosed(st, []);
eq(st.length, 2, "U1 빈 묶음은 안 쌓는다");
let r = L.popClosed(st);
eq(r.batch.map((t) => t.key), ["b", "c"], "U2 가장 최근 묶음을 통째로 — 앞자리부터(자리 오름차순)");
r = L.popClosed(r.rest);
eq([r.batch.map((t) => t.key), r.rest.length], [["a"], 0], "U3 그다음은 그 앞 묶음");
eq(L.popClosed([]), null, "U4 빈 더미 — 아무 일 없음");
let big = [];
for (let i = 0; i < 21; i++) big = L.pushClosed(big, [{ key: "k" + i, zone: "side", at: 0 }]);
eq([big.length, big[0][0].key, big[19][0].key], [20, "k1", "k20"], "U5 20 묶음까지만 — 21번째가 오면 가장 오래된 것(k0)을 버린다");

// ── 2부: 셸 배선(web/v2/panes.ts) ──────────────────────────────────────────────
const PANES = readFileSync(process.env.PANES_SRC || path.join(root, "web/v2/panes.ts"), "utf8");
const fn = (head) => { const i = PANES.indexOf(head); if (i < 0) return ""; const j = PANES.indexOf("\n  }\n", i); return PANES.slice(i, j + 4); };
const tabElFn = fn("  function tabEl(zone: Zone, key: TabKey, on: boolean): HTMLElement {");
check(tabElFn.length > 0, "S0 (배선) tabEl 을 찾았다 — 아래 단언이 무언가를 보고 있다");
check(/const x = pinned \|\| \(detachX && !on\) \? null : el\('button', \{\s*class: 'pn-tab-x'/.test(tabElFn), "S1 × 는 고정 탭과 «안 켠 붙은 앱 탭» 만 빼고 모든 탭에 선다 — 켜졌는지와 무관하다");
check(/el\('span', \{ class: 'pn-tab-lead'[^)]*\}, pnIcon\(ic, 'pn-i sm'\)\), el\('span', \{ class: 'pn-tab-t'/.test(tabElFn), "S1b 탭 = 아이콘 칸(pn-tab-lead) + 이름(pn-tab-t) — 런타임 기하 시험이 재는 그 구조");
check(/addEventListener\('auxclick'[\s\S]*?e\.button !== 1[\s\S]*?if \(!pinned && !\(detachX && !on\)\) closeTab\(zone, key, \{ pointer: true \}\)/.test(tabElFn), "S2 휠 클릭(가운데 버튼) = 닫기 · 고정 탭과 안 켠 붙은 앱 탭은 제외");
check(/beginTabDrag\(dragHost, zone, key, w, e\)/.test(tabElFn) && !/draggable/.test(tabElFn), "S3 끌기는 포인터 끌기(pane-tabdrag) — HTML5 draggable 이 아니다");
check(/if \(consumeDragClick\(\)\) return; activate\(zone, key\)/.test(tabElFn), "S3b 끌기로 끝난 누름은 켜기로 치지 않는다");
check(!/data-n/.test(tabElFn), "S4 아이콘 어깨의 번호(data-n)는 걷혔다");
const dropFn = fn("  function dropTab(zone: Zone, key: TabKey, o?: { paint?: boolean }): void {");
check(/lay\.act\[real\] = landingAfterClose\(before, key, recent\[real\]\)/.test(dropFn), "S5 켜진 탭을 닫으면 최근 본 탭으로(landingAfterClose)");
check(!/list\[Math\.max\(0, i - 1\)\]/.test(PANES), "S5b 종전 규칙(왼쪽 이웃)은 걷혔다");
check(dropFn.length > 0 && !/saveAct\(/.test(dropFn), "S5c dropTab 은 세션 기억(saveAct)을 쓰지 않는다 — 세션을 갈아 끼울 때도 불려 새 세션의 기억을 덮어썼다(격리 리뷰)");
const removeFn = fn("  function removeTab(zone: Zone, key: TabKey): void {");
check(/if \(DERIVED_TABS\.has\(tabBase\(key\)\)\) \{ const z = zoneOf\(key\) \|\| zone; revealZone\(z\); activate\(z, key\); return; \}/.test(removeFn),
  "S5d 안 켠 붙은 앱 탭의 닫기는 걷지 않고 켠다 — 걷기만 하면 곧 되살아나 아무 일도 안 한 것이 된다");
const closeFn = fn("  function closeTab(zone: Zone, key: TabKey, o?: { pointer?: boolean }): void {");
check(/if \(o\?\.pointer && pane && !narrow\(\)\) freeze\(pane\);/.test(closeFn), "S6 마우스로 닫으면 폭을 얼린다 — 다음 탭의 × 가 커서 밑에 온다");
check(/bar\.addEventListener\('pointerleave', \(\) => thaw\(p\)\)/.test(PANES), "S6b 줄에서 손을 떼면 푼다");
check(/if \(pane\.frozen\) applyFreeze\(pane\); else fit\(pane\);/.test(PANES), "S6c 다시 그릴 때 얼려 둔 폭을 지킨다");
const moreFn = fn("  function moreBtn(zone: Zone): HTMLElement {");
check(/onclick: \(\) => \{ removeTab\(zone, t\); if \(zoneTabs\(zone\)\.length\) fill\(\); else close\(\); \}/.test(moreFn), "S7 ⌄ 목록의 × 는 목록을 닫지 않고 그 줄만 걷는다");
const menuFn = fn("  function tabMenu(e: MouseEvent, zone: Zone, key: TabKey): void {");
for (const [label, n] of [["'다른 탭 닫기'", "S8a"], ["'오른쪽 탭 닫기'", "S8b"], ["'파일 탭 모두 닫기'", "S8c"], ["'탭 고정'", "S8d"], ["'닫은 탭 다시 열기'", "S8e"]]) {
  check(menuFn.includes(label), `${n} 탭 우클릭 메뉴에 ${label}`);
}
const manyFn = fn("  function closeMany(zone: Zone, anchor: TabKey | null, kind: BulkKind): void {");
check(/bulkTargets\(zoneTabs\(zone\), anchor, kind, \{ keep: keepInBulk, isFile: isFileTab \}\)/.test(manyFn) && /lay\.act\[real\] = anchor;/.test(manyFn), "S8f 한꺼번에 닫기는 bulkTargets 로 고르고, 우클릭한 탭을 켠다");
const keyFn = fn("  function onTabsKey(p: Pane, e: KeyboardEvent): void {");
check(/e\.key === 'Delete' \|\| e\.key === 'Backspace'/.test(keyFn) && /if \(isPinned\(key\)\) return;/.test(keyFn) && /'ArrowRight'/.test(keyFn) && /'Home'/.test(keyFn), "S9 키보드 — ←/→/Home/End 로 옮기고 Delete 로 닫는다(고정 탭 제외)");
//  마운트 중 첫 paintAll 이 읽는 값은 그보다 앞에 선언돼야 한다(TDZ — mount-time-tdz-panes-declaration-order-762).
const mountAt = PANES.indexOf("export function mountPanes(");
const firstPaint = PANES.indexOf("\n  paintAll();\n", mountAt);
const declAt = (re) => { const m = re.exec(PANES.slice(mountAt)); return m ? mountAt + m.index : -1; };
check(firstPaint > 0 && [/const recent: Record<Zone, TabKey\[\]>/, /let closedStack: ClosedTab\[\]\[\]/, /const dragHost: TabDragHost/].every((re) => { const i = declAt(re); return i > 0 && i < firstPaint; }),
  "S11 탭 줄의 기억(recent · closedStack · dragHost)은 첫 paintAll 보다 앞에 선언된다");
check(/pin: TabKey\[\];/.test(PANES) && /pin: arr\(s\.pin\)/.test(PANES) && /normalizePins\(lay\[z\], pins\)/.test(PANES), "S10 고정 탭은 배치에 저장되고, 읽을 때 맨 앞으로 모인다");

console.log(fail ? `\n${fail}건 실패 · ${pass}건 통과` : `\n${pass}건 통과`);
process.exit(fail ? 1 : 0);
