#!/usr/bin/env node
// 세션 카드 — 최소화는 언제나 최소 폭 · 비친 뒤 곁칸을 한 번 더 누르면 최소화 · 처음 크기 · 옛 기억 잇기를 실제 크롬에서 잰다 (#3870, 원준 2026-10-11)
//
//  원준: «곁칸 늘려서 팝업으로 뜰 때 사이즈가 너무 크게 뜨는 거 같음» · «한 번 밖에 누르면 투명해지잖아. 투명해진 다음에 한 번 더 누르면
//   최소화되는 걸로» · «최소화될 때 가로 사이즈 유지하지 말고 가로 사이즈도 최소로 줄여 버려. 최소화하는 모든 과정에 적용»
//
// 사양(행마다 단언 하나 이상) — 엣지 표 전체는 side-card-pill2.test.mjs 머리글:
//  N1c 옛 기억(card3: 바꾼 크기 480×320 · 옮긴 자리 tr 60 60) → 크기는 기본값(320) · 자리는 오른쪽 위 60 · 60
//  N1d 새 기억(card4: 400×250)이 있으면 그것만(card3 는 안 읽는다)
//  N2 카드 480 → 최소화 → 알약 260 · 펴면 480 · N3 오른쪽 모서리 카드는 오른쪽 가장자리 그대로 · N3b 왼쪽 모서리는 왼쪽 그대로
//  N4 알약 오른쪽 손잡이 +100 → 360 · 펴면 카드 480 그대로 · 다시 최소화 → 260
//  N5 되살린 알약(restore fold) → 260
//  N6 비친 카드에서 곁칸 누름 → 최소화 · N6b 또렷한 카드에서 누름 → 비침만, 한 번 더 → 최소화 · N6c 막 떠오르는 중 누름 → 비침만
//  N6d 7px 끌고 놓음 → 그대로 · N6f 정확히 6px → 최소화 · N6e 이미 알약이면 누름 → 그대로
//  N7 비친 카드 · 곁칸 안 액자로 초점이 들어감(창 blur) → 최소화 안 함
//  N8 알약 상태 글쇠 ← → 알약 폭만 · 카드 크기 그대로 · N9 Home → 알약 260 · 카드 기본 크기
//
// fail-first: 바꾸기 전 web/lib/side-card-geom.ts · web/v2/side-card.ts 를 제자리에 물리면 빨갛다(실측은 커밋 메시지).
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
  <div class="pn-col" id="col"><div class="sc-wrap"><div id="head" class="sc-head"><div class="sc-head-l"><span class="v2-dot busy"></span><span class="sc-titlebox"><button class="sc-title sc-title-btn" type="button"><span class="sc-title-t">그 우리 우측 곁칸 제일 크게 댕기면 세션이 위에</span><svg width="13" height="13"><path d="M0 0h8v8z"/></svg></button><span class="sc-title-no mono">#4620</span></span></div><div class="sc-head-r"><span class="sc-pair"><span id="tstat" class="sc-termstat ok">연결됨</span></span><button class="btn-text sc-act" id="more" type="button">⋯</button></div></div><div class="sc-body" style="flex:1;min-height:0">터미널</div></div></div>
  <div class="v2-split-x" id="split"></div>
  <section id="pane" class="pn-pane" data-zone="side"><div class="pn-pane-body">사이드바</div></section>
