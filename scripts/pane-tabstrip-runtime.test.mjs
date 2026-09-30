#!/usr/bin/env node
// 곁칸 탭 줄 — 실제 크롬에서 재는 모양 · 끌기 (#3870 «곁칸 탭 관리», 원준 2026-09-30)
//
//  원준: "하나 닫고 하나씩 다 찾으러 다녀야 함 … 아이콘이 중앙이 맞는지도 살짝 헷갈림 … 사파리나 크롬 탭들 닫거나 열거나 끌거나 드래그하는 거."
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  G1 이름 있는 탭: 닫기 단추의 중심 = 아이콘의 중심(가로·세로)                  — 아이콘 자리가 × 로 바뀐다(사파리)
//  G2 아이콘만 남은 탭(접힌 줄의 켜지지 않은 탭 · 고정 탭): 아이콘이 탭 한가운데
//  G3 아이콘만 남은 탭의 × 는 모서리 — 아이콘 중심을 덮지 않는다(누르려다 닫지 않게)
//  G4 아이콘 어깨의 번호 없음
//  D1 같은 줄: 두 번째 탭을 오른쪽 이웃 가운데 너머로 끌어 놓으면 reorder(그 자리) 1건 — 놓기 전엔 0건
//  D1b 이웃은 끄는 동안 잡은 탭 폭만큼 비켜 선다
//  D2 고정 경계: 고정 안 한 탭을 맨 앞(고정 탭 자리)까지 끌어도 reorder 자리는 고정 수(1)
//  D3 다른 칸 줄에 놓으면 moveTo(그 칸, 커서 자리) · 끼울 자리 세로선이 선다 / 본문이면 맨 끝 / 밖이면 호출 0건
//  D4 × 위에서 누른 것 · 4px 움직임은 끌기가 아니다 — 호출 0건
//  D5 Esc 는 없던 일 — 호출 0건, 이웃 자리 원래대로
//  D6 끌기로 끝난 누름 뒤 consumeDragClick() 은 한 번만 참
//  D7 끄는 동안 액자(iframe)는 포인터를 못 받는다(그 위에서 놓아도 pointerup 이 이 문서로 온다) · 끝나면 되돌아온다
//  D8 버튼이 떼어진 채 움직이면(액자·창 밖에서 놓았다) 없던 일 — 호출 0건, 다음 끌기가 막히지 않는다
//
// 왜 런타임인가: 중심이 맞는지는 CSS 가 실제로 그린 자리에서만 잰다(여백·폭·absolute 의 합). 끌기는 포인터 사건의 흐름이다.
// fail-first(2026-09-30): × 의 left 를 7→10 으로 바꾸면 G1 이, 모서리 규칙을 지우면 G3 가, pane-tabdrag 의 × 방어를 지우면 D4 가,
//  Esc 처리를 지우면 D5 가 빨간불이었다(TABDRAG_SRC · PANES_CSS 로 변형본을 물려 확인).
// fail-first(2026-10-01 #4443 리뷰 반영): 반영 전 곁칸 CSS 면 B1 이(크롬 47 · 띠 여백 8), stripRoom 이 여백·간격을 무시하는 돌연변이
//  (PANE_TABS_SRC)면 B2 가(«다 편다» 로 셈하고 444 > 432 로 넘친다) 빨간불이었다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 곁칸 탭 줄 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }

const SRC = process.env.TABDRAG_SRC || path.join(ROOT, "web/v2/pane-tabdrag.ts");
const bundle = execFileSync(ESBUILD, [SRC, "--bundle", "--format=iife", "--global-name=TabDrag", "--platform=browser", "--log-level=error"], { encoding: "utf8" });
//  탭 폭 셈(lib/pane-tabs planTabs · stripRoom) — B1·B2 가 실제 CSS 와 맞춰 본다. PANE_TABS_SRC 로 변형본을 물린다(fail-first).
const TABS_SRC = process.env.PANE_TABS_SRC || path.join(ROOT, "web/lib/pane-tabs.ts");
const tabsLib = execFileSync(ESBUILD, [TABS_SRC, "--bundle", "--format=iife", "--global-name=PaneTabs", "--platform=browser", "--log-level=error"], { encoding: "utf8" });
//  실제 스타일: 토큰(01-base) + 곁칸(42-v2-panes). 아이콘 크기(.pn-i)도 여기에 있다.
const CSS = readFileSync(path.join(ROOT, "public/styles/01-base.css"), "utf8") + "\n" + readFileSync(process.env.PANES_CSS || path.join(ROOT, "public/styles/42-v2-panes.css"), "utf8");

