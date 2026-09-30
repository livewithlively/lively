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
//  ── #4443 리뷰 반영(2026-10-01) — 시험 페이지는 셸처럼 몸통에 메뉴 엔진을 걸고(main.ts), 곁칸 빈 자리 메뉴·공통 행도 흉내 낸다.
//     틀(#wrap)은 탭 칸(.v2-tabpane)처럼 overflow:auto 이고 곁칸이 오른쪽 끝에 붙는다 ──
//  A1 우클릭 = 독 행만(칸에 넣기·공통 행을 잇지 않는다) · A2 메뉴 키 · A3 ⇧F10 으로 연 메뉴가 **남는다** · A4 손가락 길게 누르기 = 독 행
//  A5 손잡이 우클릭 = 독 설정만 · A6 좁은 폭의 [더보기]엔 메뉴가 없다(브라우저 메뉴도 막는다)
//  B1 프로젝트 없는 화면(태스크·자료·지식 못 고름)에서 웹을 빼도 안 보이는 고정은 남는다 · B7 «독 되돌리기» = 고정 목록을 «적은 적 없음» 으로
//  C1 가리기(아래) · C2 가리기(오른쪽) — 틀에 스크롤이 안 생긴다 · C3 숨은 독에 초점이 들어가도 틀이 안 구르고 독이 나온다
//  D1 독 끌기 중 버튼이 떼어진 채 움직임 → 없던 일(다음 pointerup 도 안 적는다) · D2 아이콘 끌기도 · D3 창 blur · D4 다른 포인터는 모른 척
//  D5 끄는 중에 독이 걷히면 놓아도 아무것도 안 적는다 · D6 끌기는 한 번에 하나
//  E1 떠 있기만 한 앱을 제자리에서 흔들면 고정되지 않는다 · E2 고정 줄 안으로 끌어오면 그 자리에 고정
//  F1 키보드로 앱을 열면(다시 세움) 초점이 같은 앱의 새 단추로 · F2 초점이 독 밖이면 건드리지 않는다
//  G1 같은 창에서 캐시만 바뀌었을 때 refreshDocks 로 따라온다 · H1 [더보기]가 열린 채 독이 옮겨지면 새 단추 옆으로 · I1 이름표는 곁칸 안에
//  ── 재검증 반영(2026-10-01) ── H2 옆 독(오른쪽·왼쪽)의 [더보기]도 곁칸 안에 선다(곁칸 기본 폭 340) · F3 초점 든 앱을 빼면 초점은 이웃 단추로
//
// 왜 런타임인가: 자리·여백·확대는 CSS 와 스크립트가 **함께** 그린 결과에서만 잰다. 손짓은 포인터 사건의 흐름이다.
// fail-first(2026-09-30): 42-v2-dock.css 의 떠 있는 알약 translate(가운데 기준)를 지우면 R1·R10 이, 42-v2-panes.css 의 본문 여백
//  규칙을 지우면 R2·R2b·R9 가, 머리 줄 한 값(--pn-head-h)을 탭 줄에서 빼면 R16 이 빨간불이었다(DOCK_CSS · PANES_CSS 로 변형본을 물려 확인).
// fail-first(2026-10-01 리뷰 반영): 반영 전 독(git show HEAD, DOCK_UI_SRC) + 반영 전 곁칸 CSS(PANES_CSS)에 물리면 A2·A3·A4·B1·B7·C1·C2·
//  D1–D6·E1·F1·G1·H1·I1 19줄이 빨간불(39 ok · 19 fail). 새 독 + 반영 전 메뉴 엔진(ctx-registry 에 only 없음)이면 A1·A2·A4·A5·A6,
//  새 독 + 반영 전 곁칸 CSS(overflow: clip 없음)면 C1·C2 만 빨갛다. C3 은 옛 코드도 통과한다(초점 사건에서 독이 먼저 나와 구를 일이 없다)
//  — 그래서 «초점이 들어오면 독이 나온다» 를 지우는 돌연변이로 빨간불을 봤다.
// fail-first(2026-10-01 재검증 반영): 반영 전 독(PR #1203 머지판)에 물리면 H2(오른쪽 독 [더보기] −42px 밖) · H2b(왼쪽 −44px) · F3(초점 BODY) 가 빨갛다.
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
const CTX = process.env.CTX_SRC || path.join(ROOT, "web/v2/ctx-registry.ts");
//  독과 셸의 메뉴 엔진을 **한 묶음**으로 — 둘이 같은 제공자 표(bindCtx)와 같은 «열린 메뉴» 를 봐야 한다(따로 묶으면 표가 둘이 된다).
const entry = `export * from ${JSON.stringify(SRC)};\nexport { mountCtxMenus, bindCtxSurface, registerCtxCommon } from ${JSON.stringify(CTX)};\n`;
//  입구는 절대 경로만 쓴다(stdin 이라 기준 폴더가 없다).
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=Dock", "--platform=browser", "--log-level=error", "--loader=ts", "--sourcefile=dock-test-entry.ts"],
  { input: entry, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const STY = path.join(ROOT, "public/styles");
const css = (f, env) => readFileSync(process.env[env] || path.join(STY, f), "utf8");
//  실제 스타일: 토큰(01-base) · 앱 타일(40-v2 .v2-gi) · 세션 머리줄(36-chat) · 곁칸(42-v2-panes) · 독(42-v2-dock) · 메뉴(49-v2-ctx).
const CSS = [css("01-base.css"), css("36-chat.css"), css("40-v2.css"), css("42-v2-panes.css", "PANES_CSS"), css("42-v2-dock.css", "DOCK_CSS"), css("49-v2-ctx.css")].join("\n");

const PAGE = `<!doctype html><meta charset="utf-8"><style>${CSS}
  html,body{margin:0;font:14px sans-serif;background:var(--bg)}
  /* 헤드리스(가상 시간)는 CSS 전환을 진행시키지 않는다 — 전환 시작값을 재게 된다. 자리·크기는 전환 없이 잰다(튀어 오르기는 클래스로 본다). */
  *,*::before,*::after{transition:none!important;animation:none!important}
  /* 틀 = 탭 칸(.v2-tabpane)처럼 overflow:auto · 곁칸이 오른쪽 끝에 붙는다(C1–C3 — 넘친 독이 틀에 스크롤을 만드는지 본다) */
  #wrap{position:absolute;left:0;top:0;width:1240px;height:760px;overflow:auto}
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
<input id="ext" style="position:absolute;left:10px;top:800px;width:120px" aria-label="독 밖 입력칸">
<pre id="out">PENDING</pre>
<script>try{localStorage.clear()}catch(e){}
//  헤드리스(가상 시간)는 화면을 안 그려 requestAnimationFrame 이 안 돈다 — 시험 페이지에서만 16ms 타이머로 대신 돌린다.
window.requestAnimationFrame=(cb)=>setTimeout(()=>cb(performance.now()),16); window.cancelAnimationFrame=(id)=>clearTimeout(id);
//  CI 의 헤드리스(리눅스)는 마우스 장치가 없어 (any-)pointer: fine 이 거짓이다 — 확대는 «가는 포인터가 있을 때» 의 동작이므로 그 환경을 흉내 낸다(PR #1202 CI 실측).
//   흉내 내는 기기 = 터치 화면 + 트랙패드 노트북: 주 포인터는 손가락(pointer: fine 거짓), 가는 포인터가 하나 있다(any-pointer: fine 참).
//   그래서 확대를 pointer: fine 으로 판정하면 R7a 가 빨갛다 — 둘 다 참으로 흉내 내면 판정이 무엇이든 통과한다(#4443 리뷰 지적).
(function(){const mm=window.matchMedia.bind(window);const fake=(q,v)=>({matches:v,media:q,onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return false}});
 window.matchMedia=(q)=>/any-pointer:\\s*fine/.test(q)?fake(q,true):/pointer:\\s*fine/.test(q)?fake(q,false):mm(q);})();
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
  //  셸처럼(main.ts) 몸통에 메뉴 엔진 — 우클릭 · 메뉴 키 · 길게 누르기. 곁칸 빈 자리 메뉴(panes.ts bindCtxSurface)와 공통 행도 흉내.
  Dock.mountCtxMenus(document.body,{longPress:true,menuKey:true});
  Dock.bindCtxSurface(document.getElementById('wrap'),()=>[{label:'칸에 넣기',run:()=>{}},{label:'새 세션',run:()=>{}}]);
  Dock.registerCtxCommon(()=>[{label:'이 화면 주소 복사',run:()=>{}}]);
  const ESC=()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  const menuText=()=>{const m=document.querySelector('.pn-ctx'); return m?m.textContent:null;};
  const row=(label)=>[...document.querySelectorAll('.pn-ctx .pn-ctx-i')].find((b)=>(b.querySelector('.pn-ctx-l')||b).textContent===label);
  let narrowNow=false;
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
    curSession:()=>'sid-1', attach:async(a)=>{calls.push(['attach',a.id]);}, narrow:()=>narrowNow };
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
  R.a1_only=!!menu && !mt.includes('칸에 넣기') && !mt.includes('이 화면 주소 복사');
  ESC(); await frame();
  // A2 — 메뉴 키(≣): 초점 든 아이콘에서 → 독 메뉴가 뜨고 **남는다**(종전: 독이 연 메뉴를 엔진이 «열려 있으면 닫기» 로 곧바로 닫았다)
  const kb=it('web'); kb.focus();
  kb.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true,cancelable:true})); await frame(); await sleep(30);
  let tx=menuText(); R.a2_menukey=!!tx && tx.includes('독에서 빼기') && !tx.includes('칸에 넣기');
  ESC(); await frame();
  // A3 — ⇧F10
  kb.focus(); kb.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true})); await frame(); await sleep(30);
  tx=menuText(); R.a3_shiftf10=!!tx && tx.includes('독에서 빼기');
  ESC(); await frame(); kb.blur();
  // A4 — 손가락 길게 누르기(iOS 는 contextmenu 를 안 낸다) → 550ms 뒤 엔진이 그 자리의 메뉴 — 독 아이콘의 것이어야 한다
  const lr=rc(it('web'));
  it('web').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:cx(lr),clientY:cy(lr),pointerId:21,pointerType:'touch',isPrimary:true}));
  await sleep(640);
  tx=menuText(); R.a4_longpress=!!tx && tx.includes('독에서 빼기') && !tx.includes('칸에 넣기'); R.a4_info=(tx||'(메뉴 없음)').slice(0,60);
  it('web').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:21,pointerType:'touch'}));
  ESC(); await frame();
  // A5 — 독의 빈 자리(손잡이) 우클릭 = 독 설정만
  const gp=root.querySelector('.pn-dock-grip'); const gpr=rc(gp);
  gp.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:cx(gpr),clientY:cy(gpr)})); await frame();
  tx=menuText()||''; R.a5_settings=tx.includes('위치') && tx.includes('자동으로 가리기') && tx.includes('독 되돌리기') && !tx.includes('칸에 넣기') && !tx.includes('이 화면 주소 복사');
  ESC(); await frame();
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
  // C1 — 물러난 독은 곁칸 밖으로 넘치지 않는다: 틀(탭 칸 흉내, overflow:auto)에 스크롤이 안 생긴다(리뷰 실측: 아래 +50px)
  const wrap=document.getElementById('wrap');
  R.c1_info=[wrap.scrollHeight,wrap.clientHeight,wrap.scrollWidth,wrap.clientWidth];
  R.c1_no_scroll=wrap.scrollHeight<=wrap.clientHeight && wrap.scrollWidth<=wrap.clientWidth;
  reveal.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false,pointerType:'mouse'})); await frame(); await sleep(350);
  R.r11_in=!root.classList.contains('out');
  // C3 — 숨은 독에 키보드로 들어가도(초점) 틀이 구르지 않고 독이 나온다
  window.dispatchEvent(new StorageEvent('storage',{key})); await frame(); await sleep(60);      // 다시 가린다(손이 독 위에 없다)
  R.c3_hidden_first=root.classList.contains('out');
  it('files').focus(); await frame(); await sleep(60);
  R.c3_info=[wrap.scrollTop,wrap.scrollLeft,root.classList.contains('out')];
  R.c3_no_scroll=R.c3_hidden_first && wrap.scrollTop===0 && wrap.scrollLeft===0 && !root.classList.contains('out');
  document.activeElement.blur(); wrap.scrollTop=0; wrap.scrollLeft=0;
  // C2 — 오른쪽 테두리에서 가리기(리뷰 실측: 오른쪽 +50px)
  localStorage.setItem(key, JSON.stringify({...s2, hide:'1', edge:'right'})); window.dispatchEvent(new StorageEvent('storage',{key}));
  await frame(); await sleep(420);
  R.c2_info=[wrap.scrollWidth,wrap.clientWidth,wrap.scrollHeight,wrap.clientHeight,root.classList.contains('out')];
  R.c2_no_scroll=root.classList.contains('out') && root.dataset.edge==='right' && wrap.scrollWidth<=wrap.clientWidth && wrap.scrollHeight<=wrap.clientHeight;
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
  // ── 끌기 방어 — 떼는 순간을 못 본 끌기는 없던 일(탭 끌기 pane-tabdrag 와 같은 방어) ──
  //  묶음마다 알려진 자리에서 시작하고(setPrefs) 예외는 묶음 안에서 받는다 — 한 줄이 넘어져도 나머지 줄의 빨강·초록이 보이게(fail-first 에서 옛 코드가
  //   끌기 상태를 남겨 다음 줄들이 엉뚱하게 넘어졌다).
  const pinK=Object.keys(localStorage).find(k=>k.startsWith('lively_v2_dock_apps'));
  const prefsNow=()=>localStorage.getItem(key); const pinsNow=()=>localStorage.getItem(pinK);
  const Pb0=(x,y,id=9)=>window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:0,pointerId:id,pointerType:'mouse'}));
  const setPrefs=async(o={})=>{localStorage.setItem(key, JSON.stringify({edge:'bottom',at:'0.50',mode:'float',hide:'0',mag:'1',...o})); window.dispatchEvent(new StorageEvent('storage',{key})); await frame(); await sleep(60);};
  const setPins=async(list)=>{localStorage.setItem(pinK, JSON.stringify(list)); window.dispatchEvent(new StorageEvent('storage',{key:pinK})); await frame(); await sleep(40);};
  const clearDrag=async()=>{ESC(); window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:9,pointerType:'mouse'})); await frame(); await setPrefs();};
  const gripEl=()=>root.querySelector('.pn-dock-grip');
  try{
    await setPrefs();
    // D1 — 독 끌기 중 버튼이 떼어진 채 움직였다(액자·창 밖에서 놓았다)
    const p0=prefsNow(); const g1=rc(gripEl());
    P('pointerdown',cx(g1),cy(g1),gripEl()); P('pointermove',cx(g1)+30,cy(g1)-30);
    R.d1_started=root.classList.contains('moving') && !!pane.querySelector('.pn-dock-preview');
    Pb0(pr.left+10,pr.top+300); await frame();
    R.d1_cancelled=!root.classList.contains('moving') && !pane.querySelector('.pn-dock-preview') && !document.documentElement.classList.contains('pn-dock-dragging');
    P('pointerup',pr.left+10,pr.top+300); await frame(); await sleep(60);
    R.d1_nothing_saved=prefsNow()===p0;
  }catch(e){R.err_d1=String(e&&e.message||e);}
  await clearDrag();
  try{
    // D4 — 다른 포인터(pointerId 3)의 이동은 모른 척 · D3 — 창을 떠났다(⌘-Tab) → 없던 일
    const p0=prefsNow(); const g1=rc(gripEl());
    P('pointerdown',cx(g1),cy(g1),gripEl()); P('pointermove',cx(g1)+30,cy(g1)-30);
    const tf=root.style.transform;
    window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:pr.right-4,clientY:pr.top+200,button:0,buttons:1,pointerId:3,pointerType:'mouse'}));
    R.d4_other_pointer=!!tf && root.style.transform===tf;
    window.dispatchEvent(new Event('blur')); await frame();
    R.d3_blur=!root.classList.contains('moving') && !pane.querySelector('.pn-dock-preview') && !document.documentElement.classList.contains('pn-dock-dragging');
    P('pointerup',cx(g1)+30,cy(g1)-30); await frame(); await sleep(60);
    R.d3_nothing_saved=prefsNow()===p0;
  }catch(e){R.err_d3=String(e&&e.message||e);}
  await clearDrag();
  try{
    // D2 — 아이콘 끌기 중 버튼이 떼어졌다
    const q0=pinsNow(); const fi=rc(it('files').querySelector('.pn-dock-ic'));
    P('pointerdown',cx(fi),cy(fi),it('files')); P('pointermove',cx(fi)+20,cy(fi));
    R.d2_started=!!document.querySelector('.pn-dock-ghost');
    Pb0(cx(fi)+60,cy(fi)); await frame(); await sleep(60);
    R.d2_cancelled=!document.querySelector('.pn-dock-ghost') && !root.querySelector('.pn-dock-it.lifted') && !document.documentElement.classList.contains('pn-dock-dragging');
    P('pointerup',cx(fi)+60,cy(fi)); await frame(); await sleep(60);
    R.d2_nothing_saved=pinsNow()===q0;
  }catch(e){R.err_d2=String(e&&e.message||e);}
  await clearDrag();
  try{
    // D6 — 끌기는 한 번에 하나: 아이콘을 누른 채 손잡이를 또 눌러도 독 끌기는 시작되지 않는다
    const p0=prefsNow(), q0=pinsNow();
    const fi2=rc(it('files').querySelector('.pn-dock-ic')); const g2=gripEl(); const g2r=rc(g2);
    P('pointerdown',cx(fi2),cy(fi2),it('files')); P('pointerdown',cx(g2r),cy(g2r),g2); P('pointermove',cx(g2r)+30,cy(g2r)-30);
    R.d6_one_drag=!root.classList.contains('moving') && !pane.querySelector('.pn-dock-preview');
    ESC(); await frame(); await sleep(60);
    R.d6_clean=!document.querySelector('.pn-dock-ghost') && !document.documentElement.classList.contains('pn-dock-dragging') && pinsNow()===q0 && prefsNow()===p0;
  }catch(e){R.err_d6=String(e&&e.message||e);}
  await clearDrag();
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
  // ── 흔들기(E1) · 고정 줄로 끌어오기(E2) — 떠 있기만 한 앱(타임라인: 고정에서 빼 두고 R14 에서 열었다) ──
  try{
    await setPrefs(); await setPins(['files','knowledge','tasks','web']);
    const q1=pinsNow(); const tlA=it('timeline');
    R.e_case=!!tlA && !tlA.classList.contains('pin') && tlA.classList.contains('run');
    const tAr=rc(tlA.querySelector('.pn-dock-ic'));
    P('pointerdown',cx(tAr),cy(tAr),tlA); P('pointermove',cx(tAr)-8,cy(tAr)); P('pointerup',cx(tAr)-8,cy(tAr)); await frame(); await sleep(60);
    R.e1_wiggle=pinsNow()===q1; R.e1_info=pinsNow();
    await setPins(['files','knowledge','tasks','web']);
    const tkr=rc(it('tasks')), wbr=rc(it('web')); const tlB=it('timeline'); const tBr=rc(tlB.querySelector('.pn-dock-ic'));
    P('pointerdown',cx(tBr),cy(tBr),tlB); P('pointermove',cx(tBr)-20,cy(tBr)); P('pointermove',(cx(tkr)+cx(wbr))/2,cy(tBr));
    P('pointerup',(cx(tkr)+cx(wbr))/2,cy(tBr)); await frame(); await sleep(60);
    R.e2_info=pinsNow(); R.e2_pinned=pinsNow()==='["files","knowledge","tasks","timeline","web"]';
  }catch(e){R.err_e=String(e&&e.message||e);}
  await clearDrag();
  // ── 초점(F1 · F2) ──
  try{
    const kn2=it('knowledge'); R.f1_case=!!kn2 && !kn2.classList.contains('run');
    kn2.focus(); kn2.click(); await frame(); await sleep(40);
    const ae=document.activeElement;
    R.f1_info=ae?(ae.tagName+':'+((ae.dataset&&ae.dataset.type)||'')):'none';
    R.f1_refocus=!!ae && ae.classList.contains('pn-dock-it') && ae.dataset.type==='knowledge' && ae!==kn2 && ae.isConnected;
    const ext=document.getElementById('ext'); ext.focus();
    st.act='web'; dock.sync(); await frame();
    R.f2_untouched=document.activeElement===ext; ext.blur();
  }catch(e){R.err_f=String(e&&e.message||e);}
  // F3 — 초점 든 앱의 단추가 사라지면(메뉴 키 → «독에서 빼기», 안 떠 있는 앱) 초점은 같은 자리의 이웃 단추로(재검증 실측: body)
  try{
    APPS.push({type:'liv',name:'리브',glyph:'apps',hint:'리브',multi:false,pickable:true});
    await setPrefs(); await setPins(['files','knowledge','liv','tasks','web']);
    const lv=it('liv'); R.f3_case=!!lv && !lv.classList.contains('run');
    lv.focus(); lv.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true,cancelable:true})); await frame(); await sleep(30);
    const un=row('독에서 빼기'); if(un) un.click(); await frame(); await sleep(60);
    const a3=document.activeElement;
    R.f3_info=a3?(a3.tagName+':'+((a3.dataset&&a3.dataset.type)||'')):'none';
    R.f3_neighbor=!!un && !it('liv') && !!a3 && a3.classList.contains('pn-dock-it') && a3.isConnected && a3.dataset.type==='tasks';
    if(a3&&a3.blur) a3.blur();
  }catch(e){R.err_f3=String(e&&e.message||e);}
  ESC(); { const i=APPS.findIndex(a=>a.type==='liv'); if(i>=0) APPS.splice(i,1); } await setPins(['files','knowledge','tasks','web']);
  // G1 — 같은 창에서 캐시만 바뀌었다(부팅 동기 · 저장 응답 채택 — storage 사건 없음) → 셸이 refreshDocks 를 부르면 따라온다
  try{
    await setPrefs(); const pg=prefsNow(); const hasRefresh=typeof Dock.refreshDocks==='function';
    localStorage.setItem(key, JSON.stringify({...JSON.parse(pg), edge:'top'}));
    if(hasRefresh) Dock.refreshDocks(); await frame();
    R.g1_follow=hasRefresh && root.dataset.edge==='top';
  }catch(e){R.err_g=String(e&&e.message||e);}
  // H1 — [더보기]가 열린 채 독이 옮겨졌다(다른 창에서 위치 › 왼쪽) → 창은 열린 채 새 단추 옆에서 다시 부풀어 나온다
  try{
    await setPrefs();
    root.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(120);
    await setPrefs({edge:'left'});
    const mp=pane.querySelector('.pn-dock-more'); const nb=root.querySelector('.pn-dock-more-btn');
    R.h1_info=[mp&&mp.dataset.edge, nb&&nb.getAttribute('aria-expanded'), root.dataset.edge];
    R.h1_reanchor=!!mp && mp.classList.contains('open') && mp.dataset.edge==='left' && root.dataset.edge==='left' && nb.getAttribute('aria-expanded')==='true' && rc(mp).left>=rc(root).right-0.5;
    if(mp) mp.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sleep(260);
  }catch(e){R.err_h=String(e&&e.message||e);}
  // H2 — 옆 독(오른쪽·왼쪽)의 [더보기]도 곁칸 안에 선다 — 곁칸이 넘친 것을 자르므로 밖으로 나간 몫은 잘린다(재검증 실측: 오른쪽 독에서 타일 15개 중 5개)
  for(const edge of ['right','left']){
    try{
      await setPrefs({edge});
      root.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(260);
      const mp=pane.querySelector('.pn-dock-more'); const pr1=rc(pane); const qe=mp&&mp.querySelector('.pn-dock-more-q');
      const r1=mp?rc(mp):null; const qr=qe?rc(qe):null;
      R['h2_'+edge+'_info']=r1?[Math.round(r1.left-pr1.left),Math.round(pr1.right-r1.right),Math.round(r1.width)]:'(창 없음)';
      R['h2_'+edge]=!!r1 && !!qr && r1.left>=pr1.left-0.5 && r1.right<=pr1.right+0.5 && qr.left>=pr1.left && qr.right<=pr1.right;
      if(mp) mp.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sleep(260);
    }catch(e){R['err_h2_'+edge]=String(e&&e.message||e);}
  }
  await setPrefs();
  // I1 — 이름표는 곁칸 안에 선다(곁칸이 넘친 것을 자른다): 왼쪽 끝에 둔 독의 첫 아이콘에 긴 이름
  const fApp=APPS.find(a=>a.type==='files'); const oldName=fApp.name;
  try{
    fApp.name='자료 — 이름이 꽤 긴 앱';
    await setPins(['files','knowledge','tasks','web']); await setPrefs({at:'0.00'});
    const first=it('files'); first.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false,pointerType:'mouse'})); await frame();
    const tipEl=pane.querySelector('.pn-dock-tip'); const tpr=rc(tipEl); const pr0=rc(pane);
    R.i1_info=[Math.round(tpr.left-pr0.left), Math.round(pr0.right-tpr.right), tipEl.hidden, tipEl.textContent];
    R.i1_inside=!tipEl.hidden && tipEl.textContent===fApp.name && tpr.left>=pr0.left+3.5 && tpr.right<=pr0.right-3.5;
    first.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'}));
  }catch(e){R.err_i=String(e&&e.message||e);}
  fApp.name=oldName; await setPrefs();
  // B1 — 프로젝트 없는 세션 화면(태스크·자료·지식을 못 고른다)에서 웹 «독에서 빼기» → 안 보이는 고정은 남는다
  try{
    localStorage.removeItem(pinK);                                        // 정한 적 없음 = 기본 다섯
    for(const a of APPS) if(['tasks','files','knowledge'].includes(a.type)) a.pickable=false;
    dock.sync(); await frame();
    const wB=it('web'); const wBr=rc(wB);
    wB.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:cx(wBr),clientY:cy(wBr)})); await frame();
    const unpin=row('독에서 빼기'); R.b1_case=!!unpin;
    if(unpin) unpin.click(); await frame(); await sleep(40);
    R.b1_info=localStorage.getItem(pinK);
    R.b1_hidden_kept=localStorage.getItem(pinK)==='["tasks","files","knowledge","timeline"]';
  }catch(e){R.err_b1=String(e&&e.message||e);}
  ESC(); for(const a of APPS) if(['tasks','files','knowledge'].includes(a.type)) a.pickable=true;
  dock.sync(); await frame();
  // B7 — «독 되돌리기» = 고정 목록을 «적은 적 없음» 으로(나중에 기본값이 바뀌면 따라간다) · 설정은 기본
  try{
    await setPins(['web','files']); await setPrefs({edge:'top', at:'0.30', hide:'1'});
    await setPrefs({at:'0.30'});                                          // 손잡이가 보이는 자리(떠 있는 알약 · 가리기 끔)에서 연다
    const gB=gripEl(); const gBr=rc(gB);
    gB.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:cx(gBr),clientY:cy(gBr)})); await frame();
    const rs=row('독 되돌리기'); if(rs) rs.click(); await frame(); await sleep(40);
    const pd=JSON.parse(localStorage.getItem(key)||'null');
    R.b7_info=[localStorage.getItem(pinK), JSON.stringify(pd)];
    R.b7_reset=!!rs && localStorage.getItem(pinK)===null && !!pd && pd.edge==='bottom' && pd.mode==='float' && pd.hide==='0' && pd.at==='0.50';
  }catch(e){R.err_b7=String(e&&e.message||e);}
  ESC(); await frame();
  // A6 — 좁은 폭(서랍): [더보기] 우클릭엔 메뉴가 없다 — 곁칸 빈 자리 메뉴도, 브라우저 메뉴도(엔진이 막는다)
  try{
    narrowNow=true; dock.sync(); await frame();
    const mbN=root.querySelector('.pn-dock-more-btn'); const mbr=rc(mbN);
    const ce=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:cx(mbr),clientY:cy(mbr)}); mbN.dispatchEvent(ce); await frame();
    R.a6_narrow_none=root.classList.contains('narrow') && !document.querySelector('.pn-ctx') && ce.defaultPrevented;
  }catch(e){R.err_a6=String(e&&e.message||e);}
  ESC(); narrowNow=false; dock.sync(); await frame();
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
  // D5 — 끄는 중에 독이 걷혔다(탭을 닫았다) → 놓아도 아무것도 안 적는다 · 조각이 안 남는다
  try{
    await setPins(['files','knowledge','tasks','web']);
    const q5=localStorage.getItem(pinK);
    const dock3=Dock.mountDock(host2); await frame(); await sleep(40);
    const f5=pane.querySelector('.pn-dock-it[data-type="files"]'); const f5r=rc(f5.querySelector('.pn-dock-ic'));
    P('pointerdown',cx(f5r),cy(f5r),f5); P('pointermove',cx(f5r)+20,cy(f5r)); P('pointermove',cx(f5r)+20,cy(f5r)-150);
    R.d5_started=!!document.querySelector('.pn-dock-ghost');
    dock3.destroy();
    P('pointerup',cx(f5r)+20,cy(f5r)-150); await frame(); await sleep(60);
    R.d5_nothing=R.d5_started && localStorage.getItem(pinK)===q5 && !document.querySelector('.pn-dock-ghost') && !document.documentElement.classList.contains('pn-dock-dragging');
  }catch(e){R.err_d5=String(e&&e.message||e);}
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
// ── #4443 리뷰 반영(2026-10-01) ──
check(R.a1_only, "A1 우클릭 = 독 행만 — 곁칸 빈 자리 메뉴(칸에 넣기)·공통 행을 잇지 않는다(macOS 독 메뉴처럼 그 앱의 것만)");
check(R.a2_menukey, "A2 메뉴 키(≣)로 연 독 메뉴가 **남는다**(종전: 엔진이 곧바로 닫았다 — 키보드로는 고정·빼기·닫기에 못 닿았다)");
check(R.a3_shiftf10, "A3 ⇧F10 도 같다");
check(R.a4_longpress, "A4 손가락 길게 누르기 = 독 메뉴(종전: 곁칸 빈 자리 메뉴 «칸에 넣기…»)", R.a4_info);
check(R.a5_settings, "A5 독의 빈 자리(손잡이) 우클릭 = 독 설정만");
check(R.a6_narrow_none, "A6 좁은 폭(서랍)의 [더보기]엔 메뉴가 없다 — 곁칸 메뉴도 브라우저 메뉴도 안 뜬다");
check(R.b1_case, "B1a (배선) 좁힌 화면에서도 웹 메뉴에 «독에서 빼기» 가 섰다");
check(R.b1_hidden_kept, "B1 프로젝트 없는 화면에서 웹을 빼도 안 보이는 고정(태스크·자료·지식)은 계정에 남는다(종전: [timeline] 하나)", R.b1_info);
check(R.b7_reset, "B7 «독 되돌리기» = 고정 목록을 «적은 적 없음» 으로(기본값이 바뀌면 따라간다) · 자리·모양·가리기 기본", JSON.stringify(R.b7_info));
check(R.c1_no_scroll, "C1 가리기(아래) — 물러난 독이 곁칸 밖으로 넘쳐 틀(탭 칸)에 스크롤을 만들지 않는다", JSON.stringify(R.c1_info));
check(R.c2_no_scroll, "C2 가리기(오른쪽)도", JSON.stringify(R.c2_info));
check(R.c3_no_scroll, "C3 숨은 독에 초점이 들어가도 틀이 구르지 않고 독이 나온다", JSON.stringify(R.c3_info));
check(R.d1_started && R.d1_cancelled, "D1 독 끌기 중 버튼이 떼어진 채 움직이면 없던 일 — 끌기 상태(액자 포인터 막기 포함)가 안 남는다");
check(R.d1_nothing_saved, "D1b 그 뒤의 아무 pointerup 도 «놓기» 가 아니다 — 자리가 안 바뀐다(종전: edge=left 로 저장됐다)");
check(R.d2_started && R.d2_cancelled && R.d2_nothing_saved, "D2 아이콘 끌기 중 버튼이 떼어져도 없던 일 — 조각·들림 없음 · 고정 그대로");
check(R.d3_blur && R.d3_nothing_saved, "D3 끄는 중에 창을 떠나면(blur) 없던 일");
check(R.d4_other_pointer, "D4 다른 포인터의 이동은 모른 척(독이 그 포인터를 따라가지 않는다)");
check(R.d5_nothing, "D5 끄는 중에 독이 걷히면 놓아도 아무것도 안 적는다 · 조각이 안 남는다");
check(R.d6_one_drag && R.d6_clean, "D6 끌기는 한 번에 하나 — 아이콘을 누른 채 손잡이를 또 눌러도 독 끌기가 안 선다");
check(R.e_case, "E0 (배선) 떠 있기만 한 앱(타임라인)이 뒤 구획에 섰다");
check(R.e1_wiggle, "E1 떠 있기만 한 앱을 제자리에서 흔들면 고정되지 않는다(종전: 8px 에 고정 줄 맨 뒤로)", R.e1_info);
check(R.e2_pinned, "E2 고정 줄 안(프로젝트·웹 사이)으로 끌어오면 그 자리에 고정", R.e2_info);
check(R.f1_case && R.f1_refocus, "F1 키보드로 앱을 열면(독을 다시 세움) 초점이 같은 앱의 새 단추로(종전: body)", R.f1_info);
check(R.f2_untouched, "F2 초점이 독 밖이면 다시 세워도 건드리지 않는다");
check(R.g1_follow, "G1 같은 창에서 캐시만 바뀌면(부팅 동기 · 저장 응답) refreshDocks 로 따라온다");
check(R.h1_reanchor, "H1 [더보기]가 열린 채 독이 옮겨지면 창은 열린 채 새 단추 옆으로(aria-expanded 도 새 단추에)", JSON.stringify(R.h1_info));
check(R.i1_inside, "I1 이름표는 곁칸 안에 선다 — 왼쪽 끝 독의 긴 이름도 안 잘린다", JSON.stringify(R.i1_info));
check(R.h2_right, "H2 오른쪽 독의 [더보기]가 곁칸 안에 선다(검색 칸까지) — 곁칸이 자르니 밖으로 나가면 잘린다", JSON.stringify(R.h2_right_info));
check(R.h2_left, "H2b 왼쪽 독도", JSON.stringify(R.h2_left_info));
check(R.f3_case && R.f3_neighbor, "F3 초점 든 앱을 메뉴 키로 빼면(단추가 사라짐) 초점은 같은 자리의 이웃(프로젝트)으로", R.f3_info);
const errs=Object.keys(R).filter((k)=>k.startsWith("err_")).map((k)=>`${k}: ${R[k]}`);
check(!errs.length, "(배선) 시나리오 묶음이 넘어지지 않았다 — 위 판정이 실제로 끝까지 돌았다", errs.join(" | "));
console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
