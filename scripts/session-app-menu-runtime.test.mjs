#!/usr/bin/env node
// 붙은 앱 탭의 ⋯ 메뉴 · 판 이력 · 방금 고침 띠 — **실제 크롬에서 돌리는** 회귀 테스트 (#4600, 프로젝트 #4592 · 격리 리뷰 (1)(2)(3) 반영)
//
// 왜 런타임인가: 순수 판정(scripts/session-app-menu.test.mjs)과 소스 정규식은 «줄이 있다» 까지만 말한다. 메뉴가 실제로 뜨고, 앱이 구독해야만
//  「표시 설정」이 켜지고, 되돌리기가 프레임을 **한 번만** 다시 띄우는지는 DOM 과 postMessage 가 있는 자리에서만 잰다.
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  R1  붙은 목록이 오면 머리줄에 앱 이름 · 판 번호를 모르면(null — 옛 게이트웨이) 「N판」 알약이 없다 · 탭 이름이 앱 이름
//  R2  ⋯ → 메뉴 여섯 줄(구분선 제외) 순서 · 「표시 설정」은 앱이 prefs-open 을 구독하기 전엔 흐리고 힌트 「이 앱은 표시 설정이 없어요」 · 판을 모르면 「판 이력…」 힌트 없음
//  R3  앱이 구독하면(ui/subscribe {topic:'prefs-open'}) 「표시 설정」이 켜지고, 누르면 앱 문서가 prefs-open 알림을 받는다
//  R4  목록이 바뀌어(판 3 · 원본 덮어씀) 다시 오면 알약 「3판」 · 「판 이력…」 힌트 「3판」 · 「원본으로」 켜짐 — id 는 같아도 판·이름이 바뀌면 다시 그린다(attachedSignature)
//  R5  「판 이력…」 → 판 메뉴(최신 먼저 · 지금 판은 흐림) · 「2판」 을 누르면 POST /revert {version_no:2} → 프레임이 **그 자리에서** 다시 뜬다(1회)
//  R6  뒤따라 온 'updated' 사건이 같은 번호(2)면 다시 띄우지 않고(여전히 1회) 띠만 「2판 · 방금 고침 · …」
//  R7  다른 번호(4)의 'updated' 사건은 다시 띄운다(2회) · 띠 「4판 · 방금 고침 · 보낸 줄 접기」
//  R8  띠의 「되돌리기」 = 바로 앞 판(목록 기준 2) → POST /revert {version_no:2} · 다시 띄움(3회)
//  R9  「AI에게 고치기…」 → 셸 창 사건 lively:compose-draft {session:'sid-1', text:'「장표 수정」 앱을 이렇게 고쳐 줘: '}
// fail-first: 리뷰 전 판(hasFrame 으로 켜던 판)에선 R2 의 흐림·힌트가, afterRevert 없는 판에선 R5 의 «그 자리에서 1회» 가 빨갛다(R6 가 2회가 된다).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 붙은 앱 탭 메뉴 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }

