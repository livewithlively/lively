#!/usr/bin/env node
// 곁칸 독 — 실제 크롬에서 재는 자리 · 끌어 옮기기 · 크기 · 메뉴 (#4443 «곁칸 → 앱의 실행 화면», 원준 2026-09-30 → 10-01)
//
//  원준(10-01, 바로잡음): "디폴트로 4안(이음매 독)이고 끌어당겨서 3안에 둘 수 있는 걸로 하고 싶은거야. 그리고 아래에 뒀을 때는
//   곁칸 사이즈 변하는거에 따라서 독 사이즈도 바꾸고 싶음. 너가 바닥 왼쪽 탭 만든건 없애줘 일단은. 그리고 좀 더 이쁘게 … 맥 os 참고해서."
//
// 시험 페이지 = 셸의 격자 그대로: .pn-wrap > .pn-body(세션 열 | 분할선 6px | 곁칸 340px). 틀(#wrap)은 탭 칸(.v2-tabpane)처럼
//  overflow:auto 이고 곁칸이 오른쪽 끝에 붙는다. 몸통에 셸의 메뉴 엔진을 걸고(main.ts), 곁칸 빈 자리 메뉴·공통 행도 흉내 낸다.
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  R1  기본 = 이음매: 분할선 한가운데(세로) · 세로 구간 가운데 · 곁칸의 부모(.pn-body)에 붙는다 · 세로 알약
//  R1b 손잡이(⋮⋮) · 자동 가리기 띠가 없다(원준 10-01 «없애줘»)
//  R2  이음매 독은 아무도 안 비킨다 — 곁칸 본문 여백 0, «태스크 추가» 가 곁칸 바닥에(제 바깥 여백만큼 위)
//  R3  점 = 떠 있는 탭 수(최대 셋), 켜진 앱만 켜짐 · R4 안 떠 있는 앱을 누르면 연다 · 튀어 오른다
//  R5  떠 있는 앱은 보여 주고, 켜진 앱을 또 누르면 다음 인스턴스 · R6 ⌥-클릭 = 하나 더
//  R7  확대 — 이음매는 세로 축: 마우스 밑 ≈1.6배, 먼 것은 그대로 · R7c 알약 폭은 그대로(아이콘이 양옆으로 솟는다, macOS)
//  R8  우클릭(엔진) — 열린 창 · 새로 열기 · 모두 닫기 · 독에서 빼기 · 독 설정. A1–A5 메뉴 세 길 · A6 좁은 폭의 [더보기]엔 메뉴 없음
//  S1  독 설정 메뉴: 위치 › 이음매 · 사이드바 아래 / 확대 / 독 되돌리기 — «모양» · «자동으로 가리기» 는 없다
//  R9  이음매에서 알약 끝을 잡고 곁칸 안쪽 깊이 끌면 → 놓일 자리 윤곽(곁칸 바닥) → 놓으면 곁칸 아래(계정 설정 home=float), 곁칸에 붙는다
//  R2b 곁칸 아래 독은 내용 위에 떠 있다(원준 10-02 «뒤에 그냥 뭐 없이 둥둥 떠있게») — 본문 여백 0(하얀 띠 없음) · 맨 아래 입력칸이 있는 앱(프로젝트)은
//      앱 끝에 독 두께(아이콘 + 안 여백×2 + 점 줄 + 바깥 여백×2)만큼 빈 자리 → «태스크 추가» 가 독 위에
//  R2c 목록은 독 밑까지 흐른다 — 자료 목록 상자의 바닥 = 곁칸 바닥 · 독 옆 바닥 자리도 목록 · 끝에 독 두께만큼 빈 자리 → 끝까지 굴리면 마지막 줄이 독 위
//  R10 곁칸 아래 독의 크기는 곁칸 폭을 따라 — 280 < 340 < 420 에서 아이콘이 커지고, 어느 폭에서도 확대한 몫까지 곁칸 안에
//  R10c 곁칸 아래 독은 확대해도 알약 높이는 그대로(아이콘이 위로 솟는다, macOS)
//  R11 곁칸 아래에서 경계선 가까이(세로 30% 높이)로 끌어 놓으면 → 이음매, 그 높이(at 0.3)
//  R12 아이콘을 끌어 순서를 바꾼다(이음매는 세로) · R13 독 밖으로(옆으로) 끌어내면 고정이 풀린다
//  R14 [더보기] — 이음매 독이면 알약 옆 곁칸 쪽으로 부풀어 곁칸 안에 · 사이드바 앱만(«새 탭으로 여는 앱» 없음, 원준 10-05) · 검색 · Enter · R15 Esc
//  H2  곁칸 아래 독의 [더보기]는 곁칸 안, 독 위에
//  R16 곁칸 탭 줄 높이 = 세션 머리줄 높이 · C1 어느 자리에서도 틀(탭 칸)에 스크롤이 안 생긴다
//  R17 이음매가 없으면(서랍 · 카드 · 접힘) 곁칸 아래 · R17b 자리바꿈(곁칸이 왼쪽 · sw-left)이면 오른쪽 분할선 위 · 이름표는 세션 쪽(오른쪽)
//  R17c 곁칸이 접히면(폭 0) 독도 빈 자리도 없다 · R18 걷으면 흔적이 없다 · R19 붙이기 수단이 없는 게이트웨이(옛 판) — 그 구획이 없다
//  D1–D6 끌기 방어(버튼 떼어짐 · 다른 포인터 · blur · 걷힘 · 한 번에 하나) · E1–E2 흔들기/고정 줄로 끌어오기
//  F1–F3 초점 · G1 refreshDocks · H1 [더보기] 열린 채 자리가 바뀌면 옛 창은 닫힌다 · I1 이름표(이음매 = 세션 쪽 · 곁칸 아래 = 곁칸 안)
//  B1 안 보이는 고정 보존 · B7 «독 되돌리기» = 이음매 가운데 + 고정 목록 «적은 적 없음»
//  HD1 이음매 독 맨 위에 손잡이(원준 10-01 «위쪽에 핸들») — 첫 아이콘 위 · 짧은 가로 막대 · 앱 단추가 아니다(탭 순서 밖)
//  HD2 손잡이를 잡고 끌면 독이 옮겨 간다(R9 가 손잡이에서 시작) · HD4 손잡이 위에선 확대하지 않는다
//  HD5 좁은 폭(서랍)엔 손잡이가 없다
//  HF1 곁칸 아래 독에도 손잡이(원준 10-02 «이음새 있을 때랑 똑같이») — 알약 왼쪽 끝 · 세운 막대 · 아이콘 높이 가운데 · 앱 단추가 아니다
//  HF2 그 손잡이를 잡고 경계선으로 끌면 이음매로(R11 이 손잡이에서 시작) · HF3 그 손잡이 위에선 확대하지 않는다
//  GL1 「프로젝트」 타일 = 과녁(proj) · GL2 [모든 앱] 타일 = 각진 사각 넷(apps)(#4233 원준 2026-10-05 «독에는 아이콘은 왜 안 바꿨나»)
//
// 왜 런타임인가: 경계선 위에 걸쳤는지 · 곁칸 폭을 따라 커지는지 · 끌어 놓은 곳에 서는지는 CSS 가 실제로 그린 자리에서만 잰다.
// fail-first(2026-10-01 이음매 판): 바꾸기 전 판(떠 있는 알약 기본 · 막대 · 손잡이 — lib · 독 · CSS 셋 다 git show HEAD 를 제자리에)에 물리면
//  71 중 32 줄이 빨갛다(R1 · R1b · R2 · R7c · S1 · R9 · R2b · R10 · R11 · R14a · G1 · H1 · I1 · B7 · R17 …). 돌연변이 —
//  끄는 동안 곁칸의 부모로 옮겨 붙지 않으면 R11b · 곁칸 아래 크기를 고정(48)하면 R10 · 곁칸 아래 알약 높이 고정을 빼면 R10c ·
//  이음매 알약 폭 고정을 빼면 R7c 가 빨갛다(DOCK_UI_SRC · DOCK_CSS 로 물려 확인).
// fail-first(2026-10-01 손잡이): 손잡이 전 판(PR #1208 머지판)에 물리면 HD1 · HD2 · HD4 가, 손잡이 위 확대 멈춤을 지우면 HD4(첫 아이콘 47px)가 빨갛다.
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
const entry = `export * from ${JSON.stringify(SRC)};\nexport { mountCtxMenus, bindCtxSurface, registerCtxCommon } from ${JSON.stringify(CTX)};\nexport { iconPath } from ${JSON.stringify(path.join(ROOT, "web/lib/icon-paths.ts"))};\n`;
//  입구는 절대 경로만 쓴다(stdin 이라 기준 폴더가 없다).
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=Dock", "--platform=browser", "--log-level=error", "--loader=ts", "--sourcefile=dock-test-entry.ts"],
  { input: entry, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const STY = path.join(ROOT, "public/styles");
const css = (f, env) => readFileSync(process.env[env] || path.join(STY, f), "utf8");
//  실제 스타일: 토큰(01-base) · 세션 머리줄(36-chat) · 앱 타일 · 분할선(40-v2) · 곁칸(42-v2-panes) · 독(42-v2-dock) · 자리바꿈(45) · 메뉴(49-v2-ctx).
const CSS = [css("01-base.css"), css("36-chat.css"), css("40-v2.css"), css("42-v2-panes.css", "PANES_CSS"), css("42-v2-dock.css", "DOCK_CSS"), css("45-v2-side-swap.css"), css("49-v2-ctx.css")].join("\n");

const PAGE = `<!doctype html><meta charset="utf-8"><style>${CSS}
  html,body{margin:0;font:14px sans-serif;background:var(--bg)}
  /* 헤드리스(가상 시간)는 CSS 전환을 진행시키지 않는다 — 전환 시작값을 재게 된다. 자리·크기는 전환 없이 잰다(튀어 오르기는 클래스로 본다). */
  *,*::before,*::after{transition:none!important;animation:none!important}
  /* 틀 = 탭 칸(.v2-tabpane)처럼 overflow:auto · 곁칸이 오른쪽 끝(C1) */
  #wrap{position:absolute;left:0;top:0;width:1240px;height:760px;overflow:auto}
  .pn-col{display:flex;flex-direction:column;min-width:0;background:var(--bg)}
  #split{background:var(--line)}
</style>
<div id="wrap" class="pn-wrap">
  <div id="grid" class="pn-body">
    <div class="pn-col" id="col"><div id="head" class="sc-head"><div class="sc-head-l"><b>세션 머리줄</b></div><div class="sc-head-r"><button class="btn btn-ghost btn-sm">단추</button></div></div><div style="flex:1"></div></div>
    <div class="v2-split-x" id="split"></div>
    <section id="pane" class="pn-pane" data-zone="side">
      <div class="pn-tabbar"><div class="pn-tabs"></div><div class="pn-tabtail"></div></div>
      <div class="pn-pane-body"><div class="pn-part pn-tk" id="tkpart"><div class="pn-tk-list">목록</div><label class="pn-tk-add">＋ 태스크 추가</label></div><div class="pn-part pn-files" id="fpart" hidden><div class="pn-fbody"><div style="height:1600px">긴 자료 목록</div><div class="last">마지막 줄</div></div></div></div>
    </section>
  </div>
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
  const pane=document.getElementById('pane'); const pbody=pane.querySelector('.pn-pane-body');
  const tkPart=document.getElementById('tkpart'), tkAdd=tkPart.querySelector('.pn-tk-add'), fPart=document.getElementById('fpart'), fBody=fPart.querySelector('.pn-fbody'), fLast=fPart.querySelector('.last');
  const mb=(e)=>parseFloat(getComputedStyle(e).marginBottom)||0;
  const grid=document.getElementById('grid'); const split=document.getElementById('split'); const wrap=document.getElementById('wrap');
  //  셸처럼(main.ts) 몸통에 메뉴 엔진 — 우클릭 · 메뉴 키 · 길게 누르기. 곁칸 빈 자리 메뉴(panes.ts bindCtxSurface)와 공통 행도 흉내.
  Dock.mountCtxMenus(document.body,{longPress:true,menuKey:true});
  Dock.bindCtxSurface(wrap,()=>[{label:'칸에 넣기',run:()=>{}},{label:'새 세션',run:()=>{}}]);
  Dock.registerCtxCommon(()=>[{label:'이 화면 주소 복사',run:()=>{}}]);
  const ESC=()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  const menuText=()=>{const m=document.querySelector('.pn-ctx'); return m?m.textContent:null;};
  const row=(label)=>[...document.querySelectorAll('.pn-ctx .pn-ctx-i')].find((b)=>(b.querySelector('.pn-ctx-l')||b).textContent===label);
  let narrowNow=false; let seamOn=true;
  const calls=[];
  const APPS=[
    {type:'tasks',name:'프로젝트',glyph:'proj',hint:'태스크',multi:false,pickable:true},
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
    curSession:()=>'sid-1', attach:async(a)=>{calls.push(['attach',a.id]);},
    seam:()=>(seamOn?split:null), narrow:()=>narrowNow };
  dock=Dock.mountDock(host);
  await frame(); await sleep(30);
  const root=document.querySelector('.pn-dock'); const shelf=root.querySelector('.pn-dock-shelf');
  const it=(t)=>root.querySelector('.pn-dock-it[data-type="'+t+'"]');
  const seamX=()=>cx(rc(split));
  const span=()=>{const p=rc(pane); const bar=pane.querySelector('.pn-tabbar').offsetHeight; return {top:p.top+bar,bottom:p.bottom};};
  const sizeNow=()=>parseFloat(getComputedStyle(root).getPropertyValue('--dk-s'));
  const P=(type,x,y,t=window)=>t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:1,pointerId:9,pointerType:'mouse'}));
  const Pb0=(x,y,id=9)=>window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:0,pointerId:id,pointerType:'mouse'}));
  //  독을 잡는 자리 — 이음매면 맨 위 손잡이 한가운데, 곁칸 아래면 알약 왼쪽 끝 여백(곁칸 아래엔 손잡이가 없다).
  const grabPt=()=>{const r=rc(shelf); const h=shelf.querySelector('.pn-dock-handle'); if(h){const q=rc(h); return [cx(q),cy(q)];} return root.dataset.home==='seam'?[cx(r), r.top+4]:[r.left+3, cy(r)];};
  const PK='lively_v2_dock', PINK='lively_v2_dock_apps';
  const prefsNow=()=>localStorage.getItem(PK); const pinsNow=()=>localStorage.getItem(PINK);
  const setPrefs=async(o={})=>{localStorage.setItem(PK, JSON.stringify({home:'seam',at:'0.50',mag:'1',...o})); window.dispatchEvent(new StorageEvent('storage',{key:PK})); await frame(); await sleep(60);};
  const setPins=async(list)=>{localStorage.setItem(PINK, JSON.stringify(list)); window.dispatchEvent(new StorageEvent('storage',{key:PINK})); await frame(); await sleep(40);};
  const clearDrag=async()=>{ESC(); window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:9,pointerType:'mouse'})); await frame(); await setPrefs();};

  // R1 — 기본 = 이음매
  let sr=rc(shelf); const sp0=span();
  R.r1_info=[Math.round(cx(sr)-seamX()), Math.round(cy(sr)-(sp0.top+sp0.bottom)/2), root.dataset.home, root.parentElement&&root.parentElement.id, Math.round(sr.width), Math.round(sr.height)];
  R.r1=root.dataset.home==='seam' && root.parentElement===grid && Math.abs(cx(sr)-seamX())<=1 && Math.abs(cy(sr)-(sp0.top+sp0.bottom)/2)<=2 && sr.height>sr.width*3;
  R.r1b_nogrip=!document.querySelector('.pn-dock-grip') && !document.querySelector('.pn-dock-reveal');
  //  GL 독 타일의 그림(#4233): 프로젝트 = 과녁 · [모든 앱] = 각진 사각 넷. 실제로 그린 path 를 읽는다.
  const gd=(n)=>{const p=n&&n.querySelector('.pn-dock-ic .v2-gi-glyph'); return p?p.getAttribute('d'):null;};
  R.gl_tasks=gd(it('tasks')); R.gl_more=gd(root.querySelector('.pn-dock-more-btn'));
  // R2 — 이음매 독은 아무도 안 비킨다
  R.r2=['paddingBottom','paddingTop','paddingLeft','paddingRight'].every((k)=>getComputedStyle(pbody)[k]==='0px') && Math.abs(rc(tkAdd).bottom+mb(tkAdd)-rc(pane).bottom)<=1;
  // HD1 — 이음매 독 맨 위의 손잡이: 첫 아이콘 위 · 짧은 가로 막대 · 앱 단추가 아니다
  const hd=shelf.querySelector('.pn-dock-handle'); const hdi=hd&&hd.querySelector('i');
  if(hd){ const hr=rc(hd), ir=rc(hdi), fr=rc(it('tasks').querySelector('.pn-dock-ic'));
    R.hd1_info=[Math.round(hr.width),Math.round(hr.height),Math.round(ir.width),Math.round(ir.height),Math.round(fr.top-hr.bottom)];
    R.hd1=shelf.firstElementChild===hd && hr.bottom<=fr.top && Math.abs(cx(ir)-seamX())<=1 && ir.width>=12 && ir.width<=24 && ir.height>=3 && ir.height<=5
      && hd.tagName!=='BUTTON' && !hd.hasAttribute('tabindex') && hd.getAttribute('aria-hidden')==='true' && getComputedStyle(hd).cursor==='grab'; }
  // HD4 — 손잡이 위에선 확대하지 않는다(잡으려는 것은 독)
  if(hd){ const hr=rc(hd);
    hd.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx(hr),clientY:cy(hr),pointerType:'mouse'})); await frame(); await sleep(200);
    const s0=sizeNow(); const icw=[...shelf.querySelectorAll('.pn-dock-ic')].map((q)=>rc(q).width);
    R.hd4_info=JSON.stringify(icw.map((x)=>Math.round(x)));
    R.hd4_no_mag=icw.every((x)=>Math.abs(x-s0)<=0.6);
    shelf.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'})); await frame(); await sleep(200); }
  // R3
  R.r3=it('web').querySelectorAll('.pn-dock-dots i').length===2 && it('files').querySelectorAll('.pn-dock-dots i').length===1
    && it('tasks').querySelectorAll('.pn-dock-dots i').length===0 && it('files').classList.contains('on') && !it('web').classList.contains('on');
  // R4
  calls.length=0; it('tasks').click(); await frame();
  R.r4=JSON.stringify(calls)==='[["open","tasks"]]' && it('tasks').classList.contains('bounce');
  // R5
  calls.length=0; it('web').click(); it('web').click();
  R.r5=JSON.stringify(calls)==='[["show","web"],["show","web#2"]]'; R.r5_info=JSON.stringify(calls);
  // R6
  calls.length=0; it('files').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,altKey:true}));
  R.r6=JSON.stringify(calls)==='[["open","files"]]';
  await sleep(950);                                  // 튀어 오르기가 끝나게
  // R7 — 확대(이음매는 세로 축)
  R.r7_mag_on=root.classList.contains('mag');
  const size=sizeNow();
  const tr=rc(it('knowledge').querySelector('.pn-dock-ic'));
  shelf.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx(tr),clientY:cy(tr),pointerType:'mouse'}));
  await frame(); await sleep(260);
  const w=(t)=>rc(it(t).querySelector('.pn-dock-ic')).width;
  const far=root.querySelector('.pn-dock-more-btn .pn-dock-ic');
  R.r7_info=[size, Math.round(w('knowledge')*10)/10, Math.round(rc(far).width*10)/10];
  R.r7=Math.abs(w('knowledge')-size*1.6)<=1.5 && Math.abs(rc(far).width-size)<=0.6 && w('files')>size+0.5;
  R.r7c_shelf_fixed=Math.abs(rc(shelf).width-(size+12))<=1;
  shelf.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'}));
  await frame(); await sleep(320);
  R.r7_settles=Math.abs(w('knowledge')-size)<=0.6;
  // R8 — 우클릭(셸의 메뉴 엔진이 받는다)
  const wr=rc(it('web'));
  it('web').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:cx(wr),clientY:cy(wr)}));
  await frame();
  let tx=menuText()||'';
  R.r8_text=tx.slice(0,200);
  R.r8=tx.includes('열린 창') && tx.includes('T:web#2') && tx.includes('새로 열기') && tx.includes('모두 닫기') && tx.includes('독에서 빼기') && tx.includes('독');
  R.a1_only=!!tx && !tx.includes('칸에 넣기') && !tx.includes('이 화면 주소 복사');
  ESC(); await frame();
  // A2 — 메뉴 키(≣): 초점 든 아이콘에서 → 독 메뉴가 뜨고 **남는다**
  const kb=it('web'); kb.focus();
  kb.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true,cancelable:true})); await frame(); await sleep(30);
  tx=menuText(); R.a2_menukey=!!tx && tx.includes('독에서 빼기') && !tx.includes('칸에 넣기');
  ESC(); await frame();
  // A3 — ⇧F10
  kb.focus(); kb.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true})); await frame(); await sleep(30);
  tx=menuText(); R.a3_shiftf10=!!tx && tx.includes('독에서 빼기');
  ESC(); await frame(); kb.blur();
  // A4 — 손가락 길게 누르기(iOS 는 contextmenu 를 안 낸다) → 550ms 뒤 엔진이 그 자리의 메뉴 — 독 아이콘의 것
  const lr=rc(it('web'));
  it('web').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:cx(lr),clientY:cy(lr),pointerId:21,pointerType:'touch',isPrimary:true}));
  await sleep(640);
  tx=menuText(); R.a4_longpress=!!tx && tx.includes('독에서 빼기') && !tx.includes('칸에 넣기'); R.a4_info=(tx||'(메뉴 없음)').slice(0,60);
  it('web').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:21,pointerType:'touch'}));
  ESC(); await frame();
  // A5 · S1 — 독의 빈 자리(알약 끝) 우클릭 = 독 설정만 · 위치 › 이음매 / 사이드바 아래 · «모양» · «자동으로 가리기» 없음
  let gp=grabPt();
  shelf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:gp[0],clientY:gp[1]})); await frame();
  tx=menuText()||'';
  R.a5_settings=tx.includes('위치') && tx.includes('확대') && tx.includes('독 되돌리기') && !tx.includes('칸에 넣기') && !tx.includes('이 화면 주소 복사');
  R.s1_removed=!!tx && !tx.includes('자동으로 가리기') && !tx.includes('모양');
  const posRow=row('위치'); if(posRow) posRow.click(); await frame();
  const subs=[...document.querySelectorAll('.pn-ctx-sub')].map((m)=>m.textContent).join('|');
  R.s1_sub=subs.includes('이음매') && subs.includes('사이드바 아래'); R.s1_info=subs.slice(0,120);
  ESC(); ESC(); await frame();
  // R9 — 이음매에서 알약 끝을 잡고 곁칸 안쪽 깊이 → 곁칸 아래
  gp=grabPt(); const pr=rc(pane);
  const onHandle=document.elementFromPoint(gp[0],gp[1]); R.hd2_from_handle=!!onHandle && !!onHandle.closest('.pn-dock-handle');
  P('pointerdown',gp[0],gp[1],onHandle||shelf); P('pointermove',gp[0]+20,gp[1]+20); P('pointermove',pr.left+200,pr.bottom-90);
  const pv=grid.querySelector('.pn-dock-preview');
  R.r9_preview=!!pv && pv.dataset.home==='float' && Math.abs(rc(pv).bottom-(pr.bottom-8))<=2;
  R.r9_lifted=root.parentElement===grid && root.classList.contains('moving');
  P('pointerup',pr.left+200,pr.bottom-90); await frame(); await sleep(450);
  const saved=JSON.parse(prefsNow()||'null');
  sr=rc(shelf);
  R.r9_saved=JSON.stringify(saved);
  R.r9=!!saved && saved.home==='float' && root.dataset.home==='float' && root.parentElement===pane
    && Math.abs(sr.bottom-(rc(pane).bottom-8))<=1.5 && Math.abs(cx(sr)-(rc(pane).left+1+pane.clientWidth/2))<=2 && sr.width>sr.height*3;
  R.r9_gone=!grid.querySelector('.pn-dock-preview') && !root.classList.contains('moving');
  // HF1 — 곁칸 아래 독에도 손잡이: 알약 왼쪽 끝 · 세운 막대 · 아이콘 높이 가운데 · 앱 단추가 아니다
  const hf=shelf.querySelector('.pn-dock-handle'); const hfi=hf&&hf.querySelector('i');
  if(hf){ const hr=rc(hf), ir=rc(hfi), f0=rc(shelf.querySelector('.pn-dock-it .pn-dock-ic'));
    R.hf1_info=[Math.round(hr.left-sr.left),Math.round(hr.width),Math.round(hr.height),Math.round(ir.width),Math.round(ir.height),Math.round(cy(ir)-cy(f0)),Math.round(f0.left-hr.right)];
    R.hf1=root.dataset.home==='float' && shelf.firstElementChild===hf && hr.left-sr.left<=4 && hr.right<=f0.left && ir.width>=3 && ir.width<=5 && ir.height>=12 && ir.height<=24
      && Math.abs(cy(ir)-cy(f0))<=1.5 && hf.tagName!=='BUTTON' && !hf.hasAttribute('tabindex') && hf.getAttribute('aria-hidden')==='true' && getComputedStyle(hf).cursor==='grab'; }
  // HF3 — 그 손잡이 위에선 확대하지 않는다(잡으려는 것은 독)
  if(hf){ const hr=rc(hf);
    hf.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx(hr),clientY:cy(hr),pointerType:'mouse'})); await frame(); await sleep(200);
    const s0=sizeNow(); const icw=[...shelf.querySelectorAll('.pn-dock-ic')].map((q)=>rc(q).width);
    R.hf3_info=JSON.stringify(icw.map((x)=>Math.round(x))); R.hf3_no_mag=icw.every((x)=>Math.abs(x-s0)<=0.6);
    shelf.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'})); await frame(); await sleep(200); }
  // R2b — 곁칸 아래 독은 내용 위에 떠 있다: 본문 여백 0 · 맨 아래 입력칸이 있는 앱은 앱 끝에 독 두께만큼 빈 자리 → «태스크 추가» 가 독 위에
  const s9=sizeNow(); const inset=s9+12+6+16; const tkAfter=getComputedStyle(tkPart,'::after').height;
  R.r2b_info=[s9, getComputedStyle(pbody).paddingBottom, tkAfter, Math.round(rc(tkAdd).bottom), Math.round(sr.top)];
  R.r2b=getComputedStyle(pbody).paddingBottom==='0px' && parseFloat(tkAfter)===inset && rc(tkAdd).bottom<=sr.top+0.5;
  // R2c — 목록은 독 밑까지 흐른다: 목록 상자의 바닥 = 곁칸 바닥 · 독 옆 바닥 자리도 목록 · 끝에 독 두께만큼 빈 자리 → 끝까지 굴리면 마지막 줄이 독 위
  tkPart.hidden=true; fPart.hidden=false; dock.sync(); await frame();
  { const fr=rc(fBody), pr2=rc(pane), sr2=rc(shelf); const beside=document.elementFromPoint(pr2.left+6, cy(sr2));
    fBody.scrollTop=fBody.scrollHeight; await frame(); const lr=rc(fLast);
    R.r2c_info=[Math.round(fr.bottom), Math.round(pr2.bottom), getComputedStyle(fBody,'::after').height, Math.round(lr.bottom), Math.round(sr2.top), beside&&beside.className];
    R.r2c=Math.abs(fr.bottom-pr2.bottom)<=1 && fr.bottom>sr2.bottom && parseFloat(getComputedStyle(fBody,'::after').height)===inset && lr.bottom<=sr2.top+0.5 && !!beside && !!beside.closest('.pn-fbody'); }
  fBody.scrollTop=0; fPart.hidden=true; tkPart.hidden=false; dock.sync(); await frame();
  // R10 — 곁칸 폭을 따라 커지고 작아진다(곁칸 폭 = 격자의 --pn-side-w). 헤드리스는 ResizeObserver 가 안 돌아 sync 로 다시 그린다.
  const sizes=[]; const fits=[]; const edge=[];
  for(const wpx of [280,340,420]){
    grid.style.setProperty('--pn-side-w',wpx+'px'); dock.sync(); await frame();
    const sz=sizeNow(); sizes.push(sz);
    //  확대한 몫까지 곁칸 안에 드나 — 가운데 아이콘에 손을 얹어 잰다.
    const kk=rc(it('knowledge').querySelector('.pn-dock-ic'));
    shelf.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx(kk),clientY:cy(kk),pointerType:'mouse'})); await frame(); await sleep(120);
    const a=rc(shelf), p=rc(pane);
    const icons=[...shelf.querySelectorAll('.pn-dock-ic')].map(rc);
    const left=Math.min(a.left,...icons.map((q)=>q.left)), right=Math.max(a.right,...icons.map((q)=>q.right));
    //  크기 공식(lib floatIconSize)은 확대한 몫까지 바깥 여백 8px 안에 들게 잡는다 — 손잡이 몫(HANDLE_FLOAT)을 빼먹으면 이 여백을 먹는다.
    fits.push(left>=p.left+8-1 && right<=p.right-8+1); edge.push([Math.round(left-p.left), Math.round(p.right-right)]);
    if(wpx===340){ R.r10c_shelf_fixed=Math.abs(a.height-(sz+18))<=1; }
    shelf.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'})); await frame(); await sleep(200);
  }
  grid.style.removeProperty('--pn-side-w'); dock.sync(); await frame();
  R.r10_info=JSON.stringify({sizes,fits,edge});
  R.r10=sizes[0]<sizes[1] && sizes[1]<sizes[2] && fits.every(Boolean);
  // R11 — 곁칸 아래에서 경계선 가까이(세로 30%)로 → 이음매, 그 높이
  gp=grabPt(); const sp1=span(); const ty=sp1.top+(sp1.bottom-sp1.top)*0.3;
  const onHf=document.elementFromPoint(gp[0],gp[1]); R.hf2_from_handle=root.dataset.home==='float' && !!onHf && !!onHf.closest('.pn-dock-handle');
  P('pointerdown',gp[0],gp[1],shelf); P('pointermove',gp[0]-20,gp[1]-20); P('pointermove',seamX()+10,ty);
  const pv2=grid.querySelector('.pn-dock-preview');
  R.r11_preview=!!pv2 && pv2.dataset.home==='seam' && Math.abs(cx(rc(pv2))-seamX())<=1.5;
  //  곁칸 안에 붙어 있던 독이 끄는 동안엔 곁칸의 부모로 옮겨 붙는다 — 곁칸 테두리(overflow: clip)를 넘어 경계선까지 따라온다.
  R.r11_lifted=root.parentElement===grid && root.classList.contains('moving') && rc(shelf).left<rc(pane).left;
  P('pointerup',seamX()+10,ty); await frame(); await sleep(450);
  const s11=JSON.parse(prefsNow()||'null'); sr=rc(shelf);
  R.r11_info=[JSON.stringify(s11), Math.round(cy(sr)), Math.round(ty)];
  R.r11=!!s11 && s11.home==='seam' && Math.abs(Number(s11.at)-0.3)<=0.02 && root.dataset.home==='seam' && root.parentElement===grid
    && Math.abs(cx(sr)-seamX())<=1 && Math.abs(cy(sr)-Math.max(ty, sp1.top+8+sr.height/2))<=2;
  await setPrefs();
  // R12 — 첫 고정 아이콘(프로젝트)을 지식과 웹 사이로(이음매는 세로)
  const a0=rc(it('tasks').querySelector('.pn-dock-ic')); const kn=rc(it('knowledge')); const wb=rc(it('web'));
  P('pointerdown',cx(a0),cy(a0),it('tasks')); P('pointermove',cx(a0),cy(a0)+12); P('pointermove',cx(a0),(cy(kn)+cy(wb))/2);
  R.r12_caret=!!shelf.querySelector('.pn-dock-caret:not([hidden])');
  P('pointerup',cx(a0),(cy(kn)+cy(wb))/2); await frame(); await sleep(60);
  R.r12_pins=pinsNow(); R.r12=pinsNow()==='["files","knowledge","tasks","web","timeline"]';
  // R13 — 타임라인(안 떠 있음)을 옆으로 끌어내면 고정이 풀리고 독에서 사라진다
  const tl=rc(it('timeline').querySelector('.pn-dock-ic'));
  P('pointerdown',cx(tl),cy(tl),it('timeline')); P('pointermove',cx(tl)-20,cy(tl)); P('pointermove',cx(tl)-140,cy(tl));
  R.r13_badge=!!document.querySelector('.pn-dock-ghost.out');
  P('pointerup',cx(tl)-140,cy(tl)); await frame(); await sleep(450);
  const pins2=JSON.parse(pinsNow()||'[]');
  R.r13=!pins2.includes('timeline') && !it('timeline') && !document.querySelector('.pn-dock-ghost'); R.r13_pins=JSON.stringify(pins2);
  // ── 끌기 방어 — 떼는 순간을 못 본 끌기는 없던 일(탭 끌기 pane-tabdrag 와 같은 방어). 묶음마다 알려진 자리에서 시작하고 예외는 묶음 안에서 받는다. ──
  try{
    await setPrefs();
    // D1 — 독 끌기 중 버튼이 떼어진 채 움직였다(액자·창 밖에서 놓았다)
    const p0=prefsNow(); const g1=grabPt();
    P('pointerdown',g1[0],g1[1],shelf); P('pointermove',g1[0]+30,g1[1]+30);
    R.d1_started=root.classList.contains('moving') && !!grid.querySelector('.pn-dock-preview');
    Pb0(pr.left+200,pr.bottom-90); await frame();
    R.d1_cancelled=!root.classList.contains('moving') && !grid.querySelector('.pn-dock-preview') && !document.documentElement.classList.contains('pn-dock-dragging');
    P('pointerup',pr.left+200,pr.bottom-90); await frame(); await sleep(60);
    R.d1_nothing_saved=prefsNow()===p0 && root.dataset.home==='seam';
  }catch(e){R.err_d1=String(e&&e.message||e);}
  await clearDrag();
  try{
    // D4 — 다른 포인터(pointerId 3)의 이동은 모른 척 · D3 — 창을 떠났다(⌘-Tab) → 없던 일
    const p0=prefsNow(); const g1=grabPt();
    P('pointerdown',g1[0],g1[1],shelf); P('pointermove',g1[0]+30,g1[1]+30);
    const tf=root.style.transform;
    window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:pr.left+250,clientY:pr.bottom-60,button:0,buttons:1,pointerId:3,pointerType:'mouse'}));
    R.d4_other_pointer=!!tf && root.style.transform===tf;
    window.dispatchEvent(new Event('blur')); await frame();
    R.d3_blur=!root.classList.contains('moving') && !grid.querySelector('.pn-dock-preview') && !document.documentElement.classList.contains('pn-dock-dragging');
    P('pointerup',pr.left+250,pr.bottom-60); await frame(); await sleep(60);
    R.d3_nothing_saved=prefsNow()===p0 && root.dataset.home==='seam';
  }catch(e){R.err_d3=String(e&&e.message||e);}
  await clearDrag();
  try{
    // D2 — 아이콘 끌기 중 버튼이 떼어졌다
    const q0=pinsNow(); const fi=rc(it('files').querySelector('.pn-dock-ic'));
    P('pointerdown',cx(fi),cy(fi),it('files')); P('pointermove',cx(fi),cy(fi)+20);
    R.d2_started=!!document.querySelector('.pn-dock-ghost');
    Pb0(cx(fi),cy(fi)+60); await frame(); await sleep(60);
    R.d2_cancelled=!document.querySelector('.pn-dock-ghost') && !root.querySelector('.pn-dock-it.lifted') && !document.documentElement.classList.contains('pn-dock-dragging');
    P('pointerup',cx(fi),cy(fi)+60); await frame(); await sleep(60);
    R.d2_nothing_saved=pinsNow()===q0;
  }catch(e){R.err_d2=String(e&&e.message||e);}
  await clearDrag();
  try{
    // D6 — 끌기는 한 번에 하나: 아이콘을 누른 채 알약 끝을 또 눌러도 독 끌기는 시작되지 않는다
    const p0=prefsNow(), q0=pinsNow();
    const fi2=rc(it('files').querySelector('.pn-dock-ic')); const g2=grabPt();
    P('pointerdown',cx(fi2),cy(fi2),it('files')); P('pointerdown',g2[0],g2[1],shelf); P('pointermove',g2[0]+30,g2[1]+30);
    R.d6_one_drag=!root.classList.contains('moving') && !grid.querySelector('.pn-dock-preview');
    ESC(); await frame(); await sleep(60);
    R.d6_clean=!document.querySelector('.pn-dock-ghost') && !document.documentElement.classList.contains('pn-dock-dragging') && pinsNow()===q0 && prefsNow()===p0;
  }catch(e){R.err_d6=String(e&&e.message||e);}
  await clearDrag();
  // R14 — [더보기](이음매): 알약 옆 곁칸 쪽으로 부풀어, 곁칸 안에
  calls.length=0;
  root.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(260);
  const more=grid.querySelector('.pn-dock-more');
  const mtext=more?more.textContent:'';
  R.r14_open=!!more && more.classList.contains('open') && mtext.includes('사이드바 앱') && mtext.includes('타임라인') && !mtext.includes('새 탭으로 여는 앱') && !more.querySelector('a.pn-dock-tile');
  if(more){ const mr=rc(more), sr2=rc(shelf), p2=rc(pane), s2=span();
    R.r14_beside=mr.left>=sr2.right-0.5 && mr.left>=p2.left && mr.right<=p2.right+0.5 && mr.top>=s2.top-0.5 && mr.bottom<=s2.bottom+0.5;
    R.r14_info=[Math.round(mr.left),Math.round(mr.right),Math.round(sr2.right),Math.round(p2.left),Math.round(p2.right)]; }
  await sleep(120);
  R.r14d_attach=!!more && more.textContent.includes('이 세션에 붙이기') && more.textContent.includes('메모');
  const q=more.querySelector('.pn-dock-more-q'); q.value='타임'; q.dispatchEvent(new Event('input',{bubbles:true}));
  const tiles=[...more.querySelectorAll('.pn-dock-tile')].map(t=>t.textContent.trim());
  R.r14_filter=tiles[0]==='타임라인' && !tiles.includes('자료') && !tiles.includes('웹'); R.r14_tiles=JSON.stringify(tiles);
  q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await frame(); await sleep(260);
  R.r14_enter=JSON.stringify(calls)==='[["open","timeline"]]' && !grid.querySelector('.pn-dock-more');
  R.r14_info2=JSON.stringify(calls);
  // R15
  root.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(60);
  grid.querySelector('.pn-dock-more').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sleep(260);
  R.r15=!grid.querySelector('.pn-dock-more');
  // H2 — 곁칸 아래 독의 [더보기]는 곁칸 안, 독 위에
  try{
    await setPrefs({home:'float'});
    root.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(260);
    const mp=pane.querySelector('.pn-dock-more'); const p3=rc(pane), d3=rc(shelf);
    R.h2_info=mp?[Math.round(rc(mp).left-p3.left),Math.round(p3.right-rc(mp).right),Math.round(d3.top-rc(mp).bottom)]:'(창 없음)';
    R.h2_float=!!mp && rc(mp).left>=p3.left && rc(mp).right<=p3.right && rc(mp).bottom<=d3.top;
    if(mp) mp.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sleep(260);
  }catch(e){R.err_h2=String(e&&e.message||e);}
  await setPrefs();
  // R16 — 탭 줄 높이 = 세션 머리줄 높이
  const hb=rc(document.getElementById('head')); const tb=rc(pane.querySelector('.pn-tabbar'));
  R.r16_heights=[Math.round(hb.height*10)/10, Math.round(tb.height*10)/10, innerWidth];
  R.r16=innerWidth>=901 && Math.abs(hb.bottom-tb.bottom)<=0.5 && Math.abs(hb.height-tb.height)<=0.5;
  // C1 — 어느 자리에서도 틀(탭 칸 흉내, overflow:auto)에 스크롤이 안 생긴다
  const noScroll=()=>wrap.scrollHeight<=wrap.clientHeight && wrap.scrollWidth<=wrap.clientWidth;
  const c1a=noScroll(); await setPrefs({home:'float'}); const c1b=noScroll(); await setPrefs();
  R.c1_info=[c1a,c1b,wrap.scrollWidth,wrap.clientWidth,wrap.scrollHeight,wrap.clientHeight]; R.c1_no_scroll=c1a && c1b;
  // ── 흔들기(E1) · 고정 줄로 끌어오기(E2) — 떠 있기만 한 앱(타임라인: R13 에서 뺐고 R14 에서 열었다). 이음매는 세로 ──
  try{
    await setPrefs(); await setPins(['files','knowledge','tasks','web']);
    const q1=pinsNow(); const tlA=it('timeline');
    R.e_case=!!tlA && !tlA.classList.contains('pin') && tlA.classList.contains('run');
    const tAr=rc(tlA.querySelector('.pn-dock-ic'));
    P('pointerdown',cx(tAr),cy(tAr),tlA); P('pointermove',cx(tAr),cy(tAr)-8); P('pointerup',cx(tAr),cy(tAr)-8); await frame(); await sleep(60);
    R.e1_wiggle=pinsNow()===q1; R.e1_info=pinsNow();
    await setPins(['files','knowledge','tasks','web']);
    const tkr=rc(it('tasks')), wbr=rc(it('web')); const tlB=it('timeline'); const tBr=rc(tlB.querySelector('.pn-dock-ic'));
    P('pointerdown',cx(tBr),cy(tBr),tlB); P('pointermove',cx(tBr),cy(tBr)-20); P('pointermove',cx(tBr),(cy(tkr)+cy(wbr))/2);
    P('pointerup',cx(tBr),(cy(tkr)+cy(wbr))/2); await frame(); await sleep(60);
    R.e2_info=pinsNow(); R.e2_pinned=pinsNow()==='["files","knowledge","tasks","timeline","web"]';
  }catch(e){R.err_e=String(e&&e.message||e);}
  await clearDrag();
  // ── 초점(F1 · F2 · F3) ──
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
    await setPrefs(); const hasRefresh=typeof Dock.refreshDocks==='function';
    localStorage.setItem(PK, JSON.stringify({home:'float',at:'0.50',mag:'1'}));
    if(hasRefresh) Dock.refreshDocks(); await frame();
    R.g1_follow=hasRefresh && root.dataset.home==='float' && root.parentElement===pane;
  }catch(e){R.err_g=String(e&&e.message||e);}
  await setPrefs();
  // H1 — [더보기]가 열린 채 자리가 바뀌었다(다른 창에서 사이드바 아래로) → 붙는 곳이 바뀌니 옛 창은 닫힌다(남지 않는다)
  try{
    root.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(120);
    R.h1_case=!!grid.querySelector('.pn-dock-more.open');
    await setPrefs({home:'float'}); await sleep(260);
    R.h1_closed=root.dataset.home==='float' && !document.querySelector('.pn-dock-more.open') && root.querySelector('.pn-dock-more-btn').getAttribute('aria-expanded')==='false';
  }catch(e){R.err_h1=String(e&&e.message||e);}
  await setPrefs();
  // I1 — 이름표: 이음매는 세션 쪽(알약 왼쪽), 곁칸 아래는 곁칸 안(긴 이름도 안 잘린다)
  const fApp=APPS.find(a=>a.type==='files'); const oldName=fApp.name;
  try{
    const f1=it('files'); f1.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false,pointerType:'mouse'})); await frame();
    const tipEl=document.querySelector('.pn-dock-tip'); const t1=rc(tipEl), s1=rc(shelf);
    R.i1_seam=!tipEl.hidden && tipEl.dataset.side==='left' && t1.right<=s1.left && tipEl.parentElement===grid;
    f1.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'}));
    fApp.name='자료 — 이름이 꽤 긴 앱 이름표';
    await setPrefs({home:'float'});
    const f2=it('files'); f2.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false,pointerType:'mouse'})); await frame();
    const tip2=document.querySelector('.pn-dock-tip'); const t2=rc(tip2), p4=rc(pane);
    R.i1_info=[tip2.dataset.side, Math.round(t2.left-p4.left), Math.round(p4.right-t2.right), tip2.textContent];
    R.i1_float=!tip2.hidden && tip2.dataset.side==='top' && tip2.textContent===fApp.name && t2.left>=p4.left+3.5 && t2.right<=p4.right-3.5;
    f2.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'}));
  }catch(e){R.err_i=String(e&&e.message||e);}
  fApp.name=oldName; await setPrefs();
  // B1 — 프로젝트 없는 세션 화면(태스크·자료·지식을 못 고른다)에서 웹 «독에서 빼기» → 안 보이는 고정은 남는다
  try{
    localStorage.removeItem(PINK);                                        // 정한 적 없음 = 기본 다섯
    for(const a of APPS) if(['tasks','files','knowledge'].includes(a.type)) a.pickable=false;
    dock.sync(); await frame();
    const wB=it('web'); const wBr=rc(wB);
    wB.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:cx(wBr),clientY:cy(wBr)})); await frame();
    const unpin=row('독에서 빼기'); R.b1_case=!!unpin;
    if(unpin) unpin.click(); await frame(); await sleep(40);
    R.b1_info=pinsNow(); R.b1_hidden_kept=pinsNow()==='["tasks","files","knowledge","timeline"]';
  }catch(e){R.err_b1=String(e&&e.message||e);}
  ESC(); for(const a of APPS) if(['tasks','files','knowledge'].includes(a.type)) a.pickable=true;
  dock.sync(); await frame();
  // B7 — «독 되돌리기» = 이음매 가운데 + 고정 목록을 «적은 적 없음» 으로
  try{
    await setPins(['web','files']); await setPrefs({home:'float', at:'0.30'});
    const g7=grabPt();
    shelf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:g7[0],clientY:g7[1]})); await frame();
    const rs=row('독 되돌리기'); if(rs) rs.click(); await frame(); await sleep(40);
    const pd=JSON.parse(prefsNow()||'null');
    R.b7_info=[pinsNow(), JSON.stringify(pd)];
    R.b7_reset=!!rs && pinsNow()===null && !!pd && pd.home==='seam' && pd.at==='0.50' && pd.mag==='1' && root.dataset.home==='seam';
  }catch(e){R.err_b7=String(e&&e.message||e);}
  ESC(); await frame();
  // A6 — 좁은 폭(서랍): 곁칸 아래로 서고, [더보기] 우클릭엔 메뉴가 없다 — 곁칸 빈 자리 메뉴도, 브라우저 메뉴도(엔진이 막는다)
  try{
    narrowNow=true; dock.sync(); await frame();
    const mbN=root.querySelector('.pn-dock-more-btn'); const mbr=rc(mbN);
    const ce=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:cx(mbr),clientY:cy(mbr)}); mbN.dispatchEvent(ce); await frame();
    R.a6_narrow_none=root.classList.contains('narrow') && root.dataset.home==='float' && root.parentElement===pane && !document.querySelector('.pn-ctx') && ce.defaultPrevented;
    R.hd5_narrow_no_handle=!shelf.querySelector('.pn-dock-handle');
  }catch(e){R.err_a6=String(e&&e.message||e);}
  ESC(); narrowNow=false; dock.sync(); await frame();
  // R17 — 이음매가 없으면(카드 모드 · 접힘 — 셸이 null 을 준다) 곁칸 아래
  seamOn=false; dock.sync(); await frame();
  R.r17_noseam=root.dataset.home==='float' && root.parentElement===pane;
  seamOn=true; dock.sync(); await frame();
  R.r17_back=root.dataset.home==='seam' && root.parentElement===grid;
  // R17b — 자리바꿈(곁칸이 왼쪽 · sw-left): 분할선이 곁칸 오른쪽 — 알약이 그 위에, 이름표는 세션 쪽(오른쪽)
  try{
    grid.classList.add('sw-left'); dock.sync(); await frame();
    const sb=rc(shelf);
    R.r17b_info=[Math.round(cx(sb)), Math.round(seamX()), root.dataset.side];
    R.r17b_swap=root.dataset.home==='seam' && Math.abs(cx(sb)-seamX())<=1 && root.dataset.side==='left' && rc(pane).right<=seamX()+0.5;
    const f3=it('files'); f3.dispatchEvent(new PointerEvent('pointerenter',{bubbles:false,pointerType:'mouse'})); await frame();
    const tip3=document.querySelector('.pn-dock-tip');
    R.r17b_tip=!tip3.hidden && tip3.dataset.side==='right' && rc(tip3).left>=rc(shelf).right;
    f3.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'}));
  }catch(e){R.err_r17b=String(e&&e.message||e);}
  grid.classList.remove('sw-left'); dock.sync(); await frame();
  // FV — 곁칸 전체보기(이음매 없음 · 넓은 곁칸): 바닥을 따라 좌우로 끌어 옮긴다(원준 10-07)
  try{
    const keep=prefsNow();
    localStorage.setItem(PK,JSON.stringify({home:'seam',at:'0.50',mag:'1'})); Dock.refreshDocks();
    seamOn=false; grid.style.setProperty('--pn-side-w','900px'); dock.sync(); await frame();
    const pw=()=>rc(pane); let a=rc(shelf);
    R.fv1_info=[Math.round(cx(a)-cx(pw())), root.dataset.home];
    R.fv1_center=root.dataset.home==='float' && Math.abs(cx(a)-cx(pw()))<=1.5;
    // FV2 — 손잡이를 잡고 왼쪽으로 150 → 윤곽이 따라오고, 놓으면 그 자리에 선다 · 서는 곳(home)은 안 바뀐다
    let g2=grabPt(); const c0=cx(a);
    const h2=document.elementFromPoint(g2[0],g2[1]);
    P('pointerdown',g2[0],g2[1],h2||shelf); P('pointermove',g2[0]-20,g2[1]-4); P('pointermove',g2[0]-150,g2[1]-10);
    const pv2=grid.querySelector('.pn-dock-preview');
    R.fv2_preview=!!pv2 && pv2.dataset.home==='float' && Math.abs(cx(rc(pv2))-(c0-150))<=3 && Math.abs(rc(pv2).bottom-(pw().bottom-8))<=2;
    R.fv2_pv_info=pv2?[Math.round(cx(rc(pv2))),Math.round(c0-150)]:null;
    P('pointerup',g2[0]-150,g2[1]-10); await frame(); await sleep(450);
    let sv=JSON.parse(prefsNow()||'null'); a=rc(shelf);
    R.fv2_info=[JSON.stringify(sv), Math.round(cx(a)), Math.round(c0-150)];
    R.fv2_moved=!!sv && Number(sv.fx)<0.5 && Math.abs(cx(a)-(c0-150))<=6 && root.parentElement===pane && Math.abs(a.bottom-(pw().bottom-8))<=1.5;
    R.fv2_home_kept=!!sv && sv.home==='seam';
    // FV3 — 왼쪽 끝 너머로 끌면 끝에서 멈춘다 · 끝에서 확대해도 곁칸 안(바깥 여백 8px)
    g2=grabPt(); P('pointerdown',g2[0],g2[1],document.elementFromPoint(g2[0],g2[1])||shelf); P('pointermove',g2[0]-30,g2[1]); P('pointermove',pw().left-300,g2[1]);
    P('pointerup',pw().left-300,g2[1]); await frame(); await sleep(450);
    sv=JSON.parse(prefsNow()||'null');
    const f0=rc(shelf.querySelector('.pn-dock-it .pn-dock-ic'));
    shelf.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:cx(f0),clientY:cy(f0),pointerType:'mouse'})); await frame(); await sleep(120);
    a=rc(shelf); const ics=[...shelf.querySelectorAll('.pn-dock-ic')].map(rc); const lft=Math.min(a.left,...ics.map((q)=>q.left));
    R.fv3_info=[sv&&sv.fx, Math.round(lft-pw().left), Math.round(Math.max(...ics.map((q)=>q.width)))];
    R.fv3_edge=!!sv && Number(sv.fx)===0 && lft>=pw().left+8-1 && lft<=pw().left+60 && Math.max(...ics.map((q)=>q.width))>sizeNow()*1.3;
    shelf.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerType:'mouse'})); await frame(); await sleep(200);
    // FV4 — [더보기] · 이름표는 옮긴 독을 따라간다(곁칸 안)
    const mbv=root.querySelector('.pn-dock-more-btn'); mbv.click(); await frame(); await sleep(60);
    const pnl=pane.querySelector('.pn-dock-more'); const mr=pnl&&rc(pnl);
    R.fv4_more=!!pnl && mr.left>=pw().left && mr.right<=pw().right && cx(rc(mbv))>=mr.left && cx(rc(mbv))<=mr.right && cx(mr)<cx(pw())-60 && mr.bottom<=rc(shelf).top;
    mbv.click(); await frame(); await sleep(220);
    // FV5 — 우클릭 › «사이드바 아래 가운데로»(옮겨 둔 독에만 있다) → 가운데
    g2=grabPt(); shelf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:g2[0],clientY:g2[1]})); await frame();
    const rowC=row('사이드바 아래 가운데로'); R.fv5_row=!!rowC; if(rowC) rowC.click(); await frame(); await sleep(60); ESC(); await frame();
    sv=JSON.parse(prefsNow()||'null'); a=rc(shelf);
    R.fv5_center=!!sv && Number(sv.fx)===0.5 && Math.abs(cx(a)-cx(pw()))<=1.5;
    g2=grabPt(); shelf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:g2[0],clientY:g2[1]})); await frame();
    R.fv5_row_gone=!!menuText() && !row('사이드바 아래 가운데로'); ESC(); await frame();
    // FV6 — 오른쪽으로 옮겼다가 가운데 근처(10px)에 놓으면 가운데로 붙는다
    g2=grabPt(); P('pointerdown',g2[0],g2[1],document.elementFromPoint(g2[0],g2[1])||shelf); P('pointermove',g2[0]+30,g2[1]); P('pointermove',g2[0]+200,g2[1]); P('pointerup',g2[0]+200,g2[1]); await frame(); await sleep(450);
    sv=JSON.parse(prefsNow()||'null'); R.fv6_right=!!sv && Number(sv.fx)>0.5 && cx(rc(shelf))>cx(pw())+150;
    g2=grabPt(); const back=cx(pw())+10-cx(rc(shelf));
    P('pointerdown',g2[0],g2[1],document.elementFromPoint(g2[0],g2[1])||shelf); P('pointermove',g2[0]-30,g2[1]); P('pointermove',g2[0]+back,g2[1]); P('pointerup',g2[0]+back,g2[1]); await frame(); await sleep(450);
    sv=JSON.parse(prefsNow()||'null'); R.fv6_snap=!!sv && Number(sv.fx)===0.5 && Math.abs(cx(rc(shelf))-cx(pw()))<=1.5; R.fv6_info=[sv&&sv.fx, Math.round(cx(rc(shelf))-cx(pw()))];
    // FV7 — 좁은 곁칸(340)에선 알약이 폭을 채운다: 왼쪽 끝을 골라 뒀어도 가운데 · 좌우로 끌어도 고른 자리(fx)는 그대로
    localStorage.setItem(PK,JSON.stringify({home:'seam',at:'0.50',fx:'0.00',mag:'1'})); Dock.refreshDocks();
    grid.style.removeProperty('--pn-side-w'); dock.sync(); await frame();
    a=rc(shelf); R.fv7_center=root.dataset.home==='float' && Math.abs(cx(a)-cx(pw()))<=1.5;
    g2=grabPt(); P('pointerdown',g2[0],g2[1],document.elementFromPoint(g2[0],g2[1])||shelf); P('pointermove',g2[0]+10,g2[1]-6); P('pointermove',g2[0]+40,g2[1]-10); P('pointerup',g2[0]+40,g2[1]-10); await frame(); await sleep(450);
    sv=JSON.parse(prefsNow()||'null'); R.fv7_kept=!!sv && Number(sv.fx)===0 && sv.home==='seam'; R.fv7_info=JSON.stringify(sv);
    // FV9 — 서랍(좁은 폭)은 넓은 화면에서 고른 자리와 무관하게 가운데(거기선 끌 수도 되돌릴 수도 없다)
    localStorage.setItem(PK,JSON.stringify({home:'seam',at:'0.50',fx:'0.00',mag:'1'})); Dock.refreshDocks();
    grid.style.setProperty('--pn-side-w','900px'); narrowNow=true; dock.sync(); await frame();
    a=rc(shelf); R.fv9_info=Math.round(cx(a)-cx(pw())); R.fv9_narrow_center=root.classList.contains('narrow') && Math.abs(cx(a)-cx(pw()))<=1.5;
    narrowNow=false; dock.sync(); await frame();
    R.fv9_wide_left=cx(rc(shelf))<cx(pw())-150;
    // FV10 — 이음매가 있는 넓은 곁칸의 «사이드바 아래» 독도 좌우로 옮긴다 — 서는 곳(home=float)과 좌우 자리를 함께 적는다
    localStorage.setItem(PK,JSON.stringify({home:'float',at:'0.50',mag:'1'})); Dock.refreshDocks();
    seamOn=true; dock.sync(); await frame();
    g2=grabPt(); const c10=cx(rc(shelf));
    P('pointerdown',g2[0],g2[1],document.elementFromPoint(g2[0],g2[1])||shelf); P('pointermove',g2[0]+30,g2[1]); P('pointermove',g2[0]+160,g2[1]); P('pointerup',g2[0]+160,g2[1]); await frame(); await sleep(450);
    sv=JSON.parse(prefsNow()||'null'); R.fv10_info=[JSON.stringify(sv), Math.round(cx(rc(shelf))-c10)];
    R.fv10_seam_float=!!sv && sv.home==='float' && Number(sv.fx)>0.5 && root.dataset.home==='float' && Math.abs(cx(rc(shelf))-(c10+160))<=6;
    // FV11 — 이음매에 선 독의 메뉴엔 «사이드바 아래 가운데로» 가 없다(눌러도 보이는 일이 없다)
    localStorage.setItem(PK,JSON.stringify({home:'seam',at:'0.50',fx:'0.90',mag:'1'})); Dock.refreshDocks(); await frame();
    g2=grabPt(); shelf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:g2[0],clientY:g2[1]})); await frame();
    R.fv11_no_row=root.dataset.home==='seam' && !!menuText() && !row('사이드바 아래 가운데로'); ESC(); await frame();
    grid.style.removeProperty('--pn-side-w'); seamOn=false; dock.sync(); await frame();
    // FV8 — 이음매가 돌아오면 다시 이음매(전체보기에서 옮긴 것은 좌우 자리뿐)
    seamOn=true; dock.sync(); await frame();
    R.fv8_seam_back=root.dataset.home==='seam' && root.parentElement===grid;
    if(keep===null) localStorage.removeItem(PK); else localStorage.setItem(PK,keep); Dock.refreshDocks();
  }catch(e){R.err_fv=String(e&&e.stack||e);}
  seamOn=true; grid.style.removeProperty('--pn-side-w'); dock.sync(); await frame();
  // R17c — 곁칸이 접히면(폭 0) 독도 여백도 없다 · R18 걷으면 흔적이 없다
  grid.style.setProperty('--pn-side-w','0px'); pane.style.width='0px'; pane.style.borderLeftWidth='0px'; dock.sync(); await frame();
  R.r17c=root.hidden && getComputedStyle(pbody).paddingBottom==='0px' && getComputedStyle(tkPart,'::after').height==='0px';
  dock.destroy();
  R.destroyed=!document.querySelector('.pn-dock') && !document.querySelector('.pn-dock-tip');
  grid.style.removeProperty('--pn-side-w'); pane.style.width=''; pane.style.borderLeftWidth='';
  // R19 — 붙이기 수단이 없는 게이트웨이(옛 판): 독은 쓰고, [더보기]에 «이 세션에 붙이기» 구획이 없다
  const host2={...host}; delete host2.attach;
  const dock2=Dock.mountDock(host2); await frame(); await sleep(40);
  document.querySelector('.pn-dock-more-btn').click(); await frame(); await sleep(200);
  const m2=document.querySelector('.pn-dock-more');
  R.r19=!!m2 && m2.textContent.includes('사이드바 앱') && !m2.textContent.includes('이 세션에 붙이기');
  dock2.destroy();
  // R20 — 붙은 앱 칸은 그 앱의 얼굴로 선다(#4592): 얼굴이 있으면 그 그림 · 그 색, 없으면(옛 셸 · 앱이 여럿) 종류의 기본(네모 넷)
  try{
    const APPS20=[...APPS,{type:'sessapp',name:'붙은 앱',glyph:'apps',hint:'',multi:false,pickable:false}];
    const st20={tabs:[{key:'files',type:'files'},{key:'sessapp',type:'sessapp'}]};
    let face20='deck';
    const host20={...host, apps:()=>APPS20, tabs:()=>st20.tabs, act:()=>'files', title:(k)=>k==='sessapp'?'장표 수정':'T:'+k, face:(k)=>k==='sessapp'?face20:null};
    const dock20=Dock.mountDock(host20); await frame(); await sleep(40);
    const it=()=>document.querySelector('.pn-dock-it[data-type="sessapp"]');
    const dOf=(b)=>b&&b.querySelector('.v2-gi-glyph').getAttribute('d'); const sOf=(b)=>b&&b.querySelector('.v2-gi-glyph').getAttribute('stroke');
    const appsD='M4 4h6v6H4z';
    R.r20_face=!!it() && !dOf(it()).startsWith(appsD) && dOf(it())===Dock.iconPath('deck') && sOf(it())==='var(--gi-c-deck)' && it().getAttribute('style').includes('--gi-c-deck') && it().getAttribute('aria-label').startsWith('장표 수정');
    R.r20_info={d:String(dOf(it())).slice(0,24),s:sOf(it()),st:it()&&it().getAttribute('style')};
    face20=null; dock20.sync(); await frame(); await sleep(40);
    R.r20_back=!!it() && dOf(it()).startsWith(appsD) && sOf(it())==='var(--gi-c-liv)';
    face20='deck'; dock20.sync(); await frame(); await sleep(40);
    R.r20_again=!!it() && dOf(it())===Dock.iconPath('deck');
    const host21={...host20}; delete host21.face; dock20.destroy();
    const dock21=Dock.mountDock(host21); await frame(); await sleep(40);
    R.r20_nohost=!!it() && dOf(it()).startsWith(appsD);
    dock21.destroy();
  }catch(e){R.err_r20=String(e&&e.message||e);}
  // D5 — 끄는 중에 독이 걷혔다(탭을 닫았다) → 놓아도 아무것도 안 적는다 · 조각이 안 남는다
  try{
    await setPins(['files','knowledge','tasks','web']);
    const q5=pinsNow();
    const dock3=Dock.mountDock(host2); await frame(); await sleep(40);
    const f5=document.querySelector('.pn-dock-it[data-type="files"]'); const f5r=rc(f5.querySelector('.pn-dock-ic'));
    P('pointerdown',cx(f5r),cy(f5r),f5); P('pointermove',cx(f5r),cy(f5r)+20); P('pointermove',cx(f5r)-150,cy(f5r)+20);
    R.d5_started=!!document.querySelector('.pn-dock-ghost');
    dock3.destroy();
    P('pointerup',cx(f5r)-150,cy(f5r)+20); await frame(); await sleep(60);
    R.d5_nothing=R.d5_started && pinsNow()===q5 && !document.querySelector('.pn-dock-ghost') && !document.documentElement.classList.contains('pn-dock-dragging');
  }catch(e){R.err_d5=String(e&&e.message||e);}
  }catch(e){R.error=String(e&&e.stack||e);}
  document.getElementById('out').textContent='RESULT '+JSON.stringify(R)+' ENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "pane-dock-", virtualTimeBudget: 30000, args: ["--window-size=1400,900"] });
const m = /RESULT (\{.*\}) ENDRESULT/s.exec(dom);
if (!m) { const out = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom); console.error("FAIL  결과를 못 받았다 — #out: " + (out ? out[1].slice(0, 1500) : "(없음)") + " · 받은 DOM " + dom.length + "자"); process.exit(1); }
const R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
let pass = 0, fail = 0;
const check = (cond, n, info = "") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n}${info ? " — " + info : ""}`); } };
if (R.error) { console.error("FAIL  페이지 스크립트가 넘어졌다 — " + R.error); process.exit(1); }
check(R.r1, "R1 기본 = 이음매 — 세션과 곁칸 사이 분할선 한가운데 · 세로 구간 가운데 · 곁칸의 부모(.pn-body)에 붙은 세로 알약", JSON.stringify(R.r1_info));
{
  //  GL 은 표(web/lib/icon-paths.ts)의 글자 그대로와 견준다.
  const ICON_SRC = readFileSync(path.join(ROOT, "web/lib/icon-paths.ts"), "utf8");
  const want = (k) => (new RegExp("^  " + k + ": '([^']+)'", "m").exec(ICON_SRC) || [])[1] || "(표에 없음)";
  check(R.gl_tasks === want("proj"), "GL1 독의 「프로젝트」 타일 = 프로젝트 과녁(proj, #4233)", String(R.gl_tasks).slice(0, 40));
  check(R.gl_more === want("apps") && R.gl_more !== want("grid"), "GL2 독의 [모든 앱] 타일 = 각진 사각 넷(apps), 둥근 사각(grid)이 아니다(#4233)", String(R.gl_more).slice(0, 40));
}
check(R.r1b_nogrip, "R1b 손잡이(⋮⋮) · 자동 가리기 띠가 없다(원준 10-01 «바닥 왼쪽 탭 … 없애줘»)");
check(R.r2, "R2 이음매 독은 아무도 안 비킨다 — 곁칸 본문 여백 0 · «태스크 추가» 가 곁칸 바닥에");
check(R.hd1, "HD1 이음매 독 맨 위에 손잡이 — 첫 아이콘 위 · 경계선 한가운데의 짧은 가로 막대 · 잡는 손 모양 · 앱 단추가 아니다(탭 순서 밖)", JSON.stringify(R.hd1_info));
check(R.hd4_no_mag, "HD4 손잡이 위에선 확대하지 않는다 — 잡으려는 것은 독이지 앱이 아니다", R.hd4_info);
check(R.r3, "R3 점 = 떠 있는 탭 수, 켜진 앱만 켜짐");
check(R.r4, "R4 안 떠 있는 앱을 누르면 연다 · 튀어 오른다");
check(R.r5, "R5 떠 있는 앱은 보여 주고, 켜진 앱을 또 누르면 다음 인스턴스", R.r5_info);
check(R.r6, "R6 ⌥-클릭 = 하나 더");
check(R.r7_mag_on, "R7a 확대가 켜져 있다(가는 포인터 · 동작 줄이기 꺼짐)");
check(R.r7, "R7 확대(이음매는 세로 축) — 마우스 밑은 ≈1.6배, 먼 아이콘은 그대로", JSON.stringify(R.r7_info));
check(R.r7c_shelf_fixed, "R7c 확대해도 알약 폭은 그대로 — 아이콘이 양옆으로 솟는다(macOS)");
check(R.r7_settles, "R7b 손을 떼면 가라앉는다");
check(R.r8, "R8 우클릭 — 열린 창 · 새로 열기 · 모두 닫기 · 독에서 빼기 · 독 설정", R.r8_text);
check(R.a1_only, "A1 우클릭 = 독 행만 — 곁칸 빈 자리 메뉴(칸에 넣기)·공통 행을 잇지 않는다");
check(R.a2_menukey, "A2 메뉴 키(≣)로 연 독 메뉴가 남는다");
check(R.a3_shiftf10, "A3 ⇧F10 도 같다");
check(R.a4_longpress, "A4 손가락 길게 누르기 = 독 메뉴", R.a4_info);
check(R.a5_settings, "A5 독의 빈 자리(알약 끝) 우클릭 = 독 설정만");
check(R.s1_removed, "S1 독 설정에 «모양» · «자동으로 가리기» 가 없다(막대 · 가리기는 걷었다)");
check(R.s1_sub, "S1b 위치 › 이음매 · 사이드바 아래", R.s1_info);
check(R.r9_preview, "R9a 곁칸 안쪽 깊이 끄는 동안 놓일 자리(곁칸 바닥) 윤곽이 보인다");
check(R.r9_lifted, "R9b 끄는 동안 독은 곁칸의 부모에 붙는다(곁칸 테두리에서 안 잘린다)");
check(R.r9, "R9 놓으면 곁칸 아래 — 계정 설정 home=float · 곁칸에 붙어 바닥 가운데(바깥 여백 8)", R.r9_saved);
check(R.r9_gone, "R9c 놓으면 윤곽이 사라진다");
check(R.hd2_from_handle, "HD2 위 R9 의 끌기는 손잡이를 잡고 시작했다 — 손잡이로 독이 옮겨 간다");
check(R.hf1, "HF1 곁칸 아래 독에도 손잡이 — 알약 왼쪽 끝 · 세운 막대 · 아이콘 높이 가운데 · 앱 단추가 아니다(원준 10-02 «이음새 있을 때랑 똑같이»)", JSON.stringify(R.hf1_info));
check(R.hf3_no_mag, "HF3 곁칸 아래 독의 손잡이 위에선 확대하지 않는다", R.hf3_info);
check(R.r2b, "R2b 곁칸 아래 독은 내용 위에 떠 있다 — 본문 여백 0(하얀 띠 없음) · 입력칸 앱 끝에 독 두께만큼 빈 자리 · «태스크 추가» 가 독 위에", JSON.stringify(R.r2b_info));
check(R.r2c, "R2c 목록은 독 밑까지 흐른다 — 목록 바닥 = 곁칸 바닥 · 독 옆도 목록 · 끝까지 굴리면 마지막 줄이 독 위", JSON.stringify(R.r2c_info));
check(R.r10, "R10 곁칸 아래 독의 크기는 곁칸 폭을 따라 — 280 < 340 < 420 에서 커지고, 확대한 몫까지 곁칸 안에(원준 10-01)", R.r10_info);
check(R.r10c_shelf_fixed, "R10c 확대해도 알약 높이는 그대로 — 아이콘이 위로 솟는다(macOS)");
check(R.r11_preview, "R11a 경계선 가까이 끄는 동안 이음매 윤곽이 분할선 위에 보인다");
check(R.r11_lifted, "R11b 곁칸 아래에서 끌면 곁칸의 부모로 옮겨 붙어 곁칸 테두리를 넘어 따라온다(안 잘린다)");
check(R.r11, "R11 경계선 가까이(세로 30%)에 놓으면 이음매 · 그 높이(at 0.3)", JSON.stringify(R.r11_info));
check(R.hf2_from_handle, "HF2 위 R11 의 끌기는 곁칸 아래 독의 손잡이를 잡고 시작했다 — 손잡이로 이음매에 돌아간다");
check(R.r12_caret, "R12a 아이콘을 끄는 동안 끼울 자리 선이 보인다");
check(R.r12, "R12 아이콘을 끌어 순서를 바꾼다(이음매는 세로)", R.r12_pins);
check(R.r13_badge, "R13a 독 밖으로 끌면 «빼기» 표시");
check(R.r13, "R13 고정한 아이콘을 독 밖으로(옆으로) 끌어내면 고정이 풀린다", R.r13_pins);
check(R.d1_started && R.d1_cancelled, "D1 독 끌기 중 버튼이 떼어진 채 움직이면 없던 일 — 끌기 상태(액자 포인터 막기 포함)가 안 남는다");
check(R.d1_nothing_saved, "D1b 그 뒤의 아무 pointerup 도 «놓기» 가 아니다 — 자리가 안 바뀐다");
check(R.d2_started && R.d2_cancelled && R.d2_nothing_saved, "D2 아이콘 끌기 중 버튼이 떼어져도 없던 일 — 조각·들림 없음 · 고정 그대로");
check(R.d3_blur && R.d3_nothing_saved, "D3 끄는 중에 창을 떠나면(blur) 없던 일");
check(R.d4_other_pointer, "D4 다른 포인터의 이동은 모른 척");
check(R.d5_nothing, "D5 끄는 중에 독이 걷히면 놓아도 아무것도 안 적는다 · 조각이 안 남는다");
check(R.d6_one_drag && R.d6_clean, "D6 끌기는 한 번에 하나 — 아이콘을 누른 채 알약 끝을 또 눌러도 독 끌기가 안 선다");
check(R.r14_open, "R14 [더보기] — 사이드바 앱 구획 · «새 탭으로 여는 앱» 은 없다(여기서 여는 것은 모두 사이드바에 선다, 원준 10-05)");
check(R.r14_beside, "R14a 이음매 독의 [더보기]는 알약 옆 곁칸 쪽으로 — 곁칸 안 · 곁칸 세로 구간 안", JSON.stringify(R.r14_info));
check(R.r14_filter, "R14b 검색이 거른다", R.r14_tiles);
check(R.r14_enter, "R14c Enter = 첫 앱을 연다 · 창이 닫힌다", R.r14_info2);
check(R.r14d_attach, "R14d 붙이기 수단이 있으면 [더보기]에 «이 세션에 붙이기» — 설치 앱이 선다");
check(R.r15, "R15 Esc 로 닫힌다");
check(R.h2_float, "H2 곁칸 아래 독의 [더보기]는 곁칸 안, 독 위에", JSON.stringify(R.h2_info));
check(R.r16, "R16 곁칸 탭 줄 높이 = 세션 머리줄 높이(아래선이 한 줄)", JSON.stringify(R.r16_heights));
check(R.c1_no_scroll, "C1 어느 자리(이음매 · 곁칸 아래)에서도 틀(탭 칸)에 스크롤이 안 생긴다", JSON.stringify(R.c1_info));
check(R.e_case, "E0 (배선) 떠 있기만 한 앱(타임라인)이 뒤 구획에 섰다");
check(R.e1_wiggle, "E1 떠 있기만 한 앱을 제자리에서 흔들면 고정되지 않는다", R.e1_info);
check(R.e2_pinned, "E2 고정 줄 안(프로젝트·웹 사이)으로 끌어오면 그 자리에 고정", R.e2_info);
check(R.f1_case && R.f1_refocus, "F1 키보드로 앱을 열면(독을 다시 세움) 초점이 같은 앱의 새 단추로", R.f1_info);
check(R.f2_untouched, "F2 초점이 독 밖이면 다시 세워도 건드리지 않는다");
check(R.f3_case && R.f3_neighbor, "F3 초점 든 앱을 메뉴 키로 빼면(단추가 사라짐) 초점은 같은 자리의 이웃(프로젝트)으로", R.f3_info);
check(R.g1_follow, "G1 같은 창에서 캐시만 바뀌면(부팅 동기 · 저장 응답) refreshDocks 로 따라온다(곁칸 아래로 옮겨 붙는다)");
check(R.h1_case && R.h1_closed, "H1 [더보기]가 열린 채 자리가 바뀌면(붙는 곳이 바뀜) 옛 창은 닫힌다 — 남지 않는다");
check(R.i1_seam, "I1 이음매 독의 이름표는 세션 쪽(알약 왼쪽) · 곁칸의 부모에");
check(R.i1_float, "I1b 곁칸 아래 독의 이름표는 아이콘 위 · 긴 이름도 곁칸 안", JSON.stringify(R.i1_info));
check(R.b1_case, "B1a (배선) 좁힌 화면에서도 웹 메뉴에 «독에서 빼기» 가 섰다");
check(R.b1_hidden_kept, "B1 프로젝트 없는 화면에서 웹을 빼도 안 보이는 고정(태스크·자료·지식)은 계정에 남는다", R.b1_info);
check(R.b7_reset, "B7 «독 되돌리기» = 이음매 가운데 · 확대 켬 + 고정 목록 «적은 적 없음»", JSON.stringify(R.b7_info));
check(R.a6_narrow_none, "A6 좁은 폭(서랍)은 곁칸 아래 · [더보기]엔 메뉴가 없다 — 곁칸 메뉴도 브라우저 메뉴도 안 뜬다");
check(R.hd5_narrow_no_handle, "HD5 좁은 폭(서랍)엔 손잡이가 없다(끌기가 없다)");
check(R.r17_noseam, "R17 이음매가 없으면(카드 모드 · 접힘) 곁칸 아래");
check(!R.err_fv, "FV0 전체보기 장면이 끝까지 돈다", R.err_fv);
check(R.fv1_center, "FV1 곁칸 전체보기(이음매 없음 · 넓은 곁칸) — 적은 적 없으면 바닥 한가운데", JSON.stringify(R.fv1_info));
check(R.fv2_preview, "FV2a 손잡이를 잡고 왼쪽으로 끌면 놓일 자리 윤곽이 바닥을 따라 따라온다(원준 10-07)", JSON.stringify(R.fv2_pv_info));
check(R.fv2_moved, "FV2 놓으면 그 자리에 선다 — 계정 설정에 좌우 자리(fx), 곁칸 바닥에 그대로", JSON.stringify(R.fv2_info));
check(R.fv2_home_kept, "FV2b 이음매 없는 화면에서 옮겨도 서는 곳(home)은 안 바뀐다 — 나란히 보기로 돌아가면 이음매 그대로", JSON.stringify(R.fv2_info));
check(R.fv3_edge, "FV3 곁칸 밖으로 끌면 끝에서 멈춘다(fx 0) — 끝에서 확대해도 바깥 여백 8px 안", JSON.stringify(R.fv3_info));
check(R.fv4_more, "FV4 [더보기]는 옮긴 독 위에, 곁칸 안에 부푼다");
check(R.fv5_row && R.fv5_center, "FV5 우클릭 › «사이드바 아래 가운데로» → 가운데(키보드로도 닿는 길)");
check(R.fv5_row_gone, "FV5b 가운데에 있으면 그 줄이 없다");
check(R.fv6_right && R.fv6_snap, "FV6 오른쪽으로도 옮긴다 · 가운데 근처(10px)에 놓으면 가운데로 붙는다", JSON.stringify(R.fv6_info));
check(R.fv7_center, "FV7 좁은 곁칸(340)에선 왼쪽 끝을 골라 뒀어도 가운데 — 알약이 폭을 채운다");
check(R.fv7_kept, "FV7b 좁은 곁칸에서 좌우로 끌어도 넓을 때 고른 자리(fx)를 안 지운다", R.fv7_info);
check(R.fv9_narrow_center && R.fv9_wide_left, "FV9 서랍(좁은 폭)은 왼쪽 끝을 골라 뒀어도 가운데 — 넓은 화면으로 돌아오면 고른 자리", String(R.fv9_info));
check(R.fv10_seam_float, "FV10 이음매가 있는 넓은 곁칸의 «사이드바 아래» 독도 좌우로 옮긴다(home=float + fx)", JSON.stringify(R.fv10_info));
check(R.fv11_no_row, "FV11 이음매에 선 독의 메뉴엔 «사이드바 아래 가운데로» 가 없다");
check(R.fv8_seam_back, "FV8 이음매가 돌아오면 다시 이음매");
check(R.r17_back, "R17a 이음매가 돌아오면 다시 이음매");
check(R.r17b_swap, "R17b 자리바꿈(곁칸이 왼쪽)이면 오른쪽 분할선 위", JSON.stringify(R.r17b_info));
check(R.r17b_tip, "R17c 자리바꿈이면 이름표는 세션 쪽(오른쪽)");
check(R.r17c, "R17d 곁칸이 접히면 독도 여백도 빈 자리도 없다");
check(R.destroyed, "R18 걷으면 흔적이 없다(이름표까지)");
check(R.r19, "R19 붙이기 수단이 없으면(옛 판 게이트웨이) [더보기]에 그 구획이 없다 — 독은 그대로 쓴다");
check(R.r20_face, "R20a ★ 붙은 앱 칸은 그 앱의 그림 · 그 앱의 색으로 선다(장표 수정 = deck) — 네모 넷이 아니다", JSON.stringify(R.r20_info));
check(R.r20_back, "R20b 얼굴이 없어지면(앱이 여럿) 종류의 기본 그림 · 색으로 돌아간다");
check(R.r20_again, "R20c 얼굴이 다시 서면 독도 다시 그린다(서명에 얼굴이 들어 있다)");
check(R.r20_nohost, "R20d 얼굴을 안 주는 셸에서도 독은 선다(기본 그림)");
const errs = Object.keys(R).filter((k) => k.startsWith("err_")).map((k) => `${k}: ${R[k]}`);
check(!errs.length, "(배선) 시나리오 묶음이 넘어지지 않았다 — 위 판정이 실제로 끝까지 돌았다", errs.join(" | "));
console.log(`\n${pass} ok · ${fail} fail`);
if (fail) process.exit(1);
