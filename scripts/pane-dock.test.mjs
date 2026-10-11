// #4443 «곁칸 → 앱의 실행 화면» — 곁칸 독의 규칙(web/lib/pane-dock.ts) + 셸 배선(web/v2/panes.ts · pane-dock.ts).
//
//  원준(2026-10-01, 바로잡음): "디폴트로 4안(이음매 독)이고 끌어당겨서 3안에 둘 수 있는 걸로 … 아래에 뒀을 때는 곁칸 사이즈
//   변하는거에 따라서 독 사이즈도 바꾸고 싶음. 너가 바닥 왼쪽 탭 만든건 없애줘 일단은. 그리고 좀 더 이쁘게 … 맥 os 참고해서."
//
//  1부 — 순수 규칙(엣지 표의 행마다 단언 하나 이상). 2부 — 셸이 그 규칙을 실제로 부르는지(소스 배선).
//  화면(독의 자리·크기·곁칸 머리 높이·끌어 옮기기)은 pane-dock-runtime.test.mjs 가 실제 크롬에서 잰다.
//  fail-first(2026-09-30 첫 판): 순환(다음 인스턴스)을 «처음 것»으로 · «다 뺐다» 표식 무시 — PANE_DOCK_SRC 로 변형본을 물려 빨간불.
//  fail-first(2026-10-01 리뷰 반영): dockPins 가 고를 수 있는 것으로 base 를 거르면 B2·B2b·B3·B3b · movePinBefore 가 이웃을 무시하면
//   B6·B6d·B6e·B6f · pinSlot 경계 `>`→`>=` 면 Q2 · 비고정 가드를 지우면 Q3·Q4 가 빨갛다. 배선 G2·J4·W10·K1 은 반영 전 main.ts · panes.ts ·
//   pane-dock.ts · 50-mobile.css(MAIN_SRC · PANES_SRC · DOCK_UI_SRC · MOBILE_CSS)에 물려 빨간불을 봤다.
//  fail-first(2026-10-01 이음매 판): 기본을 float 로 하면 P1 · P3 · P3c, 이음매 없을 때 곁칸 아래로 안 가면 P7, 안쪽 문턱 `>`→`>=` 면 L3,
//   가운데 자석을 빼면 L6, 곁칸 아래 크기에서 확대 몫(grow)을 빼면 F5 · F7b, 이음매에도 바닥 여백을 주면 S1 이 빨갛다(PANE_DOCK_SRC).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SRC = process.env.PANE_DOCK_SRC || path.join(root, "web/lib/pane-dock.ts");
const out = mkdtempSync(path.join(tmpdir(), "pane-dock-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [SRC, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" });
const D = await import(path.join(out, path.basename(SRC).replace(/\.ts$/, ".js")));

let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
const J = (v) => JSON.stringify(v);
const eq = (got, want, n) => check(J(got) === J(want), n, `기대 ${J(want)} · 실제 ${J(got)}`);
const near = (got, want, n, eps = 1e-9) => check(Math.abs(got - want) <= eps, n, `기대 ${want} · 실제 ${got}`);

// ── 1부: 순수 규칙 ────────────────────────────────────────────────────────────
// 설정 읽기·쓰기 (P1–P7) — 이음매 판(10-01): 서는 곳(home) 둘 · 이음매 자리(at) · 확대
eq(D.readDockPrefs(undefined), { home: "seam", at: 0.5, fx: 0.5, mag: true }, "P1 적은 적 없으면 기본 — 이음매(4안) 가운데, 확대 켬(원준 10-01: 디폴트는 4안)");
eq(D.readDockPrefs({ home: "float", at: "0.30", mag: "0" }), { home: "float", at: 0.3, fx: 0.5, mag: false }, "P2 적어 둔 대로");
eq(D.readDockPrefs({ home: "diagonal", at: "x", mag: 3 }), { home: "seam", at: 0.5, fx: 0.5, mag: true }, "P3 깨진 칸은 칸마다 기본값(한 칸이 깨져도 나머지는 산다)");
eq(D.readDockPrefs({ home: "float", at: "x" }).home, "float", "P3b 한 칸만 깨지면 나머지 칸은 적힌 대로");
eq(D.readDockPrefs({ edge: "right", at: "0.80", mode: "bar", hide: "1", mag: "1" }), { home: "seam", at: 0.8, fx: 0.5, mag: true }, "P3c 종전 판의 칸(edge · mode · hide)은 안 읽는다 — 무엇을 골랐든 이음매에서 다시 시작(막대·가리기는 걷었다)");
eq([D.readDockPrefs({ at: "1.7" }).at, D.readDockPrefs({ at: "-2" }).at, D.readDockPrefs({ at: "" }).at], [1, 0, 0.5], "P4 자리는 0~1 로 자르고, 빈 값은 가운데");
const p5 = { home: "float", at: 0.123, fx: 0.876, mag: false };
eq(D.readDockPrefs(D.writeDockPrefs(p5)), { ...p5, at: 0.12, fx: 0.88 }, "P5 적은 것을 다시 읽으면 같다(자리는 소수 둘째 자리)");
check(Object.values(D.writeDockPrefs(p5)).every((v) => typeof v === "string" && v.length <= 64), "P6 서버 map 저장소 규격 — 값은 문자열 64자 이내");
eq([D.effectiveHome({ home: "seam" }, true), D.effectiveHome({ home: "seam" }, false), D.effectiveHome({ home: "float" }, true)], ["seam", "float", "float"],
  "P7 이음매가 없으면(서랍 · 카드 · 접힘) 곁칸 아래 — 있으면 사람이 고른 곳");

