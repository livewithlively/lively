#!/usr/bin/env node
// 홈 사이드바 세션 줄의 두 단추 — ✓ 완료 · 휴지통 — 실제 side.ts 를 크롬에서 돌려 재는 회귀 테스트 (#3870)
//
//  원준 2026-10-05: "X를 누르는거 말고 완료돼서 지난세션으로 보내는 그런 느낌이 드는 버튼 … 완료됨과 쓰레기통 이렇게 두개 버튼"
//   → "잘못 생성한 세션을 사이드바에서 삭제하고 싶다는 느낌이 들 때 완료를 거치지 않고 삭제를 할 수가 없잖아" → "태스크도 완료처리".
//  종전: 줄마다 × 하나(목록에서 치우기). 휴지통은 지난 세션 줄에만 있었고 서버는 도는 세션의 휴지통 요청을 거절했다.
//
// 사양(엣지 표 — 행마다 단언 하나 이상)
//  B1 내 세션 줄(도는 것) — ✓ 와 휴지통이 선다 · × 는 없다
//  B2 내 세션 줄(끝난 것) — 같다(✓ 와 휴지통)
//  B3 남의 세션 줄 — 종전대로 × 하나 · 휴지통 없음
//  B4 세션 아닌 줄(앱 화면) — 종전대로 × 하나 · 휴지통 없음
//  B5 목록 재료에 없는 세션 줄(새로 들인 조회가 빈손) — 종전대로 × 하나(모르는 세션에 버리기를 세우지 않는다)
//  B6 제 뜻을 들고 온 줄(카드 안 «지난 세션» 전량 줄 — 맨 오른쪽이 이미 휴지통) — 그 단추 하나 그대로(✓ 로 갈아 끼우지 않는다)
//  D1 ✓ — 그 줄을 목록에서 내린다(셸의 치움 훅을 그 줄의 키로 한 번) · 그 세션의 태스크를 done 으로 보낸다 · 휴지통 요청은 없다
//  D1′ ✓ — 태스크를 새로 만들지 않는다(요청에 only_existing:true) · 서버는 그 값이면 없는 태스크를 안 만든다
//  D2 ✓ — 태스크 요청이 실패해도 내리기는 이미 갔다(훅 한 번) · 실패를 말한다(오류 토스트)
//  D3 ✓ — 태스크가 없는 세션(서버가 task:null)도 내리기는 간다 · 오류로 말하지 않는다
//  T1 휴지통 · 도는 세션 — 멈춘다는 창이 뜬다. «다음부터 묻지 않기» 가 켜져 있어도 뜬다
//  T2 휴지통 · 도는 세션 · 확인 — 요청에 stop_live:true 와 그 세션의 이름들(박스 id · 대화 uuid)
//  T3 휴지통 · 도는 세션 · 취소 — 요청이 안 간다
//  T4 휴지통 · 끝난 세션 · «묻지 않기» 켬 — 창 없이 바로 간다 · stop_live 는 안 싣는다
//  T5 휴지통 · 끝난 세션 · «묻지 않기» 끔 — 종전 창이 뜬다(멈춘다는 말이 없다)
//  T6 휴지통 · 화면은 끝난 줄로 아는데 서버가 «돌고 있다» 고 거절 — 멈출지 묻고, 확인하면 stop_live 로 다시 보낸다 · 취소하면 안 보낸다
//  C1 손을 안 얹은 줄 — 휴지통은 안 보인다(display none) · 켜진 줄은 ✓ 만 서 있다
//  C2 손을 얹은 줄 — 왼쪽부터 압정 · ✓ · 휴지통 순서로 서고 서로 안 겹친다 · 제목이 그 셋 밑으로 안 들어간다(원준 2026-10-05 «순서 [압정] [✓] [휴지통]으로»)
//  C6 ✓ 는 손을 얹든 말든 같은 자리다(켜진 줄 — 손을 얹을 때 ✓ 가 움직이지 않는다) · 켜진 줄의 제목이 ✓ 밑으로 안 들어간다
//  C3 한 줄 모드(프로젝트 카드 안)에서도 휴지통이 ✓ 와 같은 높이에 선다
//  C4 고정된 줄에 손을 얹음 — 고정 압정 · 휴지통 · ✓ 가 안 겹친다
//  C5 터치 화면(호버 없음) — 휴지통이 늘 보이고 ✓ 와 안 겹치며, 제목 · 상태 점이 두 단추 밑으로 안 들어간다
//  S1 서버 라우트 — stop_live 는 op 가 trash 이고 값이 정확히 true 일 때만 «멈추고 넣는다» 로 넘긴다
//  W1 우클릭 메뉴 — 내 세션: «완료» 와 휴지통(도는 세션도) · 휴지통에 든 세션엔 둘 다 없다
//
// fail-first(2026-10-05, 종료코드 확인):
//  · 고치기 전 소스(web 트리 · 40-v2.css · 라우트를 origin/main 판으로 물림) → S1 · W1 빨강, 런타임은 ✓ 단추가 없어 페이지 예외.
//    고치기 전 CSS 만 → C1 · C2 · C3 빨강.
//  · 변이 빨강: ✓ 가 안 내림(D1~D3) · ✓ 가 태스크를 안 끝냄(D1~D3) · stop_live 안 실음(T2) · 끝난 세션에도 stop_live(T4) ·
//    도는 세션에 종전 창(T1 · T3) · 요청 본문에서 stop_live 빠짐(T2) · 태스크 실패를 말 안 함(D2) · 모르는 세션에도 두 단추(B5) ·
//    남의 세션 판정 제거(B3) · 압정이 안 물러남(C2) · 제목이 안 줄어듦(C2) · 휴지통이 늘 보임(C1) · 한 줄 모드 높이(C3).
//  · 격리 리뷰 반영분도 빨강: 제 뜻을 든 줄도 갈아 끼움(B6) · only_existing 안 실음(D1′) · 옛 session-task.ts(D1′ 서버) ·
//    거절 뒤 다시 안 물음(T6) · 고정 압정 안 옮김(C4) · 터치에 휴지통 안 보임 / 터치 여백 그대로(C5).
//  · 초록으로 남은 변이 둘(겹친 가드라 뜻이 같다): 줄의 `!inst.owner` 만 뺌(isMine 이 받는다) · 세션 줄 판정만 뺌(목록 재료에 없어 B5 갈래가 받는다).
// ⚠ 글자는 ASCII 만 쓴다(줄 이름) — 글꼴 없는 면에서 한글 조판이 크롬을 죽인 적이 있다(side-past-dim-runtime 머리말).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const j = (o) => JSON.stringify(o);

