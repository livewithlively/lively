#!/usr/bin/env node
// 사이드바 목록은 정본을 받은 뒤에만 그린다 — 실제 side.ts 를 크롬에서 돌려 재는 회귀 테스트 (#3870)
//
//  원준 2026-10-04: "새로고침하면 사이드바에 무슨 기준인지 모르겠는데 로딩이 덜 됐을 때 로딩이 된 뒤의 사실과 다른
//   프로젝트나 세션 이름이 쭉 뜨는데 이상해 해결좀."
//  원인 — 셸의 첫 그림(main.ts «데이터 전 골격»)이 골격이 아니라 목록이었다. 세션 · 프로젝트 목록을 받기 전(data.loadedAt = 0)
//   인데 이 브라우저에 저장돼 있던 창을 줄로 세우고, 숫자와 «없어요» 안내까지 말했다(web/lib/side-boot.ts 머리말).
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  A1 잣대 — 자료가 없거나(null · undefined · {}) loadedAt 이 0 · null 이면 «못 받았다»
//  A2 잣대 — loadedAt 이 1(경계) 이상이면 «받았다»
//  A3 막대 — 세 줄 이상 · 폭 1~100% · 길이가 서로 다르다
//  V1 다섯 축(프로젝트 · 리스트 · 세션 · 기록 · 인스턴스)을 다 받았으면 첫 판이든 몇 판째든 «그려도 된다»
//  V2 한 축이라도 못 받았으면 «기다린다» — 축마다(다섯 다 따로)
//  V3 포기는 판 수와 시간 **둘 다** 찼을 때만 — 판만 찼거나(클릭 · 스트림이 몇 초 만에 세 판을 채운다) 시간만 찼으면 기다린다.
//     정확히 상한(세 판 · 15,000ms)에서 바뀐다
//  K1 장부 — 첫 판에 다 받으면 그 판부터 «받았다»
//  K2 장부 — 한 번 «받았다» 가 되면 그 뒤 판이 전부 실패해도 안 돌아간다(막대로 깜빡이지 않는다)
//  K3 장부 — 못 받은 판은 «못 받았다 · 실패» 로 답하고, 판 수 · 시간이 차면 포기해 «받았다» 가 된다(그 뒤로도 유지)
//  K4 장부 — 늦게 온 축(인스턴스만 둘째 판에)이 오면 그 판부터 «받았다»
//  V4 배선 — 셸(main.ts loadData)이 그 장부로만 loadedAt 을 찍는다: 실패한 첫 판이 «받았다» 가 되지 않는다
//  F1 받으려다 실패한 판이 있었으면 막대 아래에 못 받았다고 말한다 / 아직 한 판도 안 끝났으면 말하지 않는다
//  H1 홈 · 받기 전 · 셸이 줄을 내밀어도(저장돼 있던 창) 한 줄도 안 선다 — 그 이름이 화면에 없다
//  H2 홈 · 받기 전 · 「앱 N」 숫자가 없다 / «열린 앱이 없어요» 도 없다(줄이 0개여도) / 자리 표시 막대가 선다
//  H3 홈 · 받기 전엔 셸에 줄을 묻지도 않는다(hooks.instances 호출 0)
//  H4 홈 · 받기 전에 다시 그려도(묶기 단추) 줄이 안 선다
//  H5 홈 · 받은 뒤 — 줄 · 숫자가 서고 막대는 없다
//  H6 홈 · 받은 뒤 줄이 0개면 «열린 앱이 없어요» — 받은 뒤의 «없다» 는 사실이다
//  S1 세션 목록 · 받기 전 — «아직 세션이 없어요» 도 「전체 0」 도 없다 · 막대
//  S2 세션 목록 · 받은 뒤 0건 — «아직 세션이 없어요» · 「전체 0」
//  P1 프로젝트 · 받기 전 — «아직 리스트가 없어요» 도 「전체 0」 도 없다 · 막대
//  P2 프로젝트 · 받은 뒤 0건 — «아직 리스트가 없어요» · 「전체 0」
//  P3 프로젝트 · 프로젝트만 오고 리스트가 아직(받기 전) — 「기타 (미분류) N」 줄이 안 선다 / 받은 뒤엔 선다
//  T1 발치 「휴지통」 숫자 — 받기 전엔 없다 · 받은 뒤엔 선다
//  C1 막대는 실제 스타일시트에서 보인다(높이 · 폭 · 바탕이 있다) — 클래스만 달고 CSS 가 없으면 빈칸이다
//  W1 배선 — 셸이 내민 줄이 실제로 화면까지 가는 길이 살아 있다(H5 가 겸한다: 받은 뒤엔 그 이름이 선다).
//   이게 없으면 H1 은 «원래 아무것도 안 그리는 페이지» 에서도 초록이다.
//  (E1 «첫 목록 응답이 전부 실패해도 막대에 갇히지 않는다» 는 main.ts loadData 의 몫이라 매니지드 헤드리스로 확인했다.)
//
// 왜 런타임인가: 고친 자리는 «무엇을 DOM 에 세우나» 다. 문자열 검사로는 구역이 셋이고 숫자 자리가 넷인 것을 못 잡는다.
// fail-first(2026-10-04): 고치기 전 side.ts · 40-v2.css(SIDE_SRC · V2_CSS 로 origin/main 판을 물림)에서 8건 빨강
//  (H1~H4 · S1 · P1 · T1 · C1 — 받기 전 화면에 «STALE-ALPHA» 두 줄 · 「앱 2」 · 「전체 0」 · 「휴지통 1」 이 서 있었다).
//  변이 7종도 빨강: 홈 붓의 판정 제거(H1~H4 · C1) · bootKids 빈 배열(H2 · H4 · S1 · P1 · C1) · 막대 CSS 삭제(C1) ·
//   잣대가 늘 참(A1 외 8) · 경계 > 0 → > 1(A2) · 휴지통 숫자 판정 제거(T1) · 세션 목록 판정 제거(S1).
//  2차(실패한 첫 판 · 리뷰 반영): 옛 main.ts(MAIN_SRC)에서 V4 빨강. 변이도 빨강 — 판 상한 >= → > · 시간 조건 제거 · 인스턴스 축을 안 봄 ·
//   장부가 안 붙든다(실패한 판에 되돌아감) · 실패 안내 제거 · 실패 안내가 늘 뜸 · 셸이 인스턴스 축을 안 넘김.
// ⚠ 글자는 ASCII 만 쓴다(줄 이름) — 글꼴 없는 면에서 한글 조판이 크롬을 죽인 적이 있다(side-past-dim-runtime 머리말).
// 크롬이 없는 면에서는 런타임 절을 조용히 건너뛴다.
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

