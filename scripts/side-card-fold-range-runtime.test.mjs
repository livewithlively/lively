#!/usr/bin/env node
// 세션 카드 — 최소화한 카드의 이동 범위를 실제 크롬에서 잰다 (#3870 · #4443, 원준 2026-10-07)
//
//  원준: «최소화 상태에서는 또;; 터미널 세션 곁칸 위에 창으로 떴을 때 이동 범위에 제약있음» — 최소화한 카드는 머리줄만 남는데
//   자리의 세로 범위는 편 높이로 세어서, 창 위쪽 (편 높이 − 머리줄)만큼은 머리줄이 갈 수 없었다.
//
// 사양(행마다 단언 하나 이상):
//  M1 편 카드를 머리줄로 끌어 맨 위로 — 카드 윗변이 창 위 여백(8)에 선다(종전과 같다)
//  M2 최소화하면 머리줄만 남는다(높이 < 80)
//  M3 최소화한 카드를 맨 위로 끌면 **머리줄이** 창 위 여백(8)에 선다 — 종전엔 편 높이만큼 아래에서 멈췄다
//  M4 최소화한 카드를 맨 아래 · 왼쪽 끝으로 끌어도 창 안(여백 8)
//  M5 위에 올려 둔 채 펴면 카드 전체가 창 안으로 내려온다 · 적어 둔 자리는 위 모서리 기준(접힘은 적지 않는다, 2026-10-09)
//  M6 Shift+화살표(글쇠)로도 최소화한 카드가 편 카드의 한계보다 위로 간다
//
// 왜 런타임인가: 머리줄 높이는 CSS 가 그린 뒤에야 알고, 카드는 position: fixed 라 창에서 잰 자리만 뜻이 있다.
// fail-first: 바꾸기 전 web/lib/side-card-geom.ts · web/v2/side-card.ts 를 제자리에 물리면 M3 · M6 이 빨갛다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 세션 카드 최소화 범위 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const SRC = process.env.SIDE_CARD_SRC || path.join(ROOT, "web/v2/side-card.ts");
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=Card", "--platform=browser", "--log-level=error", "--loader=ts", "--sourcefile=card-test-entry.ts"],
  { input: `export * from ${JSON.stringify(SRC)};\n`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const STY = path.join(ROOT, "public/styles");
const CSS = ["01-base.css", "36-chat.css", "40-v2.css", "42-v2-panes.css", "45-v2-side-swap.css"].map((f) => readFileSync(path.join(STY, f), "utf8")).join("\n");

const PAGE = `<!doctype html><meta charset="utf-8"><style>${CSS}
  html,body{margin:0;height:100%;font:14px sans-serif;background:var(--bg)}
  *,*::before,*::after{transition:none!important;animation:none!important}
  #wrap{position:absolute;left:120px;top:60px;right:0;bottom:0}
</style>
<div id="wrap" class="pn-wrap"><div id="grid" class="pn-body">
  <div class="pn-col" id="col"><div class="sc-wrap"><div id="head" class="sc-head"><div class="sc-head-l"><b>세션</b></div></div><div class="sc-body" style="flex:1;min-height:0">터미널</div></div></div>
  <div class="v2-split-x" id="split"></div>
  <section id="pane" class="pn-pane" data-zone="side"><div class="pn-pane-body">사이드바</div></section>
</div></div>
<pre id="out">PENDING</pre>
<script>try{localStorage.clear()}catch(e){}
window.requestAnimationFrame=(cb)=>setTimeout(()=>cb(performance.now()),16); window.cancelAnimationFrame=(id)=>clearTimeout(id);
//  움직임 없이(카드로 바뀌는 전환을 기다리지 않는다).
(function(){const mm=window.matchMedia.bind(window);window.matchMedia=(q)=>/prefers-reduced-motion/.test(q)?{matches:true,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}:mm(q);})();</script>
<script>${bundle}</script>
<script>
(async function(){
  const R={}; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const rc=(n)=>n.getBoundingClientRect();
  try{
    const grid=document.getElementById('grid'), col=document.getElementById('col'), pane=document.getElementById('pane'), head=document.getElementById('head');
    const VH=document.documentElement.clientHeight, VW=document.documentElement.clientWidth;
    const card=Card.mountSideCard({body:grid,colMain:col,sidePane:pane,sideOn:()=>true,setSideW:()=>{}});
    card.restore(true); await sleep(60);
    R.m0_card=grid.classList.contains('cm') && getComputedStyle(col).position==='fixed';
    const P=(type,x,y,t)=>t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:1,pointerId:5,pointerType:'mouse'}));
    const drag=async(dx,dy)=>{const r=rc(head); const x=r.left+30,y=r.top+r.height/2; P('pointerdown',x,y,head); P('pointermove',x+dx/2,y+dy/2,head); P('pointermove',x+dx,y+dy,head); P('pointerup',x+dx,y+dy,head); await sleep(30);};
    //  저장 열쇠: 2026-10-09 부터 lively_v2_side_card3 — 자리는 «가장 가까운 모서리 + 거리», 접힘은 적지 않는다(카드는 늘 펼쳐서 뜬다).
    const saved=()=>JSON.parse(localStorage.getItem('lively_v2_side_card3')||'null');
    // M1 — 편 카드를 맨 위로
    await drag(0,-5000); let r=rc(col); const fullH=r.height;
    R.m1_info=[Math.round(r.top),Math.round(r.height)]; R.m1=Math.abs(r.top-8)<=1.5 && r.height>=200;
    // M2 — 최소화
    col.querySelector('.cm-min-b, .cm-fold-b').click(); await sleep(30); r=rc(col);
    R.m2_info=[Math.round(r.top),Math.round(r.height)]; R.m2=grid.classList.contains('cm-fold') && r.height<80 && r.height>=30;
    // M3 — 최소화한 카드를 맨 위로
    await drag(0,-5000); r=rc(col);
    R.m3_info=[Math.round(r.top),Math.round(r.height),Math.round(fullH)]; R.m3=Math.abs(r.top-8)<=2.5;
    // M6 — 글쇠: 아래로 내렸다가 Shift+↑ 를 넉넉히 — 편 카드의 한계(창 높이 − 편 높이 − 8 … 머리줄은 그 아래)보다 위로
    await drag(0,300);
    const grip=col.querySelector('.cm-grip-nw'); for(let i=0;i<80;i++) grip.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',shiftKey:true,bubbles:true,cancelable:true}));
    await sleep(30); r=rc(col); R.m6_info=Math.round(r.top); R.m6=Math.abs(r.top-8)<=2.5;
    // M4 — 맨 아래 · 왼쪽 끝
    await drag(-5000,5000); r=rc(col);
    R.m4_info=[Math.round(r.left),Math.round(VH-r.bottom)]; R.m4=Math.abs(r.left-8)<=1.5 && Math.abs(VH-r.bottom-8)<=1.5;
    // M5 — 위에 올려 둔 채 펴면 창 안으로
    await drag(0,-5000); col.querySelector('.cm-min-b, .cm-fold-b').click(); await sleep(30); r=rc(col); const sv=saved();
    R.m5_info=[Math.round(r.top),Math.round(r.bottom),VH,JSON.stringify(sv)];
    //  적어 둔 자리: 위 모서리(t*)에 붙은 «옮긴 자리» · 접힘은 적지 않는다 — 편 카드는 그 모서리에서 아래로 펴져 창 안에 선다.
    R.m5=!grid.classList.contains('cm-fold') && r.top>=8-1.5 && r.bottom<=VH-8+1.5 && Math.abs(r.height-fullH)<=1 && !!sv && sv.placed===true && String(sv.corner).startsWith('t') && !('fold' in sv);
  }catch(e){R.err=String(e&&e.stack||e);}
  document.getElementById('out').textContent='RESULT '+JSON.stringify(R)+' ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "side-card-fold-", virtualTimeBudget: 15000, args: ["--window-size=1400,900"] });
const m = /RESULT (\{.*\}) ENDRESULT/s.exec(dom);
if (!m) { console.error("FAIL  크롬이 결과를 안 냈다 — 받은 DOM " + dom.length + "자"); process.exit(1); }
const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const R = JSON.parse(raw);
let pass = 0, fail = 0;
const check = (c, n, info = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${info}`); } };
check(!R.err, "M0 장면이 끝까지 돈다", R.err);
check(R.m0_card, "M0b 카드 상태 — 세션 열이 창에 고정(fixed)된 카드");
check(R.m1, "M1 편 카드를 머리줄로 끌어 맨 위로 — 윗변이 창 위 여백(8)", JSON.stringify(R.m1_info));
check(R.m2, "M2 최소화하면 머리줄만 남는다", JSON.stringify(R.m2_info));
check(R.m3, "M3 최소화한 카드를 맨 위로 끌면 머리줄이 창 위 여백(8)에 선다(원준 10-07 «최소화 상태에서는 … 이동 범위에 제약»)", JSON.stringify(R.m3_info));
check(R.m6, "M6 Shift+화살표로도 최소화한 카드가 창 맨 위까지 간다", String(R.m6_info));
check(R.m4, "M4 최소화한 카드를 맨 아래 · 왼쪽 끝으로 끌어도 창 안(여백 8)", JSON.stringify(R.m4_info));
check(R.m5, "M5 위에 올려 둔 채 펴면 카드 전체가 창 안으로 내려오고, 적어 둔 자리도 창 안", JSON.stringify(R.m5_info));
console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