// ───────────────────────── S · W. 소스로 보는 것(라우트는 DB · express 가 있어야 돈다 · 우클릭 행은 셸이 조립한다)
{
  const ROUTE = code(readFileSync(process.env.ROUTE_SRC || path.join(ROOT, "src/sessions/session-trash-routes.ts"), "utf8"));
  check(/const stopLive = op === "trash" && b\.stop_live === true;/.test(ROUTE)
    && /applySessionTrashOp\(u, me, op as TrashOp, ids, stopLive \? \{ stopLive: true, mustStop: true \} : \{\}\)/.test(ROUTE),
    "S1 서버 라우트 — stop_live 는 op 가 trash 이고 값이 정확히 true 일 때만 넘긴다");
  const TASK = code(readFileSync(process.env.TASK_SRC || path.join(ROOT, "src/capabilities/session-task.ts"), "utf8"));
  const gate = TASK.indexOf('if (!task && input.only_existing) return { ok: true, task: null, reason: "no-task" };');
  const make = TASK.indexOf("task = await ensureSessionTask(");
  check(gate > 0 && make > gate && /\.\.\.\(b\.only_existing === true \? \{ only_existing: true \} : \{\}\)/.test(TASK),
    "D1′(서버) only_existing 이면 없는 태스크를 만들기 전에 돌아간다 · REST 는 정확히 true 일 때만 싣는다");
  const SIDE = code(readFileSync(process.env.SIDE_SRC || path.join(ROOT, "web/v2/side.ts"), "utf8"));
  const a = SIDE.indexOf("export function sessionCtxRows("), b = SIDE.indexOf("export function projectCtxRows(");
  const CTX = a > 0 && b > a ? SIDE.slice(a, b) : "";
  check(/if \(mine && !isTrashedSess\(s\)\) rows\.push\(\{ sep: true, label: '' \}, \{ label: '완료 — 목록에서 내리기'[^\n]*run: \(\) => doDone\(s\) \}\);/.test(CTX)
    && /if \(mine && !isTrashedSess\(s\)\) rows\.push\(\{ label: live \? '멈추고 휴지통으로 보내기' : '휴지통으로 보내기'[^\n]*run: \(\) => void doTrash\(s\) \}\);/.test(CTX)
    && !/mine && !live && !isTrashedSess/.test(CTX),
    "W1 우클릭 메뉴 — 내 세션엔 «완료» 와 휴지통(도는 세션도) · 휴지통에 든 세션엔 없다");
}

