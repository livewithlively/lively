#!/usr/bin/env node
// 세션 카드 — 처음 자리 · 크기 · 알약(최소화)의 폭 조절 · 누르기 흐름을 실제 크롬에서 잰다 (#3870, 원준 2026-10-09)
//
//  원준: «처음 뜨는 위치 · 크기 · 처음 상태 · 최소화 이후 큰 화면으로 보는 플로우가 되는 대로 짜였다» ·
//   «최소화 상태에서 제목만 한 줄로 떠다닐 때 가로 폭 조절 안 됨».
//
// 사양(행마다 단언 하나 이상):
//  Q1 처음 자리: 세션이 왼쪽이면 사이드바(격자) 왼쪽 아래 — 격자 왼쪽 + 24 · 아래 24
//  Q2 처음 크기: 폭 360(세션 열의 마지막 폭) · 높이 = 창 높이 × 0.34
//  Q3 알약(최소화)은 좌우 손잡이만 보인다 · 오른쪽 손잡이를 끌면 폭이 그만큼 넓어진다(버그 수정)
//  Q4 알약을 한 번 누르면(끌지 않고) 잠깐 뒤 펴진다
//  Q5 알약을 두 번 누르면 펴지지 않고 곧장 크게(카드가 풀린다)
//  Q6 다시 카드가 되면 펼친 카드다(최소화한 채 크게 봤어도)
//  Q7 되살린 카드는 그 세션에 적어 둔 최소화를 따른다 — 적어 둔 최소화면 알약, 값이 없는 세션이면 펼친 카드(앞 세션 값이 따라오지 않는다, 2026-10-10)
//  Q8 카드가 아니면 cm-card-left(배율 단추 쪽 표식)가 없다
//  Q9 위에 올려 둔 알약의 폭을 바꿔도 윗변 그대로(튀지 않는다)
//  Q10 기본 자리 카드의 오른쪽 가장자리로 폭만 바꾸면 «옮긴 자리» 로 적지 않는다(크기만 적는다)
//  Q11 알약을 누르고 곧장 끌면 끄는 도중에 펴지지 않는다
//  (Q7~Q11 은 리뷰 2026-10-09 — 바꾸기 전 커밋 58d763c7a 를 물리면 빨갛다)
//  Q12 최소화 · 펴기 · 곁칸 고르기를 셸에 알린다(onState) — 되살린 값은 도로 알리지 않는다
//  Q13 되살린 고름: 곁칸을 골랐던 카드는 비친 채(cm-live 없음) · 카드를 골랐던 · 값이 없는 카드는 또렷(2026-10-10 «새로고침하면 상태가 계속 달라짐»)
//
// fail-first(실측 2026-10-09): 바꾸기 전 web/lib/side-card-geom.ts · web/v2/side-card.ts 를 SIDE_CARD_SRC 로 물리면 Q1 · Q2 · Q3 · Q4 가 빨갛다
//  (Q5 · Q6 은 종전에도 맞았다 — 지키려고 둔다).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
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
    const VH=document.documentElement.clientHeight;
    const states=[]; const card=Card.mountSideCard({body:grid,colMain:col,sidePane:pane,sideOn:()=>true,setSideW:()=>{},sessionLeft:()=>true,onState:(s)=>states.push(s)});
    card.restore(true); await sleep(60);
    let r=rc(col); const g=rc(grid);
    R.q1_info=[Math.round(r.left),Math.round(VH-r.bottom),Math.round(g.left)]; R.q1=Math.abs(r.left-(g.left+24))<=1.5 && Math.abs(VH-r.bottom-24)<=1.5;
    R.q2_info=[Math.round(r.width),Math.round(r.height),VH]; R.q2=Math.abs(r.width-360)<=1 && Math.abs(r.height-Math.max(260,Math.min(400,Math.round(VH*0.34))))<=1;
    const P=(type,x,y,t)=>t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:1,pointerId:7,pointerType:'mouse'}));
    // Q3 — 최소화 → 좌우 손잡이만 · 오른쪽 손잡이로 폭 넓히기
    col.querySelector('.cm-min-b, .cm-fold-b').click(); await sleep(30);
    const vis=(e)=>{const n=col.querySelector('.cm-grip-'+e); return !!n && !n.hidden && getComputedStyle(n).display!=='none';};
    const w0=rc(col).width;
    const ge=col.querySelector('.cm-grip-e'); const eb=rc(ge);
    if (vis('e')) { const x=eb.left+eb.width/2, y=eb.top+eb.height/2; P('pointerdown',x,y,ge); P('pointermove',x+60,y,ge); P('pointermove',x+120,y,ge); P('pointerup',x+120,y,ge); await sleep(30); }
    r=rc(col);
    R.q3_info=[vis('e'),vis('w'),vis('n'),vis('se'),Math.round(w0),Math.round(r.width),grid.classList.contains('cm-fold')];
    R.q3=vis('e') && vis('w') && !vis('n') && !vis('se') && Math.abs(r.width-(w0+120))<=2 && grid.classList.contains('cm-fold');
    // Q4 — 알약을 한 번 누름(끌지 않고) → 잠깐 뒤 펴진다
    const hb=rc(head); const hx=hb.left+40, hy=hb.top+hb.height/2;
    P('pointerdown',hx,hy,head); P('pointerup',hx,hy,head); head.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:hx,clientY:hy,detail:1}));
    const mid=grid.classList.contains('cm-fold'); await sleep(320);
    R.q4_info=[mid,grid.classList.contains('cm-fold')]; R.q4=mid===true && !grid.classList.contains('cm-fold');
    // Q5 — 다시 최소화 → 두 번 누름 → 펴지지 않고 곧장 크게(카드가 풀린다)
    col.querySelector('.cm-min-b, .cm-fold-b').click(); await sleep(30);
    const hb2=rc(head); const x2=hb2.left+40, y2=hb2.top+hb2.height/2;
    for (const d of [1,2]) { P('pointerdown',x2,y2,head); P('pointerup',x2,y2,head); head.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x2,clientY:y2,detail:d})); }
    head.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:x2,clientY:y2,detail:2}));
    let unfolded=false; for (let i=0;i<10;i++){ await sleep(40); if (grid.classList.contains('cm') && !grid.classList.contains('cm-fold')) unfolded=true; }
    R.q5_info=[grid.classList.contains('cm'),unfolded]; R.q5=!grid.classList.contains('cm') && !unfolded;
    // Q6 — 다시 카드가 되면 펼친 카드
    card.restore(true); await sleep(60);
    R.q6_info=[grid.classList.contains('cm'),grid.classList.contains('cm-fold')]; R.q6=grid.classList.contains('cm') && !grid.classList.contains('cm-fold');
    const fold=()=>grid.classList.contains('cm-fold'); const minB=()=>col.querySelector('.cm-min-b, .cm-fold-b');
    const saved=()=>JSON.parse(localStorage.getItem('lively_v2_side_card3')||'null');
    const drag=async(t,dx,dy)=>{const b=rc(t); const x=b.left+(t===head?30:b.width/2), y=b.top+b.height/2; P('pointerdown',x,y,t); P('pointermove',x+dx/2,y+dy/2,t); P('pointermove',x+dx,y+dy,t); P('pointerup',x+dx,y+dy,t); await sleep(30);};
    // Q8 — 카드가 아니면 cm-card-left 가 없다
    card.restore(false); await sleep(40);
    R.q8_info=grid.className; R.q8=!grid.classList.contains('cm') && !grid.classList.contains('cm-card-left');
    // Q7 — 적어 둔 최소화를 따른다 · 값이 없는 세션은 펼친 카드
    card.restore(true,{fold:true}); await sleep(40); const f0=fold();
    card.restore(false); card.restore(true); await sleep(40); const f1=fold();
    card.restore(true,{fold:false}); await sleep(40); const f2=fold();
    R.q7_info=[f0,f1,f2,grid.classList.contains('cm')]; R.q7=f0 && !f1 && !f2 && grid.classList.contains('cm');
    // Q12 — 셸에 알린다: 최소화 · 펴기 · 곁칸 고르기. 되살린 값은 도로 알리지 않는다
    states.length=0; card.restore(true,{fold:false,pick:true}); await sleep(30); const afterRestore=states.length;
    minB().click(); await sleep(30); const sFold=states[states.length-1];
    minB().click(); await sleep(30); const sOpen=states[states.length-1];
    pane.firstElementChild.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:9,pointerType:'mouse'})); await sleep(30); const sSide=states[states.length-1];
    R.q12_info=[afterRestore,JSON.stringify(sFold),JSON.stringify(sOpen),JSON.stringify(sSide)];
    R.q12=afterRestore===0 && !!sFold && sFold.fold===true && !!sOpen && sOpen.fold===false && !!sSide && sSide.pick===false;
    // Q13 — 되살린 고름
    card.restore(true,{pick:false}); await sleep(40); const live0=grid.classList.contains('cm-live');
    card.restore(true,{pick:true}); await sleep(40); const live1=grid.classList.contains('cm-live');
    card.restore(true); await sleep(40); const live2=grid.classList.contains('cm-live');
    R.q13_info=[live0,live1,live2]; R.q13=!live0 && live1 && live2;
    card.restore(true); await sleep(30);
    // Q10 — 기억을 지우고(Home) 오른쪽 가장자리로 폭만 넓힌다
    col.querySelector('.cm-grip-nw').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true})); await sleep(30);
    const wA=rc(col).width; await drag(col.querySelector('.cm-grip-e'),40,0); const sv=saved();
    R.q10_info=[Math.round(wA),Math.round(rc(col).width),JSON.stringify(sv)]; R.q10=!!sv && sv.sized===true && sv.placed===false && Math.abs(rc(col).width-(wA+40))<=2;
    // Q9 — 알약을 맨 위로 올리고 오른쪽 가장자리로 폭을 바꾼다
    minB().click(); await sleep(30); await drag(head,0,-5000); const t0=rc(col).top, w9=rc(col).width;
    await drag(col.querySelector('.cm-grip-e'),60,0);
    R.q9_info=[Math.round(t0),Math.round(rc(col).top),Math.round(w9),Math.round(rc(col).width),fold()]; R.q9=fold() && Math.abs(rc(col).top-t0)<=1.5 && Math.abs(rc(col).width-(w9+60))<=2;
    // Q11 — 알약을 누르고(펴기 예약) 곧장 끈다 → 다 끌고 기다려도 접힌 채
    const hb3=rc(head); const x3=hb3.left+40, y3=hb3.top+hb3.height/2;
    P('pointerdown',x3,y3,head); P('pointerup',x3,y3,head); head.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x3,clientY:y3,detail:1}));
    await drag(head,0,200); await sleep(320);
    R.q11_info=[fold(),Math.round(rc(col).top)]; R.q11=fold() && rc(col).top>t0+100;
  }catch(e){R.err=String(e&&e.stack||e);}
  document.getElementById('out').textContent='RESULT '+JSON.stringify(R)+' ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "side-card-pill-", virtualTimeBudget: 15000, args: ["--window-size=1400,900"] });
