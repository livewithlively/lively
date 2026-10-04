#!/usr/bin/env node
// 프로젝트로 묶을 때 「지금 볼 것」에는 볼 일 있는 세션만 선다 — 실제 side.ts 를 크롬에서 돌려 재는 회귀 테스트 (#4551)
//
//  원준 2026-10-04: "프로젝트로 묶은 상태에서 지금 볼 것에 저 많은 것 중에 한두 개만 올려주면 되는데 프로젝트로 묶인 게
//   전체 다 올라온다. 진짜 지금 볼 것만 같은 프로젝트가 여러 개 있을 때 한 곳에 묶여 보이고 나머지는 아래에 보이는 방식으로."
//  원인 — 카드의 자리가 첫 행의 묶음 하나로 정해져, 하나만 돌아도 카드가 통째로 「지금 볼 것」에 섰다(lib/home-pins planNowCards 머리말).
//
// 사양(엣지 표 — 행마다 단언 하나 이상).
//  재료: 프로젝트 1(확인 필요 1 · 작업 중 1 · 조용한 줄 4) · 프로젝트 2(확인 필요 1 · 조용한 줄 1) · 프로젝트 3(조용한 줄 2) ·
//        프로젝트 4(작업 중 1 — 줄이 전부 볼 일) · 프로젝트 없음(확인 필요 1 · 조용한 줄 1).
//  R1 「지금 볼 것」 아래엔 볼 일 있는 다섯 줄만 선다 — 조용한 줄은 한 줄도 없다
//  R2 같은 프로젝트의 볼 일 둘은 **한 카드**에 묶인다(조각 카드는 프로젝트마다 하나) · 카드 순서는 가장 급한 줄 순서
//  R3 조각 카드는 기본이 펴짐 — 올라온 줄 이름이 그대로 보인다(작업 중뿐인 카드도)
//  R4 그 프로젝트의 나머지 줄은 날짜 묶음 아래 제 카드에 남는다(카드 · 개수 칩)
//  R5 볼 일이 없는 프로젝트는 종전 그대로 카드 하나(날짜 아래)
//  R6 조각 카드 머리를 누르면 접힌다 · 다시 그려도 접힌 채 · 다시 누르면 펴진다 · 다른 카드의 펼침은 안 건드린다
//  R7 ★ 조각 카드에서 압정을 누르면 **그 프로젝트**가 고정된다 — 카드 하나로 합쳐져 「고정」 아래에 서고 조각 카드는 없다
//  R8 세션별 축으로 풀면 조각 카드가 없다(날짜 카드만) · 두 축의 「지금 볼 것」이 같은 줄 집합이다
//  R9 경계 — 줄이 전부 볼 일인 프로젝트는 날짜 아래 카드가 없다(빈 카드를 만들지 않는다)
//  R10 경계 — 「프로젝트 없음」도 같은 규칙으로 나뉘고, 그 조각 카드엔 압정이 없다(고정할 프로젝트가 없다)
//  W1 배선 — 묶음 이름표가 실제로 서고 줄이 화면까지 간다(R1 이 «아무것도 안 그리는 페이지» 에서 초록이 되지 않게)
//
// fail-first(2026-10-04): 고치기 전 side.ts(SIDE_SRC 로 origin/main 판을 물림)에서 8건 빨강(R1~R4 · R6 · R7 · R9 · R10) —
//  「지금 볼 것」 아래에 프로젝트 1 · 2 · 없음의 조용한 줄까지 열 줄이 섰다. W1 · R5 · R8 은 종전에도 참이라 초록(무회귀 가드).
// ⚠ 글자는 ASCII 만 쓴다(줄 · 프로젝트 이름) — 글꼴 없는 면에서 한글 조판이 크롬을 죽인 적이 있다(side-past-dim-runtime 머리말).
//   묶음 이름(지금 볼 것)은 자리 규칙의 상수라 그대로 쓴다 — 판정은 글자 모양이 아니라 DOM 구조로 한다.
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (cond, n, why = "기대와 다르다") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 「지금 볼 것」 조각 카드 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const SRC = process.env.SIDE_SRC || path.join(ROOT, "web/v2/side.ts");
const bundle = execFileSync(ESBUILD, [SRC, "--bundle", "--format=iife", "--global-name=Side", "--platform=browser", "--log-level=error"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const CSS = ["01-base.css", "40-v2.css", "47-v2-rail.css"].map((f) => readFileSync(path.join(ROOT, "public/styles", f), "utf8")).join("\n");

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${CSS.replace(/<\/style/gi, "<\\/style")}
  html,body{margin:0} #v2-root{display:block} .v2-side{width:300px;height:900px}
</style>
<div id="v2-root"><nav class="v2-side stu-side"><div class="stu-panel"><div class="stu-panel-tree" id="host"></div></div></nav></div>
<pre id="out">PENDING</pre>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>
(async function(){
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const host = document.getElementById('host');
    const NOW = '\\uC9C0\\uAE08 \\uBCFC \\uAC83', DAY = 'TODAY-GROUP';
    let t = 1700000000000;
    //  main.ts sideInstances 가 만드는 줄 모양 그대로 — 묶음 · 순위 · 시각은 그쪽이 정해서 넘긴다(정렬: 층 → 순위 → 최신).
    const row = (id, pid, st) => ({ id: 'sess:' + id, title: 'ROW-' + id, active: false, icon: 'chat', meta: 'AI',
      project: pid ? { id: pid, name: 'PROJ-' + pid } : null, owner: null, ask: null, pinned: false, past: false,
      status: st ? { key: st, label: st } : null, group: st ? NOW : DAY, rank: st === 'waiting' ? 0 : st === 'busy' ? 2 : 9, at: t-- });
    const rows = [
      row('w1', 1, 'waiting'), row('w2', 2, 'waiting'), row('w0', 0, 'waiting'), row('b1', 1, 'busy'), row('b4', 4, 'busy'),
      row('q1', 1), row('q2', 1), row('q3', 2), row('q4', 1), row('q5', 3), row('q6', 1), row('q7', 3), row('q0', 0),
    ];
    const hooks = { section: () => 'home', instances: () => rows, navHost: () => null, railHidden: () => false };
    const data = { projects: [], sessions: [], lists: [], folders: [], loadedAt: 1700000000000 };
    const draw = async () => { Side.drawSide(host, data, () => '', hooks); await sleep(40); };
    //  목록을 묶음 이름표 기준으로 읽는다 — 이름표 뒤에 오는 카드가 그 묶음의 것이다.
    const snap = () => {
      const first = host.querySelector('.v2-app-group');
      const list = first ? first.parentElement : host;
      const out = []; let cur = null;
      for (const n of Array.from(list.children)) {
        if (n.classList.contains('v2-app-group')) { cur = { label: n.textContent, cards: [] }; out.push(cur); continue; }
        if (!n.classList.contains('v2-pg')) continue;
        if (!cur) { cur = { label: '', cards: [] }; out.push(cur); }
        const cnt = n.querySelector('.v2-pg-row .v2-cnt');
        cur.cards.push({ anch: n.getAttribute('data-anch'), open: n.classList.contains('open'),
          name: (n.querySelector('.v2-pg-row .n') || {}).textContent || '', cnt: cnt ? cnt.textContent : null,
          pin: !!n.querySelector('.v2-pg-row .v2-pinb'),
          rows: Array.from(n.querySelectorAll('.v2-app-inst-title')).map((x) => x.textContent) });
      }
      return out;
    };
    const head = (anch) => host.querySelector('.v2-pg[data-anch="' + anch + '"] .v2-pg-t');

    await draw();
    R.sess = snap();                                              // 세션별 축(기본)
    const axis = host.querySelector('.v2-axisbtn');
    if (!axis) throw new Error('no axis button');
    axis.click(); await sleep(40);
    R.proj = snap();                                              // 프로젝트별 축
    R.axisOn = !!host.querySelector('.v2-axisbtn.on');

    //  R6 — 조각 카드를 접는다 → 다시 그려도 접힌 채 → 다시 누르면 펴진다.
    const h1 = head('now:p:1');
    if (h1) {
      h1.click(); await sleep(40); R.closed = snap();
      await draw(); R.closedAgain = snap();
      const h1b = head('now:p:1'); if (h1b) { h1b.click(); await sleep(40); }
      R.reopened = snap();
    }

    //  R7 — 조각 카드의 압정.
    const pin = host.querySelector('.v2-pg[data-anch="now:p:1"] .v2-pinb');
    R.hasPin = !!pin;
    if (pin) { pin.click(); await sleep(40); R.pinned = snap(); }
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 600); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script></html>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "side-now-", args: ["--window-size=1200,1000"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-600)); process.exit(1); }
const R = JSON.parse(m[1]);
if (R.error) { console.error("FAIL  페이지 예외 — " + R.error); process.exit(1); }
const j = (o) => JSON.stringify(o);
const NOW = "지금 볼 것", DAY = "TODAY-GROUP";
const grp = (s, label) => (s || []).find((g) => g.label === label) || { cards: [] };
const all = (s) => (s || []).flatMap((g) => g.cards);
const rowsOf = (g) => g.cards.flatMap((c) => c.rows);
const card = (s, anch) => all(s).find((c) => c.anch === anch);
const sorted = (xs) => [...xs].sort();
const HOT = ["ROW-b1", "ROW-b4", "ROW-w0", "ROW-w1", "ROW-w2"];

const now = grp(R.proj, NOW), day = grp(R.proj, DAY);
check(R.axisOn === true && (R.proj || []).map((g) => g.label).join("|") === `${NOW}|${DAY}` && rowsOf(now).length > 0 && all(R.proj).length > 0,
  "W1 프로젝트별 축 — 묶음 이름표 둘(지금 볼 것 · 날짜)이 서고 줄이 화면까지 간다", j((R.proj || []).map((g) => [g.label, g.cards.length])));
check(j(sorted(rowsOf(now))) === j(HOT),
  "R1 ★★ 「지금 볼 것」 아래엔 볼 일 있는 다섯 줄만 선다 — 조용한 줄은 한 줄도 없다", j(rowsOf(now)));
check(j(now.cards.map((c) => [c.anch, c.rows])) === j([["now:p:1", ["ROW-w1", "ROW-b1"]], ["now:p:2", ["ROW-w2"]], ["now:p:0", ["ROW-w0"]], ["now:p:4", ["ROW-b4"]]]),
  "R2 ★ 같은 프로젝트의 볼 일 둘은 한 카드에 묶인다 — 조각 카드는 프로젝트마다 하나 · 순서는 가장 급한 줄 순서", j(now.cards.map((c) => [c.anch, c.rows])));
check(now.cards.length === 4 && now.cards.every((c) => c.open) && now.cards[0].name === "PROJ-1",
  "R3 조각 카드는 기본이 펴짐 — 올라온 줄이 그대로 보인다(작업 중뿐인 카드도)", j(now.cards.map((c) => [c.anch, c.open, c.name])));
check(j(day.cards.map((c) => [c.anch, c.cnt])) === j([["p:1", "4"], ["p:2", null], ["p:3", "2"], ["p:0", null]]),
  "R4 ★★ 그 프로젝트의 나머지 줄은 날짜 묶음 아래 제 카드에 남는다(프로젝트 1 = 4줄 · 프로젝트 2 = 1줄)", j(day.cards.map((c) => [c.anch, c.cnt])));
check(!!card(R.proj, "p:3") && !card(R.proj, "now:p:3"), "R5 볼 일이 없는 프로젝트는 종전 그대로 카드 하나", j(all(R.proj).map((c) => c.anch)));

const c1 = card(R.closed, "now:p:1"), c1b = card(R.closedAgain, "now:p:1"), c1c = card(R.reopened, "now:p:1");
const others = (s) => j(all(s).filter((c) => c.anch !== "now:p:1").map((c) => [c.anch, c.open]));
check(!!c1 && c1.open === false && c1.rows.length === 0 && !!c1b && c1b.open === false && !!c1c && c1c.open === true && c1c.rows.length === 2
  && others(R.closed) === others(R.proj) && others(R.closedAgain) === others(R.proj),
  "R6 조각 카드 머리를 누르면 접힌다 · 다시 그려도 접힌 채 · 다시 누르면 펴진다 · 다른 카드는 그대로", j([c1, c1b, c1c]));

const pg = (R.pinned || [])[0] || { cards: [] };
const pinnedCard = card(R.pinned, "p:1");
check(R.hasPin === true && !!pinnedCard && pg.cards.some((c) => c.anch === "p:1") && pg.label !== NOW && pg.label !== DAY
  && !card(R.pinned, "now:p:1") && all(R.pinned).filter((c) => c.anch === "p:1").length === 1
  && pinnedCard.cnt === "6" && !!card(R.pinned, "now:p:2") && !!card(R.pinned, "p:2"),
  "R7 ★ 조각 카드의 압정 = 그 프로젝트 고정 — 카드 하나로 합쳐 「고정」 아래에(6줄), 조각 카드는 사라지고 다른 프로젝트는 그대로",
  j((R.pinned || []).map((g) => [g.label, g.cards.map((c) => [c.anch, c.cnt])])));

check(all(R.sess).length > 0 && all(R.sess).every((c) => !String(c.anch).startsWith("now:") && !String(c.anch).startsWith("p:"))
  && j(sorted(rowsOf(grp(R.sess, NOW)))) === j(HOT),
  "R8 세션별 축엔 조각 카드가 없다(날짜 카드만) — 두 축의 「지금 볼 것」이 같은 줄 집합이다", j((R.sess || []).map((g) => [g.label, g.cards.map((c) => c.anch)])));

check(!!card(R.proj, "now:p:4") && !card(R.proj, "p:4"), "R9 경계 — 줄이 전부 볼 일인 프로젝트는 날짜 아래 카드가 없다(빈 카드를 만들지 않는다)", j(all(R.proj).map((c) => c.anch)));
const n0 = card(R.proj, "now:p:0"), d0 = card(R.proj, "p:0"), n1 = card(R.proj, "now:p:1");
check(!!n0 && !!d0 && j(n0.rows) === j(["ROW-w0"]) && n0.pin === false && !!n1 && n1.pin === true,
  "R10 경계 — 「프로젝트 없음」도 같은 규칙으로 나뉘고, 그 조각 카드엔 압정이 없다(프로젝트 조각 카드엔 있다)", j([n0, d0 && d0.anch, n1 && n1.pin]));

console.log(`\n#4551 「지금 볼 것」 조각 카드 런타임: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
