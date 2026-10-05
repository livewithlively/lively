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

// 탭이 나눠 쓸 폭 (J3) — #4443 탭 새 옷: 띠에 안 여백과 탭 사이 간격이 생겼다. clientWidth 를 그대로 넘기면 셈이 실제보다 넉넉하다.
eq(L.stripRoom(340, 2, 2, 2, 6), 340 - 4 - 10, "J3 안 여백 둘 + 간격 n−1 개를 뺀다(탭 여섯 = 간격 다섯)");
eq([L.stripRoom(340, 2, 2, 2, 1), L.stripRoom(340, 2, 2, 2, 0)], [336, 336], "J3b 탭이 하나·없음이면 간격은 없다");
eq(L.stripRoom(10, 2, 2, 2, 6), 0, "J3c 모자라면 0(음수 폭을 planTabs 에 넘기지 않는다)");

// 보이게 할 칸 (V1–V4) — #4443 원준(10-01): «타임라인 쟨 왜 터미널 밑에서 갑자기 앱이 튀어나와. 밑에서 나오는거 없게해줘»
eq(L.showZone("bottom", { bottomOn: false, narrow: false }), "side", "V1 닫힌 아래 칸의 탭을 보이려면 아래 칸을 펼치지 않고 곁칸으로(터미널 밑에서 튀어나오지 않는다)");
eq(L.showZone("bottom", { bottomOn: true, narrow: false }), "bottom", "V2 아래 칸이 열려 있으면 거기서 켠다(이미 보이는 자리 — 사람이 펴 두고 쓰는 중)");
eq(L.showZone("bottom", { bottomOn: false, narrow: true }), "bottom", "V3 좁은 폭은 서랍이 아래 칸 탭도 보여 주므로 그대로(배치를 안 건드린다)");
eq([L.showZone("side", { bottomOn: false, narrow: false }), L.showZone("main", { bottomOn: false, narrow: false })], ["side", "main"], "V4 곁칸 · 가운데 칸은 그대로");

// 아래 칸이 보이나 (BS1–BS5) — #4443 원준(10-01) 후속: 아래 칸은 사람이 거기 넣은 것이 있을 때만 있다
eq(L.bottomShown({ bottomOn: true, count: 1, narrow: false }), true, "BS1 열려 있고 탭 하나(경계) — 보인다");
eq(L.bottomShown({ bottomOn: true, count: 0, narrow: false }), false, "BS2 열림을 기억해도 탭이 없으면(경계) 빈 칸을 세우지 않는다");
eq(L.bottomShown({ bottomOn: false, count: 3, narrow: false }), false, "BS3 닫혀 있으면 탭이 있어도 안 보인다");
eq(L.bottomShown({ bottomOn: true, count: 2, narrow: true }), false, "BS4 좁은 폭은 서랍이 아래 칸 탭을 든다 — 아래 칸은 안 보인다");
eq(L.bottomShown({ bottomOn: false, count: 0, narrow: true }), false, "BS5 닫힘 · 빈 칸 · 좁은 폭 — 안 보인다");

// 새 탭이 설 칸 (LZ1–LZ3) — #4443 원준(10-05) «아래칸에 여는거 우리 안하기로 했잖음»: 아래 칸은 새 탭을 받지 않는다(줄기만 한다)
eq(L.landZone("bottom"), "side", "LZ1 아래 칸으로 가려던 새 탭은 곁칸에 선다");
eq([L.landZone("side"), L.landZone("main")], ["side", "main"], "LZ2 곁칸 · 가운데 칸은 그대로");
eq(["", undefined, null, "BOTTOM", {}].map((z) => L.landZone(z)), ["side", "side", "side", "side", "side"], "LZ3 그 밖의 값(빈 값 · 엉뚱한 값)은 곁칸 — 아래 칸으로 새지 않는다");
// 물려받는 배치의 아래 칸 걷기 (FB1–FB4) — 저장한 적 없는 프로젝트가 last 를 물려받을 때 옛 아래 칸을 새로 세우지 않는다(격리 리뷰)
const inh = { main: ["sessions"], side: ["files", "knowledge"], bottom: ["timeline", "web"], act: { main: "sessions", side: "knowledge", bottom: "web" }, sideOn: true, bottomOn: true };
const fb = L.foldBottom(inh);
eq([fb.side, fb.bottom, fb.act, fb.sideOn, fb.bottomOn], [["files", "knowledge", "timeline", "web"], [], { main: "sessions", side: "knowledge", bottom: null }, true, true], "FB1 아래 칸의 탭은 곁칸 뒤로(순서 그대로) · 아래 칸은 비고 그 켜짐도 비운다 · 곁칸 켜짐 · 나머지는 그대로");
eq(inh.bottom, ["timeline", "web"], "FB2 받은 배치는 고치지 않는다(새 판을 돌려준다)");
eq(L.foldBottom({ ...inh, side: ["files", "web"] }).side, ["files", "web", "timeline"], "FB3 곁칸에 이미 있는 열쇠는 두 번 세우지 않는다");
const empty = { ...inh, bottom: [], act: { ...inh.act, bottom: null } };
check(L.foldBottom(empty) === empty, "FB4 아래 칸이 비었으면(경계) 받은 것을 그대로 돌려준다");

