#!/usr/bin/env node
// 곁칸 독 — 실제 크롬에서 재는 자리 · 크기 · 손짓 (#4443 «곁칸 → 앱의 실행 화면», 원준 2026-09-30)
//
//  원준: "3안으로 갈건데 독 드래그하면 2안 위치에 … 테두리쪽 원하는 곳 어디든 … 태스크 입력하는 거 같은 건 어떻게? …
//   상단 탭 부분 높이 … 터미널 세션의 상단 바 부분이랑 같게 … 맥의 독 참고해서 모션·애니메이션·우클릭·더보기까지."
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  R1  기본: 바닥 가운데에 떠 있는 알약 — 곁칸 바닥에서 6px, 가로 가운데
//  R2  독이 보이면 부품이 물러선다 — 본문 아래 여백 = 아이콘 + 안 여백×2 + 점 + 바깥 여백×2 (맨 아래 입력칸이 독 위에 선다)
//  R3  점 = 떠 있는 탭 수(최대 셋), 켜진 앱만 켜짐 표시
//  R4  안 떠 있는 앱을 누르면 연다(open 1건) · 연 앱은 튀어 오른다
//  R5  떠 있는 앱을 누르면 보여 준다 · 켜진 앱을 또 누르면 다음 인스턴스로 돈다
//  R6  ⌥-클릭 = 여럿 띄울 수 있는 앱은 하나 더
//  R7  확대 — 마우스 밑 아이콘은 크게(≈1.6배), 멀리 있는 아이콘은 그대로
//  R8  우클릭 — 열린 창 목록 · 새로 열기 · 모두 닫기 · 독에서 빼기 · 독 설정
//  R9  독을 끌어 오른쪽 테두리에 바짝 → 막대(2안)로 붙는다: 계정 설정 edge=right · mode=bar, 부품은 오른쪽이 물러서고 아래는 0
//  R9b 끄는 동안 놓일 자리가 윤곽으로 보인다(막대면 테두리 전체) · 놓으면 윤곽이 사라진다
//  R10 다시 끌어 바닥 안쪽 30% 자리에 → 떠 있는 알약이 그 자리에(가운데 자석 밖)
//  R11 자동으로 가리기 — 독이 물러나고 부품이 자리를 다 쓴다 · 테두리 띠에 손을 대면 나온다
//  R12 아이콘을 끌어 순서를 바꾼다(고정 목록이 바뀐다)
//  R13 고정한 아이콘을 독 밖으로 끌어내면 고정이 풀린다
//  R14 [더보기] — 곁칸 앱 · 새 탭 앱 구획, 검색이 거른다, Enter 가 첫 앱을 연다, 열면 창이 닫힌다
//  R15 Esc 로 [더보기]가 닫힌다
//  R16 곁칸 탭 줄 높이 = 세션 머리줄 높이(두 열의 아래선이 한 줄로 잇는다) — 넓은 폭(≥901px)
//  R14d 붙이기 수단이 있으면 [더보기]에 «이 세션에 붙이기»(설치 앱)
//  R17 곁칸이 접혀(폭 0) 있으면 독도 없고 부품 여백도 0
//  R19 붙이기 수단이 없는 게이트웨이(옛 판)면 그 구획이 없다 — 독은 그대로 쓴다
//
// 왜 런타임인가: 자리·여백·확대는 CSS 와 스크립트가 **함께** 그린 결과에서만 잰다. 손짓은 포인터 사건의 흐름이다.
// fail-first(2026-09-30): 42-v2-dock.css 의 떠 있는 알약 translate(가운데 기준)를 지우면 R1·R10 이, 42-v2-panes.css 의 본문 여백
//  규칙을 지우면 R2·R2b·R9 가, 머리 줄 한 값(--pn-head-h)을 탭 줄에서 빼면 R16 이 빨간불이었다(DOCK_CSS · PANES_CSS 로 변형본을 물려 확인).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 곁칸 독 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }

