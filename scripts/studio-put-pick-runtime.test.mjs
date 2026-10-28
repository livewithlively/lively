#!/usr/bin/env node
// 앱빌더 ⑤ 넣기 — 「누가 쓰나」 를 ⑤ 에서 고르고, 「워크스페이스 모두」 면 확인 창을 거쳐 공개한다(#4632 · 태스크 #5094) · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-28 «첫 앱제작시 확인 누르면 팀원 전원에게 보이는 과정일 때 한 번 여기서 마지막으로 확인 누르면 모든 팀원들이 이 앱을 사용할 수 있다
//  하는 팝업같은걸 띄워서 확인하면 … 모든 사람들이 볼 수 있는 단계로(단 나만 쓰는 경우는 제외)» · «5단계에서 하는 일이 너무 없는거 아닌가?»
//  실측(이 변경 전): ④ 「완료 · 다음 단계로」 가 곧바로 저장 + 공개했고(표에 할 일이 없으면 확인 창 없음), ⑤ 는 결과만 보였다.
//
// 엣지 표(스크래치패드 spec-put.md):
//  K1 ④ 「완료 · 다음 단계로」 — 저장 요청 0건 · ⑤ 넣기 전 화면(「누가 쓰나」 고르기) · ④ 확인엔 「누가 쓰나」 줄이 없다
//  K2 ⑤ 「나만」(기본)으로 「넣기」 — 확인 창 0개 · 저장 1건(publish 없음) · 결과 화면 · 기록 done
//  K3 ⑤ 「워크스페이스 모두」 → 「넣고 모두에게 공개하기」 → 확인 창 1개(«「회의록」 앱을 워크스페이스 모두에게 공개할까요?») → 취소 — 저장 0건 · 고르는 화면 그대로 · done 아님
//  K4 같은 데서 확인 창 「모두에게 공개」 — 저장 1건 publish:true · 결과 화면
//  K5 ④ 에서 고친 이름이 ⑤ 저장의 매니페스트 title 에 실린다 · 닫았다 열어도(기록 putName) 실린다
//  K6 이미 공개한 앱(공개 판 V3)을 고쳐 넣기 — 확인 창 «이 버전을 모두에게 공개할까요?» · 본문에 V3
//  K7 공개하면 표에 할 일이 있다 — 확인 창은 하나(표 목록 + «모든 사람» 문장이 같은 창에)
//  W  페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 K1 · K3 · K5 · K6 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 ⑤ 넣기 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  __saves — 저장 요청 몸(publish · 매니페스트 title). __vis · __pub — 앱의 공개 범위 · 공개 판 번호. __changes — 공개 미리 보기의 표 할 일.
const FETCH = `<script>window.__saves = []; window.__vis = "me"; window.__pub = 0; window.__changes = [];
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  const MAN = { id: "mn", title: "회의록", version: "0.1.0", ui: { pages: [{ key: "main", title: "회의록", entry: "ui/index.html" }] }, studio: { place: "full" } };
  if (p === "/api/ui/apps/mn/pull") return j({ files: [{ path: "lively-app.json", content: JSON.stringify(MAN) }, { path: "ui/index.html", content: "<p>회의록</p>" }] });
  if (p === "/api/ui/apps/save" && method === "POST") { const b = JSON.parse(init.body || "{}"); const mf = (b.files || []).find((f) => f.path === "lively-app.json"); window.__saves.push({ publish: !!b.publish, title: mf ? JSON.parse(mf.content).title : null }); if (b.publish) { window.__vis = "all"; } return j({ ok: true, version_no: 4 }); }
  if (p === "/api/ui/apps/mn/publish-preview" && method === "POST") return j({ changes: window.__changes, notes: [], blocked: [] });
  if (p === "/api/ui/apps/mn/server") return j({ server_declared: false });
  if (/\\/prompt$/.test(p) && method === "POST") return j({ ok: true });
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (/^\\/api\\/ui\\/apps\\/mn\\/versions/.test(p)) return j({ versions: [{ version_no: 3, note: "고침", saved_at: "2026-10-28T00:00:00Z" }, { version_no: 2, note: "고침", saved_at: "2026-10-27T00:00:00Z" }, { version_no: 1, note: "처음", saved_at: "2026-10-26T00:00:00Z" }] });
  if (/^\\/api\\/ui\\/apps\\/mn(\\?|$)/.test(p)) return j({ app: { id: "mn", title: "회의록", empty: false, visibility: window.__vis, published_version_no: window.__pub, can_publish: true, draft: window.__pub ? { by: "wonjoon-jang", version_no: 3 } : null, version_no: 3, manifest: MAN } });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (/^\\/api\\/ui\\/apps(\\?|$)/.test(p)) return j({ apps: [] });
  if (p.startsWith("/api/ui/v6/projects")) return j({ projects: [{ id: 4680, name: "앱빌더", status_category: "active" }] });
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
  const base = { sid: "box-s1", pid: 4680, what: "회의 녹음 정리", place: "full", appId: "mn", draftId: "mn", known: [], at: Date.now() - 3600000, card: CARD, round: 1, from: 5, mode: "new", title: "회의록", named: true, reached: 3,
    check: { have: ["정리", "찾기"], missing: [], ver: 3, card: "" } };
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : "");
  const rec = () => JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").find((r) => r.sid === "box-s1") || {};
  const dialogs = () => [...document.querySelectorAll(".ov-confirm-back")];
  const dlg = () => { const d = dialogs()[0]; return d ? { title: txt(d.querySelector(".ov-head h3")), body: txt(d.querySelector(".ov-confirm-body")) } : null; };
  const press = (re, root) => { const b = [...(root || document).querySelectorAll("button")].find((n) => re.test(txt(n)) && !n.disabled && n.offsetParent !== null); if (b) b.click(); return !!b; };
  const mount = async (r) => {
    St.closeAppStudio(); dialogs().forEach((n) => n.remove()); document.querySelectorAll(".toast").forEach((n) => n.remove());
    window.__saves.length = 0; location.hash = "#/builder";
    localStorage.setItem("lively_v2_app_studio", JSON.stringify([r]));
    St.openAppStudio({ sid: r.sid }, { host, onClose: () => {}, onSee: () => {} });
    await sleep(2500);
  };
  const picking = () => !!host.querySelector(".v2-studio-pick");
  const result = () => /앱이 만들어졌어요|워크스페이스 앱이 됐어요/.test(txt(host.querySelector(".v2-studio-fin h2")) + " " + txt(host.querySelector(".v2-studio-fin")));
  const whoInCheck = () => [...host.querySelectorAll(".v2-studio-chk b")].some((b) => txt(b) === "누가 쓰나");

  window.__step = "K1";
  window.__vis = "me"; window.__pub = 0; window.__changes = [];
  await mount({ ...base, stage: "check" });
  const nameIn = host.querySelector(".v2-studio-name-in");
  if (nameIn) { nameIn.value = "회의록 정리"; nameIn.dispatchEvent(new Event("input", { bubbles: true })); }
  const whoBefore = whoInCheck();
  press(/^완료 · 다음 단계로$/, host); await sleep(1500);
  R.k1 = { whoInCheck: whoBefore, saves: window.__saves.length, picking: picking(), done: !!rec().done, putName: rec().putName || null };

  window.__step = "K2";
  press(/^넣기$/, host.querySelector(".v2-studio-pick")); await sleep(2500);
  R.k2 = { dialogs: dialogs().length, saves: window.__saves.slice(), result: result(), done: !!rec().done };

  window.__step = "K3";
  window.__vis = "me"; window.__pub = 0;
  await mount({ ...base, stage: "put", done: false, putName: "회의록 정리" });   // K5 — 닫았다 연 뒤(기록의 putName)
  press(/^워크스페이스 모두$/, host.querySelector(".v2-studio-pick")); await sleep(400);
  const goText = txt([...host.querySelectorAll(".v2-studio-pick .v2-studio-go")][0]);
  press(/^넣고 모두에게 공개하기$/, host.querySelector(".v2-studio-pick")); await sleep(1500);
  const d3 = dlg(), n3 = dialogs().length;
  press(/^취소$/, dialogs()[0]); await sleep(1200);
  R.k3 = { goText, dialogs: n3, dlg: d3, saves: window.__saves.length, picking: picking(), done: !!rec().done };

  window.__step = "K4";
  press(/^넣고 모두에게 공개하기$/, host.querySelector(".v2-studio-pick")); await sleep(1500);
  press(/^모두에게 공개$/, dialogs()[0]); await sleep(2500);
  R.k4 = { saves: window.__saves.slice(), result: result(), done: !!rec().done };
  R.k5 = { k2Title: (R.k2.saves[0] || {}).title, k4Title: (R.k4.saves[0] || {}).title };

  window.__step = "K6";
  window.__vis = "all"; window.__pub = 3; window.__changes = [];
  await mount({ ...base, mode: "edit", stage: "put", done: false, vis: "all" });
  press(/^넣고 모두에게 공개하기$/, host.querySelector(".v2-studio-pick")); await sleep(1500);
  R.k6 = { dialogs: dialogs().length, dlg: dlg() };
  press(/^취소$/, dialogs()[0]); await sleep(800);

  window.__step = "K7";
  window.__vis = "all"; window.__pub = 3; window.__changes = ["메모 표에 칸 «담당자» 를 더해요"];
  await mount({ ...base, mode: "edit", stage: "put", done: false, vis: "all" });
  press(/^넣고 모두에게 공개하기$/, host.querySelector(".v2-studio-pick")); await sleep(1500);
  R.k7 = { dialogs: dialogs().length, dlg: dlg() };
  press(/^취소$/, dialogs()[0]); await sleep(500);

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

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-put-pick-", virtualTimeBudget: 90000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (R.crash) { console.error("FAIL  페이지가 죽었다: " + R.crash); process.exit(1); }

let fails = 0;
const ok = (n) => console.log("ok  " + n);
const bad = (n, why) => { fails++; console.error("FAIL  " + n + " — " + why); };
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
const hit = (cond, n, got) => (cond ? ok(n) : bad(n, "실제 " + JSON.stringify(got)));

same(R.k1, { whoInCheck: false, saves: 0, picking: true, done: false, putName: "회의록 정리" }, "K1 ④ 엔 「누가 쓰나」 가 없고 「완료 · 다음 단계로」 는 저장 없이 ⑤ 고르는 화면으로");
same(R.k2, { dialogs: 0, saves: [{ publish: false, title: "회의록 정리" }], result: true, done: true }, "K2 ⑤ 「나만」 넣기 — 확인 창 없이 저장 한 번(공개 아님) · 결과 화면");
hit(R.k3 && R.k3.goText === "넣고 모두에게 공개하기" && R.k3.dialogs === 1 && R.k3.dlg && R.k3.dlg.title === "「회의록 정리」 앱을 워크스페이스 모두에게 공개할까요?" && /모든 사람이 앱 찾기에서/.test(R.k3.dlg.body)
  && R.k3.saves === 0 && R.k3.picking && !R.k3.done, "K3 「워크스페이스 모두」 — 확인 창 하나 · 취소하면 저장 없이 고르는 화면 그대로", R.k3);
same(R.k4, { saves: [{ publish: true, title: "회의록 정리" }], result: true, done: true }, "K4 확인 창 「모두에게 공개」 — 저장 한 번(공개) · 결과 화면");
same(R.k5, { k2Title: "회의록 정리", k4Title: "회의록 정리" }, "K5 ④ 에서 고친 이름이 저장에 실린다 · 닫았다 열어도(기록) 실린다");
hit(R.k6 && R.k6.dialogs === 1 && R.k6.dlg && R.k6.dlg.title === "이 버전을 모두에게 공개할까요?" && /공개 버전\(V3\)/.test(R.k6.dlg.body), "K6 이미 공개한 앱 — «이 버전을 모두에게» · 지금 공개 판 V3", R.k6);
hit(R.k7 && R.k7.dialogs === 1 && R.k7.dlg && /표가 이렇게 바뀌어요/.test(R.k7.dlg.title) && /담당자/.test(R.k7.dlg.body) && /모든 사람/.test(R.k7.dlg.body), "K7 표에 할 일이 있으면 확인 창 하나에 표 목록과 «모든 사람» 문장", R.k7);
same(R.errors, [], "W  페이지 예외 없음");
if (fails) { console.error(`studio-put-pick: ${fails} 실패`); process.exit(1); }
console.log("studio-put-pick: 통과");
