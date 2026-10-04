#!/usr/bin/env node
// [프로젝트] 사이드바에서 리스트를 즐겨찾기에 넣고 뺀다 — 실제 side.ts · board.ts 를 크롬에서 돌려 재는 회귀 테스트 (#3870)
//
//  원준 2026-10-04: "프로젝트 탭 들어갔을 때 뭔가 사이드바에 즐겨찾기 리스트 넣는 방법도 이상하고 뭔가 되게 많이 불편하거든?
//   이거 플로우가 엄청 어색하니까 수정좀 해봐"
//  고치기 전(매니지드 실측): 사이드바 줄에 단추 0 · 우클릭 메뉴에 즐겨찾기 없음 · 넣는 길은 본문(액자) 브레드크럼 옆 ☆ 하나 ·
//   ☆ 를 눌러 저장돼도 사이드바 즐겨찾기 줄은 새로고침 전까지 그대로(web/lib/list-fav.ts 머리말).
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  M1 알림 읽기 — 맞는 모양이면 {id, on} · 종류가 다르거나 번호가 양의 정수가 아니거나 on 이 불리언이 아니면 null
//  Q1 저장 줄 — 한 번 고르면 요청 1건, 되면 saved(id, on)
//  Q2 저장 줄 — 응답 전에 뒤집으면 누른 순서대로 한 번에 하나(true → false). 동시에 둘이 나가지 않는다
//  Q3 저장 줄 — 켰다 껐다 켰다(응답 전) = 요청 1건(마지막 값이 서버가 아는 값과 같아지면 더 안 보낸다)
//  Q4 저장 줄 — 실패하면 failed(id, 서버가 아는 값) · 밀린 것은 버린다 · 그 뒤 다시 고르면 다시 보낸다
//  Q5 저장 줄 — 서버가 이미 아는 값을 고르면(밖에서 알려 준 뒤) 요청 0건 · 리스트끼리는 서로 안 기다린다
//  Q6 저장 줄 — 실패를 알리는 자리(failed) 안에서 다시 고르면 그 요청이 나간다(유실되지 않는다)
//  F1 즐겨찾기를 받은 뒤, 즐겨찾기 아닌 리스트 줄 — 별 단추가 있다(안 눌림)
//  F2 즐겨찾기 줄(고정 줄) · 카드 안의 즐겨찾기한 리스트 줄 — 별 단추가 있다(눌림)
//  F3 즐겨찾기를 아직 못 받았다 — 별 단추가 없다 · 우클릭 행도 없다
//  F3b 즐겨찾기 받기가 실패했다 — «즐겨찾기 없음» 이 아니라 «모른다»: 별 단추가 없고, 다음에 그릴 때 다시 받아 선다
//  F4 별 누름(추가) — 저장 응답 전에 고정 줄에 선다 · 요청 1건(kind=project_list · id · on=true) · 주소는 안 바뀐다
//  F5 별 누름(빼기, 고정 줄에서) — 고정 줄에서 사라진다 · 요청 on=false
//  F6 저장 실패 — 되돌린다(추가였으면 줄이 사라진다)
//  F7 응답 전에 연달아 두 번 — 요청이 true → false 순서로 하나씩, 끝 상태 = 즐겨찾기 아님
//  F8 키보드(Enter) — 누름과 같다 · 주소는 안 바뀐다 · 초점이 같은 리스트의 별에 남는다
//  F9 전체 · 기타(미분류) 줄 — 별 단추가 없다
//  F10 사이드바에서 바꿈 — 저장이 된 뒤에 액자에 알린다(id · on · 받는 곳은 이 오리진만). 실패한 저장은 알리지 않는다
//  F11 액자가 알려 옴(applyFavList) — 즉시 반영 · 저장 요청 0건 · 보낸 액자엔 되알리지 않고 다른 액자엔 전한다
//  F12 우클릭 행 — 즐겨찾기 아니면 «추가», 맞으면 «빼기» · 누르면 넣고 뺀다
//  F13 착지 — 즐겨찾기 맨 위가 바뀌면 [프로젝트] 구역의 착지 주소가 그 리스트다(이번 화면 · 다음 진입이 읽는 저장값 둘 다)
//  C1 별은 평소엔 안 보이고(display none) 줄에 올리면 수 자리에 선다 — 올려도 줄 높이가 안 바뀐다
//  B1 액자: 본문 ☆ 누름 → 저장 성공 — 바깥 셸에 알린다(id · on · 받는 곳은 이 오리진만)
//  B1x 액자: 저장 실패 — 알리지 않는다
//  B2 액자: 셸이 알려 옴(보고 있는 리스트) — ☆ 눌림 상태가 맞춰진다 · 저장 요청 0건
//  B3 액자: 오리진이 다른 알림 · 바깥 창이 아닌 곳에서 온 알림 · 모양이 틀린 알림 — 무시
//  B4 단독 화면(바깥 창 없음) — ☆ 는 종전대로 돌고(저장 요청 1건) 예외가 없다
//  W1 배선 — 셸(main.ts)이 액자의 알림을 applyFavList 로 넘긴다(보낸 창과 함께) · 우클릭 메뉴(ctx-shell 'plist')가 그 행을 싣는다
//
// 왜 런타임인가: 고친 것은 «누르면 무엇이 서고 무엇이 나가나» 다. 요청은 가짜 서버가 받은 기록으로, 알림은 액자가 받은 기록으로 잰다.
// fail-first: 고치기 전 web/(WEB_SRC 로 origin/main 판을 물림)과 변이에서 빨강을 먼저 봤다 — 결과는 커밋 메시지에.
// ⚠ 이름은 ASCII 만(글꼴 없는 면). 크롬이 없는 면에서는 런타임 절을 조용히 건너뛴다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
const j = (o) => JSON.stringify(o);
const WEB = process.env.WEB_SRC || path.join(ROOT, "web");
const STYLES = process.env.STYLES_SRC || path.join(ROOT, "public/styles");

