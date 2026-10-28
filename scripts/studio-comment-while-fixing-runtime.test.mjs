#!/usr/bin/env node
// 앱빌더 ③ — AI 가 고치는 동안에도 다음 코멘트를 남긴다(#4632) · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버 · 가짜 실시간 스트림).
//
// 원준 2026-10-28 «코멘트 할 텍스트 하나 치고 나서는 그거 다 적용될 때까지 다른 코멘트를 남기는 게 비활성화되어 있네 · 해결해야».
//  종전: 「수정하기」 뒤엔 허브의 실제 화면 단추가 기다림 줄로 바뀌고(openReal 도 막힘), 새 버전이 오면 코멘트를 **전부** 비웠다 —
//  그 사이에 적은 것까지 날아갔다. 이제 보낸 것만 «반영 중» 으로 남겼다가 새 버전이 오면 그것만 걷는다. 막대 쪽은 review-talk-runtime W1~W5.
//
// 엣지 표:
//  C1 「수정하기」 — 보낸 글에 그 코멘트 · 앱 전체 글 · 보낸 핀은 반영 중(세지 않음) · 앱 전체 칸은 비움 · 단추 잠김
//  C2 고치는 중 — 허브에 실제 화면 단추가 그대로 있고 눌러서 간다(코멘트 층이 선다)
//  C3 고치는 중에 남긴 코멘트 — 셈 1 · 기록(localStorage)엔 보낸 핀이 없다
//  C4 새 버전 도착 — 보낸 것만 걷히고 새 코멘트는 그대로 · 「수정하기 · 1건」 이 다시 눌린다
//  C5 다음 「수정하기」 — 새 코멘트만 보낸다(먼저 보낸 것은 다시 안 간다)   W 페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 트리에서 C1 · C2 · C3 · C4 · C5 가 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 고치는 중 코멘트 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts'; export { startLiveSync } from './v2/live-sync.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  window.__push(ev) — 실시간 스트림에 사건 하나를 흘린다. __prompts — AI 에게 보낸 글.
const FETCH = `<script>window.__prompts = []; window.__sse = null; window.__n = 0;
window.__push = (ev) => { if (window.__sse) window.__sse.enqueue(new TextEncoder().encode("data: " + JSON.stringify(ev) + "\\n\\n")); };
const APP = { id: "mn", title: "회의록", status: "active", enabled: true, visibility: "me", made_by: "wonjoon-jang", manifest: { title: "회의록", ui: { pages: [{ key: "main", title: "회의록", entry: "ui/index.html" }] } } };
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start(c) { window.__sse = c; } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p === "/api/ui/app-instances" && method === "POST") return j({ instance: { id: "inst-" + (++window.__n), app_id: "mn", page_key: "main" } });
  if (/^\\/api\\/ui\\/app-instances\\/inst-/.test(p)) return j({ instance: { id: p.split("/").pop(), app_id: "mn" } });
  if (p.startsWith("/api/ui/app-instances")) return j({ instances: [] });
  if (/\\/prompt$/.test(p) && method === "POST") { let t = ""; try { t = JSON.parse(init.body).text || ""; } catch (_) {} window.__prompts.push(t); return j({ ok: true }); }
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (/^\\/api\\/ui\\/apps\\/mn\\/versions/.test(p)) return j({ versions: [{ version_no: 2 + window.__ver }, { version_no: 1 }] });
  if (/^\\/api\\/ui\\/apps\\/mn(\\?|$)/.test(p)) return j({ app: { id: "mn", title: "회의록", empty: false, visibility: "me", version_no: 2 } });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (/^\\/api\\/ui\\/apps(\\?|$)/.test(p)) return j({ apps: [APP] });
  if (p.startsWith("/api/ui/v6/projects")) return j({ projects: [{ id: 4632, name: "앱 만들기", status_category: "active" }] });
  if (p.includes("sessions")) return j({ sessions: [] });
  return j({});
};
window.__ver = 0;</script>`;

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const host = document.getElementById("host");
  localStorage.setItem("lively_ui_token", "t");
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ intro: 1, coach: { plan: 1, draft: 1, check: 1, put: 1 } }));
  St.startLiveSync(() => {});
  const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
  const pin1 = { kind: "pin", x: 0.2, y: 0.3, where: "제목", note: "제목 더 크게" };
  const rec0 = { sid: "box-s1", pid: 0, what: "회의 녹음 정리", place: "full", appId: "mn", draftId: "mn", known: [], at: Date.now() - 3600000, card: CARD, round: 1, from: 5, mode: "new", title: "회의록", named: true, reached: 2, stage: "fix", pins: [pin1], general: "전체 톤 밝게" };
  const stored = () => JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]")[0] || {};
  const fixBtn = () => document.querySelector(".v2-studio-fix-in");
  const trayRows = () => [...document.querySelectorAll(".v2-studio-tray .v2-studio-tray-row:not(.all)")].map((r) => ({ sent: r.classList.contains("sent"), note: r.querySelector("input").value, dis: r.querySelector("input").disabled }));
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec0]));
  location.hash = "#/builder";
  St.openAppStudio({ sid: "box-s1" }, { host, onClose: () => {}, onSee: () => {} });
  await sleep(3000);

  window.__step = "C1";
  R.before = { btn: txt(fixBtn()), dis: fixBtn() && fixBtn().disabled };
  fixBtn().click(); await sleep(1500);
  R.c1 = { prompts: window.__prompts.slice(), btn: txt(fixBtn()), dis: fixBtn().disabled, rows: trayRows(),
    general: (document.querySelector(".v2-studio-tray .v2-studio-tray-row.all input") || {}).value };
  window.__step = "C2";
  const goB = [...document.querySelectorAll(".v2-studio-hub-go button")].find((b) => /앱 화면으로 보기/.test(b.textContent));
  R.c2 = { goBtn: !!goB, wait: !!document.querySelector(".v2-studio-hub-wait") };
  //  고치는 중에 앱빌더 쪽 칸에 새 코멘트를 적는다(실제 화면 막대에서 짚은 것과 같은 목록)
  window.__step = "C3";
  const g = document.querySelector(".v2-studio-tray .v2-studio-tray-row.all input");
  g.value = "버튼 둥글게"; g.dispatchEvent(new Event("input", { bubbles: true })); await sleep(200);
  R.c3 = { btn: txt(fixBtn()), dis: fixBtn().disabled, storedPins: (stored().pins || []).length, storedGeneral: stored().general };
  if (goB) { goB.click(); await sleep(2500); }
  R.c2.bar = !!document.querySelector(".v2-review-bar"); R.c2.hash = location.hash;
  window.__step = "C4";
  window.__ver = 1; window.__push({ type: "app", kind: "updated", app_id: "mn", session: null, version_no: 3, note: "제목 키움" }); await sleep(2500);
  R.c4 = { rows: trayRows(), btn: txt(fixBtn()), dis: fixBtn() && fixBtn().disabled, general: (document.querySelector(".v2-studio-tray .v2-studio-tray-row.all input") || {}).value,
    barCount: txt(document.querySelector(".v2-review-count")), barSendDis: (document.querySelector(".v2-review-bar .v2-studio-now-pri") || {}).disabled };
  window.__step = "C5";
  window.__prompts.length = 0; fixBtn().click(); await sleep(1500);
  R.c5 = { prompts: window.__prompts.slice() };
  St.closeAppStudio();
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}
  html,body{margin:0} #host{width:1100px;height:860px;position:relative}
