#!/usr/bin/env node
// 앱빌더 ③ 고침을 기다리다 AI 가 멈췄을 때 — 화면 모든 자리가 «멈췄다» 를 같은 말로(#4632) · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-28 «중간에 안됐는데 수정중 하면서 시간 세고있으면 어떡해» — 만들기 세션이 고침을 받자마자 «You've hit your weekly limit · resets 9am» 으로
//  끝났는데, 막대는 «끝내지 못하고 멈췄어요» · 띠는 «AI 수정 중 11:06» 을 세고 · 허브는 «AI가 수정하고 있어요» 였다. 까닭(사용 한도)은 어디에도 없었다.
//
// 엣지 표:
//  F1 고침을 보냄 · 세션이 돈다 — 띠가 «AI 수정 중 m:ss» 로 센다 · 허브 «AI가 수정하고 있어요»
//  F2 턴이 끝남(idle) — 막대가 멈춤을 말하면 띠도 «AI가 멈췄어요» 로 서고(시계가 더 가지 않는다) · 허브 제목 · 돌던 표시도 멈춤으로
//  F3 「이어서 수정하기」 — 이어서 하라는 글(app_save) 1건 · 띠가 다시 «AI 수정 중 0:0x» 부터 센다
//  F4 답 글이 사용 한도 알림 — 기다리지 않고(30초 전에) 막대가 «이번 주 AI 사용 한도 … 오전 9시에 풀려요» · 띠 «AI 사용 한도로 멈췄어요»
//  F5 새로 보내면 한도 표시는 걷힌다   W 페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 F2 · F4 가 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 고침 멈춤 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
//  window.__row — 세션 한 줄. window.__tx — 기록에 더할 AI 답(ndjson 한 줄로 · 한 번 준다).
const FETCH = `<script>window.__prompts = []; window.__calls = []; window.__row = { agentState: "busy", working: true }; window.__tx = ""; window.__logTo = 5;
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  if (/\\/prompt$/.test(p) && method === "POST") { let t = ""; try { t = JSON.parse(init.body).text || ""; } catch (_) {} window.__prompts.push(t); window.__calls.push("prompt"); return j({ ok: true }); }
  if (p.includes("/transcript")) {
    if (window.__tx && !/tail=1/.test(p)) { const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: window.__tx }] } }) + "\\n"; window.__tx = ""; window.__logTo += 100; return new Response(line, { status: 200, headers: { "X-Log-To": String(window.__logTo) } }); }
    return new Response("", { status: 200, headers: { "X-Log-To": String(window.__logTo) } });
  }
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p.startsWith("/api/ui/terminal/sessions?only=")) { window.__calls.push("row"); return j({ sessions: [Object.assign({ id: "box-s1" }, window.__row)] }); }
  if (/^\\/api\\/ui\\/apps\\/mn\\/versions/.test(p)) return j({ versions: [{ version_no: 1, is_current: true, origin: "member", note: "" }] });
  if (/^\\/api\\/ui\\/apps\\/mn(\\?|$)/.test(p)) return j({ app: { id: "mn", title: "회의록", visibility: "me" } });
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
  const pin = { kind: "pin", x: 0.5, y: 0.5, note: "글자 크게", where: "제목" };
  const base = { sid: "box-s1", pid: 0, what: "회의 녹음 정리", place: "both", appId: "mn", known: [], at: Date.now() - 3600000, stage: "fix", card: window.__CARD, round: 0, from: 5, mode: "new", title: "회의록", named: true, reached: 2, pins: [pin], general: "" };
  const view = () => { const band = host.querySelector(".v2-studio-band");
    return { now: txt($(".v2-studio-now-t")), btns: $$(".v2-studio-now button").map((b) => [txt(b), b.disabled]), band: band && !band.hidden ? txt(band) : null,
      hub: txt($(".v2-studio-hub-head h2")), spin: !!$(".v2-studio-hub-wait .v2-studio-spin") }; };
  const mount = async (rec, row) => {
    St.closeAppStudio(); window.__row = row; window.__prompts.length = 0; window.__calls.length = 0;
    localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec]));
    St.openAppStudio({ sid: rec.sid }, { host, onClose: () => {}, onSee: () => {} });
    await sleep(1500);
  };
  const press = async (re) => { const b = $$(".v2-studio-now button").find((n) => re.test(n.textContent)); if (b && !b.disabled) b.click(); await sleep(800); return !!b && !b.disabled; };

  window.__step = "F1";
  await mount({ ...base }, { agentState: "busy", working: true });
  R.f1 = { pressed: await press(/수정하기 · 1건/) };
  await sleep(5000);
  R.f1.v = view(); R.f1.prompts = window.__prompts.length;
  window.__step = "F2";
  window.__row = { agentState: "idle" };
  await sleep(100000);   // 보낸 뒤 60초는 말하지 않고 · 그 뒤 30초 이어지면 멈춤
  R.f2 = { a: view() };
  await sleep(5000);
  R.f2.b = view();   // 5초 뒤에도 띠 글이 같아야 한다(시계가 서 있다)
  window.__step = "F3";
  window.__prompts.length = 0;
  R.f3 = { pressed: await press(/이어서 수정하기/) };
  window.__row = { agentState: "busy", working: true };
  await sleep(2500);
  R.f3.v = view(); R.f3.prompts = window.__prompts.slice();
  window.__step = "F4";
  await mount({ ...base }, { agentState: "busy", working: true });
  await press(/수정하기 · 1건/);
  window.__row = { agentState: "idle" };
  window.__tx = "You've hit your weekly limit · resets 9am (Asia/Seoul)";
  await sleep(6000);   // 기록은 2.5초마다 읽는다 — 30초 · 60초를 기다리지 않는다
  R.f4 = { v: view() };
  await sleep(40000);   // 세션 줄(idle)이 와도 한도 까닭은 그대로
  R.f4.later = view();
  window.__step = "F5";
  window.__prompts.length = 0;
  R.f5 = { pressed: await press(/이어서 수정하기/) };
  window.__row = { agentState: "busy", working: true };
  await sleep(2500);
  R.f5.v = view();
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

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-fix-stall-", virtualTimeBudget: 400000, args: ["--window-size=1200,900"] });
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

check(R.f1 && R.f1.pressed && R.f1.prompts === 1 && /^AI 수정 중 0:0\d$/.test(R.f1.v.band || "") && R.f1.v.hub === "AI가 수정하고 있어요" && R.f1.v.spin, "F1 고침을 보냄 — 띠가 «AI 수정 중 m:ss» 로 세고 허브는 «AI가 수정하고 있어요»", R.f1);
check(R.f2 && /끝내지 못하고 멈췄어요/.test(R.f2.a.now || "") && R.f2.a.btns.some(([t, d]) => t === "이어서 수정하기" && !d), "F2 턴이 끝남 — 막대가 멈춤과 「이어서 수정하기」", R.f2 && R.f2.a);
check(R.f2 && R.f2.a.band === "AI가 멈췄어요" && R.f2.b.band === "AI가 멈췄어요", "F2 띠는 시계를 세우고 «AI가 멈췄어요»(«AI 수정 중 m:ss» 를 세지 않는다)", R.f2);
check(R.f2 && R.f2.a.hub === "AI가 멈췄어요" && !R.f2.a.spin, "F2 허브 제목 · 기다림 판도 멈춤으로(도는 표시 없이)", R.f2 && R.f2.a);
check(R.f3 && R.f3.pressed && R.f3.prompts.length === 1 && /app_save/.test(R.f3.prompts[0]), "F3 「이어서 수정하기」 — 이어서 하라는 글 1건(app_save)", R.f3);
check(R.f3 && /^AI 수정 중 0:0\d$/.test(R.f3.v.band || "") && R.f3.v.hub === "AI가 수정하고 있어요", "F3 다시 돌면 띠가 그때부터 센다", R.f3 && R.f3.v);
check(R.f4 && /이번 주 AI 사용 한도에 걸려 멈췄어요\. 오전 9시에 풀려요\./.test(R.f4.v.now || "") && R.f4.v.band === "AI 사용 한도로 멈췄어요", "F4 답 글이 사용 한도 알림 — 기다리지 않고 까닭 · 풀리는 때(막대 · 띠)", R.f4 && R.f4.v);
check(R.f4 && /사용 한도/.test(R.f4.later.now || "") && R.f4.later.band === "AI 사용 한도로 멈췄어요", "F4 세션 줄이 idle 로 와도 한도 까닭은 그대로", R.f4 && R.f4.later);
check(R.f5 && R.f5.pressed && !/사용 한도/.test(R.f5.v.now || "") && /^AI 수정 중/.test(R.f5.v.band || ""), "F5 새로 보내면 한도 표시는 걷힌다", R.f5);
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 앱빌더 고침 멈춤: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