// 곁칸 아래 좌우 자리 (FX1–FX9) — 원준 10-07 «곁칸 전체보기로 보고있을 때 아래 Dock 끌어당겨서 밑에 위치 옮기거나». 구간 200~1000(가운데 600).
eq([D.readDockPrefs({ fx: "0.20" }).fx, D.readDockPrefs({ fx: "7" }).fx, D.readDockPrefs({ fx: "-1" }).fx, D.readDockPrefs({ fx: "x" }).fx, D.readDockPrefs({ fx: "" }).fx], [0.2, 1, 0, 0.5, 0.5],
  "FX1 좌우 자리는 적어 둔 대로 · 0~1 로 자르고 · 깨진 값 · 빈 값은 가운데");
eq(D.writeDockPrefs({ home: "float", at: 0.5, fx: 0.2, mag: true }).fx, "0.20", "FX2 좌우 자리도 계정에 적는다(문자열)");
eq([D.floatCenter(0, 200, 1000), D.floatCenter(0.5, 200, 1000), D.floatCenter(1, 200, 1000), D.floatCenter(0.25, 200, 1000)], [200, 600, 1000, 400], "FX3 자리 → 가운데 x — 구간의 비율(0 = 왼쪽 끝 · 1 = 오른쪽 끝)");
eq([D.floatCenter(0, 180, 160), D.floatCenter(1, 180, 160), D.floatCenter(0.2, 170, 170)], [170, 170, 170], "FX4 구간이 없으면(좁은 곁칸 — 알약이 폭을 채운다) 무엇을 골랐든 가운데");
eq([D.floatCenter(-3, 200, 1000), D.floatCenter(9, 200, 1000)], [200, 1000], "FX4b 범위 밖 값은 끝으로 자른다(알약이 곁칸 밖으로 안 나간다)");
eq([D.floatAt(400, 200, 1000), D.floatAt(900, 200, 1000)], [0.25, 0.88], "FX5 놓은 자리 → 구간의 비율(소수 둘째 자리)");
eq([D.floatAt(50, 200, 1000), D.floatAt(5000, 200, 1000)], [0, 1], "FX6 구간 밖에 놓으면 끝으로 자른다");
eq([D.floatAt(614, 200, 1000), D.floatAt(586, 200, 1000), D.floatAt(615, 200, 1000)], [0.5, 0.5, 0.52], "FX7 경계 — 가운데 ±14px 은 가운데로 붙는다, 15px 은 놓은 자리 그대로");
eq([D.floatAt(170, 160, 183), D.floatAt(170, 180, 160), D.floatAt(170, 160, 184) !== undefined], [undefined, undefined, true], "FX8 경계 — 움직일 구간이 24px 도 안 되면 자리를 안 돌려준다(넓을 때 고른 자리를 지우지 않게), 24px 이면 돌려준다");
near(D.floatCenter(D.floatAt(431, 200, 1000), 200, 1000), 431, "FX9 놓은 자리에 다시 선다(적고 읽어도 2.5% 이내 — 800px 구간에 4px)", 4);

// 고정 목록 (N1–N5)
const known = (t) => ["tasks", "files", "knowledge", "web", "timeline", "liv", "preview"].includes(t);
eq(D.readDockPins(null, known), ["tasks", "files", "knowledge", "web", "timeline"], "N1 정한 적 없으면 기본 다섯");
eq(D.readDockPins(["~"], known), [], "N2 «다 뺐다» 표식이면 빈 독(기본으로 돌아가지 않는다)");
eq(D.readDockPins(["web", "bogus", "web", "files"], known), ["web", "files"], "N3 모르는 종류·중복은 걷고 순서는 지킨다");
eq(D.readDockPins(["bogus"], known), ["tasks", "files", "knowledge", "web", "timeline"], "N4 전부 모르는 종류(부품이 사라짐)면 기본값");
eq(D.readDockPins(null, (t) => t !== "timeline"), ["tasks", "files", "knowledge", "web"], "N4b 기본값에서도 모르는 종류는 걷는다");
eq(D.writeDockPins([]), ["~"], "N5 빈 목록은 표식으로 적는다(저장소가 빈 목록을 «적은 적 없음»으로 지우므로)");
eq(D.readDockPins(D.writeDockPins([]), known), [], "N5b 표식을 적고 다시 읽으면 빈 독");