// 옛 기본값 걷기 (PK1–PK12) — 닫힌 아래 칸에 타임라인 하나만 숨겨 둔 옛 기본 배치를 한 번만 걷는다
const parked = (extra = {}) => ({ main: ["sessions"], side: ["files", "tasks"], bottom: ["timeline"], act: { main: "sessions", side: "files", bottom: "timeline" }, sideOn: true, bottomOn: false, ...extra });
let pk = L.unparkBottom({ last: parked() });
eq([pk.store.last.bottom, pk.store.last.act.bottom, pk.cleared, pk.changed, pk.store.seeded.bottom], [[], null, 1, true, 1], "PK1 닫힌 아래 칸의 타임라인 하나 — 걷고 켜짐도 비운다 · 표식");
eq([pk.store.last.side, pk.store.last.main], [["files", "tasks"], ["sessions"]], "PK1b 다른 칸은 손대지 않는다");
const noFlag = parked(); delete noFlag.bottomOn;
eq(L.unparkBottom({ last: noFlag }).store.last.bottom, [], "PK2 bottomOn 이 없으면(옛 판) 닫힘으로 본다 — 걷는다");
eq(L.unparkBottom({ last: parked({ bottomOn: true }) }).store.last.bottom, ["timeline"], "PK3 열려 있으면 사람이 펴 두고 쓰는 것 — 그대로");
eq(L.unparkBottom({ last: parked({ bottom: ["timeline", "web"] }) }).store.last.bottom, ["timeline", "web"], "PK4 다른 탭이 함께 있으면 사람이 고른 배치 — 그대로");
eq(L.unparkBottom({ last: parked({ bottom: ["web"], act: { main: "sessions", side: "files", bottom: "web" } }) }).store.last.bottom, ["web"], "PK5 타임라인이 아닌 탭 하나 — 그대로");
pk = L.unparkBottom({ last: parked({ bottom: [] }) });
eq([pk.store.last.bottom, pk.cleared, pk.changed], [[], 0, true], "PK6 이미 빈 아래 칸 — 걷을 것 없음(표식만)");
pk = L.unparkBottom({ last: parked(), p: { 1: parked(), 2: parked({ bottomOn: true }) } });
eq([pk.store.last.bottom, pk.store.p[1].bottom, pk.store.p[2].bottom, pk.cleared], [[], [], ["timeline"], 2], "PK7 프로젝트마다 — 옛 기본만 걷고 열린 칸은 그대로");
pk = L.unparkBottom({ last: parked(), seeded: { bottom: 1 } });
eq([pk.store.last.bottom, pk.changed, pk.cleared], [["timeline"], false, 0], "PK8 이미 걷었으면(표식) 손대지 않는다 — 그 뒤 사람이 둔 타임라인은 사람이 고른 것");
eq([L.unparkBottom({}).changed, L.unparkBottom({}).store.seeded.bottom, L.unparkBottom(null).store.seeded.bottom, L.unparkBottom(null).cleared], [true, 1, 1, 0], "PK9 빈 저장소 · null — 던지지 않고 표식만 찍는다");
eq(L.unparkBottom({ last: parked(), seeded: { tasks: 1 } }).store.seeded, { tasks: 1, bottom: 1 }, "PK10 태스크 들이기 표식(seeded.tasks)은 그대로 두고 함께 찍는다");
const broken = { last: { main: ["sessions"], bottom: "timeline" }, p: { 3: null, 4: { main: ["sessions"], bottom: ["timeline"] } } };
let brokenOk = true; try { pk = L.unparkBottom(broken); } catch (_) { brokenOk = false; }
eq([brokenOk, pk.store.last.bottom, pk.store.p[3], pk.store.p[4].bottom, "act" in pk.store.p[4], pk.cleared], [true, "timeline", null, [], false, 1], "PK11 망가진 항목(배열 아닌 bottom · null · act 없음) — 던지지 않고, 없는 act 는 만들지 않는다");
eq(L.unparkBottom({ last: parked({ bottom: ["timeline#2"] }) }).store.last.bottom, ["timeline#2"], "PK12 사람이 만든 둘째 타임라인 — 옛 기본은 'timeline' 정확히 하나뿐");

