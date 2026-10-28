#!/usr/bin/env node
// 앱빌더 좁은 화면(#4632 원준 2026-10-29 «싹 다 고쳐» — 점검 목록 g5 · 5-1~5-6) — 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//  같은 페이지를 창 폭 500(폰 · 헤드리스 크롬 창의 최소 폭이 500 이다 — 390 을 줘도 500 으로 뜬다)과 1200(넓은 화면)으로 두 번 띄워 잰다.
//  폰 문턱(≤640 · ≤760 · ≤900)은 500 에서 다 걸린다. 넓은 화면은 종전 그대로여야 한다. 390 실측 화면은 PR 본문에 붙인다.
//
// 엣지 표:
//  N1 (5-1) 500 · 고른 카드 없음 — 배포 설정 칸이 없고(반쯤 걸쳐 카드를 가리던 것) 목록만
//  N2 (5-1) 500 · 카드를 누름 — 뒤로 가기 한 칸이 쌓이고(history.length +1) 배포 설정만 · 맨 위 「‹ 목록」
//  N3 (5-1) 500 · 「‹ 목록」 — 쌓은 칸을 되돌려 주소가 #/builder · 목록이 다시 선다
//  N4 (5-1) 1200 — 고른 것이 없어도 배포 설정 칸이 서고 「‹ 목록」 은 없다 · 카드를 눌러도 뒤로 가기 칸을 쌓지 않는다
//  H1 (5-2) 500 · ③ 머리줄 — 공개하기 · 되돌리기 · AI 세션 보기는 숨고 「⋯」 · 「닫기」 는 화면 안 · 앱 이름 폭 > 0
//  H2 (5-2) 500 · 「⋯」 — 보이는 접은 단추만 같은 이름으로 · 누르면 원래 단추가 한 일(AI 세션 창이 열린다)
//  H3 (5-2) 1200 — 접은 단추가 그대로 보이고 「⋯」 는 없다
//  S1 (5-3) 500 · 단계 바 — 지금 단계만 이름이 보이고 나머지는 번호만 · 넘치지 않는다
//  S2 (5-3) 1200 — 다섯 단계 이름이 다 보인다
//  I1 (5-5) 500 · 처음 안내 — 세 장이 한 줄에 하나씩(한 칸) · 그림이 칸을 넘지 않는다
//  T1 (5-4) 500 · 둘러보기 2번(긴 카드) — 단추 줄이 상자 안 · 상자가 화면 안 · 장면 칸이 스스로 굴린다
//  R1 (5-6) 500 · 실제 화면 막대 — 「완료 · 다음 단계로」 · 자리 바꾸기는 숨고 「⋯」 · 도구는 그림만 · 두 줄 이하 · 모든 단추가 화면 안 · 아래 탭 바(56px) 위
//  R2 (5-6) 500 · 막대의 「⋯」 → 「완료 · 다음 단계로」 — onLike 1건
//  R3 (5-6) 1200 — 「완료 · 다음 단계로」 가 막대에 그대로 · 「⋯」 없음
//  W  페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(origin/main 에서 390 쪽이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 좁은 화면 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts'; export { renderBuilderApp } from './v2/builder.ts'; export { openReview, closeReview } from './v2/app-review.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=narrow-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
const FETCH = `<script>
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u);
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json", "X-Log-To": "5" } });
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p.startsWith("/api/ui/apps/notes/versions")) return j({ versions: [1, 2, 3].map((n) => ({ version_no: n, is_current: n === 3, is_published: n === 2, note: n > 1 ? "고침" : "초안", saved_at: "2026-10-19T00:00:00Z" })) });
  if (/^\\/api\\/ui\\/apps\\/notes(\\?|$)/.test(p)) return j({ app: { id: "notes", title: "회의록 정리 도우미", visibility: "all", published_version_no: 2, current_version_no: 3, can_edit: true, can_publish: true, draft: { by: "wonjoon-jang", version_no: 3 }, manifest: { studio: { card: ${JSON.stringify(CARD)} } } } });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (p.startsWith("/api/ui/org/members")) return j({ members: [{ id: "wonjoon-jang", display_name: "원준", kind: "human" }] });
  if (p === "/api/ui/apps" || p.startsWith("/api/ui/apps?")) return j({ apps: [
    { id: "notes", title: "회의록", status: "active", visibility: "me", installed_by: "wonjoon-jang", made_by: "wonjoon-jang", owner_member: "wonjoon-jang", is_owner: true, can_edit: true, current_version_no: 3, manifest: { ui: { pages: [{}] }, studio: { put: true, place: "both" } } },
    { id: "chan", title: "팀 채널", status: "active", visibility: "me", installed_by: "wonjoon-jang", made_by: "wonjoon-jang", owner_member: "wonjoon-jang", is_owner: true, can_edit: true, current_version_no: 2, manifest: { ui: { pages: [{}] }, studio: { put: true } } }] });
  if (p.includes("sessions")) return j({ sessions: [] });
  return j({});
};</script>`;