// ───────────────────────── M · Q. 순수 규칙
const LIB = path.join(WEB, "lib/list-fav.ts");
if (!existsSync(LIB)) bad("M0 web/lib/list-fav.ts 가 있다", "없다 — 알림 모양 · 저장 순서를 정하는 자리가 없다");
else {
  const out = mkdtempSync(path.join(tmpdir(), "list-fav-"));
  execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), [LIB, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
  const { LIST_FAV_MSG, listFavMsg, readListFavMsg, createFavSaver } = await import(path.join(out, "list-fav.js"));
  const good = readListFavMsg(listFavMsg(7, true)), off = readListFavMsg({ type: LIST_FAV_MSG, id: 7, on: false });
  const junk = [null, undefined, "x", 3, {}, { type: "other", id: 7, on: true }, { type: LIST_FAV_MSG, id: "7", on: true }, { type: LIST_FAV_MSG, id: 0, on: true },
    { type: LIST_FAV_MSG, id: -2, on: true }, { type: LIST_FAV_MSG, id: 1.5, on: true }, { type: LIST_FAV_MSG, id: 7, on: "true" }, { type: LIST_FAV_MSG, id: 7 }];
  check(good && good.id === 7 && good.on === true && off && off.on === false && junk.every((x) => readListFavMsg(x) === null),
    "M1 알림 읽기 — 맞는 모양만 읽는다", j([good, off, junk.map((x) => readListFavMsg(x))]));

  //  가짜 서버 — 요청마다 손으로 풀어 준다(응답 전 상태를 재려고).
  const rig = () => {
    const calls = [], saved = [], failed = [], gates = [];
    let live = 0, peak = 0;
    const s = createFavSaver({
      save: (id, on) => new Promise((res, rej) => { calls.push([id, on]); live++; peak = Math.max(peak, live); gates.push({ ok: () => { live--; res(); }, no: () => { live--; rej(new Error("boom")); } }); }),
      saved: (id, on) => saved.push([id, on]),
      failed: (id, back) => failed.push([id, back]),
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { s, calls, saved, failed, gates, peak: () => peak, tick };
  };
  { const r = rig(); r.s.want(1, true); await r.tick(); const mid = [r.calls.length, r.saved.length, r.s.busy(1)]; r.gates[0]?.ok(); await r.tick();
    check(j(mid) === "[1,0,true]" && j(r.calls) === "[[1,true]]" && j(r.saved) === "[[1,true]]" && r.failed.length === 0 && r.s.busy(1) === false, "Q1 한 번 고르면 요청 1건 · 되면 saved", j([mid, r.calls, r.saved])); }
  { const r = rig(); r.s.want(1, true); r.s.want(1, false); await r.tick(); const mid = j(r.calls); r.gates[0]?.ok(); await r.tick(); const mid2 = j(r.calls); r.gates[1]?.ok(); await r.tick();
    check(mid === "[[1,true]]" && mid2 === "[[1,true],[1,false]]" && j(r.saved) === "[[1,true],[1,false]]" && r.peak() === 1, "Q2 응답 전에 뒤집으면 누른 순서대로 한 번에 하나", j([mid, mid2, r.saved, r.peak()])); }
  { const r = rig(); r.s.want(1, true); r.s.want(1, false); r.s.want(1, true); await r.tick(); r.gates[0]?.ok(); await r.tick(); await r.tick();
    check(j(r.calls) === "[[1,true]]" && j(r.saved) === "[[1,true]]", "Q3 켰다 껐다 켰다 = 요청 1건", j([r.calls, r.saved])); }
  { const r = rig(); r.s.want(1, true); r.s.want(1, false); await r.tick(); r.gates[0]?.no(); await r.tick(); await r.tick();
    const afterFail = j([r.calls, r.failed, r.saved, r.s.busy(1)]);
    r.s.want(1, true); await r.tick(); r.gates[1]?.ok(); await r.tick();
    check(afterFail === '[[[1,true]],[[1,false]],[],false]' && j(r.calls) === "[[1,true],[1,true]]" && j(r.saved) === "[[1,true]]",
      "Q4 실패하면 failed(서버가 아는 값) · 밀린 것은 버린다 · 다시 고르면 다시 보낸다", j([afterFail, r.calls, r.saved])); }
  { const r = rig(); r.s.know(1, true); r.s.want(1, true); await r.tick(); const none = r.calls.length;
    r.s.want(1, false); r.s.want(2, true); await r.tick(); const both = j(r.calls); r.gates[0]?.ok(); r.gates[1]?.ok(); await r.tick();
    check(none === 0 && both === "[[1,false],[2,true]]" && j(r.saved) === "[[1,false],[2,true]]", "Q5 서버가 아는 값을 고르면 요청 0건 · 리스트끼리는 서로 안 기다린다", j([none, both, r.saved])); }
  { const calls = [], gates = []; let again = true;
    const s = createFavSaver({ save: (id, on) => new Promise((res, rej) => { calls.push([id, on]); gates.push({ ok: res, no: () => rej(new Error("boom")) }); }),
      saved: () => {}, failed: (id) => { if (again) { again = false; s.want(id, true); } } });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    s.want(1, true); await tick(); gates[0]?.no(); await tick(); await tick(); const after = j(calls); gates[1]?.ok(); await tick();
    check(after === "[[1,true],[1,true]]" && s.busy(1) === false, "Q6 실패를 알리는 자리에서 다시 고르면 그 요청이 나간다", j([after, s.busy(1)])); }
}

// ───────────────────────── W. 배선(주석을 걷고 본다)
const strip = (f) => (existsSync(f) ? readFileSync(f, "utf8").replace(/^[ \t]*\/\/.*$/gm, "") : "");
const MAIN = strip(path.join(WEB, "v2/main.ts")), CTX = strip(path.join(WEB, "v2/ctx-shell.ts"));
check(/const fav = readListFavMsg\(m\);\s*if \(fav\) \{ applyFavList\(fav\.id, fav\.on, ev\.source\); return; \}/.test(MAIN)
  && /registerCtx\('plist'[\s\S]{0,260}listFavCtxRow\(Number\(hit\.data\.lid\)\)[\s\S]{0,200}\.\.\.\(fav \? \[fav\] : \[\]\)/.test(CTX),
  "W1 셸이 액자의 알림을 applyFavList 로 넘기고(보낸 창과 함께) · 우클릭 메뉴가 즐겨찾기 행을 싣는다");

// ───────────────────────── 런타임
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 즐겨찾기 런타임 검증 미실행"); done(); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const pack = (entry, name) => execFileSync(ESBUILD, [path.join(WEB, entry), "--bundle", "--format=iife", "--global-name=" + name, "--platform=browser",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");
const run = async (html, prefix) => {
  const dom = await dumpDom(chrome, { html, prefix, args: ["--window-size=1400,900"] });
  const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-600)); process.exit(1); }
  const R = JSON.parse(m[1]);
  if (R.error) { console.error("FAIL  페이지 예외 — " + R.error); process.exit(1); }
  return R;
};
//  가짜 서버(두 페이지 공통) — /favorites GET 은 window.__favs, POST 는 기록하고 window.__hold 면 손으로 풀 때까지 붙든다. __failNext 면 500.
const SERVER = `
  window.__posts = []; window.__gates = []; window.__favs = [10]; window.__favGets = 0; window.__hold = false; window.__failNext = false; window.__favDelay = null; window.__favGetFail = false;
  window.fetch = async (url, opts) => {
    const u = String(url), method = (opts && opts.method) || 'GET';
    const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
    if (/\\/api\\/ui\\/v6\\/favorites/.test(u)) {
      if (method === 'GET') { window.__favGets++; if (window.__favDelay) await window.__favDelay; if (window.__favGetFail) return json({ error: 'boom' }, 500); return json({ project_lists: window.__favs.slice() }); }
      window.__posts.push(JSON.parse(opts.body));
      const failing = window.__failNext; window.__failNext = false;
      if (window.__hold) await new Promise((r) => window.__gates.push(r));
      return failing ? json({ error: 'boom' }, 500) : json({ ok: true });
    }
    if (/\\/api\\/ui\\/v6\\/projects(\\?|$)/.test(u)) return json({ projects: window.__projects || [] });
    if (/\\/api\\/ui\\/v6\\/project-lists/.test(u)) return json({ lists: window.__lists || [] });
    if (/\\/api\\/ui\\/v6\\/project-folders/.test(u)) return json({ folders: window.__folders || [] });
    if (/\\/api\\/ui\\/v6\\/board-fields/.test(u)) return json({ anchorId: null, fields: [], valuesByProject: {} });
    return json({});
  };`;

