#!/usr/bin/env node
// 앱빌더 ③ 허브(앱빌더 화면) — 점검(2026-10-28) 묶음 g3 의 허브 몫 · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버 · 가짜 실시간 스트림).
//
// 원준 2026-10-29 «다 봤는데 그냥 싹 다 고쳐». 엣지 표(스크래치패드 spec-audit-g3.md):
//  U1 ③ 안내 글 — 글 속에 단추 없음 · «다음 화면에서» 없음 · «여기서» · 진짜 「수정하기」 는 코멘트 목록 맨 아래 · «가상 화면» 없음(6-12)
//  H2 새 판이 와 보낸 코멘트가 빠진 틈(허브를 다시 그리기 전)에 ✕ → 그 줄의 코멘트만 지운다(3-6)
//  H1 허브 목록에 쓰는 중 새 판이 와 허브를 다시 그린다 → 같은 코멘트 칸에 초점 · 커서 그대로(3-6)
//  A2 AI 가 확인을 기다린다(멈춤 ask) → 허브 줄은 «이어서 수정할 수 있어요» 가 아니라 「AI 세션 보기」로 답하라 ·
//     그때 연 실제 화면 막대도 「AI에게 말하기」로 답하라고 한다(3-7)
//  L1 「앱 화면으로 보기」 를 눌러 앱을 띄우는 사이 ④ 로 갔다 → 다 띄운 뒤 막대를 세우지 않는다(3-11)   W 페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 허브 점검 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts'; export { startLiveSync } from './v2/live-sync.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  __push(ev) — 실시간 스트림에 사건 하나. __row — 만들기 세션 한 줄(멈춤 판정). __slowVer · __slowInst — 버전 · 앱 열기 응답을 늦춘다(ms).
const FETCH = `<script>window.__prompts = []; window.__sse = null; window.__n = 0; window.__ver = 0; window.__row = { agentState: "busy", working: true }; window.__slowVer = 0; window.__slowInst = 0;
window.__push = (ev) => { if (window.__sse) window.__sse.enqueue(new TextEncoder().encode("data: " + JSON.stringify(ev) + "\\n\\n")); };
const APP = { id: "mn", title: "회의록", status: "active", enabled: true, visibility: "me", made_by: "wonjoon-jang", manifest: { title: "회의록", ui: { pages: [{ key: "main", title: "회의록", entry: "ui/index.html" }] } } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start(c) { window.__sse = c; } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p === "/api/ui/app-instances" && method === "POST") { if (window.__slowInst) await wait(window.__slowInst); return j({ instance: { id: "inst-" + (++window.__n), app_id: "mn", page_key: "main" } }); }
  if (/^\\/api\\/ui\\/app-instances\\/inst-/.test(p)) return j({ instance: { id: p.split("/").pop(), app_id: "mn" } });
  if (p.startsWith("/api/ui/app-instances")) return j({ instances: [] });
  if (/\\/prompt$/.test(p) && method === "POST") { let t = ""; try { t = JSON.parse(init.body).text || ""; } catch (_) {} window.__prompts.push(t); return j({ ok: true }); }
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (p.startsWith("/api/ui/terminal/sessions?only=")) return j({ sessions: [Object.assign({ id: "box-s1" }, window.__row)] });
  if (/^\\/api\\/ui\\/apps\\/mn\\/versions/.test(p)) { if (window.__slowVer) await wait(window.__slowVer); return j({ versions: [{ version_no: 2 + window.__ver, is_current: true }, { version_no: 1 }] }); }
  if (/^\\/api\\/ui\\/apps\\/mn(\\?|$)/.test(p)) return j({ app: { id: "mn", title: "회의록", empty: false, visibility: "me", version_no: 2 } });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (/^\\/api\\/ui\\/apps(\\?|$)/.test(p)) return j({ apps: [APP] });
  if (p.startsWith("/api/ui/v6/projects")) return j({ projects: [{ id: 4632, name: "앱 만들기", status_category: "active" }] });
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
  localStorage.setItem("lively_ui_token", "t");
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ intro: 1, coach: { plan: 1, draft: 1, check: 1, put: 1 } }));
  St.startLiveSync(() => {});
  const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
  const stored = () => JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]")[0] || {};
  const rows = () => [...document.querySelectorAll(".v2-studio-hub .v2-studio-tray .v2-studio-tray-row:not(.all)")];
  const base = () => ({ sid: "box-s1", pid: 0, what: "회의 녹음 정리", place: "full", appId: "mn", draftId: "mn", known: [], at: Date.now() - 3600000, card: CARD, round: 1, from: 5, mode: "new", title: "회의록", named: true, reached: 2, stage: "fix", general: "" });
  const mount = async (rec) => {
    St.closeAppStudio(); location.hash = "#/builder";
    localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec]));
    St.openAppStudio({ sid: rec.sid }, { host, onClose: () => {}, onSee: () => {} });
    await sleep(3000);
  };
  const A = () => ({ kind: "pin", x: 0.1, y: 0.1, where: "", note: "앞에 보낸 것", sent: true }), B = () => ({ kind: "pin", x: 0.3, y: 0.3, where: "", note: "둘째" }), C = () => ({ kind: "pin", x: 0.6, y: 0.6, where: "", note: "셋째" });

  window.__step = "U1";
  await mount({ ...base(), pins: [B(), C()] });
  { const p = document.querySelector(".v2-studio-hub-head p"); const foot = document.querySelector(".v2-studio-hub .v2-studio-tray-f .v2-studio-fix-in");
    R.u1 = { text: txt(p), btnInP: !!(p && p.querySelector("button")), foot: txt(foot), footDis: foot && foot.disabled }; }
  //  코멘트가 없을 때의 「지금 할 일」 줄
  await mount({ ...base(), pins: [] });
  R.u1.now = txt(document.querySelector(".v2-studio-now-t")); R.u1.virt = /가상 화면/.test(host.textContent);

  window.__step = "H2";
  //  고치는 중(A 를 보냄) — 새 판이 오면 A 가 빠진다. 버전 읽기를 늦춰 허브를 다시 그리기 전 틈에 셋째 줄의 ✕ 를 누른다.
  await mount({ ...base(), pins: [A(), B(), C()], fixing: { at: Date.now() - 5000, ver: 2 } });
  R.h2 = { rows0: rows().length };
  window.__slowVer = 3000; window.__ver = 1;
  window.__push({ type: "app", kind: "updated", app_id: "mn", session: null, version_no: 3, note: "고쳤어요" }); await sleep(400);
  { const r = rows()[2]; const x = r && r.querySelector(".x"); R.h2.stale = !!x; if (x) x.click(); await sleep(100); }
  R.h2.notes = (stored().pins || []).map((p) => p.note);
  await sleep(4000); window.__slowVer = 0;

  window.__step = "H1";
  await mount({ ...base(), pins: [A(), B(), C()], fixing: { at: Date.now() - 5000, ver: 3 } });
  { const ta = rows()[1] && rows()[1].querySelector(".v2-studio-tray-in");
    if (ta) { ta.focus(); ta.value = "둘째 고침"; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.setSelectionRange(2, 2); }
    window.__ver = 2; window.__push({ type: "app", kind: "updated", app_id: "mn", session: null, version_no: 4, note: "고쳤어요" }); await sleep(3000);
    const now = document.activeElement;
    R.h1 = { had: !!ta, replaced: !!ta && !ta.isConnected, isTray: !!now && now.tagName === "TEXTAREA" && !!now.closest(".v2-studio-tray"), val: now && now.value, caret: now && now.selectionStart, rows: rows().length }; }

  window.__step = "A2";
  window.__row = { agentState: "waiting", awaiting: true };
  await mount({ ...base(), pins: [A(), B()], fixing: { at: Date.now() - 120000, ver: 9 } });   // 보낸 지 2분 — 처음 60초 유예는 지났다
  await sleep(45000);   // 세션 줄은 10초마다 · 멈춤이 30초 이어지면 까닭을 말한다
  R.a2 = { wait: txt(document.querySelector(".v2-studio-hub-wait")) };
  { const go = [...document.querySelectorAll(".v2-studio-hub-go button")].find((b) => /앱 화면으로 보기/.test(b.textContent)); if (go) { go.click(); await sleep(2500); }
    R.a2.bar = !!document.querySelector(".v2-review-bar"); R.a2.hint = txt(document.querySelector(".v2-review-hint")); }
  window.__row = { agentState: "busy", working: true };

  window.__step = "L1";
  await mount({ ...base(), pins: [B()] });
  window.__slowInst = 2500;
  { const go = [...document.querySelectorAll(".v2-studio-hub-go button")].find((b) => /앱 화면으로 보기/.test(b.textContent)); R.l1 = { go: !!go }; if (go) go.click(); await sleep(300);
    const done = [...document.querySelectorAll(".v2-studio-now button")].find((b) => /완료 · 다음 단계로/.test(b.textContent)); R.l1.done = !!done && !done.disabled; if (done) done.click();
    await sleep(4500);
    R.l1.stage = stored().stage; R.l1.bar = !!document.querySelector(".v2-review-bar"); R.l1.hash = location.hash; }
  window.__slowInst = 0;
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

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-hub-g3-", virtualTimeBudget: 200000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const check = (cond, n, why = "") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${typeof why === "string" ? why : JSON.stringify(why)}`); } };