// ───────────────────────── 런타임
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 세션 줄 단추 런타임 검증 미실행"); done(); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const SRC = process.env.SIDE_SRC || path.join(ROOT, "web/v2/side.ts");
const bundle = execFileSync(ESBUILD, [SRC, "--bundle", "--format=iife", "--global-name=Side", "--platform=browser", "--log-level=error"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const RAW_CSS = ["01-base.css", "40-v2.css", "47-v2-rail.css"].map((f) =>
  readFileSync(f === "40-v2.css" && process.env.V2_CSS ? process.env.V2_CSS : path.join(ROOT, "public/styles", f), "utf8")).join("\n");
//  ⚠ 헤드리스 크롬은 면마다 포인터가 다르다 — 리눅스 CI 는 (hover: none) 이 참이라 터치 규칙(× · ✓ 가 늘 보인다)이 걸리고, 맥은 거짓이다
//   (CI 에서 C1 이 «손을 안 얹은 줄의 ✓ 가 보인다» 로 빨갰다). 마우스 화면을 재는 장면에선 그 미디어 조건을 늘 거짓으로 못박고,
//   터치 화면(C5)은 따로 늘 참으로 못박아 잰다.
const CSS = RAW_CSS.replace(/@media \(hover: none\)/g, "@media not all");

//  손을 얹은 모양 — 헤드리스 dump 로는 :hover 를 못 만든다. 같은 스타일시트에서 :hover 를 클래스(.h)로 바꾼 사본을 뒤에 얹고,
//   **실제로 그려진 줄**에 .h 를 달아 잰다(손으로 지은 줄은 그리드 · 여백이 실제와 달라 고정된 줄의 자리가 11px 어긋났다).
const HCSS = CSS.replace(/\.v2-app-inst(--acts|--1)?:hover/g, ".v2-app-inst$1.h");
const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${CSS.replace(/<\/style/gi, "<\\/style")}
  html,body{margin:0} #v2-root{display:block} .v2-side{width:300px;height:800px}
</style><style>${HCSS.replace(/<\/style/gi, "<\\/style")}</style>
<div id="v2-root"><nav class="v2-side stu-side"><div class="stu-panel"><div class="stu-panel-tree" id="host"></div></div></nav></div>
<div id="toasts"></div>
<pre id="out">PENDING</pre>
<script>
  //  서버 흉내 — 요청을 적고, 장면이 정한 답을 준다. 쓰기 두 가지(태스크 · 휴지통)만 뜻이 있다.
  window.__req = []; window.__taskMode = 'ok';
  window.fetch = function (url, init) {
    var u = String(url), body = null; try { body = JSON.parse((init && init.body) || 'null'); } catch (_) {}
    var m = (init && init.method) || 'GET';
    if (m !== 'GET') window.__req.push({ m: m, u: u.replace(/^.*\\/api\\//, '/api/'), body: body });
    var out = {};
    if (/\\/task$/.test(u)) {
      if (window.__taskMode === 'fail') return Promise.resolve(new Response(JSON.stringify({ error: 'TASK-DOWN' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
      out = window.__taskMode === 'none' ? { ok: true, task: null, reason: 'no-project' } : { ok: true, task: { id: 9, status: 'done' } };
    } else if (/session-trash$/.test(u)) {
      //  serverLive — 서버는 그 세션이 돈다고 안다: stop_live 없이 오면 거절한다(실제 문구 그대로).
      out = window.__serverLive && !(body && body.stop_live) ? { ok: true, done: [], skipped: ((body && body.ids) || []).map(function (id) { return { id: id, why: '아직 돌고 있는 세션 — 먼저 지난 세션으로 보내 주세요' }; }) }
        : { ok: true, done: (body && body.ids) || [], skipped: [] };
    }
    return Promise.resolve(new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
</script>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>
(async function(){
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const host = document.getElementById('host');
    const NOW = Date.now();
    //  목록 재료 — 내 도는 세션 · 내 끝난 세션 · 남의 세션. 줄 이름은 ASCII.
    const sess = (id, o) => Object.assign({ id: id, label: id.toUpperCase(), projectId: null, node: null, live: true, alive: true, owned: true,
      stateKey: 'idle', stateLabel: 'idle', lastSeen: NOW, raw: { id: id, owner: 'me', owned: true } }, o || {});
    const data = { projects: [], lists: [], folders: [], loadedAt: NOW, sessions: [
      sess('box-live', { logId: 'uuid-live' }),
      sess('box-past', { alive: false, stateKey: 'restorable', raw: { id: 'box-past', owner: 'me', owned: true, restorable: true } }),
      sess('box-other', { owned: false, raw: { id: 'box-other', owner: 'someone', owned: false } }),
    ] };
    const row = (id, title, o) => Object.assign({ id: id, title: title, active: false, icon: 'chat', meta: 'AI', project: null, owner: null, ask: null,
      status: null, pinned: false, past: false, group: 'TODAY-GROUP', rank: 9, at: NOW }, o || {});
    const rows = [
      row('sess:box-live', 'ROW-LIVE'),
      row('sess:box-past', 'ROW-PAST', { past: true }),
      row('sess:box-other', 'ROW-OTHER', { owner: { id: 'someone', name: 'Someone' } }),
      row('inst:app1', 'ROW-APP', { icon: 'app' }),
      row('sess:box-ghost', 'ROW-GHOST'),
      row('sess:box-live2', 'ROW-ACTIVE', { active: true }),
      row('sess:box-pin', 'ROW-PINNED-WITH-A-VERY-LONG-TITLE-THAT-MUST-ELLIPSIZE-0123456789', { pinned: true }),
      row('sess:box-long', 'ROW-LONG-WITH-A-VERY-LONG-TITLE-THAT-MUST-ELLIPSIZE-0123456789'),
      row('sess:box-on', 'ROW-ON-WITH-A-VERY-LONG-TITLE-THAT-MUST-ELLIPSIZE-0123456789', { active: true }),
      row('sess:box-past2', 'ROW-OWN-TRASH', { past: true, close: { kind: 'trash', label: 'OWN-TRASH', title: 'OWN-TRASH', run: () => { ownRuns.push('ran'); } } }),
    ];
    data.sessions.push(sess('box-pin'), sess('box-long'), sess('box-on'));
    data.sessions.push(sess('box-past2', { alive: false, stateKey: 'restorable', raw: { id: 'box-past2', owner: 'me', owned: true, restorable: true } }));
    data.sessions.push(sess('box-live2'));
    const closed = [];
    const ownRuns = [];
    const hooks = { section: () => 'home', instances: () => rows, navHost: () => null, railHidden: () => false, onCloseInstance: (k) => { closed.push(k); } };
    Side.drawSide(host, data, () => '', hooks); await sleep(40);
    const rowEl = (id) => host.querySelector('.v2-app-inst[data-instance="' + id + '"]');
    const shape = (id) => { const e = rowEl(id); if (!e) return null;
      return { done: e.querySelectorAll('.v2-app-inst-close--done').length, trash: e.querySelectorAll('.v2-app-inst-trash').length,
        x: e.querySelectorAll('.v2-app-inst-close:not(.v2-app-inst-close--done)').length, acts: e.classList.contains('v2-app-inst--acts') }; };
    R.shape = { live: shape('sess:box-live'), past: shape('sess:box-past'), other: shape('sess:box-other'), app: shape('inst:app1'), ghost: shape('sess:box-ghost') };
    R.rowsDrawn = host.querySelectorAll('.v2-app-inst').length;
    { const e = rowEl('sess:box-past2'); const b = e && e.querySelector('.v2-app-inst-close');
      R.own = e ? { done: e.querySelectorAll('.v2-app-inst-close--done').length, trash: e.querySelectorAll('.v2-app-inst-trash').length, closeN: e.querySelectorAll('.v2-app-inst-close').length,
        isTrashKind: !!b && b.classList.contains('v2-app-inst-close--trash'), label: b ? b.getAttribute('aria-label') : null } : null; }

    // ── C. 자리(손을 안 얹은 줄 · 켜진 줄)
    const disp = (id, sel) => { const b = rowEl(id) && rowEl(id).querySelector(sel); return b ? getComputedStyle(b).display : 'missing'; };
    R.c1 = { trashIdle: disp('sess:box-live', '.v2-app-inst-trash'), doneIdle: disp('sess:box-live', '.v2-app-inst-close--done'),
      trashOn: disp('sess:box-live2', '.v2-app-inst-trash'), doneOn: disp('sess:box-live2', '.v2-app-inst-close--done') };

    //  손을 얹은 모양(실제 줄에 .h)
    const geo = (id) => { const e = rowEl(id); e.classList.add('h'); const g = (sel) => { const x = e.querySelector(sel); const r = x.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), d: getComputedStyle(x).display }; };
      const out = { pin: g('.v2-app-inst-pin'), trash: g('.v2-app-inst-trash'), done: g('.v2-app-inst-close--done'), title: g('.v2-app-inst-title') }; e.classList.remove('h'); return out; };
    R.geo = { plain: geo('sess:box-long'), pinned: geo('sess:box-pin') };
    { const e = rowEl('sess:box-on'); const g = (sel) => { const x = e.querySelector(sel); const r = x.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), d: getComputedStyle(x).display }; };
      const snap = () => ({ done: g('.v2-app-inst-close--done'), trash: g('.v2-app-inst-trash'), title: g('.v2-app-inst-title') });
      const idle = snap(); e.classList.add('h'); const hover = snap(); e.classList.remove('h'); R.geoOn = { idle: idle, hover: hover }; }
    // ── D. ✓
    const toasts = () => Array.from(document.querySelectorAll('#toasts .toast')).map((t) => ({ err: t.classList.contains('coral') }));
    const click = (id, sel) => { const b = rowEl(id).querySelector(sel); b.click(); };
    const reset = () => { window.__req.length = 0; closed.length = 0; };
    reset(); window.__taskMode = 'ok'; click('sess:box-live', '.v2-app-inst-close--done'); await sleep(60);
    R.d1 = { closed: closed.slice(), req: window.__req.slice() };
    reset(); window.__taskMode = 'fail'; click('sess:box-past', '.v2-app-inst-close--done'); await sleep(80);
    R.d2 = { closed: closed.slice(), req: window.__req.slice(), toasts: toasts() };
    document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
    reset(); window.__taskMode = 'none'; click('sess:box-live2', '.v2-app-inst-close--done'); await sleep(80);
    R.d3 = { closed: closed.slice(), req: window.__req.slice(), toasts: toasts() };
    window.__taskMode = 'ok';

    // ── T. 휴지통
    const dlg = () => { const b = document.querySelector('.ov-confirm'); return b ? { danger: b.classList.contains('danger'), text: (b.textContent || '').length, stop: !!b.querySelector('.btn-danger'), skipBox: !!b.querySelector('#sess-trash-skip') } : null; };
    const answer = (yes) => { const b = document.querySelector('.ov-confirm'); if (!b) return false; b.querySelector(yes ? '.ov-confirm-acts .btn:last-child' : '.ov-confirm-acts .btn-ghost').click(); return true; };
    localStorage.setItem('lively.v2.trash.skipConfirm', '1');
    reset(); click('sess:box-live', '.v2-app-inst-trash'); await sleep(60);
    R.t1 = { dlg: dlg(), reqBefore: window.__req.length };
    answer(true); await sleep(80);
    R.t2 = { req: window.__req.slice(), closed: closed.slice() };
    reset(); click('sess:box-live', '.v2-app-inst-trash'); await sleep(60);
    const had = !!dlg(); answer(false); await sleep(80);
    R.t3 = { had: had, req: window.__req.slice(), open: !!dlg() };
    reset(); click('sess:box-past', '.v2-app-inst-trash'); await sleep(80);
    R.t4 = { dlg: dlg(), req: window.__req.slice() };
    localStorage.removeItem('lively.v2.trash.skipConfirm');
    reset(); click('sess:box-past', '.v2-app-inst-trash'); await sleep(60);
    R.t5 = { dlg: dlg(), reqBefore: window.__req.length };
    answer(false); await sleep(40);
    // ── T6. 화면은 끝난 줄로 아는데 서버는 돈다고 한다
    localStorage.setItem('lively.v2.trash.skipConfirm', '1'); window.__serverLive = true;
    reset(); click('sess:box-past', '.v2-app-inst-trash'); await sleep(100);
    R.t6 = { dlg: dlg(), first: window.__req.slice() };
    answer(true); await sleep(100);
    R.t6.after = window.__req.slice();
    reset(); click('sess:box-past', '.v2-app-inst-trash'); await sleep(100);
    const had6 = !!dlg(); answer(false); await sleep(100);
    R.t6c = { had: had6, req: window.__req.slice() };
    window.__serverLive = false; localStorage.removeItem('lively.v2.trash.skipConfirm');
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 700); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script></html>`;

const parse = (dom) => {
  const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-600)); process.exit(1); }
  const R = JSON.parse(m[1]);
  if (R.error) { console.error("FAIL  페이지 예외 — " + R.error); process.exit(1); }
  return R;
};
const R = parse(await dumpDom(chrome, { html: PAGE, prefix: "side-row-acts-", args: ["--window-size=1200,900"] }));

// 배선 — 줄이 실제로 그려졌다(안 그려지면 아래 «없다» 단언이 전부 거짓 초록이다)
check(R.rowsDrawn === 10 && !!R.shape.live && !!R.shape.other && !!R.shape.app && !!R.shape.ghost && !!R.own, "W0 줄 열이 그려졌다", j([R.rowsDrawn, R.shape]));
const two = (s) => !!s && s.done === 1 && s.trash === 1 && s.x === 0 && s.acts === true;
const onlyX = (s) => !!s && s.done === 0 && s.trash === 0 && s.x === 1 && s.acts === false;
check(two(R.shape.live), "B1 내 세션 줄(도는 것) — ✓ 와 휴지통 · × 없음", j(R.shape.live));
check(two(R.shape.past), "B2 내 세션 줄(끝난 것) — ✓ 와 휴지통", j(R.shape.past));
check(onlyX(R.shape.other), "B3 남의 세션 줄 — × 하나 · 휴지통 없음", j(R.shape.other));
check(onlyX(R.shape.app), "B4 세션 아닌 줄 — × 하나 · 휴지통 없음", j(R.shape.app));
check(onlyX(R.shape.ghost), "B5 목록 재료에 없는 세션 줄 — × 하나(모르는 세션에 버리기를 세우지 않는다)", j(R.shape.ghost));

check(!!R.own && R.own.done === 0 && R.own.trash === 0 && R.own.closeN === 1 && R.own.isTrashKind === true && R.own.label === "OWN-TRASH",
  "B6 제 뜻을 들고 온 줄 — 그 단추 하나 그대로(✓ 로 갈아 끼우지 않는다)", j(R.own));
const taskReq = (r) => r.filter((x) => /\/api\/ui\/terminal\/sessions\/[^/]+\/task$/.test(x.u));
const trashReq = (r) => r.filter((x) => /session-trash$/.test(x.u));
check(j(R.d1.closed) === j(["sess:box-live"]) && taskReq(R.d1.req).length === 1 && /\/sessions\/box-live\/task$/.test(taskReq(R.d1.req)[0].u)
  && taskReq(R.d1.req)[0].body.status === "done" && trashReq(R.d1.req).length === 0,
  "D1 ✓ — 그 줄을 내리고(치움 훅 한 번) 그 세션의 태스크를 done 으로 보낸다 · 휴지통 요청은 없다", j(R.d1));
check(taskReq(R.d1.req)[0] && taskReq(R.d1.req)[0].body.only_existing === true, "D1′ ✓ — 태스크를 새로 만들지 않는다(only_existing:true)", j(R.d1.req));
check(j(R.d2.closed) === j(["sess:box-past"]) && taskReq(R.d2.req).length === 1 && R.d2.toasts.length >= 1 && R.d2.toasts.some((t) => t.err),
  "D2 ✓ — 태스크 요청이 실패해도 내리기는 갔다 · 실패를 말한다", j(R.d2));
check(j(R.d3.closed) === j(["sess:box-live2"]) && taskReq(R.d3.req).length === 1 && R.d3.toasts.length >= 1 && !R.d3.toasts.some((t) => t.err),
  "D3 ✓ — 태스크가 없는 세션도 내리기는 간다 · 오류로 말하지 않는다", j(R.d3));

check(!!R.t1.dlg && R.t1.dlg.danger === true && R.t1.dlg.stop === true && R.t1.dlg.skipBox === false && R.t1.reqBefore === 0,
  "T1 휴지통 · 도는 세션 — «묻지 않기» 가 켜져 있어도 멈춘다는 창이 뜬다(답 전엔 요청 0 · 건너뛰기 칸 없음)", j(R.t1));
const t2 = trashReq(R.t2.req)[0];
check(trashReq(R.t2.req).length === 1 && !!t2 && t2.body.op === "trash" && t2.body.stop_live === true && j(t2.body.ids) === j(["box-live", "uuid-live"]),
  "T2 휴지통 · 도는 세션 · 확인 — stop_live:true 와 그 세션의 이름들", j(R.t2.req));
check(R.t3.had === true && R.t3.req.length === 0 && R.t3.open === false, "T3 휴지통 · 도는 세션 · 취소 — 요청이 안 간다", j(R.t3));
const t4 = trashReq(R.t4.req)[0];
check(R.t4.dlg === null && trashReq(R.t4.req).length === 1 && !!t4 && t4.body.op === "trash" && !("stop_live" in t4.body) && j(t4.body.ids) === j(["box-past"]),
  "T4 휴지통 · 끝난 세션 · «묻지 않기» 켬 — 창 없이 바로 · stop_live 없음", j(R.t4));
check(!!R.t5.dlg && R.t5.dlg.danger === false && R.t5.dlg.skipBox === true && R.t5.reqBefore === 0,
  "T5 휴지통 · 끝난 세션 · «묻지 않기» 끔 — 종전 창(위험 표식 없음 · 건너뛰기 칸 있음)", j(R.t5));

{
  const f = trashReq(R.t6.first), a = trashReq(R.t6.after);
  check(f.length === 1 && !("stop_live" in f[0].body) && !!R.t6.dlg && R.t6.dlg.danger === true
    && a.length === 2 && a[1].body.stop_live === true && j(a[1].body.ids) === j(["box-past"])
    && R.t6c.had === true && trashReq(R.t6c.req).length === 1 && !("stop_live" in trashReq(R.t6c.req)[0].body),
    "T6 서버가 «돌고 있다» 고 거절하면 멈출지 묻고 — 확인하면 stop_live 로 다시, 취소하면 다시 안 보낸다", j([R.t6, R.t6c]));
}
check(R.c1.trashIdle === "none" && R.c1.doneIdle === "none" && R.c1.trashOn === "none" && R.c1.doneOn !== "none" && R.c1.doneOn !== "missing",
  "C1 손을 안 얹은 줄 — 휴지통은 안 보인다 · 켜진 줄은 ✓ 만 서 있다", j(R.c1));

// ── C2 · C4 — 손을 얹은 모양(실제로 그려진 줄에 .h 를 달아 잰 값).
{
  const g = R.geo.plain, pn = R.geo.pinned;
  const seq = (x) => x.pin.d !== "none" && x.trash.d !== "none" && x.done.d !== "none" && x.pin.w > 0 && x.trash.w > 0 && x.done.w > 0
    && x.pin.r <= x.done.l && x.done.r <= x.trash.l && x.title.r <= x.pin.l;
  check(seq(g), "C2 손을 얹은 줄 — 압정 · ✓ · 휴지통 순서로 안 겹치고, 제목이 그 밑으로 안 들어간다", j(g));
  const on = R.geoOn;
  check(!!on && on.idle.done.d !== "none" && on.idle.trash.d === "none" && on.idle.done.l === on.hover.done.l && on.idle.title.r <= on.idle.done.l,
    "C6 ✓ 는 손을 얹든 말든 같은 자리 · 켜진 줄의 제목이 ✓ 밑으로 안 들어간다", j(on));
  check(seq(pn), "C4 고정된 줄에 손을 얹음 — 고정 압정 · ✓ · 휴지통 순서로 안 겹친다", j(pn));
}
// ── C3 — 한 줄 모드(프로젝트 카드 안)의 높이. 그 모드는 묶는 축이 프로젝트일 때만 서서, 여기서는 줄을 손으로 지어 높이만 본다.
{
  const PAGE2 = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${HCSS.replace(/<\/style/gi, "<\\/style")}
    html,body{margin:0} #v2-root{display:block} .v2-side{width:300px;height:400px}</style>
  <div id="v2-root"><nav class="v2-side stu-side"><div class="stu-panel"><div class="stu-panel-tree"><div class="v2-app-list" id="l"></div></div></div></nav></div>
  <pre id="out">PENDING</pre>
  <script>
  (function(){
    var R = {};
    try {
      var d = document.createElement('div'); d.className = 'v2-app-inst v2-app-inst--acts v2-app-inst--1 h';
      d.innerHTML = '<button class="v2-app-inst-open" type="button"><span class="v2-app-inst-title">ONE-LINE-ROW</span></button>'
        + '<button class="v2-app-inst-pin" type="button"><svg viewBox="0 0 24 24"></svg></button>'
        + '<button class="v2-app-inst-trash" type="button"><svg viewBox="0 0 24 24"></svg></button>'
        + '<button class="v2-app-inst-close v2-app-inst-close--done" type="button"><svg viewBox="0 0 24 24"></svg></button>';
      document.getElementById('l').appendChild(d);
      var top = function (sel) { var x = d.querySelector(sel); return { t: Math.round(x.getBoundingClientRect().top), d: getComputedStyle(x).display }; };
      R.one = { pin: top('.v2-app-inst-pin'), trash: top('.v2-app-inst-trash'), done: top('.v2-app-inst-close--done') };
    } catch (e) { R.error = String(e && e.stack || e).slice(0, 400); }
    document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
  })();
  </script></html>`;
  const H = parse(await dumpDom(chrome, { html: PAGE2, prefix: "side-row-acts-css-", args: ["--window-size=1200,900"] }));
  check(H.one.trash.d !== "none" && H.one.trash.t === H.one.done.t && H.one.trash.t === H.one.pin.t,
    "C3 한 줄 모드 — 휴지통이 ✓ · 압정과 같은 높이", j(H.one));
}
// ── C5 터치 화면 — 헤드리스 dump 는 (hover: none) 을 못 만든다. 모바일 스타일시트의 그 미디어 조건을 늘 참으로 바꿔 잰다(손은 안 얹은 줄).
{
  const MOB = readFileSync(process.env.MOBILE_CSS || path.join(ROOT, "public/styles/50-mobile.css"), "utf8");
  const TCSS = (RAW_CSS + "\n" + MOB).replace(/@media \(hover: none\)/g, "@media all");
  const PAGE3 = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${TCSS.replace(/<\/style/gi, "<\\/style")}
    html,body{margin:0} #v2-root{display:block} .v2-side{width:300px;height:400px}</style>
  <div id="v2-root"><nav class="v2-side stu-side"><div class="stu-panel"><div class="stu-panel-tree"><div class="v2-app-list" id="l"></div></div></div></nav></div>
  <pre id="out">PENDING</pre>
  <script>
  (function(){
    var R = {};
    try {
      var d = document.createElement('div'); d.className = 'v2-app-inst v2-app-inst--acts st-busy';
      d.innerHTML = '<button class="v2-app-inst-open" type="button"><span class="v2-app-inst-title">A-VERY-LONG-SESSION-TITLE-THAT-MUST-ELLIPSIZE-BEFORE-THE-BUTTONS-0123456789</span></button>'
        + '<span class="v2-app-inst-st" data-st="busy"></span>'
        + '<button class="v2-app-inst-pin" type="button"><svg viewBox="0 0 24 24"></svg></button>'
        + '<button class="v2-app-inst-trash" type="button"><svg viewBox="0 0 24 24"></svg></button>'
        + '<button class="v2-app-inst-close v2-app-inst-close--done" type="button"><svg viewBox="0 0 24 24"></svg></button>';
      document.getElementById('l').appendChild(d);
      var rect = function (e) { var r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), d: getComputedStyle(e).display }; };
      R.touch = { trash: rect(d.querySelector('.v2-app-inst-trash')), done: rect(d.querySelector('.v2-app-inst-close--done')), title: rect(d.querySelector('.v2-app-inst-title')), st: rect(d.querySelector('.v2-app-inst-st')) };
    } catch (e) { R.error = String(e && e.stack || e).slice(0, 400); }
    document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
  })();
  </script></html>`;
  const tc = parse(await dumpDom(chrome, { html: PAGE3, prefix: "side-row-acts-touch-", args: ["--window-size=1200,900"] })).touch;
  check(tc.trash.d !== "none" && tc.done.d !== "none" && tc.trash.w > 0 && tc.done.r <= tc.trash.l && tc.title.r <= tc.done.l && tc.st.r <= tc.done.l,
    "C5 터치 화면 — 휴지통이 늘 보이고 ✓ 와 안 겹치며, 제목 · 상태 점이 두 단추 밑으로 안 들어간다", j(tc));
}
done();
