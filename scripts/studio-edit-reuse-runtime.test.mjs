#!/usr/bin/env node
// 앱빌더 「고치기」 — 같은 앱의 고치기 세션을 다시 쓴다 · 만든 앱을 이어 열면 고치기다(#4632 · 태스크 #5089) · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-28 «앱빌더 왜 갑자기 회의록 어플이 두 개가 됐어??? 분명 하나였는데 누구맘대로 갈라졌어??»
//  실측: 「고치기」 를 누를 때마다 새 세션을 열어 앱의 만들기 세션 기록(build_session)이 옮겨 갔고, 앞의 고치기 세션이 「만들던 앱」 에 같은 이름으로 하나 더 섰다.
//  게다가 «이어서» 로 되살린 기록은 늘 mode 'new' 라 세션 이름이 «"회의록" 앱 고치기» → «"회의록" 앱 제작» 으로 되바뀌었다.
//
// 엣지 표(스크래치패드 spec.md 7~10):
//  R1 같은 앱의 고치기 기록이 있고 그 세션이 서버에 있다 — 세션 생성 요청 0건 · 그 기록(세션)으로 연다
//  R2 기록은 있는데 세션이 서버에 없다 — 기록을 걷고 새 세션을 연다(세션 생성 요청 1건)
//  R3 세션 존재 확인이 실패(네트워크) — 있는 것으로 보고 다시 연다(세션 생성 요청 0건)
//  R4 «이어서» 로 공개한 앱을 되살림 — 기록 mode 'edit' · 세션 이름을 «"회의록" 앱 고치기» 로 맞춘다(«제작» 이 아니다)
//  R5 «이어서» 로 아직 안 만든(나만 보는 · 마무리 전) 앱을 되살림 — mode 'new' 그대로(경계)
//  W  페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 R1 · R3 · R4 가 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 고치기 세션 재사용 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  window.__only — ?only= 의 답: "alive"(그 세션 한 줄) · "gone"(빈 목록) · "fail"(500). __spawns — 세션 생성 요청 몸. __labels — 세션 이름 바꾸기 요청(id → label).
//  __vis — 앱의 공개 범위 · __put — 매니페스트 마무리 표시.
const FETCH = `<script>window.__only = "alive"; window.__spawns = []; window.__labels = []; window.__vis = "all"; window.__put = false; window.__n = 0;
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  const APP = () => ({ id: "mn", title: "회의록", status: "active", enabled: true, visibility: window.__vis, made_by: "wonjoon-jang", is_owner: true, can_edit: true, build_session: "box-s1", current_version_no: 3,
    manifest: { title: "회의록", ui: { pages: [{ key: "main", title: "회의록", entry: "ui/index.html" }] }, studio: window.__put ? { put: true, place: "full" } : { place: "full" } } });
  if (p.startsWith("/api/ui/terminal/sessions?only=")) { if (window.__only === "fail") return j({ error: "서버 오류" }, 500); const id = decodeURIComponent(/only=([^&]+)/.exec(p)[1]); return j({ sessions: window.__only === "alive" ? [{ id, label: '"회의록" 앱 고치기', agentState: "idle" }] : [] }); }
  if ((/^\\/api\\/ui\\/v6\\/projects\\/\\d+\\/sessions$/.test(p) || p === "/api/ui/terminal/sessions") && method === "POST") { const b = JSON.parse(init.body || "{}"); window.__spawns.push(b); const id = "box-new-" + (++window.__n); return j({ id, session: { id, label: b.label } }); }
  { const m = /^\\/api\\/ui\\/terminal\\/sessions\\/([^/?]+)$/.exec(p); if (m && method === "POST") { const b = JSON.parse(init.body || "{}"); window.__labels.push({ id: decodeURIComponent(m[1]), label: b.label }); return j({ ok: true }); } }
  if (/\\/prompt$/.test(p) && method === "POST") return j({ ok: true });
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p === "/api/ui/apps/build-start" && method === "POST") return j({ app_id: "mn", bound: true });
  if (/^\\/api\\/ui\\/apps\\/mn\\/versions/.test(p)) return j({ versions: [{ version_no: 3 }, { version_no: 2 }, { version_no: 1 }] });
  if (/^\\/api\\/ui\\/apps\\/mn(\\?|$)/.test(p)) return j({ app: APP() });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (/^\\/api\\/ui\\/apps(\\?|$)/.test(p)) return j({ apps: [APP()] });
  if (p.startsWith("/api/ui/v6/projects")) return j({ projects: [{ id: 4680, name: "앱빌더", status_category: "active" }] });
  if (p.startsWith("/api/ui/v6/sessions")) return j({ sessions: [{ id: "box-s1", label: '"회의록" 앱 제작', agentState: "idle" }] });
  if (p.includes("sessions")) return j({ sessions: [] });
  return j({});
};</script>`;

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = document.getElementById("host");
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ intro: 1, coach: { plan: 1, draft: 1, check: 1, put: 1 } }));
  const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
  const editRec = { sid: "box-s1", pid: 4680, what: "회의록", place: "full", appId: "mn", draftId: "mn", known: [], at: Date.now() - 3600000, card: CARD, round: 1, from: 5, mode: "edit", title: "회의록", named: true, reached: 2, stage: "fix" };
  const recs = () => JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]");
  const reset = (rs) => { St.closeAppStudio(); document.querySelectorAll(".toast").forEach((n) => n.remove()); window.__spawns.length = 0; window.__labels.length = 0; location.hash = "#/builder"; localStorage.setItem("lively_v2_app_studio", JSON.stringify(rs)); };
  const open = async () => { await St.openAppStudioFor({ id: "mn", title: "회의록", by: "wonjoon-jang", place: "full" }, "edit", { host, onClose: () => {}, onSee: () => {} }); await sleep(2500); };
  const shown = () => !!host.querySelector(".v2-studio") && (host.querySelector(".v2-studio-name") || {}).textContent === "회의록";

  window.__step = "R1";
  reset([editRec]); window.__only = "alive";
  await open();
  R.r1 = { spawns: window.__spawns.length, recSids: recs().map((r) => r.sid), shown: shown() };

  window.__step = "R2";
  reset([editRec]); window.__only = "gone";
  await open();
  R.r2 = { spawns: window.__spawns.length, label: window.__spawns[0] && window.__spawns[0].label, oldRec: recs().some((r) => r.sid === "box-s1"), newRec: recs().some((r) => r.sid === "box-new-1" && r.mode === "edit") };

  window.__step = "R3";
  reset([editRec]); window.__only = "fail";
  await open();
  R.r3 = { spawns: window.__spawns.length, recSids: recs().map((r) => r.sid), shown: shown() };

  window.__step = "R4";
  //  기록 없이 «이어서»(다른 브라우저) — 공개한 앱이라 고치기다. 세션 목록엔 «제작» 으로 적혀 있어 다시 맞춘다.
  reset([]); window.__only = "alive"; window.__vis = "all"; window.__put = false;
  St.openAppStudio({ sid: "box-s1", what: "회의록", appId: "mn", title: "회의록" }, { host, onClose: () => {}, onSee: () => {} });
  await sleep(3500);
  const r4 = recs().find((r) => r.sid === "box-s1") || {};
  R.r4 = { mode: r4.mode, named: !!r4.named, labels: window.__labels.map((l) => l.label), spawns: window.__spawns.length };

  window.__step = "R5";
  reset([]); window.__vis = "me"; window.__put = false;
  St.openAppStudio({ sid: "box-s1", what: "회의록", appId: "mn", title: "회의록" }, { host, onClose: () => {}, onSee: () => {} });
  await sleep(3500);
  const r5 = recs().find((r) => r.sid === "box-s1") || {};
  R.r5 = { mode: r5.mode, labels: window.__labels.map((l) => l.label) };

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
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-edit-reuse-", virtualTimeBudget: 60000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (R.crash) { console.error("FAIL  페이지가 죽었다: " + R.crash); process.exit(1); }

