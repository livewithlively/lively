// #3870 후속 (원준 2026-10-01 · 10-07): 세션 카드가 들어온 뒤 생긴 세 가지.
//  ① «세션이 왼쪽에서 30% 정도로 작아져도 좌우가 바뀌는 기능이 사라짐 — 둘 다 되게»
//  ② «곁칸 위 카드로 대화할 때 커서가 랙걸려서 새로고침 · 화면복구를 해야 하는 일이 종종 — 안정적으로»
//  ③ «카드를 움직일 수 있는 범위가 창 전체였으면 — 지금은 곁칸 안쪽으로 너무 제한적»
//  화면 web/v2/side-card.ts · web/v2/side-swap.ts · web/v2/panes.ts · 셈 web/lib/side-swap-judge.ts · 터미널 web/standalone/terminal.ts · CSS 45-v2-side-swap.css
//
//  원인(① 둘):
//   a. 세션 열이 최소 폭(360)에 닿고 손이 조금이라도 더 가면 카드 전환 구간이다. 거기서 덜 넘겨 놓으면 카드가 «취소» 로 받고
//      panes 가 자리바꿈 판정을 통째로 건너뛰었다(onRelease() 가 참이면 return).
//   b. 사이드바 상한 = 격자 − 366. 격자가 762 보다 좁으면 상한이 52% 에 못 미쳐 자리바꿈이 영영 안 일어난다(1116 창 = 격자 718 → 49%).
//
//  사양 · 엣지 표(spec-failfirst):
//   SW1 좁은 격자(718): 상한까지 키우면 넘어간다 · 돌아오는 문턱은 그보다 낮고 하한보다 높다
//   SW2 넓은 격자(1042 · 1600): 문턱은 종전 그대로 52 / 46
//   SW3 끌 거리가 없는 격자(상한 = 하한, ≤ 586): 넘어가지 않는다 · 왼쪽이면 돌아온다
//   SW4 모든 격자 폭(600~3000)에서: 상한에 닿으면 넘어가고, 하한까지 줄이면 돌아온다, 돌아오는 문턱 < 넘어가는 문턱
//   SW5 되살릴 때도 그 격자의 문턱으로 판정한다
//   SW6 side-swap: 놓을 때 · 끄는 중 예고 · 되살릴 때 · 첫 측정이 모두 그 격자의 문턱을 쓴다
//   SR1 panes: 카드 구간에서 덜 넘겨 놓아도 자리바꿈을 판정하고 폭을 적는다(카드가 물러난 뒤)
//   SR2 side-card: 덜 넘겨 놓으면 물러나는 움직임이 끝나고(판이 살아 있을 때만) back 을 부른다. 카드가 될 때는 부르지 않는다
//   V1 side-card: 카드의 자리 · 크기 셈은 창 크기(vw · vh)로 한다. 사이드바 폭 셈은 격자(bw)
//   V2 side-card: 창 크기가 바뀌면 카드를 창 안으로 다시 넣는다(destroy 가 걷는다)
//   V3 CSS: 카드는 position: fixed, z-index 는 레일 · 사이드바(≤ 45) 위 · 레일 메뉴(60) 아래
//   (stage 판: T1~T3 없음 — 카드 비침 연동이 stage 에 없다)
//   T1 터미널: 카드인 동안(glassOn) 크기를 새로 알렸으면 크기가 멈춘 뒤 한 번 화면을 다시 맞춘다(forceRedraw = 화면 복구의 재캡처)
//   T2 터미널: 카드가 되거나 풀릴 때도 같은 재맞춤을 건다(풀릴 때는 glassOn 이 이미 꺼져 있다)
//   T3 터미널: 재맞춤은 디바운스(끄는 동안 여러 번 바뀌어도 한 번) · 연결이 열려 있을 때만
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail ? " : " + detail : ""}`); } };
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const load = async (p) => {
  const src = read(p);
  if (!src) return null;
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  try { return await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`); } catch { return null; }
};

