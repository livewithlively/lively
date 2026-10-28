#!/usr/bin/env node
// 앱빌더 ③ 실제 화면 막대 — 「AI에게 말하기」 대화 칸(#4632) · 런타임 회귀 테스트(헤드리스 크롬 · 막대만 띄운다).
//
// 원준 2026-10-28 «앱 전체에 코멘트하는 텍스트박스를 누르면 아래에서 위로 올라오게 · 터미널 세션 같은 데서 AI와 대화하면서
//  원하는 걸 물어보고 지정하고 수정하는 대화형». 막대 칸을 누르면 막대에 맞붙은 대화 칸이 올라오고 그 안에 만드는 AI 세션 화면이 선다.
//
// 엣지 표(스크래치패드 spec-review-talk.md):
//  E1 칸 포커스 → 대화 칸 열림 · 안에 넘긴 세션 화면   E2 열기 전엔 세션 화면을 옮기지 않는다
//  E3 첫 말 Enter → 보낸 글 1건(대화 방식 + 그 글) · 칸 비움   E4 두 번째 말 = 쓴 글 그대로
//  E5 조합 중 Enter · 빈 글 → 안 보냄   E6 보내기 실패 → 글 그대로
//  E7 「접기」 · Esc → 닫힘 · 세션 화면은 칸 안에 그대로   E8 도구 고름 → 닫힘   E9 코멘트 칸 ↔ 대화 칸 서로 닫음
//  W1~W5 고치는 중(「수정하기」 를 보낸 뒤) — 도구 · 앱 위 층 · 새 코멘트 · 「AI에게 말하기」 가 그대로 · 보낸 것은 흐리게 · 세지 않음 · 못 고침   E11 막대 칸에 쓴 글은 앱 전체 코멘트(general) · 코멘트 수를 안 바꾼다
//  E12 막대가 걷히면 세션 화면이 제자리로 돌아간다   E13 막대가 위면 대화 칸이 막대 아래로   W 페이지 예외 없음
//  B talkBrief — 첫 말에만 방식(묻기 · app_pull/app_save · 공개 안 함) · 그 뒤는 글 그대로
//  ⚠ 범위 밖: «실패한 뒤 다음 말이 다시 첫 말» 플래그(app-studio onTalk) · 세션 위젯 꼴의 고정 자리(placeTalk) · 앱빌더 쪽 걷기 경로(backToBuilder · teardown 은 모두 closeReview 를 거친다).
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 E1 · E3~E9 · E12 · E13 · W · B 가 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 대화 칸 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-review.ts'; export * as Flow from './lib/studio-flow.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=Rv", "--platform=browser", "--loader=ts", "--sourcefile=review-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  //  앱빌더의 「AI 세션」 칸 흉내 — 세션 화면(chat)이 그 안에 산다. 옮겨졌다 돌아오는지를 이 부모로 잰다.
  const side = document.getElementById("side"), chat = document.getElementById("chat"), after = document.getElementById("after");
  const sent = []; let fail = false;
  const host = { appId: "mn", title: "회의록", route: location.hash || "#/i/x", pins: [{ kind: "pin", x: 0.2, y: 0.3, where: "제목", note: "더 크게" }], general: "전체 톤 밝게",
    version: 2, waiting: false, chat, changes: 0,
    onTalk: async (t) => { await sleep(30); if (fail) return false; sent.push(t); return true; },
    onChange: () => { host.changes++; }, onSend: () => {}, onLike: () => {}, onBack: () => {}, onClose: () => { R.closedInside = chat.parentNode && chat.parentNode.id; } };
  location.hash = host.route;
  const api = Rv.openReview(host);
  const gen = $(".v2-review-bar .v2-review-gen");
  const talk = () => document.querySelector(".v2-review-talk");
  const isOpen = () => { const t = talk(); return !!t && t.classList.contains("on") && getComputedStyle(t).visibility === "visible"; };
  const key = (k, o = {}) => gen.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
  const type = (s) => { gen.value = s; gen.dispatchEvent(new Event("input", { bubbles: true })); };

  window.__step = "E2";
  R.e2 = { parent: chat.parentNode && chat.parentNode.id, placeholder: gen && gen.placeholder, open: isOpen() };
  window.__step = "E1";
  //  열기 전 닫힌 칸의 자리(움직임의 출발점) — 헤드리스 가상 시간에선 전이가 안 흐르니, 출발점만 재고 전이는 끈 뒤 최종 자리를 잰다.
  { const st = document.createElement("style"); st.textContent = ".v2-review-talk, .v2-review-talk.on { transition: none !important; }"; document.head.append(st); }
  gen.focus(); gen.dispatchEvent(new FocusEvent("focus")); await sleep(300);
  const tb = talk();
  //  닫으면(접기) 출발점으로 돌아간다 — 그 자리가 막대 쪽(아래)으로 밀려 있어야 «아래에서 올라오는» 움직임이다.
  tb.classList.remove("on"); R.fromY = new DOMMatrix(getComputedStyle(tb).transform).m42; tb.classList.add("on");
  R.e1 = { fromY: R.fromY, open: isOpen(), chatIn: !!tb && tb.contains(chat), inBar: !!tb && $(".v2-review-bar").contains(tb), joined: $(".v2-review-bar").classList.contains("v2-review-bar--tray"),
    // 막대 위로 올라온다 — 칸의 아래 끝이 막대의 위 끝에 닿는다
    above: !!tb && Math.abs(tb.getBoundingClientRect().bottom - $(".v2-review-bar").getBoundingClientRect().top) < 2, h: tb ? Math.round(tb.getBoundingClientRect().height) : 0 };
  window.__step = "E11";
  type("버튼 색 어떤 게 좋을까?");
  R.e11 = { general: host.general, changes: host.changes, count: $(".v2-review-count") && $(".v2-review-count").textContent };
  window.__step = "E5";
  key("Enter", { isComposing: true }); await sleep(100);
  const n5a = sent.length;
  window.__step = "E3";
  key("Enter"); await sleep(200);
  R.e3 = { sent: sent.slice(), val: gen.value, open: isOpen() };
  window.__step = "E5b";
  type("   "); key("Enter"); await sleep(150);
  R.e5 = { composing: n5a, blank: sent.length };
  window.__step = "E4";
  type("파란색으로 해 줘"); key("Enter"); await sleep(200);
  R.e4 = { last: sent[sent.length - 1], n: sent.length, val: gen.value };
  window.__step = "E7";
  $(".v2-review-talk-h button").click(); await sleep(300);
  R.e7a = { open: isOpen(), chatIn: talk().contains(chat), connected: chat.isConnected };
  gen.blur(); gen.focus(); gen.dispatchEvent(new FocusEvent("focus")); await sleep(250);
  const reopened = isOpen();
  key("Escape"); await sleep(250);
  R.e7b = { reopened, esc: isOpen() };
  window.__step = "E8";
  gen.focus(); gen.dispatchEvent(new FocusEvent("focus")); await sleep(250);
  const before8 = isOpen();
  [...document.querySelectorAll(".v2-review-tools button")].find((b) => /핀/.test(b.textContent)).click(); await sleep(250);
  R.e8 = { before8, after: isOpen() };
  window.__step = "E9";
  gen.focus(); gen.dispatchEvent(new FocusEvent("focus")); await sleep(250);
  $(".v2-review-count").click(); await sleep(250);
  const trayOpen = !!document.querySelector(".v2-review-tray"), talkAfterTray = isOpen();
  gen.blur(); gen.focus(); gen.dispatchEvent(new FocusEvent("focus")); await sleep(250);
  R.e9 = { trayOpen, talkAfterTray, talkBack: isOpen(), trayGone: !document.querySelector(".v2-review-tray"), joined: $(".v2-review-bar").classList.contains("v2-review-bar--tray") };
  window.__step = "E6";
  //  실패 — 새 막대(첫 말 상태를 부르는 쪽이 쥔다: 여기선 onTalk 가 받은 글로 잰다) · 글은 그대로 남는다
  fail = true; type("실패할 말"); key("Enter"); await sleep(200);
  R.e6 = { val: gen.value, n: sent.length };
  fail = false;
  window.__step = "W";
  //  고치는 중(원준 2026-10-28 «하나 치고 나서는 다 적용될 때까지 다른 코멘트를 남기는 게 비활성화 · 해결해야») — 부르는 쪽이 보낸 코멘트에 sent 를 찍고 앱 전체 칸을 비운다.
  { const pb = [...document.querySelectorAll(".v2-review-tools button")].find((b) => /선택/.test(b.textContent)); pb.click(); await sleep(50); }
  host.pins[0].sent = true; api.update({ waiting: true, general: "" }); await sleep(600);
  const ov = document.querySelector(".v2-review-ov"), sendB = document.querySelector(".v2-review-bar .v2-studio-now-pri");
  const toolBtns = () => [...document.querySelectorAll(".v2-review-tools button")];
  R.w = { genDisabled: gen.disabled, toolsDisabled: toolBtns().some((b) => b.disabled), toolOn: (toolBtns().find((b) => b.classList.contains("on")) || {}).textContent,
    layerHidden: document.querySelector(".v2-review-layer").hidden, sendDis: sendB.disabled, sendText: sendB.textContent, count: $(".v2-review-count").textContent, hint: $(".v2-review-hint").textContent };
  { const sm = document.querySelector(".v2-studio-mk-n.sent"); R.w.sentMark = !!sm && getComputedStyle(sm).opacity < 0.6; if (sm) sm.click(); await sleep(150); R.w.popOnSent = !!document.querySelector(".v2-studio-pop"); }
  toolBtns().find((b) => /핀/.test(b.textContent)).click(); await sleep(50);
  { const r = ov.getBoundingClientRect(); ov.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width * 0.6, clientY: r.top + r.height * 0.6 })); }
  await sleep(1100);   // 탐침 답을 0.7초 기다린다(프레임이 답하지 않는 시험 문서)
  { const ta = document.querySelector(".v2-studio-pop textarea"); R.w.pop = !!ta; if (ta) { ta.value = "버튼 더 크게"; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); } }
  await sleep(100);
  R.w.pins = host.pins.length; R.w.newNote = host.pins[1] && host.pins[1].note; R.w.newSent = !!(host.pins[1] && host.pins[1].sent); R.w.countAfter = $(".v2-review-count").textContent;
  $(".v2-review-count").click(); await sleep(150);
  R.w.tray = [...document.querySelectorAll(".v2-review-tray .v2-studio-tray-row:not(.all)")].map((r) => ({ sent: r.classList.contains("sent"), dis: r.querySelector("input").disabled, x: !!r.querySelector(".x") }));
  $(".v2-review-count").click(); await sleep(100);
  type("고치는 중 말"); key("Enter"); await sleep(250);
  R.w.talkN = sent.length; R.w.talkLast = sent[sent.length - 1];
  api.update({ waiting: false }); await sleep(100);
  window.__step = "E13";
  $(".v2-review-flip").click(); await sleep(50);
  gen.focus(); gen.dispatchEvent(new FocusEvent("focus")); await sleep(300);
  { const t = talk(), b = $(".v2-review-bar"); R.e13 = { open: isOpen(), below: !!t && Math.abs(t.getBoundingClientRect().top - b.getBoundingClientRect().bottom) < 2 }; }
  window.__step = "E12";
  api.close(); await sleep(100);
  R.e12 = { parent: chat.parentNode && chat.parentNode.id, order: chat.nextElementSibling && chat.nextElementSibling.id, talkLeft: !!talk(), closedInside: R.closedInside };
  window.__step = "B";
  R.b = { first: Rv.Flow.talkBrief("  파란색으로  ", "mn", "full", true), next: Rv.Flow.talkBrief("  파란색으로  ", "mn", "full", false) };
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}</style></head><body>
<iframe class="v2-appui-frame" data-app-id="mn" srcdoc="<p>앱</p>" style="position:fixed;left:20px;top:20px;width:900px;height:460px;border:0"></iframe>
<div id="side" class="v2-studio-side"><div id="head">AI 세션</div><div id="chat" class="v2-studio-chat"><div class="term">터미널</div></div><div id="after"></div></div>
<div id="out"></div>
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "review-talk-", virtualTimeBudget: 60000, args: ["--window-size=1400,900"] });
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

