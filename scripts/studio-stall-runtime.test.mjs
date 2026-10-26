#!/usr/bin/env node
// 앱빌더 만들기 화면 — 기다리던 AI 일이 멈춘 걸 알아보고 이어서 하게(#4632) · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-26 «앱 빌더에서 회의록 앱 아침에 맡긴거 AI가 초안을 만들고 있어요(시작하는 중). 몇 분 걸려요. 이상태에서 진전이 안되는데?»
//  실측: 만들기 세션이 돌던 노트북이 잠들어 턴이 끝났다(«Your computer went to sleep mid-response»). 화면은 몇 시간째 «만들고 있어요» 였고,
//   새로 열면 이미 받은 [[걸음 3/4]] 를 잊고 «시작하는 중» 으로 돌아갔다. 판정 표(runStall)는 app-studio-flow.test.mjs S 가 잰다.
//
// 엣지 표(스크래치패드 spec-run-stall.md):
//  T1 걸음 3 을 받아 둔 기록 — 새로 열어도 「자료 표 만드는 중」   T2 걸음이 없는 옛 기록 — 「시작하는 중」(종전 그대로)
//  T3 세션이 돈다 — 40초가 지나도 멈췄다 하지 않는다   T4 턴이 끝남(idle) — 29초엔 아직 · 31초엔 막대 · 가운데 판이 멈춤으로
//  T5 「이어서 만들기」 — 이어서 하라는 글(걸음 표식 · app_save) 1건 · 멈춤 표시를 걷는다 · 60초 동안 다시 말하지 않는다
//  T6 컴퓨터가 꺼짐 — 컴퓨터 이름 · 단추 잠김   T7 세션이 꺼짐(줄 없음) — 되살리기 뒤 글   T8 확인을 기다림 — 「AI 세션 보기」
//  T9 지어낸 줄(observed:false) — 멈췄다 하지 않는다   T10 상태를 못 읽음 — 멈췄다 하지 않는다
//  T11 막 연 만들기 — 2분 동안은 말하지 않는다   T12 ② 카드 기다림 · 다시 돌면 걷힌다   T13 닫으면 더 묻지 않는다   W 페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 T1 · T4~T8 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 멈춤 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
//  window.__row — 세션 한 줄(undefined 면 줄 없음 · "fail" 이면 500). __calls — 세션 상태 조회 · 되살리기 · 보낸 글.
const FETCH = `<script>window.__prompts = []; window.__calls = []; window.__row = { agentState: "busy", working: true };
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  if (/\\/prompt$/.test(p) && method === "POST") { let t = ""; try { t = JSON.parse(init.body).text || ""; } catch (_) {} window.__prompts.push(t); window.__calls.push("prompt"); return j({ ok: true }); }
  if (/\\/restore$/.test(p) && method === "POST") { window.__calls.push("restore"); return j({ ok: true }); }
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p.startsWith("/api/ui/terminal/sessions?only=")) {
    window.__calls.push("row");
    if (window.__row === "fail") return j({ error: "x" }, 500);
    return j({ sessions: window.__row ? [Object.assign({ id: "box-s1" }, window.__row)] : [] });
  }
  if (/^\\/api\\/ui\\/apps\\/mn(\\?|$)/.test(p)) return j({ app: { id: "mn", title: "", empty: true, visibility: "me" } });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (p.startsWith("/api/ui/apps")) return j({ apps: [] });
  if (p.includes("sessions")) return j({ sessions: [] });
  return j({});
};</script>`;

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const host = document.getElementById("host");
  const $ = (s) => host.querySelector(s), $$ = (s) => [...host.querySelectorAll(s)];
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ intro: 1, coach: { plan: 1, draft: 1, check: 1, put: 1 } }));
  const base = { sid: "box-s1", pid: 0, what: "회의 녹음 정리", place: "both", appId: "", draftId: "mn", known: [], at: Date.now() - 3600000, stage: "draft", card: window.__CARD, round: 0, from: 5, mode: "new", title: "회의록", named: true, reached: 2 };
  const view = () => ({ now: txt($(".v2-studio-now-t")), btns: $$(".v2-studio-now button").map((b) => [txt(b), b.disabled]), wait: txt($(".v2-studio-wait b")), spin: !!$(".v2-studio-wait .v2-studio-spin"),
    steps: $$(".v2-studio-steps span").map((n) => (n.classList.contains("done") ? "done" : n.classList.contains("on") ? "on" : "todo")) });
  const mount = async (rec, row) => {
    St.closeAppStudio(); window.__row = row; window.__prompts.length = 0; window.__calls.length = 0;
    localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec]));
    St.openAppStudio({ sid: rec.sid }, { host, onClose: () => {}, onSee: () => {} });
    await sleep(1500);
  };
  const press = async (re) => { const b = $$(".v2-studio-now button").find((n) => re.test(n.textContent)); if (b && !b.disabled) b.click(); await sleep(800); return !!b; };

  window.__step = "T1";
  await mount({ ...base, step: 3 }, { agentState: "busy", working: true });
  R.t1 = view();
  window.__step = "T2";
  await mount({ ...base }, { agentState: "busy", working: true });
  R.t2 = view();
  window.__step = "T3";
  await sleep(40000);
  R.t3 = { ...view(), rows: window.__calls.filter((c) => c === "row").length };
  window.__step = "T4";
  await mount({ ...base, step: 3 }, { agentState: "idle" });
  await sleep(28000);   // 첫 조회(열고 바로) 뒤 ~29.5초
  R.t4 = { early: view() };
  await sleep(1500 + 1500);   // ~31초
  R.t4.late = view();
  window.__step = "T5";
  R.t5 = { pressed: await press(/이어서 만들기/) };
  R.t5.prompts = window.__prompts.slice(); R.t5.calls = window.__calls.filter((c) => c !== "row"); R.t5.after = view();
  await sleep(45000);   // 아직 멈춘 줄이 와도 60초 동안은 다시 말하지 않는다
  R.t5.quiet = view();
  R.t5.rec = (JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]")[0] || {}).step;
  window.__step = "T6";
  await mount({ ...base }, { agentState: "offline", node: { id: "lvlyui-macbookair", name: "LVLYui-MacBookAir.local", online: false } });
  await sleep(32000);
  R.t6 = view();
  window.__step = "T7";
  await mount({ ...base }, undefined);
  await sleep(32000);
  R.t7 = { v: view(), pressed: await press(/이어서 만들기/) };
  R.t7.calls = window.__calls.filter((c) => c !== "row");
  window.__step = "T8";
  await mount({ ...base }, { agentState: "waiting", awaiting: true });
  await sleep(32000);
  R.t8 = view();
  window.__step = "T9";
  await mount({ ...base }, { agentState: "offline", observed: false });
  await sleep(32000);
  R.t9 = { ...view(), rows: window.__calls.filter((c) => c === "row").length };
  window.__step = "T10";
  await mount({ ...base }, "fail");
  await sleep(32000);
  R.t10 = { ...view(), rows: window.__calls.filter((c) => c === "row").length };
  window.__step = "T11";
  //  막 연 만들기(세션이 뜨는 중) — 턴이 안 돌아도 2분 동안은 멈췄다 하지 않는다 · 그 뒤엔 말한다
  await mount({ ...base, at: Date.now() }, { agentState: "idle" });
  await sleep(110000);
  R.t11 = { early: view() };
  await sleep(80000);   // 2분 뒤부터 30초 이어지면(열고 ~170초)
  R.t11.late = view();
  window.__step = "T12";
  //  멈춤이 뜬 뒤 다른 길로 새 일을 맡겼다(기획 카드 고쳐 달라기) — 지난 멈춤이 곧바로 걷힌다
  await mount({ ...base, stage: "plan", card: null }, { agentState: "idle" });
  await sleep(32000);
  R.t12 = { before: view() };
  window.__row = { agentState: "busy", working: true };
  await sleep(10500);
  R.t12.cleared = view();
  window.__step = "T13";
  //  닫으면 세션 상태를 더 묻지 않는다
  St.closeAppStudio(); window.__calls.length = 0;
  await sleep(30000);
  R.t13 = window.__calls.filter((c) => c === "row").length;
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}
  html,body{margin:0} #host{width:1100px;height:860px;position:relative}
