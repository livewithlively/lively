#!/usr/bin/env node
// 앱빌더 첫 화면 「만들던 앱」 카드에서 바로 지우기(#4632) — 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-26 «앱빌더 들어가자 마자 있는 화면의 타일에서 그 해당 만들고있는 앱 클릭해서 우측 사이드바로 옮기지 않아도 삭제할 수 있는 버튼을 그 카드에도 만들고싶어».
//  카드의 「지우기」 는 오른쪽 「모두 지우기」 와 같은 일(앱 · 앱빌딩 세션 · 기록)이고, 되돌릴 수 없으니 두 번 눌러야 지운다. 누른다고 카드가 골라지지 않는다.
//
// 엣지 표(스크래치패드 spec-tile-delete.md):
//  T1 만들던 앱 카드 — 「이어서 만들기」 · (첫 버전이 있으면) 「개발 정보」 · 「지우기」 만(「목록에서 빼기」 는 없앴다 · 원준 2026-10-26 «안 보이게 하려면 삭제»)
//  T2 한 번 — 요청 0건 · «한 번 더 누르면 지워져요» · 카드가 골라지지 않는다(오른쪽 패널 · 주소 그대로)
//  T3 한 번 누르고 4초 지남(경계) — 「지우기」 로 돌아오고 요청 0건 · 그 뒤 한 번 더 눌러도 다시 묻기만
//  T4 두 번(나만 보는 앱 있음) — /discard 1건 + 세션 완전 삭제 1건 · 카드 사라짐
//  T5 두 번(앱 없음 · 기획 단계) — discard 0건 · 세션 완전 삭제 1건 · 카드 사라짐
//  T6 두 번(공개한 앱의 만들던 것) — discard 0건(모두가 쓰는 앱) · 세션 완전 삭제 1건
//  T7 두 번인데 discard 가 500 — 카드 남음 · 세션 완전 삭제 0건 · 단추가 다시 눌리는 「지우기」 로
//  T8 오른쪽 패널 「모두 지우기」(기존) — 그대로 두 번 눌러 지운다
//  T9 지우는 사이 목록이 다시 그려져 새 카드로 또 두 번 — 앱 지우기 · 세션 지우기는 한 번씩만(격리 리뷰)
//  T10 세션 목록에서 온 만들던 앱 — 지난 세션(멈춘 것)은 선다 · 휴지통의 세션은 안 선다 · 이 브라우저 기록이 있어도 그 세션이 휴지통이면 안 선다
//  T11 지운 뒤 새로 연다(원준 2026-10-28 «다 삭제했는데 … 다 부활해있어» · «실제로 어디에서도 이게 다 지워지게») — 세션 목록에서 온 카드를 지우면
//      세션 완전 삭제(박스 id + 대화 uuid) 1건 + 대화 기록 파기 1건. 이 창의 기억(deletedSids)을 비운 채 다시 그려도 안 선다(서버 목록에서 영영 빠진다).
//      종전 DELETE ?reclaim=1 은 지난 세션으로 남겨 여기서 다시 섰다
//  T12 세션을 못 지우면 — 카드 남음 · 까닭을 알림 · 다시 누를 수 있다
//  T13 이미 없는 세션이면 — 지운 것으로 친다(카드 사라짐)
//  W  페이지 예외 없음 · 앱 목록 요청이 실제로 나갔다
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(카드에 지우기가 없던 origin/main 에서 T1~T7 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 카드 지우기 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=B", "--platform=browser", "--loader=ts", "--sourcefile=tile-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: "export { renderBuilderApp } from './v2/builder.ts'; export { deletedSids } from './v2/builder-model.ts';", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  가짜 서버 — 요청을 window.__calls 에 적는다. 지운 앱은 다음 목록에서 빠진다. window.__failDiscard 면 discard 가 500.
const FETCH = `<script>window.__calls = []; window.__gone = new Set(); window.__failDiscard = false; window.__slow = 0; window.__purged = new Set(); window.__trashSkip = {};
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const body = init && init.body ? JSON.parse(init.body) : null;
  window.__calls.push(method + " " + p + (p === "/api/ui/terminal/session-trash" && body ? " " + body.op + " " + body.ids.join(",") + (body.stop_live ? " stop" : "") : ""));
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const m = /^\\/api\\/ui\\/apps\\/([^/?]+)\\/discard$/.exec(p);
  if (m && method === "POST" && window.__slow) await new Promise((r) => setTimeout(r, window.__slow));
  if (m && method === "POST") { if (window.__failDiscard) return j({ error: "서버가 바빠요" }, 500); window.__gone.add(m[1]); return j({ ok: true }); }
  if (p.startsWith("/api/ui/terminal/sessions/") && method === "DELETE") return j({ ok: true });
  if (/^\\/api\\/ui\\/v6\\/sessions\\/[^/]+\\/purge/.test(p) && method === "POST") return j({ ok: true, log: { bytes: 10 } });
  if (p === "/api/ui/terminal/session-trash" && method === "POST") {
    const done = [], skipped = [];
    for (const id of body.ids) { if (window.__trashSkip[id]) skipped.push({ id, why: window.__trashSkip[id] }); else { window.__purged.add(id); done.push(id); } }
    return j({ ok: true, op: body.op, done, skipped });
  }
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (p.startsWith("/api/ui/apps?")) {
    const app = (id, title, visibility) => ({ id, title, status: "active", visibility, installed_by: "wonjoon-jang", is_owner: true, current_version_no: 1, manifest: { ui: { pages: [{}] } } });
    return j({ apps: [app("notes", "회의록", "me"), app("shared1", "주간 안건", "all"), app("mine2", "출장비", "me"), app("mine3", "명함", "me")].filter((a) => !window.__gone.has(a.id)) });
  }
  return j({});
};</script>`;

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const host = document.getElementById("host");
  const NOW = Date.now();
  const rec = (sid, title, appId, stage, i) => ({ sid, pid: 0, what: title + " 앱", place: "both", appId, known: [], at: NOW - i * 1000, stage, mode: "new", title, named: true, reached: 2 });
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([
    rec("box-a", "회의록", "notes", "fix", 1),        // 나만 보는 앱이 있는 만들던 앱
    rec("box-b", "여행 계획", "", "plan", 2),         // 아직 앱 없음(기획 단계)
    rec("box-c", "주간 안건", "shared1", "fix", 3),   // 공개한 앱을 고치던 것
    rec("box-d", "출장비", "mine2", "fix", 4),        // discard 가 실패할 것
    rec("box-e", "명함", "mine3", "fix", 5),          // 지우는 사이 다시 그려질 것
    rec("box-t", "다른 데서 지운 것", "", "plan", 6), // 다른 브라우저에서 지워 세션이 휴지통에 있다
    rec("box-f", "견적", "", "plan", 7),              // 세션을 휴지통에 못 넣을 것(컴퓨터가 꺼짐)
    rec("box-g", "없는 세션", "", "plan", 8),         // 서버에 그 세션이 이미 없다
  ]));
  //  셸의 세션 목록 — 서버처럼 휴지통에 넣은 세션엔 trashedAt 이 실린다(sess-merge). 지난 세션(restorable)은 그대로 실린다.
  const row = (id, label, i, trashedAt = null) => ({ id, label, projectId: null, owned: true, lastSeen: NOW - (20 + i) * 1000, restorable: true, trashedAt, logId: "uuid-" + id, logNode: "", raw: { claudeSessionId: "uuid-" + id } });
  const SESS = [row("box-s", '"메모" 앱 제작', 1), row("box-u", '"할 일" 앱 제작', 2, "2026-10-28T00:00:00Z"), row("box-t", '"다른 데서 지운 것" 앱 제작', 3, "2026-10-28T00:00:00Z")];
  //  완전 삭제한 세션은 서버 목록에서 빠진다(session-trash purged).
  const env = { projects: () => [], sessions: () => SESS.filter((s) => !window.__purged.has(s.id)), redrawSide: () => {}, setRoute: () => {} };
  history.replaceState(null, "", "#/builder");
  B.renderBuilderApp(host, ["builder"], new URLSearchParams(""), env);
  await sleep(800);

  const draftSec = () => [...host.querySelectorAll(".v2-bld-sec")].find((s) => /^만들던 앱/.test(txt(s.querySelector("h3")) || ""));
  const cardOf = (title) => [...(draftSec() || host).querySelectorAll(".v2-bld-card")].find((c) => txt(c.querySelector(".hd b")) === title) || null;
  const btnsOf = (c) => (c ? [...c.querySelectorAll("button")].map((b) => txt(b)) : []);
  const delOf = (c) => (c ? [...c.querySelectorAll("button")].find((b) => /^지우기$|한 번 더 누르면/.test(txt(b))) : null);
  const writes = (from) => window.__calls.slice(from).filter((c) => !c.startsWith("GET "));
  const panelHead = () => txt(host.querySelector(".v2-bld-panel h3, .v2-bld-side h3")) || txt([...host.querySelectorAll("h3")].pop());

  // T10
  R.t10 = { stopped: !!cardOf("메모"), trashed: !!cardOf("할 일"), localTrashed: !!cardOf("다른 데서 지운 것") };
  // T1
  R.t1 = btnsOf(cardOf("회의록"));
  // T2 — 한 번
  const a = cardOf("회의록");
  const panelBefore = panelHead(), hashBefore = location.hash;
  let mark = window.__calls.length;
  const d1 = delOf(a); if (d1) d1.click();
  await sleep(300);
  R.t2 = { has: !!d1, text: txt(delOf(cardOf("회의록"))), writes: writes(mark), on: !!(cardOf("회의록") && cardOf("회의록").classList.contains("on")), panelSame: panelHead() === panelBefore, hash: location.hash === hashBefore };
  // T3 — 4초가 지나면 돌아온다 · 그 뒤 한 번은 다시 묻기만
  await sleep(4200);
  R.t3 = { text: txt(delOf(cardOf("회의록"))), writes: writes(mark) };
  if (delOf(cardOf("회의록"))) delOf(cardOf("회의록")).click();
  await sleep(200);
  R.t3.again = { text: txt(delOf(cardOf("회의록"))), writes: writes(mark) };
  // T4 — 두 번째(4초 안)
  if (delOf(cardOf("회의록"))) delOf(cardOf("회의록")).click();
  await sleep(900);
  R.t4 = { writes: writes(mark), gone: !cardOf("회의록") };
  // T5 · T6 — 두 번 연달아
  const twice = async (title) => {
    const from = window.__calls.length;
    if (delOf(cardOf(title))) delOf(cardOf(title)).click();
    await sleep(150);
    if (delOf(cardOf(title))) delOf(cardOf(title)).click();
    await sleep(900);
    return { writes: writes(from), gone: !cardOf(title) };
  };
  R.t5 = await twice("여행 계획");
  R.t6 = await twice("주간 안건");
  // T7 — discard 가 실패
  window.__failDiscard = true;
  R.t7 = await twice("출장비");
  const d7 = delOf(cardOf("출장비"));
  R.t7.btn = d7 ? { text: txt(d7), disabled: d7.disabled } : null;
  // T8 — 카드를 골라 오른쪽 「모두 지우기」
  window.__failDiscard = false;
  const c8 = cardOf("출장비");
  if (c8) c8.querySelector(".hd").click();
  await sleep(900);
  const pb = () => [...host.querySelectorAll("button")].find((b) => /모두 지우기|한 번 더 누르면 지워져요\. 되돌릴/.test(txt(b)));
  mark = window.__calls.length;
  R.t8 = { panel: !!pb(), hide: [...host.querySelectorAll("button")].filter((b) => /목록에서 빼기/.test(txt(b))).length, mini: [...host.querySelectorAll(".v2-bld-mini")].map(txt).join(" | ") };
  if (pb()) pb().click();
  await sleep(150);
  R.t8.armed = txt(pb());
  if (pb()) pb().click();
  await sleep(900);
  R.t8.writes = writes(mark); R.t8.gone = !cardOf("출장비");

  // T9 — 앱 지우기가 느린 사이 목록을 다시 그리고 새 카드로 또 두 번
  window.__slow = 1200;
  mark = window.__calls.length;
  if (delOf(cardOf("명함"))) delOf(cardOf("명함")).click();
  await sleep(100);
  if (delOf(cardOf("명함"))) delOf(cardOf("명함")).click();
  await sleep(200);
  B.renderBuilderApp(host, ["builder"], new URLSearchParams(""), env);
  await sleep(300);
  R.t9 = { again: !!cardOf("명함") };
  if (delOf(cardOf("명함"))) delOf(cardOf("명함")).click();
  await sleep(100);
  if (delOf(cardOf("명함"))) delOf(cardOf("명함")).click();
  await sleep(2500);
  R.t9.writes = writes(mark); R.t9.gone = !cardOf("명함");
  window.__slow = 0;
  // T11 — 세션 목록에서 온 「메모」 를 지우고, 이 창의 기억을 비운 채(새로 연 것처럼) 다시 그린다
  R.t11 = await twice("메모");
  B.deletedSids.clear();
  B.renderBuilderApp(host, ["builder"], new URLSearchParams(""), env);
  await sleep(600);
  R.t11.reopened = !!cardOf("메모");
  // T12 — 그 컴퓨터가 꺼져 세션을 휴지통에 못 넣는다
  window.__trashSkip["box-f"] = "돌고 있는 세션을 멈추지 못했어요";
  //  알림은 3.6초 뒤 걷히므로 선 것을 그때그때 적어 둔다.
  const toastLog = [];
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => toastLog.push(txt(n))))).observe(document.getElementById("toasts"), { childList: true });
  R.t12 = await twice("견적");
  const d12 = delOf(cardOf("견적"));
  R.t12.btn = d12 ? { text: txt(d12), disabled: d12.disabled } : null;
  R.t12.toast = toastLog.join(" | ");
  // T13 — 서버에 이미 없는 세션
  window.__trashSkip["box-g"] = "본인 세션이 아니거나 없는 세션";
  R.t13 = await twice("없는 세션");
  R.toasts = [...document.querySelectorAll("#toasts .toast")].length;
  R.listed = window.__calls.filter((c) => c.startsWith("GET /api/ui/apps?")).length;
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}
  html,body{margin:0} #host{width:1100px;height:860px;position:relative}