const m = /RESULT (\{.*\}) ENDRESULT/s.exec(dom);
if (!m) { console.error("FAIL  크롬이 결과를 안 냈다 — 받은 DOM " + dom.length + "자"); process.exit(1); }
const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const R = JSON.parse(raw);
let pass = 0, fail = 0;
const check = (c, n, info = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${info}`); } };
check(!R.err, "Q0 장면이 끝까지 돈다", R.err);
check(R.q1, "Q1 처음 자리: 세션 쪽(왼쪽) 사이드바 아래 모서리 — 격자 왼쪽 + 24 · 아래 24", JSON.stringify(R.q1_info));
check(R.q2, "Q2 처음 크기: 폭 360 · 높이 창 × 0.34", JSON.stringify(R.q2_info));
check(R.q3, "Q3 알약은 좌우 손잡이만 · 오른쪽 손잡이로 폭이 넓어진다(원준 10-09 «최소화 상태에서 가로 폭 조절 안 됨»)", JSON.stringify(R.q3_info));
check(R.q4, "Q4 알약을 한 번 누르면 잠깐 뒤 펴진다", JSON.stringify(R.q4_info));
check(R.q5, "Q5 알약을 두 번 누르면 펴지지 않고 곧장 크게", JSON.stringify(R.q5_info));
check(R.q6, "Q6 다시 카드가 되면 펼친 카드", JSON.stringify(R.q6_info));
check(R.q7, "Q7 되살린 카드는 그 세션에 적어 둔 최소화를 따른다(값이 없으면 펼침)", JSON.stringify(R.q7_info));
check(R.q12, "Q12 최소화 · 펴기 · 곁칸 고르기를 셸에 알린다 · 되살린 값은 도로 안 알린다", JSON.stringify(R.q12_info));
check(R.q13, "Q13 곁칸을 골랐던 카드는 비친 채 · 카드를 골랐던 · 값 없는 카드는 또렷", JSON.stringify(R.q13_info));
check(R.q8, "Q8 카드가 아니면 cm-card-left 가 없다", JSON.stringify(R.q8_info));
check(R.q9, "Q9 위에 올려 둔 알약의 폭을 바꿔도 윗변 그대로", JSON.stringify(R.q9_info));
check(R.q10, "Q10 폭만 바꾸면 크기만 적고 «옮긴 자리» 로는 적지 않는다", JSON.stringify(R.q10_info));
check(R.q11, "Q11 알약을 누르고 곧장 끌면 끄는 도중에 펴지지 않는다", JSON.stringify(R.q11_info));
console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
