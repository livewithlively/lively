#!/usr/bin/env node
// 앱 사이드바의 발치 · 좁은 폭의 ☰ (#4632) — 사이드바는 발치까지 그 앱의 것이고, ☰ 는 그 앱의 사이드바만 연다 — 런타임 회귀 테스트.
//
// 원준 2026-10-19 — 「자료 · 분류체계 · 세션 이력 발치의 홈 도크를 뺄까요?」 «ㅇㅇ» · 「폰에서 사이드바 없는 앱의 ☰ 가 홈 목록을 여는데 둘까요?」 «아니 각자 앱 사이드바로.»
//  (그 전 결정 2026-10-17 «사이드바 내용까지가 하나의 앱이야. 한 앱을 실행했는데 다른 앱의 사이드바가 계속 떠있거나, 홈의 사이드바가 떠있는 경우는 없어야한다».)
//  종전엔 자료 · 분류체계 · 세션 이력 발치에 구역 도크(지난 세션 · 휴지통 · 외부 앱 연결)가 붙었고, 좁은 폭에서 사이드바 없는 앱의 ☰ 가 구역 목록(대개 홈)을 열었다.
//  누가 사이드바를 갖나는 side-owner.test.mjs, 앱빌더 사이드바 본문은 builder-side-runtime.test.mjs 가 잰다.
//
// 엣지 표(스크래치패드 spec-side-foot-phone.md):
//  F1~F4 자료 · 분류체계 · 세션 이력 · 앱빌더 — 구역 도크 없음(세션 이력 「세션 목록」 · 앱빌더 「앱 찾기」 는 그 앱의 문이라 남는다)
//  F5 구역 넷 — 도크 셋 그대로(경계) · F6 레일 숨김 — 앱 사이드바에 [앱] · [나] 줄 · 도크 없음 · F7 보이는 게 없는 발치는 자리를 안 차지한다
//  P1~P8 좁은 폭 ☰ — 사이드바 없는 앱은 ☰ 없음 · 어떤 길로도 서랍 안 열림 · 넓은 폭 단추는 그대로 · 문턱 넘나들기 · 열린 서랍 닫기 · 폰 탭 바 · setSide 부재
//  W 셸 배선 — main.ts 가 사이드바 주인으로 setSide 를 부른다
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 F1~F3 · F6 · P1 · P4~P6 이 빨갛다).
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
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

// ── W — 셸 배선(소스) — 사이드바 열 접기(app-ctx)와 ☰ 걷기가 같은 판정(사이드바 주인)을 본다 ──
{
  const main = readFileSync(path.join(WEB, "v2/main.ts"), "utf8");
  const m = /const (\w+) = sideOwnerOfRoute\(tab\.route\) !== 'none';([\s\S]{0,600})/.exec(main);
  check(!!m && new RegExp(`classList\\.toggle\\('app-ctx', !${m[1]}\\)`).test(m[2]) && new RegExp(`mobile\\?\\.setSide\\(${m[1]}\\)`).test(m[2]),
    "W  셸이 사이드바 주인으로 열 접기(app-ctx)와 ☰ 걷기(setSide)를 함께 정한다", m ? m[0].slice(0, 200) : "판정 줄 없음");
}

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 런타임 검증(F · P)을 건너뜁니다(CHROME_BIN 으로 지정)"); console.log(`\n#4632 발치 · ☰: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`); process.exit(fail ? 1 : 0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const pack = (entry, name) => execFileSync(ESBUILD, [path.join(WEB, entry), "--bundle", "--format=iife", "--global-name=" + name, "--platform=browser",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
//  사이드바 + 레일 숨기기(사람이 ⌘⇧S 로 숨긴 것과 같은 상태) — side.ts 는 레일의 상태를 직접 읽는다(rail.ts railIsHidden).
const packSideRail = () => execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=Side", "--platform=browser", "--loader=ts", "--sourcefile=side-rail.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: "export * from './v2/side.ts'; export { toggleRail, railIsHidden } from './v2/rail.ts';", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");
const FETCH = `<script>window.__calls = [];
window.fetch = async (u) => {
  const url = String(u && u.url ? u.url : u); window.__calls.push(url.replace(/^.*?(\\/api\\/)/, "/api/"));
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (url.includes("/api/ui/apps")) return j({ apps: [] });
  return j({});
};</script>`;
const grab = async (html, prefix) => {
  const dom = await dumpDom(chrome, { html, prefix, virtualTimeBudget: 30000, args: ["--window-size=1400,900"] });
  const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
  return JSON.parse(m[1]);
};

