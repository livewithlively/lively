// #3870 후속 · 세션 카드 «비침» (원준 2026-09-30, 시안 2안).
//  사이드바를 끝까지 키워 세션이 카드가 됐을 때: 카드는 작게 뜨고, 쉬는 동안 바탕이 비치며(뒤는 흐리게),
//  사람이 카드를 골랐을 때만 또렷하다. 카드를 제자리로 돌리면 사이드바는 상한이 아니라 기본 폭으로 물러난다.
//  화면 web/v2/side-card.ts · 셈 web/lib/side-card-geom.ts · 터미널 web/standalone/terminal.ts · CSS 45-v2-side-swap.css · public/terminal.html
//
//  사양 · 엣지 표(spec-failfirst):
//   D1 카드 기본 크기는 320×240 (종전 420×560 은 1440 창 격자의 27%, 1116 창의 43% 를 가렸다)
//   D2 최소 크기는 기본보다 작다(사람이 더 줄일 수 있다) — 정확히 260×160 까지
//   D3 종전 키에 적힌 큰 크기를 물려받지 않는다(저장 키가 새 이름이다)
//   R1 제자리로: 사이드바는 기본 폭(SIDE_DEF = 340)으로 물러난다. 창이 좁아 상한이 더 작으면 상한(격자 600 → 234)
//   R2 기본 폭은 한 값이다 — panes.ts 의 곁칸 기본 폭도 SIDE_DEF 를 쓴다(340 을 두 곳에 쓰지 않는다)
//   R3 물러나는 움직임: 사이드바가 격자 전체를 덮은 거리에서 0 으로 줄어든다(세션 열이 가운데에서 드러난다)
//   G1 카드인 동안 터미널 액자에 {cmd:'glass', on} 을 보낸다. 액자가 늦게 떠도(상태 신호) 다시 보낸다
//   G2 또렷 = 사람이 카드를 골랐다(cm-live) 또는 마우스가 위에 있다(:hover). 사이드바를 누르면 고름이 풀린다.
//      터미널에 초점이 가면 고른 것 · 액자끼리 초점이 옮겨 가도 따라간다
//   G3 막 떠오른 카드는 잠깐 또렷하다가 비친다(고르지 않았으면)
//   G4 세션 상태(답 기다림)로는 또렷해지지 않는다 — 고른 칸이 정한다
//   C1 CSS: 비칠 때 카드 바탕은 반투명 + 뒤 흐림(-webkit- 포함). 안쪽(칸 · 세션 화면 · 액자 · 카드 단추)은 카드인 동안 늘 투명
//   C2 CSS: 비침 규칙은 넓은 폭(카드가 있는 곳) 안에 있다
//   T1 터미널: glass 를 받으면 바탕을 비운다 — 색은 그대로, 알파만 0 (OSC 11 답이 검정이 되지 않게). 읽지 못하는 꼴은 투명한 흰색
//   T2 터미널: xterm 테마를 바꾸는 모든 자리가 비침을 지킨다(themeFor) · 만들 때도 allowTransparency 를 따른다
//   T3 terminal.html: term-glass 이면 문서 바탕을 걷고 color-scheme 을 테마에 맞춘다
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
const transpile = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = async (src) => import(`data:text/javascript;base64,${Buffer.from(transpile(src)).toString("base64")}`);

// ── 셈 ──
const libSrc = read("web/lib/side-card-geom.ts");
const lib = libSrc ? await load(libSrc) : null;
ok(!!lib, "L0 셈 모듈을 읽었다");
if (lib) {
  const { CARD_DEF, CARD_MIN, SIDE_DEF, sideCap, parseCard, clampCard, resizeCard } = lib;
  ok(CARD_DEF.w === 320 && CARD_DEF.h === 240, "D1a 카드 기본 크기 320×240", JSON.stringify(CARD_DEF));
  const d = parseCard(null);
  ok(d.w === 320 && d.h === 240, "D1b 적어 둔 값이 없으면 새 기본값", JSON.stringify(d));
  ok(CARD_MIN && CARD_MIN.w === 260 && CARD_MIN.h === 160 && CARD_MIN.w < CARD_DEF.w && CARD_MIN.h < CARD_DEF.h, "D2a 최소 크기는 기본보다 작다(260×160)", JSON.stringify(CARD_MIN));
  const exact = clampCard({ w: 260, h: 160, r: 24, b: 24 }, 1042, 843);
  ok(exact.w === 260 && exact.h === 160, "D2b 정확히 최소 크기까지 줄일 수 있다", JSON.stringify(exact));
  const shrunk = resizeCard({ w: 320, h: 240, r: 24, b: 24 }, "nw", 500, 500, 1042, 843);
  ok(shrunk.w === 260 && shrunk.h === 160, "D2c 끌어서 줄이면 최소 크기에서 멈춘다", JSON.stringify(shrunk));
  ok(SIDE_DEF === 340, "R1a 사이드바 기본 폭 340", String(SIDE_DEF));
  ok(Math.min(SIDE_DEF, sideCap(1042)) === 340, "R1b 넓은 창(격자 1042): 기본 폭 340");
  ok(sideCap(600) === 234 && Math.min(SIDE_DEF, sideCap(600)) === 234, "R1c 좁은 창(격자 600): 상한 234 가 기본 폭보다 작으면 상한", String(sideCap(600)));
}