// 고정·순서 (T1–T3)
eq(D.togglePin(["a", "b"], "c"), ["a", "b", "c"], "T1 고정은 맨 뒤에");
eq(D.togglePin(["a", "b"], "c", 1), ["a", "c", "b"], "T1b 자리를 주면 그 자리에");
eq(D.togglePin(["a", "b", "c"], "b"), ["a", "c"], "T2 이미 고정이면 뺀다");
eq(D.movePin(["a", "b", "c", "d"], "a", 2), ["b", "c", "a", "d"], "T3 끌어 놓은 자리(놓은 뒤 설 자리)로");
eq(D.movePin(["a", "b"], "z", 1), ["a", "z", "b"], "T3b 고정 안 된 것을 고정 줄로 끌어오면 그 자리에 고정");

// 고정 목록 한 벌 — 고치기는 base 에, 그리기는 shown (B2–B6) · #4443 리뷰(2026-10-01)
//  프로젝트 없는 세션 화면은 태스크·자료·지식·리브를 고를 수 없다(panes.ts loose). 거른 목록에 고치면 계정의 고정이 지워졌다.
const all = () => true;
const loose = (t) => !["tasks", "files", "knowledge", "liv"].includes(t);
const dp = D.dockPins(null, all, loose);
eq([dp.base, dp.shown], [["tasks", "files", "knowledge", "web", "timeline"], ["web", "timeline"]], "B2 저장 없음 · 좁힌 화면 — base 는 기본 다섯, 보이는 것은 고를 수 있는 둘");
eq(D.togglePin(dp.base, "web"), ["tasks", "files", "knowledge", "timeline"], "B2b 좁힌 화면에서 웹을 빼도 안 보이는 고정 셋은 남는다(리뷰 실측: [timeline] 하나만 남았다)");
eq(D.dockPins(["tasks", "files"], all, loose).shown, [], "B3 고정이 전부 이 화면에서 못 고르는 것이면 빈 독 — 기본값으로 채우지 않는다(안 보이는 것 ≠ 없어진 것)");
eq(D.dockPins(["tasks", "files"], all, loose).base, ["tasks", "files"], "B3b 그래도 base 는 적힌 그대로");
eq(D.dockPins(["~"], all, loose), { base: [], shown: [] }, "B4 «다 뺐다» 표식이면 둘 다 빈 목록");
eq(D.dockPins(["gone"], (t) => t !== "gone", all).base, ["tasks", "files", "knowledge", "web", "timeline"], "B5 적힌 것이 전부 없어진 종류(부품이 사라진 판)면 base 는 기본값");
eq(D.movePinBefore(["a", "b", "c", "d"], "a", "d"), ["b", "c", "a", "d"], "B6 놓은 자리 = 바로 뒤의 고정 앱 앞");
eq(D.movePinBefore(["a", "b", "c"], "a", null), ["b", "c", "a"], "B6b 뒤가 없으면(null) 맨 뒤");
eq(D.movePinBefore(["a", "b", "c"], "a", "zz"), ["b", "c", "a"], "B6c 없는 이웃이면 맨 뒤(자리를 잃지 않는다)");
eq(D.movePinBefore(["a", "b"], "z", "b"), ["a", "z", "b"], "B6d 고정 안 된 것을 끌어오면 그 자리에 고정");
eq(D.movePinBefore(["a", "b", "c"], "b", "c"), ["a", "b", "c"], "B6e 제자리에 놓으면 같은 목록(저장할 것이 없다)");
eq(D.movePinBefore(["tasks", "files", "knowledge", "web", "timeline"], "timeline", "web"), ["tasks", "files", "knowledge", "timeline", "web"], "B6f 좁힌 화면(웹·타임라인만 보임)에서 순서를 바꿔도 안 보이는 셋은 제자리");

// 끼울 자리 (Q1–Q5) — 고정 줄의 축 방향 [시작, 끝]. 간격 4.
const sp = [[0, 40], [44, 84], [88, 128]];
eq([D.pinSlot(10, sp, true, 4), D.pinSlot(21, sp, true, 4), D.pinSlot(65, sp, true, 4), D.pinSlot(500, sp, true, 4)], [0, 1, 2, 3], "Q1 고정 앱 — 가운데를 넘으면 그 뒤로(맨 끝 너머면 맨 뒤)");
eq(D.pinSlot(132, sp, false, 4), 3, "Q2 고정 안 한 앱 — 고정 줄 끝 + 간격(경계)까지는 맨 뒤에 고정");
eq(D.pinSlot(133, sp, false, 4), -1, "Q3 고정 안 한 앱 — 그 너머(제 구획에서 흔든 것)는 끼울 자리 없음");
eq(D.pinSlot(0, [], false, 4), -1, "Q4 고정 줄이 비었으면 고정 안 한 앱은 끼울 곳이 없다(메뉴로 고정)");
eq(D.pinSlot(0, [], true, 4), 0, "Q5 고정 앱 혼자면 제자리(0)");