let fails = 0;
const ok = (n) => console.log("ok  " + n);
const bad = (n, why) => { fails++; console.error("FAIL  " + n + " — " + why); };
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

same(R.r1, { spawns: 0, recSids: ["box-s1"], shown: true }, "R1 같은 앱의 고치기 세션이 살아 있으면 새 세션을 열지 않고 그 세션으로 연다");
same(R.r2, { spawns: 1, label: '"회의록" 앱 고치기', oldRec: false, newRec: true }, "R2 그 세션이 서버에 없으면 기록을 걷고 새 고치기 세션 하나를 연다");
same(R.r3, { spawns: 0, recSids: ["box-s1"], shown: true }, "R3 세션 존재 확인이 실패하면 있는 것으로 보고 다시 연다(세션을 하나 더 열지 않는다)");
same(R.r4, { mode: "edit", named: true, labels: ['"회의록" 앱 고치기'], spawns: 0 }, "R4 공개한 앱을 «이어서» 로 되살리면 고치기(edit) — 세션 이름을 «앱 고치기» 로 맞춘다(«제작» 아님)");
same(R.r5, { mode: "new", labels: [] }, "R5 마무리 전 나만 보는 앱을 되살리면 새로 만들기(new) 그대로 — 세션 이름(«제작»)도 그대로");
same(R.errors, [], "W  페이지 예외 없음");
if (fails) { console.error(`studio-edit-reuse: ${fails} 실패`); process.exit(1); }
console.log("studio-edit-reuse: 통과");
