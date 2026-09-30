// #4443 «곁칸 → 앱의 실행 화면» — 곁칸 독의 규칙(web/lib/pane-dock.ts) + 셸 배선(web/v2/panes.ts · pane-dock.ts).
//
//  원준(2026-09-30): "3안으로 갈건데 독 드래그하면 2안 위치에 위치시킬 수도 있게끔. 테두리쪽 원하는 곳 어디든 …
//   같은 앱 여러개 열릴 수도 있게 … 맥의 독 참고해서 모션이나 애니메이션이나 우클릭 기능이나 더보기 눌렀을 때의 화면까지."
//
//  1부 — 순수 규칙(엣지 표의 행마다 단언 하나 이상). 2부 — 셸이 그 규칙을 실제로 부르는지(소스 배선).
//  화면(독의 자리·크기·곁칸 머리 높이)은 pane-dock-runtime.test.mjs 가 실제 크롬에서 잰다.
//  fail-first(2026-09-30): 1부는 PANE_DOCK_SRC 로 변형본을 물려 빨간불을 봤다 — 순환(다음 인스턴스)을 «처음 것»으로 ·
//   막대 문턱 `<=`→`<` · 가운데 자석 제거 · 동점 우선순위 뒤집기 · 안전 영역에서 hide 무시 · «다 뺐다» 표식 무시.
//   2부는 배선 전의 panes.ts(git show HEAD)에 물려 빨간불을 봤다.
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
// 설정 읽기·쓰기 (P1–P6)
eq(D.readDockPrefs(undefined), { edge: "bottom", at: 0.5, mode: "float", hide: false, mag: true }, "P1 적은 적 없으면 기본 — 바닥 가운데에 떠 있는 독, 확대 켬, 가리기 끔");
eq(D.readDockPrefs({ edge: "left", at: "0.30", mode: "bar", hide: "1", mag: "0" }), { edge: "left", at: 0.3, mode: "bar", hide: true, mag: false }, "P2 적어 둔 대로");
eq(D.readDockPrefs({ edge: "diagonal", at: "x", mode: "?", hide: "yes", mag: 3 }), { edge: "bottom", at: 0.5, mode: "float", hide: false, mag: true }, "P3 깨진 칸은 칸마다 기본값(한 칸이 깨져도 나머지는 산다)");
eq(D.readDockPrefs({ edge: "top", at: "x" }).edge, "top", "P3b 한 칸만 깨지면 나머지 칸은 적힌 대로");
eq([D.readDockPrefs({ at: "1.7" }).at, D.readDockPrefs({ at: "-2" }).at, D.readDockPrefs({ at: "" }).at], [1, 0, 0.5], "P4 자리는 0~1 로 자르고, 빈 값은 가운데");
const p5 = { edge: "right", at: 0.123, mode: "float", hide: true, mag: false };
eq(D.readDockPrefs(D.writeDockPrefs(p5)), { ...p5, at: 0.12 }, "P5 적은 것을 다시 읽으면 같다(자리는 소수 둘째 자리)");
check(Object.values(D.writeDockPrefs(p5)).every((v) => typeof v === "string" && v.length <= 64), "P6 서버 map 저장소 규격 — 값은 문자열 64자 이내");

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