// 독에 서는 것 (I1–I3)
const tabs = [{ key: "files", type: "files" }, { key: "editor", type: "editor" }, { key: "web", type: "web" }, { key: "editor#2", type: "editor" }, { key: "web#2", type: "web" }];
const items = D.dockItems(["tasks", "files", "web"], tabs, "web#2");
eq(items.map((i) => [i.type, i.pinned, i.keys, i.active]), [
  ["tasks", true, [], false], ["files", true, ["files"], false], ["web", true, ["web", "web#2"], true], ["editor", false, ["editor", "editor#2"], false],
], "I1 고정한 앱(정한 순서) 다음에 떠 있지만 고정 안 한 앱 — 인스턴스는 탭 줄 순서로 한 아이콘에");
eq(D.dockItems([], [{ key: "a", type: "x" }, { key: "a", type: "x" }], null)[0].keys, ["a"], "I2 같은 열쇠는 한 번만");
check(D.dockItems(["web"], tabs, null).every((i) => !i.active), "I3 켜진 탭이 없으면 켜진 앱도 없다");
eq(D.dockItems([], [], null), [], "I4 고정도 탭도 없으면 빈 독");

// 누르기 (C1–C6)
const web = items.find((i) => i.type === "web");
eq(D.dockClick(items[0], "web#2", []), { kind: "open" }, "C1 안 떠 있으면 연다");
eq(D.dockClick(web, "web", []), { kind: "show", key: "web#2" }, "C2 이미 켜진 앱을 또 누르면 다음 인스턴스로(⌘` — 같은 앱의 창을 돌아가며)");
eq(D.dockClick(web, "web#2", []), { kind: "show", key: "web" }, "C2b 끝에서는 처음으로 돈다");
eq(D.dockClick(items[1], "files", []), { kind: "show", key: "files" }, "C3 하나뿐이면 그대로");
eq(D.dockClick(web, "files", ["editor", "web#2", "web"]), { kind: "show", key: "web#2" }, "C4 켜져 있지 않으면 가장 최근에 본 인스턴스");
eq(D.dockClick(web, "files", []), { kind: "show", key: "web" }, "C5 본 기록이 없으면 처음 것");
eq(D.dockClick(web, "files", [], { fresh: true, multi: true }), { kind: "open" }, "C6 ⌥-클릭 · «새로 열기» — 여럿 띄울 수 있는 앱은 새로");
eq(D.dockClick(items[1], "web", [], { fresh: true, multi: false }), { kind: "show", key: "files" }, "C6b 하나만 사는 앱은 새로 열지 않고 보여 준다");

// 자리 (L1–L9) — 이음매 x=900, 곁칸은 오른쪽, 세로 구간 142~900(머리 줄 아래 ~ 바닥). 곁칸 안쪽으로 40 넘게 들이면 곁칸 아래.
const g = { seam: 900, side: "right", top: 142, bottom: 900 };
eq(D.placeDock(910, 142 + 758 * 0.3, g), { home: "seam", at: 0.3 }, "L1 경계선 가까이(곁칸 안쪽 10) 놓으면 이음매 — 자리는 세로 구간의 비율");
eq(D.placeDock(1100, 500, g), { home: "float" }, "L2 곁칸 안쪽 깊이 놓으면 곁칸 아래(at 은 안 돌려준다 — 이음매에서 고른 자리를 지우지 않게)");
eq([D.placeDock(940, 500, g).home, D.placeDock(941, 500, g).home], ["seam", "float"], "L3 경계 — 안쪽 정확히 40 은 이음매, 41 은 곁칸 아래");
eq(D.placeDock(700, 142 + 758 * 0.8, g), { home: "seam", at: 0.8 }, "L4 세션 쪽에 놓아도 이음매(경계선은 세션에서도 손이 닿는 경첩)");
eq([D.placeDock(800, 500, { ...g, side: "left" }).home, D.placeDock(870, 500, { ...g, side: "left" }).home, D.placeDock(960, 500, { ...g, side: "left" }).home], ["float", "seam", "seam"],
  "L5 자리바꿈(곁칸이 왼쪽 · sw-left) — 안쪽은 반대 방향으로 잰다(왼쪽으로 100 들이면 곁칸 아래, 30 이면 이음매, 오른쪽 세션 쪽도 이음매)");
