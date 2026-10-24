#!/usr/bin/env node
// 폰 세션 화면에서 연 사이드바 서랍을 닫을 수 있어야 한다 (#4998) — 런타임 회귀 테스트.
//
// 상민님 2026-10-25 «모바일에서 세션보다가 홈화면사이드바열면 세션이 가려지고 사이드바보이는데 이 사이드바를 다시 닫을길이없음».
//  폰 세션 화면은 맨 윗줄(☰ · 검색 · [자료])을 걷고(#4229 후속) 머리줄의 ≡ 로 사이드바 서랍을 연다. 그런데 서랍은 화면 한 장(전폭)이라
//  머리줄의 ≡ 를 덮고, 닫는 단추(☰)는 걷힌 맨 윗줄에 있었다 — 배경막도 서랍 밑이다. 서랍이 열린 동안만 맨 윗줄을 위에 띄운다(50-mobile.css).
//
// 엣지 표:
//  S0 세션 화면 · 서랍 닫힘 — 맨 윗줄은 걷혀 있다(종전 그대로)
//  S1 머리줄 ≡(openSide)로 열면 맨 윗줄이 선다 · 화면 위에 떠 있다(fixed · top 0)
//  S2 그 줄의 ☰ 가 손가락에 닿는다(가운데를 눌렀을 때 맨 위 요소가 ☰ — 서랍·탭 바에 안 덮인다)
//  S3 서랍 꼭대기 = 맨 윗줄 바닥(서랍 첫 줄이 줄 밑에 숨지 않는다)
//  S4 서랍을 여닫아도 세션 판(.sc-wrap)의 크기·자리가 그대로다(터미널 크기가 안 바뀐다)
//  S5 ☰ 를 누르면 서랍이 닫히고 맨 윗줄은 다시 걷힌다
//  S6 탭 바로 연 구역 목록(«AI 세션» 등)도 같은 맨 윗줄이 서고 ☰ 로 닫힌다
//  N1 세션이 아닌 화면 — 맨 윗줄은 흐름 안(fixed 아님)이고 서랍은 그 밑에서 선다(경계 · 종전 그대로)
//  E  페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 S1 · S2 · S3 · S6 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정). 폰 세션 사이드바 닫기 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const pack = (entry, name) => execFileSync(ESBUILD, [path.join(WEB, entry), "--bundle", "--format=iife", "--global-name=" + name, "--platform=browser",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");
const FETCH = `<script>window.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });</script>`;

//  matchMedia 는 문서의 폭을 본다 — 셸을 390×664(폰의 보이는 높이) iframe 안에 세운다. 세션 판은 셸의 그것과 같은 뼈대(.v2-main 안의 .sc-wrap · 머리줄 ≡).
const shell = (session) => `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "43-v2-topbar-search.css", "47-v2-rail.css", "50-mobile.css")}
  html,body{margin:0}
</style>
<div id="v2-root" class="rail-mode has-topbar topbar-web">
 <nav class="v2-side" id="v2-side"><div class="v2-side-sec">세션</div><a href="#/s/x">다른 세션</a></nav>
 <main class="v2-main" style="display:flex;flex-direction:column;min-height:0;flex:1 1 auto">${session
    ? `<div class="sc-wrap" style="display:flex;flex-direction:column;flex:1 1 auto;min-height:0"><div class="sc-head"><div class="sc-head-l"><button class="sc-side" type="button">≡</button><span class="sc-title">세션</span></div><div class="sc-head-r"></div></div><div class="sc-term" style="flex:1 1 auto"></div></div>`
    : `<div class="v2-center">홈</div>`}</main>
 <aside class="v2-aside" id="v2-aside"></aside>
</div>
${FETCH}
<script>${pack("v2/mobile.ts", "Mob")}</script>`;