// 자리 (L1–L8) — 곁칸 상자 (1000,100) 340×800
const box = { left: 1000, top: 100, width: 340, height: 800 };
eq(D.placeFromPoint(1175, 850, box), { edge: "bottom", at: 0.5, mode: "float" }, "L1 바닥 근처 가운데 → 바닥 · 가운데(자석) · 떠 있음");
eq(D.placeFromPoint(1100, 885, box), { edge: "bottom", at: 0.29, mode: "bar" }, "L2 바닥에 바짝(22px 이내) → 막대(2안), 자리는 가로 비율");
eq(D.placeFromPoint(1100, 878, box).mode, "bar", "L2b 경계 — 정확히 22px 은 막대");
eq(D.placeFromPoint(1100, 877, box).mode, "float", "L2c 경계 — 23px 은 떠 있음");
eq(D.placeFromPoint(1030, 300, box), { edge: "left", at: 0.25, mode: "float" }, "L3 왼쪽 근처 → 왼쪽 · 세로 비율");
eq(D.placeFromPoint(1050, 850, { left: 1000, top: 800, width: 100, height: 100 }).edge, "bottom", "L4 거리가 같으면 바닥이 이긴다(기본 자리)");
eq(D.placeFromPoint(1030, 830, { left: 1000, top: 800, width: 100, height: 100 }).edge, "top", "L4b 위와 왼쪽이 같으면(둘 다 30px, 바닥·오른쪽 70px) 위가 이긴다(바닥 › 위 › 왼 › 오른)");
eq(D.placeFromPoint(1500, 500, box), { edge: "right", at: 0.5, mode: "bar" }, "L5 곁칸 밖에 놓으면 가장 가까운 테두리 · 막대");
eq(D.placeFromPoint(1000 + 340 * 0.56, 850, box).at, 0.5, "L6 경계 — 가운데 +0.06 은 가운데로 붙는다");
eq(D.placeFromPoint(1000 + 340 * 0.57, 850, box).at, 0.57, "L6b 경계 — +0.07 은 놓은 자리 그대로");
eq(D.placeFromPoint(1175, 120, box).edge, "top", "L7 위 테두리도 선다");
const z = D.placeFromPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 });
check(Number.isFinite(z.at) && z.at >= 0 && z.at <= 1, "L8 상자 폭·높이가 0(접힌 칸)이어도 자리가 NaN 이 아니다", J(z));

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

// 안전 영역 (S1–S5) — 픽셀 상수가 아니라 «어느 여백이 들어가나»를 본다(상수는 DOCK_METRICS 한 자리).
const s = 32, m = D.DOCK_METRICS;
const core = s + 2 * m.pad + m.dot;
eq(D.dockInset({ edge: "bottom", at: 0.5, mode: "float", hide: true, mag: true }, s), { bottom: 0, top: 0, left: 0, right: 0 }, "S1 가려 두면 부품이 자리를 다 쓴다");
eq(D.dockInset({ edge: "bottom", at: 0.5, mode: "float", hide: false, mag: true }, s), { bottom: core + 2 * m.margin, top: 0, left: 0, right: 0 }, "S2 떠 있는 독(바닥) — 아이콘 + 안 여백×2 + 점 + 바깥 여백×2 만큼 부품이 물러선다(macOS: 창은 독 위까지)");
eq(D.dockInset({ edge: "bottom", at: 0.5, mode: "bar", hide: false, mag: true }, s).bottom, core + m.label, "S3 막대(바닥)는 이름 줄까지, 바깥 여백 없이(테두리에 붙는다)");
eq(D.dockInset({ edge: "left", at: 0.5, mode: "bar", hide: false, mag: true }, s), { bottom: 0, top: 0, left: core, right: 0 }, "S3b 막대(옆)는 이름 없이 — 세로를 하나도 안 쓴다");
eq(D.dockInset({ edge: "top", at: 0.5, mode: "float", hide: false, mag: true }, s).top, core + 2 * m.margin, "S4 위에 두면 위가 물러선다");
check(core + 2 * m.margin <= 60, "S5 떠 있는 독(아이콘 32)이 바닥에서 먹는 높이는 60px 이하 — 세로가 귀하다(원준 2026-09-30)", `실제 ${core + 2 * m.margin}`);

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
check(/\bplaceFromPoint\(/.test(DOCK), "W4 끌어 놓기는 규칙(placeFromPoint)을 탄다");
check(/\bdockInset\(/.test(DOCK), "W5 부품이 비키는 폭은 규칙(dockInset)에서");
check(/shellPrefStore\('lively_v2_dock', 'map'\)/.test(DOCK) && /shellPrefStore\('lively_v2_dock_apps', 'list'\)/.test(DOCK), "W6 독 설정·고정 목록은 계정에(사람이 정한 것 — 기기마다 다시 맞추지 않는다)");
check(/--ac/.test(PANES) && /appColor\(/.test(PANES), "W7 탭도 같은 앱 색(--ac)을 쓴다 — 독과 탭이 한 앱으로 읽힌다");

console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
