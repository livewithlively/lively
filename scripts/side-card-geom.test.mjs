// #3870 세션 카드: 우측 사이드바를 세션 쪽 끝까지 키우면 세션이 카드가 된다 (원준 2026-09-27).
//  셈은 web/lib/side-card-geom.ts 한 곳, 화면은 web/v2/side-card.ts, 배선은 split.ts · side-swap.ts · panes.ts.
//
//  계기: 1440px 창에서 손잡이를 끝까지 끌면 사이드바가 1037px, 세션 열이 0px 가 되고 손잡이가 화면 오른쪽 끝에
//   5px 만 남았다(매니지드 실측). 상한이 창 폭의 88% 라 격자(1042px)를 넘었다.
//
//  사양 · 엣지 표(spec-failfirst):
//   C1 상한 = 격자 폭 - 360(세션 최소) - 6(손잡이). 격자 1042 → 676
//   C2 격자가 좁아도 상한은 사이드바 하한(220) 아래로 안 내려간다
//   C3 격자 폭을 못 쟀으면(0) 상한으로 막지 않는다(적어 둔 폭을 하한으로 깎지 않는다)
//   C4 상한은 격자 폭을 넘지 않는다(넓은 격자 전부에서 세션 열이 360 이상 남는다)
//   P1 전환 구간 = 상한에서 격자 끝까지. 넘긴 거리 0 → 0, 구간 전체 → 1, 그 너머도 1
//   P2 30% 를 넘겨야 카드. 30% 정각은 아니다
//   K1 카드는 격자 안에 선다. 큰 값 · 음수 · 글자가 와도
//   K2 카드는 320×240 아래로 안 줄고, 격자에서 8px 떨어진 크기를 안 넘는다
//   K3 크기 조절: 왼쪽 위 모서리를 끌면 오른쪽 아래가 제자리다
//   K4 크기 조절: 오른쪽 아래 모서리를 끌면 왼쪽 위가 제자리다
//   K5 크기 조절로 최소 크기 아래로 못 줄인다
//   K6 옮기기: 크기는 그대로, 격자 밖으로 못 나간다
//   S1 적어 둔 카드 읽기: 없음 · 깨진 글자 · 일부만 있는 값 → 기본값으로 채운다
//   W1 side-swap.ts: 상한을 창 폭(innerWidth)으로 재지 않는다. sideCap 을 쓴다
//   W2 split.ts: 끄는 중 상한을 넘긴 거리를 onOver 로 알린다(0 이상)
//   W3 panes.ts: 손잡이가 onOver 를 카드에 넘기고, 놓을 때 카드가 먼저 받는다(카드가 되면 자리는 settle 이 정하고, 덜 넘겼으면 물러난 뒤 판정한다)
//   W4 panes.ts: 카드인지 아닌지를 이 세션의 화면 상태(View.card)로 적고 되살린다
//   W5 side-card.ts: 세션 열을 옮겨 붙이지 않는다(append · prepend · insertBefore 로 colMain 을 옮기지 않는다)
//   W6 CSS: 카드 규칙은 넓은 폭(min-width: 901px) 안에 있다. 카드 상태의 세션 열은 grid-column 을 auto 로 되돌린다
//   W7 화면 글에 «곁칸» 이 없다(#4233 이름 규칙)
//   K7 격자가 카드 최소 크기보다 작으면 카드도 격자 안으로 줄인다
//   W9 side-card: 움직이던 함수는 기다린 뒤마다 자기 판(gen)이 살아 있는지 본다. restore · destroy 가 판을 올린다
//   W10 side-card: 격자 폭을 못 재면(0) 사이드바 폭을 적지 않는다
//   W11 side-swap: 서는 순간에는 자리를 판정하지 않는다(전역 키의 폭으로 판정해 지금 연 세션에 적던 결함)
//   J1 놓을 때의 자리: 52% 이상 왼쪽 · 46% 이하 오른쪽 · 그 사이는 지금 자리
//   J2 되살릴 때: 자리바꿈이 꺼져 있으면 늘 오른쪽
//   J3 되살릴 때: 적어 둔 자리가 없으면 폭으로 판정한다
//   J4 되살릴 때: 적어 둔 «왼쪽» + 격자 폭을 잴 수 있음 + 46% 이하 → 오른쪽으로 보여 준다(340px 사이드바가 왼쪽에 서던 결함)
//   J5 되살릴 때: 적어 둔 «왼쪽» + 격자 폭을 못 잼 → 적어 둔 대로(어림값으로 뒤집지 않는다)
//   J6 되살릴 때: 적어 둔 «왼쪽» + 문턱 사이(46~52%)나 그 위 → 적어 둔 대로
//   J7 되살릴 때: 적어 둔 «오른쪽» 은 폭이 넓어도 그대로(한 방향만 바로잡는다)
//   W12 side-swap: 되살릴 때 바로잡은 자리를 세션에 적지 않는다(넓은 창에서 바꾼 자리를 좁은 창이 지우지 않게)
//   W13 상한은 그릴 때 맞춘다: 격자 열이 --pn-side-fit(적어 둔 폭과 상한 가운데 작은 쪽)을 쓰고, 식이 sideCap 과 같다
//   W14 side-swap · panes: 격자 폭이 바뀌어도 적어 둔 폭(--pn-side-w)을 깎지 않는다. 자리 판정은 폭이 멈춘 뒤에 한다
//   W15 split: 끌기 시작 폭을 상한 안으로 맞춘다
//   W8 CSS: 자리바꿈 상태에서 사이드바를 접으면 세션이 격자 전체를 쓴다(sw-left.no-side 가 sw-left 뒤에 있다)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " : " + detail : ""}`); } };
/** 주석을 뺀 코드. 설명 글에 적힌 옛 이름이 단언을 속이지 않게. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const strings = (src, name = "x.ts") => {
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (n) => { if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text); ts.forEachChild(n, visit); };
  visit(sf);
  return out;
};

let lib = null;
const libSrc = read("web/lib/side-card-geom.ts");
if (libSrc) {
  const js = ts.transpileModule(libSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  lib = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
ok(!!lib, "L0 셈이 잎 모듈(web/lib/side-card-geom.ts)에 있다");
if (lib) {
  const { sideCap, overZone, overProgress, shouldCommit, clampCard, resizeCard, moveCard, parseCard, SESS_MIN, SPLIT_W, CARD_MIN, CARD_PAD, CARD_DEF } = lib;
  ok(SESS_MIN === 360 && SPLIT_W === 6, "C0 세션 최소 폭 360 · 손잡이 6", `${SESS_MIN} ${SPLIT_W}`);
  ok(sideCap(1042) === 676, "C1 격자 1042 → 상한 676", String(sideCap(1042)));
  ok(sideCap(500) === 220 && sideCap(586) === 220 && sideCap(587) === 221, "C2 좁은 격자에서도 하한 220", `${sideCap(500)} ${sideCap(586)} ${sideCap(587)}`);
  ok(sideCap(0) > 100000 && sideCap(-5) > 100000 && sideCap(NaN) > 100000, "C3 격자 폭 0 이면 막지 않는다", String(sideCap(0)));
  let bad = "";
  for (let w = 600; w <= 3000; w += 37) { const c = sideCap(w); if (c >= w || w - c - SPLIT_W < SESS_MIN) { bad = `${w}→${c}`; break; } }
  ok(!bad, "C4 넓은 격자 전부에서 세션 열이 360 이상 남는다", bad);

  ok(overZone(1042) === 366, "P1a 전환 구간 = 366", String(overZone(1042)));
  ok(overProgress(0, 1042) === 0 && overProgress(-10, 1042) === 0, "P1b 안 넘겼으면 0");
  ok(overProgress(366, 1042) === 1 && overProgress(900, 1042) === 1, "P1c 구간 전체와 그 너머는 1");
  ok(Math.abs(overProgress(183, 1042) - 0.5) < 1e-9, "P1d 절반은 0.5", String(overProgress(183, 1042)));
  ok(overProgress(50, 0) === 0, "P1e 격자 폭 0 이면 0");
  ok(shouldCommit(0.31) && !shouldCommit(0.3) && !shouldCommit(0.29) && !shouldCommit(0), "P2 30% 를 넘겨야 카드");

  const B = [1042, 862];
  const inside = (c) => c.r >= CARD_PAD && c.b >= CARD_PAD && c.r + c.w <= B[0] - CARD_PAD && c.b + c.h <= B[1] - CARD_PAD;
  ok(inside(clampCard({ w: 420, h: 560, r: 24, b: 24 }, ...B)), "K1a 기본 카드는 격자 안");
  ok(inside(clampCard({ w: 5000, h: 5000, r: -300, b: 9000 }, ...B)), "K1b 큰 값 · 음수가 와도 격자 안", JSON.stringify(clampCard({ w: 5000, h: 5000, r: -300, b: 9000 }, ...B)));
  ok(inside(clampCard({ w: "x", h: null, r: undefined, b: NaN }, ...B)), "K1c 글자 · 빈 값이 와도 격자 안");
  const tiny = clampCard({ w: 10, h: 10, r: 24, b: 24 }, ...B);
  ok(tiny.w === CARD_MIN.w && tiny.h === CARD_MIN.h, "K2a 320×240 아래로 안 준다", JSON.stringify(tiny));
  const huge = clampCard({ w: 9999, h: 9999, r: 24, b: 24 }, ...B);
  ok(huge.w === B[0] - 16 && huge.h === B[1] - 16, "K2b 격자에서 8px 떨어진 크기를 안 넘는다", JSON.stringify(huge));

  const base = { w: 420, h: 560, r: 24, b: 24 };
  const nw = resizeCard(base, "nw", -100, -50, ...B);
  ok(nw.w === 520 && nw.h === 610 && nw.r === 24 && nw.b === 24, "K3 왼쪽 위를 끌면 오른쪽 아래가 제자리", JSON.stringify(nw));
  const mid = { w: 420, h: 400, r: 200, b: 200 };
  const se = resizeCard(mid, "se", 60, 40, ...B);
  ok(se.w === 480 && se.h === 440 && se.r === 140 && se.b === 160 && (B[0] - se.r - se.w) === (B[0] - mid.r - mid.w) && (B[1] - se.b - se.h) === (B[1] - mid.b - mid.h),
    "K4 오른쪽 아래를 끌면 왼쪽 위가 제자리", JSON.stringify(se));
  const shrink = resizeCard(base, "nw", 900, 900, ...B);
  ok(shrink.w === CARD_MIN.w && shrink.h === CARD_MIN.h && shrink.r === 24 && shrink.b === 24, "K5a 왼쪽 위로 줄여도 최소 크기", JSON.stringify(shrink));
  const shrink2 = resizeCard(mid, "se", -900, -900, ...B);
  ok(shrink2.w === CARD_MIN.w && shrink2.h === CARD_MIN.h, "K5b 오른쪽 아래로 줄여도 최소 크기", JSON.stringify(shrink2));
  const onlyE = resizeCard(mid, "e", 50, 999, ...B);
  ok(onlyE.w === 470 && onlyE.h === 400, "K5c 가장자리 하나는 한 방향만 바꾼다", JSON.stringify(onlyE));
  const small = clampCard({ w: 420, h: 560, r: 24, b: 24 }, 261, 200);
  ok(small.w === 261 - 16 && small.h === 200 - 16 && small.r === 8 && small.b === 8, "K7 좁은 격자(261×200)에서는 카드가 격자 안으로 준다", JSON.stringify(small));
  const mv = moveCard(base, -300, -200, ...B);
  ok(mv.w === 420 && mv.h === 560 && mv.r === 324 && mv.b === 224, "K6a 옮기면 크기는 그대로", JSON.stringify(mv));
  ok(inside(moveCard(base, -5000, -5000, ...B)) && inside(moveCard(base, 5000, 5000, ...B)), "K6b 격자 밖으로 못 나간다");

  const d = parseCard(null);
  ok(d.w === CARD_DEF.w && d.h === CARD_DEF.h && d.r === CARD_DEF.r && d.b === CARD_DEF.b && d.fold === false, "S1a 없으면 기본값", JSON.stringify(d));
  ok(JSON.stringify(parseCard("{깨진")) === JSON.stringify(d) && JSON.stringify(parseCard("[1,2]")) !== "", "S1b 깨진 글자면 기본값");
  const part = parseCard(JSON.stringify({ w: 640, fold: true }));
  ok(part.w === 640 && part.h === CARD_DEF.h && part.fold === true, "S1c 일부만 있으면 나머지는 기본값", JSON.stringify(part));
  ok(parseCard(JSON.stringify({ fold: "yes" })).fold === false, "S1d 접힘은 true 일 때만");
}

// ── 자리바꿈 판정(web/lib/side-swap-judge.ts) ──
let jud = null;
const judSrc = read("web/lib/side-swap-judge.ts");
if (judSrc) {
  const js = ts.transpileModule(judSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  jud = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
ok(!!jud, "J0 자리바꿈 판정이 잎 모듈(web/lib/side-swap-judge.ts)에 있다");
if (jud) {
  const { judgeSwap, placeOnRestore, SWAP_TH } = jud;
  ok(SWAP_TH.on === 0.52 && SWAP_TH.off === 0.46, "J1a 문턱 52% · 46%");
  ok(judgeSwap(0.52, false) === true && judgeSwap(0.6, false) === true && judgeSwap(0.46, true) === false && judgeSwap(0.3, true) === false, "J1b 52% 이상 왼쪽 · 46% 이하 오른쪽");
  ok(judgeSwap(0.5, false) === false && judgeSwap(0.5, true) === true && judgeSwap(0.47, true) === true && judgeSwap(0.519, false) === false, "J1c 그 사이는 지금 자리");
  ok(judgeSwap(NaN, true) === true && judgeSwap(NaN, false) === false, "J1d 비율을 못 세면 지금 자리");
  const P = (o) => placeOnRestore({ enabled: true, remembered: undefined, ratio: 0.3, measurable: true, cur: false, ...o });
  ok(P({ enabled: false, remembered: true, ratio: 0.9 }) === false && P({ enabled: false, remembered: undefined, ratio: 0.9, cur: true }) === false, "J2 자리바꿈이 꺼져 있으면 늘 오른쪽");
  ok(P({ ratio: 0.6 }) === true && P({ ratio: 0.3, cur: true }) === false && P({ ratio: 0.5, cur: true }) === true, "J3 적어 둔 자리가 없으면 폭으로 판정");
  ok(P({ remembered: true, ratio: 340 / 1042 }) === false && P({ remembered: true, ratio: 0.46 }) === false, "J4 적어 둔 «왼쪽» 이어도 46% 이하면 오른쪽으로 보여 준다", String(P({ remembered: true, ratio: 340 / 1042 })));
  ok(P({ remembered: true, ratio: 0.2, measurable: false }) === true, "J5 격자 폭을 못 재면 적어 둔 대로");
  ok(P({ remembered: true, ratio: 0.47 }) === true && P({ remembered: true, ratio: 0.5 }) === true && P({ remembered: true, ratio: 0.65 }) === true, "J6 문턱 사이와 그 위는 적어 둔 대로");
  ok(P({ remembered: false, ratio: 0.8 }) === false && P({ remembered: false, ratio: 0.2 }) === false, "J7 적어 둔 «오른쪽» 은 그대로");
  // 리뷰가 든 경우: 넓은 창(격자 1600)에서 900px 로 자리를 바꾼 세션을 좁은 격자(600)에서 다시 연다 → 보이기는 오른쪽
  ok(P({ remembered: true, ratio: 234 / 600 }) === false && P({ remembered: true, ratio: 900 / 1600 }) === true, "J8 좁은 창에서는 오른쪽, 다시 넓히면 적어 둔 왼쪽");
}

// ── 배선 ──
const swap = code(read("web/v2/side-swap.ts"));
const cap = swap.slice(swap.indexOf("export const maxSideWidth"), swap.indexOf("export const maxSideWidth") + 200);
ok(/sideCap\(/.test(cap) && !/innerWidth/.test(cap), "W1 side-swap: 상한을 sideCap(격자 폭)으로 잰다", cap.slice(0, 120));
const split = code(read("web/v2/split.ts"));
ok(/onOver\?\.\(\s*Math\.max\(\s*0\s*,/.test(split), "W2 split: 상한을 넘긴 거리를 onOver 로 알린다");
const panes = code(read("web/v2/panes.ts"));
ok(/onOver:\s*\(over\)\s*=>\s*\{\s*card\?\.onOver\(over\)/.test(panes), "W3a panes: onOver 를 카드에 넘긴다");
ok(/if\s*\(card\?\.onRelease\(settle\)\)\s*return;\s*settle\(\);/.test(panes), "W3b panes: 놓을 때 카드가 먼저 받는다(덜 넘겼으면 물러난 뒤 자리바꿈 판정 — side-card-swap-window.test.mjs)");
ok(/card\?:\s*boolean/.test(panes) && /card\?\.restore\(v\.card === true\)/.test(panes) && /saveView\(\{\s*card:\s*v\s*\}\)/.test(panes), "W4 panes: 카드 여부를 이 세션의 화면 상태로 적고 되살린다");
const cardSrc = read("web/v2/side-card.ts");
const cardCode = code(cardSrc);
ok(!!cardSrc && !/\.(append|prepend|insertBefore|replaceChildren|appendChild)\([^)]*\bcolMain\b/.test(cardCode), "W5 side-card: 세션 열을 옮겨 붙이지 않는다");
const css = read("public/styles/45-v2-side-swap.css");
const at = css.indexOf("@media (min-width: 901px)");
const cmRule = css.indexOf(".pn-body.cm > .pn-col {");
ok(at > 0 && cmRule > at, "W6a CSS: 카드 규칙이 넓은 폭 안에 있다");
const rule = css.slice(cmRule, css.indexOf("}", cmRule));
ok(/grid-column:\s*auto/.test(rule) && /grid-row:\s*auto/.test(rule) && /position:\s*fixed/.test(rule), "W6b CSS: 카드 상태의 세션 열은 칸 지정을 auto 로 되돌린다(창 기준 fixed)", rule.slice(0, 160));
const texts = [...strings(cardSrc, "side-card.ts")];
ok(texts.length > 5 && texts.every((t) => !t.includes("곁칸")), "W7 화면 글에 «곁칸» 이 없다", texts.filter((t) => t.includes("곁칸")).join(" | "));

const fnBody = (name) => { const a = cardCode.indexOf("async function " + name + "("); if (a < 0) return ""; const b = cardCode.indexOf("\n  }\n", a); return cardCode.slice(a, b); };
for (const fn of ["cancel", "enter", "leave"]) {
  const b = fnBody(fn);
  const awaits = (b.match(/await /g) || []).length, checks = (b.match(/if \(!alive\(\)\) return;/g) || []).length;
  ok(/const g = \+\+gen/.test(b) && awaits >= 1 && checks >= 1 && /tween\([^;]*alive\)/.test(b), `W9 side-card ${fn}: 판을 잡고, 기다린 뒤 살아 있는지 본다`, `await ${awaits} · 확인 ${checks}`);
}
const halt = cardCode.slice(cardCode.indexOf("function halt("), cardCode.indexOf("function restore("));
ok(/gen\+\+/.test(halt) && /stopDrag\?\.\(\)/.test(halt) && /function restore\(v: boolean\): void \{\s*halt\(\);/.test(cardCode) && /destroy: \(\) => \{\s*halt\(\);/.test(cardCode), "W9 side-card: restore · destroy 가 움직임과 끌기를 끝낸다");
ok(/const capNow = \(\): number \| null => \(bw\(\) > 0 \? sideCap\(bw\(\)\) : null\)/.test(cardCode) && !/setSideW\(sideCap\(/.test(cardCode), "W10 side-card: 격자 폭을 못 재면 사이드바 폭을 적지 않는다");

const tail = swap.slice(swap.indexOf("const onResize"), swap.indexOf("return {", swap.indexOf("const onResize")));
const topLevel = tail.split("\n").filter((l) => /^  [a-zA-Z]/.test(l));           // mountSideSwap 몸통의 바로 아래 줄(들여쓰기 2칸)
ok(topLevel.length > 0 && !topLevel.some((l) => /^  onEnd\(/.test(l)), "W11 side-swap: 서는 순간 onEnd 를 부르지 않는다", topLevel.filter((l) => /onEnd/.test(l)).join(" | "));

const rst = swap.slice(swap.indexOf("function restore("), swap.indexOf("function onEnd("));
ok(/placeOnRestore\(/.test(rst) && /setSwapped\(want, false, !keepStored\)/.test(rst) && !/h\.onChange/.test(rst), "W12a side-swap restore: 바로잡은 자리는 적지 않는다(persist 끔)");
const setSw = swap.slice(swap.indexOf("function setSwapped("), swap.indexOf("function restore("));
ok(/if \(persist\) h\.onChange\?\.\(v\); else h\.onPlace\?\.\(v\);/.test(setSw), "W12b side-swap setSwapped: persist 가 거짓이면 onChange 를 부르지 않는다");

const base42 = read("public/styles/42-v2-panes.css");
const fit = (base42.match(/--pn-side-fit:\s*([^;]+);/) || [])[1] || "";
ok(/^min\(var\(--pn-side-w\),\s*max\(220px,\s*calc\(100% - 366px\)\)\)$/.test(fit.trim()) && lib && lib.SESS_MIN + lib.SPLIT_W === 366 && lib.SIDE_MIN === 220, "W13a CSS 의 상한 식이 sideCap 과 같다(220 · 366)", fit);
ok(/\.pn-body \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 6px var\(--pn-side-fit\)/.test(base42) && /\.pn-body\.sw-left \{\s*grid-template-columns:\s*var\(--pn-side-fit\) 6px minmax\(0, 1fr\)/.test(css), "W13b 격자 열(평소 · 자리바꿈)이 --pn-side-fit 을 쓴다");
const rsz = swap.slice(swap.indexOf("const onResize"), swap.indexOf("return {", swap.indexOf("const onResize")));
ok(rsz.length > 0 && !/setProperty\(SIDE_VAR/.test(swap.slice(swap.indexOf("export function mountSideSwap"))) && !/setSideW\(/.test(rsz), "W14a side-swap: 폭 변수를 적지 않는다(깎지 않는다)");
ok(/window\.setTimeout\(/.test(rsz) && /RESIZE_SETTLE_MS/.test(rsz) && /body\.clientWidth !== w/.test(rsz), "W14b side-swap: 격자 폭이 멈춘 뒤에 자리를 판정한다");
const av = panes.slice(panes.indexOf("function applyView("), panes.indexOf("colMain.append(mainPane.root"));
ok(av.length > 0 && !/maxSideW\(\)/.test(av), "W14c panes applyView: 상한으로 깎지 않는다");
ok(/const shown = \(\): number => clamp\(current\(\), o\.min, Math\.max\(o\.min, maxOf\(\)\)\)/.test(split) && /const base = shown\(\);/.test(split), "W15a split: 끌기 시작 폭을 상한 안으로");
const kd = split.slice(split.indexOf("addEventListener('keydown'"));
ok(/apply\(shown\(\) - step \* growOf\(\), true\)/.test(kd) && /apply\(shown\(\) \+ step \* growOf\(\), true\)/.test(kd) && !/apply\(current\(\) [-+]/.test(kd), "W15b split: 글쇠 조정도 보이는 폭에서 시작한다");

const swl = css.indexOf(".pn-body.sw-left {"), nos = css.indexOf(".pn-body.sw-left.no-side {"), nosCol = css.indexOf(".pn-body.sw-left.no-side > .pn-col {");
ok(swl >= 0 && nos > swl && nosCol > nos && /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*0\s*0/.test(css.slice(nos, css.indexOf("}", nos))) && /grid-column:\s*1\b/.test(css.slice(nosCol, css.indexOf("}", nosCol))),
  "W8 CSS: 자리바꿈 + 사이드바 접힘이면 세션이 격자 전체");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