// ── ① 자리바꿈 문턱 ──
const geom = await load("web/lib/side-card-geom.ts");
const jud = await load("web/lib/side-swap-judge.ts");
ok(!!geom && !!jud, "L0 셈 모듈을 읽었다");
const thOk = jud && typeof jud.swapThFor === "function";
ok(thOk, "SW0 격자 폭마다 문턱을 정하는 함수(swapThFor)가 있다");
if (geom && thOk) {
  const { sideCap, SIDE_MIN } = geom;
  const { swapThFor, judgeSwap, placeOnRestore, SWAP_TH } = jud;
  const th = (w) => swapThFor(w, sideCap(w), SIDE_MIN);
  const at = (w, px, cur) => judgeSwap(px / w, cur, th(w));

  const w718 = 718, cap718 = sideCap(w718);
  ok(cap718 / w718 < 0.52, "SW1a 전제: 격자 718 의 상한은 52% 에 못 미친다", (cap718 / w718).toFixed(3));
  ok(at(w718, cap718, false) === true, "SW1b 격자 718: 상한까지 키우면 왼쪽으로 넘어간다", JSON.stringify(th(w718)));
  ok(at(w718, cap718 - 10, false) === false, "SW1c 격자 718: 상한 10px 전에서는 아직 안 넘어간다");
  const t718 = th(w718);
  ok(t718.off < t718.on && t718.off > SIDE_MIN / w718, "SW1d 격자 718: 돌아오는 문턱은 넘어가는 문턱보다 낮고 하한보다 높다", JSON.stringify(t718));
  ok(at(w718, SIDE_MIN, true) === false && at(w718, cap718 - 10, true) === true, "SW1e 격자 718: 하한까지 줄이면 돌아오고, 상한 근처에서는 왼쪽을 지킨다");

  for (const w of [1042, 1600]) {
    const t = th(w);
    ok(t.on === SWAP_TH.on && t.off === SWAP_TH.off, `SW2 격자 ${w}: 문턱은 종전 그대로`, JSON.stringify(t));
  }
  ok(judgeSwap(0.52, false) === true && judgeSwap(0.46, true) === false, "SW2b 문턱을 안 주면 종전 문턱(52 / 46)");

  const t500 = th(500);
  ok(sideCap(500) === SIDE_MIN && judgeSwap(1, false, t500) === false, "SW3a 끌 거리가 없는 격자(500): 넘어가지 않는다", JSON.stringify(t500));
  ok(judgeSwap(SIDE_MIN / 500, true, t500) === false, "SW3b 끌 거리가 없는 격자(500): 왼쪽이었으면 돌아온다");

  let bad = "";
  for (let w = 600; w <= 3000; w += 7) {   // 587~599 는 끌 거리가 1~13px 라 SW3 쪽이다
    const t = th(w), cap = sideCap(w);
    if (!(at(w, cap, false) === true)) { bad = `${w}: 상한 ${cap} 에서 안 넘어감 ${JSON.stringify(t)}`; break; }
    if (!(at(w, SIDE_MIN, true) === false)) { bad = `${w}: 하한에서 안 돌아옴 ${JSON.stringify(t)}`; break; }
    if (!(t.off < t.on)) { bad = `${w}: 문턱 순서 ${JSON.stringify(t)}`; break; }
  }
  ok(!bad, "SW4 격자 600~3000 전부: 상한이면 넘어가고, 하한이면 돌아오고, 돌아오는 문턱이 더 낮다", bad);

  const P = (o) => placeOnRestore({ enabled: true, remembered: undefined, measurable: true, cur: false, th: th(w718), ...o });
  ok(P({ ratio: cap718 / w718 }) === true, "SW5a 되살릴 때(적어 둔 자리 없음): 좁은 격자의 상한 폭이면 왼쪽");
  ok(P({ remembered: true, ratio: cap718 / w718 }) === true, "SW5b 되살릴 때: 적어 둔 «왼쪽» 이 좁은 격자의 상한 폭이면 그대로 왼쪽(46% 로 뒤집지 않는다)");
}