async function PAGE_MAIN() {
  const R = { w: innerWidth }; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const shown = (n) => !!n && n.isConnected && getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 0;
  const W = innerWidth;

  // ── 앱빌더 첫 화면 ──
  window.__step = "N";
  const bhost = document.getElementById("bhost");
  const env = { projects: () => [], sessions: () => [], sessionsReady: () => true, redrawSide: () => {}, setRoute: () => {} };
  history.replaceState(null, "", "#/builder");
  St.renderBuilderApp(bhost, ["builder"], new URLSearchParams(""), env);
  await sleep(1200);
  const panel = () => bhost.querySelector(".v2-bld-panel"), list = () => bhost.querySelector(".v2-bld-list");
  R.n1 = { panel: shown(panel()), list: shown(list()), cards: bhost.querySelectorAll(".v2-bld-card").length };
  const h0 = history.length;
  const card = [...bhost.querySelectorAll(".v2-bld-card")].find((c) => txt(c.querySelector(".hd b")) === "회의록");
  if (card) card.querySelector(".hd").click();
  await sleep(1200);
  const back = bhost.querySelector(".v2-bld-back");
  R.n2 = { pushed: history.length - h0, hash: location.hash, panel: shown(panel()), list: shown(list()), back: shown(back), backText: txt(back), first: panel() && panel().firstElementChild === back };
  if (back && shown(back)) { back.click(); await sleep(1200); }
  R.n3 = { hash: location.hash, list: shown(list()), panel: shown(panel()) };

  // ── ③ 만들기 화면 머리줄 · 단계 바 ──
  window.__step = "H";
  const host = document.getElementById("host");
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ intro: 1, coach: { plan: 1, draft: 1, check: 1, put: 1, fix: 1 } }));
  const rec = { sid: "box-s1", pid: 0, what: "회의록을 날짜별로 정리", place: "both", appId: "notes", known: [], at: Date.now() - 600000, stage: "fix", card: window.__CARD, round: 2, from: 5, mode: "new", title: "회의록", named: true, reached: 4 };
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec]));
  St.openAppStudio({ sid: "box-s1" }, { host, onClose: () => {}, onSee: () => {} });
  await sleep(1800);
  const top = host.querySelector(".v2-studio-top--build");
  const hr = host.getBoundingClientRect();
  const fold = top ? [...top.querySelectorAll(".v2-studio-fold")] : [];
  const close = top ? [...top.querySelectorAll("button")].find((b) => txt(b) === "닫기") : null;
  const more = top ? top.querySelector(".v2-studio-more") : null;
  const nameEl = top ? top.querySelector(".v2-studio-name") : null;
  R.h1 = { foldShown: fold.filter(shown).map(txt), foldAll: fold.map(txt), more: shown(more), closeIn: !!close && shown(close) && close.getBoundingClientRect().right <= hr.right + 0.5, nameW: nameEl ? Math.round(nameEl.getBoundingClientRect().width) : 0, overflow: top ? top.scrollWidth - top.clientWidth : -1 };
  if (more && shown(more)) {
    more.click(); await sleep(200);
    const menu = host.querySelector(".v2-studio-help");
    R.h2 = { items: menu ? [...menu.querySelectorAll("button")].map(txt) : null };
    const chatItem = menu ? [...menu.querySelectorAll("button")].find((b) => txt(b) === "AI 세션 보기") : null;
    if (chatItem) { chatItem.click(); await sleep(400); }
    const win = host.querySelector(".v2-studio-chatwin");
    R.h2.chatOpen = !!win && !win.hidden;
    R.h2.menuGone = !host.querySelector(".v2-studio-help");
  }
  const bar = host.querySelector(".v2-studio-bar");
  const kids = bar ? [...bar.children] : [];
  R.s1 = { names: kids.map((k) => shown(k.querySelector(".v2-studio-stl"))), on: kids.findIndex((k) => k.classList.contains("on")), overflow: bar ? bar.scrollWidth - bar.clientWidth : -1, text: txt(bar) };

  // ── 처음 안내 · 둘러보기 ──
  window.__step = "I";
  St.closeAppStudio();
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ coach: {} }));
  St.openAppStudio(null, { host, onClose: () => {}, onSee: () => {} });
  await sleep(800);
  const cards = host.querySelector(".v2-studio-intro-cards");
  const cols = cards ? getComputedStyle(cards).gridTemplateColumns.split(" ").length : 0;
  const pics = cards ? [...cards.querySelectorAll(".pic")] : [];
  R.i1 = { cols, picsFit: pics.every((p) => { const c = p.parentElement.getBoundingClientRect(), r = p.getBoundingClientRect(); return r.left >= c.left - 0.5 && r.right <= c.right + 0.5; }), picOverflow: pics.map((p) => getComputedStyle(p).overflow) };
  const tourBtn = [...host.querySelectorAll(".v2-studio-intro button")].find((b) => /둘러보기/.test(txt(b) || ""));
  if (tourBtn) { tourBtn.click(); await sleep(300); }
  const next = host.querySelector(".v2-studio-tour .v2-studio-go");
  if (next) { next.click(); await sleep(300); }
  const box = host.querySelector(".v2-studio-tour .v2-studio-intro-box"), act = box ? box.querySelector(".v2-studio-intro-act") : null, tb = box ? box.querySelector(".v2-studio-tour-body") : null;
  if (box && act) {
    const b = box.getBoundingClientRect(), a = act.getBoundingClientRect();
    R.t1 = { h2: txt(box.querySelector("h2")), actIn: a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5, boxIn: b.bottom <= hr.bottom + 0.5, scrolls: !!tb && getComputedStyle(tb).overflowY === "auto" };
  } else R.t1 = { missing: true };
  St.closeAppStudio();

  // ── 실제 화면 막대 ──
  window.__step = "R";
  let liked = 0;
  const rh = { appId: "mn", title: "회의록", route: "#/i/x", pins: [], general: "", version: 3, waiting: false, chat: document.getElementById("chat"),
    onTalk: async () => true, onChange: () => {}, onSend: () => {}, onLike: () => { liked++; }, onBack: () => {}, onClose: () => {} };
  location.hash = rh.route;
  St.openReview(rh);
  await sleep(400);
  const rb = document.querySelector(".v2-review-bar");
  const like = rb ? [...rb.querySelectorAll("button")].find((b) => txt(b) === "완료 · 다음 단계로") : null;
  const rmore = rb ? rb.querySelector(".v2-review-more") : null;
  const r = rb ? rb.getBoundingClientRect() : null;
  const btns = rb ? [...rb.querySelectorAll("button")].filter(shown) : [];
  const toolNames = rb ? [...rb.querySelectorAll(".v2-review-tools button > span:not(.ico)")].map(shown) : [];
  R.r1 = { like: shown(like), more: shown(rmore), h: r ? Math.round(r.height) : 0, bottom: r ? Math.round(innerHeight - r.bottom) : 0, allIn: btns.every((b) => { const x = b.getBoundingClientRect(); return x.left >= -0.5 && x.right <= innerWidth + 0.5; }), toolNames };
  if (rmore && shown(rmore)) {
    rmore.click(); await sleep(200);
    const m = document.querySelector(".v2-review-menu");
    R.r2 = { items: m ? [...m.querySelectorAll("button")].map(txt) : null, inView: m ? (() => { const x = m.getBoundingClientRect(); return x.left >= 0 && x.right <= innerWidth && x.top >= 0; })() : false };
    const it = m ? [...m.querySelectorAll("button")].find((b) => txt(b) === "완료 · 다음 단계로") : null;
    if (it) { it.click(); await sleep(100); }
    R.r2.liked = liked;
  }
  St.closeReview();
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}