// «앱» 탭 한 번 걷기 (DA1–DA7) — #4443 원준(10-05): «기본배치 탭에는 앱이 있는데 그거 기본배치 아니게 없애줄래? 애초에 어떻게 앱을 +해서 탭으로»
const withApps = (extra = {}) => ({ main: ["sessions"], side: ["files", "tasks", "knowledge", "apps"], bottom: [], act: { main: "sessions", side: "apps", bottom: null }, pin: ["apps", "files"], ...extra });
let da = L.dropAppsTab({ last: withApps() });
eq([da.store.last.side, da.store.last.act.side, da.store.last.pin, da.dropped, da.changed, da.store.seeded.apps], [["files", "tasks", "knowledge"], "files", ["files"], 1, true, 1], "DA1 «앱» 탭을 걷고, 켜져 있었으면 그 칸 첫 탭을 켠다 · 고정에서도 뺀다 · 표식");
eq(L.dropAppsTab({ last: withApps({ side: ["files", "apps", "apps#2"], act: { side: "files" } }) }).store.last, { main: ["sessions"], side: ["files"], bottom: [], act: { side: "files" }, pin: ["files"] }, "DA2 «앱» 이 둘(apps · apps#2)이어도 모두 · 켜짐이 다른 탭이면 그대로");
eq(L.dropAppsTab({ last: withApps({ side: ["files"], bottom: ["apps"], act: { side: "files", bottom: "apps" } }) }).store.last.act.bottom, null, "DA3 아래 칸에 있던 «앱» 도 걷는다 — 비면 켜짐도 비운다");
da = L.dropAppsTab({ last: withApps(), p: { 1: withApps(), 2: withApps({ side: ["files", "web"], act: { side: "web" }, pin: [] }) } });
eq([da.store.p[1].side, da.store.p[2].side, da.dropped], [["files", "tasks", "knowledge"], ["files", "web"], 2], "DA4 프로젝트마다 — «앱» 이 없는 배치는 그대로");
da = L.dropAppsTab({ last: withApps(), seeded: { tasks: 1, bottom: 1, apps: 1 } });
eq([da.store.last.side, da.changed, da.dropped], [["files", "tasks", "knowledge", "apps"], false, 0], "DA5 이미 걷었으면(표식) 손대지 않는다");
eq([L.dropAppsTab({}).changed, L.dropAppsTab(null).store.seeded.apps, L.dropAppsTab({ seeded: { tasks: 1 } }).store.seeded], [true, 1, { tasks: 1, apps: 1 }], "DA6 빈 저장소 · null — 던지지 않고 표식만 · 다른 표식은 그대로");
let daOk = true; try { da = L.dropAppsTab({ last: { side: "apps", main: null }, p: { 3: null, 4: { side: ["apps"] } } }); } catch (_) { daOk = false; }
eq([daOk, da.store.last.side, da.store.p[4].side, "act" in da.store.p[4]], [true, "apps", [], false], "DA7 망가진 항목(배열 아닌 칸 · null · act 없음) — 던지지 않고 없는 act 는 만들지 않는다");

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
check(/el\('span', \{ class: 'pn-tab-lead'[^)]*\}, pnIcon\(glyphAt\(ic, 14\), 'pn-i sm'\)\), el\('span', \{ class: 'pn-tab-t'/.test(tabElFn), "S1b 탭 = 아이콘 칸(pn-tab-lead) + 이름(pn-tab-t) — 런타임 기하 시험이 재는 그 구조(그림은 14px 자리 크기에 맞춘 이름, #4233)");
check(/addEventListener\('auxclick'[\s\S]*?e\.button !== 1[\s\S]*?if \(!pinned && !\(detachX && !on\)\) closeTab\(zone, key, \{ pointer: true \}\)/.test(tabElFn), "S2 휠 클릭(가운데 버튼) = 닫기 · 고정 탭과 안 켠 붙은 앱 탭은 제외");
check(/beginTabDrag\(dragHost, zone, key, w, e\)/.test(tabElFn) && !/draggable/.test(tabElFn), "S3 끌기는 포인터 끌기(pane-tabdrag) — HTML5 draggable 이 아니다");
check(/if \(consumeDragClick\(\)\) return; (?:if \(reselect\(zone, key\)\) return; )?activate\(zone, key\)/.test(tabElFn), "S3b 끌기로 끝난 누름은 켜기로 치지 않는다(«처음으로»보다도 먼저 거른다 — X5)");
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
check(firstPaint > 0 && [/const recent: Record<Zone, TabKey\[\]>/, /let closedStack: ClosedTab\[\]\[\]/, /const dragHost: TabDragHost/, /const bottomVisible = \(\): boolean/].every((re) => { const i = declAt(re); return i > 0 && i < firstPaint; }),
  "S11 탭 줄의 기억(recent · closedStack · dragHost)과 아래 칸 판정(bottomVisible, #4443)은 첫 paintAll 보다 앞에 선언된다");
check(/pin: TabKey\[\];/.test(PANES) && /pin: arr\(s\.pin\)/.test(PANES) && /normalizePins\(lay\[z\], pins\)/.test(PANES), "S10 고정 탭은 배치에 저장되고, 읽을 때 맨 앞으로 모인다");

// 아래 칸은 넣은 것이 있을 때만 · 켜진 탭을 다시 누르면 처음으로 (X1–X9) — #4443 원준(10-01)
//  «닫힌 아래 칸은 … 펼쳐지지 않습니다 → 근데 왜 <아래 칸을 켜면 (타임라인이) 거기 있습니다> ???» · «자료 아이콘을 다시 누르면 자료 맨 상단으로»
const defAt = PANES.indexOf("const DEF_LAYOUT = (): Layout => ({");
const defBlock = defAt >= 0 ? PANES.slice(defAt, PANES.indexOf("});", defAt)) : "";
check(defAt >= 0 && /bottom: \[\],/.test(defBlock) && /bottom: null/.test(defBlock) && !/'timeline'/.test(defBlock), "X1 기본 배치의 아래 칸은 비어 있다 — 타임라인을 닫힌 아래 칸에 숨겨 두지 않는다");
check(/side: \['files', 'tasks', 'knowledge'\],/.test(defBlock) && !/'apps'/.test(defBlock), "X1b 기본 배치에 «앱» 탭이 없다(원준 10-05 «기본배치 아니게 없애줄래»)");
const seedAt = PANES.indexOf("function seedLayoutStore(): void {");
const seedFn = seedAt >= 0 ? PANES.slice(seedAt, PANES.indexOf("\n}\n", seedAt)) : "";
check(/const u = unparkBottom\(r\.store\);/.test(seedFn) && /const a = dropAppsTab\(u\.store\);/.test(seedFn) && /if \(r\.changed \|\| u\.changed \|\| a\.changed\) localStorage\.setItem\(LAYOUT_KEY, JSON\.stringify\(a\.store\)\);/.test(seedFn), "X2 저장된 배치의 옛 기본(숨긴 타임라인 · «앱» 탭)을 한 번 걷어 저장한다");
const paintFn = fn("  function paintAll(): void {");
check(/const bShow = bottomVisible\(\);/.test(paintFn) && /colMain\.classList\.toggle\('no-bottom', !bShow\);/.test(paintFn) && /bottomPane\.root\.hidden = !bShow;/.test(paintFn) && /splitY\.hidden = !bShow;/.test(paintFn), "X3 아래 칸 · 경계선은 «열려 있고 탭이 있을 때만» 선다");
check(/const bottomVisible = \(\): boolean => bottomShown\(\{ bottomOn: lay\.bottomOn, count: lay\.bottom\.length, narrow: narrow\(\) \}\);/.test(PANES), "X3b 그 판정은 lib bottomShown — 탭 수는 아래 칸의 배치");
const pickFn = fn("  function openPicker(anchor: HTMLElement, zone: Zone): void {");
check(!!pickFn && !/label: '아래 칸 열기'/.test(pickFn) && !/openPicker\(anchor, 'bottom'\)/.test(pickFn) && /foot: \[\{ label: '기본 배치로'/.test(pickFn), "X4 [＋] 발치엔 «기본 배치로» 만 — «아래 칸 열기» 는 없다(원준 10-05 «아래칸에 여는거 우리 안하기로»)");
//  #4443(원준 10-05 «① 앱 서랍 + ② 의 키보드»): [＋] 는 앱 서랍(v2/pane-drawer) — 이 칸에 넣을 수 있는 것만, 타일 그림은 독과 같은 것(glyph = 부품 아이콘).
check(/(const h = )?openAppDrawer\(anchor, \{/.test(pickFn) && /more: has\(d\.type\), ic: \(\) => dockTile\(d\.icon, d\.type\), pick: \(\) => \{ addPart\(zone, d\.type\); \}/.test(pickFn)
  && /sections: \[\{ title: '사이드바 앱', note: '누르면 사이드바에 탭으로 열려요', items: side \}\]/.test(pickFn) && !/anchoredPopover\(/.test(pickFn),
  "X4c [＋] 는 앱 서랍 — «사이드바 앱»(넣을 수 있는 부품 · 독과 같은 타일 · 이미 열린 multi 는 하나 더) · stage 판은 묶음 하나");
console.log("skip  X4d «이 세션에 붙이기» 묶음 — stage 판엔 붙은 앱(#4225)이 아직 없다(main 에서 잰다)");
check(/b\.onclick = \(\) => openPicker\(b, zone\);/.test(PANES), "X4b [＋] 는 같은 고르기를 연다");
const tabMenuFn = fn("  function tabMenu(e: MouseEvent, zone: Zone, key: TabKey): void {");
check(/\.\.\.\(\['side'\] as Zone\[\]\)\.filter\(canGo\)\.map\(/.test(tabMenuFn) && !/\['side', 'bottom'\] as Zone\[\]\)\.filter\(canGo\)/.test(tabMenuFn), "X10 탭 우클릭에 «아래 칸으로 보내기» 가 없다 — 아래 칸의 옛 탭은 곁칸으로 보낼 수 있다");
check(/sessionOnly \|\| zone === 'bottom' \? null : addBtn\(zone\)/.test(PANES), "X11 아래 칸 탭 줄엔 [＋] 가 없다 — 아래 칸에는 새로 열지 않는다(남은 옛 탭만 보인다)");
const ctxAt = PANES.indexOf("bindCtxSurface(wrap, (hit, ev) => {");
const ctxEnd = ctxAt >= 0 ? PANES.indexOf("{ label: '칸에 넣기'", ctxAt) : -1;
const ctxBlock = ctxAt >= 0 && ctxEnd > ctxAt ? PANES.slice(ctxAt, ctxEnd) : "";       // 끝을 못 찾으면 비운다 — 파일 끝까지 잡으면 다른 곳의 같은 줄이 대신 맞는다(격리 리뷰)
check(/const zone: Zone = 'side';/.test(ctxBlock) && !/z === 'bottom' && !narrow\(\) \? 'bottom' : 'side'/.test(PANES), "X12 빈 자리 우클릭 «칸에 넣기» 는 어디서 불러도 곁칸에 넣는다");
//  아래 칸은 줄기만 한다(X14–X17) — 옛 배치에 남은 아래 칸이 보일 때 닿던 남은 길도 곁칸으로(lib landZone · 원준 10-05)
check(/canGo: \(key, from, to\) => !narrow\(\) && from !== to && to === 'side' && tabBase\(key\) !== 'sessions',/.test(PANES), "X14 끌어 놓기의 과녁은 곁칸뿐 — 아래 칸으로는 끌어 넣지 못한다(아래 칸의 옛 탭은 곁칸으로 끌어낼 수 있다)");
check(/label: `\$\{d\.name\} 하나 더`, icon: 'plus', run: \(\) => \{ addPart\(landZone\(zone\), type\); \}/.test(tabMenuFn), "X15 탭 우클릭 «하나 더» — 아래 칸의 옛 탭에서 불러도 새 탭은 곁칸(landZone)");
const viewerFn = fn("  function openViewerAt(d: ViewerOpen | undefined): void {");
check(/const zone: Zone = found \? showZone\(found\.zone, \{ bottomOn: lay\.bottomOn, narrow: narrow\(\) \}\) : landZone\(findTab\('editor'\)\?\.zone \?\? 'side'\);/.test(viewerFn), "X16 새 뷰어는 아래 칸에 서지 않는다 — 그 파일의 뷰어가 이미 있으면 그 탭을 켠다(닫힌 아래 칸이면 곁칸으로)");
const reopenFn = fn("  function reopenClosed(): void {");
check(/const zone: Zone = 'side';/.test(reopenFn) && !/t\.zone === 'bottom'/.test(reopenFn) && /lay\[zone\] = placeKey\(lay\[zone\], key, t\.zone === zone \? t\.at : lay\[zone\]\.length, pinSet\(\)\);/.test(reopenFn)
  && /thawAll\(\);\s*(?:\/\/[^\n]*\n\s*)*bringUp\(last\.zone, last\.key\);/.test(reopenFn) && !/revealZone\(last\.zone\)/.test(reopenFn),
  "X17 닫은 탭 다시 열기 — 아래 칸에서 닫은 탭도 곁칸(맨 끝)으로 · 켜기는 bringUp(닫힌 아래 칸을 펼치지 않는다)");
const loadAt = PANES.indexOf("function loadLayout(id: number): Layout {");
const loadFn = loadAt >= 0 ? PANES.slice(loadAt, PANES.indexOf("\n}\n", loadAt)) : "";
check(/if \(last\) return normalizeLayout\(foldBottom\(last\)\);/.test(loadFn) && /if \(v1\) return normalizeLayout\(foldBottom\(v1\)\);/.test(loadFn) && /if \(mine\) return mine;/.test(loadFn),
  "X18 물려받는 배치(last · 옛 전역)는 아래 칸을 곁칸 뒤로 합친다 — 제 배치(mine)는 그대로");
const PARTS_SRC = readFileSync(process.env.PANES_PARTS_SRC || path.join(root, "web/v2/panes-parts.ts"), "utf8");
check(/PART_DEFS\.filter\(\(d\) => d\.type !== 'apps' && \(d\.multi \|\| !has\(d\.type\)\)/.test(pickFn) && /PART_DEFS\.filter\(\(d\) => d\.type !== 'sessions' && d\.type !== 'apps'\)/.test(PANES), "X13 «앱» 칸은 [＋] · 빈 자리 메뉴로 탭을 못 연다(stage 판엔 pickable 이 없어 이름으로 거른다)");
check(/onclick: \(\) => \{ if \(consumeDragClick\(\)\) return; if \(reselect\(zone, key\)\) return; activate\(zone, key\); \}/.test(PANES), "X5 탭 누르기 — 끈 뒤면 무시, 켜진 탭이면 «처음으로», 아니면 켠다");
const reFn = fn("  function reselect(zone: Zone, key: TabKey): boolean {");
check(/if \(!pane \|\| pane\.act !== key\) return false;/.test(reFn) && /if \(!part \|\| !part\.reselect\) return false;/.test(reFn) && /part\.reselect\(\);/.test(reFn), "X6 «처음으로»는 켜진 탭이고 앱이 그걸 가졌을 때만 — 아니면 종전대로 켠다");
const showFn = fn("  function showPart(type: PartType): void {");
check(/if \(zoneVisible\(found\.zone\) && reselect\(found\.zone, found\.key\)\) return;\n    bringUp\(found\.zone, found\.key\);/.test(showFn), "X7 머리줄 [자료] — 이미 보이고 켜져 있으면 «처음으로», 아니면 보이게만");
check(/const zoneVisible = \(z: Zone\): boolean => \(z === 'main' \? true : z === 'side' \? lay\.sideOn && !narrow\(\) : bottomVisible\(\)\);/.test(PANES), "X7b 접힌 곁칸 · 좁은 폭(서랍)은 «안 보임» — 다시 누른 게 아니라 여는 것");
const FILES = readFileSync(process.env.PANES_FILES_SRC || path.join(root, "web/v2/panes-files.ts"), "utf8");
check(/reselect: \(\) => \{ if \(cwd\) goto\(''\); else body\.scrollTop = 0; \},/.test(FILES), "X8 자료의 «처음으로» = 맨 위 폴더(뒤로 가능한 goto) · 이미 맨 위면 목록 맨 위");
const PARTS = readFileSync(process.env.PANES_PARTS_SRC || path.join(root, "web/v2/panes-parts.ts"), "utf8");
check(/\n  reselect\?: \(\) => void;\n\}/.test(PARTS), "X9 부품 약속(Part)에 reselect");

console.log(fail ? `\n${fail}건 실패 · ${pass}건 통과` : `\n${pass}건 통과`);
process.exit(fail ? 1 : 0);