const PANE = process.env.SESSAPP_SRC || path.join(ROOT, "web/v2/session-app-pane.ts");
const entry = `export { sessAppPart, COMPOSE_DRAFT_EVT } from ${JSON.stringify(PANE)};\n`
  + `export { startLiveSync } from ${JSON.stringify(path.join(ROOT, "web/v2/live-sync.ts"))};\n`
  + `export { TOKEN_KEY } from ${JSON.stringify(path.join(ROOT, "web/lib/net.ts"))};\n`;
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=SAP", "--platform=browser", "--log-level=error", "--loader=ts", "--sourcefile=sessapp-test-entry.ts"],
  { input: entry, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const STY = path.join(ROOT, "public/styles");
const CSS = ["01-base.css", "40-v2.css", "42-v2-panes.css", "49-v2-ctx.css"].map((f) => readFileSync(path.join(STY, f), "utf8")).join("\n");

//  앱 문서 — 호스트가 머리에 SDK 를 끼워 넣는다. 여기선 prefs-open 알림이 **문서에 닿았는지**만 부모에게 되알린다.
//  ⚠ 시험 페이지의 <script> 안에 JSON 으로 실리므로 닫는 태그를 `<\/script>` 로 가린다(아니면 바깥 스크립트가 거기서 끊겨 서버 흉내가 통째로 안 선다 — 실측).
const APP_HTML = `<!doctype html><meta charset="utf-8"><title>앱</title><body>앱 화면<script>
addEventListener('message', function (e) { var m = e.data; if (m && m.method === 'ui/notifications/prefs-open') parent.postMessage({ __probe: 'prefs-open-got' }, '*');
  if (m && m.method === 'ui/notifications/insets') setTimeout(function () { parent.postMessage({ __probe: 'insets', css: getComputedStyle(document.documentElement).getPropertyValue('--lively-inset-bottom').trim(), api: window.lively.ui.insets.bottom }, '*'); }, 0); });
parent.postMessage({ __probe: 'app-ready' }, '*');
</script></body>`;
const APP_P1 = { app_id: "deck-edit", title: "장표 수정", attached_at: "2026-10-07T00:00:00Z", attached_by: "me", usable: true, has_ui: true,
  pages: [{ key: "main", title: "장표 수정" }], tables: [{ name: "docs", columns: [] }], version_no: null, overrides_builtin: false };
const APP_P2 = { ...APP_P1, version_no: 3, overrides_builtin: true };
const VERSIONS = [
  { version_no: 3, origin: "member", version: "1.0.0", note: "보낸 줄 접기", saved_by: "원준", saved_at: "2026-10-07T07:30:00Z", is_current: true },
  { version_no: 2, origin: "member", version: "1.0.0", note: "글 줄 칸을 아래로", saved_by: "원준", saved_at: "2026-10-07T07:02:00Z", is_current: false },
  { version_no: 1, origin: "builtin", version: "1.0.0", note: null, saved_by: null, saved_at: "2026-10-07T06:00:00Z", is_current: false },
];

const PAGE = `<!doctype html><meta charset="utf-8"><style>${CSS}
  html,body{margin:0;font:14px sans-serif;background:var(--bg)}
  *,*::before,*::after{transition:none!important;animation:none!important}
  #pane{position:absolute;left:600px;top:0;width:340px;height:600px;display:flex;flex-direction:column}
</style>
<div id="toasts"></div>
<section id="pane" class="pn-pane" data-zone="side"><div id="host" class="pn-pane-body" style="display:flex;flex-direction:column;flex:1;min-height:0"></div></section>
<pre id="out">PENDING</pre>
<script>try{localStorage.clear()}catch(e){}
window.requestAnimationFrame=(cb)=>setTimeout(()=>cb(performance.now()),16); window.cancelAnimationFrame=(id)=>clearTimeout(id);
//  서버 흉내 — 붙은 목록(단계별) · 앱 화면 · 판 이력 · 되돌리기(본문 기록) · 알림 스트림(열어 두고 __push 로 민다). 나머지는 빈 성공.
window.__apps=[${JSON.stringify(APP_P1)}]; window.__reverts=[]; window.__push=null; window.__calls=[]; window.__errs=[];
window.addEventListener('error',(e)=>window.__errs.push(String(e.message)));
(function(){const J=(o)=>new Response(JSON.stringify(o),{status:200,headers:{'content-type':'application/json'}});
 window.fetch=(u,o)=>{const s=String(u&&u.url||u); window.__calls.push(s); const body=o&&o.body?JSON.parse(o.body):null;
  if(s.includes('/api/ui/terminal/sessions/sid-1/apps')) return Promise.resolve(J({session_id:'sid-1',apps:window.__apps}));
  if(s.includes('/api/ui/apps/deck-edit/ui')) return Promise.resolve(J({app_id:'deck-edit',page_key:'main',kind:'page',title:'장표 수정',html:${JSON.stringify(APP_HTML).replace(/<\/script>/g, '<\\/script>')},pages:[{key:'main',title:'장표 수정'}],csp:{}}));
  if(s.includes('/api/ui/apps/deck-edit/versions')) return Promise.resolve(J({versions:${JSON.stringify(VERSIONS)}}));
  if(s.includes('/api/ui/apps/deck-edit/revert')) { window.__reverts.push(body); return Promise.resolve(J({ok:true,version_no:body&&body.version_no})); }
  if(s.includes('/api/ui/notify/stream')) { const st=new ReadableStream({start(c){ window.__push=(t)=>c.enqueue(new TextEncoder().encode(t)); }}); return Promise.resolve(new Response(st,{status:200,headers:{'content-type':'text/event-stream'}})); }
  return Promise.resolve(J({}));
 };})();
</script>
<script>${bundle}</script>
<script>
(async function(){
  const R={}; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const until=async(fn,ms)=>{const t0=performance.now(); while(performance.now()-t0<(ms||4000)){ try{ const v=fn(); if(v) return v; }catch(e){} await sleep(20);} return null;};
  try{
  localStorage.setItem(SAP.TOKEN_KEY,'tok');
  const host=document.getElementById('host'); const pane=document.getElementById('pane');
  const sessFns=[]; let tabTitle=null;
  const ctx={ id:1, data:()=>({}), detail:()=>null, dead:()=>false, curSession:()=>'sid-1', onSession:(fn)=>{sessFns.push(fn); return ()=>{};},
    trailHost:()=>document.createElement('div'), memKey:()=>'m', paneRoot:()=>pane, slot:'sessapp', slotKey:()=>'m', setTabTitle:(t)=>{tabTitle=t;} };
  const drafts=[]; window.addEventListener(SAP.COMPOSE_DRAFT_EVT,(e)=>drafts.push(e.detail));
  let prefsGot=0, rpcMsgs=0, appReady=0; window.addEventListener('message',(e)=>{ if(e.data&&e.data.__probe==='prefs-open-got') prefsGot++; if(e.data&&e.data.__probe==='app-ready') appReady++; if(e.data&&e.data.jsonrpc) rpcMsgs++; });
  SAP.startLiveSync(()=>{});
  const part=SAP.sessAppPart(ctx); host.append(part.root);
  const head=part.root.querySelector('.pn-sessapp-head'); const band=part.root.querySelector('.pn-sessapp-band');
  const iframe=await until(()=>part.root.querySelector('iframe.v2-appui-frame'));
  await until(()=>!head.hidden);
  await until(()=>window.__push);
  const reloadN=()=>{const m=/lively:reload (\\d+)/g; let last=0, x; while((x=m.exec(iframe.srcdoc))) last=+x[1]; return last;};
  const menuRows=()=>[...document.querySelectorAll('.pn-ctx .pn-ctx-i')];
  const row=(label)=>menuRows().find((b)=>{const l=b.querySelector('.pn-ctx-l'); return l&&l.textContent===label;});
  const hintOf=(b)=>{const h=b&&b.querySelector('.pn-ctx-hint'); return h?h.textContent:null;};
  const ESC=()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  const openMore=async()=>{ part.root.querySelector('.pn-sessapp-more').click(); await until(()=>document.querySelector('.pn-ctx')); };
  // R1
  R.R1_title=head.querySelector('.pn-sessapp-title').textContent; R.R1_pill=!!head.querySelector('.pn-sessapp-ver'); R.R1_tab=tabTitle; R.R1_iframe=!!iframe;
  // R2
  await openMore();
  R.R2_rows=menuRows().map((b)=>b.querySelector('.pn-ctx-l').textContent);
  R.R2_prefsOff=!!(row('표시 설정')&&row('표시 설정').disabled); R.R2_prefsHint=hintOf(row('표시 설정')); R.R2_verHint=hintOf(row('판 이력…')); R.R2_origOff=!!(row('원본으로 되돌리기')&&row('원본으로 되돌리기').disabled);
  ESC(); await until(()=>!document.querySelector('.pn-ctx'));
  // R3 — 앱이 구독했다(SDK 가 보내는 것과 같은 알림을 그 프레임 창에서 온 것처럼)
  window.dispatchEvent(new MessageEvent('message',{data:{jsonrpc:'2.0',method:'ui/subscribe',params:{topic:'prefs-open'}},source:iframe.contentWindow}));
  await sleep(30);
  await openMore();
  R.R3_prefsOff=!!(row('표시 설정')&&row('표시 설정').disabled); R.R3_prefsHint=hintOf(row('표시 설정'));
  await until(()=>appReady>0, 3000); R.R3_appReady=appReady;
  row('표시 설정').click(); await until(()=>prefsGot>0, 3000); R.R3_prefsGot=prefsGot; R.R3_rpc=rpcMsgs;
  await until(()=>!document.querySelector('.pn-ctx'));
  // R3i — 곁칸의 독이 바닥을 가린다(--pn-dock-b) → 앱 문서에 --lively-inset-bottom 으로 닿는다 (#4592)
  {
    const got=[]; window.addEventListener('message',(e)=>{ if(e.data&&e.data.__probe==='insets') got.push(e.data); });
    pane.style.setProperty('--pn-dock-b','70px');
    await until(()=>got.some((g)=>g.css==='70px'), 1200); R.R3i_set=got.slice(-1)[0]||null;
    pane.style.setProperty('--pn-dock-b','36px');
    await until(()=>got.some((g)=>g.css==='36px'), 1200); R.R3i_change=got.slice(-1)[0]||null;
    pane.style.removeProperty('--pn-dock-b');
    await until(()=>got.some((g)=>g.css==='0px'), 1200); R.R3i_clear=got.slice(-1)[0]||null;
    pane.style.setProperty('--pn-dock-b','52px'); await until(()=>got.some((g)=>g.css==='52px'), 1200);
    const n0=got.length; iframe.srcdoc=iframe.srcdoc+'<!-- again -->';     // 새 문서(다시 불러옴) — 인사 뒤에 지금 값을 다시 받는다
    await until(()=>got.length>n0 && got.slice(-1)[0].css==='52px', 1500); R.R3i_reload=got.length>n0?got.slice(-1)[0]:null;
    pane.style.removeProperty('--pn-dock-b'); await sleep(60);
  }
  // R4 — 목록이 바뀌었다(판 3 · 원본 덮어씀) → 붙이기 사건으로 다시 읽게
  window.__apps=[${JSON.stringify(APP_P2)}];
  window.__push('event: app\\ndata: '+JSON.stringify({type:'app',kind:'attach',app_id:'deck-edit',session:'sid-1'})+'\\n\\n');
  await until(()=>head.querySelector('.pn-sessapp-ver'));
  R.R4_pill=(head.querySelector('.pn-sessapp-ver')||{}).textContent||null;
  await openMore();
  R.R4_verHint=hintOf(row('판 이력…')); R.R4_origOff=!!(row('원본으로 되돌리기')&&row('원본으로 되돌리기').disabled);
  // R5 — 판 이력 → 2판으로
  row('판 이력…').click(); await until(()=>row('2판 · 글 줄 칸을 아래로'));
  R.R5_rows=menuRows().map((b)=>b.querySelector('.pn-ctx-l').textContent); R.R5_curOff=!!(row('3판 · 보낸 줄 접기')&&row('3판 · 보낸 줄 접기').disabled);
  const before=reloadN(); row('2판 · 글 줄 칸을 아래로').click();
  await until(()=>reloadN()>before, 3000);
  R.R5_revert=window.__reverts.slice(); R.R5_reloadN=reloadN();
  await until(()=>!document.querySelector('.pn-ctx'));
  // R6 — 같은 번호의 updated 사건
  window.__push('event: app\\ndata: '+JSON.stringify({type:'app',kind:'updated',app_id:'deck-edit',session:'sid-1',version_no:2,note:'글 줄 칸을 아래로'})+'\\n\\n');
  await until(()=>!band.hidden, 3000); await sleep(50);
  R.R6_reloadN=reloadN(); R.R6_band=band.hidden?null:band.querySelector('.pn-sessapp-band-t').textContent;
  // R7 — 다른 번호
  window.__push('event: app\\ndata: '+JSON.stringify({type:'app',kind:'updated',app_id:'deck-edit',session:'sid-1',version_no:4,note:'보낸 줄 접기'})+'\\n\\n');
  await until(()=>reloadN()>R.R6_reloadN, 3000);
  R.R7_reloadN=reloadN(); R.R7_band=band.querySelector('.pn-sessapp-band-t').textContent;
  // R8 — 띠의 되돌리기
  const n8=window.__reverts.length; band.querySelector('.pn-sessapp-band-b').click();
  await until(()=>window.__reverts.length>n8, 3000); await until(()=>reloadN()>R.R7_reloadN, 3000);
  R.R8_revert=window.__reverts[n8]||null; R.R8_reloadN=reloadN();
  // R9 — AI에게 고치기
  await openMore(); row('AI에게 고치기…').click(); await sleep(30);
  R.R9_draft=drafts[0]||null;
  }catch(e){ R.error=String(e&&e.stack||e); R.calls=window.__calls; R.errs=window.__errs; R.body=document.getElementById('host').innerHTML.slice(0,800); }
  document.getElementById('out').textContent='RESULT'+JSON.stringify(R)+'ENDRESULT';
})();
</script>`;

//  ⚠ IsolateSandboxedIframes 를 끈다 — 크롬은 sandbox iframe 을 **다른 프로세스**에 두는데, 가상 시간(--virtual-time-budget)은
//   프로세스를 건너는 postMessage 왕복을 기다려 주지 않는다. 부모의 «3초 기다리기» 가 실시간 몇 ms 에 끝나 R3(앱 문서가
//   prefs-open 을 받았다고 되알림)이 세 번에 두 번 빨갛게 흔들렸다(2026-10-07 실측: 같은 코드 3회 중 1회 통과 → 끄고 8회 연속 통과).
//   같은 프로세스에 두면 알림과 되알림이 같은 이벤트 루프에서 순서대로 돈다. 재는 것은 호스트의 배선이지 프로세스 격리가 아니다.
const dom = await dumpDom(chrome, { html: PAGE, prefix: "sessapp-menu-", virtualTimeBudget: 20000, args: ["--window-size=1200,800", "--disable-features=IsolateSandboxedIframes"] });
const m = dom.match(/RESULT(\{[\s\S]*?\})ENDRESULT/);
if (!m) { console.error("FAIL  결과를 못 읽었다\n" + dom.slice(0, 1200)); process.exit(1); }
const R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (R.error) { console.error("FAIL  페이지 오류\n" + R.error + "\n요청: " + JSON.stringify(R.calls) + "\n오류: " + JSON.stringify(R.errs) + "\nDOM: " + String(R.body || "").slice(0, 700)); process.exit(1); }

let pass = 0, fail = 0;
const t = (cond, name, extra) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL ${name}${extra !== undefined ? " — " + JSON.stringify(extra) : ""}`); } };
t(R.R1_title === "장표 수정" && R.R1_pill === false && R.R1_tab === "장표 수정" && R.R1_iframe, "R1 머리줄에 앱 이름 · 판을 모르면 「N판」 없음 · 탭 이름 = 앱 이름 · 앱 화면이 떴다", R);
t(JSON.stringify(R.R2_rows) === JSON.stringify(["AI에게 고치기…", "표시 설정", "판 이력…", "원본으로 되돌리기", "크게 보기", "이 세션에서 떼기"]), "R2 ⋯ 메뉴 여섯 줄 · 순서", R.R2_rows);
t(R.R2_prefsOff === true && R.R2_prefsHint === "이 앱은 표시 설정이 없어요", "R2 구독 전 「표시 설정」은 흐리고 까닭을 힌트로(리뷰 (1))", [R.R2_prefsOff, R.R2_prefsHint]);
t(R.R2_verHint === null && R.R2_origOff === true, "R2 판을 모르면 「판 이력…」 힌트 없음 · 원본 그대로면 「원본으로」 흐림(리뷰 (3))", [R.R2_verHint, R.R2_origOff]);
t(R.R3_prefsOff === false && R.R3_prefsHint === "나에게만" && R.R3_prefsGot >= 1, "R3 앱이 prefs-open 을 구독하면 켜지고, 누르면 앱 문서가 알림을 받는다", [R.R3_prefsOff, R.R3_prefsHint, R.R3_prefsGot, "rpc:" + R.R3_rpc, "ready:" + R.R3_appReady]);
t(!!R.R3i_set && R.R3i_set.css === "70px" && R.R3i_set.api === 70, "R3i-1 ★ 곁칸의 독이 바닥을 70px 가리면 앱 문서의 --lively-inset-bottom 이 70px (lively.ui.insets.bottom 도)", R.R3i_set);
t(!!R.R3i_change && R.R3i_change.css === "36px" && !!R.R3i_clear && R.R3i_clear.css === "0px" && R.R3i_clear.api === 0, "R3i-2 독 크기가 바뀌거나 독이 비키면(이음매로 옮김) 따라 바뀐다", [R.R3i_change, R.R3i_clear]);
t(!!R.R3i_reload && R.R3i_reload.css === "52px", "R3i-3 앱 화면이 다시 불러와져도(새 문서) 지금 값을 다시 받는다", R.R3i_reload);
t(R.R4_pill === "3판" && R.R4_verHint === "3판" && R.R4_origOff === false, "R4 목록이 다시 오면 「3판」 알약 · 힌트 · 「원본으로」 켜짐", [R.R4_pill, R.R4_verHint, R.R4_origOff]);
t(JSON.stringify(R.R5_rows) === JSON.stringify(["3판 · 보낸 줄 접기", "2판 · 글 줄 칸을 아래로", "1판 · 라이블리 기본 앱"]) && R.R5_curOff === true, "R5 판 이력 메뉴 — 최신 먼저 · 지금 판은 흐림", [R.R5_rows, R.R5_curOff]);
t(JSON.stringify(R.R5_revert) === JSON.stringify([{ version_no: 2 }]) && R.R5_reloadN === 1, "R5 「2판」 → POST /revert {version_no:2} → 그 자리에서 다시 띄움(1회)(리뷰 (2))", [R.R5_revert, R.R5_reloadN]);
t(R.R6_reloadN === 1 && R.R6_band === "2판 · 방금 고침 · 글 줄 칸을 아래로", "R6 같은 번호의 updated 사건은 다시 띄우지 않고 띠만(리뷰 (2))", [R.R6_reloadN, R.R6_band]);
t(R.R7_reloadN === 2 && R.R7_band === "4판 · 방금 고침 · 보낸 줄 접기", "R7 다른 번호의 updated 사건은 다시 띄운다(2회) · 띠 갱신", [R.R7_reloadN, R.R7_band]);
t(JSON.stringify(R.R8_revert) === JSON.stringify({ version_no: 2 }) && R.R8_reloadN === 3, "R8 띠의 「되돌리기」 = 바로 앞 판(2) · 다시 띄움(3회)", [R.R8_revert, R.R8_reloadN]);
t(R.R9_draft && R.R9_draft.session === "sid-1" && R.R9_draft.text === "「장표 수정」 앱을 이렇게 고쳐 줘: ", "R9 「AI에게 고치기…」 → lively:compose-draft {session, text}", R.R9_draft);
console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);