check(R.u1.text && !R.u1.btnInP && !/다음 화면에서/.test(R.u1.text) && /여기서/.test(R.u1.text), "U1 안내 글 — 글 속에 단추 없음 · «다음 화면에서» 없음 · «여기서»", R.u1);
check(/수정하기 · 2건/.test(R.u1.foot || "") && R.u1.footDis === false, "U1 진짜 「수정하기」 는 코멘트 목록 맨 아래(코멘트 수 · 눌림)", R.u1);
check(R.u1.now && !R.u1.virt, "U1 «가상 화면» 이라는 말이 없다(코멘트 없을 때의 할 일 줄)", R.u1);
check(R.h2.rows0 === 3 && R.h2.stale, "H2 배선 — 다시 그리기 전 틈에 셋째 줄의 ✕ 가 그대로 있다", R.h2);
check(JSON.stringify(R.h2.notes) === JSON.stringify(["둘째"]), "H2 그 틈의 ✕ 는 그 줄의 코멘트(셋째)만 지운다", R.h2);
check(R.h1.had && R.h1.replaced && R.h1.rows === 2, "H1 배선 — 새 판이 와 허브 목록을 다시 그렸다(보낸 것은 빠짐)", R.h1);
check(R.h1.isTray && R.h1.val === "둘째 고침" && R.h1.caret === 2, "H1 다시 그려도 쓰던 칸에 초점 · 커서 그대로", R.h1);
check(R.a2.wait && /AI 세션 보기/.test(R.a2.wait) && /답해/.test(R.a2.wait) && !/이어서 수정할 수/.test(R.a2.wait), "A2 확인을 기다리면 허브 줄은 「AI 세션 보기」로 답하라", R.a2);
check(R.a2.bar && /「AI에게 말하기」를 눌러 답해/.test(R.a2.hint || "") && !/AI 세션 보기/.test(R.a2.hint || ""), "A2 그때 연 실제 화면 막대는 「AI에게 말하기」로 답하라", R.a2);
check(R.l1.go && R.l1.done && R.l1.stage === "check", "L1 배선 — 앱을 띄우는 사이 ④ 로 갔다", R.l1);
check(!R.l1.bar, "L1 다 띄운 뒤에도 막대를 세우지 않는다(④ 화면을 덮지 않는다)", R.l1);
check(!R.errors.length, "W 페이지 예외 없음", R.errors);

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
