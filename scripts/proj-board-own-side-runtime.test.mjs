#!/usr/bin/env node
// 셸 액자 안의 프로젝트 보드엔 자기 사이드바도, 그걸 여는 단추도 없다 — 실제 board.ts 를 크롬에서 돌려 재는 회귀 테스트 (#3870)
//
//  원준 2026-10-04: "굳이 프로젝트 탭으로 들어갔을 때 그 페이지의 메인 창에 프로젝트 / L Lively 제품 / 제품 / 라이블리 앱 런칭 전 할일
//   여기 왼쪽에 지금 사이드바 여는 버튼이 또있늗네, 이럼 사이드바에 사이드바를 또 여는거잖아. 또 열리는 사이드바 없게 바꿔주고 그 아이콘도 없애"
//  원인 — 새 셸 액자(?embed=1) 안에서는 보드가 «폴더 · 리스트» 패널을 세우지 않기로 했는데(#2043, 들어올 때 byArea 를 끈다),
//   여는 길 둘(브레드크럼 맨 앞 단추 · 톱니 «사이드바 표시» 스위치)은 그대로 남아 눌러서 다시 세울 수 있었다. 셸의 [프로젝트]
//   사이드바 옆에 같은 목록이 한 번 더 선다. 게다가 액자 안의 조작이 단독 화면 패널의 열림 선호(pjv:sideOpen)를 덮어썼다.
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  E1 액자 · 리스트 스코프 — 브레드크럼 줄은 서고(리스트 이름이 보인다) 사이드바 단추(.pjv-side-btn)는 없다 — 줄은 경로(.pjv-crumbs)로 시작한다
//  E2 액자 · 열림 선호가 '1' 이고 스코프 딥링크로 들어와도 패널(.pjv-side-nav)이 안 선다
//  E3 액자 · 전체 스코프(__all__)에서도 단추 · 패널이 없다
//  E4 액자 · 톱니 팝오버에 «사이드바 표시» 스위치가 없다 — 다른 스위치(값을 왼쪽 정렬) · 보기 방식은 그대로 있다(팝오버가 살아 있다)
//  E5 액자 · 보기 방식을 바꿔도(리스트로 나누기 — 선호를 적는 길) 단독 화면의 열림 선호(pjv:sideOpen)를 안 건드린다
//  E6 액자 · 보기 방식을 바꾼 뒤(다시 그린 뒤)에도 단추 · 패널이 없다
//  E7 액자 · 열림 선호가 없을 때(처음 온 브라우저) 스코프 딥링크로 들어와도 단추 · 패널이 없고 선호를 만들지도 않는다
//  C1 단독(클래식) · 열림 선호 '1' — 단추가 브레드크럼 맨 앞에 서고 눌린 상태(aria-pressed=true), 패널이 선다.
//     액자 장면들 **뒤에 같은 페이지에서** 잰다 — 잣대가 «액자 표식이 없다» 를 단독으로 읽는가(표식이 켜졌다 꺼지는 경계).
//  C2 단독 · 단추를 누르면 패널이 걷히고 선호가 '0', 다시 누르면 서고 '1' — 여닫이가 종전대로 돈다
//  C3 단독 · 톱니 팝오버에 «사이드바 표시» 스위치가 있다
//  W1 배선 — 액자 장면과 단독 장면이 같은 페이지 · 같은 자료다. 단독에서 단추 · 패널이 서므로 E 행은 «원래 아무것도 안 그리는
//   페이지» 의 거짓 초록이 아니다(C1 이 겸한다). 모든 장면에서 프로젝트 줄(ALPHA-PROJ)이 보이는지도 함께 본다.
//
// 왜 런타임인가: 고친 자리는 «무엇을 DOM 에 세우나» 이고 여는 길이 둘(단추 · 스위치) + 적는 길이 하나다. 문자열 검사로는 길 하나를 놓친다.
// fail-first: 고치기 전 web/(WEB_SRC 로 origin/main 판을 물림)과 변이에서 빨강을 먼저 봤다 — 결과는 커밋 메시지에.
// 크롬이 없는 면에서는 조용히 건너뛴다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 프로젝트 보드 사이드바 런타임 검증 미실행"); done(); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const WEB = process.env.WEB_SRC || path.join(ROOT, "web");
const bundle = execFileSync(ESBUILD, [path.join(WEB, "projects/board.ts"), "--bundle", "--format=iife", "--global-name=Board", "--platform=browser",
  "--define:import.meta.url=\"file:///board.js\"", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const CSS = ["01-base.css", "29-projects-board-header.css"].map((f) => readFileSync(path.join(ROOT, "public/styles", f), "utf8")).join("\n");

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${CSS.replace(/<\/style/gi, "<\\/style")}
  html,body{margin:0}
</style>
<main id="view"></main>
<pre id="out">PENDING</pre>
<script>
//  서버 대신 — 폴더 하나 · 리스트 하나 · 프로젝트 하나. 이름은 ASCII(글꼴 없는 면).
(function(){
  const proj = { id: 1, name: 'ALPHA-PROJ', status: 'in_progress', list_id: 10, updated_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', member_ids: [] };
  const table = [
    [/\\/api\\/ui\\/v6\\/projects(\\?|$)/, { projects: [proj] }],
    [/\\/api\\/ui\\/v6\\/project-lists/, { lists: [{ id: 10, name: 'LIST-TEN', folder_id: 5, sort: 0 }] }],
    [/\\/api\\/ui\\/v6\\/project-folders/, { folders: [{ id: 5, name: 'FOLDER-FIVE', parent_id: null, sort: 0 }] }],
    [/\\/api\\/ui\\/v6\\/board-fields/, { anchorId: null, fields: [], valuesByProject: {} }],
  ];
  window.__calls = [];
  window.fetch = async (url) => {
    window.__calls.push(String(url));
    const hit = table.find(([re]) => re.test(String(url)));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
</script>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>
(async function(){
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const view = document.getElementById('view');
    const open = async (embed, scope, pref) => {
      document.body.classList.toggle('embed', embed);
      if (pref == null) localStorage.removeItem('pjv:sideOpen'); else localStorage.setItem('pjv:sideOpen', pref);
      await Board.renderProjectsV2(view, '', {}, scope);
      await sleep(40);
    };
    const q = (s) => view.querySelector(s);
    const snap = () => {
      const bar = q('.pjv-crumbbar'), btn = q('.pjv-side-btn');
      return { bar: !!bar, crumbs: bar ? bar.textContent : null, first: bar && bar.firstElementChild ? bar.firstElementChild.className : null,
        btn: view.querySelectorAll('.pjv-side-btn').length, pressed: btn ? btn.getAttribute('aria-pressed') : null,
        nav: view.querySelectorAll('.pjv-side-nav').length, rows: /ALPHA-PROJ/.test(view.textContent || ''), pref: localStorage.getItem('pjv:sideOpen') };
    };
    //  톱니 팝오버 — 스위치 줄의 이름들과 보기 방식 줄 수.
    const gear = async () => {
      const g = q('.pjv-gear-btn'); if (!g) return null;
      g.click(); await sleep(30);
      const pop = document.querySelector('.pjv-set-pop'); if (!pop) return null;
      return { pop, out: { switches: [...pop.querySelectorAll('.pjv-closed-row-label')].map((n) => n.textContent), modes: pop.querySelectorAll('.pjv-view-item').length } };
    };
    const shut = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(20); document.querySelectorAll('.pjv-pop').forEach((n) => n.remove()); };

    // ── 액자
    await open(true, 'L10', null); R.e_fresh = snap();
    await open(true, 'L10', '1'); R.e_list = snap();
    { const g = await gear(); R.e_gear = g ? g.out : null;
      //  «리스트로 나누기» — 보기 방식 라디오의 둘째 줄. 사이드바가 꺼져 있을 때 열림 선호를 적는 길이다.
      const item = g ? g.pop.querySelectorAll('.pjv-view-item')[1] : null;
      if (item) { item.click(); await sleep(60); R.e_after_mode = snap(); }
      await shut(); }
    await open(true, '__all__', '1'); R.e_all = snap();

    // ── 단독(클래식) — 같은 페이지에서 액자 표식만 뗀다
    await open(false, 'L10', '1'); R.c_list = snap();
    { const g = await gear(); R.c_gear = g ? g.out : null; await shut(); }
    { const b = q('.pjv-side-btn'); if (b) { b.click(); await sleep(60); R.c_closed = snap(); const b2 = q('.pjv-side-btn'); if (b2) { b2.click(); await sleep(60); R.c_reopened = snap(); } } }
    R.calls = window.__calls.length;
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 600); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script></html>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "proj-own-side-", args: ["--window-size=1400,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-600)); process.exit(1); }
const R = JSON.parse(m[1]);
if (R.error) { console.error("FAIL  페이지 예외 — " + R.error); process.exit(1); }
const j = (o) => JSON.stringify(o);
const scenes = ["e_fresh", "e_list", "e_gear", "e_after_mode", "e_all", "c_list", "c_gear"];
if (!scenes.every((k) => R[k])) { console.error("FAIL  장면을 다 못 찍었다 — " + scenes.filter((k) => !R[k]).join(",") + "\n" + j(R)); process.exit(1); }
const SIDE_SWITCH = "사이드바 표시", ALIGN_SWITCH = "값을 왼쪽 정렬";

// ───────────────────────── E. 셸 액자 안
check(R.e_list.bar && /LIST-TEN/.test(R.e_list.crumbs) && R.e_list.rows && R.e_list.btn === 0 && /pjv-crumbs/.test(R.e_list.first || ""),
  "E1 액자 · 리스트 스코프 — 브레드크럼 줄은 서고 사이드바 단추는 없다", j(R.e_list));
check(R.e_list.nav === 0 && R.e_list.rows, "E2 액자 · 열림 선호 '1' + 스코프 딥링크로 들어와도 패널이 안 선다", j(R.e_list));
check(R.e_all.bar && R.e_all.btn === 0 && R.e_all.nav === 0 && R.e_all.rows, "E3 액자 · 전체 스코프에서도 단추 · 패널이 없다", j(R.e_all));
check(!R.e_gear.switches.includes(SIDE_SWITCH) && R.e_gear.switches.includes(ALIGN_SWITCH) && R.e_gear.modes >= 3,
  "E4 액자 · 톱니 팝오버에 «사이드바 표시» 스위치가 없다(다른 스위치 · 보기 방식은 그대로)", j(R.e_gear));
check(R.e_after_mode.pref === "1", "E5 액자 · 보기 방식을 바꿔도 단독 화면의 열림 선호를 안 건드린다", j(R.e_after_mode));
check(R.e_after_mode.bar && R.e_after_mode.btn === 0 && R.e_after_mode.nav === 0, "E6 액자 · 다시 그린 뒤에도 단추 · 패널이 없다", j(R.e_after_mode));
check(R.e_fresh.bar && R.e_fresh.rows && R.e_fresh.btn === 0 && R.e_fresh.nav === 0 && R.e_fresh.pref === null,
  "E7 액자 · 열림 선호가 없을 때도 단추 · 패널이 없고 선호를 만들지 않는다", j(R.e_fresh));

// ───────────────────────── C. 단독(클래식) — 종전대로
check(R.calls > 0 && R.c_list.rows && R.c_list.btn === 1 && /pjv-side-btn/.test(R.c_list.first || "") && R.c_list.pressed === "true" && R.c_list.nav === 1 && /LIST-TEN/.test(R.c_list.crumbs),
  "C1 · W1 단독 · 단추가 브레드크럼 맨 앞에 서고 눌린 상태, 패널이 선다(액자 장면 뒤 같은 페이지)", j([R.c_list, R.calls]));
check(!!R.c_closed && R.c_closed.nav === 0 && R.c_closed.btn === 1 && R.c_closed.pressed === "false" && R.c_closed.pref === "0"
  && !!R.c_reopened && R.c_reopened.nav === 1 && R.c_reopened.pressed === "true" && R.c_reopened.pref === "1",
  "C2 단독 · 단추로 패널이 걷히고(선호 0) 다시 선다(선호 1)", j([R.c_closed || null, R.c_reopened || null]));
check(R.c_gear.switches.includes(SIDE_SWITCH) && R.c_gear.switches.includes(ALIGN_SWITCH), "C3 단독 · 톱니 팝오버에 «사이드바 표시» 스위치가 있다", j(R.c_gear));

done();