const page = (w, h) => `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "47-v2-rail.css")}
  html,body{margin:0} #bhost{width:${w}px;height:${h}px;position:relative} #host{width:${w}px;height:${h}px;position:relative;overflow:hidden}
</style>
<div id="bhost"></div><div id="host"></div>
<iframe class="v2-appui-frame" data-app-id="mn" srcdoc="<p>앱</p>" style="position:fixed;left:0;top:0;width:${w}px;height:${h - 120}px;border:0"></iframe>
<div id="chat" class="v2-studio-chat"></div>
<div id="toasts"></div>
<pre id="out" style="position:absolute;left:-9999px">PENDING</pre>
${FETCH}
<script>window.__CARD = ${JSON.stringify(CARD)};</script>
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const run = async (w, h) => {
  const dom = await dumpDom(chrome, { html: page(w, h - 64), prefix: "bld-narrow-", virtualTimeBudget: 60000, args: [`--window-size=${w},${h}`] });
  const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  if (!m) { console.error(`FAIL  ${w}px 결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n` + dom.slice(-800)); process.exit(1); }
  const R = JSON.parse(m[1]);
  if (process.env.DEBUG) console.log(w, JSON.stringify(R, null, 1));
  if (R.crash) { console.error(`FAIL  ${w}px 페이지가 도중에 넘어졌다 — ` + R.crash); process.exit(1); }
  return R;
};

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why) => (cond ? ok(n) : bad(n, JSON.stringify(why)));

const N = await run(500, 844);
check(N.w === 500, "창 폭 500 으로 떴다", N.w);
check(N.n1 && N.n1.cards >= 2 && N.n1.list && !N.n1.panel, "N1 500 · 고른 카드 없음 — 배포 설정 칸 없이 목록만", N.n1);
check(N.n2 && N.n2.pushed === 1 && /sel=notes/.test(N.n2.hash) && N.n2.panel && !N.n2.list && N.n2.back && N.n2.first && N.n2.backText === "‹ 목록", "N2 500 · 카드를 누르면 뒤로 가기 한 칸 · 배포 설정만 · 맨 위 「‹ 목록」", N.n2);
check(N.n3 && N.n3.hash === "#/builder" && N.n3.list && !N.n3.panel, "N3 500 · 「‹ 목록」 — 쌓은 칸을 되돌려 목록으로", N.n3);
check(N.h1 && N.h1.foldAll.length === 3 && N.h1.foldShown.length === 0 && N.h1.more && N.h1.closeIn && N.h1.nameW > 20 && N.h1.overflow <= 0, "H1 500 · 머리줄 — 공개하기 · 되돌리기 · AI 세션 보기는 「⋯」 로 · 「닫기」 는 화면 안 · 이름이 보인다", N.h1);
check(N.h2 && Array.isArray(N.h2.items) && N.h2.items.includes("AI 세션 보기") && N.h2.items.includes("공개하기") && N.h2.chatOpen && N.h2.menuGone, "H2 500 · 「⋯」 — 보이는 단추만 같은 이름 · 누르면 원래 단추가 한 일", N.h2);
check(N.s1 && N.s1.on >= 0 && N.s1.names.filter(Boolean).length === 1 && N.s1.names[N.s1.on] && N.s1.overflow <= 0 && /^① /.test(N.s1.text || ""), "S1 500 · 단계 바 — 지금 단계만 이름 · 나머지는 번호 · 넘치지 않는다(글은 그대로)", N.s1);
check(N.i1 && N.i1.cols === 1 && N.i1.picsFit && N.i1.picOverflow.every((o) => o === "hidden"), "I1 500 · 처음 안내 — 세 장이 한 줄에 하나씩 · 그림이 칸을 넘지 않는다", N.i1);
check(N.t1 && /^2\./.test(N.t1.h2 || "") && N.t1.actIn && N.t1.boxIn && N.t1.scrolls, "T1 500 · 둘러보기 2번 — 단추 줄이 상자 안 · 상자가 화면 안 · 장면만 굴린다", N.t1);
check(N.r1 && !N.r1.like && N.r1.more && N.r1.h <= 100 && N.r1.allIn && N.r1.toolNames.length === 4 && N.r1.toolNames.every((x) => !x) && N.r1.bottom >= 56, "R1 500 · 실제 화면 막대 — 완료는 「⋯」 로 · 도구는 그림만 · 두 줄 이하 · 화면 안 · 아래 탭 바 위", N.r1);
check(N.r2 && Array.isArray(N.r2.items) && N.r2.items.includes("완료 · 다음 단계로") && N.r2.inView && N.r2.liked === 1, "R2 500 · 막대 「⋯」 → 「완료 · 다음 단계로」 — onLike 1건 · 메뉴가 화면 안", N.r2);
check(N.errors && N.errors.length === 0, "W 500 · 페이지 예외 없음", N.errors);

const D = await run(1200, 900);
check(D.w === 1200, "창 폭 1200 으로 떴다", D.w);
check(D.n1 && D.n1.panel && D.n1.list && D.n2 && D.n2.pushed === 0 && !D.n2.back && D.n2.list && D.n2.panel, "N4 1200 — 배포 설정 칸이 늘 서고 「‹ 목록」 없음 · 고를 때 뒤로 가기 칸을 쌓지 않는다", { n1: D.n1, n2: D.n2 });
check(D.h1 && D.h1.foldShown.includes("AI 세션 보기") && !D.h1.more && D.h1.closeIn, "H3 1200 — 접은 단추가 그대로 보이고 「⋯」 없음", D.h1);
check(D.s1 && D.s1.names.every(Boolean), "S2 1200 — 다섯 단계 이름이 다 보인다", D.s1);
check(D.i1 && D.i1.cols === 3, "I2 1200 — 처음 안내는 세 칸", D.i1);
check(D.r1 && D.r1.like && !D.r1.more, "R3 1200 — 「완료 · 다음 단계로」 가 막대에 그대로 · 「⋯」 없음", D.r1);
check(D.errors && D.errors.length === 0, "W 1200 · 페이지 예외 없음", D.errors);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
