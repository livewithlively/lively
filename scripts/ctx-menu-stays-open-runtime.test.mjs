#!/usr/bin/env node
// 우클릭 메뉴는 **사람이 닫을 때만** 닫힌다 — 런타임 회귀 테스트 (#4351, 2026-09-26)
//
// 사양(엣지 표 — 행마다 시나리오 하나):
//  1 열린 채 목록을 비우고 다시 채우고 scrollTop 을 되돌린다(8초 틱과 같음)  → 열린 채
//  2 다른 스크롤 요소의 scrollTop 을 프로그램으로 바꾼다                      → 열린 채
//  3 메뉴 밖에서 사람이 굴린다(wheel)                                         → 닫힘
//  4 메뉴 안에서 굴린다(긴 메뉴)                                              → 열린 채   (경계)
//  5 메뉴 밖에서 손가락으로 끈다(touchmove)                                   → 닫힘
//  6 메뉴 밖을 누른다(pointerdown)                                            → 닫힘
//  7 메뉴 안을 누른다(pointerdown)                                            → 열린 채
//  8 Escape                                                                   → 닫힘
//  9 창 크기가 바뀐다(resize)                                                 → 닫힘
// 10 메뉴를 연 같은 박자(0ms) 안의 pointerdown(우클릭을 만든 그 누름)          → 열린 채   (경계)
//
// 왜 런타임인가: 결함이 «리스너 이름 하나»(scroll vs wheel)와 «브라우저가 되그림에 scroll 을 쏘는 사실»의 조합이라
//  소스 정규식으로는 «scroll 을 안 쓴다» 까지만 볼 수 있고, 되그림이 정말 메뉴를 못 닫는지는 실제 DOM 에서만 잰다.
//  실측(원준 2026-09-26 «우측 곁칸에서 우클릭이 될 때 있고 안 될 때 있다»): 곁칸 태스크 부품은 8초마다 `replaceKids(list)` 뒤
//  `list.scrollTop = top` 을 하고, 그 두 걸음이 scroll 이벤트를 두 번 쏜다. 메뉴가 document capture 로 scroll 을 듣고 있어
//  목록이 스크롤돼 있을 때만 닫혔다 — 그래서 «될 때 있고 안 될 때 있다» 로 보였다.
//
// fail-first: `CTX_MENU_SRC=<옛 ctx-menu.ts>` 로 변경 전 소스를 물리면 1·3·5 행이 빨간불이다(2026-09-26 실측 — 옛 엔진은 scroll 로 닫고 wheel·touchmove 는 몰랐다).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 우클릭 메뉴 닫힘 런타임 검증 미실행");
  process.exit(0);
}
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }

// 엔진만 IIFE 로 묶는다 — 실제 소스가 대상이다(옵션·리스너 이름을 흉내 내지 않는다).
const SRC = process.env.CTX_MENU_SRC || path.join(ROOT, "web/v2/ctx-menu.ts");
const bundle = execFileSync(ESBUILD, [
  SRC, "--bundle", "--format=iife", "--global-name=CtxMenu", "--platform=browser", "--log-level=error",
], { encoding: "utf8" });   // 옛 소스로 재려면 web/v2/ 안에 두고 CTX_MENU_SRC 로 가리킨다(상대 import 가 같은 부품을 잡게)