async function PAGE(inners) {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const make = async (inner) => {
    const f = document.createElement("iframe");
    f.style.cssText = "width:390px;height:664px;border:0;display:block";
    f.srcdoc = inner;
    document.body.append(f);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    const W = f.contentWindow, D = f.contentDocument;
    W.addEventListener("error", (e) => errors.push("in: " + String(e.message || e)));
    const root = D.getElementById("v2-root");
    const mc = W.Mob.mountMobileChrome(root, D.getElementById("v2-side"), D.getElementById("v2-aside"));
    //  셸(main.ts)처럼 — 창 맨 윗줄을 root 맨 앞에 세우고 ☰ 는 그 맨 왼쪽, [자료] 는 오른쪽 끝. 배경막 · 탭 바는 맨 뒤.
    const top = D.createElement("div"); top.className = "v2-topbar v2-topbar--web"; root.prepend(top);
    top.append(mc.asideBtn); top.prepend(mc.menuBtn);
    root.append(mc.scrim, mc.tabs);
    const sc = D.querySelector(".sc-side"); if (sc) sc.addEventListener("click", () => mc.openSide());   // = session-chat.ts 의 ≡ (onOpenSidebar)
    await sleep(40);
    const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    const st = () => {
      const cs = W.getComputedStyle(top), side = D.getElementById("v2-side");
      const m = mc.menuBtn.getBoundingClientRect();
      const hit = m.width ? D.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2) : null;
      return {
        drawer: root.classList.contains("m-side"),
        bar: cs.display !== "none" && top.getClientRects().length > 0, pos: cs.position, barBox: box(top),
        menuHit: !!hit && (hit === mc.menuBtn || mc.menuBtn.contains(hit)),
        sideTop: Math.round(side.getBoundingClientRect().top),
        wrap: box(D.querySelector(".sc-wrap")),
      };
    };
    return { f, D, mc, st, click: async (n) => { n.click(); await sleep(40); } };
  };
  {
    const t = await make(inners.session);
    R.s0 = t.st();
    await t.click(t.D.querySelector(".sc-side")); R.s1 = t.st();
    await t.click(t.mc.menuBtn); R.s5 = t.st();
    //  목록을 여는 구역 탭(홈 · 더보기가 아닌 것) 아무거나 — 구역 표(railSections)가 바뀌어도 시험이 따라간다.
    const b = t.D.querySelector(".v2-mtab[data-sec]:not([data-sec=home])");
    R.s6tab = !!b;
    if (b) { await t.click(b); R.s6 = t.st(); await t.click(t.mc.menuBtn); R.s6close = t.st(); }
    t.f.remove();
  }
  {
    const t = await make(inners.home);
    t.mc.openSide(); await sleep(40); R.n1 = t.st();
    t.f.remove();
  }
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0">
<pre id="out">PENDING</pre>
<script>const INNERS = ${JSON.stringify({ session: shell(true), home: shell(false) }).replace(/<\/script/gi, "<\\/script")};
(${PAGE.toString()})(INNERS);</script>`;

const dom = await dumpDom(chrome, { html, prefix: "phone-sess-side-", virtualTimeBudget: 30000, args: ["--window-size=600,900"] });
const mm = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!mm) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(mm[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

const s0 = R.s0 || {}, s1 = R.s1 || {}, s5 = R.s5 || {}, s6 = R.s6 || {}, n1 = R.n1 || {};
same([s0.drawer, s0.bar], [false, false], "S0 세션 화면 · 서랍 닫힘 — 맨 윗줄은 걷혀 있다(종전 그대로)");
same([s1.drawer, s1.bar, s1.pos, s1.barBox && s1.barBox.y], [true, true, "fixed", 0], "S1 머리줄 ≡ 로 서랍을 열면 맨 윗줄이 화면 위에 떠서 선다");
same(s1.menuHit, true, "S2 그 줄의 ☰ 가 손가락에 닿는다(서랍 · 탭 바에 안 덮인다)");
//  줄 바닥 = 그 줄의 밑선(1px)까지 — 서랍은 제 윗선(border-top)으로 그 밑선 위에 앉는다(다른 폰 화면과 같은 그림, N1). 그래서 1px 겹침까지는 같다.
const under = (s) => !!s.bar && !!s.barBox && s.barBox.h > 0 && s.sideTop >= s.barBox.y + s.barBox.h - 1 && s.sideTop <= s.barBox.y + s.barBox.h;
same(under(s1), true, "S3 서랍 꼭대기 = 맨 윗줄 바닥(밑선 1px 겹침까지)");
same(s1.wrap, s0.wrap, "S4 서랍을 열어도 세션 판(터미널)의 크기 · 자리가 그대로");
same([s5.drawer, s5.bar, s5.wrap], [false, false, s0.wrap], "S5 ☰ 를 누르면 서랍이 닫히고 맨 윗줄은 다시 걷힌다");
same([R.s6tab, s6.drawer, s6.bar, s6.menuHit, R.s6close && R.s6close.drawer], [true, true, true, true, false], "S6 탭 바로 연 구역 목록도 같은 줄이 서고 ☰ 로 닫힌다");
same([n1.drawer, n1.bar, n1.pos !== "fixed", under(n1)], [true, true, true, true], "N1 세션이 아닌 화면 — 맨 윗줄은 흐름 안 · 서랍은 그 밑(종전 그대로)");
same(R.errors, [], "E  페이지 예외 없음");

console.log(`\n#4998 폰 세션 사이드바 닫기: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
