#!/usr/bin/env node
// 앱빌더 만들기 화면 — 꺼진 만들기 세션에 보낸 글이 AI 에게 닿게(#4632) · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-28 «앱빌더 안에서 수정했을 때 제대로 AI세션 안에까지 안들어가는거같아 특히 AI를 꺼둔 상태일때».
//  원인(코드): 되살리기(POST …/restore)는 **새 세션 id** 를 세우고 대화 · 못 간 글을 그리로 옮긴다. 그런데 화면은 응답을 버리고 옛 id 에
//   계속 보냈다(꺼진 세션의 아웃박스에 쌓여 AI 에게 안 닿음) · 옛 기록만 읽었다(답을 못 봄) · 꺼진 세션에도 그냥 보내고 «수정하고 있어요» 를 띄웠다.
//
// 엣지 표:
//  V1 꺼진 세션(restorable)에 ② 「수정하기」 — 되살리기 한 번 → 글은 새 세션으로 · 기록 · 주소(onSession)도 새 세션
//  V2 이어서 읽기 — 옮긴 뒤 답(기록)과 세션 상태를 새 세션에서 읽는다
//  V3 살아 있는 세션 — 되살리지 않고 그 세션에 보낸다
//  V4 상태를 못 읽음 — 되살리지 않고 보낸다(모르면 막지 않는다)
//  V5 세션이 꺼져 멈춤 막대 → 「이어서 만들기」 — 되살리기 한 번 · 이어 하라는 글은 새 세션으로
//  V6 되살리기가 실패 — 보내지 않고 까닭을 알린다(꺼진 세션에 그냥 보내지 않는다)
//  W  페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 V1 · V2 · V5 · V6 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 세션 되살리기 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
//  window.__rows — 세션 id → 줄(없으면 줄 없음 · "fail" 이면 500). __restore — 되살리기 응답(null 이면 500).
//  __log — [종류, 세션 id] : row · restore · prompt · transcript.
const FETCH = `<script>window.__log = []; window.__rows = {}; window.__restore = null;
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  const sidOf = (re) => { const m = re.exec(p); return m ? decodeURIComponent(m[1]) : ""; };
  if (/\\/prompt$/.test(p) && method === "POST") { window.__log.push(["prompt", sidOf(/sessions\\/([^/]+)\\/prompt/)]); return j({ ok: true, queued: true, outbox_id: 1, seq: 1 }); }
  if (/\\/restore$/.test(p) && method === "POST") { window.__log.push(["restore", sidOf(/sessions\\/([^/]+)\\/restore/)]); return window.__restore ? j(window.__restore) : j({ error: "막힘" }, 500); }
  if (p.includes("/transcript")) { window.__log.push(["transcript", sidOf(/sessions\\/([^/]+)\\/transcript/)]); return new Response("", { status: 200, headers: { "X-Log-To": "5" } }); }
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p.startsWith("/api/ui/terminal/sessions?only=")) {
    const sid = decodeURIComponent((/only=([^&]+)/.exec(p) || [])[1] || "");
    window.__log.push(["row", sid]);
    const r = window.__rows[sid];
    if (r === "fail") return j({ error: "x" }, 500);
    return j({ sessions: r ? [Object.assign({ id: sid }, r)] : [] });
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
  const base = { sid: "box-s1", pid: 0, what: "회의 녹음 정리", place: "both", appId: "", draftId: "mn", known: [], at: Date.now() - 3600000, stage: "plan", card: window.__CARD, round: 0, from: 5, mode: "new", title: "회의록", named: true, reached: 1 };
  let sessions = [];
  const mount = async (rec, rows, restore) => {
    St.closeAppStudio(); window.__rows = rows; window.__restore = restore; window.__log.length = 0; sessions = [];
    localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec]));
    St.openAppStudio({ sid: rec.sid }, { host, onClose: () => {}, onSee: () => {}, onSession: (sid) => sessions.push(sid) });
    await sleep(1500);
  };
  const ask = async (t) => {
    const i = $(".v2-studio-ask-in"); if (!i) return false;
    i.value = t; i.dispatchEvent(new Event("input"));
    const b = $$(".v2-studio-ask button").find((n) => /수정하기/.test(n.textContent)); if (!b) return false;
    b.click(); await sleep(2500); return true;
  };
  const press = async (re) => { const b = $$(".v2-studio-now button").find((n) => re.test(n.textContent)); if (b && !b.disabled) b.click(); await sleep(2500); return !!b; };
  const recs = () => JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").map((r) => r.sid);
  const not = (k) => window.__log.filter((x) => x[0] !== k);

  window.__step = "V1";
  await mount({ ...base }, { "box-s1": { agentState: "offline", restorable: true }, "box-s2": { agentState: "idle" } },
    { ok: true, resumed: "conversation", session: { id: "box-s2", label: "\"회의록\" 앱 제작" } });
  R.v1 = { asked: await ask("담당자 칸 추가") };
  R.v1.calls = not("row").filter((x) => x[0] !== "transcript"); R.v1.recs = recs(); R.v1.sessions = sessions.slice();
  window.__step = "V2";
  window.__log.length = 0;
  await sleep(12000);   // 답 읽기(2.5초마다) — 새 세션 기록에서
  R.v2 = { transcript: [...new Set(window.__log.filter((x) => x[0] === "transcript").map((x) => x[1]))] };
  window.__step = "V3";
  await mount({ ...base }, { "box-s1": { agentState: "idle" } }, null);
  R.v3 = { asked: await ask("더 단순하게") };
  R.v3.calls = not("row").filter((x) => x[0] !== "transcript");
  window.__step = "V4";
  await mount({ ...base }, { "box-s1": "fail" }, null);
  R.v4 = { asked: await ask("더 단순하게") };
  R.v4.calls = not("row").filter((x) => x[0] !== "transcript");
  window.__step = "V5";
  await mount({ ...base, stage: "draft", reached: 2 }, { "box-s1": { agentState: "offline", restorable: true }, "box-s2": { agentState: "busy", working: true } },
    { ok: true, resumed: "conversation", session: { id: "box-s2" } });
  await sleep(32000);
  R.v5 = { now: txt($(".v2-studio-now-t")), pressed: await press(/이어서 만들기/) };
  R.v5.calls = not("row").filter((x) => x[0] !== "transcript"); R.v5.recs = recs();
  window.__log.length = 0;
  await sleep(11000);
  R.v5.rowsAfter = [...new Set(window.__log.filter((x) => x[0] === "row").map((x) => x[1]))];
  window.__step = "V6";
  await mount({ ...base }, { "box-s1": { agentState: "offline", restorable: true } }, null);
  R.v6 = { asked: await ask("담당자 칸 추가") };
  R.v6.calls = not("row").filter((x) => x[0] !== "transcript"); R.v6.recs = recs();
  R.v6.toast = txt(document.getElementById("toasts"));
  St.closeAppStudio();
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

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-revive-", virtualTimeBudget: 200000, args: ["--window-size=1200,900"] });
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

check(R.v1 && R.v1.asked, "V1 ② 「수정하기」 칸이 선다", R.v1);
same(R.v1 && R.v1.calls, [["restore", "box-s1"], ["prompt", "box-s2"]], "V1 꺼진 세션 — 먼저 되살리고 글은 새 세션으로");
same(R.v1 && R.v1.recs, ["box-s2"], "V1 기록도 새 세션으로(옛 세션 기록은 걷는다)");
same(R.v1 && R.v1.sessions, ["box-s2"], "V1 앱빌더 주소도 새 세션으로(onSession)");
same(R.v2 && R.v2.transcript, ["box-s2"], "V2 답은 새 세션 기록에서 읽는다");
same(R.v3 && R.v3.calls, [["prompt", "box-s1"]], "V3 살아 있는 세션 — 되살리지 않고 그 세션에");
same(R.v4 && R.v4.calls, [["prompt", "box-s1"]], "V4 상태를 못 읽으면 — 되살리지 않고 보낸다");
check(R.v5 && /세션이 꺼져서/.test(R.v5.now || "") && R.v5.pressed, "V5 세션이 꺼져 멈춤 막대 · 「이어서 만들기」", R.v5);
same(R.v5 && R.v5.calls, [["restore", "box-s1"], ["prompt", "box-s2"]], "V5 「이어서 만들기」 — 되살리기 한 번 · 이어 하라는 글은 새 세션으로");
same(R.v5 && R.v5.recs, ["box-s2"], "V5 기록도 새 세션으로");
same(R.v5 && R.v5.rowsAfter, ["box-s2"], "V5 그 뒤 세션 상태도 새 세션에서 본다");
same(R.v6 && R.v6.calls, [["restore", "box-s1"]], "V6 되살리기 실패 — 꺼진 세션에 그냥 보내지 않는다");
check(R.v6 && /다시 켜지 못해/.test(R.v6.toast || ""), "V6 까닭을 알린다", R.v6);
same(R.v6 && R.v6.recs, ["box-s1"], "V6 기록은 그대로");
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 앱빌더 꺼진 세션 되살려 보내기: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