</div></div>
<pre id="out">PENDING</pre>
<script>try{localStorage.clear(); localStorage.setItem('lively_v2_side_card3', JSON.stringify({w:480,h:320,sized:true,corner:'tr',dx:60,dy:60,placed:true,left:false}));}catch(e){}
window.requestAnimationFrame=(cb)=>setTimeout(()=>cb(performance.now()),16); window.cancelAnimationFrame=(id)=>clearTimeout(id);
//  움직임 없이(카드로 바뀌는 전환을 기다리지 않는다).
(function(){const mm=window.matchMedia.bind(window);window.matchMedia=(q)=>/prefers-reduced-motion/.test(q)?{matches:true,media:q,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}:mm(q);})();</script>
<script>${bundle}</script>
<script>
(async function(){
  const R={}; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const rc=(n)=>n.getBoundingClientRect();
  try{
    const grid=document.getElementById('grid'), col=document.getElementById('col'), pane=document.getElementById('pane'), head=document.getElementById('head');
    const VW=document.documentElement.clientWidth, VH=document.documentElement.clientHeight;
    const P=(type,x,y,t,id)=>t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:type==='pointerup'?0:1,pointerId:id||7,pointerType:'mouse',isPrimary:true}));   // 진짜 마우스는 늘 primary
    const fold=()=>grid.classList.contains('cm-fold'); const live=()=>grid.classList.contains('cm-live');
    const minB=()=>col.querySelector('.cm-min-b');
    const host={body:grid,colMain:col,sidePane:pane,sideOn:()=>true,setSideW:()=>{},sessionLeft:()=>true};
    const disp=(sel)=>{const n=col.querySelector(sel); return n?getComputedStyle(n).display:'missing';};
    // N1c — 옛 기억: 크기는 버리고 자리는 잇는다
    let card=Card.mountSideCard(host); card.restore(true); await sleep(50); let r=rc(col);
    R.n1c_info=[Math.round(r.width),Math.round(r.height),Math.round(VW-r.right),Math.round(r.top)];
    R.n1c=Math.abs(r.width-320)<=1 && Math.abs(r.height-Math.max(220,Math.min(300,Math.round(VH*0.27))))<=1 && Math.abs(VW-r.right-60)<=1.5 && Math.abs(r.top-60)<=1.5;
    // N1d — 새 기억이 있으면 그것만
    card.destroy(); localStorage.setItem('lively_v2_side_card4', JSON.stringify({w:400,h:250,sized:true,corner:'br',dx:24,dy:24,placed:false,left:true}));
    card=Card.mountSideCard(host); card.restore(true); await sleep(50); r=rc(col);
    R.n1d_info=[Math.round(r.width),Math.round(r.height)]; R.n1d=Math.abs(r.width-400)<=1 && Math.abs(r.height-250)<=1;
    const grip=(e)=>col.querySelector('.cm-grip-'+e);
    const dragBy=async(t,dx,dy,id)=>{const b=rc(t); const x=b.left+(t===head?30:b.width/2), y=b.top+b.height/2; P('pointerdown',x,y,t,id); P('pointermove',x+dx/2,y+dy/2,t,id); P('pointermove',x+dx,y+dy,t,id); P('pointerup',x+dx,y+dy,t,id); await sleep(30);};
    // N2 · N3b — 카드 480(왼쪽 아래 기본 자리) → 최소화 → 알약 260, 왼쪽 가장자리 그대로 → 펴면 480
    await dragBy(grip('e'),80,0); const cw=rc(col).width, cl=rc(col).left;
    minB().click(); await sleep(30); r=rc(col); const pw=r.width, pl=r.left;
    minB().click(); await sleep(30); const back=rc(col).width;
    R.n2_info=[Math.round(cw),Math.round(pw),Math.round(back),Math.round(cl),Math.round(pl)];
    R.n2=Math.abs(cw-480)<=2 && Math.abs(pw-260)<=1 && Math.abs(back-cw)<=1; R.n3b=Math.abs(pl-cl)<=1.5;
    // N4 — 알약 넓히기는 알약에만
    minB().click(); await sleep(30); await dragBy(grip('e'),100,0); const pw2=rc(col).width;
    minB().click(); await sleep(30); const cw2=rc(col).width; minB().click(); await sleep(30); const pw3=rc(col).width;
    R.n4_info=[Math.round(pw2),Math.round(cw2),Math.round(pw3)]; R.n4=Math.abs(pw2-360)<=2 && Math.abs(cw2-cw)<=1 && Math.abs(pw3-260)<=1;
    minB().click(); await sleep(30);
    // N3 — 오른쪽 위로 옮긴 카드 → 최소화 → 오른쪽 가장자리 그대로
    await dragBy(head,5000,-5000); const rr=rc(col).right; minB().click(); await sleep(30); const pr2=rc(col).right;
    R.n3_info=[Math.round(rr),Math.round(pr2),Math.round(rc(col).width)]; R.n3=Math.abs(rr-pr2)<=1.5 && Math.abs(rc(col).width-260)<=1;
    minB().click(); await sleep(30);
    // N5 — 되살린 알약
    card.restore(true,{fold:true}); await sleep(30);
    R.n5_info=[fold(),Math.round(rc(col).width)]; R.n5=fold() && Math.abs(rc(col).width-260)<=1;
    // 곁칸 누름(누르고 놓기). d = 놓을 때 옮긴 거리
    const sideEl=pane.firstElementChild; const press=async(d,id)=>{const b=rc(sideEl); const x=b.left+200, y=b.top+200; P('pointerdown',x,y,sideEl,id); P('pointerup',x+d,y,sideEl,id); await sleep(30);};
    // N6 — 비친 카드에서 곁칸 누름 → 최소화
    card.restore(true,{pick:false}); await sleep(30); const lv0=live(); await press(0,21);
    R.n6_info=[lv0,fold(),Math.round(rc(col).width)]; R.n6=!lv0 && fold() && Math.abs(rc(col).width-260)<=1;
    // N6e — 이미 알약이면 그대로
    await press(0,22); R.n6e=fold();
    // N6b — 또렷한 카드: 첫 누름은 비침만, 둘째 누름에 최소화
    card.restore(true,{pick:true}); await sleep(30); const lv1=live(); await press(0,23); const f1=fold(), lv2=live(); await press(0,24); const f2=fold();
    R.n6b_info=[lv1,f1,lv2,f2]; R.n6b=lv1 && !f1 && !lv2 && f2;
    // N6d · N6f — 7px 끌기는 그대로 · 정확히 6px 은 누름
    card.restore(true,{pick:false}); await sleep(30); await press(7,25); const f7=fold(); await press(6,26); const f6=fold();
    R.n6d_info=[f7,f6]; R.n6d=!f7; R.n6f=f6;
    // N7 — 비친 카드 · 곁칸 안 액자로 초점(창 blur) → 최소화 안 함
    card.restore(true,{pick:false}); await sleep(30);
    const fr=document.createElement('iframe'); sideEl.appendChild(fr); fr.focus(); window.dispatchEvent(new Event('blur')); await sleep(60);
    R.n7_info=[document.activeElement===fr,fold(),live()]; R.n7=!fold() && !live();
    fr.remove(); document.body.focus && document.body.focus();
    // N6c — 막 떠오르는 중(enter 직후 1.2초) 누름 → 비침만
    card.restore(false); await sleep(30); card.onOver(100000); card.onRelease(); await sleep(80);
    const ent=grid.classList.contains('cm') && live(); await press(0,27); const f8=fold();
    R.n6c_info=[ent,f8,live()]; R.n6c=ent && !f8;
    // N8 — 알약 상태 글쇠 ← 로 알약 폭만 바꾼다(크기 바꾸기 = 왼쪽 위 모서리를 옮긴다)
    card.restore(true,{fold:false,pick:true}); await sleep(30); const cw3=rc(col).width; minB().click(); await sleep(30);
    const kg=grip('nw'); for (let i=0;i<2;i++) kg.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true})); await sleep(30); const pk=rc(col).width;
    minB().click(); await sleep(30); const cw4=rc(col).width;
    R.n8_info=[Math.round(cw3),Math.round(pk),Math.round(cw4)]; R.n8=Math.abs(pk-292)<=1 && Math.abs(cw4-cw3)<=1;
    // N9 — Home: 알약 폭 · 카드 크기 모두 처음으로
    minB().click(); await sleep(30); await dragBy(grip('e'),60,0); kg.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true})); await sleep(30); const ph=rc(col).width;
    minB().click(); await sleep(30); const chome=rc(col).width;
    R.n9_info=[Math.round(ph),Math.round(chome)]; R.n9=Math.abs(ph-260)<=1 && Math.abs(chome-320)<=1;
    // N11r — 진짜 머리줄 이름으로: 카드에서 태스크 번호 · 연필 · 정상 «연결됨» 은 빠지고 ⋯ 는 남는다 · 끊기면 보인다 · 알약은 ⋯ 도 빠지고 이름이 넓다
    card.restore(true,{fold:false}); await sleep(30);
    const c1=[disp('.sc-title-no'),disp('.sc-title-btn > svg'),disp('.sc-pair'),disp('#more')];
    const ts=document.getElementById('tstat'); ts.className='sc-termstat err'; ts.textContent='연결 끊김'; await sleep(20); const cErr=disp('.sc-pair');
    ts.className='sc-termstat ok'; ts.textContent='연결됨'; minB().click(); await sleep(30);
    const pMore=disp('#more'), tw=rc(col.querySelector('.sc-title-t')).width;
    R.n11_info=[...c1,cErr,pMore,Math.round(tw)];
    R.n11=c1[0]==='none' && c1[1]==='none' && c1[2]==='none' && c1[3]!=='none' && cErr!=='none' && pMore==='none' && tw>100;
    // N12 — 세션 입력칸에 글이 들어왔다는 알림(화면 안에서 올라옴) → 알약이 펴지고 또렷
    card.restore(true,{fold:true,pick:false}); await sleep(30); const f12=fold(), l12=live();
    head.dispatchEvent(new CustomEvent('lively:session-input',{bubbles:true})); await sleep(30);
    R.n12_info=[f12,l12,fold(),live()]; R.n12=f12 && !l12 && !fold() && live();
    // N13 — 비친 카드 · 세션에 글을 넣는 단추(data-card-keep)를 눌러도 접지 않는다
    card.restore(true,{pick:false}); await sleep(30);
    const kb=document.createElement('button'); kb.setAttribute('data-card-keep',''); kb.textContent='본문 넣기'; sideEl.appendChild(kb);
    const kr=rc(kb); P('pointerdown',kr.left+5,kr.top+5,kb,31); P('pointerup',kr.left+5,kr.top+5,kb,31); await sleep(30);
    R.n13_info=[fold()]; R.n13=!fold();
    // N14 — 두 번째 손가락(isPrimary 아님)의 누름은 세지 않는다
    const sb=rc(sideEl); sideEl.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:sb.left+200,clientY:sb.top+200,button:0,pointerId:41,pointerType:'touch',isPrimary:false}));
    sideEl.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:sb.left+200,clientY:sb.top+200,button:0,pointerId:41,pointerType:'touch',isPrimary:false})); await sleep(30);
    R.n14_info=[fold()]; R.n14=!fold();
  }catch(e){R.err=String(e&&e.stack||e);}
  document.getElementById('out').textContent='RESULT '+JSON.stringify(R)+' ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "side-card-pill2-", virtualTimeBudget: 15000, args: ["--window-size=1400,900"] });