// ══ F — 발치 ══════════════════════════════════════════════════════════════════
async function PAGE_FOOT() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = document.getElementById("host");
  const side = document.querySelector(".v2-side");
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const data = { projects: [{ id: 1, name: "결제" }], sessions: [{ id: "box-1", label: "결제 백오프", projectId: 1, owned: true, lastSeen: Date.now() }], lists: [], folders: [], loadedAt: Date.now() };
  //  화면마다 [활성 키, 주인, 구역] — 주인은 셸이 넘기는 그대로(main.ts owner 훅). 구역 넷은 주인 «section» 에 그 구역.
  const SCREENS = {
    sources: ["sources", "sources", "home"], taxonomy: ["taxonomy", "taxonomy", "home"], sessions: ["app:sessions", "sessions", "home"], builder: ["builder", "builder", "home"],
    home: ["home", "section", "home"], sess: ["app:terminal", "section", "sess"], proj: ["app:projects2", "section", "proj"], wiki: ["app:knowledge", "section", "wiki"],
  };
  const HASH = { sources: "#/sources", taxonomy: "#/taxonomy", sessions: "#/app/sessions", builder: "#/builder", home: "#/", sess: "#/app/terminal", proj: "#/projects2", wiki: "#/app/knowledge" };
  const look = async (key, railHidden) => {
    const [ak, own, sec] = SCREENS[key];
    history.replaceState(null, "", HASH[key]);
    Side.drawSide(host, data, () => ak, { section: () => sec, owner: () => own, instances: () => [], navHost: () => null, railHidden: () => railHidden });
    await sleep(60);
    const foot = host.querySelector("footer");
    return {
      sec: side.getAttribute("data-sec"),
      dock: [...host.querySelectorAll(".v2-app-dock .v2-dock-t")].map(txt),
      links: [...host.querySelectorAll("footer .v2-foot-link")].map((a) => txt(a.querySelector(".n"))),
      row: !!host.querySelector("footer .v2-foot-row"),
      footH: foot ? Math.round(foot.getBoundingClientRect().height) : null,
    };
  };
  R.shown = {}; R.hidden = {};
  for (const k of Object.keys(SCREENS)) R.shown[k] = await look(k, false);
  Side.toggleRail();
  R.railHidden = Side.railIsHidden();
  for (const k of Object.keys(SCREENS)) R.hidden[k] = await look(k, true);
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE_F = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "47-v2-rail.css", "49-v2-ctx.css")}
  html,body{margin:0} #v2-root{display:block} .v2-side{width:316px;height:800px}
