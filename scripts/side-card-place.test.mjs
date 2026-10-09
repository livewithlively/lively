// #3870 · 세션 카드의 자리 · 크기 · 상태 · 흐름 (원준 2026-10-09 «위치 · 크기 · 처음 상태 · 최소화 뒤 크게 보는 흐름이 되는 대로 짜였다»
//  · «최소화 상태에서 가로 폭 조절 안 됨»).
//  셈 web/lib/side-card-geom.ts(defaultCardSize · defaultAnchor · rectFromAnchor · anchorFromRect · parsePrefs) · 화면 web/v2/side-card.ts.
//
//  사양 · 엣지 표(spec-failfirst) — 상태는 셋: 열(세션이 격자 안) · 카드(펼침) · 알약(최소화)
//   P1 세션 왼쪽 · 격자 왼쪽 398 · 안 옮김 → 모서리 bl · 왼쪽 거리 422(격자 안 24) · 아래 24 (레일 · 왼쪽 목록 위에 뜨지 않는다)
//   P2 세션 오른쪽 · 격자 오른쪽 = 창 오른쪽 → br · 오른쪽 24 · 아래 24
//   P3 옮겨 둔 자리는 다음 진입에도 그대로(세션 쪽이 달라도)
//   P4 오른쪽 모서리에 붙은 카드는 창 폭이 바뀌어도 오른쪽 거리 그대로
//   P5 왼쪽 모서리에 붙은 카드는 창 폭이 바뀌어도 왼쪽 거리 그대로
//   P6 카드를 창 가운데선 너머로 옮기면 가장 가까운 모서리로 다시 적는다(자리는 그대로)
//   S1 창 높이 900 · 안 바꿈 → 360 × 306 (폭 = 세션 열의 마지막 폭 — 터미널 줄 폭이 그대로)
//   S2 창 높이 600(0.34×600 = 204) → 높이 260(하한) · S3 창 높이 1400(476) → 400(상한)
//   S4 바꿔 둔 크기는 다음 진입에도 그대로
//   F1 최소화한 채 크게 → 다시 카드가 되면 펼친 카드 · F2 옛 저장에 fold:true 가 있어도 펼친 카드(접힘을 읽지도 적지도 않는다)
//   F3 위 모서리 카드를 최소화하면 알약이 위에 남는다 · F4 아래 모서리면 아래에 남는다
//   F5 알약 한 번 누름 → 편다(두 번 누르기와 섞이지 않게 기다린다) · F6 두 번 누름 → 크게(펴지 않고 곧장)
//   F7 알약을 끌고 놓으면 옮기기만(펴지 않는다) · 손이 떨린 만큼(3px 이하)은 옮김으로 적지 않는다
//   F8 알약은 좌우 가장자리 손잡이가 있다(위아래 · 모서리는 없다)
//   D1 저장 값이 깨짐 · 없음 → 아무것도 기억하지 않음(기본 크기 · 세션 쪽 모서리) · D2 Home 글쇠 → 기억을 지운다
//   W1 카드가 뜰 모서리를 고를 «세션 쪽» 은 자리바꿈 판정 전에 잰다(panes.ts → sessionLeft)
//   K1 기본 자리(아래 모서리)가 곁칸 앱 막대(.pn-dock-shelf)와 겹치면 막대 위(12)로 올린다 · K2 가로로 안 겹치면 그대로
//   K3 위 모서리 자리는 그대로 · K4 막대가 없으면 그대로 · K5 알약(접힌 높이)도 겹치면 올린다
//   K6 경계: 막대 왼쪽 = 카드 오른쪽(맞닿음)은 겹침이 아니다 · K7 올린 자리가 또 다른 막대와 겹치면 한 번 더 · K8 오른쪽 모서리도 같다
//   K9 사람이 옮긴 자리는 올리지 않는다(기본 자리일 때만) · K10 뷰어의 배율 단추는 카드 반대쪽 아래(카드가 왼쪽이면 제자리 오른쪽)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " : " + detail : ""}`); } };
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const load = async (src) => import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`);

const lib = await load(read("web/lib/side-card-geom.ts"));
const { defaultCardSize, defaultAnchor, rectFromAnchor, anchorFromRect, parsePrefs, liftAbove, SESS_MIN, CARD_GAP } = lib;
ok(typeof defaultCardSize === "function" && typeof defaultAnchor === "function" && typeof rectFromAnchor === "function" && typeof anchorFromRect === "function" && typeof parsePrefs === "function",
  "L0 자리 · 크기의 셈이 잎 모듈에 있다");

if (typeof defaultAnchor === "function") {
  // ── 처음 자리 ──
  const VW = 1440, VH = 900;
  const a1 = defaultAnchor(true, 398, 1440, VW);
  ok(a1.corner === "bl" && a1.dx === 398 + 24 && a1.dy === 24, "P1 세션 왼쪽 → 사이드바 왼쪽 아래(격자 안 24) — 레일 · 왼쪽 목록 위가 아니다", JSON.stringify(a1));
  const r1 = rectFromAnchor(360, 306, a1, VW, VH);
  ok(VW - r1.r - r1.w === 422 && r1.b === 24, "P1b 그린 자리: 왼쪽 422 · 아래 24", JSON.stringify(r1));
  const a2 = defaultAnchor(false, 0, 1440, VW);
  ok(a2.corner === "br" && a2.dx === 24 && a2.dy === 24, "P2 세션 오른쪽 → 오른쪽 아래", JSON.stringify(a2));
  const a2b = defaultAnchor(false, 0, 1300, VW);
  ok(a2b.dx === 140 + 24, "P2b 격자 오른쪽이 창 끝이 아니면 격자 안에서 24", JSON.stringify(a2b));

  // ── 창 크기가 바뀌어도 붙은 모서리 ──
  const br = { corner: "br", dx: 24, dy: 24 }, bl = { corner: "bl", dx: 422, dy: 24 };
  ok(rectFromAnchor(360, 306, br, 1440, 900).r === 24 && rectFromAnchor(360, 306, br, 1116, 820).r === 24, "P4 오른쪽 모서리 카드는 창 폭이 바뀌어도 오른쪽 24");
  const L = (r, vw) => vw - r.r - r.w;
  ok(L(rectFromAnchor(360, 306, bl, 1440, 900), 1440) === 422 && L(rectFromAnchor(360, 306, bl, 1116, 820), 1116) === 422, "P5 왼쪽 모서리 카드는 창 폭이 바뀌어도 왼쪽 422");

  // ── 옮기면 가까운 모서리로 ──
  const moved = { w: 360, h: 306, r: 1440 - 360 - 900, b: 500 };          // 왼쪽 900 → 가운데(1080) 가 창 오른쪽 절반
  const am = anchorFromRect(moved, 1440, 900);
  ok(am.corner === "tr" && am.dx === moved.r && am.dy === 900 - 500 - 306, "P6 오른쪽 위 절반으로 옮기면 tr 로 다시 적는다", JSON.stringify(am));
  const back = rectFromAnchor(360, 306, am, 1440, 900);
  ok(back.r === moved.r && back.b === moved.b, "P6b 다시 적어도 자리는 그대로(왕복)", JSON.stringify(back));
  for (const c of [{ w: 360, h: 300, r: 30, b: 40 }, { w: 360, h: 300, r: 1000, b: 40 }, { w: 360, h: 300, r: 30, b: 550 }, { w: 360, h: 300, r: 1000, b: 550 }]) {
    const a = anchorFromRect(c, 1440, 900), r = rectFromAnchor(c.w, c.h, a, 1440, 900);
    if (r.r !== c.r || r.b !== c.b) { ok(false, "P6c 네 모서리 왕복", JSON.stringify({ c, a, r })); break; }
  }
  ok(true, "P6c 네 모서리 모두 왕복해도 자리가 같다");

  // ── 처음 크기 ──
  const s1 = defaultCardSize(900);
  ok(s1.w === SESS_MIN && s1.w === 360 && s1.h === 306, "S1 창 높이 900 → 360 × 306 (폭 = 세션 열의 마지막 폭)", JSON.stringify(s1));
  ok(defaultCardSize(600).h === 260 && defaultCardSize(764).h === 260 && defaultCardSize(766).h === 260 && defaultCardSize(1400).h === 400 && defaultCardSize(1176).h === 400,
    "S2·S3 경계: 하한 260 · 상한 400", JSON.stringify([600, 764, 766, 1176, 1400].map((v) => defaultCardSize(v).h)));
  ok(defaultCardSize(NaN).h === 306, "S2b 창 높이를 못 재면 900 으로 센다");

  // ── 접힘 · 모서리 ──
  const tl = { corner: "tl", dx: 500, dy: 100 };
  const fTop = rectFromAnchor(360, 306, tl, 1440, 900, 44);
  ok(900 - fTop.b - 44 === 100, "F3 위 모서리 카드를 최소화하면 알약이 위(100)에 남는다", JSON.stringify(fTop));
  const uTop = rectFromAnchor(360, 306, tl, 1440, 900);
  ok(900 - uTop.b - 306 === 100, "F3b 펴면 같은 윗변에서 아래로 펴진다", JSON.stringify(uTop));
  ok(rectFromAnchor(360, 306, br, 1440, 900, 44).b === 24, "F4 아래 모서리 카드를 최소화하면 알약이 아래(24)에 남는다");

  // ── 기억 ──
  const p0 = parsePrefs(null), p1 = parsePrefs("{깨진"), p2 = parsePrefs(JSON.stringify({ w: 500, h: 300, r: 24, b: 24, fold: true }));
  ok(!p0.sized && !p0.placed && !p1.sized && !p1.placed, "D1 저장 값이 없거나 깨지면 아무것도 기억하지 않는다", JSON.stringify([p0, p1]));
  ok(!p2.sized && !p2.placed && !("fold" in p2), "F2 옛 덩이(w · h · r · b · fold)는 «바꿈 · 옮김» 으로 읽지 않고 접힘은 아예 없다", JSON.stringify(p2));
  const p3 = parsePrefs(JSON.stringify({ w: 480, h: 320, sized: true, corner: "tr", dx: 30, dy: 60, placed: true }));
  ok(p3.sized && p3.w === 480 && p3.h === 320 && p3.placed && p3.corner === "tr" && p3.dx === 30 && p3.dy === 60, "S4 · P3 바꾼 크기 · 옮긴 자리를 읽는다", JSON.stringify(p3));
  const p4 = parsePrefs(JSON.stringify({ w: 10, h: 10, sized: true, corner: "xx", dx: -5, dy: 5, placed: true }));
  ok(p4.w === 260 && p4.h === 160 && p4.corner === "br" && p4.dx === 0, "D1b 이상한 값은 최소 크기 · 기본 모서리 · 0 으로 다듬는다", JSON.stringify(p4));
}

if (typeof liftAbove !== "function") ok(false, "K0 막대를 피하는 셈(liftAbove)이 잎 모듈에 있다");
else {
  const VW = 1440, VH = 900;
  const dock = { left: 548, top: 826, right: 896, bottom: 892 };          // 1440×900 실측(곁칸 앱 막대)
  const bl = { corner: "bl", dx: 422, dy: 24 };                            // 왼쪽 422..782 · 아래 24
  const k1 = liftAbove(bl, 360, 306, [dock], VW, VH);
  ok(k1.corner === "bl" && k1.dx === 422 && k1.dy === VH - 826 + 12, "K1 앱 막대와 겹치면 막대 위 12 로 올린다(아래 거리 86)", JSON.stringify(k1));
  const k1r = rectFromAnchor(360, 306, k1, VW, VH);
  ok(VH - k1r.b <= 826 - 12, "K1b 그린 카드의 아랫변이 막대 윗변보다 12 위", JSON.stringify(k1r));
  ok(liftAbove(bl, 360, 306, [{ left: 900, top: 826, right: 1200, bottom: 892 }], VW, VH) === bl, "K2 가로로 안 겹치면 그대로(같은 값)");
  const tl = { corner: "tl", dx: 422, dy: 24 };
  ok(liftAbove(tl, 360, 306, [dock], VW, VH) === tl, "K3 위 모서리 자리는 그대로");
  ok(liftAbove(bl, 360, 306, [], VW, VH) === bl, "K4 막대가 없으면 그대로");
  ok(liftAbove(bl, 360, 44, [dock], VW, VH).dy === 86, "K5 알약(높이 44)도 겹치면 올린다");
  ok(liftAbove(bl, 126, 306, [dock], VW, VH) === bl && liftAbove(bl, 127, 306, [dock], VW, VH).dy === 86, "K6 경계: 카드 오른쪽 = 막대 왼쪽(548)은 겹침 아님 · 1px 넘으면 겹침");
  ok(liftAbove(bl, 360, 306, [{ left: 0, top: 892, right: 1440, bottom: 900 }], VW, VH).dy === 24, "K6b 경계: 막대 윗변 = 카드 아랫변(맞닿음)은 겹침 아님");
  //  처음 자리(570..876)와는 안 겹치고 올린 자리(508..814)와만 겹치는 막대 — 한 번만 보면 놓친다.
  const upper = { left: 400, top: 520, right: 500, bottom: 560 };
  ok(liftAbove(bl, 360, 306, [upper], VW, VH) === bl, "K7a 처음 자리와는 안 겹친다(시험 장치 확인)");
  ok(liftAbove(bl, 360, 306, [dock, upper], VW, VH).dy === VH - 520 + 12, "K7 올린 자리가 또 다른 막대와 겹치면 한 번 더", JSON.stringify(liftAbove(bl, 360, 306, [dock, upper], VW, VH)));
  const br = { corner: "br", dx: 600, dy: 24 };                            // 왼쪽 = 1440 − 600 − 360 = 480 .. 840
  ok(liftAbove(br, 360, 306, [dock], VW, VH).dy === 86 && liftAbove({ corner: "br", dx: 24, dy: 24 }, 360, 306, [dock], VW, VH).dy === 24, "K8 오른쪽 모서리도 가로 자리로 판정");
}

// ── 화면(side-card.ts) ──
const card = code(read("web/v2/side-card.ts"));
const enter = card.slice(card.indexOf("async function enter("), card.indexOf("async function leave("));
const leave = card.slice(card.indexOf("async function leave("), card.indexOf("function halt("));
ok(/sessLeft = h\.sessionLeft \? h\.sessionLeft\(\) : true;/.test(enter) && enter.indexOf("sessLeft =") < enter.indexOf("h.settle"), "W1 뜰 모서리의 «세션 쪽» 은 자리바꿈 판정(settle) 전에 잰다");
ok(/fold = false;/.test(enter), "F1a 카드가 되면 언제나 펼친 카드");
ok(/fold = false;/.test(leave), "F1b 크게 보면(제자리로) 접힘을 지운다 — 다음 카드는 펼친 카드");
const cur = card.slice(card.indexOf("function currentRect("), card.indexOf("function paintRect("));
ok(/const s = size \?\? defaultCardSize\(vh\(\)\);/.test(cur) && /if \(!a\) \{[\s\S]*?const g = body\.getBoundingClientRect\(\);[\s\S]*?defaultAnchor\(sessLeft, g\.left, g\.right, vw\(\)\)[\s\S]*?\}/.test(cur),
  "P1c · S1b 정한 적이 없으면 그릴 때마다 창 · 격자로 기본값을 센다", cur.slice(0, 240));
ok(/a = liftAbove\(defaultAnchor\(sessLeft, g\.left, g\.right, vw\(\)\), s\.w, fh \?\? s\.h, obstacles\(\), vw\(\), vh\(\)\);/.test(cur) && cur.indexOf("liftAbove(") > cur.indexOf("if (!a)"),
  "K9 막대 피하기는 기본 자리일 때만(옮긴 자리는 그대로) · 접혀 있으면 알약 높이로", cur.slice(0, 400));
const obs = card.slice(card.indexOf("function obstacles("), card.indexOf("function currentRect("));
ok(/querySelectorAll\('\.pn-dock-shelf'\)/.test(obs) && /colMain\.contains\(n\)/.test(obs) && /q\.width > 0 && q\.height > 0/.test(obs), "K1c 피할 것: 보이는 곁칸 앱 막대(세션 카드 안의 것은 빼고)", obs.slice(0, 300));
const pr = card.slice(card.indexOf("function paintRect("), card.indexOf("function paint():"));
ok(/body\.classList\.toggle\('cm-card-left', vw\(\) - c\.r - c\.w \/ 2 < vw\(\) \/ 2\)/.test(pr), "K10 카드가 창 왼쪽 절반이면 cm-card-left", pr.slice(0, 300));
ok(/classList\.remove\([^)]*'cm-card-left'/.test(card), "K10b 카드에서 나오면 cm-card-left 를 지운다");
ok(/let size: \{ w: number; h: number \} \| null = prefs\.sized/.test(card) && /let anchor: CardAnchor \| null = prefs\.placed/.test(card), "P3 · S4 기억한 크기 · 자리로 시작한다(따로)");
const save = card.slice(card.indexOf("const save = (): void =>"), card.indexOf("const hint = el("));
ok(/sized: !!size/.test(save) && /placed: !!anchor/.test(save) && !/fold/.test(save), "F2b 적는 것: 바꿈 · 옮김(접힘은 적지 않는다)", save.slice(0, 200));
const sf = card.slice(card.indexOf("function setFold("), card.indexOf("let pillTimer"));
ok(!/save\(\)/.test(sf), "F2c 최소화 · 펴기는 적지 않는다");
const pt = card.slice(card.indexOf("const onTitleClick"), card.indexOf("colMain.addEventListener('click', onTitleClick, true)"));
ok(/if \(!fold \|\| dragged\) return;/.test(pt) && /pillTimer = window\.setTimeout\(\(\) => \{ if \(!dead && shown\(\) && fold\) setFold\(false\); \}, PILL_CLICK_MS\);/.test(pt), "F5 알약 한 번 누름 → 편다(기다렸다가) · F7 끌고 놓은 것은 누름이 아니다", pt.slice(0, 300));
const dbl = card.slice(card.indexOf("const onHeadDbl"), card.indexOf("colMain.addEventListener('dblclick', onHeadDbl, true)"));
ok(/window\.clearTimeout\(pillTimer\);/.test(dbl) && dbl.indexOf("clearTimeout(pillTimer)") < dbl.indexOf("leave()"), "F6 두 번 누름 → 펴기를 취소하고 곧장 크게");
const ds = card.slice(card.indexOf("function dragStart("), card.indexOf("const headOf ="));
ok(/if \(Math\.abs\(dx\) \+ Math\.abs\(dy\) > 3\) dragged = true;/.test(ds) && /if \(!dragged\) return;/.test(ds) && /if \(persist && dragged && !dead && bw\(\) > 0\) save\(\);/.test(ds), "F7b 손이 떨린 만큼(3px 이하)은 옮김으로 적지 않는다");
ok(/anchor = anchorFromRect\(c, vw\(\), vh\(\), fh\);/.test(ds) && /if \(kind !== 'move'\) size = \{ w: c\.w, h: c\.h \};/.test(ds), "P6d 끌면 가까운 모서리로 다시 적는다 · 크기를 바꾸면 크기도");
const pa = card.slice(card.indexOf("function paint():"), card.indexOf("// ── 비침 · 또렷"));
ok(/g\.hidden = !s \|\| \(fold && g\.dataset\.edge !== 'e' && g\.dataset\.edge !== 'w'\)/.test(pa), "F8 알약은 좌우 가장자리 손잡이만 있다(폭 조절 — 버그 수정)", pa.slice(0, 400));
const kd = card.slice(card.indexOf("keyGrip.addEventListener('keydown'"), card.indexOf("const onHeadDbl"));
ok(/if \(e\.key === 'Home'\) \{[\s\S]*?size = null; anchor = null;/.test(kd), "D2 Home → 기억을 지우고 기본값");
ok(/const KEY_CARD = 'lively_v2_side_card3';/.test(card), "D1c 옛 키(r · b · 접힘 덩이)를 읽지 않는다");
const panes = code(read("web/v2/panes.ts"));
ok(/sessionLeft: \(\) => !swap\?\.swapped\(\)/.test(panes), "W1b 셸은 «세션이 왼쪽인가» 를 자리바꿈 상태로 알려 준다");
const css = read("public/styles/45-v2-side-swap.css");
const g = (e) => (css.match(new RegExp("\\.cm-grip-" + e + " \\{([^}]*)\\}")) || [])[1] || "";
ok(/cursor: ew-resize/.test(g("e")) && /cursor: ew-resize/.test(g("w")), "F8b 좌우 손잡이는 가로 크기 조절 손(ew-resize)");
const cssCode = code(css);
ok(/\.pn-body\.cm:not\(\.cm-card-left\) > \.pn-pane\[data-zone="side"\] \.pn-zoom \{ right: auto; left: 12px; \}/.test(cssCode)
  && !/\.pn-body\.cm > \.pn-pane\[data-zone="side"\] \.pn-zoom/.test(cssCode), "K10c 배율 단추는 카드가 오른쪽일 때만 왼쪽으로(왼쪽 카드 밑에 숨지 않는다)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