eq(D.placeDock(910, 142 + 758 * 0.56, g).at, 0.5, "L6 경계 — 가운데 +0.06 은 가운데로 붙는다(맥 창 끌기의 가운데 자석)");
eq(D.placeDock(910, 142 + 758 * 0.57, g).at, 0.57, "L6b 경계 — +0.07 은 놓은 자리 그대로");
eq([D.placeDock(910, 0, g).at, D.placeDock(910, 2000, g).at], [0, 1], "L7 세로 구간 밖에 놓으면 끝으로 자른다");
eq(D.placeDock(905, 500, { ...g, seam: null }), { home: "float" }, "L8 이음매가 없으면(서랍 · 카드 · 접힘) 어디에 놓아도 곁칸 아래");
const z = D.placeDock(900, 10, { seam: 900, side: "right", top: 10, bottom: 10 });
check(Number.isFinite(z.at) && z.at >= 0 && z.at <= 1, "L9 세로 구간이 0(접힌 칸)이어도 자리가 NaN 이 아니다", J(z));

// 확대 (M1–M5)
near(D.magnify(0, { max: 1.6, range: 90 }), 1.6, "M1 마우스 바로 밑은 최대");
near(D.magnify(90, { max: 1.6, range: 90 }), 1, "M2 범위 끝은 1");
near(D.magnify(45, { max: 1.6, range: 90 }), 1.3, "M3 범위 가운데는 절반 — 코사인 종 모양");
check(D.magnify(-30, { max: 1.6, range: 90 }) === D.magnify(30, { max: 1.6, range: 90 }), "M4 좌우 대칭");
eq([D.magnify(10, { max: 1, range: 90 }), D.magnify(10, { max: 1.6, range: 0 })], [1, 1], "M5 확대를 끄면(max≤1 · 범위 0) 늘 1");

// 크기 (F1–F4)
const fo = { max: 40, min: 26, gap: 4, pad: 6, grow: 36 };
eq(D.fitIconSize(6, 1000, fo), 40, "F1 넉넉하면 최대");
eq(D.fitIconSize(6, 200, fo), 26, "F2 모자라면 최소에서 멈춘다((200−36−12−20)/6 = 22 → 26)");
eq(D.fitIconSize(6, 300, fo), Math.floor((300 - 36 - 12 - 20) / 6), "F3 그 사이는 확대 몫을 남기고 나눈다");
eq(D.fitIconSize(0, 300, fo), 40, "F4 아이콘이 없으면 최대(나누지 않는다)");
//  곁칸 아래 독(③)은 곁칸 폭을 따라 커지고 작아진다(원준 10-01) — 아이콘 여섯 · 구분선 하나(9) · 안 여백 8 · 바깥 여백 8 · 간격 4 · 확대 몫 1.75.
const ff = { min: 26, max: 48, gap: 4, pad: 8, margin: 8, extra: 9, grow: D.MAG_GROW };
eq([D.floatIconSize(280, 6, ff), D.floatIconSize(340, 6, ff), D.floatIconSize(420, 6, ff)], [28, 36, 46], "F5 곁칸 폭을 따라 커진다 — 280 → 28 · 340 → 36 · 420 → 46");
eq([D.floatIconSize(440, 6, ff), D.floatIconSize(900, 6, ff), D.floatIconSize(120, 6, ff)], [48, 48, 26], "F6 경계 — 넓으면 최대 48 에서, 좁으면 최소 26 에서 멈춘다");
eq(D.floatIconSize(340, 6, { ...ff, grow: 0 }), 46, "F7 확대를 끄면 불어날 몫을 안 남긴다 — 같은 폭에서 더 크다");
const fw = (w) => { const k = D.floatIconSize(w, 6, ff); return 6 * k + ff.extra + 2 * ff.pad + ff.gap * 5 + D.MAG_GROW * k; };
check([280, 339, 420, 440, 600].every((w) => fw(w) <= w - 2 * ff.margin + 0.5), "F7b 확대한 독(불어난 몫까지)이 곁칸 폭 안에 든다 — 곁칸은 넘친 것을 자른다(첫 촬영: 양 끝이 잘렸다)",
  J([280, 339, 420, 440, 600].map((w) => [w, Math.round(fw(w))])));
eq(D.floatIconSize(340, 0, ff), 48, "F8 아이콘이 없으면 최대(나누지 않는다)");