const m = /RESULT (\{.*\}) ENDRESULT/s.exec(dom);
if (!m) { console.error("FAIL  크롬이 결과를 안 냈다 — 받은 DOM " + dom.length + "자"); process.exit(1); }
const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const R = JSON.parse(raw);
let pass = 0, fail = 0;
const check = (c, n, info = "") => { if (c) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${info}`); } };
check(!R.err, "N0 장면이 끝까지 돈다", R.err);
check(R.n1c, "N1c 옛 기억은 크기를 버리고 자리(오른쪽 위 60 · 60)를 잇는다 · 크기는 기본값 320", JSON.stringify(R.n1c_info));
check(R.n1d, "N1d 새 기억(card4)이 있으면 그것만", JSON.stringify(R.n1d_info));
check(R.n2, "N2 카드 480 → 최소화 → 알약 260 · 펴면 480", JSON.stringify(R.n2_info));
check(R.n3b, "N3b 왼쪽 모서리 카드는 왼쪽 가장자리 그대로 줄어든다", JSON.stringify(R.n2_info));
check(R.n3, "N3 오른쪽 모서리 카드는 오른쪽 가장자리 그대로 줄어든다", JSON.stringify(R.n3_info));
check(R.n4, "N4 알약을 넓혀도 카드 크기는 그대로 · 다시 최소화하면 260", JSON.stringify(R.n4_info));
check(R.n5, "N5 되살린 알약도 260", JSON.stringify(R.n5_info));
check(R.n6, "N6 비친 카드에서 곁칸 누름 → 최소화(원준 10-11 «투명해진 다음에 한 번 더 누르면 최소화»)", JSON.stringify(R.n6_info));
check(R.n6e, "N6e 이미 알약이면 곁칸 누름 → 그대로");
check(R.n6b, "N6b 또렷한 카드: 첫 누름은 비침만 · 둘째 누름에 최소화", JSON.stringify(R.n6b_info));
check(R.n6d, "N6d 7px 끌고 놓음 → 최소화 안 함", JSON.stringify(R.n6d_info));
check(R.n6f, "N6f 경계: 정확히 6px → 누름(최소화)", JSON.stringify(R.n6d_info));
check(R.n7, "N7 곁칸 안 액자로 초점이 들어가는 것은 최소화가 아니다", JSON.stringify(R.n7_info));
check(R.n6c, "N6c 막 떠오르는 중 곁칸 누름 → 비침만", JSON.stringify(R.n6c_info));
check(R.n8, "N8 알약 상태 글쇠 ← 는 알약 폭만(260 → 292) · 카드 크기 그대로", JSON.stringify(R.n8_info));
check(R.n9, "N9 Home → 알약 260 · 카드 기본 폭 320", JSON.stringify(R.n9_info));
check(R.n11, "N11 진짜 머리줄: 카드에서 번호 · 연필 · 정상 «연결됨» 빠짐 · ⋯ 남음 · 끊기면 보임 · 알약은 ⋯ 도 빠지고 이름 > 100px", JSON.stringify(R.n11_info));
check(R.n12, "N12 세션 입력칸에 글이 들어오면 알약이 펴지고 또렷([본문 넣기] 한 글이 숨지 않는다)", JSON.stringify(R.n12_info));
check(R.n13, "N13 세션에 글을 넣는 단추(data-card-keep)는 비친 카드를 접지 않는다", JSON.stringify(R.n13_info));
check(R.n14, "N14 두 번째 손가락(isPrimary 아님)의 누름은 세지 않는다", JSON.stringify(R.n14_info));
console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