check(R.e2.parent === "side" && !R.e2.open, "E2 열기 전엔 세션 화면이 제자리 · 대화 칸 닫힘", R.e2);
check(/AI에게 말하기/.test(R.e2.placeholder || ""), "E2 막대 칸은 「AI에게 말하기」", R.e2);
check(R.e1.open && R.e1.chatIn && R.e1.inBar && R.e1.joined, "E1 칸을 누르면 막대에 맞붙은 대화 칸이 열리고 안에 세션 화면", R.e1);
check(R.e1.fromY > 0, "E1 닫힌 자리는 아래로 밀려 있다(아래에서 올라오는 움직임)", R.e1);
check(R.e1.above && R.e1.h >= 200, "E1 대화 칸은 막대 위로 올라온다(아래 끝 = 막대 위 끝 · 높이 있음)", R.e1);
check(R.e11.general === "전체 톤 밝게" && R.e11.changes === 0, "E11 막대 칸에 써도 앱 전체 코멘트 · 변경 알림 없음", R.e11);
check(/코멘트 2건/.test(R.e11.count || ""), "E11 코멘트 수는 그대로(핀 1 + 앱 전체 1)", R.e11);
check(R.e5.composing === 0, "E5 조합 중 Enter 는 안 보낸다", R.e5);
check(R.e3.sent.length === 1 && R.e3.sent[0] === "버튼 색 어떤 게 좋을까?" && R.e3.val === "" && R.e3.open, "E3 Enter → 쓴 글을 보내고 칸을 비운다 · 대화 칸은 열린 채", R.e3);
check(R.e5.blank === 1, "E5 빈 글은 안 보낸다", R.e5);
check(R.e4.n === 2 && R.e4.last === "파란색으로 해 줘" && R.e4.val === "", "E4 다음 말도 쓴 글 그대로 보낸다", R.e4);
check(!R.e7a.open && R.e7a.chatIn && R.e7a.connected, "E7 「접기」 → 닫힘 · 세션 화면은 칸 안에 그대로(버리지 않음)", R.e7a);
check(R.e7b.reopened && !R.e7b.esc, "E7 다시 누르면 열리고 Esc 로 닫힌다", R.e7b);
check(R.e8.before8 && !R.e8.after, "E8 도구를 고르면 닫힌다", R.e8);
check(R.e9.trayOpen && !R.e9.talkAfterTray, "E9 코멘트 칸을 열면 대화 칸이 닫힌다", R.e9);
check(R.e9.talkBack && R.e9.trayGone && R.e9.joined, "E9 대화 칸을 열면 코멘트 칸이 닫히고 막대와 맞붙은 채", R.e9);
check(R.e6.val === "실패할 말" && R.e6.n === 2, "E6 못 보내면 쓴 글을 그대로 둔다", R.e6);
check(!R.w.toolsDisabled && /선택/.test(R.w.toolOn || "") && !R.w.layerHidden, "W1 고치는 중에도 도구가 눌리고 고른 도구 그대로 · 앱 위 층이 선다", R.w);
check(R.w.sendDis && /AI 수정 중/.test(R.w.sendText) && /다음 코멘트를 남겨/.test(R.w.hint), "W1 「수정하기」 는 고치는 중이라 잠기고 그동안 남기라고 말한다", R.w);
check(/코멘트 0건/.test(R.w.count), "W2 보낸(반영 중) 코멘트는 세지 않는다", R.w);
check(R.w.sentMark && !R.w.popOnSent, "W2 보낸 코멘트 번호는 흐리고 눌러도 칸이 안 열린다", R.w);
check(R.w.pop && R.w.pins === 2 && R.w.newNote === "버튼 더 크게" && !R.w.newSent && /코멘트 1건/.test(R.w.countAfter), "W3 고치는 중에 새 핀 · 코멘트를 남기고 그것만 센다", R.w);
same(R.w.tray, [{ sent: true, dis: true, x: false }, { sent: false, dis: false, x: true }], "W4 코멘트 칸 — 보낸 줄은 잠기고 지울 수 없다 · 새 줄은 그대로");
check(!R.w.genDisabled && R.w.talkN === 3 && R.w.talkLast === "고치는 중 말", "W5 고치는 중에도 「AI에게 말하기」 로 보낸다", R.w);
check(R.e13.open && R.e13.below, "E13 막대가 위면 대화 칸이 막대 아래로", R.e13);
check(R.e12.parent === "side" && R.e12.order === "after" && !R.e12.talkLeft, "E12 막대가 걷히면 세션 화면이 제자리(같은 순서)로 · 대화 칸도 걷힌다", R.e12);
check(R.e12.closedInside === "side", "E12 부르는 쪽 onClose 때 이미 제자리다", R.e12);
check(/먼저 짧게 물어봐/.test(R.b.first) && /app_pull mn/.test(R.b.first) && /app_save/.test(R.b.first) && /app_visibility_set 은 부르지 마/.test(R.b.first) && R.b.first.endsWith("\n파란색으로"), "B 첫 말엔 대화 방식(묻기 · app_pull/app_save · 공개 안 함) + 그 글", R.b);
check(R.b.next === "파란색으로", "B 두 번째 말부터는 글 그대로", R.b);
check(!R.errors.length, "W 페이지 예외 없음", R.errors);

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