</style>
<div id="host"></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-wfix-", virtualTimeBudget: 120000, args: ["--window-size=1200,900"] });
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

check(/수정하기 · 2건/.test(R.before.btn || "") && !R.before.dis, "C0 보내기 전 — 「수정하기 · 2건」", R.before);
check(R.c1.prompts.length === 1 && /제목 더 크게/.test(R.c1.prompts[0]) && /전체 톤 밝게/.test(R.c1.prompts[0]), "C1 보낸 글에 그 코멘트 · 앱 전체 글", R.c1);
same(R.c1.rows, [{ sent: true, note: "제목 더 크게", dis: true }], "C1 보낸 핀은 반영 중으로 남고 고칠 수 없다");
check(R.c1.general === "" && R.c1.dis, "C1 앱 전체 칸은 비우고 단추는 잠긴다", R.c1);
check(R.c2.goBtn && R.c2.wait, "C2 고치는 중에도 허브에 실제 화면 단추가 있다(기다림 줄과 함께)", R.c2);
check(R.c2.bar && /^#\/i\/inst-/.test(R.c2.hash), "C2 눌러서 실제 화면으로 간다 · 코멘트 층이 선다", R.c2);
check(/수정하기 · 1건/.test(R.c3.btn || "") && R.c3.dis, "C3 고치는 중에 남긴 코멘트를 센다(단추는 아직 잠김)", R.c3);
check(R.c3.storedPins === 0 && R.c3.storedGeneral === "버튼 둥글게", "C3 기록엔 보낸 핀이 없고 새 코멘트는 있다", R.c3);
same(R.c4.rows, [], "C4 새 버전이 오면 보낸 핀만 걷힌다");
check(R.c4.general === "버튼 둥글게" && /수정하기 · 1건/.test(R.c4.btn || "") && !R.c4.dis, "C4 고치는 중에 남긴 코멘트는 그대로 · 「수정하기 · 1건」 이 눌린다", R.c4);
check(/코멘트 1건/.test(R.c4.barCount || "") && R.c4.barSendDis === false, "C4 실제 화면 막대도 같은 셈 · 단추가 눌린다", R.c4);
check(R.c5.prompts.length === 1 && /버튼 둥글게/.test(R.c5.prompts[0]) && !/제목 더 크게/.test(R.c5.prompts[0]), "C5 다음 「수정하기」 는 새 코멘트만 보낸다", R.c5);
check(!R.errors.length, "W 페이지 예외 없음", R.errors);

console.log(`\n#4632 고치는 중에도 코멘트: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