const PAGE = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;font:14px sans-serif}
  #list{height:120px;overflow:auto;border:1px solid #999;width:300px}
  #list div{height:24px}
  .pn-ctx{position:fixed;background:#fff;border:1px solid #333;max-height:60px;overflow:auto}
</style>
<div id="list"></div><div id="other" style="height:80px;overflow:auto;width:200px"><div style="height:600px"></div></div>
<pre id="out">PENDING</pre>
<script>${bundle}</script>
<script>
(async function(){
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const list=document.getElementById('list');
  const fill=()=>{list.replaceChildren(...Array.from({length:40},(_,i)=>{const d=document.createElement('div');d.textContent='row '+i;return d}))};
  fill(); list.scrollTop=200;
  const rows=Array.from({length:8},(_,i)=>({label:'항목 '+i,run(){}}));
  const open=()=>{CtxMenu.showCtxMenu(60,60,rows,{title:'시험'});};
  const isOpen=()=>CtxMenu.ctxIsOpen();
  const R={};
  // 배선 단언 — 메뉴가 정말 뜨고 scroll 이 정말 나는지(관측 장치가 살아 있나).
  open(); await sleep(30); R.w_menu_opens=isOpen();
  let scrollSeen=0; document.addEventListener('scroll',()=>{scrollSeen++},true);   // 메뉴를 연 뒤부터 센다
  // 1 되그림 + scrollTop 되돌림 — side.ts listAfter 와 같은 모양: 목록 **노드를 새로 만들어 갈아 끼우고** scrollTop 을 되돌린다
  //   (같은 노드에 replaceChildren 만 하면 높이가 같아 scroll 이 안 난다 — 실제 되그림은 새 노드라 0 → 되돌림으로 scroll 이 난다)
  const top=list.scrollTop; const fresh=list.cloneNode(false); list.replaceWith(fresh); fresh.append(...Array.from({length:40},(_,i)=>{const d=document.createElement('div');d.textContent='row '+i;return d})); fresh.scrollTop=top;
  //   ⚠ --dump-dom 헤드리스는 프레임이 안 돌아 브라우저가 scroll 을 안 쏜다(ctx-rclick-runtime 의 rAF 한계와 같다). 브라우저가 쏠 그 이벤트를
  //   그대로 쏜다(scroll 은 bubbles:false 라 document 는 capture 로만 듣는다 — 엔진이 듣던 바로 그 자리).
  fresh.dispatchEvent(new Event('scroll')); await sleep(60);
  R.w_redraw_fires_scroll=scrollSeen>0;                 // 관측: 되그림이 scroll 을 실제로 쐈다(안 쐈으면 1행은 아무것도 안 본 것)
  R.r1_redraw_keeps_open=isOpen();
  // 2 다른 요소의 프로그램 스크롤
  document.getElementById('other').scrollTop=100; await sleep(60);
  R.r2_program_scroll_keeps_open=isOpen();
  // 4 메뉴 안에서 굴림(경계) — 먼저 잰다(3 은 닫으므로)
  document.querySelector('.pn-ctx').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:20})); await sleep(30);
  R.r4_wheel_inside_keeps_open=isOpen();
  // 3 메뉴 밖에서 굴림
  document.getElementById('list').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:40})); await sleep(30);
  R.r3_wheel_outside_closes=!isOpen();
  // 5 touchmove 밖
  open(); await sleep(30);
  document.getElementById('list').dispatchEvent(new TouchEvent('touchmove',{bubbles:true})); await sleep(30);
  R.r5_touchmove_outside_closes=!isOpen();
  // 6 pointerdown 밖
  open(); await sleep(30);
  document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:5,clientY:5})); await sleep(30);
  R.r6_pointerdown_outside_closes=!isOpen();
  // 7 pointerdown 안
  open(); await sleep(30);
  document.querySelector('.pn-ctx .pn-ctx-i').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); await sleep(30);
  R.r7_pointerdown_inside_keeps_open=isOpen();
  // 8 Escape
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sleep(30);
  R.r8_escape_closes=!isOpen();
  // 9 resize
  open(); await sleep(30);
  window.dispatchEvent(new Event('resize')); await sleep(30);
  R.r9_resize_closes=!isOpen();
  // 10 연 같은 박자의 pointerdown(우클릭을 만든 그 누름) — 경계
  open(); document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:5,clientY:5}));
  R.r10_same_tick_pointerdown_keeps_open=isOpen(); await sleep(30);
  CtxMenu.closeCtxMenu();
  document.getElementById('out').textContent=JSON.stringify(R)+'\\nENDRESULT';
})();
</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "ctx-stays-open-", virtualTimeBudget: 8000 });
const m = dom.match(/<pre id="out">([\s\S]*?)ENDRESULT/);
if (!m) { console.error("FAIL  결과 표지를 못 받았다\n" + dom.slice(0, 600)); process.exit(1); }
const R = JSON.parse(m[1].trim());
let fails = 0;
const check = (k, why) => { const ok = R[k] === true; console.log(`${ok ? "ok  " : "FAIL"}  ${k} — ${why}`); if (!ok) fails++; };
check("w_menu_opens", "(배선) 메뉴가 실제로 뜬다");
check("w_redraw_fires_scroll", "(배선) 되그림의 scroll 이벤트가 document capture 에 닿는다 — 1행이 무언가를 재고 있다는 증거");
check("r1_redraw_keeps_open", "1 목록을 비우고 다시 채우며 scrollTop 을 되돌려도(8초 틱) 열린 채");
check("r2_program_scroll_keeps_open", "2 다른 요소의 프로그램 스크롤도 못 닫는다");
check("r3_wheel_outside_closes", "3 메뉴 밖에서 굴리면(wheel) 닫힌다");
check("r4_wheel_inside_keeps_open", "4 메뉴 안에서 굴리면 열린 채(경계)");
check("r5_touchmove_outside_closes", "5 메뉴 밖에서 손가락으로 끌면(touchmove) 닫힌다");
check("r6_pointerdown_outside_closes", "6 메뉴 밖을 누르면 닫힌다");
check("r7_pointerdown_inside_keeps_open", "7 메뉴 안을 누르면 열린 채");
check("r8_escape_closes", "8 Escape 로 닫힌다");
check("r9_resize_closes", "9 창 크기가 바뀌면 닫힌다");
check("r10_same_tick_pointerdown_keeps_open", "10 연 같은 박자의 pointerdown 은 못 닫는다(경계)");
console.log(fails ? `\n${fails}건 실패` : "\n12건 통과");
process.exit(fails ? 1 : 0);
