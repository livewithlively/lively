#!/usr/bin/env node
// 앱빌더 ③ 실제 화면 막대 · 와이어프레임 보드 — 점검(2026-10-28) 묶음 g3 · 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-29 «다 봤는데 그냥 싹 다 고쳐». 사양 · 엣지 표(스크래치패드 spec-audit-g3.md)의 막대 · 보드 몫:
//  P1 탐침 없이 뜬 프레임 → 막대를 열면 탐침과 함께 다시 띄운다 · 이미 든 것은 그대로   P2 막대를 닫은 뒤 다시 띄우면 표시가 빠진다(3-1)
//  F1 막대를 위로(↑) 옮겨 앱 위쪽 가운데를 덮어도 앱이 보인다   F2 대화 칸이 덮어도   F3 우리 것이 아닌 덮개면 안 보인다(3-2)
//  S1 도구를 쓴 채 휠 → 앱 문서가 스크롤 · 바깥 문서는 안 움직인다   S2 번호가 스크롤을 따라간다 · 화면 밖이면 안 그린다
//  S3 짚을 때의 스크롤이 핀에 남고 AI 글이 «내린 화면» 을 말한다(0 이면 말 없음)   S4 새 문서면 스크롤은 다시 0(3-3)
//  Q1 그 자리 칸이 열린 채 앞 코멘트가 빠진 새 목록 → 칸 그대로 · 새 번호 · 초점   Q2 그 코멘트가 없어졌으면 닫는다
//  Q3 기다림 시작에도 닫지 않는다   Q4 「취소」 는 그 코멘트만 지운다(3-4)
//  B1 보드 칸이 열린 채 앞 코멘트가 빠지고 refresh → 「취소」 가 그 코멘트만   B2 칸의 코멘트가 없어졌으면 닫는다(3-5)
//  B3 그림 없는 보드의 핀 = 그 화면 카드 기준 + screen · AI 글은 «보드에 놓은 앱 화면»   B4 카드 밖은 코멘트를 안 만든다(3-8)
//  B5 보드 칸에서 한글 조합 중 Esc 는 닫지 않는다(3-13)   M1 위치 답 거르기 한 벌(readHitRes · 3-13)
//  T1 써 보기면 번호 · 상자가 흐리고 안 눌린다(3-9)   K1 고치는 중에 열면 보낸 때부터 센다(3-10)
//  A1 AI 가 확인을 기다리면 «「AI에게 말하기」를 눌러 답해 주세요» · 「AI에게 답하기」 가 대화 칸을 연다(3-7)   W 페이지 예외 없음
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
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 막대 · 보드 점검 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-review.ts'; export * as Flow from './lib/studio-flow.ts'; export * as Ui from './v2/app-ui.ts'; export * as Wb from './v2/wire-board.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=Rv", "--platform=browser", "--loader=ts", "--sourcefile=audit-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  가짜 서버 — 앱 화면(긴 문서)만. 그 밖은 빈 답.
const FETCH = `<script>window.__uiGets = 0;
const APP_HTML = '<!doctype html><html><body style="margin:0"><h1 style="margin:0;height:60px">회의 제목</h1><div style="height:3000px;background:linear-gradient(#fff,#eee)"></div><button style="position:absolute;top:1500px;left:20px">아래 단추</button></body></html>';
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u);
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json" } });
  if (/^\\/api\\/ui\\/apps\\/mn\\/ui/.test(p)) { window.__uiGets++; return j({ html: APP_HTML, title: "회의록", page_key: "main", csp: {} }); }
  return j({});
};</script>`;

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  localStorage.setItem("lively_ui_token", "t");
  { const st = document.createElement("style"); st.textContent = ".v2-review-talk, .v2-review-talk.on { transition: none !important; }"; document.head.append(st); }
  //  앱 프레임이 보내는 스크롤 알림을 엿듣는다(관측 장치 — 탐침이 실제로 돌았나)
  const scrolls = []; window.addEventListener("message", (e) => { const m = e.data; if (m && m.__studio === "scroll") scrolls.push(m.sy); });

  window.__step = "P1";
  //  검토가 아닐 때 띄운 앱 화면 — 탐침 없음
  const fr = await Rv.Ui.mountAppUiFrame("mn", { title: "회의록" });
  Object.assign(fr.root.style, { position: "fixed", left: "0px", top: "40px", width: "1400px", height: "600px", border: "0" });
  document.body.append(fr.root);
  await sleep(600);
  R.p1 = { before: fr.root.dataset.probe || "", scrollsBefore: scrolls.length };
  const chat = document.getElementById("chat"), sent = [];
  const pinA = { kind: "pin", x: 0.1, y: 0.1, where: "", note: "앞에 보낸 것", sent: true };
  const pinB = { kind: "pin", x: 0.5, y: 0.5, where: "", note: "가운데" };
  const pinC = { kind: "pin", x: 0.7, y: 0.2, where: "", note: "오른쪽 위" };
  const host = { appId: "mn", title: "회의록", route: "#/i/x", pins: [pinA, pinB, pinC], general: "", version: 2, waiting: false, chat,
    onTalk: async (t) => { sent.push(t); return true; }, onChange: () => {}, onSend: () => {}, onLike: () => {}, onBack: () => {} };
  location.hash = host.route;
  let api = Rv.openReview(host);
  await sleep(900);
  R.p1.after = fr.root.dataset.probe || ""; R.p1.scrollsAfter = scrolls.length; R.p1.again = Rv.Ui.ensureReviewProbe ? Rv.Ui.ensureReviewProbe("mn") : -1;

  window.__step = "F";
  const layer = () => $(".v2-review-layer"), hint = () => ($(".v2-review-hint") || {}).textContent || "";
  R.f0 = { shown: !layer().hidden };
  $(".v2-review-flip").click(); await sleep(700);
  R.f1 = { shown: !layer().hidden, hint: hint(), barTop: Math.round($(".v2-review-bar").getBoundingClientRect().top) };
  //  F2 대화 칸을 연다(막대가 위면 막대 아래로 — 앱 위쪽을 덮는다)
  const gen = $(".v2-review-gen"); gen.focus(); gen.dispatchEvent(new FocusEvent("focus")); await sleep(700);
  R.f2 = { talkOn: !!$(".v2-review-talk.on"), shown: !layer().hidden };
  $(".v2-review-talk-h button").click(); await sleep(100);
  //  F3 우리 것이 아닌 덮개
  const cover = document.createElement("div"); Object.assign(cover.style, { position: "fixed", left: "0", top: "0", width: "1400px", height: "200px", zIndex: "99", background: "rgba(0,0,0,.2)" });
  document.body.append(cover); await sleep(700);
  R.f3 = { shown: !layer().hidden };
  cover.remove(); $(".v2-review-flip").click(); await sleep(700);

  window.__step = "S";
  const ov = () => $(".v2-review-ov");
  const markTop = (n) => { const b = [...document.querySelectorAll(".v2-review-layer .v2-studio-mk-n")].find((x) => x.textContent === String(n)); return b ? parseFloat(b.style.top) : null; };
  R.s = { topB0: markTop(2) };
  { const r = ov().getBoundingClientRect(); const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 300, clientX: r.left + 300, clientY: r.top + 300 }); ov().dispatchEvent(ev); R.s.prevented = ev.defaultPrevented; }
  await sleep(600);
  R.s.lastScroll = scrolls[scrolls.length - 1]; R.s.outer = window.scrollY; R.s.topB1 = markTop(2);
  //  S3 내린 화면에서 핀 하나
  [...document.querySelectorAll(".v2-review-tools button")].find((b) => /핀/.test(b.textContent)).click(); await sleep(50);
  { const r = ov().getBoundingClientRect(); ov().dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.8 })); }
  await sleep(1000);
  const pinD = host.pins[3];
  R.s.pinD = pinD ? { sy: pinD.sy, kind: pinD.kind } : null;
  { const ta = $(".v2-studio-pop textarea"); if (ta) { ta.value = "아래 쪽"; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); } }
  await sleep(100);
  R.s.brief = Rv.Flow.fixBrief(2, host.pins, "", "full", "mn");
  //  S2 아주 많이 내리면 처음 핀(가운데)은 화면 밖 — 그리지 않는다
  { const r = ov().getBoundingClientRect(); ov().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 1500, clientX: r.left + 300, clientY: r.top + 300 })); }
  await sleep(600);
  R.s.topB2 = markTop(2);
  //  S4 새 문서(새 판) — 스크롤은 다시 맨 위
  Rv.Ui.reloadAppFrames("mn"); await sleep(1200);
  R.s.topB3 = markTop(2); R.s.lastScroll2 = scrolls[scrolls.length - 1];

  window.__step = "T1";
  [...document.querySelectorAll(".v2-review-tools button")].find((b) => /써 보기/.test(b.textContent)).click(); await sleep(100);
  { const n = [...document.querySelectorAll(".v2-review-layer .v2-studio-mk-n")].find((x) => !x.classList.contains("sent")); const cs = n && getComputedStyle(n);
    R.t1 = { has: !!n, op: cs ? Number(cs.opacity) : 1, pe: cs ? cs.pointerEvents : "" }; }
  [...document.querySelectorAll(".v2-review-tools button")].find((b) => /선택/.test(b.textContent)).click(); await sleep(100);

  window.__step = "Q";
  //  Q1 가운데(2번) 칸을 열어 쓰는 중에 앞 코멘트(보낸 것)가 빠진다
  { const n = [...document.querySelectorAll(".v2-review-layer .v2-studio-mk-n")].find((x) => x.textContent === "2"); if (n) n.click(); await sleep(150); }
  { const ta = $(".v2-studio-pop textarea"); R.q = { opened: !!ta }; if (ta) { ta.focus(); ta.value = "가운데 고침"; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.setSelectionRange(2, 2); }
    host.pins.splice(0, 1); api.update({ pins: host.pins, version: 3 }); await sleep(150);
    const pop = $(".v2-studio-pop"), now = document.activeElement;
    R.q.q1 = { pop: !!pop, n: pop && (pop.querySelector(".k .n") || {}).textContent, focus: !!pop && pop.contains(now), caret: now && now.selectionStart, note: pinB.note }; }
  //  Q3 기다림이 시작돼도
  api.update({ waiting: true }); await sleep(100);
  R.q.q3 = { pop: !!$(".v2-studio-pop") };
  api.update({ waiting: false }); await sleep(100);
  //  Q4 「취소」 — 그 코멘트(가운데)만
  { const c = [...document.querySelectorAll(".v2-studio-pop button")].find((b) => b.textContent === "취소"); if (c) c.click(); await sleep(100);
    R.q.q4 = { notes: host.pins.map((p) => p.note) }; }
  //  Q2 그 코멘트가 없어졌다
  { const n = [...document.querySelectorAll(".v2-review-layer .v2-studio-mk-n")].find((x) => x.textContent === "1"); if (n) n.click(); await sleep(150);
    const had = !!$(".v2-studio-pop"); host.pins.splice(0, 1); api.update({ pins: host.pins }); await sleep(100); R.q.q2 = { had, pop: !!$(".v2-studio-pop") }; }

  window.__step = "K1";
  api.close(); await sleep(100);
  R.p2 = { probe: (Rv.Ui.reloadAppFrames("mn"), fr.root.dataset.probe || "") };
  host.pins = []; host.waiting = true; host.waitSince = Date.now() - 83000;
  location.hash = host.route;
  api = Rv.openReview(host); await sleep(1500);
  R.k1 = { send: ($(".v2-review-bar > .v2-studio-now-pri") || {}).textContent };

  window.__step = "A1";
  api.update({ stall: { text: "AI가 확인을 기다리고 있어요. 「AI 세션 보기」를 눌러 답해주세요.", resume: false, ask: true } }); await sleep(100);
  { const b = $(".v2-review-bar > .v2-studio-now-pri"); R.a1 = { hint: hint(), text: b && b.textContent, dis: b && b.disabled }; if (b) b.click(); await sleep(300); R.a1.talk = !!$(".v2-review-talk.on"); }
  api.close(); await sleep(100);

  window.__step = "M1";
  const rh = Rv.Flow.readHitRes;
  R.m1 = rh ? { bad: rh({ __studio: "hitres", id: 3, tag: "<img onerror>", text: "가".repeat(200), rect: { l: "x", t: null, w: 0.5, h: Infinity }, sy: "12" }), notHit: rh({ __studio: "scroll", id: 1 }), noId: rh({ __studio: "hitres" }) } : null;

  window.__step = "B";
  //  B1 · B2 그림이 있는 보드 — 셋 중 둘째 칸을 연 채 앞의 것이 빠진다
  const wa = { kind: "pin", x: 0.1, y: 0.1, where: "", note: "보낸 것", on: "wire", sent: true }, wb = { kind: "pin", x: 0.3, y: 0.3, where: "", note: "둘째", on: "wire" }, wc = { kind: "pin", x: 0.6, y: 0.6, where: "", note: "셋째", on: "wire" };
  const wpins = [wa, wb, wc];
  const WF = '<div style="width:1200px;height:800px"><button style="margin:40px">다음</button></div>';
  let board = Rv.Wb.openWireBoard({ appId: "mn", title: "회의록", version: "V2", place: "full", html: WF, pins: () => wpins, onPins: () => {}, focus: 1 });
  await sleep(2200);
  R.b = { opened: !!$(".v2-wb-pop") };
  wpins.splice(0, 1); if (board.refresh) board.refresh(); await sleep(100);
  R.b.head = (($(".v2-wb-pop .h b")) || {}).textContent;
  { const c = [...document.querySelectorAll(".v2-wb-pop button")].find((b) => b.textContent === "취소"); if (c) c.click(); await sleep(100); }
  R.b.b1 = wpins.map((p) => p.note);
  //  B2 칸의 코멘트가 밖에서 없어졌다
  { const n = document.querySelector(".v2-wb-mk-n"); const r = n && n.getBoundingClientRect(); const cat = $(".v2-wb-catch");
    if (r) { cat.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); await sleep(150); }
    const had = !!$(".v2-wb-pop");
    //  B5 조합 중 Esc 는 닫지 않는다 · 끝난 Esc 는 닫는다
    const ta = $(".v2-wb-pop textarea"); if (ta) ta.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })); await sleep(50);
    R.b.b5 = { had, kept: !!$(".v2-wb-pop") };
    wpins.splice(0, wpins.length); if (board.refresh) board.refresh(); await sleep(100);
    R.b.b2 = { had, pop: !!$(".v2-wb-pop"), marks: document.querySelectorAll(".v2-wb-mk-n").length };
    board.close(); }
  //  B5 끝난 Esc — 칸을 닫는다(새 보드에서)
  { const wp2 = [{ kind: "pin", x: 0.3, y: 0.3, where: "", note: "", on: "wire" }];
    board = Rv.Wb.openWireBoard({ appId: "mn", title: "회의록", version: "V2", place: "full", html: WF, pins: () => wp2, onPins: () => {}, focus: 0 }); await sleep(2200);
    const had = !!$(".v2-wb-pop"); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(50);
    R.b.b5b = { had, closed: !$(".v2-wb-pop") }; board.close(); }
  //  B3 · B4 그림 없는 보드 — 앱 화면 둘(세션 위젯 · 앱 화면)을 대신 놓는다
  { const fp = []; board = Rv.Wb.openWireBoard({ appId: "mn", title: "회의록", version: "V2", place: "both", html: "", pins: () => fp, onPins: () => {} }); await sleep(1500);
    [...document.querySelectorAll(".v2-wb-tools button")].find((b) => /핀/.test(b.textContent)).click(); await sleep(50);
    const cat = $(".v2-wb-catch"), cards = [...document.querySelectorAll(".v2-wb-card")];
    const clickAt = async (x, y) => { cat.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y })); cat.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: x, clientY: y })); await sleep(200); };
    const full = cards[1] && cards[1].getBoundingClientRect(), side = cards[0] && cards[0].getBoundingClientRect();
    R.b.cards = cards.length;
    if (full) await clickAt(full.left + full.width * 0.5, full.top + full.height * 0.5);
    const p3 = fp[0] ? { x: Math.round(fp[0].x * 100), y: Math.round(fp[0].y * 100), screen: fp[0].screen || "" } : null;
    { const ta = $(".v2-wb-pop textarea"); if (ta) { ta.value = "여기 고침"; ta.dispatchEvent(new Event("input", { bubbles: true })); } }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(80);
    const n3 = fp.length;
    if (side && full) await clickAt((side.right + full.left) / 2, full.top + full.height * 0.5);   // 두 카드 사이 빈 보드
    R.b.b3 = { p: p3, brief: fp[0] ? Rv.Flow.fixBrief(2, fp.map((p) => Object.assign({}, p, { note: p.note || "여기 고침" })), "", "both", "mn") : "" };
    R.b.b4 = { before: n3, after: fp.length };
    board.close(); }
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}</style></head><body>
<div id="side" class="v2-studio-side"><div id="chat" class="v2-studio-chat"><div class="term">터미널</div></div></div>
<div id="toasts"></div><div id="out"></div>
${FETCH}
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "review-audit-g3-", virtualTimeBudget: 90000, args: ["--window-size=1400,900", "--disable-site-isolation-trials", "--disable-features=IsolateOrigins,site-per-process"] });   // 격리를 끈다 — 켜 두면 출처 없는 앱 프레임이 다른 프로세스라 가상 시간 안에서 탐침이 답하지 않는다
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const check = (cond, n, why = "") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${typeof why === "string" ? why : JSON.stringify(why)}`); } };
const near = (a, b, d) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= d;

check(R.p1.before === "" && R.p1.scrollsBefore === 0, "P1 배선 — 검토 전에 띄운 앱 화면엔 탐침이 없다(표시 없음 · 스크롤 알림 0)", R.p1);
check(R.p1.after === "1" && R.p1.scrollsAfter > 0, "P1 막대를 열면 그 프레임을 탐침과 함께 다시 띄운다(표시 · 탐침이 실제로 돈다)", R.p1);
check(R.p1.again === 0, "P1 이미 탐침이 든 프레임은 다시 띄우지 않는다", R.p1);
check(R.p2.probe === "", "P2 막대를 닫은 뒤 다시 띄우면 탐침 표시가 빠진다", R.p2);
check(R.f0.shown, "F 배선 — 막대가 아래면 앱 위 층이 선다", R.f0);
check(R.f1.shown && !/안 보여요/.test(R.f1.hint) && R.f1.barTop < 100, "F1 막대를 위로 옮겨 앱 위쪽을 덮어도 앱이 보인다(층 · 안내 그대로)", R.f1);
check(R.f2.talkOn && R.f2.shown, "F2 대화 칸이 앱 위쪽을 덮어도 앱이 보인다", R.f2);
check(!R.f3.shown, "F3 우리 것이 아닌 덮개가 덮으면 안 보이는 것으로 친다", R.f3);
check(R.s.prevented && R.s.lastScroll === 300 && R.s.outer === 0, "S1 도구를 쓴 채 휠 → 앱 문서가 300 내려가고 바깥 문서는 그대로", R.s);
check(near(R.s.topB0 - R.s.topB1, 50, 1.5), "S2 번호가 스크롤을 따라 위로 간다(300px ÷ 600px = 50%)", R.s);
check(R.s.topB2 === null, "S2 화면 밖으로 나간 번호는 그리지 않는다", R.s);
check(R.s.pinD && R.s.pinD.sy === 300, "S3 짚을 때의 스크롤이 핀에 남는다", R.s.pinD);
check(/\[핀 4\][^\n]*아래로 300px 내린 화면/.test(R.s.brief) && !/\[핀 2\][^\n]*내린 화면/.test(R.s.brief), "S3 AI 글이 그 핀에만 «아래로 300px 내린 화면» 을 말한다", R.s.brief);
check(R.s.lastScroll2 === 0 && near(R.s.topB3, R.s.topB0, 0.5), "S4 새 문서면 스크롤은 0 — 번호가 제자리로", R.s);
check(R.t1.has && R.t1.op < 0.6 && R.t1.pe === "none", "T1 써 보기면 번호가 흐리고 눌리지 않는다", R.t1);
check(R.q.opened && R.q.q1.pop && R.q.q1.n === "1" && R.q.q1.focus && R.q.q1.caret === 2 && R.q.q1.note === "가운데 고침", "Q1 앞 코멘트가 빠진 새 목록에도 쓰던 칸 그대로 · 새 번호 · 초점 · 커서", R.q);
check(R.q.q3.pop, "Q3 기다림이 시작돼도 칸을 닫지 않는다", R.q);
check(JSON.stringify(R.q.q4.notes) === JSON.stringify(["오른쪽 위", "아래 쪽"]), "Q4 「취소」 는 그 코멘트만 지운다", R.q.q4);
check(R.q.q2.had && !R.q.q2.pop, "Q2 칸의 코멘트가 목록에서 없어지면 칸을 닫는다", R.q.q2);
check(/AI 수정 중 1:2\d/.test(R.k1.send || ""), "K1 고치는 중에 열면 보낸 때부터 센다(1:2x)", R.k1);
check(/「AI에게 말하기」를 눌러 답해/.test(R.a1.hint) && !/AI 세션 보기/.test(R.a1.hint) && R.a1.dis === false && R.a1.talk, "A1 AI 가 확인을 기다리면 「AI에게 말하기」로 답하라 · 단추가 대화 칸을 연다", R.a1);
check(R.m1 && R.m1.bad && R.m1.bad.tag === "div" && R.m1.bad.text.length === 80 && R.m1.bad.rect.l === 0 && R.m1.bad.rect.t === 0 && R.m1.bad.rect.w === 0.5 && R.m1.bad.rect.h === 0 && R.m1.bad.sy === 12 && R.m1.notHit === null && R.m1.noId === null,
  "M1 위치 답 거르기 — 태그 div · 글 80자 · 수 아닌 좌표 0 · hitres 아니면 null", R.m1);
check(R.b.opened && R.b.head && /^1 /.test(R.b.head), "B1 앞 코멘트가 빠지면 보드 칸의 번호가 새 목록을 따른다", R.b);
check(JSON.stringify(R.b.b1) === JSON.stringify(["셋째"]), "B1 보드 칸의 「취소」 는 그 코멘트만 지운다", R.b.b1);
check(R.b.b2.had && !R.b.b2.pop && R.b.b2.marks === 0, "B2 칸의 코멘트가 밖에서 없어지면 칸을 닫고 번호를 새로 그린다", R.b.b2);
check(R.b.b5.had && R.b.b5.kept, "B5 한글 조합 중 Esc 는 보드 칸을 닫지 않는다", R.b.b5);
check(R.b.b5b.had && R.b.b5b.closed, "B5 끝난 Esc 는 닫는다", R.b.b5b);
check(R.b.cards === 2 && R.b.b3.p && R.b.b3.p.screen === "full" && near(R.b.b3.p.x, 50, 2) && near(R.b.b3.p.y, 50, 2), "B3 그림 없는 보드의 핀은 그 화면 카드 기준(가운데 = 50%) · screen 표시", R.b);
check(/와이어프레임 보드에 놓은 앱 화면\(앱 화면 꼴\)/.test(R.b.b3.brief) && !/wireframe/i.test(R.b.b3.brief.split("\n").slice(1).join("\n")), "B3 AI 글은 «보드에 놓은 앱 화면» 으로 말한다(와이어프레임 파일이라 하지 않는다)", R.b.b3.brief);
check(R.b.b4.before === 1 && R.b.b4.after === 1, "B4 카드 밖(빈 보드)을 누르면 코멘트를 만들지 않는다", R.b.b4);
check(!R.errors.length, "W 페이지 예외 없음", R.errors);

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