// ───────────────────────── A. 잣대
const LIB = process.env.SIDE_BOOT_SRC || path.join(ROOT, "web/lib/side-boot.ts");
if (!existsSync(LIB)) { bad("A0 web/lib/side-boot.ts 가 있다", "없다 — «받았나» 를 가르는 잣대가 없다"); }
else {
  const out = mkdtempSync(path.join(tmpdir(), "side-boot-"));
  execFileSync(path.join(ROOT, "node_modules/.bin/tsc"),
    [LIB, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
  const { sideTruthReady, SIDE_BOOT_BARS, sideTruthVerdict, createSideTruth, SIDE_BOOT_GIVEUP_ROUNDS: G, SIDE_BOOT_GIVEUP_MS: MS } = await import(path.join(out, "side-boot.js"));
  check([null, undefined, {}, { loadedAt: 0 }, { loadedAt: null }].every((d) => sideTruthReady(d) === false),
    "A1 자료 없음 · loadedAt 0 = 못 받았다");
  check(sideTruthReady({ loadedAt: 1 }) === true && sideTruthReady({ loadedAt: Date.now() }) === true,
    "A2 loadedAt 1 이상 = 받았다");
  check(Array.isArray(SIDE_BOOT_BARS) && SIDE_BOOT_BARS.length >= 3 && SIDE_BOOT_BARS.every((w) => w > 0 && w <= 100) && new Set(SIDE_BOOT_BARS).size > 1,
    "A3 막대는 세 줄 이상 · 폭 1~100% · 길이가 서로 다르다");
  if (typeof sideTruthVerdict !== "function" || typeof createSideTruth !== "function" || !(G >= 2) || !(MS > 0)) bad("V0 lib/side-boot 가 sideTruthVerdict · createSideTruth · SIDE_BOOT_GIVEUP_ROUNDS · _MS 를 내보낸다", "없다");
  else {
    const all = { projects: true, lists: true, sessions: true, logs: true, instances: true };
    const none = { projects: false, lists: false, sessions: false, logs: false, instances: false };
    const missing = Object.keys(all).map((k) => ({ ...all, [k]: false }));
    check(Object.keys(all).length === 5 && [[1, 0], [2, 100], [G, MS], [G + 5, MS * 9]].every(([r, ms]) => sideTruthVerdict(all, r, ms) === "ready"),
      "V1 다섯 축을 다 받았으면 몇 판째든 그려도 된다");
    check(missing.every((ax) => sideTruthVerdict(ax, 1, 0) === "wait" && sideTruthVerdict(ax, G - 1, MS * 9) === "wait") && sideTruthVerdict(none, 1, 0) === "wait",
      "V2 한 축이라도 못 받았으면 기다린다(다섯 축 각각)", JSON.stringify(missing.map((ax) => sideTruthVerdict(ax, 1, 0))));
    check(missing.every((ax) => sideTruthVerdict(ax, G, MS) === "giveup" && sideTruthVerdict(ax, G + 4, MS + 1) === "giveup")
      && sideTruthVerdict(none, G + 9, MS - 1) === "wait" && sideTruthVerdict(none, G - 1, MS) === "wait" && sideTruthVerdict(none, G, MS - 1) === "wait",
      "V3 포기는 판 수와 시간이 둘 다 찼을 때만 — 정확히 상한에서 바뀐다");
    const T0 = 1_000_000;
    { const t = createSideTruth(); const a = t.note(all, T0);
      check(t.ready() === true && a.ready === true && a.failed === false, "K1 첫 판에 다 받으면 그 판부터 받았다"); }
    { const t = createSideTruth(); t.note(all, T0);
      const later = [t.note(none, T0 + 8000), t.note(none, T0 + 16000), t.note(none, T0 + 999000)];
      check(later.every((x) => x.ready === true && x.failed === false) && t.ready() === true, "K2 한 번 받았으면 그 뒤 실패한 판이 와도 안 돌아간다", JSON.stringify(later)); }
    { const t = createSideTruth(); const seq = [];
      seq.push(t.note(none, T0)); seq.push(t.note(none, T0 + 300)); seq.push(t.note(none, T0 + 600)); seq.push(t.note(none, T0 + 900));   // 몇 초 만에 네 판
      const fast = seq.every((x) => x.ready === false && x.failed === true) && t.ready() === false;
      const edge = t.note(none, T0 + MS - 1), gave = t.note(none, T0 + MS), after = t.note(none, T0 + MS + 8000);
      check(fast && edge.ready === false && gave.ready === true && gave.failed === false && after.ready === true,
        "K3 못 받은 판은 실패로 답하고, 판 수 · 시간이 차면 포기해 그린다", JSON.stringify([seq, edge, gave, after])); }
    { const t = createSideTruth(); const a = t.note({ ...all, instances: false }, T0), b = t.note(all, T0 + 8000);
      check(a.ready === false && a.failed === true && b.ready === true, "K4 늦게 온 축(인스턴스)이 오면 그 판부터 받았다", JSON.stringify([a, b])); }
  }
  //  V4 — 셸이 loadedAt 을 **무조건** 찍지 않고 장부에 다섯 축을 넘긴다. 주석을 걷고 본다(설명 주석의 낱말이 거짓 초록을 만든다).
  const MAIN = readFileSync(process.env.MAIN_SRC || path.join(ROOT, "web/v2/main.ts"), "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
  const stamps = MAIN.match(/^\s*data = \{[^\n]*loadedAt:[^\n]*$/gm) || [];
  const noted = /\.note\(\{([^}]*)\}/.exec(MAIN);
  check(stamps.length === 1 && !/loadedAt:\s*Date\.now\(\)\s*[,}]/.test(stamps[0]) && /createSideTruth\(\)/.test(MAIN)
    && !!noted && ["projects", "lists", "sessions", "logs", "instances"].every((k) => new RegExp("\\b" + k + ":").test(noted[1])),
    "V4 셸은 장부(createSideTruth)가 허락할 때만 loadedAt 을 찍고, 다섯 축을 다 넘긴다", `loadedAt 을 찍는 줄 ${stamps.length}개 · note 인자: ${noted ? noted[1].trim().slice(0, 160) : "없음"}`);
}

// ───────────────────────── 런타임
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 사이드바 첫 그림 런타임 검증 미실행"); done(); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const SRC = process.env.SIDE_SRC || path.join(ROOT, "web/v2/side.ts");
const bundle = execFileSync(ESBUILD, [SRC, "--bundle", "--format=iife", "--global-name=Side", "--platform=browser", "--log-level=error"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const CSS = ["01-base.css", "40-v2.css", "47-v2-rail.css"].map((f) =>
  readFileSync(f === "40-v2.css" && process.env.V2_CSS ? process.env.V2_CSS : path.join(ROOT, "public/styles", f), "utf8")).join("\n");

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${CSS.replace(/<\/style/gi, "<\\/style")}
  html,body{margin:0} #v2-root{display:block} .v2-side{width:300px;height:800px}
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
    //  셸이 받기 전에 내밀던 줄 — 저장돼 있던 창(main.ts sideInstances ③)이 만드는 모양 그대로.
    const row = (id, title) => ({ id: 'sess:' + id, title, active: false, icon: 'chat', meta: 'AI', project: null, owner: null, ask: null,
      status: null, pinned: false, past: false, group: 'TODAY-GROUP', rank: 9, at: Date.now() });
    const stale = [row('a', 'STALE-ALPHA'), row('b', 'STALE-BRAVO')];
    let sec = 'home', rows = stale, calls = 0;
    const hooks = { section: () => sec, instances: () => { calls++; return rows; }, navHost: () => null, railHidden: () => false };
    const trashed = { id: 7, name: 'TRASHED-PROJ', status: null, status_category: null, list_id: null, trashed_at: '2026-10-01T00:00:00Z', archived_at: null, member_ids: [] };
    const before = { projects: [trashed], sessions: [], lists: [], folders: [], loadedAt: 0 };
    const after  = { projects: [trashed], sessions: [], lists: [], folders: [], loadedAt: 1700000000000 };
    const draw = async (d) => { Side.drawSide(host, d, () => '', hooks); await sleep(30); };
    const q = (s) => host.querySelector(s);
    const n = (s) => host.querySelectorAll(s).length;
    const txt = (s) => { const e = q(s); return e ? e.textContent : null; };
    const snap = () => ({ text: host.textContent || '', rows: n('.v2-app-inst'), boot: n('.v2-side-boot'), bars: n('.v2-side-boot > i'),
      note: n('.v2-side-boot-note'), noneRow: n('.v2-ptl--none'), empty: n('.v2-app-empty') + n('.v2-empty'), count: txt('.v2-app-count'), allCnt: txt('.v2-kviews .v2-cnt'), dockN: txt('.v2-dock-n') });

    // ── 홈
    sec = 'home'; rows = stale; calls = 0;
    await draw(before); R.h_pre = snap(); R.h_pre_calls = calls;
    const bar = q('.v2-side-boot > i'), box = q('.v2-side-boot');
    if (bar && box) { const cs = getComputedStyle(bar), b = bar.getBoundingClientRect(), bx = box.getBoundingClientRect();
      R.c1 = { h: b.height, w: b.width, boxW: bx.width, bg: cs.backgroundColor }; }
    const axis = q('.v2-axisbtn');
    if (axis) { axis.click(); await sleep(30); R.h_pre_repaint = snap(); const again = q('.v2-axisbtn'); if (again) again.click(); await sleep(30); }
    rows = []; await draw(before); R.h_pre_none = snap();
    await draw({ ...before, loadFailed: true }); R.h_pre_failed = snap();
    rows = stale; await draw(after); R.h_post = snap();
    rows = []; await draw(after); R.h_post_none = snap();
    // ── 세션 목록
    sec = 'sess'; await draw(before); await sleep(60); R.s_pre = snap();
    await draw(after); await sleep(60); R.s_post = snap();
    // ── 프로젝트
    sec = 'proj'; await draw({ ...before, projects: [] }); await sleep(60); R.p_pre = snap();
    await draw({ ...after, projects: [] }); await sleep(60); R.p_post = snap();
    const loose = { id: 9, name: 'LOOSE-PROJ', status: null, status_category: null, list_id: null, trashed_at: null, archived_at: null, member_ids: [] };
    await draw({ ...before, projects: [loose], loadFailed: true }); await sleep(60); R.p_pre_loose = snap();
    await draw({ ...after, projects: [loose] }); await sleep(60); R.p_post_loose = snap();
  } catch (e) { R.error = String((e && e.stack) || e).slice(0, 600); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script></html>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "side-boot-", args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-600)); process.exit(1); }
const R = JSON.parse(m[1]);
if (R.error) { console.error("FAIL  페이지 예외 — " + R.error); process.exit(1); }
const j = (o) => JSON.stringify(o, (k, v) => (k === "text" ? String(v).slice(0, 80) : v));
const snaps = ["h_pre", "h_pre_none", "h_post", "h_post_none", "s_pre", "s_post", "p_pre", "p_post"];
if (!snaps.every((k) => R[k])) { console.error("FAIL  장면을 다 못 찍었다 — " + snaps.filter((k) => !R[k]).join(",")); process.exit(1); }

// ───────────────────────── H. 홈
check(R.h_pre.rows === 0 && !/STALE-/.test(R.h_pre.text), "H1 홈 · 받기 전 — 셸이 내민 줄(저장돼 있던 창)이 한 줄도 안 선다", j(R.h_pre));
check(R.h_pre.count === null && R.h_pre.empty === 0 && R.h_pre.boot === 1 && R.h_pre.bars >= 3
  && R.h_pre_none.count === null && R.h_pre_none.empty === 0 && R.h_pre_none.boot === 1,
  "H2 홈 · 받기 전 — 숫자도 «열린 앱이 없어요» 도 없고 자리 표시 막대가 선다(줄 0개여도)", j([R.h_pre, R.h_pre_none]));
check(R.h_pre_calls === 0, "H3 홈 · 받기 전엔 셸에 줄을 묻지 않는다", `hooks.instances 호출 ${R.h_pre_calls}회`);
check(!!R.h_pre_repaint && R.h_pre_repaint.rows === 0 && !/STALE-/.test(R.h_pre_repaint.text) && R.h_pre_repaint.boot === 1,
  "H4 홈 · 받기 전에 다시 그려도 줄이 안 선다", j(R.h_pre_repaint || "묶기 단추를 못 찾았다"));
check(R.h_post.rows === 2 && /STALE-ALPHA/.test(R.h_post.text) && /STALE-BRAVO/.test(R.h_post.text) && R.h_post.count === "2" && R.h_post.boot === 0,
  "H5 · W1 홈 · 받은 뒤 — 줄 · 숫자가 서고 막대는 없다(셸의 줄이 화면까지 간다)", j(R.h_post));
check(R.h_post_none.rows === 0 && R.h_post_none.empty === 1 && R.h_post_none.boot === 0 && R.h_post_none.count === "0",
  "H6 홈 · 받은 뒤 줄 0개 — «열린 앱이 없어요»", j(R.h_post_none));

// ───────────────────────── S · P. 세션 목록 · 프로젝트
check(R.s_pre.empty === 0 && R.s_pre.allCnt === null && R.s_pre.boot === 1, "S1 세션 목록 · 받기 전 — 빈 안내 · 「전체 0」 없음 · 막대", j(R.s_pre));
check(R.s_post.empty === 1 && R.s_post.allCnt === "0" && R.s_post.boot === 0, "S2 세션 목록 · 받은 뒤 0건 — 빈 안내 · 「전체 0」", j(R.s_post));
check(R.p_pre.empty === 0 && R.p_pre.allCnt === null && R.p_pre.boot === 1, "P1 프로젝트 · 받기 전 — 빈 안내 · 「전체 0」 없음 · 막대", j(R.p_pre));
check(R.p_post.empty === 1 && R.p_post.allCnt === "0" && R.p_post.boot === 0, "P2 프로젝트 · 받은 뒤 0건 — 빈 안내 · 「전체 0」", j(R.p_post));
check(!!R.p_pre_loose && R.p_pre_loose.noneRow === 0 && R.p_pre_loose.allCnt === null && R.p_pre_loose.boot === 1 && !!R.p_post_loose && R.p_post_loose.noneRow === 1,
  "P3 프로젝트 · 리스트를 받기 전엔 「기타 (미분류)」 줄이 안 선다 · 받은 뒤엔 선다", j([R.p_pre_loose, R.p_post_loose]));

// ───────────────────────── F. 못 받았다고 말하나
check(!!R.h_pre_failed && R.h_pre_failed.boot === 1 && R.h_pre_failed.note === 1 && R.h_pre_failed.rows === 0 && R.h_pre_failed.empty === 0
  && R.h_pre.note === 0 && R.h_post.note === 0,
  "F1 실패한 판이 있었으면 막대 아래에 못 받았다고 말한다 · 첫 판 전과 받은 뒤엔 말하지 않는다", j([R.h_pre_failed, R.h_pre.note, R.h_post.note]));

// ───────────────────────── T. 발치 휴지통 숫자
check(R.h_pre.dockN === null && R.s_pre.dockN === null && R.h_post.dockN === "1", "T1 「휴지통」 숫자 — 받기 전엔 없고 받은 뒤엔 선다", j([R.h_pre.dockN, R.s_pre.dockN, R.h_post.dockN]));

// ───────────────────────── C. 막대가 실제로 보이나
check(!!R.c1 && R.c1.h >= 6 && R.c1.w >= 40 && R.c1.w < R.c1.boxW && !/rgba\(0, 0, 0, 0\)|transparent/.test(R.c1.bg),
  "C1 막대는 실제 스타일시트에서 보인다(높이 · 폭 · 바탕)", j(R.c1 || "막대가 없다"));

done();