// 안전 영역 (S1–S4) — 픽셀 상수가 아니라 «어느 여백이 들어가나»를 본다(상수는 DOCK_METRICS 한 자리).
const m = D.DOCK_METRICS;
eq(D.dockInset("seam", 32), { bottom: 0, top: 0, left: 0, right: 0 }, "S1 이음매 독은 아무도 안 비킨다(경계선 위에 떠 있다) — 세로를 하나도 안 쓴다");
eq(D.dockInset("float", 36), { bottom: 36 + 2 * m.pad + m.dot + 2 * m.margin, top: 0, left: 0, right: 0 }, "S2 곁칸 아래 독 — 아이콘 + 안 여백×2 + 점 줄 + 바깥 여백×2 만큼 부품이 물러선다(macOS: 창은 독 위까지)");
eq([D.dockThickness("seam", 32), D.dockThickness("float", 36)], [32 + 2 * m.pad, 36 + 2 * m.pad + m.dot], "S3 두께 — 이음매는 점 줄이 알약 길이 쪽이라 안 든다 · 곁칸 아래는 점 줄까지");
check(D.dockInset("float", 36).bottom <= 72, "S4 곁칸 기본 폭(아이콘 36)의 곁칸 아래 독이 바닥에서 먹는 높이는 72px 이하 — 세로가 귀하다", `실제 ${D.dockInset("float", 36).bottom}`);

// 색 (K1)
eq([D.appColor("files"), D.appColor("tasks"), D.appColor("nope")], ["src", "proj", "apps"], "K1 앱 색은 앱 아이콘 토큰을 빌린다 — 모르는 종류는 회색");