// ── 화면(side-card.ts) ──
const card = code(read("web/v2/side-card.ts"));
ok(/const KEY_CARD = 'lively_v2_side_card2';/.test(card) && !/'lively_v2_side_card'/.test(card), "D3 저장 키가 새 이름이다(종전 큰 크기를 물려받지 않는다)");
const leave = card.slice(card.indexOf("async function leave("), card.indexOf("function halt("));
ok(leave.length > 0 && /Math\.min\(SIDE_DEF, cap\)/.test(leave) && !/h\.setSideW\(cap, true\)/.test(leave), "R1d 제자리로: 상한이 아니라 기본 폭으로 물러난다", leave.slice(0, 160));
ok(/const from = back \? Math\.max\(0, Math\.round\(bw\(\)\) - \(to as number\) - SPLIT_W\) : 0;/.test(leave) && /paintOver\(from\)/.test(leave) && /paintOver\(from \* \(1 - t\)\)/.test(leave), "R3 물러나는 움직임: 격자 전체를 덮은 거리에서 0 으로");
ok(/cmd: 'glass', on: v/.test(card) && /iframe\.sc-term-frame/.test(card), "G1a 카드인지 아닌지를 터미널 액자에 보낸다");
ok(/m\.type !== 'lively-term-status'/.test(card) && /window\.addEventListener\('message', onFrameMsg\)/.test(card) && /window\.removeEventListener\('message', onFrameMsg\)/.test(card), "G1b 액자가 늦게 떠 상태를 알려 오면 다시 보낸다(걷을 때 듣기도 뗀다)");
const paintSrc = card.slice(card.indexOf("function paint():"), card.indexOf("\n  }\n", card.indexOf("function paint():")));
ok(/paintLive\(\);/.test(paintSrc) && /postGlass\(\);/.test(paintSrc), "G1c 카드 상태를 그릴 때마다 또렷/비침과 액자 비침을 함께 맞춘다", paintSrc.slice(-120));
const plAt = card.indexOf("function paintLive(");
const paintLive = plAt >= 0 ? card.slice(plAt, card.indexOf("\n", plAt)) : "";
ok(/body\.classList\.toggle\('cm-live', shown\(\) && \(entering \|\| picked\)\)/.test(paintLive), "G2a 또렷 = 고름 또는 막 떠오름(cm-live)", paintLive);
ok(/picked = !!t && colMain\.contains\(t\)/.test(card) && /document\.addEventListener\('pointerdown', onDownCap, true\)/.test(card), "G2b 누른 곳이 카드 밖(사이드바)이면 고름이 풀린다");
ok(/window\.addEventListener\('blur', onWinBlur\)/.test(card) && /picked = focusInCard\(\)/.test(card), "G2c 터미널 액자에 초점이 가면(창 blur) 고른 것으로 친다");
ok(/window\.setInterval\(/.test(card) && /window\.clearInterval\(watchFocus\)/.test(card), "G2d 액자끼리 초점이 옮겨 가도 따라간다(걷을 때 멈춘다)");
const enter = card.slice(card.indexOf("async function enter("), card.indexOf("async function leave("));
ok(/picked = false;/.test(enter) && /liveForAWhile\(\)/.test(enter) && /ENTER_LIVE_MS = 1200/.test(card), "G3 막 떠오른 카드는 1.2초 또렷하다가 비친다");
const liveBlock = plAt >= 0 ? card.slice(plAt, card.indexOf("function liveForAWhile(")) : "";
ok(liveBlock.length > 0 && !/v2-dot|\bwait\b|termstat|sc-wait/.test(liveBlock), "G4 세션 상태로는 또렷해지지 않는다");

// ── panes.ts: 기본 폭은 한 값 ──
const panes = code(read("web/v2/panes.ts"));
ok(/import \{ SIDE_DEF \} from '\.\.\/lib\/side-card-geom\.js'/.test(panes) && /def: SIDE_DEF, min: 220/.test(panes) && /Number\(v\.sideW\) \|\| SIDE_DEF/.test(panes) && !/\|\| 340\b/.test(panes) && !/def: 340\b/.test(panes), "R2 panes 의 곁칸 기본 폭도 SIDE_DEF");

// ── CSS ──
const css = read("public/styles/45-v2-side-swap.css");
const media = css.indexOf("@media (min-width: 901px)");
const restAt = css.indexOf(".pn-body.cm:not(.cm-live) > .pn-col:not(:hover) {");
const rest = restAt >= 0 ? css.slice(restAt, css.indexOf("}", restAt)) : "";
ok(restAt > media && media >= 0 && css.lastIndexOf("@media", restAt) === media, "C2 비침 규칙은 넓은 폭 안에 있다");
ok(/background:\s*color-mix\(in srgb, var\(--bg\) \d+%, transparent\)/.test(rest) && /-webkit-backdrop-filter:\s*blur\(\d+px\)/.test(rest) && /(^|[^-])backdrop-filter:\s*blur\(\d+px\)/m.test(rest), "C1a 비칠 때: 반투명 바탕 + 뒤 흐림(-webkit- 포함)", rest.slice(0, 200));
const blurPx = Number((rest.match(/-webkit-backdrop-filter:\s*blur\((\d+)px\)/) || [])[1] || 0);
ok(blurPx >= 16, "C1b 뒤를 크게 흐린다(잔 글씨가 터미널 글씨와 겹치지 않게, 16px 이상)", String(blurPx));
ok(/\.pn-body\.cm > \.pn-col > \.pn-pane,\s*\.pn-body\.cm > \.pn-col \.sc-wrap,\s*\.pn-body\.cm > \.pn-col \.sc-term-frame,\s*\.pn-body\.cm > \.pn-col \.cm-ctl \{ background: transparent; \}/.test(css), "C1c 카드인 동안 안쪽은 늘 투명(바탕은 카드 한 곳)");
const cmAt = css.indexOf(".pn-body.cm > .pn-col {\n");
const cmRule = cmAt >= 0 ? css.slice(cmAt, css.indexOf("}", cmAt)) : "";
ok(/width: var\(--cm-w, 320px\); height: var\(--cm-h, 240px\)/.test(cmRule), "D1c CSS 의 대체값도 새 기본 크기", cmRule.slice(0, 200));

// ── 터미널 ──
const termSrc = read("web/standalone/terminal.ts");
const term = code(termSrc);
ok(/else if \(m\.cmd === 'glass'\) setGlass\(m\.on === true\);/.test(term), "T1a 액자가 glass 명령을 받는다");
const fnSrc = (name) => { const a = termSrc.indexOf("export function " + name + "("); if (a < 0) return ""; const b = termSrc.indexOf("\n}\n", a); return termSrc.slice(a, b + 2); };
const clearSrc = fnSrc("clearOf");
let clearOf = null;
if (clearSrc) { try { clearOf = (await load(clearSrc)).clearOf; } catch (e) { console.error(String(e)); } }
ok(!!clearOf, "T1b 바탕 비우기 함수(clearOf)가 있다");
if (clearOf) {
  ok(clearOf("#FFFFFF") === "rgba(255, 255, 255, 0)" && clearOf("#111726") === "rgba(17, 23, 38, 0)", "T1c 색은 그대로, 알파만 0", `${clearOf("#FFFFFF")} ${clearOf("#111726")}`);
  ok(clearOf("#fff") === "rgba(255, 255, 255, 0)" && clearOf("rgb(30, 30, 46)") === "rgba(30, 30, 46, 0)" && clearOf("#1e1e2eff") === "rgba(30, 30, 46, 0)", "T1d 짧은 hex · rgb() · 알파 붙은 hex");
  ok(clearOf("") === "rgba(255, 255, 255, 0)" && clearOf("blue") === "rgba(255, 255, 255, 0)" && clearOf(undefined) === "rgba(255, 255, 255, 0)", "T1e 빈 값 · 읽지 못하는 꼴은 투명한 흰색(검정이 아니다)");
}
const themeSets = term.match(/term\.options\.theme = [^;]+;/g) || [];
ok(themeSets.length >= 4 && themeSets.every((x) => /themeFor\(/.test(x)), "T2a xterm 테마를 바꾸는 자리는 전부 themeFor", themeSets.join(" | "));
ok(/theme: themeFor\(p\.theme\), allowTransparency: glassOn,/.test(term), "T2b 만들 때도 비침을 따른다");
ok(/term\.options\.allowTransparency = on;/.test(term), "T2c 켜고 끌 때 allowTransparency 도 함께");
const html = read("public/terminal.html").replace(/\n\s*/g, " ");
ok(/html\.term-glass \{ color-scheme: light; \}/.test(html) && /html\.term-glass\[data-theme="dark"\] \{ color-scheme: dark; \}/.test(html) && /html\.term-glass #term-host \{ background: transparent !important; \}/.test(html) && /html\.term-glass body,/.test(html), "T3 terminal.html: 문서 바탕을 걷고 color-scheme 을 맞춘다");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