const swap = code(read("web/v2/side-swap.ts"));
const seg = (a, b) => { const i = swap.indexOf(a); return i < 0 ? "" : swap.slice(i, b ? swap.indexOf(b, i + a.length) : i + 600); };
const fnEnd = seg("function onEnd(", "function onDrag("), fnDrag = seg("function onDrag(", "function hideHint("), fnRst = seg("function restore(", "function onEnd(");
ok(/judgeSwap\(ratio\(px\), swapped, thFor\(body\.clientWidth\)\)/.test(fnEnd), "SW6a side-swap onEnd: 그 격자의 문턱으로 판정한다", fnEnd.slice(0, 200));
ok(/judgeSwap\([^)]*,\s*thFor\(body\.clientWidth\)\)/.test(fnDrag), "SW6b side-swap onDrag: 예고도 같은 문턱");
ok(/th:\s*thFor\(body\.clientWidth\)/.test(fnRst), "SW6c side-swap restore: 되살릴 때도 같은 문턱");
ok(/if \(first\) \{[^\n]*thFor\(w\)\.off/.test(swap) && !/\bTH\.off\b/.test(swap), "SW6d side-swap 첫 측정: 같은 문턱");
ok(/const thFor = \(bodyW: number\) => swapThFor\(bodyW, sideCap\(bodyW\), SIDE_MIN\)/.test(swap), "SW6e side-swap: 문턱은 상한(sideCap) · 하한(SIDE_MIN)으로 센다");

// ── ① 카드 구간에서 덜 넘겨 놓기 ──
const panes = code(read("web/v2/panes.ts"));
const endWire = (() => { const i = panes.indexOf("onEnd: (px) => {\n      const settle"); return i < 0 ? "" : panes.slice(i, panes.indexOf("\n    },", i)); })();
ok(/const settle = \(\): void => \{\s*swap\?\.onEnd\(px\);\s*saveView\(\{\s*sideW: Math\.round\(px\)\s*\}\);\s*\};/.test(endWire)
  && /if \(card\?\.onRelease\(settle\)\) return;\s*settle\(\);/.test(endWire), "SR1 panes: 카드가 받아도(덜 넘김) 자리바꿈 판정과 폭 적기를 넘긴다", endWire.slice(0, 160));

const card = code(read("web/v2/side-card.ts"));
const fnBody = (name) => { const a = card.indexOf(name); if (a < 0) return ""; const b = card.indexOf("\n  }\n", a); return card.slice(a, b); };
const rel = fnBody("function onRelease(");
ok(/function onRelease\(back\?: \(\) => void\): boolean/.test(rel) && /void cancel\(from, back\)/.test(rel) && /void enter\(from\)/.test(rel), "SR2a side-card onRelease: 덜 넘기면 cancel 에 back 을 넘기고, 카드가 될 때는 넘기지 않는다", rel.slice(0, 200));
const can = fnBody("async function cancel(");
const iAlive = can.lastIndexOf("if (!alive()) return;"), iBack = can.indexOf("back?.()");
ok(iBack > 0 && iAlive > 0 && iBack > iAlive && iBack > can.indexOf("busy = false"), "SR2b side-card cancel: 움직임이 끝나고 판이 살아 있을 때 back 을 부른다", can.slice(0, 300));

// ── ③ 창 전체 ──
const rectFns = [fnBody("function paintRect("), fnBody("function dragStart("), card.slice(card.indexOf("keyGrip.addEventListener('keydown'"), card.indexOf("const onHeadDbl"))];
ok(rectFns.every((b) => b.length > 0 && /vw\(\)/.test(b) && /vh\(\)/.test(b) && !/\bbh\(\)/.test(b) && !/clampCard\(card, bw\(\)/.test(b)), "V1a side-card: 카드 자리 · 크기 셈(그리기 · 끌기 · 글쇠)은 창 크기로 한다");
ok(/const vw = \(\): number => document\.documentElement\.clientWidth/.test(card) && /const vh = \(\): number => document\.documentElement\.clientHeight/.test(card), "V1b side-card: 창 크기는 문서의 보이는 폭 · 높이");
ok(/const capNow = \(\): number \| null => \(bw\(\) > 0 \? sideCap\(bw\(\)\) : null\)/.test(card) && /overZone\(bw\(\)\)/.test(card), "V1c side-card: 사이드바 폭 셈은 그대로 격자로");
ok(/window\.addEventListener\('resize', onWinResize\)/.test(card) && /window\.removeEventListener\('resize', onWinResize\)/.test(card), "V2 side-card: 창 크기가 바뀌면 카드를 다시 넣고, destroy 가 걷는다");

const css = read("public/styles/45-v2-side-swap.css");
const cmRule = css.slice(css.indexOf(".pn-body.cm > .pn-col {"), css.indexOf("}", css.indexOf(".pn-body.cm > .pn-col {")));
const z = Number((cmRule.match(/z-index:\s*(\d+)/) || [])[1]);
ok(/position:\s*fixed/.test(cmRule), "V3a CSS: 카드는 창 기준(fixed)", cmRule.slice(0, 120));
const css40 = read("public/styles/40-v2.css");
const wsMenuZ = Number((css40.match(/\.v2-ws-menu \{[^}]*z-index:\s*(\d+)/) || [])[1]);
ok(z > 45 && wsMenuZ > 0 && z < wsMenuZ, "V3b CSS: 카드 z-index 는 사이드바(45) 위 · 레일 메뉴 아래", `card ${z} · ws-menu ${wsMenuZ}`);

// ── ② 터미널 — stage 에는 카드 비침(glass) 연동이 없어 이 판에는 옮기지 않았다(main 판에만 T1~T3) ──

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