// ── 2부: 배선(소스) ──────────────────────────────────────────────────────────
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const PANES = read(process.env.PANES_SRC || path.join(root, "web/v2/panes.ts"));
const DOCK = read(process.env.DOCK_UI_SRC || path.join(root, "web/v2/pane-dock.ts"));
check(PANES.length > 0, "W0 배선: 셸 소스를 읽었다(비었으면 아래가 전부 헛돈다)");
check(/mountDock\(/.test(PANES), "W1 셸이 곁칸에 독을 세운다(mountDock)");
check(/dock\??\.sync\(\)/.test(PANES), "W2 곁칸을 다시 그릴 때마다 독도 맞춘다(dock.sync)");
check(/\bdockClick\(/.test(DOCK), "W3 누르기는 규칙(dockClick)을 탄다 — 인스턴스 순환이 한 곳에서만 정해진다");
check(/\bplaceDock\(/.test(DOCK), "W4 끌어 놓기는 규칙(placeDock)을 탄다 — 이음매냐 곁칸 아래냐가 한 곳에서만 정해진다");
check(/\bdockInset\(/.test(DOCK), "W5 부품이 비키는 폭은 규칙(dockInset)에서");
check(/shellPrefStore\('lively_v2_dock', 'map'\)/.test(DOCK) && /shellPrefStore\('lively_v2_dock_apps', 'list'\)/.test(DOCK), "W6 독 설정·고정 목록은 계정에(사람이 정한 것 — 기기마다 다시 맞추지 않는다)");
check(/--ac/.test(PANES) && /appColor\(/.test(PANES), "W7 탭도 같은 앱 색(--ac)을 쓴다 — 독과 탭이 한 앱으로 읽힌다");
//  #4443 리뷰(2026-10-01) 반영의 배선 — 동작은 pane-dock-runtime(메뉴 세 길 · 넘침 · 끌기 방어 · 초점 · refreshDocks)이 실제 크롬에서 잰다.
const MAIN = read(process.env.MAIN_SRC || path.join(root, "web/v2/main.ts"));
const MOBILE = read(process.env.MOBILE_CSS || path.join(root, "public/styles/50-mobile.css"));
const reload = /const reloadShellPrefs = \(\): void => \{([\s\S]*?)\n  \};/.exec(MAIN);
check(!!reload && /\brefreshDocks\(\)/.test(reload[1]) && /import \{ refreshDocks \} from '\.\/pane-dock\.js'/.test(MAIN), "G2 캐시가 같은 창에서 서버 값이 되면(부팅 동기 · 저장 응답) 셸이 독도 다시 읽힌다(reloadShellPrefs → refreshDocks)");
const fitSrc = /function fit\(p: Pane\): void \{([\s\S]*?)\n  \}/.exec(PANES);
check(!!fitSrc && /stripRoom\(/.test(fitSrc[1]) && /paddingLeft/.test(fitSrc[1]) && /paddingRight/.test(fitSrc[1]) && /columnGap/.test(fitSrc[1]) && !/planTabs\(tabsIn, (full|p\.tabs\.clientWidth)\)/.test(fitSrc[1]),
  "J4 탭 폭 셈(fit)은 띠 안 여백·간격을 뺀 폭(stripRoom)으로 — clientWidth 를 그대로 넘기지 않는다");
check(!/addEventListener\('contextmenu'/.test(DOCK) && /bindCtx\(b, \(\) => itemMenu\(/.test(DOCK) && /only: true/.test(DOCK), "W10 독 메뉴는 셸의 메뉴 엔진 한 길로(bindCtx · only) — 제 contextmenu 를 따로 듣지 않는다(메뉴 키·길게 누르기가 같은 메뉴에 닿게)");
const q16 = MOBILE.indexOf("input.pn-dock-more-q { font-size: 16px; }");
const block = q16 < 0 ? -1 : MOBILE.lastIndexOf("@media", q16);      // 그 규칙을 품은 블록(640px 블록이 여럿이다)
check(q16 > 0 && block >= 0 && MOBILE.startsWith("@media (max-width: 640px)", block), "K1 폰(≤640px)에서 [더보기]의 앱 찾기 칸은 16px — iOS 가 초점에서 확대하지 않는 하한(창이 열리며 초점이 들어간다)");

//  이음매 판(10-01)의 배선
check(/seam: \(\) => \(narrow\(\) \|\| !lay\.sideOn \|\| body\.classList\.contains\('cm'\) \? null : splitX\)/.test(PANES),
  "W8 셸이 독에 이음매(세션 열과 곁칸 사이 분할선)를 넘긴다 — 서랍 · 접힘 · 카드 모드엔 없다(독이 곁칸 아래로 선다)");
const DOCK_CSS = read(process.env.DOCK_CSS || path.join(root, "public/styles/42-v2-dock.css"));
check(!/pn-dock-grip|pn-dock-reveal|data-mode="bar"|자동으로 가리기/.test(DOCK) && !/pn-dock-grip|pn-dock-reveal|data-mode="bar"/.test(DOCK_CSS),
  "W11 손잡이(⋮⋮) · 테두리 막대(2안) · 자동으로 가리기는 걷었다(원준 10-01 «바닥 왼쪽 탭 … 없애줘») — 알약 자체가 손잡이");
//  밑에서 튀어나오지 않기(10-01): 탭을 «보이게» 하는 셸의 길이 모두 bringUp(→ lib showZone)을 지난다 — 닫힌 아래 칸을 펼치지 않는다.
const bringUp = /function bringUp\(zone: Zone, key: TabKey\): void \{([\s\S]*?)\n  \}/.exec(PANES);
check(!!bringUp && /showZone\(zone, \{ bottomOn: lay\.bottomOn, narrow: narrow\(\) \}\)/.test(bringUp[1]) && /moveTab\(key, zone, 'side'\)/.test(bringUp[1]),
  "W12 탭을 보이게 하는 길(bringUp)은 닫힌 아래 칸이면 곁칸으로 옮겨 켠다(lib showZone · moveTab) — 원준 10-01 «밑에서 나오는거 없게»");
check(/show: \(k\) => bringUp\(zoneOf\(k\) \|\| 'side', k\)/.test(PANES) && !/show: \(k\) => \{ const z = zoneOf\(k\) \|\| 'side'; revealZone\(z\)/.test(PANES),
  "W12b 독의 «보여 주기» 는 bringUp — 타임라인(옛 기본 배치에선 닫힌 아래 칸)을 눌러도 터미널 밑에서 튀어나오지 않는다");
check(/if \(!found\) \{ addPart\('side', type\); return; \}\s*(?:if \(zoneVisible\(found\.zone\) && reselect\(found\.zone, found\.key\)\) return;\s*)?bringUp\(found\.zone, found\.key\);/.test(PANES) && /const key = lay\[z\]\.find\(\(k\) => tabBase\(k\) === 'web'\)!;\s*bringUp\(z, key\);/.test(PANES)
  && /if \(added\.length\) \{ bringUp\(z, SESSAPP_TAB\); return; \}/.test(PANES) && /if \(!z\) return;\s*bringUp\(z, SESSAPP_TAB\);/.test(PANES)
  && /const zone: Zone = found \? showZone\(found\.zone, \{ bottomOn: lay\.bottomOn, narrow: narrow\(\) \}\) : landZone\(findTab\('editor'\)\?\.zone \?\? 'side'\);/.test(PANES),   // #4443 10-05 — 새 뷰어는 아래 칸에 아예 안 선다(landZone)
  "W12c 머리줄 단추(showPart) · 웹 칸 · 붙은 앱(새로 붙음 · 다시 누름) · 파일 뷰어도 같은 길 — 닫힌 아래 칸을 펼치지 않는다");
//  곁칸 아래 독은 내용 위에 떠 있다(원준 10-02 «뒤에 그냥 뭐 없이 둥둥 떠있게») — 본문을 올리지 않고, 목록은 끝에만 · 입력칸 앱은 앱 끝에 빈 자리.
//   런타임(pane-dock-runtime R2b · R2c)은 자료 · 프로젝트 둘로 재고, 여기선 나머지 앱의 목록 상자가 목록에서 빠지지 않았는지 본다.
const PANES_CSS = read(process.env.PANES_CSS || path.join(root, "public/styles/42-v2-panes.css"));
check(/\.pn-pane\[data-zone="side"\] > \.pn-pane-body \{ padding: var\(--pn-dock-t, 0px\) var\(--pn-dock-r, 0px\) 0 var\(--pn-dock-l, 0px\); \}/.test(PANES_CSS)
  && !/pn-pane-body \{[^}]*var\(--pn-dock-b/.test(PANES_CSS),
  "W13 곁칸 본문은 독만큼 올리지 않는다 — 독 뒤에 하얀 띠가 안 생긴다");
const spacer = /\.pn-pane\[data-zone="side"\] :is\(([^)]*)\)::after,\s*\n\.pn-pane\[data-zone="side"\] :is\(([^)]*)\)::after \{ content: ""; display: block; flex: none; grid-column: 1 \/ -1; height: var\(--pn-dock-b, 0px\); \}/.exec(PANES_CSS);
const lists = spacer ? spacer[1].split(",").map((x) => x.trim()) : [], lifts = spacer ? spacer[2].split(",").map((x) => x.trim()) : [];
check([".pn-fbody", ".pn-knlist", ".pn-knr-scroll", ".pn-tl .tl-scroll", ".pn-prev", ".pn-md", ".pn-ed-pre", ".pn-ed-pick2 .pn-flist", ".pn-apps-grid", ".fx-scroll"].every((c) => lists.includes(c))
  && [".pn-tk", ".pn-liv"].every((c) => lifts.includes(c)) && /\.pn-pane\[data-zone="side"\] \.pn-ed-ta \{ padding-bottom: calc\(12px \+ var\(--pn-dock-b, 0px\)\); \}/.test(PANES_CSS),
  "W13b 목록 상자(자료 · 지식 목록 · 지식 읽기 · 타임라인 · 미리보기 · 뷰어 · 앱 · 세션 파일)는 끝에만 독 두께만큼 빈 자리 · 입력칸 앱(프로젝트 · 리브)은 앱 끝에 · 고치기 칸은 아래 안 여백", JSON.stringify({ lists, lifts }));
//  곁칸 아래 독에도 손잡이(원준 10-02 «이음새 있을 때랑 똑같이») — 서랍만 없다 · 크기와 놓일 자리 윤곽이 손잡이 몫을 안다.
check(/if \(!host\.narrow\(\)\) kids\.push\(handleEl\(home\)\);/.test(DOCK) && !/if \(home === 'seam' && !host\.narrow\(\)\) kids\.push\(handleEl/.test(DOCK)
  && /extra: extra \+ \(host\.narrow\(\) \? 0 : HANDLE_FLOAT\), grow \}/.test(DOCK) && /SEP \+ HANDLE_FLOAT;\n\s*const s = floatIconSize\(W, n, \{[^}]*extra, grow/.test(DOCK) && /const w = Math\.min\(W - 2 \* M\.margin, floatWidth\(n, s, extra\)\)/.test(DOCK),
  "W14 손잡이는 이음매 · 곁칸 아래 둘 다(서랍만 없다) — 곁칸 아래 크기와 끌 때의 윤곽이 손잡이 몫(HANDLE_FLOAT)을 셈한다");
//  곁칸 아래 좌우 자리(원준 10-07) — 자리 · 끌어 놓기 · 윤곽이 모두 규칙(floatCenter · floatAt)을 타고, 자리를 못 정했으면 열쇠째 안 적는다.
check(/st\.left = floatCenter\(host\.narrow\(\) \? DOCK_DEFAULTS\.fx : prefs\.fx, lo, hi\) \+ 'px';/.test(DOCK) && !/st\.left = pane\.clientWidth \/ 2 \+ 'px';/.test(DOCK), "W15 곁칸 아래 독은 바닥의 fx 자리에 선다(늘 한가운데가 아니다)");
check(/const fx = floatAt\([^;]*f\.lo, f\.hi\);\n\s*if \(fx !== undefined\) target\.fx = fx;/.test(DOCK), "W15b 끌어 놓은 좌우 자리는 규칙(floatAt)이 정한다 — 못 정하면 열쇠째 뺀다(undefined 를 적으면 옛 자리가 지워진다)");
check(/floatCenter\(t\.fx \?\? prefs\.fx, f\.lo, f\.hi\) - w \/ 2/.test(DOCK), "W15c 놓일 자리 윤곽도 같은 좌우 자리에 그린다");
check(/const half = w \/ 2 \+ \(magOn\(\) \? \(MAG_GROW \* s\) \/ 2 : 0\) \+ M\.margin;/.test(DOCK), "W15d 좌우 구간은 확대로 불어날 몫(양쪽 반씩)과 바깥 여백을 남긴다 — 끝에 둔 독을 확대해도 곁칸 테두리에서 안 잘린다");
console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
