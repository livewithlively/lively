#!/usr/bin/env node
// 앱빌더 ③ — 「수정하기」 를 보내 두고 나갔다 와도 «AI가 수정하고 있어요» 로 다시 연다(#4632) · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-28 «수정하기를 눌렀어. 누르면 수정중이라는 내용의 화면으로 가는데, 라이블리앱에서 다른 화면으로 갔다가 다시 앱빌더로 들어가면
//  진행중 페이지로 안 가고 (코멘트 1건 · 수정하기) 상태로 가게 돼. 다른 데 갔어도 알아서 진행하고 있어야 되고 다시 들어가면 진행중이라는 내용이 떠야지»
//  실측: 기다림(S.waiting)이 화면 메모리에만 있었다 — 닫고 다시 열면 보내기 전 화면(코멘트 그대로 · 「수정하기」 눌림)이었고, 그 사이 새 판이 나와도 끝맺지 않았다.
//
// 엣지 표:
//  F1 「수정하기」 — 보낸 때와 그때 가장 뒤 판(5)을 기록에 둔다
//  F2 닫고 다시 엶(새 판 없음 · 판 번호가 보낸 때와 같다) — 허브 · 막대 «AI가 수정하고 있어요» · 도는 표시 · 띠 «AI 수정 중» · 허브 「수정하기」 잠김 · 눌러도 다시 안 보낸다
//  F3 보낸 지 2분 지나 다시 엶 — 시계는 보낸 때부터(«AI 수정 중 2:0x»)
//  F4 나가 있던 사이 새 판(6) — 열자마자 끝맺는다: 기록의 기다림 · 코멘트를 걷고 몇 번째를 올린다 · «V6 · 요지» 를 알린다 · 실제 화면 단추가 다시 선다
//  F5 다시 연 뒤 세션이 멈춰 있다 — 멈춤 판정이 그대로 돈다(「이어서 수정하기」)
//  F6 보낼 때 판을 못 읽은 기록(ver 0) — 보낸 뒤 저장된 판이면 끝맺고, 그 전 것뿐이면 기다림을 잇는다
//  F7 만들던 앱 줄 — 기다리는 중이면 「③ 수정 중」 · 앱의 지금 판이 보낸 판보다 뒤면 「③ 시안」(이미 끝났다) · 기록이 없으면 「③ 시안」
//  W  페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 F1~F4 · F6 · F7 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 고침 이어 열기 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts'; export { buildModel } from './v2/builder-model.ts'; export { draftStageShort } from './lib/builder-flow.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
//  window.__ver — 앱 판 수 · __savedAt — 판마다 저장된 때(없으면 옛날) · __row — 만들기 세션 한 줄.
const FETCH = `<script>window.__prompts = []; window.__ver = 5; window.__savedAt = null; window.__row = { agentState: "busy", working: true };
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  if (/\\/prompt$/.test(p) && method === "POST") { let t = ""; try { t = JSON.parse(init.body).text || ""; } catch (_) {} window.__prompts.push(t); return j({ ok: true }); }
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p.startsWith("/api/ui/terminal/sessions?only=")) return j({ sessions: window.__row ? [Object.assign({ id: "box-s1" }, window.__row)] : [] });
  if (p.startsWith("/api/ui/apps/notes/versions")) { const n = window.__ver; return j({ versions: Array.from({ length: n }, (_, i) => ({ version_no: i + 1, is_current: i + 1 === n, note: i + 1 === n && n > 5 ? "파일 여러 개 올리기" : "고침",
    saved_at: (window.__savedAt && window.__savedAt[i]) || "2026-10-01T00:00:00Z" })) }); }
  if (/^\\/api\\/ui\\/apps\\/notes(\\?|$)/.test(p)) return j({ app: { id: "notes", title: "회의록", visibility: "me", published_version_no: 0, manifest: { studio: { card: ${JSON.stringify(CARD)} } } } });
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
  const GENERAL = "앱에서 + 새 회의록 하면 나오는 곳에 여러 파일을 올릴 수 있도록";
  //  ③ 을 보던 기록 — 지금 5번째 버전 · 앱 전체 코멘트 1건.
  const base = { sid: "box-s1", pid: 0, what: "회의록 정리", place: "both", appId: "notes", known: [], at: Date.now() - 3600000, stage: "fix", card: window.__CARD, round: 4, from: 5, mode: "new",
    title: "회의록", named: true, reached: 2, general: GENERAL, pins: [] };
  const recNow = () => (JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").find((r) => r.sid === "box-s1") || {});
  const opts = { host, onClose: () => {}, onSee: () => {} };
  const fixBtn = () => $$(".v2-studio-now button").find((b) => /수정하기/.test(b.textContent || ""));
  const view = () => { const b = fixBtn(); return { h2: txt($(".v2-studio-hub-head h2")), wait: txt($(".v2-studio-hub-wait")), spin: !!$(".v2-studio-hub-wait .v2-studio-spin"), go: !!$(".v2-studio-hub-go"),
    band: $(".v2-studio-band") && !$(".v2-studio-band").hidden ? txt($(".v2-studio-band")) : "", fix: b ? [txt(b), b.disabled] : null, now: txt($(".v2-studio-now-t")) }; };
  const mount = async (rec) => {
    St.closeAppStudio(); window.__prompts.length = 0;
    if (rec) localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec]));
    St.openAppStudio({ sid: "box-s1" }, opts);
    await sleep(1500);
  };

  window.__step = "F1";
  await mount({ ...base });
  R.f1 = { before: view() };
  const b1 = fixBtn(); if (b1 && !b1.disabled) b1.click();
  await sleep(1000);
  R.f1.prompts = window.__prompts.length; R.f1.fixing = recNow().fixing || null; R.f1.after = view();

  window.__step = "F2";
  await mount(null);   // 같은 기록으로 다시 연다(다른 화면에 갔다 돌아옴)
  R.f2 = view(); R.f2.general = recNow().general;
  const b2 = fixBtn(); if (b2) b2.click(); const hubIn = $(".v2-studio-fix-in"); if (hubIn) hubIn.click();
  await sleep(600);
  R.f2.prompts = window.__prompts.length; R.f2.hubIn = hubIn ? hubIn.disabled : null;

  window.__step = "F3";
  await mount({ ...base, fixing: { at: Date.now() - 125000, ver: 5 } });
  R.f3 = view();

  window.__step = "F4";
  window.__ver = 6;
  //  고치는 동안 새로 남긴 앱 전체 코멘트(보낸 것은 보낼 때 비웠다) — 끝맺어도 다음 「수정하기」 몫으로 남는다.
  await mount({ ...base, general: "버튼 둥글게", fixing: { at: Date.now() - 300000, ver: 5 } });
  const r4 = recNow();
  R.f4 = { ...view(), fixing: r4.fixing || null, round: r4.round, general: r4.general, prompts: window.__prompts.length };

  window.__step = "F5";
  window.__ver = 5; window.__row = { agentState: "idle" };
  await mount({ ...base, fixing: { at: Date.now() - 600000, ver: 5 } });
  await sleep(32000);
  R.f5 = view();
  window.__row = { agentState: "busy", working: true };

  window.__step = "F6";
  const at6 = Date.now() - 300000;
  window.__ver = 5; window.__savedAt = Array.from({ length: 5 }, (_, i) => new Date(at6 - (5 - i) * 60000).toISOString());   // 다 보내기 전 판
  await mount({ ...base, fixing: { at: at6, ver: 0 } });
  R.f6 = { before: { ...view(), fixing: !!recNow().fixing } };
  window.__ver = 6; window.__savedAt.push(new Date(at6 + 60000).toISOString());   // 보낸 뒤 저장된 판
  await mount({ ...base, fixing: { at: at6, ver: 0 } });
  R.f6.after = { ...view(), fixing: !!recNow().fixing };
  window.__savedAt = null;

  window.__step = "F7";
  St.closeAppStudio();
  const app = (n) => ({ id: "notes", title: "회의록", version: "1", enabled: true, installedBy: "wonjoon-jang", installedAt: 0, hasUi: true, canEdit: true, builtin: false, versionNo: n, hasInstructions: false, icon: null, studio: null, empty: false });
  const env = { projects: () => [], sessions: () => [] };
  const chip = (n, fixing) => { localStorage.setItem("lively_v2_app_studio", JSON.stringify([{ ...base, ...(fixing ? { fixing } : {}) }]));
    const d = St.buildModel([app(n)], { id: "wonjoon-jang", name: "원준" }, env).drafts.find((x) => x.sid === "box-s1"); return d ? St.draftStageShort(d.stage, !!d.appId, d.done, d.fixing) : null; };
  R.f7 = { waiting: chip(5, { at: Date.now(), ver: 5 }), done: chip(6, { at: Date.now(), ver: 5 }), none: chip(5, null) };

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

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-fix-resume-", virtualTimeBudget: 200000, args: ["--window-size=1200,900"] });
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
//  기다리는 동안 — 허브 · 막대 글 · 띠가 같은 말 · 막대엔 누를 「수정하기」 가 없다(있어도 잠김)
const fixing = (v) => !!v && /수정하고 있어요/.test(v.h2 || "") && /수정하고 있어요/.test(v.now || "") && v.spin && v.go && /^AI 수정 중 \d+:\d\d$/.test(v.band || "") && (!v.fix || v.fix[1] === true);

check(R.f1 && R.f1.before.fix && R.f1.before.fix[1] === false && R.f1.prompts === 1 && R.f1.fixing && R.f1.fixing.ver === 5 && R.f1.fixing.at > 0 && fixing(R.f1.after), "F1 「수정하기」 — 보낸 때와 그때 가장 뒤 판(5)을 기록에 둔다", R.f1);
check(fixing(R.f2), "F2 닫고 다시 열어도 허브 · 막대 «AI가 수정하고 있어요» · 도는 표시 · 띠 «AI 수정 중»", R.f2);
check(R.f2 && R.f2.prompts === 0 && R.f2.hubIn === true && R.f2.general === "", "F2 다시 연 뒤 눌러도 같은 고침을 또 보내지 않는다(보낸 앱 전체 코멘트는 보낼 때 비웠다 · 원준 2026-10-28 «고치는 중에도 다음 코멘트»)", R.f2);
check(fixing(R.f3) && /^AI 수정 중 2:[01]\d$/.test(R.f3.band), "F3 시계는 보낸 때부터(2분 지나 열면 2:0x~2:1x)", R.f3);
check(R.f4 && R.f4.fixing === null && R.f4.round === 5 && R.f4.general === "버튼 둥글게" && R.f4.prompts === 0, "F4 나가 있던 사이 새 판 — 열자마자 끝맺는다(기다림을 걷고 몇 번째를 올린다 · 다시 보내지 않는다 · 고치는 동안 남긴 코멘트는 그대로)", R.f4);
check(R.f4 && /나왔어요/.test(R.f4.h2 || "") && R.f4.go && /^V6 · 파일 여러 개 올리기$/.test(R.f4.band) && /코멘트 1건/.test(R.f4.now || "") && R.f4.fix && R.f4.fix[1] === false, "F4 «V6 · 요지» 를 알리고 실제 화면 단추가 선다 · 고치는 동안 남긴 코멘트로 「수정하기」 가 눌린다", R.f4);
check(R.f5 && /멈췄어요/.test(R.f5.now || "") && R.f5.fix && R.f5.fix[0] === "이어서 수정하기" && !R.f5.spin, "F5 다시 연 뒤에도 멈춤 판정이 돈다(「이어서 수정하기」)", R.f5);
check(R.f6 && R.f6.before.fixing && fixing(R.f6.before) && !R.f6.after.fixing && /나왔어요/.test(R.f6.after.h2 || ""), "F6 보낼 때 판을 못 읽은 기록 — 보낸 뒤 저장된 판으로 가린다", R.f6);
same(R.f7, { waiting: "③ 수정 중", done: "③ 시안", none: "③ 시안" }, "F7 만들던 앱 줄 — 기다리면 「③ 수정 중」 · 지금 판이 보낸 판보다 뒤면 이미 끝남 · 기록 없으면 「③ 시안」");
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 앱빌더 고침 이어 열기: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