const SRC = process.env.DOCK_UI_SRC || path.join(ROOT, "web/v2/pane-dock.ts");
const bundle = execFileSync(ESBUILD, [SRC, "--bundle", "--format=iife", "--global-name=Dock", "--platform=browser", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const STY = path.join(ROOT, "public/styles");
const css = (f, env) => readFileSync(process.env[env] || path.join(STY, f), "utf8");
//  실제 스타일: 토큰(01-base) · 앱 타일(40-v2 .v2-gi) · 세션 머리줄(36-chat) · 곁칸(42-v2-panes) · 독(42-v2-dock) · 메뉴(49-v2-ctx).
const CSS = [css("01-base.css"), css("36-chat.css"), css("40-v2.css"), css("42-v2-panes.css", "PANES_CSS"), css("42-v2-dock.css", "DOCK_CSS"), css("49-v2-ctx.css")].join("\n");

const PAGE = `<!doctype html><meta charset="utf-8"><style>${CSS}
  html,body{margin:0;font:14px sans-serif;background:var(--bg)}
  /* 헤드리스(가상 시간)는 CSS 전환을 진행시키지 않는다 — 전환 시작값을 재게 된다. 자리·크기는 전환 없이 잰다(튀어 오르기는 클래스로 본다). */
  *,*::before,*::after{transition:none!important;animation:none!important}
  #wrap{position:absolute;left:0;top:0;width:1300px;height:760px}
  #pane{position:absolute;left:900px;top:0;width:340px;height:760px}
  #head{position:absolute;left:20px;top:0;width:860px}
  .part{flex:1;display:flex;flex-direction:column;min-height:0}
  .list{flex:1;overflow:auto} .add{flex:none;height:34px;border-top:1px solid var(--line)}
</style>
<div id="wrap" class="pn-wrap">
  <div id="head" class="sc-head"><div class="sc-head-l"><b>세션 머리줄</b></div><div class="sc-head-r"><button class="btn btn-ghost btn-sm">단추</button></div></div>
  <section id="pane" class="pn-pane" data-zone="side">
    <div class="pn-tabbar"><div class="pn-tabs"></div><div class="pn-tabtail"></div></div>
    <div class="pn-pane-body"><div class="part"><div class="list">목록</div><div class="add">＋ 태스크 추가</div></div></div>
  </section>
</div>
<pre id="out">PENDING</pre>
<script>try{localStorage.clear()}catch(e){}
//  헤드리스(가상 시간)는 화면을 안 그려 requestAnimationFrame 이 안 돈다 — 시험 페이지에서만 16ms 타이머로 대신 돌린다.
window.requestAnimationFrame=(cb)=>setTimeout(()=>cb(performance.now()),16); window.cancelAnimationFrame=(id)=>clearTimeout(id);
//  CI 의 헤드리스(리눅스)는 마우스 장치가 없어 (any-)pointer: fine 이 거짓이다 — 확대는 «가는 포인터가 있을 때» 의 동작이므로 그 환경을 흉내 낸다(이 맥에선 참이라 통과하던 것, PR #1202 CI 실측).
(function(){const mm=window.matchMedia.bind(window);window.matchMedia=(q)=>/pointer:\\s*fine/.test(q)?{matches:true,media:q,onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return false}}:mm(q);})();
//  설치 앱 목록(/api/ui/apps)만 흉내 — 더보기의 «이 세션에 붙이기» 구획을 재려고. 나머지 서버 호출은 빈 성공.
(function(){const real=window.fetch;const J=(o)=>new Response(JSON.stringify(o),{status:200,headers:{'content-type':'application/json'}});
 window.fetch=(u,o)=>{const s=String(u&&u.url||u); if(s.includes('/api/ui/apps')) return Promise.resolve(J({apps:[{id:'memo',title:'메모',status:'active',enabled:true,manifest:{ui:{pages:[{key:'m',title:'메모'}]},data:{tables:[{name:'notes'}]}},source:{kind:'workspace'}}]})); if(s.includes('/api/')) return Promise.resolve(J({ok:true})); return real(u,o);};})();</script>
<script>${bundle}</script>
<script>
(async function(){
  const R={}; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const frame=()=>new Promise(r=>requestAnimationFrame(()=>r()));
  const rc=(n)=>n.getBoundingClientRect(); const cx=(r)=>r.left+r.width/2; const cy=(r)=>r.top+r.height/2;
  try{
  const pane=document.getElementById('pane'); const body=pane.querySelector('.pn-pane-body');
  const calls=[];
  const APPS=[
    {type:'tasks',name:'프로젝트',glyph:'projtask',hint:'태스크',multi:false,pickable:true},
    {type:'files',name:'자료',glyph:'folder',hint:'자료',multi:true,pickable:true},
    {type:'knowledge',name:'지식',glyph:'wiki',hint:'지식',multi:false,pickable:true},
    {type:'web',name:'웹',glyph:'web',hint:'웹 페이지',multi:true,pickable:true},
    {type:'timeline',name:'타임라인',glyph:'timeline',hint:'발자취',multi:false,pickable:true},
    {type:'editor',name:'뷰어',glyph:'eye',hint:'파일',multi:true,pickable:false},
  ];
  const st={tabs:[{key:'files',type:'files'},{key:'web',type:'web'},{key:'web#2',type:'web'}],act:'files',recent:[]};
  let dock=null; let n=2;
  const host={ pane, apps:()=>APPS, tabs:()=>st.tabs, act:()=>st.act, recent:()=>st.recent, title:(k)=>'T:'+k,
    show:(k)=>{calls.push(['show',k]); st.act=k; st.recent=[k,...st.recent.filter(x=>x!==k)]; dock.sync();},
    open:(t)=>{calls.push(['open',t]); const has=st.tabs.some(x=>x.type===t); const key=has?t+'#'+(++n):t; st.tabs.push({key,type:t}); st.act=key; dock.sync();},
    close:(k)=>{calls.push(['close',k]);}, closeAll:(t)=>{calls.push(['closeAll',t]);},
    curSession:()=>'sid-1', attach:async(a)=>{calls.push(['attach',a.id]);}, narrow:()=>false };
  dock=Dock.mountDock(host);
  await frame(); await sleep(30);
  const root=pane.querySelector('.pn-dock'); const shelf=root.querySelector('.pn-dock-shelf');
  const it=(t)=>root.querySelector('.pn-dock-it[data-type="'+t+'"]');
  const pr=rc(pane);
  // R1
  let dr=rc(shelf);
  R.r1_bottom_gap=Math.round(pr.bottom-dr.bottom); R.r1_center_dx=Math.round(cx(dr)-cx(pr));
  R.r1=Math.abs(pr.bottom-dr.bottom-6)<=1.5 && Math.abs(cx(dr)-cx(pr))<=1.5 && root.dataset.mode==='float' && root.dataset.edge==='bottom';
  // R2
  const size=parseFloat(getComputedStyle(root).getPropertyValue('--dk-s'));
  R.r2_size=size; R.r2_pad=getComputedStyle(body).paddingBottom;
  R.r2=parseFloat(getComputedStyle(body).paddingBottom)===size+10+4+12 && getComputedStyle(body).paddingRight==='0px';
  R.r2_add_above_dock=rc(body.querySelector('.add')).bottom<=dr.top+0.5;
  // R3
  R.r3=it('web').querySelectorAll('.pn-dock-dots i').length===2 && it('files').querySelectorAll('.pn-dock-dots i').length===1
    && it('tasks').querySelectorAll('.pn-dock-dots i').length===0 && it('files').classList.contains('on') && !it('web').classList.contains('on');
  // R4
  calls.length=0; it('tasks').click(); await frame();
  R.r4=JSON.stringify(calls)==='[["open","tasks"]]' && it('tasks').classList.contains('bounce');
  // R5
  calls.length=0; it('web').click(); it('web').click();
  R.r5=JSON.stringify(calls)==='[["show","web"],["show","web#2"]]';
  R.r5_info=JSON.stringify(calls);
  // R6
  calls.length=0; it('files').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,altKey:true}));
  R.r6=JSON.stringify(calls)==='[["open","files"]]';
  await sleep(950);                                  // 튀어 오르기가 끝나게
  // R7
  R.r7_mag_on=root.classList.contains('mag');
  const target=it('knowledge'); const tr=rc(target.querySelector('.pn-dock-ic'));
  shelf.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx(tr),clientY:cy(tr),pointerType:'mouse'}));
  await frame(); await sleep(260);
  const w=(t)=>rc(it(t).querySelector('.pn-dock-ic')).width;
  const far=root.querySelector('.pn-dock-more-btn .pn-dock-ic');
  R.r7_center=Math.round(w('knowledge')*10)/10; R.r7_far=Math.round(rc(far).width*10)/10;
  R.r7=Math.abs(w('knowledge')-size*1.6)<=1.5 && Math.abs(rc(far).width-size)<=0.6 && w('files')>size+0.5;
  shelf.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'}));
  await frame(); await sleep(320);
  R.r7_settles=Math.abs(w('knowledge')-size)<=0.6;
  // R8
  const wr=rc(it('web'));
  it('web').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:cx(wr),clientY:cy(wr)}));
  await frame();
  const menu=document.querySelector('.pn-ctx'); const mt=menu?menu.textContent:'';
  R.r8_text=mt.slice(0,200);
  R.r8=!!menu && mt.includes('열린 창') && mt.includes('T:web#2') && mt.includes('새로 열기') && mt.includes('모두 닫기') && mt.includes('독에서 빼기') && mt.includes('독');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await frame();
  // R9 — 손잡이를 잡고 오른쪽 테두리 바짝(8px)으로
  const P=(type,x,y,t=window)=>t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:1,pointerId:9,pointerType:'mouse'}));
  const grip=root.querySelector('.pn-dock-grip'); const gr=rc(grip);
  P('pointerdown',cx(gr),cy(gr),grip); P('pointermove',cx(gr)+20,cy(gr)-20); P('pointermove',pr.right-8,pr.top+380);
  const pv=pane.querySelector('.pn-dock-preview');
  R.r9b_preview=!!pv && pv.dataset.mode==='bar' && Math.round(rc(pv).right)===Math.round(pr.right) && rc(pv).height>600;
  P('pointerup',pr.right-8,pr.top+380); await frame(); await sleep(450);
  const key=Object.keys(localStorage).find(k=>k.startsWith('lively_v2_dock')&&!k.includes('apps'));
  const saved=key?JSON.parse(localStorage.getItem(key)):null;
  R.r9_saved=JSON.stringify(saved);
  R.r9=!!saved && saved.edge==='right' && saved.mode==='bar' && root.dataset.edge==='right' && root.dataset.mode==='bar'
    && parseFloat(getComputedStyle(body).paddingRight)>30 && getComputedStyle(body).paddingBottom==='0px';
  R.r9b_gone=!pane.querySelector('.pn-dock-preview');
  // R10 — 다시 끌어 바닥 안쪽 30% 자리로(빈 자리를 잡는다 — 막대엔 손잡이가 없다)
  const sr=rc(root.querySelector('.pn-dock-shelf')); const firstIt=rc(root.querySelector('.pn-dock-it'));
  const gx=cx(sr), gy=firstIt.top-3;
  P('pointerdown',gx,gy,root.querySelector('.pn-dock-shelf')); P('pointermove',gx-30,gy+10); P('pointermove',pr.left+pr.width*0.3,pr.bottom-60);
  P('pointerup',pr.left+pr.width*0.3,pr.bottom-60); await frame(); await sleep(450);
  const s2=JSON.parse(localStorage.getItem(key));
  const d2=rc(root.querySelector('.pn-dock-shelf'));
  const want=Math.max(pr.left+6+d2.width/2, pr.left+pr.width*0.3);
  R.r10_saved=JSON.stringify(s2); R.r10_cx=Math.round(cx(d2)); R.r10_want=Math.round(want);
  R.r10=s2.edge==='bottom' && s2.mode==='float' && Math.abs(s2.at-0.3)<0.02 && Math.abs(cx(d2)-want)<=2;
  // R11 — 자동으로 가리기(계정 설정을 바꾸고 다른 창에서 온 것처럼 알린다)
  localStorage.setItem(key, JSON.stringify({...s2, hide:'1'})); window.dispatchEvent(new StorageEvent('storage',{key}));
  await frame(); await sleep(420);
  const reveal=pane.querySelector('.pn-dock-reveal');
  R.r11_out=root.classList.contains('out') && getComputedStyle(body).paddingBottom==='0px' && !!reveal && !reveal.hidden;
  reveal.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false,pointerType:'mouse'})); await frame(); await sleep(350);
  R.r11_in=!root.classList.contains('out');
  localStorage.setItem(key, JSON.stringify({...s2, hide:'0', at:'0.50'})); window.dispatchEvent(new StorageEvent('storage',{key}));
  await frame(); await sleep(420);
  // R12 — 첫 고정 아이콘(프로젝트)을 지식과 웹 사이로
  const pinKey=Object.keys(localStorage).find(k=>k.startsWith('lively_v2_dock_apps'));
  const a0=rc(it('tasks').querySelector('.pn-dock-ic')); const kn=rc(it('knowledge')); const wb=rc(it('web'));
  P('pointerdown',cx(a0),cy(a0),it('tasks')); P('pointermove',cx(a0)+12,cy(a0)); P('pointermove',(cx(kn)+cx(wb))/2,cy(a0));
  R.r12_caret=!!root.querySelector('.pn-dock-caret:not([hidden])');
  P('pointerup',(cx(kn)+cx(wb))/2,cy(a0)); await frame(); await sleep(60);
  const pins1=JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('lively_v2_dock_apps'))||'null'));
  R.r12_pins=JSON.stringify(pins1);
  R.r12=JSON.stringify(pins1)==='["files","knowledge","tasks","web","timeline"]';
  // R13 — 타임라인(안 떠 있음)을 위로 끌어내면 고정이 풀리고 독에서 사라진다
  const tl=rc(it('timeline').querySelector('.pn-dock-ic'));
  P('pointerdown',cx(tl),cy(tl),it('timeline')); P('pointermove',cx(tl),cy(tl)-20); P('pointermove',cx(tl),cy(tl)-140);
  R.r13_badge=!!document.querySelector('.pn-dock-ghost.out');
  P('pointerup',cx(tl),cy(tl)-140); await frame(); await sleep(450);
  const pins2=JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('lively_v2_dock_apps'))));
  R.r13=!pins2.includes('timeline') && !it('timeline') && !document.querySelector('.pn-dock-ghost');
  R.r13_pins=JSON.stringify(pins2);
  // R14 — [더보기]
  calls.length=0;
  root.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(260);
  const more=pane.querySelector('.pn-dock-more');
  const mtext=more?more.textContent:'';
  R.r14_open=!!more && more.classList.contains('open') && mtext.includes('사이드바 앱') && mtext.includes('타임라인') && mtext.includes('새 탭으로 여는 앱');
  await sleep(120);
  R.r14d_attach=more.textContent.includes('이 세션에 붙이기') && more.textContent.includes('메모');
  const q=more.querySelector('.pn-dock-more-q'); q.value='타임'; q.dispatchEvent(new Event('input',{bubbles:true}));
  const tiles=[...more.querySelectorAll('.pn-dock-tile')].map(t=>t.textContent.trim());
  //  설명에 «타임라인» 이 든 앱(새 탭 앱 「프로젝트」)도 맞는다 — 런치패드와 같은 잣대(lib/app-match). 이름이 맞는 곁칸 앱이 맨 앞, 안 맞는 앱은 빠진다.
  R.r14_filter=tiles[0]==='타임라인' && !tiles.includes('자료') && !tiles.includes('웹'); R.r14_tiles=JSON.stringify(tiles);
  q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await frame(); await sleep(260);
  R.r14_enter=JSON.stringify(calls)==='[["open","timeline"]]' && !pane.querySelector('.pn-dock-more');
  R.r14_info=JSON.stringify(calls);
  // R15
  root.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(60);
  pane.querySelector('.pn-dock-more').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sleep(260);
  R.r15=!pane.querySelector('.pn-dock-more');
  // R16 — 탭 줄 높이 = 세션 머리줄 높이
  const hb=rc(document.getElementById('head')); const tb=rc(pane.querySelector('.pn-tabbar'));
  R.r16_heights=[Math.round(hb.height*10)/10, Math.round(tb.height*10)/10, innerWidth];
  R.r16=innerWidth>=901 && Math.abs(hb.bottom-tb.bottom)<=0.5 && Math.abs(hb.height-tb.height)<=0.5;
  // R17 — 곁칸이 접히면(폭 0)
  pane.style.width='0px'; dock.sync(); await frame();
  R.r17=root.hidden && getComputedStyle(body).paddingBottom==='0px';
  dock.destroy();
  R.destroyed=!pane.querySelector('.pn-dock');
  // R19 — 붙이기 수단이 없는 게이트웨이(옛 판): 독은 쓰고, [더보기]에 «이 세션에 붙이기» 구획이 없다
  pane.style.width='340px';
  const host2={...host}; delete host2.attach;
  const dock2=Dock.mountDock(host2); await frame(); await sleep(40);
  pane.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(200);
  const m2=pane.querySelector('.pn-dock-more');
  R.r19=!!m2 && m2.textContent.includes('사이드바 앱') && !m2.textContent.includes('이 세션에 붙이기');
  dock2.destroy();
  }catch(e){R.error=String(e&&e.stack||e);}
  document.getElementById('out').textContent='RESULT '+JSON.stringify(R)+' ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "pane-dock-", virtualTimeBudget: 20000, args: ["--window-size=1400,900"] });
const m = /RESULT (\{.*\}) ENDRESULT/s.exec(dom);
if (!m) { const out = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom); console.error("FAIL  결과를 못 받았다 — #out: " + (out ? out[1].slice(0, 1500) : "(없음)") + " · 받은 DOM " + dom.length + "자"); process.exit(1); }
const R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
let pass = 0, fail = 0;
const check = (cond, n, info = "") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n}${info ? " — " + info : ""}`); } };
if (R.error) { console.error("FAIL  페이지 스크립트가 넘어졌다 — " + R.error); process.exit(1); }
check(R.r1, "R1 기본 — 바닥 가운데에 떠 있는 알약(바닥에서 6px)", `바닥 틈 ${R.r1_bottom_gap} · 가운데 어긋남 ${R.r1_center_dx}`);
check(R.r2, "R2 독이 보이면 부품이 물러선다 — 본문 아래 여백 = 아이콘 + 안 여백×2 + 점 + 바깥 여백×2", `아이콘 ${R.r2_size} · 여백 ${R.r2_pad}`);
check(R.r2_add_above_dock, "R2b 맨 아래 «태스크 추가» 입력칸이 독 위에 선다(가려지지 않는다)");
check(R.r3, "R3 점 = 떠 있는 탭 수, 켜진 앱만 켜짐");
check(R.r4, "R4 안 떠 있는 앱을 누르면 연다 · 튀어 오른다");
check(R.r5, "R5 떠 있는 앱은 보여 주고, 켜진 앱을 또 누르면 다음 인스턴스", R.r5_info);
check(R.r6, "R6 ⌥-클릭 = 하나 더");
check(R.r7_mag_on, "R7a 확대가 켜져 있다(가는 포인터 · 동작 줄이기 꺼짐)");
check(R.r7, "R7 확대 — 마우스 밑은 ≈1.6배, 먼 아이콘은 그대로", `가운데 ${R.r7_center} · 먼 것 ${R.r7_far}`);
check(R.r7_settles, "R7b 손을 떼면 가라앉는다");
check(R.r8, "R8 우클릭 — 열린 창 · 새로 열기 · 모두 닫기 · 독에서 빼기 · 독 설정", R.r8_text);
check(R.r9b_preview, "R9b 끄는 동안 놓일 자리(막대 = 오른쪽 테두리 전체)가 보인다");
check(R.r9, "R9 오른쪽 테두리 바짝 → 막대로 붙는다 · 오른쪽이 물러서고 아래는 0", R.r9_saved);
check(R.r9b_gone, "R9c 놓으면 윤곽이 사라진다");
check(R.r10, "R10 바닥 안쪽 30% 자리에 떠 있는 알약", `${R.r10_saved} · 가운데 ${R.r10_cx} (기대 ${R.r10_want})`);
check(R.r11_out, "R11 자동으로 가리기 — 독이 물러나고 부품이 자리를 다 쓴다 · 테두리 띠가 선다");
check(R.r11_in, "R11b 테두리 띠에 손을 대면 나온다");
check(R.r12_caret, "R12a 아이콘을 끄는 동안 끼울 자리 선이 보인다");
check(R.r12, "R12 아이콘을 끌어 순서를 바꾼다", R.r12_pins);
check(R.r13_badge, "R13a 독 밖으로 끌면 «빼기» 표시");
check(R.r13, "R13 고정한 아이콘을 독 밖으로 끌어내면 고정이 풀린다", R.r13_pins);
check(R.r14_open, "R14 [더보기] — 사이드바 앱 · 새 탭 앱 구획");
check(R.r14_filter, "R14b 검색이 거른다", R.r14_tiles);
check(R.r14_enter, "R14c Enter = 첫 앱을 연다 · 창이 닫힌다", R.r14_info);
check(R.r14d_attach, "R14d 붙이기 수단이 있으면 [더보기]에 «이 세션에 붙이기» — 설치 앱이 선다");
check(R.r15, "R15 Esc 로 닫힌다");
check(R.r16, "R16 곁칸 탭 줄 높이 = 세션 머리줄 높이(아래선이 한 줄)", JSON.stringify(R.r16_heights));
check(R.r17, "R17 곁칸이 접히면 독도 여백도 없다");
check(R.destroyed, "R18 걷으면 흔적이 없다");
check(R.r19, "R19 붙이기 수단이 없으면(옛 판 게이트웨이) [더보기]에 그 구획이 없다 — 독은 그대로 쓴다");
console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