const PAGE = `<!doctype html><meta charset="utf-8"><style>${CSS}
  html,body{margin:0;font:14px sans-serif} .zone{width:600px;height:140px;display:flex;flex-direction:column;margin:0 0 20px 20px}
</style>
<div id="host"></div>
<pre id="out">PENDING</pre>
<script>${bundle}</script>
<script>${tabsLib}</script>
<script>
(async function(){
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const svg=(cls)=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('class',cls);const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d','M4 4h16v16H4z');s.append(p);return s;};
  //  탭 한 장 — 셸(panes.ts tabEl)이 그리는 구조 그대로: 겉싸개 > [탭 단추 > 아이콘 칸 + 이름] + 닫기 단추(고정 탭엔 없음).
  const tab=(key,name,{on=false,pinned=false}={})=>{
    const w=document.createElement('span'); w.className='pn-tabwrap'+(on?' on':'')+(pinned?' pinned':''); w.dataset.tab=key;
    const b=document.createElement('button'); b.className='pn-tab'; b.type='button';
    const lead=document.createElement('span'); lead.className='pn-tab-lead'; lead.append(svg('pn-i sm'));
    const t=document.createElement('span'); t.className='pn-tab-t'; t.textContent=name; b.append(lead,t); w.append(b);
    if(!pinned){const x=document.createElement('button'); x.className='pn-tab-x'; x.type='button'; x.append(svg('pn-i xs')); w.append(x);}
    return w;
  };
  const zone=(z,tabs,compact)=>{
    const pane=document.createElement('section'); pane.className='pn-pane zone'; pane.dataset.zone=z;
    const bar=document.createElement('div'); bar.className='pn-tabbar'+(compact?' compact':'');
    const strip=document.createElement('div'); strip.className='pn-tabs'; strip.append(...tabs);
    const tail=document.createElement('div'); tail.className='pn-tabtail'; bar.append(strip,tail);
    const body=document.createElement('div'); body.className='pn-pane-body'; body.style.height='100px';
    //  본문은 액자 — 실제 세션 화면·웹·PDF 칸이 그렇다(D7).
    const fr=document.createElement('iframe'); fr.style.cssText='border:0;width:100%;height:100%'; fr.srcdoc='<p>frame</p>'; body.append(fr);
    pane.append(bar,body); document.getElementById('host').append(pane); return {zone:z,bar,tabs:strip,pane};
  };
  //  ⚠ 칸 이름을 'side' 로 두면 좁은 창 CSS(≤900)가 그 칸을 숨겨 모든 크기가 0 이 된다(헤드리스 기본 창은 좁다 — 첫 판 실측).
  //   끌기는 칸 이름을 모른다(셸이 넘긴 것을 돌려줄 뿐)라 다른 이름으로 잰다.
  const side=zone('right',[tab('p1','고정',{pinned:true}),tab('a','자료',{on:true}),tab('b','지식'),tab('c','웹 문서'),tab('d','붙여넣은 그림.png')],false);
  const bottom=zone('below',[tab('t1','타임라인',{on:true}),tab('t2','리브')],false);
  const icons=zone('icons',[tab('i1','뷰어 1',{on:true}),tab('i2','뷰어 2'),tab('i3','뷰어 3')],true);
  const R={};
  const rc=(n)=>n.getBoundingClientRect(); const cx=(r)=>r.left+r.width/2; const cy=(r)=>r.top+r.height/2;
  const near=(a,b)=>Math.abs(a-b)<=0.5;
  // ── 모양 ──
  const wb=side.tabs.children[2]; const lead=rc(wb.querySelector('.pn-tab-lead')); const x=rc(wb.querySelector('.pn-tab-x')); const tb=rc(wb);
  //  #4443(2026-09-30): 아이콘 칸은 16 → 22(흰 타일 위 앱 색 선 — 독 아이콘의 작은 판). 중심 17px · 아이콘만 남은 탭 34px 는 그대로다(G1–G3).
  R.w_layout=tb.width>40 && x.width===20 && lead.width===22;   // 관측 장치 — 크기가 실제로 재졌다(0=0 으로 «통과»하지 않게)
  R.g1_x_center_on_icon=near(cx(x),cx(lead)) && near(cy(x),cy(lead));
  R.g1_icon_mid_height=near(cy(lead),cy(tb));
  R.g1_info=[cx(x),cx(lead),cy(x),cy(lead),cy(tb)].map(v=>Math.round(v*10)/10);
  const ic=icons.tabs.children[1]; const icR=rc(ic); const icLead=rc(ic.querySelector('.pn-tab-lead'));
  R.g2_icon_only_centered=near(cx(icLead),cx(icR)) && Math.round(icR.width)===34 && getComputedStyle(ic.querySelector('.pn-tab-t')).display==='none';
  const pin=side.tabs.children[0]; const pinR=rc(pin); const pinLead=rc(pin.querySelector('.pn-tab-lead'));
  R.g2_pinned_centered=near(cx(pinLead),cx(pinR)) && Math.round(pinR.width)===34 && !pin.querySelector('.pn-tab-x');
  const icX=rc(ic.querySelector('.pn-tab-x'));
  R.g3_badge_clear_of_icon_center=!(cx(icR)>=icX.left && cx(icR)<=icX.right && cy(icR)>=icX.top && cy(icR)<=icX.bottom) && icX.width<=16;
  R.g4_no_number_badge=['none','normal',''].includes(getComputedStyle(ic.querySelector('.pn-tab'),'::after').content);
  // ── 폭 예산(B1) · 셈 = 실제(B2) — #4443 탭 새 옷(2026-10-01 리뷰: 새 옷이 탭마다 +4 · 띠에 여백 8 · 간격 2 를 더해 기본 네 탭이
  //   이름 대신 아이콘으로 접혔고, 셈은 여백·간격을 몰라 여섯 탭의 마지막이 9px 삐져나왔다).
  const ts=getComputedStyle(side.tabs); const PAD=parseFloat(ts.paddingLeft)+parseFloat(ts.paddingRight); const GAPW=parseFloat(ts.columnGap)||0;
  const lab=side.tabs.children[2]; const chrome=rc(lab).width-rc(lab.querySelector('.pn-tab-t')).width;
  R.b1_info=[Math.round(chrome*10)/10,PAD,GAPW];
  //  이전 예산 = 이름 + 43px/탭(아이콘 16 · 여백 9/12 · 간격 6), 띠 여백·간격 0. 탭 n(≥2)개가 이보다 넓으면 이전엔 펴지던 줄이 접힌다.
  R.b1_budget=chrome>30 && [2,3,4,5,6,8,10,12].every((n)=>chrome*n+PAD+GAPW*(n-1)<=43*n+0.01);
  const six=zone('six',[tab('s1','프로젝트',{on:true}),tab('s2','자료'),tab('s3','지식'),tab('s4','웹 문서'),tab('s5','타임라인'),tab('s6','리브')],false);
  const sw=[...six.tabs.children];
  const nat=sw.map((w)=>({natural:rc(w).width,active:w.classList.contains('on'),pinned:w.classList.contains('pinned')}));
  const sumNat=nat.reduce((a,t)=>a+Math.ceil(t.natural),0);
  //  띠 안 폭 = 이름 다 편 탭들의 합 + 2 — clientWidth 로 셈하면 «들어간다», 실제로는 안 여백·간격만큼 안 들어간다(경계 사례).
  six.tabs.style.flex='none'; six.tabs.style.boxSizing='border-box'; six.tabs.style.width=(sumNat+2)+'px';
  const scs=getComputedStyle(six.tabs);
  const room=PaneTabs.stripRoom(six.tabs.clientWidth,parseFloat(scs.paddingLeft)||0,parseFloat(scs.paddingRight)||0,parseFloat(scs.columnGap)||0,sw.length);
  const plan=PaneTabs.planTabs(nat,room);
  sw.forEach((w,i)=>{w.style.width=plan.widths[i]+'px';});
  if(plan.mode==='icons') six.bar.classList.add('compact');
  R.b2_case=Math.round(six.tabs.clientWidth)===sumNat+2;
  R.b2_info=[plan.mode,plan.overflow,six.tabs.scrollWidth,six.tabs.clientWidth];
  R.b2_fit=plan.mode!=='full' && (plan.overflow || six.tabs.scrollWidth<=six.tabs.clientWidth);
  six.pane.remove();
  // ── 끌기 ──
  const calls=[];
  const host={
    bars:()=>[side,bottom],
    canGo:(k,f,t)=>f!==t,
    range:(z,k)=>z==='right'?(k==='p1'?[0,0]:[1,side.tabs.children.length-1]):[0,bottom.tabs.children.length-1],
    reorder:(z,k,to)=>calls.push(['reorder',z,k,to]),
    moveTo:(k,f,t,at)=>calls.push(['moveTo',k,f,t,at]),
  };
  const P=(type,x,y,target=window,extra={})=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:1,pointerId:7,pointerType:'mouse',...extra}));
  const down=(w,dx=0)=>{const r=rc(w);const e=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:cx(r)+dx,clientY:cy(r),button:0,buttons:1,pointerId:7,pointerType:'mouse'});TabDrag.beginTabDrag(host,w.closest('.pn-pane').dataset.zone,w.dataset.tab,w,e);return r;};
  const tr=(n)=>n.style.transform||'';
  // D1 — 'b'(자료 오른쪽) 를 'c' 가운데 너머로
  let r=down(side.tabs.children[2]); const cR=rc(side.tabs.children[3]);
  P('pointermove',cx(r)+10,cy(r)); P('pointermove',cx(cR)+6,cy(r));
  R.d1b_neighbor_slides=tr(side.tabs.children[3]).includes('-')&&tr(side.tabs.children[1])==='';
  R.d1_no_call_before_release=calls.length===0;
  P('pointerup',cx(cR)+6,cy(r)); await sleep(260);
  R.d1_reorder=JSON.stringify(calls)===JSON.stringify([['reorder','right','b',3]]);
  R.d1_info=JSON.stringify(calls);
  // D6 — 놓은 **바로 그 박자**의 click 은 소비된다(한 번만)
  calls.length=0; r=down(side.tabs.children[4]); P('pointermove',cx(r)+40,cy(r)); P('pointerup',cx(r)+40,cy(r));
  R.d6_consumed=TabDrag.consumeDragClick()===true && TabDrag.consumeDragClick()===false;
  await sleep(260); calls.length=0;
  // D2 — 'd'(맨 끝)를 맨 앞(고정 탭 자리)까지
  //  줄 **안에서** 맨 앞(고정 탭 위)까지 — 줄 밖으로 끌어내면 «다른 칸으로» 가 된다(D3d).
  const front=rc(side.tabs.children[0]).left+3;
  r=down(side.tabs.children[4]); P('pointermove',cx(r)-20,cy(r)); P('pointermove',front,cy(r)); P('pointerup',front,cy(r)); await sleep(260);
  R.d2_pinned_boundary=JSON.stringify(calls)===JSON.stringify([['reorder','right','d',1]]);
  R.d2_info=JSON.stringify(calls); calls.length=0;
  // D3 — 다른 칸 줄(첫 탭 가운데 너머 · 둘째 탭 가운데 앞)
  const t1=rc(bottom.tabs.children[0]), t2=rc(bottom.tabs.children[1]);
  r=down(side.tabs.children[2]); P('pointermove',cx(r),cy(r)+30); P('pointermove',(cx(t1)+cx(t2))/2,cy(t1));
  R.d3_caret=!!bottom.bar.querySelector('.pn-tab-caret') && bottom.bar.classList.contains('drop') && !!document.querySelector('.pn-tab-ghost');
  P('pointerup',(cx(t1)+cx(t2))/2,cy(t1)); await sleep(30);
  R.d3_move=JSON.stringify(calls)===JSON.stringify([['moveTo','b','right','below',1]]);
  R.d3_cleanup=!bottom.bar.querySelector('.pn-tab-caret') && !bottom.bar.classList.contains('drop') && !document.querySelector('.pn-tab-ghost');
  calls.length=0;
  const body=rc(bottom.pane.querySelector('.pn-pane-body'));
  r=down(side.tabs.children[2]); P('pointermove',cx(r),cy(r)+30); P('pointermove',cx(body),cy(body)); P('pointerup',cx(body),cy(body)); await sleep(30);
  R.d3_body_end=JSON.stringify(calls)===JSON.stringify([['moveTo','b','right','below',2]]);
  calls.length=0;
  r=down(side.tabs.children[2]); P('pointermove',cx(r),cy(r)+30); P('pointermove',900,700); P('pointerup',900,700); await sleep(260);
  R.d3_outside_nothing=calls.length===0 && tr(side.tabs.children[2])==='';
  // D4 — × 위에서 누름 · 4px 움직임
  const xb=side.tabs.children[2].querySelector('.pn-tab-x'); const xr=rc(xb);
  //  실제 누름처럼 × 에 사건을 쏜다(대상 = ×) — 셸의 탭 겉싸개가 받는 pointerdown 과 같은 길.
  const ev=new PointerEvent('pointerdown',{bubbles:true,clientX:cx(xr),clientY:cy(xr),button:0,pointerId:7,pointerType:'mouse'}); xb.addEventListener('pointerdown',(e)=>TabDrag.beginTabDrag(host,'right','b',side.tabs.children[2],e),{once:true}); xb.dispatchEvent(ev);
  P('pointermove',cx(xr)+80,cy(xr)); P('pointerup',cx(xr)+80,cy(xr)); await sleep(260);
  R.d4_x_not_drag=calls.length===0 && !TabDrag.tabDragging();
  r=down(side.tabs.children[3]); P('pointermove',cx(r)+4,cy(r)); P('pointerup',cx(r)+4,cy(r)); await sleep(260);
  R.d4_slop_is_click=calls.length===0 && TabDrag.consumeDragClick()===false;
  // D5 — Esc
  r=down(side.tabs.children[2]); const cR2=rc(side.tabs.children[3]); P('pointermove',cx(r)+10,cy(r)); P('pointermove',cx(cR2)+6,cy(r));
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  P('pointerup',cx(cR2)+6,cy(r)); await sleep(260);
  R.d5_escape_cancels=calls.length===0 && [...side.tabs.children].every((n)=>tr(n)==='') && !side.tabs.classList.contains('dnd');
  // D7 — 끄는 동안 액자
  const frame=bottom.pane.querySelector('iframe');
  R.w_frame=!!frame && getComputedStyle(frame).pointerEvents==='auto';
  r=down(side.tabs.children[2]); P('pointermove',cx(r)+30,cy(r));
  R.d7_frames_off_while_dragging=getComputedStyle(frame).pointerEvents==='none';
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); await sleep(30);
  R.d7_frames_back=getComputedStyle(frame).pointerEvents==='auto';
  // D8 — 버튼이 떼어진 채 움직임
  calls.length=0; r=down(side.tabs.children[2]); P('pointermove',cx(r)+30,cy(r)); P('pointermove',cx(r)+60,cy(r),window,{buttons:0});
  R.d8_released_elsewhere=calls.length===0 && !TabDrag.tabDragging() && !document.documentElement.classList.contains('pn-tab-dragging');
  r=down(side.tabs.children[2]); P('pointermove',cx(cR)+6,cy(r)); P('pointerup',cx(cR)+6,cy(r)); await sleep(30);
  R.d8_next_drag_works=calls.length===1;
  // 배선 — 관측 장치가 살아 있나(호출 기록이 실제로 쌓였던 적이 있다)
  R.w_calls_observed=R.d1_reorder===true;
  document.getElementById('out').textContent=JSON.stringify(R)+'\\nENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "pane-tabstrip-", virtualTimeBudget: 10000 });
const m = dom.match(/<pre id="out">([\s\S]*?)ENDRESULT/);
if (!m) { console.error("FAIL  결과 표지를 못 받았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1].trim().replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
let fails = 0;
let checks = 0;
const check = (k, why) => { checks++; const ok = R[k] === true; console.log(`${ok ? "ok  " : "FAIL"}  ${k} — ${why}`); if (!ok) fails++; };
check("w_layout", "(배선) 탭 · 아이콘 칸(22) · 닫기 단추(20)의 크기가 실제로 재졌다 — 중심 비교가 0=0 이 아니다");
check("w_calls_observed", "(배선) 끌기 호출 기록이 실제로 쌓인다 — 아래 «호출 0건» 단언이 무언가를 보고 있다");
check("g1_x_center_on_icon", `G1 닫기 단추의 중심 = 아이콘의 중심 ${JSON.stringify(R.g1_info)}`);
check("g1_icon_mid_height", "G1b 아이콘은 탭 높이의 가운데");
check("g2_icon_only_centered", "G2 아이콘만 남은 탭(34px) — 아이콘이 한가운데, 이름은 숨는다");
check("g2_pinned_centered", "G2b 고정 탭(34px) — 아이콘이 한가운데, 닫기 단추가 없다");
check("g3_badge_clear_of_icon_center", "G3 아이콘만 남은 탭의 × 는 모서리 — 아이콘 중심을 덮지 않는다");
check("g4_no_number_badge", "G4 아이콘 어깨의 번호가 없다");
check("b1_budget", `B1 탭 새 옷의 폭 예산 — 탭 n(≥2)개가 이전(이름 + 43px/탭)보다 넓지 않다: 크롬·띠 여백·간격 ${JSON.stringify(R.b1_info)}`);
check("b2_case", "B2 (배선) 경계 사례가 섰다 — 띠 안 폭 = 이름 다 편 탭 합 + 2");
check("b2_fit", `B2 셈(planTabs · stripRoom)이 «들어간다» 면 실제로도 안 넘친다 — 이 경계에선 펴지 않는다 ${JSON.stringify(R.b2_info)}`);
check("d1_no_call_before_release", "D1 놓기 전엔 순서를 안 바꾼다");
check("d1b_neighbor_slides", "D1b 끄는 동안 넘은 이웃만 비켜 선다");
check("d1_reorder", `D1 이웃 가운데 너머에 놓으면 그 자리로 ${R.d1_info}`);
check("d6_consumed", "D6 끌기로 끝난 누름의 click 은 한 번만 소비된다");
check("d2_pinned_boundary", `D2 고정 안 한 탭은 고정 탭 앞으로 못 간다 ${R.d2_info}`);
check("d3_caret", "D3 다른 칸 줄 위 — 끼울 자리 세로선 · 파란 줄 · 따라오는 탭 조각");
check("d3_move", "D3 다른 칸 줄에 놓으면 커서 자리(1)에 끼운다");
check("d3_cleanup", "D3b 놓은 뒤 세로선 · 파란 줄 · 조각이 걷힌다");
check("d3_body_end", "D3c 그 칸 본문에 놓으면 맨 끝(2)");
check("d3_outside_nothing", "D3d 칸 밖에 놓으면 아무 일 없음(제자리)");
check("d4_x_not_drag", "D4 닫기 단추 위에서 누른 것은 끌기가 아니다");
check("d4_slop_is_click", "D4b 4px 움직임은 클릭이다");
check("d5_escape_cancels", "D5 Esc 는 없던 일 — 호출 0건, 이웃 제자리");
check("w_frame", "(배선) 본문 액자가 섰고 평소엔 포인터를 받는다");
check("d7_frames_off_while_dragging", "D7 끄는 동안 액자는 포인터를 못 받는다 — 그 위에서 놓아도 끌기가 끝난다");
check("d7_frames_back", "D7b 끌기가 끝나면 액자가 다시 포인터를 받는다");
check("d8_released_elsewhere", "D8 버튼이 떼어진 채 움직이면 없던 일 — 호출 0건, 끌기 상태가 안 남는다");
check("d8_next_drag_works", "D8b 그 뒤의 끌기가 막히지 않는다");
console.log(fails ? `\n${fails}건 실패` : `\n${checks}건 통과`);
process.exit(fails ? 1 : 0);