// ───────────────────────── F · C. 셸 사이드바
const SIDE_PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "47-v2-rail.css")}
  html,body{margin:0} #v2-root{display:block} .v2-side{width:300px;height:800px}
</style>
<div id="v2-root"><nav class="v2-side stu-side"><div class="stu-panel"><div class="stu-panel-tree" id="host"></div></div></nav></div>
<iframe id="fa"></iframe><iframe id="fb"></iframe>
<pre id="out">PENDING</pre>
<script>${SERVER}</script>
<script>${pack("v2/side.ts", "Side")}</script>
<script>
(async function(){
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const host = document.getElementById('host');
    //  액자 둘 — 받은 알림을 적는다(실제 postMessage 대신: file:// 는 오리진이 'null' 이라 진짜로는 못 보낸다).
    const told = { fa: [], fb: [] };
    const origins = [];
    for (const k of ['fa', 'fb']) document.getElementById(k).contentWindow.postMessage = (m, o) => { told[k].push(m); origins.push(o); };
    const FA = document.getElementById('fa').contentWindow;
    const lists = [{ id: 10, name: 'LIST-TEN', folder_id: 5 }, { id: 11, name: 'LIST-ELEVEN', folder_id: 5 }, { id: 12, name: 'LIST-TWELVE', folder_id: 5 }];
    const folders = [{ id: 1, name: 'TOP-FOLDER', parent_id: null }, { id: 5, name: 'SUB-FOLDER', parent_id: 1 }];
    const proj = (id, list_id) => ({ id, name: 'P' + id, status: 'in_progress', status_category: 'active', list_id, trashed_at: null, archived_at: null, member_ids: [] });
    const data = { projects: [proj(1, 10), proj(2, 11), proj(3, 12), proj(4, null)], sessions: [], lists, folders, loadedAt: 1700000000000 };
    const hooks = { section: () => 'proj', instances: () => [], navHost: () => null, railHidden: () => false };
    const draw = async () => { Side.drawSide(host, data, () => '', hooks); await sleep(30); };
    const favNames = () => [...host.querySelectorAll('.v2-pfav .n')].map((n) => n.textContent);
    const star = (sel) => host.querySelector(sel + ' .v2-pstar');
    //  별이 없으면(고치기 전) 누를 것이 없다 — 예외로 죽지 않고 그 장면이 «안 바뀜» 으로 찍히게 한다.
    const hit = (sel) => { const s = star(sel); if (s) s.click(); return !!s; };
    const pressed = (sel) => { const s = star(sel); return s ? s.getAttribute('aria-pressed') : null; };
    const CARD = (id) => 'a.v2-kcat[data-lid="' + id + '"]', FAV = (id) => 'a.v2-pfav[data-lid="' + id + '"]';
    const snap = () => ({ favs: favNames(), posts: window.__posts.slice(), hash: location.hash, fa: told.fa.slice(), fb: told.fb.slice() });
    const open = async () => { while (window.__gates.length) window.__gates.shift()(); await sleep(40); };

    // ── F3b — 즐겨찾기 받기가 실패한다(500) → 모른다. 실패가 걷히면 다음에 그릴 때 다시 받는다(아래 F3 이 그 요청을 붙든다)
    window.__favGetFail = true; location.hash = '#/projects2/all';
    await draw(); await sleep(120); await draw(); await sleep(60);
    R.f3b = { stars: host.querySelectorAll('.v2-pstar').length, rows: host.querySelectorAll('a.v2-kcat').length, isFav: Side.isFavList ? Side.isFavList(10) : 'no-export', gets: window.__favGets };
    window.__favGetFail = false;
    // ── F3 — 즐겨찾기를 아직 못 받았다
    let letGo; window.__favDelay = new Promise((r) => { letGo = r; });
    location.hash = '#/projects2/all';
    await draw();
    R.f3 = { stars: host.querySelectorAll('.v2-pstar').length, rows: host.querySelectorAll('a.v2-kcat').length, ctx: Side.listFavCtxRow ? Side.listFavCtxRow(11) : 'no-export', isFav: Side.isFavList ? Side.isFavList(11) : 'no-export' };
    window.__favDelay = null; letGo(); await sleep(60); await draw();
    R.getsLoaded = window.__favGets;

    // ── F1 · F2 · F9 · C1
    R.f1 = { card11: pressed(CARD(11)), card10: pressed(CARD(10)), fav10: pressed(FAV(10)), favs: favNames(),
      allStar: host.querySelectorAll('a[href="#/projects2/all"] .v2-pstar').length, noneStar: host.querySelectorAll('.v2-ptl--none .v2-pstar').length,
      noneRow: host.querySelectorAll('.v2-ptl--none').length, label: (star(CARD(11)) || {}).title || null, labelOn: (star(FAV(10)) || {}).title || null };
    { const row = host.querySelector(CARD(11)), s = star(CARD(11)), c = row.querySelector('.v2-cnt');
      if (s) {
      const h0 = row.getBoundingClientRect().height, d0 = getComputedStyle(s).display, c0 = getComputedStyle(c).display;
      //  :hover 는 스크립트로 못 건다 — 같은 규칙의 다른 문(줄에 초점)으로 잰다: 줄에 초점이 오면 별이 서고 수가 숨는다.
      row.focus(); const h1 = row.getBoundingClientRect().height, d1 = getComputedStyle(s).display, c1 = getComputedStyle(c).display, w1 = s.getBoundingClientRect().width;
      row.blur();
      R.c1 = { h0, h1, d0, d1, c0, c1, w1, hoverRule: [...document.styleSheets].some((ss) => [...ss.cssRules].some((r) => /\\.v2-ptl:hover \\.v2-pstar/.test(r.selectorText || ''))) }; } }

    // ── F4 — 추가(응답 전)
    window.__hold = true;
    hit(CARD(11)); await sleep(40);
    R.f4_mid = { ...snap(), card11: pressed(CARD(11)), fav11: pressed(FAV(11)) };
    await open(); R.f4_done = snap();

    // ── F5 — 빼기(고정 줄에서)
    hit(FAV(10)); await sleep(40); R.f5_mid = { ...snap(), card10: pressed(CARD(10)) };
    await open(); R.f5_done = snap();

    // ── F6 — 실패
    window.__failNext = true; const p0 = window.__posts.length, a0 = told.fa.length;
    hit(CARD(12)); await sleep(40); R.f6_mid = favNames();
    await open(); await sleep(60);
    R.f6 = { favs: favNames(), posts: window.__posts.slice(p0), told: told.fa.slice(a0), card12: pressed(CARD(12)), toast: !!document.querySelector('.toast, #toast, [class*=toast]') };

    // ── F7 — 연달아 두 번
    const p1 = window.__posts.length, a1 = told.fa.length;
    hit(CARD(12)); await sleep(20); hit(CARD(12)); await sleep(40);
    R.f7_mid = { posts: window.__posts.slice(p1), favs: favNames(), gates: window.__gates.length };
    { const g = window.__gates.shift(); if (g) g(); } await sleep(60);
    R.f7_mid2 = { posts: window.__posts.slice(p1), gates: window.__gates.length };
    await open(); R.f7 = { posts: window.__posts.slice(p1), favs: favNames(), card12: pressed(CARD(12)), told: told.fa.slice(a1) };

    // ── F8 — 키보드
    window.__hold = false; const p2 = window.__posts.length;
    { const s = star(CARD(12)) || host; s.focus(); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(60);
      const act = document.activeElement;
      R.f8 = { posts: window.__posts.slice(p2), favs: favNames(), hash: location.hash, focusOnStar: !!(act && act.classList && act.classList.contains('v2-pstar')),
        focusLid: act && act.closest ? (act.closest('[data-lid]') || {}).dataset?.lid || null : null }; }

    // ── F12 — 우클릭 행
    { const row = Side.listFavCtxRow || (() => null); const add = row(10), rem = row(12); const p3 = window.__posts.length;
      R.f12 = { add: add && add.label, rem: rem && rem.label, icon: add && add.icon };
      if (add) { add.run(); await sleep(60); }
      R.f12.posts = window.__posts.slice(p3); R.f12.favs = favNames(); }

    // ── F13 — 착지
    const stored = () => { const k = Object.keys(localStorage).find((x) => /proj_fav_top/.test(x)); return k ? localStorage.getItem(k) : null; };
    R.f13 = { landing: Side.projLandingRoute(), stored: stored() };

    // ── F11 — 액자가 알려 옴
    { const p4 = window.__posts.length, a = told.fa.length, b = told.fb.length;
      if (Side.applyFavList) Side.applyFavList(10, false, FA); await sleep(40);
      R.f11 = { favs: favNames(), posts: window.__posts.slice(p4), toFa: told.fa.slice(a), toFb: told.fb.slice(b), landing: Side.projLandingRoute(), stored: stored() }; }
    R.gets = window.__favGets; R.origins = [...new Set(origins)]; R.origin = location.origin;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 700); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script></html>`;

const S = await run(SIDE_PAGE, "list-fav-side-");
const msg = (id, on) => j({ type: "lively:list-fav", id, on });
check(S.f1.card11 === "false" && S.f1.label === "즐겨찾기에 추가", "F1 즐겨찾기 아닌 리스트 줄 — 별 단추(안 눌림)", j(S.f1));
check(S.f1.card10 === "true" && S.f1.fav10 === "true" && j(S.f1.favs) === '["LIST-TEN"]' && S.f1.labelOn === "즐겨찾기에서 빼기", "F2 즐겨찾기 줄 · 카드 안의 즐겨찾기한 줄 — 별 단추(눌림)", j(S.f1));
check(S.f3.stars === 0 && S.f3.rows === 3 && S.f3.ctx === null && S.f3.isFav === null, "F3 즐겨찾기를 못 받았으면 별 단추 · 우클릭 행이 없다(줄은 선다)", j(S.f3));
check(!!S.f3b && S.f3b.stars === 0 && S.f3b.rows === 3 && S.f3b.isFav === null && S.f3b.gets >= 2 && S.getsLoaded > S.f3b.gets && S.f1.fav10 === "true",
  "F3b 받기가 실패하면 «모른다» — 별 단추가 없고, 그릴 때마다 다시 받아 보다가 되면 선다", j([S.f3b, S.getsLoaded, S.f1.fav10]));
check(j(S.f4_mid.favs) === '["LIST-TEN","LIST-ELEVEN"]' && j(S.f4_mid.posts) === '[{"kind":"project_list","id":11,"on":true}]' && S.f4_mid.hash === "#/projects2/all"
  && S.f4_mid.card11 === "true" && S.f4_mid.fav11 === "true", "F4 추가 — 응답 전에 고정 줄에 서고 요청 1건 · 주소는 그대로", j(S.f4_mid));
check(j(S.f5_mid.favs) === '["LIST-ELEVEN"]' && j(S.f5_mid.posts.slice(-1)) === '[{"kind":"project_list","id":10,"on":false}]' && S.f5_mid.card10 === "false" && S.f5_mid.hash === "#/projects2/all",
  "F5 빼기(고정 줄에서) — 사라지고 요청 on=false", j(S.f5_mid));
check(j(S.f6_mid) === '["LIST-ELEVEN","LIST-TWELVE"]' && j(S.f6.favs) === '["LIST-ELEVEN"]' && S.f6.posts.length === 1 && S.f6.card12 === "false",
  "F6 저장 실패 — 되돌린다", j([S.f6_mid, S.f6]));
check(j(S.f7_mid.posts) === '[{"kind":"project_list","id":12,"on":true}]' && S.f7_mid.gates === 1 && j(S.f7_mid2.posts.map((p) => p.on)) === "[true,false]"
  && j(S.f7.posts.map((p) => p.on)) === "[true,false]" && j(S.f7.favs) === '["LIST-ELEVEN"]' && S.f7.card12 === "false",
  "F7 연달아 두 번 — 요청이 true → false 순서로 하나씩, 끝은 즐겨찾기 아님", j([S.f7_mid, S.f7_mid2, S.f7]));
check(j(S.f8.posts) === '[{"kind":"project_list","id":12,"on":true}]' && S.f8.favs.includes("LIST-TWELVE") && S.f8.hash === "#/projects2/all" && S.f8.focusOnStar && S.f8.focusLid === "12",
  "F8 키보드 Enter — 누름과 같고 주소는 그대로, 초점이 그 리스트의 별에 남는다", j(S.f8));
check(S.f1.allStar === 0 && S.f1.noneStar === 0 && S.f1.noneRow === 1, "F9 전체 · 기타(미분류) 줄엔 별 단추가 없다", j(S.f1));
check(S.f4_mid.fa.length === 0 && j(S.f4_done.fa) === "[" + msg(11, true) + "]" && j(S.f4_done.fb) === "[" + msg(11, true) + "]"
  && j(S.f5_done.fa.slice(-1)) === "[" + msg(10, false) + "]" && S.f6.told.length === 0 && j(S.f7.told) === "[" + msg(12, true) + "," + msg(12, false) + "]",
  "F10 저장이 된 뒤에 액자들에 알린다 · 실패한 저장은 알리지 않는다", j([S.f4_mid.fa, S.f4_done.fa, S.f4_done.fb, S.f5_done.fa, S.f6.told, S.f7.told]));
check(S.origins.length === 1 && S.origins[0] === S.origin, "F10o 알림을 받는 곳은 이 오리진만이다(아무 곳 '*' 이 아니다)", j([S.origins, S.origin]));
check(!S.f11.favs.includes("LIST-TEN") && S.f11.posts.length === 0 && S.f11.toFa.length === 0 && j(S.f11.toFb) === "[" + msg(10, false) + "]",
  "F11 액자가 알려 오면 즉시 반영 · 저장 0건 · 보낸 액자엔 되알리지 않고 다른 액자엔 전한다", j(S.f11));
check(S.f12.add === "즐겨찾기에 추가" && S.f12.rem === "즐겨찾기에서 빼기" && S.f12.icon === "star" && j(S.f12.posts) === '[{"kind":"project_list","id":10,"on":true}]' && S.f12.favs.includes("LIST-TEN"),
  "F12 우클릭 행 — 아니면 «추가», 맞으면 «빼기» · 누르면 넣는다", j(S.f12));
check(S.f13.landing === "#/projects2/l/10" && S.f13.stored === "10" && S.f11.landing === "#/projects2/l/11" && S.f11.stored === "11",
  "F13 즐겨찾기 맨 위가 바뀌면 착지 주소도 그 리스트다 — 다음 진입이 쓰는 저장값까지", j([S.f13, S.f11.landing, S.f11.stored]));
check(!!S.c1 && S.c1.d0 === "none" && S.c1.d1 !== "none" && S.c1.c0 !== "none" && S.c1.c1 === "none" && S.c1.w1 >= 18 && Math.abs(S.c1.h1 - S.c1.h0) < 0.5 && S.c1.hoverRule,
  "C1 별은 평소엔 안 보이고 줄에 올리면(초점이 오면) 수 자리에 선다 — 줄 높이는 그대로", j(S.c1 || "별이 없다"));
check(S.gets === S.getsLoaded, "W2 사이드바는 즐겨찾기를 받은 뒤 다시 받지 않고도 맞는다(바꿀 때마다 받지 않는다)", "받은 직후 GET " + S.getsLoaded + "회 → 끝 " + S.gets + "회");

// ───────────────────────── B. 액자(보드)
const BOARD_PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${css("01-base.css", "29-projects-board-header.css")} html,body{margin:0}</style>
<main id="view"></main><iframe id="shell"></iframe>
<pre id="out">PENDING</pre>
<script>${SERVER}
  window.__projects = [{ id: 1, name: 'ALPHA-PROJ', status: 'in_progress', list_id: 10, updated_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', member_ids: [] }];
  window.__lists = [{ id: 10, name: 'LIST-TEN', folder_id: 5, sort: 0 }, { id: 11, name: 'LIST-ELEVEN', folder_id: 5, sort: 1 }];
  window.__folders = [{ id: 5, name: 'FOLDER-FIVE', parent_id: null, sort: 0 }];
  window.__favs = [];
</script>
<script>${pack("projects/board.ts", "Board")}</script>
<script>
(async function(){
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const view = document.getElementById('view');
    const starOn = () => { const s = view.querySelector('.pjv-crumb-fav'); return s ? s.getAttribute('aria-pressed') : null; };
    const realParent = window.parent;
    document.body.classList.add('embed');
    // ── B4 — 단독(바깥 창 없음: 이 페이지가 맨 위 창이다)
    await Board.renderProjectsV2(view, '', {}, 'L10'); await sleep(40);
    R.b4 = { top: realParent === window, before: starOn() };
    view.querySelector('.pjv-crumb-fav').click(); await sleep(80);
    R.b4.after = starOn(); R.b4.posts = window.__posts.slice();
    //  셸이 보낸 척해도(바깥 창이 없으니) 듣지 않는다
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'lively:list-fav', id: 10, on: false }, origin: location.origin, source: window }));
    await sleep(30); R.b4.afterSelfMsg = starOn();

    // ── 바깥 셸을 세운다 — 진짜 창(빈 액자)을 바깥 창 자리에 놓고, 받은 알림을 적는다
    const shell = document.getElementById('shell').contentWindow; const up = [];
    shell.postMessage = (m, o) => { up.push({ m, o }); };
    window.parent = shell;
    R.parentSwapped = window.parent === shell;
    window.__favs = [10];
    await Board.renderProjectsV2(view, '', {}, 'L10'); await sleep(40);
    R.b1 = { before: starOn() };
    const p0 = window.__posts.length;
    view.querySelector('.pjv-crumb-fav').click(); await sleep(80);
    R.b1.after = starOn(); R.b1.posts = window.__posts.slice(p0); R.b1.up = up.map((x) => x.m); R.b1.to = up.map((x) => x.o); R.b1.origin = location.origin;

    // ── B1x — 실패
    const u0 = up.length; window.__failNext = true;
    view.querySelector('.pjv-crumb-fav').click(); await sleep(120);
    R.b1x = { up: up.slice(u0).length, posts: window.__posts.slice(p0).length };
    window.__favs = []; await Board.renderProjectsV2(view, '', {}, 'L10'); await sleep(40);

    // ── B2 — 셸이 알려 옴
    const p1 = window.__posts.length, u1 = up.length;
    const say = async (data, origin, source) => { window.dispatchEvent(new MessageEvent('message', { data, origin, source })); await sleep(30); };
    R.b2 = { before: starOn() };
    await say({ type: 'lively:list-fav', id: 10, on: true }, location.origin, shell); R.b2.on = starOn();
    await say({ type: 'lively:list-fav', id: 11, on: true }, location.origin, shell); R.b2.otherList = starOn();
    await say({ type: 'lively:list-fav', id: 10, on: false }, location.origin, shell); R.b2.off = starOn();
    R.b2.posts = window.__posts.slice(p1).length; R.b2.up = up.slice(u1).length;

    // ── B3 — 무시
    await say({ type: 'lively:list-fav', id: 10, on: true }, 'https://evil.example', shell); R.b3 = { badOrigin: starOn() };
    await say({ type: 'lively:list-fav', id: 10, on: true }, location.origin, window); R.b3.notParent = starOn();
    await say({ type: 'lively:list-fav', id: '10', on: true }, location.origin, shell); R.b3.badShape = starOn();
    await say({ type: 'lively:other', id: 10, on: true }, location.origin, shell); R.b3.otherType = starOn();
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 700); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script></html>`;

const B = await run(BOARD_PAGE, "list-fav-board-");
check(B.parentSwapped && B.b1.before === "true" && B.b1.after === "false" && j(B.b1.posts) === '[{"kind":"project_list","id":10,"on":false}]' && j(B.b1.up) === "[" + msg(10, false) + "]" && B.b1.to.length === 1 && B.b1.to[0] === B.b1.origin,
  "B1 액자: ☆ 누름 → 저장 성공 — 바깥 셸에 알린다(id · on)", j(B.b1));
check(B.b1x.posts === 2 && B.b1x.up === 0, "B1x 액자: 저장 실패 — 알리지 않는다", j(B.b1x));
check(B.b2.before === "false" && B.b2.on === "true" && B.b2.otherList === "true" && B.b2.off === "false" && B.b2.posts === 0 && B.b2.up === 0,
  "B2 액자: 셸이 알려 오면 ☆ 가 맞춰진다 · 저장 0건 · 되알리지 않는다", j(B.b2));
check(B.b3.badOrigin === "false" && B.b3.notParent === "false" && B.b3.badShape === "false" && B.b3.otherType === "false", "B3 액자: 오리진이 다르거나 바깥 창이 아니거나 모양이 틀린 알림은 무시", j(B.b3));
check(B.b4.top && B.b4.before === "false" && B.b4.after === "true" && j(B.b4.posts) === '[{"kind":"project_list","id":10,"on":true}]' && B.b4.afterSelfMsg === "true",
  "B4 단독 화면 — ☆ 는 종전대로 돌고 바깥 창 없는 알림은 듣지 않는다", j(B.b4));

done();