</style>
<div id="host"></div>
<div id="toasts"></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "tile-del-", virtualTimeBudget: 60000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why) => (cond ? ok(n) : bad(n, JSON.stringify(why)));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
const DEL = (sid) => "POST /api/ui/terminal/session-trash purge " + sid;
const PURGE_ALL = (sid) => ["POST /api/ui/terminal/session-trash purge " + sid + ",uuid-" + sid, "POST /api/ui/v6/sessions/uuid-" + sid + "/purge?node="];
const DISCARD = (id) => "POST /api/ui/apps/" + id + "/discard";

same(R.t1, ["이어서 만들기", "개발 정보", "지우기"], "T1 만들던 앱 카드 — 「이어서 만들기」 · 「개발 정보」(첫 버전이 있는 카드) · 「지우기」 만(「목록에서 빼기」 없음)");
same(R.t2 && [R.t2.has, R.t2.text, R.t2.writes, R.t2.on, R.t2.panelSame, R.t2.hash], [true, "한 번 더 누르면 지워져요", [], false, true, true],
  "T2 한 번 누르면 묻기만 — 요청 0건 · 카드가 골라지지 않는다(오른쪽 · 주소 그대로)");
same(R.t3 && [R.t3.text, R.t3.writes, R.t3.again.text, R.t3.again.writes], ["지우기", [], "한 번 더 누르면 지워져요", []], "T3 4초가 지나면 「지우기」 로 돌아온다 · 그 뒤 한 번은 다시 묻기만");
same(R.t4 && [R.t4.writes, R.t4.gone], [[DISCARD("notes"), DEL("box-a")], true], "T4 두 번 — 나만 보는 앱 · 앱빌딩 세션을 지우고 카드가 사라진다");
same(R.t5 && [R.t5.writes, R.t5.gone], [[DEL("box-b")], true], "T5 앱이 없는 만들던 앱 — 세션만 지운다");
same(R.t6 && [R.t6.writes, R.t6.gone], [[DEL("box-c")], true], "T6 공개한 앱을 고치던 것 — 모두가 쓰는 앱은 지우지 않고 세션만");
same(R.t7 && [R.t7.writes, R.t7.gone, R.t7.btn], [[DISCARD("mine2")], false, { text: "지우기", disabled: false }], "T7 앱을 못 지우면 — 카드 남음 · 세션 그대로 · 다시 누를 수 있다");
check(R.t8 && R.t8.hide === 0 && !/목록에서 빼기/.test(R.t8.mini || "") && /늘 보여요/.test(R.t8.mini || "") && /완전히 지워요/.test(R.t8.mini || "") && !/휴지통으로 옮겨요/.test(R.t8.mini || ""), "T8 오른쪽 패널에도 「목록에서 빼기」 가 없다 · 지우기 전까지 늘 보인다고 말한다", R.t8);
same(R.t8 && [R.t8.panel, R.t8.armed, R.t8.writes, R.t8.gone], [true, "한 번 더 누르면 지워져요. 되돌릴 수 없어요.", [DISCARD("mine2"), DEL("box-d")], true], "T8 오른쪽 「모두 지우기」 도 그대로 두 번 눌러 지운다");
same(R.t9 && [R.t9.again, R.t9.writes, R.t9.gone], [true, [DISCARD("mine3"), DEL("box-e")], true], "T9 지우는 사이 다시 그려진 카드로 또 눌러도 한 번만 지운다");
same(R.t10, { stopped: true, trashed: false, localTrashed: false }, "T10 지난 세션(멈춘 만들기)은 선다 · 휴지통의 세션은 안 선다 · 이 브라우저 기록이 있어도 세션이 휴지통이면 안 선다");
same(R.t11 && [R.t11.writes, R.t11.gone, R.t11.reopened], [PURGE_ALL("box-s"), true, false], "T11 지운 뒤 새로 열어도 카드가 다시 서지 않는다(세션 완전 삭제 + 대화 기록 파기)");
same(R.t12 && [R.t12.writes, R.t12.gone, R.t12.btn, /앱빌딩 세션을 지우지 못했어요/.test(R.t12.toast) && /멈추지 못했어요/.test(R.t12.toast)], [[DEL("box-f")], false, { text: "지우기", disabled: false }, true], "T12 세션을 못 옮기면 카드 남음 · 까닭을 알림 · 다시 누를 수 있다");
same(R.t13 && [R.t13.writes, R.t13.gone], [[DEL("box-g")], true], "T13 이미 없는 세션이면 지운 것으로 친다");
same([R.listed > 0, R.toasts > 0, R.errors], [true, true, []], "W  앱 목록 요청이 실제로 나갔다 · 알림이 섰다 · 페이지 예외 없음");

console.log(`\n#4632 앱빌더 카드 지우기: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
