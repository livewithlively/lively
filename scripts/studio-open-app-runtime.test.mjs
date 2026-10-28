#!/usr/bin/env node
// 앱빌더가 앱을 여는 길 = 앱 찾기에서 그 앱을 누른 길(#4632) · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-28 «앱빌더에서 ⑤ 만든 앱 열기 버튼을 눌렀는데 왼쪽 사이드바 쪽이 이상해 · 앱 들어가서 그 회의록 앱 눌렀을 때랑 달라 ·
//  그거랑 똑같은 게 실행되게». ⑤ 「지금 써 보기」 는 옛 「앱 UI」 덮개 창(openAppUi)을, ③ 「앱 화면으로 보기」 는 인스턴스를 손으로 만들었다
//  (동의 · 실행 자리 · 첫 화면을 건너뜀). 둘 다 apps.openAppById → openInstalledApp(앱 찾기의 길)로 모았다.
//
// 엣지 표:
//  O1 ⑤ 화면 전체 앱 「지금 써 보기」 — 앱 찾기와 같은 인스턴스 요청(app_id · 첫 화면 page_key) 1건 · #/i/<인스턴스> · 덮개 창 없음
//  O2 ⑤ 앱 찾기 목록에 없는 앱 — 인스턴스 요청 0 · 덮개 창 없음 · 앱 찾기로 가라는 말
//  O3 ③ 「앱 화면으로 보기」 처음(옛 칸 instId 만 있음) — 옛 인스턴스를 쓰지 않고 같은 길로 1건 · 코멘트 층이 그 주소로 · 기록에 appInst
//  O4 ③ 다시(appInst 가 살아 있음) — 새로 만들지 않고 그 탭으로
//  O5 ③ 목록에 없는 앱 — 요청 0 · 코멘트 층 안 뜸 · 말   W 페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 O1 · O2 · O3 · O5 가 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 앱 열기 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  window.__listed — 앱 찾기 목록에 회의록이 서 있나. __inst — 만든 인스턴스(id → 기록). __creates — 인스턴스 만들기 요청 몸.
const FETCH = `<script>window.__listed = true; window.__inst = { "old-1": { id: "old-1", app_id: "mn" } }; window.__creates = []; window.__n = 0;
const APP = { id: "mn", title: "회의록", status: "active", enabled: true, visibility: "me", made_by: "wonjoon-jang", manifest: { title: "회의록", ui: { pages: [{ key: "main", title: "회의록", entry: "ui/index.html" }] } } };
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  if (p === "/api/ui/app-instances" && method === "POST") { const b = JSON.parse(init.body || "{}"); window.__creates.push(b); const id = "inst-" + (++window.__n); window.__inst[id] = { id, app_id: b.app_id, page_key: b.page_key }; return j({ instance: window.__inst[id] }); }
  { const m = /^\\/api\\/ui\\/app-instances\\/([^/?]+)$/.exec(p); if (m && method === "GET") { const r = window.__inst[decodeURIComponent(m[1])]; return r ? j({ instance: r }) : j({ error: "없음" }, 404); } }
  if (p.startsWith("/api/ui/app-instances")) return j({ instances: [] });
  if (/\\/prompt$/.test(p) && method === "POST") return j({ ok: true });
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (/^\\/api\\/ui\\/apps\\/mn\\/versions/.test(p)) return j({ versions: [{ version_no: 2 }, { version_no: 1 }] });
  if (/^\\/api\\/ui\\/apps\\/mn(\\?|$)/.test(p)) return j({ app: { id: "mn", title: "회의록", empty: false, visibility: "me", version_no: 2 } });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (/^\\/api\\/ui\\/apps(\\?|$)/.test(p)) return j({ apps: window.__listed ? [APP] : [] });
  if (p.startsWith("/api/ui/v6/projects")) return j({ projects: [{ id: 4632, name: "앱 만들기", status_category: "active" }] });
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
  const base = { sid: "box-s1", pid: 0, what: "회의 녹음 정리", place: "full", appId: "mn", draftId: "mn", known: [], at: Date.now() - 3600000, card: CARD, round: 1, from: 5, mode: "new", title: "회의록", named: true, reached: 4 };
  const rec = () => JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]")[0] || {};
  const toasts = () => [...document.querySelectorAll(".toast, [class*='toast']")].map((n) => n.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ");
  const mount = async (r, listed) => {
    St.closeAppStudio(); document.querySelectorAll(".v2-appui-ov, .v2-review-bar, .toast").forEach((n) => n.remove());
    window.__listed = listed; window.__creates.length = 0; location.hash = "#/builder";
    localStorage.setItem("lively_v2_app_studio", JSON.stringify([r]));
    St.openAppStudio({ sid: r.sid }, { host, onClose: () => {}, onSee: () => {} });
    await sleep(2500);
  };
  const click = async (sel, re) => { const b = [...document.querySelectorAll(sel)].find((n) => re.test(n.textContent)); if (b && !b.disabled) b.click(); await sleep(2500); return !!b; };

  window.__step = "O1";
  await mount({ ...base, stage: "put" }, true);
  R.o1 = { pressed: await click(".v2-studio-fin button, .v2-studio-go", /지금 써 보기/), creates: window.__creates.slice(), hash: location.hash, overlay: !!document.querySelector(".v2-appui-ov") };
  window.__step = "O2";
  await mount({ ...base, stage: "put" }, false);
  R.o2 = { pressed: await click(".v2-studio-fin button, .v2-studio-go", /지금 써 보기/), creates: window.__creates.slice(), hash: location.hash, overlay: !!document.querySelector(".v2-appui-ov"), toast: toasts() };
  window.__step = "O3";
  await mount({ ...base, stage: "fix", instId: "old-1" }, true);
  R.o3 = { pressed: await click(".v2-studio-hub-go button", /앱 화면으로 보기/) };
  await sleep(1500);
  R.o3.creates = window.__creates.slice(); R.o3.hash = location.hash; R.o3.bar = !!document.querySelector(".v2-review-bar"); R.o3.appInst = rec().appInst;
  window.__step = "O4";
  await mount({ ...rec(), stage: "fix" }, true);
  R.o4 = { pressed: await click(".v2-studio-hub-go button", /앱 화면으로 보기/) };
  await sleep(1500);
  R.o4.creates = window.__creates.slice(); R.o4.hash = location.hash; R.o4.bar = !!document.querySelector(".v2-review-bar");
  window.__step = "O5";
  await mount({ ...base, stage: "fix" }, false);
  R.o5 = { pressed: await click(".v2-studio-hub-go button", /앱 화면으로 보기/) };
  R.o5.toast = toasts();   // 말은 잠깐 떴다 사라진다 — 누른 직후에 읽는다
  await sleep(1500);
  R.o5.creates = window.__creates.slice(); R.o5.bar = !!document.querySelector(".v2-review-bar");
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
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-open-", virtualTimeBudget: 300000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, typeof why === "string" ? why : JSON.stringify(why)));

check(R.o1.pressed, "O1 ⑤ 「지금 써 보기」 단추가 있다", R.o1);
check(R.o1.creates.length === 1 && R.o1.creates[0].app_id === "mn" && R.o1.creates[0].page_key === "main", "O1 앱 찾기와 같은 인스턴스 요청 1건(첫 화면 page_key 까지)", R.o1);
check(/^#\/i\/inst-/.test(R.o1.hash) && !R.o1.overlay, "O1 #/i/<인스턴스> 로 가고 「앱 UI」 덮개 창은 안 뜬다", R.o1);
check(R.o2.creates.length === 0 && !R.o2.overlay && !/^#\/i\//.test(R.o2.hash), "O2 목록에 없는 앱 — 요청 0 · 덮개 창 없음 · 주소 그대로", R.o2);
check(/앱 찾기/.test(R.o2.toast || ""), "O2 앱 찾기로 가라고 말한다", R.o2);
check(R.o3.pressed && R.o3.creates.length === 1 && R.o3.creates[0].page_key === "main", "O3 ③ 처음 — 옛 칸 instId 를 쓰지 않고 앱 찾기의 길로 1건(page_key 까지)", R.o3);
check(/^#\/i\/inst-/.test(R.o3.hash) && R.o3.bar && R.o3.appInst && R.o3.hash === "#/i/" + R.o3.appInst, "O3 코멘트 층이 그 주소로 · 기록에 appInst", R.o3);
check(R.o4.pressed && R.o4.creates.length === 0 && R.o4.hash === R.o3.hash && R.o4.bar, "O4 ③ 다시 — 새로 만들지 않고 같은 탭으로", R.o4);
check(R.o5.pressed && R.o5.creates.length === 0 && !R.o5.bar, "O5 ③ 목록에 없는 앱 — 요청 0 · 코멘트 층 안 뜸", R.o5);
check(/앱 찾기/.test(R.o5.toast || ""), "O5 말한다", R.o5);
check(!R.errors.length, "W 페이지 예외 없음", R.errors);

console.log(`\n#4632 앱빌더 앱 열기 = 앱 찾기의 길: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