</style>
<div id="host"></div>
<pre id="out">PENDING</pre>
<div id="toasts"></div>
${FETCH}
<script>window.__CARD = ${JSON.stringify(CARD)};</script>
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-stall-", virtualTimeBudget: 600000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, typeof why === "string" ? why : JSON.stringify(why)));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
const stalled = (v) => !!v && /멈췄어요|기다리고 있어요/.test(v.now || "");

check(R.t1 && /자료 표 만드는 중/.test(R.t1.now || "") && JSON.stringify(R.t1.steps) === JSON.stringify(["done", "done", "done", "on"]), "T1 걸음 3 을 받아 둔 기록 — 새로 열어도 「자료 표 만드는 중」(「시작하는 중」 으로 돌아가지 않는다)", R.t1);
check(R.t2 && /시작하는 중/.test(R.t2.now || ""), "T2 걸음이 없는 옛 기록 — 「시작하는 중」(종전 그대로)", R.t2);
check(R.t3 && !stalled(R.t3) && R.t3.spin && R.t3.rows >= 3, "T3 세션이 도는 동안은 40초가 지나도 멈췄다 하지 않는다(상태는 실제로 물었다)", R.t3);
check(R.t4 && !stalled(R.t4.early) && R.t4.early.spin, "T4 턴이 끝나도 30초 전엔 아직 «만들고 있어요»(말을 막 보낸 틈에 잘못 말하지 않게)", R.t4 && R.t4.early);
check(R.t4 && /끝내지 못하고 멈췄어요/.test(R.t4.late.now || "") && R.t4.late.btns.some(([t, d]) => t === "이어서 만들기" && !d), "T4 30초가 넘으면 막대가 멈춤을 말하고 「이어서 만들기」 를 준다", R.t4 && R.t4.late);
check(R.t4 && /멈췄어요/.test(R.t4.late.wait || "") && !R.t4.late.spin && JSON.stringify(R.t4.late.steps) === JSON.stringify(["done", "done", "done", "on"]), "T4 가운데 판도 멈춤으로(도는 표시 없이 · 받은 걸음은 그대로)", R.t4 && R.t4.late);
check(R.t5 && R.t5.pressed && R.t5.prompts.length === 1 && /\[\[걸음 n\/4\]\]/.test(R.t5.prompts[0]) && /app_save/.test(R.t5.prompts[0]) && /이어서/.test(R.t5.prompts[0]), "T5 「이어서 만들기」 — 이어서 하라는 글 1건(걸음 표식 · app_save 를 다시 일러 준다)", R.t5 && R.t5.prompts);
same(R.t5 && R.t5.calls, ["prompt"], "T5 세션이 살아 있으면 되살리지 않고 글만 보낸다");
check(R.t5 && !stalled(R.t5.after) && R.t5.after.spin && !stalled(R.t5.quiet), "T5 보낸 뒤엔 멈춤 표시를 걷고 60초 동안은 다시 말하지 않는다", R.t5 && [R.t5.after, R.t5.quiet]);
same(R.t5 && R.t5.rec, 3, "T5 받은 걸음은 기록에 남아 있다");
check(R.t6 && /LVLYui-MacBookAir\)가 꺼져 있거나 잠들어/.test(R.t6.now || "") && R.t6.btns.some(([t, d]) => t === "이어서 만들기" && d === true), "T6 세션이 돌던 컴퓨터가 꺼짐 — 그 컴퓨터 이름 · 「이어서 만들기」 는 잠김", R.t6);
check(R.t7 && /세션이 꺼져서/.test(R.t7.v.now || "") && R.t7.pressed, "T7 세션이 꺼짐(줄 없음) — 까닭과 「이어서 만들기」", R.t7 && R.t7.v);
same(R.t7 && R.t7.calls, ["restore", "prompt"], "T7 「이어서 만들기」 — 세션을 되살린 뒤 글을 보낸다");
check(R.t8 && /확인을 기다리고 있어요/.test(R.t8.now || "") && R.t8.btns.some(([t]) => t === "AI 세션 보기"), "T8 AI 가 확인을 기다림 — 「AI 세션 보기」", R.t8);
check(R.t9 && !stalled(R.t9) && R.t9.spin && R.t9.rows >= 3, "T9 지어낸 줄(observed:false) — 모르면 멈췄다 하지 않는다", R.t9);
check(R.t10 && !stalled(R.t10) && R.t10.spin && R.t10.rows >= 3, "T10 상태를 못 읽으면 멈췄다 하지 않는다", R.t10);
check(R.t11 && !stalled(R.t11.early) && /끝내지 못하고 멈췄어요/.test(R.t11.late.now || ""), "T11 막 연 만들기는 2분 동안 멈췄다 하지 않는다(세션이 뜨는 틈) · 그 뒤엔 말한다", R.t11);
check(R.t12 && /끝내지 못하고 멈췄어요/.test(R.t12.before.now || "") && !stalled(R.t12.cleared), "T12 ② 카드 기다림도 멈춤을 말하고 · 다시 돌면 걷힌다", R.t12);
same(R.t13, 0, "T13 닫으면 세션 상태를 더 묻지 않는다");
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 앱빌더 멈춤 알아보기: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