</style>
<div id="v2-root"><nav class="v2-side stu-side" id="v2-side"><div class="stu-panel"><div class="stu-panel-tree" id="host"></div></div></nav></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>${packSideRail()}</script>
<script>(${PAGE_FOOT.toString()})();</script>`;

// ══ P — 좁은 폭 ☰ ═══════════════════════════════════════════════════════════════
//  matchMedia 는 문서의 폭을 본다 — 모바일 크롬을 iframe 안에 달고 그 iframe 의 폭을 바꿔 문턱을 넘나든다(창 크기는 못 바꾼다).
const INNER = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "43-v2-topbar-search.css", "47-v2-rail.css", "50-mobile.css")}
  html,body{margin:0}
</style>
<div id="v2-root" class="rail-mode has-topbar topbar-web"><nav class="v2-side" id="v2-side"><a href="#/x">줄</a></nav><main class="v2-main"></main><aside class="v2-aside" id="v2-aside"></aside></div>
${FETCH}
<script>${pack("v2/mobile.ts", "Mob")}</script>`;
async function PAGE_PHONE(inner) {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const make = async (w) => {
    const f = document.createElement("iframe");
    f.style.cssText = `width:${w}px;height:700px;border:0;display:block`;
    f.srcdoc = inner;
    document.body.append(f);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    const W = f.contentWindow, D = f.contentDocument;
    W.addEventListener("error", (e) => errors.push("in: " + String(e.message || e)));
    const root = D.getElementById("v2-root");
    const mc = W.Mob.mountMobileChrome(root, D.getElementById("v2-side"), D.getElementById("v2-aside"));
    //  셸(main.ts)처럼 ☰ 를 창 맨 윗줄로 옮긴다 — 넓은 폭에선 그 자리의 단추가 레일 여닫이다.
    const top = D.createElement("div"); top.className = "v2-topbar v2-topbar--web"; root.prepend(top); top.prepend(mc.menuBtn);
    root.append(mc.scrim, mc.tabs);
    await sleep(30);
    const st = () => ({
      menu: mc.menuBtn.getClientRects().length > 0,   // 화면에 서 있나(계산된 모양) — 속성이 아니라 결과를 잰다
      drawer: root.classList.contains("m-side"),
      sheet: mc.sheetSection(),
    });
    //  ⚠ 이 헤드리스에선 매체 질의의 change 이벤트가 오지 않는다(실측 0회) — 그래서 문턱 넘나들기는 CSS 가 맡고(계산된 모양을 잰다), 이벤트에 기대는 판정은 여기서 못 잰다.
    const resize = async (px) => { f.style.width = px + "px"; void f.offsetWidth; await sleep(60); };
    const tap = async (sec) => { const b = D.querySelector(`.v2-mtab[data-sec="${sec}"]`); if (b) b.click(); await sleep(30); return !!b; };
    //  setSide 가 없는 트리(이 변경 전)에서도 끝까지 돌아 «빨강» 으로 보이게 — 없으면 아무 일도 안 한다.
    const side = (on) => { if (typeof mc.setSide === "function") mc.setSide(on); else R.noSetSide = true; };
    return { f, mc, st, resize, tap, side, click: async () => { mc.menuBtn.click(); await sleep(30); } };
  };
  // P1 · P2 — 태블릿 폭(800)
  {
    const t = await make(800);
    t.side(false); await sleep(30);
    const a = t.st(); await t.click(); const b = t.st(); t.mc.openSide(); await sleep(30); const c = t.st();
    R.p1 = { hidden: a, afterClick: b, afterOpenSide: c };
    t.side(true); await sleep(30);
    const d = t.st(); await t.click(); const e = t.st();
    R.p2 = { shown: d, afterClick: e };
    // P5 — ☰ 로 연 서랍(그 앱의 사이드바)이 열린 채 사이드바 없는 앱으로
    t.side(false); await sleep(30);
    R.p5 = t.st();
    t.f.remove();
  }
  // P3 · P4 — 넓은 폭(1400)에서 사이드바 없는 앱 → 좁게 → 다시 넓게
  {
    const t = await make(1400);
    t.side(false); await sleep(30);
    R.p3 = t.st();
    await t.resize(800); R.p4n = t.st();
    await t.resize(1400); R.p4w = t.st();
    t.f.remove();
  }
  // P6 · P8 — 폰(390) · 사이드바 없는 앱 · 아래 탭 바 「위키」
  {
    const t = await make(390);
    t.side(false); await sleep(30);
    const had = await t.tap("wiki");
    R.p6 = { tab: had, open: t.st() };
    t.side(false); await sleep(30);
    R.p8 = t.st();
    await t.tap("wiki");
    R.p6close = t.st();
    t.f.remove();
  }
  // P7 — setSide 를 부르지 않은 셸(종전 임베더)
  {
    const t = await make(800);
    const a = t.st(); await t.click(); R.p7 = { before: a, after: t.st() };
    t.f.remove();
  }
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE_P = `<!doctype html><html lang="ko"><meta charset="utf-8"><body style="margin:0">
<pre id="out">PENDING</pre>
<script>const INNER = ${JSON.stringify(INNER).replace(/<\/script/gi, "<\\/script")};
(${PAGE_PHONE.toString()})(INNER);</script>`;

const F = await grab(PAGE_F, "app-side-foot-");
const P = await grab(PAGE_P, "app-side-phone-");
if (process.env.DEBUG) console.log(JSON.stringify({ F, P }, null, 1));

// ── F ──
const S = F.shown || {}, H = F.hidden || {};
same(S.sources && [S.sources.sec, S.sources.dock], ["sources", []], "F1 자료 사이드바 — 구역 도크(지난 세션 · 휴지통 · 외부 앱 연결)가 없다");
same(S.taxonomy && [S.taxonomy.sec, S.taxonomy.dock], ["taxonomy", []], "F2 분류체계 사이드바 — 구역 도크가 없다");
same(S.sessions && [S.sessions.sec, S.sessions.dock, S.sessions.links], ["sessions", [], ["세션 목록"]], "F3 세션 이력 사이드바 — 구역 도크 없이 그 앱의 문 「세션 목록」 만");
same(S.builder && [S.builder.sec, S.builder.dock, S.builder.links], ["builder", [], ["앱 찾기"]], "F4 앱빌더 사이드바 — 구역 도크 없이 「앱 찾기」");
const DOCK = ["지난 세션", "휴지통", "외부 앱 연결"];
const secs = ["home", "sess", "proj", "wiki"];
same(secs.map((k) => S[k] && [S[k].sec, S[k].dock]), secs.map((k) => [k, DOCK]), "F5 구역 넷(홈 · 세션 목록 · 프로젝트 · 위키) — 도크 셋은 그대로(구역의 것)");
check(F.railHidden === true, "F6 배선 — 레일이 실제로 숨었다(이게 아니면 아래 F6 은 아무것도 안 잰다)", String(F.railHidden));
const apps = ["sources", "taxonomy", "sessions", "builder"];
same(apps.map((k) => H[k] && [H[k].row, H[k].dock.length]), apps.map(() => [true, 0]), "F6 레일을 숨기면 앱 사이드바 발치에 [앱] · [나] 줄(레일 그 자체) — 도크는 여전히 없다");
same(H.builder && H.builder.links, [], "F6 레일을 숨긴 앱빌더 — 「앱 찾기」 대신 [앱] 하나(같은 일이 둘 서지 않는다)");
same(secs.map((k) => H[k] && [H[k].row, H[k].dock.length]), secs.map(() => [true, 3]), "F6 레일을 숨긴 구역 — [앱] · [나] 줄과 도크 셋(경계)");
check(S.sources && (S.sources.footH === 0 || S.sources.footH === null) && S.taxonomy && (S.taxonomy.footH === 0 || S.taxonomy.footH === null),
  "F7 보이는 게 없는 발치(자료 · 분류체계, 레일 보임)는 줄(위 선 · 여백)도 안 선다", JSON.stringify([S.sources && S.sources.footH, S.taxonomy && S.taxonomy.footH]));
check(S.sessions && S.sessions.footH > 0, "F7 문이 있는 발치(세션 이력)는 선다(경계)", String(S.sessions && S.sessions.footH));
same(F.errors, [], "F  페이지 예외 없음");

// ── P ──
const no = { menu: false, drawer: false, sheet: null };
same(P.p1, { hidden: no, afterClick: no, afterOpenSide: no }, "P1 좁은 폭(800) · 사이드바 없는 앱 — ☰ 가 없고, ☰ 클릭 · 머리줄 ≡(openSide) 어느 길로도 서랍이 안 열린다");
same(P.p2, { shown: { menu: true, drawer: false, sheet: null }, afterClick: { menu: true, drawer: true, sheet: null } }, "P2 좁은 폭 · 사이드바 있는 앱 — ☰ 가 서고 누르면 그 사이드바 서랍");
same(P.p3 && P.p3.menu, true, "P3 넓은 폭(1400) · 사이드바 없는 앱 — 그 자리의 단추(레일 여닫이)는 그대로(경계)");
same([P.p4n && P.p4n.menu, P.p4w && P.p4w.menu], [false, true], "P4 문턱을 넘나들면 다시 맞춘다 — 좁아지면 ☰ 를 걷고 넓어지면 단추가 돌아온다");
same(P.p5, no, "P5 ☰ 로 연 서랍이 열린 채 사이드바 없는 앱으로 — 서랍을 닫고 ☰ 를 걷는다");
same(P.p6, { tab: true, open: { menu: false, drawer: true, sheet: "wiki" } }, "P6 폰(390) · 사이드바 없는 앱에서 탭 「위키」 — 사람이 고른 구역의 목록이 서고 ☰ 는 여전히 없다");
same(P.p8, { menu: false, drawer: true, sheet: "wiki" }, "P8 탭 바로 연 목록이 열린 채 다시 «사이드바 없음» — 사람이 고른 목록은 그대로");
same(P.p6close, no, "P6 같은 탭을 다시 누르면 닫힌다");
same(P.p7, { before: { menu: true, drawer: false, sheet: null }, after: { menu: true, drawer: true, sheet: null } }, "P7 setSide 를 부르지 않은 셸 — 종전 그대로(☰ 가 서고 서랍이 열린다)");
same(P.errors, [], "P  페이지 예외 없음");

console.log(`\n#4632 발치 · ☰: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
