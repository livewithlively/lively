#!/usr/bin/env node
// 「세션 이력」 앱 사이드바(#4553 안 A) — **셸 쪽**: 사이드바가 실제 화면에서 「세션 목록」과 한 틀로 서고, 고른 것이 액자에 가나 — 런타임 회귀 테스트.
//
// 원준 2026-10-05 «A안으로 고고». 종전엔 세션 이력 앱에 제 사이드바가 없어 직전 구역(홈 등)의 목록이 그대로 남았다.
//  규칙(어느 묶음 · 범위 안인가)은 hist-scope.test.mjs, 액자 안 앱(범위가 세 탭에 걸리나)은 session-history-scope-runtime.test.mjs 가 잰다.
//  여기서는 셸 문서에서만 보이는 것을 잰다 — «세션 이력 앱이 활성일 때 사이드바가 무엇을 그리나 · 누르면 액자에 무엇이 가나 ·
//  누가 보낸 줄을 믿나».
//
// 엣지 표(스크래치패드 spec-side.md H):
//  H1  세션 이력 앱이 활성 — 사이드바는 세션 이력의 것(직전 구역의 목록이 아니다) · 줄을 받기 전에는 수를 말하지 않는다(받는 중) · 발치에 「세션 목록」 문
//  H2  액자의 인사(줄 없는 신호) — 지금 고른 것만 그 액자에 돌려준다
//  H3  줄이 온다 — 머리의 수 · 「전체 N」 · 이름표 · 묶음 카드(이름 · 수 · 프로젝트 줄 · N개 더) · 「세션 목록」 사이드바와 같은 부품(클래스)
//  H4  합 — 카드의 합 = 전체 · 카드 안 줄의 합 = 카드
//  H5  카드 머리 → 그 묶음이 액자에 간다 · 켜진 것은 하나 · 셸에 알린다(폰 서랍 닫기)
//  H6  줄 → 그 묶음 × 그 프로젝트 · 고른 줄을 다시 누르면 풀린다 · 「전체」 = 풀기
//  H7  묶기 고르개 — 시간별 · 남긴 것별 · 상태별 · 묶지 않음 · 기준을 바꾸면 고른 것이 풀린다 · 서랍은 닫지 않는다(새 카드를 봐야 한다)
//  H8  남긴 것별 — 일지가 오기 전에는 세지 않는다(«세는 중») · 오면 카드가 선다
//  H9  묶지 않음 — 머리 없는 카드에 프로젝트 줄 · 줄 = 그 프로젝트
//  H10 누가 보낸 줄인가 — 세션 이력 액자가 아닌 창 · 다른 오리진 · 모양이 틀린 줄은 받지 않는다
//  H11 고른 카드가 새 줄에 없다 — 풀리고(전체) 액자에 그렇게 알린다
//  H12 찾기 단추 → 액자에 찾기 신호
//  H13 카드가 많다(달이 쌓인다) — 들어가는 만큼만 세우고 «기간 N개 더» · 누르면 전부
//  H14 다른 화면이 활성 — 세션 이력 사이드바가 아니다(종전 구역 그대로)
//  H15 한 축만 받은 판(partial) — 고른 카드가 그 줄에 없어도 풀지 않는다(수가 덜 찬 것이지 사라진 것이 아니다)
//  H16 액자가 줄을 못 받았다고 알려 온다 — 받아 둔 줄이 없으면 «받는 중» 대신 그렇다고 말한다 · 줄이 오면 걷힌다
//  H17 «사람이 눌렀다» 는 지금 보이는 액자에만 — 감춰 둔 셸 탭의 액자에는 범위만 간다
//  W   페이지 예외 없음 · 배선(액자로 가는 신호가 실제로 잡혔다)
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(사이드바가 없던 origin/main 에서 H1~H13 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 세션 이력 사이드바 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const pack = (entry, name) => execFileSync(ESBUILD, [path.join(WEB, entry), "--bundle", "--format=iife", "--global-name=" + name, "--platform=browser",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

async function PAGE_MAIN() {
  const R = {};
  const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = document.getElementById("host");
  const side = document.querySelector(".v2-side");
  const $ = (s, r = host) => r.querySelector(s);
  const $$ = (s, r = host) => [...r.querySelectorAll(s)];
  const txt = (n) => (n ? n.textContent.trim() : null);
  //  액자 셋 — 세션 이력 앱의 액자 · 다른 앱의 액자 · 액자가 아닌 창. 받은 신호를 적는다(file:// 는 오리진이 'null' 이라 진짜로는 못 보낸다).
  const told = { fr: [], other: [], fr2: [] };
  for (const k of ["fr", "other", "fr2"]) document.getElementById(k).contentWindow.postMessage = (m) => { told[k].push(JSON.parse(JSON.stringify(m))); };
  const FR = document.getElementById("fr").contentWindow, OTHER = document.getElementById("other").contentWindow;
  const say = (data, o = {}) => window.dispatchEvent(new MessageEvent("message", { data, origin: o.origin === undefined ? location.origin : o.origin, source: o.source === undefined ? FR : o.source }));
  const lastScope = () => { const m = told.fr.filter((x) => x.type === "lively:hist-scope"); return m.length ? m[m.length - 1].scope : null; };
  const nScope = () => told.fr.filter((x) => x.type === "lively:hist-scope").length;
  const lastPick = () => { const m = told.fr.filter((x) => x.type === "lively:hist-scope"); return m.length ? m[m.length - 1].pick === true : null; };

  const D = 86_400_000, NOW = Date.now();
  const T0 = new Date(NOW); T0.setHours(0, 0, 0, 0);
  //  «오늘» 의 세 시각 — 오늘 0시와 지금 사이를 나눈 자리(고정된 분을 빼면 자정 직후에 어제로 넘어간다).
  const TODAY = Math.round((T0.getTime() + NOW) / 2), EARLIER = Math.round((T0.getTime() + TODAY) / 2), EARLIEST = Math.round((T0.getTime() + EARLIER) / 2);
  const dayAt = (n) => { const d = new Date(T0); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.getTime(); };
  const monthsAgo = (n) => { const d = new Date(T0); d.setDate(1); d.setMonth(d.getMonth() - n); d.setHours(12, 0, 0, 0); return d.getTime(); };
  let seq = 0;
  const row = (last, pid, pname, state = "rec", kind = null) => ({ key: "k" + (++seq), conv: "c" + seq, last, pid, pname, state, kind });
  //  오늘 3(통합검색 2 · UI 수정 1) · 어제 4(기타 2 · 통합검색 1 · UI 수정 1) · 두 달 전 2(통합검색 2)
  const ROWS = [
    row(TODAY, 7, "통합검색", "live", "k"), row(EARLIER, 7, "통합검색", "off", "a"), row(EARLIEST, 9, "UI 수정", "off", "n"),
    row(dayAt(1), 0, "", "rec", "n"), row(dayAt(1) - 1000, 0, "", "rec", "n"), row(dayAt(1) - 2000, 7, "통합검색", "rec", "k"), row(dayAt(1) - 3000, 9, "UI 수정", "rec", "a"),
    row(monthsAgo(2), 7, "통합검색", "rec", "n"), row(monthsAgo(2) - 1000, 7, "통합검색", "rec", "n"),
  ];
  const data = { projects: [], sessions: [], lists: [], folders: [], loadedAt: 1700000000000 };
  let active = "app:sessions";
  const picks = [];
  const hooks = { section: () => "home", instances: () => [], navHost: () => null, railHidden: () => false, onHistPick: (o) => picks.push(o ? !!o.keepDrawer : null) };
  const draw = async () => { Side.drawSide(host, data, () => active, hooks); await sleep(30); };
  const cards = () => $$(".v2-ksp").map((c) => ({ name: txt($(".v2-ksp-t .n", c)), n: txt($(".v2-ksp-h .v2-cnt", c)), on: !!$(".v2-ksp-h.on", c), lines: $$(".v2-kcat", c).map((l) => txt($(".n", l)) + " " + txt($(".v2-cnt", l)) + (l.classList.contains("on") ? " ●" : "")), more: txt($(".v2-pg-past:not(.v2-scards-more)", c)) }));
  const cardOf = (name) => $$(".v2-ksp").find((c) => txt($(".v2-ksp-t .n", c)) === name);
  const lineOf = (card, name) => $$(".v2-kcat", card).find((l) => txt($(".n", l)) === name);
  const head = () => ({ k: txt($(".v2-app-space-head .v2-k")), count: txt($(".v2-app-space-head .v2-app-count")), by: txt($(".v2-sgb .n")), find: !!$(".v2-findbtn") });
  const all = () => { const a = $(".v2-kviews .v2-kview"); return a ? { text: txt($(".n", a)), n: txt($(".v2-cnt", a)), on: a.classList.contains("on") } : null; };
  const onN = () => $$(".on").length;
  const menu = () => [...document.querySelectorAll(".pn-ctx .pn-ctx-i")];
  const pickBy = async (label) => { $(".v2-sgb").click(); await sleep(30); const it = menu().find((b) => txt(b.querySelector(".pn-ctx-l")) === label); if (it) it.click(); await sleep(40); return !!it; };

  try {
    // ── H1 ──
    await draw();
    R.h1 = { sec: side.getAttribute("data-sec"), head: head(), all: all(), boot: !!$(".v2-side-boot"), cards: cards().length, empty: txt($(".v2-empty")),
      door: $$(".v2-side-foot .v2-foot-link").map((a) => [txt(a), a.getAttribute("href")]), dock: $$(".v2-side-foot .v2-dock-btn").length, space: ($(".v2-app-space") || { getAttribute: () => null }).getAttribute("aria-label") };

    // ── H2 ──
    say({ type: "lively:hist-rows" });
    await sleep(30);
    R.h2 = { told: told.fr.slice(), count: head().count, boot: !!$(".v2-side-boot") };

    // ── H10 — 줄을 받기 전에: 믿지 않을 것들 ──
    say({ type: "lively:hist-rows", rows: ROWS, kinds: true }, { source: OTHER });          // 다른 앱의 액자
    say({ type: "lively:hist-rows", rows: ROWS, kinds: true }, { source: window });         // 액자가 아닌 창
    say({ type: "lively:hist-rows", rows: ROWS, kinds: true }, { origin: "https://evil.example" });
    say({ type: "lively:hist-rows", rows: "nope" });                                       // 모양이 틀렸다
    say({ type: "other", rows: ROWS });
    await sleep(40);
    R.h10 = { boot: !!$(".v2-side-boot"), cards: cards().length, count: head().count, otherTold: told.other.length };

    // ── H16 — 액자가 줄을 못 받았다고 알려 온다(받아 둔 줄이 없다) ──
    say({ type: "lively:hist-rows", failed: true });
    await sleep(40);
    R.h16 = { boot: !!$(".v2-side-boot"), empty: txt($(".v2-empty")), count: head().count };

    // ── H3 · H4 ──
    const before = nScope();
    say({ type: "lively:hist-rows", rows: ROWS, kinds: false });
    await sleep(60);
    R.h16b = { empty: txt($(".v2-empty")) };
    R.h3 = { head: head(), all: all(), label: txt($(".v2-kgroup")), cards: cards(), replied: nScope() - before, scope: lastScope(), replyPick: lastPick(),
      parts: { shelf: !!$(".v2-app-list.v2-kshelf.v2-sshelf"), card: $$(".v2-ksp.v2-pcard.v2-scard.open").length, line: $$(".v2-wcat.v2-ptl.v2-kcat.v2-sproj").length, none: $$(".v2-kcat.v2-ptl--none").length, view: !!$(".v2-wcat.v2-ptl.v2-kview.v2-sproj"), sgb: !!$(".v2-sgb[aria-haspopup=menu]") } };
    for (const m of $$(".v2-ksp .v2-pg-past:not(.v2-scards-more)")) m.click();
    await sleep(40);
    const sums = cards().map((c) => [Number(c.n), c.lines.reduce((n, l) => n + Number(l.replace(/ ●$/, "").split(" ").pop()), 0)]);
    R.h4 = { total: Number(all().n), cardSum: sums.reduce((n, s) => n + s[0], 0), lineSums: sums };

    // ── H5 ──
    const p0 = picks.length;
    $(".v2-ksp-t", cardOf("어제")).click();
    await sleep(40);
    R.h5 = { scope: lastScope(), on: onN(), headOn: cards().find((c) => c.name === "어제").on, allOn: all().on, picked: picks.slice(p0), pick: lastPick() };
    { const m = told.fr2.filter((x) => x.type === "lively:hist-scope"); const lastHidden = m[m.length - 1] || {}; R.h17 = { scope: lastHidden.scope || null, pick: lastHidden.pick === true }; }

    // ── H6 ──
    lineOf(cardOf("어제"), "통합검색").click();
    await sleep(40);
    R.h6a = { scope: lastScope(), on: onN(), line: cards().find((c) => c.name === "어제").lines.filter((l) => / ●$/.test(l)), headOn: cards().find((c) => c.name === "어제").on };
    //  줄을 고른 채 그 카드의 머리 → 카드 전체(줄이 풀린다) · 머리를 한 번 더 → 전체
    $(".v2-ksp-t", cardOf("어제")).click(); await sleep(40);
    R.h6head = { scope: lastScope(), headOn: cards().find((c) => c.name === "어제").on, on: onN() };
    $(".v2-ksp-t", cardOf("어제")).click(); await sleep(40);
    R.h6head2 = { scope: lastScope(), allOn: all().on };
    lineOf(cardOf("어제"), "기타 (미분류)").click();
    await sleep(40);
    R.h6none = { scope: lastScope() };
    lineOf(cardOf("어제"), "기타 (미분류)").click();   // 고른 줄을 다시
    await sleep(40);
    R.h6b = { scope: lastScope(), allOn: all().on, on: onN() };
    $(".v2-ksp-t", cardOf("오늘")).click(); await sleep(30);
    $(".v2-kviews .v2-kview").click(); await sleep(40);
    R.h6c = { scope: lastScope(), allOn: all().on, on: onN() };

    // ── H7 ──
    $(".v2-sgb").click(); await sleep(30);
    R.h7menu = menu().map((b) => txt(b.querySelector(".pn-ctx-l")) + "|" + (txt(b.querySelector(".pn-ctx-hint")) || "") + "|" + b.classList.contains("checked"));
    document.body.click(); await sleep(30);
    $(".v2-ksp-t", cardOf("어제")).click(); await sleep(30);
    const p1 = picks.length;
    const went = await pickBy("상태별");
    R.h7 = { went, scope: lastScope(), by: head().by, label: txt($(".v2-kgroup")), cards: cards().map((c) => c.name + " " + c.n), allOn: all().on, picked: picks.slice(p1) };

    // ── H8 — 남긴 것별: 줄에 «남긴 것» 이 아직 없다 ──
    await pickBy("남긴 것별");
    R.h8a = { scope: lastScope(), cards: cards().length, empty: txt($(".v2-empty")), label: txt($(".v2-kgroup")) };
    //  액자가 일지를 못 받았다고 알려 온다 → 그렇다고 말한다. 사람이 그 기준을 다시 고르면 다시 청하는 신호가 가고 «세는 중» 으로 돌아온다.
    say({ type: "lively:hist-rows", rows: ROWS, kinds: false, kindsFailed: true });
    await sleep(50);
    const n0 = nScope();
    R.h8fail = { empty: txt($(".v2-empty")), cards: cards().length };
    await pickBy("남긴 것별");
    R.h8retry = { empty: txt($(".v2-empty")), sent: nScope() - n0, pick: lastPick(), scope: lastScope() };
    $(".v2-sgb").click(); await sleep(30);
    R.h8menu = menu().map((b) => txt(b.querySelector(".pn-ctx-l")) + "|" + (txt(b.querySelector(".pn-ctx-hint")) || ""));
    document.body.click(); await sleep(30);
    say({ type: "lively:hist-rows", rows: ROWS, kinds: true });
    await sleep(60);
    R.h8b = { cards: cards().map((c) => c.name + " " + c.n), empty: txt($(".v2-empty")) };

    // ── H9 — 묶지 않음 ──
    await pickBy("묶지 않음");
    R.h9 = { label: txt($(".v2-kgroup")), heads: $$(".v2-ksp-h").length, plain: $$('.v2-ksp[data-grp="none"]').length, lines: $$(".v2-ksp .v2-kcat").map((l) => txt($(".n", l)) + " " + txt($(".v2-cnt", l))) };
    $$(".v2-ksp .v2-kcat").find((l) => txt($(".n", l)) === "UI 수정").click();
    await sleep(40);
    R.h9b = { scope: lastScope(), on: onN() };

    // ── H11 — 고른 카드가 새 줄에 없다 ──
    await pickBy("시간별");
    $(".v2-ksp-t", cardOf("어제")).click(); await sleep(40);
    R.h11a = lastScope();
    //  H15 — 한 축만 받은 판: 어제 것이 빠져 있어도 고른 것을 풀지 않는다
    const n15 = nScope();
    say({ type: "lively:hist-rows", rows: ROWS.filter((r) => r.last >= T0.getTime() || r.last < dayAt(2)), kinds: true, partial: true });
    await sleep(60);
    R.h15 = { scope: lastScope(), sent: nScope() - n15, cards: cards().map((c) => c.name) };
    say({ type: "lively:hist-rows", rows: ROWS.filter((r) => r.last >= T0.getTime() || r.last < dayAt(2)), kinds: true });   // 어제 것이 사라졌다
    await sleep(60);
    R.h11 = { scope: lastScope(), allOn: all().on, cards: cards().map((c) => c.name), count: head().count, picks: told.fr.filter((x) => x.type === "lively:hist-scope").slice(-2).map((x) => x.pick === true) };

    // ── H12 — 찾기 단추 ──
    const f0 = told.fr.filter((x) => x.type === "lively:hist-find").length;
    $(".v2-findbtn").click(); await sleep(30);
    R.h12 = { sent: told.fr.filter((x) => x.type === "lively:hist-find").length - f0 };

    // ── H13 — 카드가 많다 ──
    const MANY = Array.from({ length: 14 }, (_, i) => row(monthsAgo(i + 1), 7, "통합검색", "rec", "n"));
    say({ type: "lively:hist-rows", rows: [...ROWS, ...MANY], kinds: true });
    await sleep(80);
    const fold = $(".v2-scards-more");
    R.h13a = { fold: txt(fold), shown: cards().length, list: [$(".v2-sshelf").scrollHeight, $(".v2-sshelf").clientHeight] };
    if (fold) { fold.click(); await sleep(60); }
    R.h13b = { shown: cards().length, fold: txt($(".v2-scards-more")) };

    // ── H14 — 다른 화면이 활성 ──
    active = "home";
    await draw();
    R.h14 = { sec: side.getAttribute("data-sec"), hist: !!$('.v2-app-space[aria-label="세션 이력"]') };
  } catch (e) { R.error = String(e && e.stack || e); }
  R.errors = errors;
  R.toldN = told.fr.length;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "47-v2-rail.css", "49-v2-ctx.css")}
  html,body{margin:0} #v2-root{display:block} .v2-side{width:316px;height:800px}
</style>
<div id="v2-root"><nav class="v2-side stu-side" id="v2-side"><div class="stu-panel"><div class="stu-panel-tree" id="host"></div></div></nav></div>
<iframe id="fr" class="v2-frame" data-app-key="sessions"></iframe><iframe id="other" class="v2-frame" data-app-key="projects2"></iframe>
<iframe id="fr2" class="v2-frame" data-app-key="sessions" style="display:none"></iframe>
<pre id="out">PENDING</pre>
<script>window.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });</script>
<script>${pack("v2/side.ts", "Side")}</script>
<script>(${PAGE_MAIN.toString()})();</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "session-history-side-", virtualTimeBudget: 60000, args: ["--window-size=1400,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
if (R.error) bad("장면 오류", String(R.error).slice(0, 900));
const S0 = { by: "day", group: null, proj: null };

// ── H1 ──
same(R.h1 && [R.h1.sec, R.h1.space, R.h1.head.k], ["sessions", "세션 이력", "세션 이력"], "H1 세션 이력 앱이 활성이면 사이드바는 세션 이력의 것이다(직전 구역 «home» 의 목록이 아니다)");
same(R.h1 && [R.h1.head.count, R.h1.all && R.h1.all.n, R.h1.boot, R.h1.cards, R.h1.empty], [null, null, true, 0, null], "H1 줄을 받기 전에는 수를 말하지 않는다 — 받는 중 표시만(«0» 도 «없어요» 도 아니다)");
same(R.h1 && [R.h1.head.by, R.h1.head.find, R.h1.all && R.h1.all.text], ["시간별", true, "전체"], "H1 머리 = 묶기 고르개(시간별) · 찾기 단추 · 고정 줄 「전체」");
same(R.h1 && [R.h1.door, R.h1.dock], [[["세션 목록", "#/app/terminal"]], 3], "H1 발치에 「세션 목록」 문과 도크 셋");

// ── H2 ──
same(R.h2 && [R.h2.told, R.h2.count, R.h2.boot], [[{ type: "lively:hist-scope", scope: S0 }], null, true], "H2 액자의 인사에는 지금 고른 것만 돌려준다 — 줄은 아직 없다");

// ── H10 ──
same(R.h10 && [R.h10.boot, R.h10.cards, R.h10.count, R.h10.otherTold], [true, 0, null, 0], "H10 다른 앱의 액자 · 액자가 아닌 창 · 남의 오리진 · 모양이 틀린 줄은 받지 않는다(답도 안 한다)");

// ── H3 ──
same(R.h3 && [R.h3.head.count, R.h3.all, R.h3.label], ["9", { text: "전체", n: "9", on: true }, "시간별"], "H3 줄이 오면 머리의 수 · 「전체 9」(켜짐) · 이름표 «시간별»");
check(!!R.h3 && R.h3.cards.length === 3 && R.h3.cards[0].name === "오늘" && R.h3.cards[0].n === "3" && R.h3.cards[1].name === "어제" && R.h3.cards[1].n === "4" && /월$/.test(R.h3.cards[2].name) && R.h3.cards[2].n === "2",
  "H3 카드 — 오늘 3 → 어제 4 → 그 달 2(최근부터)", JSON.stringify(R.h3 && R.h3.cards.map((c) => c.name + " " + c.n)));
same(R.h3 && R.h3.cards[0].lines.slice(0, 2), ["통합검색 2", "UI 수정 1"], "H3 카드 안 줄 = 프로젝트, 많은 순");
same(R.h3 && R.h3.cards[1].lines[0], "기타 (미분류) 2", "H3 프로젝트에 안 붙은 것도 제 수대로 선다 — 이름은 다른 화면과 같은 「기타 (미분류)」(어제는 그것이 가장 많다)");
same(R.h3 && [R.h3.replied, R.h3.scope, R.h3.replyPick], [1, S0, false], "H3 줄을 받으면 그 액자에 지금 고른 것을 알려 준다 — 맞춰 주는 신호다(사람이 누른 것이 아니다)");
check(!!R.h3 && R.h3.parts.shelf && R.h3.parts.card === 3 && R.h3.parts.line >= 5 && R.h3.parts.none >= 1 && R.h3.parts.view && R.h3.parts.sgb,
  "H3 부품은 「세션 목록」 사이드바의 것 그대로(.v2-sshelf · .v2-ksp.v2-pcard.v2-scard · .v2-kcat.v2-sproj · .v2-ptl--none · .v2-kview · .v2-sgb)", JSON.stringify(R.h3 && R.h3.parts));

// ── H4 ──
same(R.h4 && [R.h4.total, R.h4.cardSum], [9, 9], "H4 카드의 합 = 전체");
check(!!R.h4 && R.h4.lineSums.length === 3 && R.h4.lineSums.every((s) => s[0] === s[1]), "H4 카드 안 줄의 합 = 카드의 수(「N개 더」를 다 편 뒤)", JSON.stringify(R.h4 && R.h4.lineSums));

// ── H5 ──
same(R.h5 && [R.h5.scope, R.h5.on, R.h5.headOn, R.h5.allOn], [{ by: "day", group: "d1", proj: null }, 1, true, false], "H5 카드 머리 → 그 묶음이 액자에 간다 · 켜진 것은 하나(「전체」가 꺼진다)");
same(R.h5 && R.h5.picked, [false], "H5 골랐다고 셸에 알린다(폰 서랍을 닫는다)");
same(R.h5 && R.h5.pick, true, "H5 액자에 가는 신호에 «사람이 눌렀다» 가 실린다(대화록 단독 화면이면 앱으로 돌아오게)");

// ── H6 ──
same(R.h6a && [R.h6a.scope, R.h6a.on, R.h6a.line, R.h6a.headOn], [{ by: "day", group: "d1", proj: 7 }, 1, ["통합검색 1 ●"], false], "H6 줄 → 그 묶음 × 그 프로젝트 · 켜진 것은 그 줄 하나(카드 머리는 꺼진다)");
same(R.h6head && [R.h6head.scope, R.h6head.headOn, R.h6head.on], [{ by: "day", group: "d1", proj: null }, true, 1], "H6 줄을 고른 채 그 카드의 머리를 누르면 카드 전체(줄이 풀린다)");
same(R.h6head2 && [R.h6head2.scope, R.h6head2.allOn], [S0, true], "H6 고른 카드의 머리를 다시 누르면 풀린다(전체)");
same(R.h6none && R.h6none.scope, { by: "day", group: "d1", proj: 0 }, "H6 「기타 (미분류)」 줄 → proj 0(없음이지 «안 골랐다» 가 아니다)");
same(R.h6b && [R.h6b.scope, R.h6b.allOn, R.h6b.on], [S0, true, 1], "H6 고른 줄을 다시 누르면 풀린다(전체)");
same(R.h6c && [R.h6c.scope, R.h6c.allOn, R.h6c.on], [S0, true, 1], "H6 「전체」 = 풀기");

// ── H7 ──
same(R.h7menu, ["시간별|3묶음|true", "남긴 것별||false", "상태별|3묶음|false", "묶지 않음||false"], "H7 묶기 메뉴 — 넷, 지금 것에 표시, 묶음 수(남긴 것별은 일지 전이라 수가 없다)");
same(R.h7 && [R.h7.went, R.h7.scope, R.h7.by, R.h7.label, R.h7.allOn], [true, { by: "state", group: null, proj: null }, "상태별", "상태별", true], "H7 기준을 바꾸면 고른 것이 풀리고 그 기준이 액자에 간다");
same(R.h7 && R.h7.cards, ["실행 중 1", "오프라인 2", "기록만 6"], "H7 상태별 카드 — 실행 중 → 오프라인 → 기록만");
same(R.h7 && R.h7.picked, [true], "H7 기준을 바꿀 때는 폰 서랍을 닫지 않는다(새 카드를 봐야 한다)");

// ── H8 ──
same(R.h8a && [R.h8a.scope, R.h8a.cards, R.h8a.empty, R.h8a.label], [{ by: "kind", group: null, proj: null }, 0, "남긴 것을 세는 중…", "남긴 것별"], "H8 남긴 것별 — 일지가 오기 전에는 세지 않는다(«세는 중»)");
same(R.h8fail && [R.h8fail.empty, R.h8fail.cards], ["남긴 것을 불러오지 못했어요. 묶는 기준을 다시 골라 주세요.", 0], "H8 액자가 일지를 못 받았다고 알려 오면 그렇다고 말한다(«세는 중» 으로 서 있지 않는다)");
same(R.h8retry && [R.h8retry.empty, R.h8retry.sent, R.h8retry.pick, R.h8retry.scope], ["남긴 것을 세는 중…", 1, true, { by: "kind", group: null, proj: null }], "H8 그 기준을 다시 고르면 다시 청하는 신호가 가고 «세는 중» 으로 돌아온다");
same(R.h8menu && R.h8menu[1], "남긴 것별|", "H8 메뉴의 묶음 수도 그동안은 비운다");
same(R.h8b && [R.h8b.cards, R.h8b.empty], [["지식을 남긴 세션 2", "작업 기록만 남긴 세션 2", "남긴 기록이 없는 세션 5"], null], "H8 일지가 오면 카드가 선다 — 지식 → 작업 기록만 → 없음");

// ── H9 ──
same(R.h9 && [R.h9.label, R.h9.heads, R.h9.plain], ["프로젝트", 0, 1], "H9 묶지 않음 — 머리 없는 카드 하나 · 이름표 «프로젝트»");
same(R.h9 && R.h9.lines, ["통합검색 5", "UI 수정 2", "기타 (미분류) 2"], "H9 줄 = 프로젝트, 많은 순 · 같으면 최근 활동 순(UI 수정은 오늘, 기타는 어제)");
same(R.h9b && [R.h9b.scope, R.h9b.on], [{ by: "none", group: null, proj: 9 }, 1], "H9 줄 → 그 프로젝트");

// ── H11 ──
same(R.h11a, { by: "day", group: "d1", proj: null }, "H11 대조: 어제를 골라 두었다");
same(R.h11 && [R.h11.scope, R.h11.allOn, R.h11.count], [S0, true, "5"], "H11 고른 카드가 새 줄에 없으면 풀리고(전체) 액자에 그렇게 알린다");
same(R.h11 && R.h11.picks, [false, false], "H11 그 신호는 사람이 누른 것이 아니다 — 보던 화면을 옮기지 않는다");
check(!!R.h11 && !R.h11.cards.includes("어제"), "H11 사라진 카드는 서지 않는다", JSON.stringify(R.h11 && R.h11.cards));

// ── H15 · H16 · H17 ──
same(R.h15 && [R.h15.scope, R.h15.sent], [{ by: "day", group: "d1", proj: null }, 1], "H15 한 축만 받은 판에서는 고른 것을 풀지 않는다 — 가는 신호는 줄에 대한 답 하나뿐");
check(!!R.h15 && !R.h15.cards.includes("어제"), "H15 대조: 그 판의 줄에는 어제 것이 없다(그래도 범위는 그대로)", JSON.stringify(R.h15 && R.h15.cards));
same(R.h16 && [R.h16.boot, R.h16.empty, R.h16.count], [false, "세션 이력을 불러오지 못했어요. 본문의 「세션 목록」 탭에서 새로 고침을 눌러 주세요.", null], "H16 액자가 줄을 못 받았다고 알려 오면 «받는 중» 대신 그렇다고 말한다");
same(R.h16b && R.h16b.empty, null, "H16 줄이 오면 그 말이 걷힌다");
same(R.h17, { scope: { by: "day", group: "d1", proj: null }, pick: false }, "H17 감춰 둔 액자에는 범위만 간다 — «사람이 눌렀다» 는 보이는 액자에만(감춰 둔 대화록 화면이 앱으로 튕기지 않는다)");

// ── H12 ──
same(R.h12 && R.h12.sent, 1, "H12 찾기 단추 → 액자에 찾기 신호");

// ── H13 ──
check(!!R.h13a && /^›?\s*기간 \d+개 더$/.test(R.h13a.fold || "") && R.h13a.shown < 17 && R.h13a.list[0] <= R.h13a.list[1] + 1, "H13 카드가 많으면 들어가는 만큼만 세우고 «기간 N개 더» — 첫 화면은 스크롤 없이", JSON.stringify(R.h13a));
check(!!R.h13b && R.h13b.shown >= 16 && /접기/.test(R.h13b.fold || ""), "H13 누르면 전부 선다(접기로 바뀐다)", JSON.stringify(R.h13b));

// ── H14 ──
same(R.h14, { sec: "home", hist: false }, "H14 다른 화면이 활성이면 세션 이력 사이드바가 아니다(구역 그대로)");

// ── W ──
same(R.errors, [], "W 페이지 예외 없음");
check(R.toldN >= 8, "W 배선 — 액자로 가는 신호가 실제로 잡혔다", String(R.toldN));

console.log(`\n#4553 세션 이력 사이드바(셸 · 런타임): ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
