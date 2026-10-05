#!/usr/bin/env node
// 셸(mountPanes) 을 실제 크롬에 통째로 세워 보는 런타임 검증 — 아래 칸 · 켜진 탭 다시 누르기 (#4443, 원준 2026-10-01)
//
//  원준: «닫힌 아래 칸은 … 펼쳐지지 않습니다 → 근데 왜 <아래 칸을 켜면 (타임라인이) 거기 있습니다> ???»
//        «자료 탭에서 … 하위로 들어갔을 때 상단에 있는 자료 아이콘을 다시 누르면 자료 맨 상단으로»
//  규칙 자체는 pane-tabs.test.mjs(BS · PK)가 값으로, 배선은 같은 파일 X 행이 소스로 본다. 여기는 **셸을 실제로 세워**
//  그 둘이 이어졌는지 본다 — 소스 정규식으로는 위쪽 고리(paintPane 의 pane.act · 마운트 순서)가 끊겨도 초록이다(격리 리뷰 지적).
//  가짜는 셋뿐: fetch(자료 목록 · 프로젝트) · ResizeObserver · IntersectionObserver. 부품 · 셸 · CSS 는 제품 그대로.
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  A1 처음 쓰는 브라우저: 아래 칸은 비고 숨었다(경계선 · no-bottom 까지) · 옛 기본 걷기 표식이 찍힌다
//  A2 [＋] › «아래 칸 열기» — 비었으면 빈 칸을 펴지 않고 «아래 칸에 넣을 것»부터 고른다
//  A3 고른 것이 아래 칸에 서야 그제서야 아래 칸이 열린다
//  A4 ✕ 로 닫은 뒤 «아래 칸 열기» — 내용이 있으니 고르기 없이 바로 연다
//  A5 아래 칸의 마지막 탭을 닫으면 빈 칸이 남지 않는다 · 그 뒤 «아래 칸 열기» 는 다시 고르기부터
//  A6 아래 칸이 보이는 동안 [＋] 발치에 «아래 칸 열기» 가 없다
//  A7 «기본 배치로 되돌리기» — 아래 칸이 비고 숨는다
//  A8 다른 세션이 «열림» 을 기억해도 내용이 비었으면 빈 칸이 올라오지 않는다 · 우클릭 «아래 칸으로 보내기» 를 하면 그 순간 선다
//  M1 옛 기본(닫힌 아래 칸에 타임라인 하나)을 걷는다 — 열린 프로젝트(p8)는 그대로 · 곁칸은 손대지 않는다
//  M2 이 세션이 «열림» 을 기억해도 걷은 뒤엔 아무것도 안 올라온다
//  M3 한 번 걷으면 다시 열어도 저장소를 다시 쓰지 않는다(표식) · 표식 뒤 사람이 둔 타임라인은 그대로
//  R1 켜진 자료 탭을 다시 누르면 맨 위 폴더 · «뒤로»(마우스 옆 단추) 로 하위 폴더에 돌아간다
//  R2 이미 맨 위면 목록만 맨 위로(폴더 그대로)
//  R3 다른 탭에서 자료 탭으로 돌아오면 보던 폴더 그대로
//  R4 끌고 놓은 뒤의 click 은 «다시 누르기» 가 아니다
//  R7 «처음으로» 가 없는 탭(프로젝트)은 다시 눌러도 켜진 채 그대로
//  H1 머리줄 [자료](showPart) — 보이고 켜져 있으면 맨 위 폴더
//  H2 곁칸이 접혀 있으면 펴기만(폴더 그대로) · 다른 탭이 켜져 있으면 자료를 켜기만(폴더 그대로)
//  I1 자료가 둘이면 누른 탭의 자료만 맨 위로 — 다른 자료는 보던 폴더 그대로
//  AD1 [＋] = 앱 서랍(원준 10-05 «① 앱 서랍 + ② 의 키보드»): [＋] 바로 아래 · 곁칸 안 · 열리면 검색칸에 초점
//  AD2 원준 화면 상태(곁칸에 자료만)에서 타일 열 개 — 독과 같은 앱 색 타일 · 이미 열린 자료엔 ＋(하나 더) · 첫 타일이 Enter 의 과녁 · 설명 한 줄
//  AD3 «새 탭으로 여는 앱» 은 없다 — 여기서 여는 것은 모두 사이드바에 선다(원준 10-05)
//  AD4 치면 거르고 Enter 로 연다(그 칸에 탭 · 서랍 닫힘) · AD5 한글 조합 중의 Enter 는 열지 않는다 · AD6 없는 이름 — 타일 0 · 안내 한 줄
//  AD7 ↓ 로 타일에 들어가 → 로 옮기면 설명이 따라간다 · 첫 줄에서 ↑ 면 검색칸 · AD8 올리면 설명 · 이미 열린 자료를 누르면 «자료 2» · AD9 Esc 로 닫힌다
//  E1 페이지 오류 없음(그리는 중에 던진 것). 마운트 자체가 던지면(TDZ 등) 그 장면이 «장면이 던졌다» 로 실패한다
//
//  fail-first(2026-10-01): 변경 전 판(SRC_ROOT 로 cc81bfd7~1 을 세움)에서 A1–A3 · A5 · A7 · A8 · M1 · M2 · R1 · R2 · H1 · H2 · I1 빨강,
//   paintPane 의 `pane.act = act;` 를 지운 돌연변이에서 R1 · R2 · H1 · H2 · I1 빨강(소스 정규식 X 행은 그대로 초록이던 고리),
//   bottomVisible 을 첫 paintAll 아래로 옮긴 돌연변이에서 마운트가 던져 모든 장면 빨강(S11 도 함께).
//  fail-first(2026-10-05 앱 서랍): 바꾸기 전 판(옛 고르기)에서 AD1–AD9 빨강. 돌연변이 — 한글 조합 중 Enter 막기를 빼면 AD4 · AD5,
//   격자 화살표를 빼면 AD7, ＋(하나 더) 배지를 빼면 AD2 가 빨갛다.
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 셸 런타임 검증 미실행"); process.exit(0); }
const CSS = ["01-base.css", "03-components.css", "20-dashboard.css", "40-v2.css", "42-v2-dock.css", "42-v2-panes.css", "45-v2-side-swap.css", "49-v2-ctx.css", "50-mobile.css"]
  .map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const bundle = buildSync({
  stdin: { contents: "export { mountPanes } from './web/v2/panes.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "PN", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch (_) { /* 아직 */ } await sleep(20); } return false; };
  const SRC = document.getElementById("pfsrc").textContent;
  const LAYOUT = "lively_panes_layout_v2", VIEW = "pn_view_by_sess";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // 가짜 서버 — 자료 목록만 진짜처럼(폴더 docs · docs/sub)
  const FS = new Map();
  const seedFs = () => { FS.clear(); const put = (p, type, d) => FS.set(p, { type, size: d || 0, mtime: 1000 }); put("docs", "dir"); put("docs/inner.txt", "file", 5); put("docs/sub", "dir"); put("docs/sub/deep.txt", "file", 5); put("readme.md", "file", 8); put("notes.txt", "file", 5); };
  const kids = (dir) => [...FS.keys()].filter((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir);
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  window.fetch = async (url) => {
    const u = new URL(url, "http://x/");
    const mm = /\/projects\/(\d+)(\/.*)?$/.exec(u.pathname);
    if (mm && mm[2] === "/files") { const q = u.searchParams.get("path") || ""; return J({ items: kids(q).map((p) => { const e = FS.get(p); return { name: p.split("/").pop(), type: e.type, size: e.size, mtime: e.mtime }; }) }); }
    if (mm && !mm[2]) return J({ project: { id: Number(mm[1]), name: "P", status_category: "started" } });
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(e) { setTimeout(() => this.cb([{ target: e, isIntersecting: true }]), 0); } unobserve() {} disconnect() {} };

  let handle = null;
  const mount = async (id = 7) => {
    if (handle) { try { handle.destroy(); } catch (_) { /* 이미 */ } handle = null; }
    document.getElementById("app")?.remove();
    const host = document.createElement("div");
    host.id = "app"; host.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;display:flex;flex-direction:column;background:var(--bg)";
    document.body.append(host);
    const PN = (new Function(SRC + "\n;return PN;"))();
    handle = PN.mountPanes(host, { id, detail: { project: { id, name: "P" } }, data: () => ({ projects: [{ id, name: "P" }], sessions: [], loadedAt: Date.now() }), sessionId: null, onOpenDrawer: () => {}, onCloseDrawer: () => {} });
    await sleep(350);
    return handle;
  };
  const store = () => JSON.parse(localStorage.getItem(LAYOUT) || "null");
  const views = () => JSON.parse(localStorage.getItem(VIEW) || "{}");
  const zone = (z) => $(`#app .pn-pane[data-zone="${z}"]`);
  const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  //  아래 칸이 «섰나» — 칸 · 경계선 · 가운데 열의 no-bottom 셋이 같은 말을 해야 한다
  const bottomUp = () => { const s = $$("#app .v2-split").find((n) => n.getAttribute("aria-label") === "아래 칸 높이"); return { pane: shown(zone("bottom")), split: s ? !s.hidden : null, col: !$("#app .pn-col")?.classList.contains("no-bottom") }; };
  const tabNames = (z) => $$(`#app .pn-pane[data-zone="${z}"] .pn-tab`).map((b) => b.getAttribute("aria-label"));
  const actTab = (z) => $$(`#app .pn-pane[data-zone="${z}"] .pn-tab`).find((b) => b.getAttribute("aria-selected") === "true")?.getAttribute("aria-label") || null;
  const tabBtn = (z, nm) => $$(`#app .pn-pane[data-zone="${z}"] .pn-tab`).find((b) => b.getAttribute("aria-label") === nm);
  const popClose = () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); $$(".dash-pop").forEach((n) => n.remove()); };
  const openAdd = async (z = "side") => { popClose(); $(`#app .pn-pane[data-zone="${z}"] .pn-tab-add`).click(); await sleep(60); };
  //  [＋] = 앱 서랍(v2/pane-drawer) — 제목 · 발치 단추 · 타일
  const DR = ".dash-pop.pn-adraw";
  const popHead = () => $(DR + " .pn-dock-more-sh b")?.textContent || null;
  const popFoot = () => $$(DR + " .pn-adraw-f .btn-text").map((b) => b.textContent.trim());
  const clickFoot = async (txt) => { const b = $$(DR + " .pn-adraw-f .btn-text").find((x) => x.textContent.trim() === txt); if (!b) return false; b.click(); await sleep(80); return true; };
  const tileOf = (nm) => $$(DR + " .pn-dock-tile").find((x) => x.querySelector(".pn-dock-tile-n")?.textContent.trim() === nm) || null;
  const clickRow = async (nm) => { const b = tileOf(nm); if (!b) return false; b.click(); await sleep(120); return true; };
  const descNow = () => $(DR + " .pn-adraw-desc")?.textContent || null;
  const crumb = (root) => (root ? $$(".pn-fcrumb", root).map((b) => b.textContent).join("/") : null);
  const fpOrder = (root) => (root ? $$("[data-fp]", root).map((n) => n.dataset.fp) : []);
  const filesRoot = () => $$('#app .pn-pane[data-zone="side"] .pn-files').find((n) => !n.hidden) || null;
  //  ⚠ 폴더 열기 · 뒤로는 **플랫폼과 무관한 손**으로 — 자료 칸은 모듈을 읽을 때 맥/윈도 단축키 표를 고른다(finder-keys isMacPlatform).
  //   ⌘↓ · ⌘[ 로 짜면 맥에선 초록, 리눅스 CI 에선 폴더에 못 들어가 빨강이었다(PR #1216 첫 CI).
  const enterDocs = async (root) => {
    await waitFor(() => fpOrder(root).includes("docs"), 4000);
    $$("[data-fp]", root).find((n) => n.dataset.fp === "docs").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));   // 두 번 누르기 = 열기
    await waitFor(() => fpOrder(root).includes("docs/inner.txt"));
  };
  const goBack = (root) => root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 3 }));   // 마우스 옆 단추(뒤로)
  const clk = async (el) => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); await sleep(150); };
  const fresh = () => { localStorage.removeItem(LAYOUT); localStorage.removeItem(VIEW); seedFs(); };

  // ── A — 처음 쓰는 브라우저 · 아래 칸은 넣은 것이 있을 때만 ──
  try {
    fresh(); await mount();
    const a = {}; R.a = a;
    const s0 = store(); a.store0 = { bottom: s0?.last?.bottom ?? null, act: s0?.last?.act?.bottom ?? null, seeded: s0?.seeded || null };
    a.b0 = bottomUp();
    await openAdd(); a.foot0 = popFoot();
    a.clickOpen = await clickFoot("아래 칸 열기"); a.pickHead = popHead(); a.b1 = bottomUp();
    a.picked = await clickRow("타임라인"); a.b2 = bottomUp(); a.bottomTabs2 = tabNames("bottom");
    await openAdd(); a.footVisible = popFoot(); popClose();
    $('#app .pn-pane[data-zone="bottom"] .pn-pane-hide').click(); await sleep(80); a.b3 = bottomUp();
    await openAdd(); await clickFoot("아래 칸 열기"); a.reopenHead = popHead(); a.b4 = bottomUp(); popClose();
    tabBtn("bottom", "타임라인").parentElement.querySelector(".pn-tab-x").click(); await sleep(120);
    a.b5 = bottomUp();
    await openAdd(); await clickFoot("아래 칸 열기"); a.emptyHead = popHead(); popClose();
    await openAdd(); await clickRow("타임라인"); await sleep(60);                        // 되돌리기가 곁칸도 기본으로 돌리는지 보려고 하나 더 둔다
    await openAdd(); await clickFoot("기본 배치로"); await sleep(150);
    const sr = store(); a.reset = { b: bottomUp(), bottom: sr.last.bottom, side: tabNames("side") };
    localStorage.setItem(VIEW, JSON.stringify({ p7: { bottomOn: true } }));          // 다른 세션의 «열림» 기억 + 빈 내용
    await mount(); a.remembered = bottomUp();
    tabBtn("side", "지식").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })); await sleep(80);
    const row = $$(".pn-ctx .pn-ctx-i, .pn-ctx button").find((b) => /아래 칸으로 보내기/.test(b.textContent));
    a.sendRow = !!row; if (row) { row.click(); await sleep(150); }
    a.afterSend = { b: bottomUp(), bottom: tabNames("bottom") };
  } catch (e) { R.errA = String(e && e.stack || e); }

  // ── M — 옛 기본값이 저장된 브라우저(한 번 걷기) ──
  try {
    const parked = (extra = {}) => ({ main: ["sessions"], side: ["files", "knowledge", "apps"], bottom: ["timeline"], act: { main: "sessions", side: "files", bottom: "timeline" }, sideOn: true, bottomOn: false, pin: [], ...extra });
    fresh();
    localStorage.setItem(LAYOUT, JSON.stringify({ last: parked(), p: { 7: parked(), 8: parked({ bottomOn: true }) }, seeded: { tasks: 1 } }));
    localStorage.setItem(VIEW, JSON.stringify({ p7: { bottomOn: true } }));         // 이 세션은 «열림» 을 기억한다
    await mount();
    const m = {}; R.m = m;
    const s = store(); m.store = { last: s.last.bottom, p7: s.p[7].bottom, p8: s.p[8].bottom, seeded: s.seeded, side: s.p[7].side };
    m.b = bottomUp();
    const raw = localStorage.getItem(LAYOUT); await mount(); m.same = raw === localStorage.getItem(LAYOUT);
    const st = store(); st.p[7].bottom = ["timeline"]; st.p[7].bottomOn = false; st.last = st.p[7];
    localStorage.setItem(LAYOUT, JSON.stringify(st)); localStorage.setItem(VIEW, "{}");
    await mount(); m.afterMarker = store().p[7].bottom;
    await mount(8); m.p8 = { b: bottomUp(), tabs: tabNames("bottom") };
  } catch (e) { R.errM = String(e && e.stack || e); }

  // ── R — 켜진 탭을 다시 누르면 처음으로 ──
  try {
    fresh(); await mount();
    const r = {}; R.r = r;
    let root = filesRoot(); await waitFor(() => fpOrder(root).length > 0);
    await enterDocs(root); r.in = crumb(root);
    await clk(tabBtn("side", "자료")); r.R1 = crumb(root);
    goBack(root); await waitFor(() => fpOrder(root).includes("docs/inner.txt")); r.R1back = crumb(root);
    await clk(tabBtn("side", "자료")); await waitFor(() => !fpOrder(root).includes("docs/inner.txt"));
    const body = $(".pn-fbody", root); const pad = document.createElement("div"); pad.style.cssText = "height:3000px;flex:none"; body.append(pad); body.scrollTop = 300;
    r.scrolled = body.scrollTop; await clk(tabBtn("side", "자료")); r.R2 = { top: body.scrollTop, crumb: crumb(root) };
    await enterDocs(root);
    await clk(tabBtn("side", "프로젝트")); await clk(tabBtn("side", "자료")); r.R3 = { act: actTab("side"), crumb: crumb(root) };
    await clk(tabBtn("side", "프로젝트")); await clk(tabBtn("side", "프로젝트")); r.R7 = actTab("side");
    await clk(tabBtn("side", "자료")); root = filesRoot(); r.in4 = crumb(root);
    const wrap = tabBtn("side", "자료").parentElement; const b = wrap.getBoundingClientRect();
    const P = (type, x, y) => (type === "pointerdown" ? wrap.querySelector(".pn-tab") : window).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 5, pointerType: "mouse" }));
    P("pointerdown", b.left + b.width / 2, b.top + b.height / 2); P("pointermove", b.left + b.width / 2 + 40, b.top + b.height / 2); P("pointerup", b.left + b.width / 2 + 40, b.top + b.height / 2);
    wrap.querySelector(".pn-tab").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); await sleep(150);
    r.R4 = crumb(filesRoot());
  } catch (e) { R.errR = String(e && e.stack || e); }

  // ── H — 머리줄 [자료] = showPart ──
  try {
    fresh(); const h = await mount();
    const o = {}; R.h = o;
    let root = filesRoot(); await waitFor(() => fpOrder(root).length > 0); await enterDocs(root);
    h.showPart("files"); await sleep(200); o.H1 = crumb(root);
    await enterDocs(root);
    $('#app .pn-pane[data-zone="side"] .pn-pane-hide').click(); await sleep(100); o.collapsed = !shown(zone("side"));
    h.showPart("files"); await sleep(200); o.H2a = { side: shown(zone("side")), crumb: crumb(filesRoot()) };
    await clk(tabBtn("side", "프로젝트")); h.showPart("files"); await sleep(200); o.H2b = { act: actTab("side"), crumb: crumb(filesRoot()) };
  } catch (e) { R.errH = String(e && e.stack || e); }

  // ── I — 자료가 둘(files · files#2) ──
  try {
    fresh(); await mount();
    const i = {}; R.i = i;
    await openAdd(); await clickRow("자료"); await sleep(200);   // 이미 열린 자료 = 하나 더
    const roots = $$('#app .pn-pane[data-zone="side"] .pn-files');
    const second = roots.find((n) => !n.hidden); await waitFor(() => fpOrder(second).length > 0); await enterDocs(second);
    const first = roots.find((n) => n !== second);
    await clk(tabBtn("side", "자료")); await waitFor(() => fpOrder(first).length > 0); await enterDocs(first);
    await clk(tabBtn("side", "자료")); i.first = crumb(first); i.second = crumb(second); i.count = roots.length;
  } catch (e) { R.errI = String(e && e.stack || e); }

  // ── D — 앱 서랍(원준 10-05 «① 앱 서랍 + ② 의 키보드») ──
  try {
    fresh(); await mount();
    const d = {}; R.d = d;
    for (const nm of ["프로젝트", "지식", "앱"]) { const b = tabBtn("side", nm); if (b) { b.parentElement.querySelector(".pn-tab-x")?.click(); await sleep(80); } }
    d.sideTabs = tabNames("side");                                              // 원준 화면과 같게 — 곁칸에 자료만
    await openAdd();
    const dr = $(DR); const inp = dr && dr.querySelector("input");
    const add = $('#app .pn-pane[data-zone="side"] .pn-tab-add').getBoundingClientRect(), pr = zone("side").getBoundingClientRect(), rr = dr ? dr.getBoundingClientRect() : null;
    d.open = { has: !!dr, focus: !!inp && document.activeElement === inp, top: rr ? Math.round(rr.top - add.bottom) : null, inPane: !!rr && rr.left >= pr.left - 0.5 && rr.right <= pr.right + 0.5 };
    const tiles = () => $$(DR + " .pn-dock-tile").map((t) => ({ n: t.querySelector(".pn-dock-tile-n").textContent, plus: !!t.querySelector(".pn-adraw-plus"), sel: t.getAttribute("aria-selected") === "true",
      gi: !!t.querySelector('svg.v2-gi .v2-gi-glyph[stroke^="var(--gi-c-"]') }));
    d.tiles = tiles(); d.desc0 = descNow();
    d.noNewTab = !!dr && !dr.querySelector("a") && !/새 탭으로/.test(dr.textContent);
    inp.value = "타임"; inp.dispatchEvent(new Event("input", { bubbles: true })); await sleep(30);
    d.typed = { tiles: tiles().map((t) => t.n + (t.sel ? "*" : "")), desc: descNow() };
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })); await sleep(60);
    d.imeKept = !!$(DR) && !tabNames("side").includes("타임라인");
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await sleep(150);
    d.entered = { closed: !$(DR), tabs: tabNames("side"), act: actTab("side") };
    await openAdd(); const inp2 = $(DR + " input");
    inp2.value = "zzz"; inp2.dispatchEvent(new Event("input", { bubbles: true })); await sleep(30);
    d.none = { tiles: $$(DR + " .pn-dock-tile").length, desc: descNow() };
    inp2.value = ""; inp2.dispatchEvent(new Event("input", { bubbles: true })); await sleep(30);
    inp2.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await sleep(20);
    const first = document.activeElement?.querySelector?.(".pn-dock-tile-n")?.textContent || null;
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); await sleep(20);
    d.arrows = { first, now: document.activeElement?.querySelector?.(".pn-dock-tile-n")?.textContent || null, desc: descNow() };
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); await sleep(20);
    d.backToInput = document.activeElement === inp2;
    tileOf("웹").dispatchEvent(new MouseEvent("mouseenter")); await sleep(20);
    d.hover = descNow();
    await clickRow("자료");
    d.more = { closed: !$(DR), tabs: tabNames("side") };
    await openAdd(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(40);
    d.esc = !$(DR);
  } catch (e) { R.errD = String(e && e.stack || e); }

  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out">PENDING</pre>
<script type="text/plain" id="pfsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, { html: PAGE, copy: CSS, prefix: "pane-shell-", virtualTimeBudget: 120000, args: ["--window-size=1400,900"] });
const mres = /<pre id="out">([\s\S]*?)ENDRESULT/.exec(dom);
if (!mres) { console.error("FAIL  페이지가 결과를 안 냈다\n" + dom.slice(0, 1500)); process.exit(1); }
const R = JSON.parse(mres[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const J = (v) => JSON.stringify(v);
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — 실제 ${J(got)}`); } };
const down = (b) => !!b && !b.pane && b.split === false && !b.col;       // 칸 · 경계선 · 가운데 열 모두 «없음»
const up = (b) => !!b && b.pane && b.split === true && b.col;
for (const k of ["errA", "errM", "errR", "errH", "errI", "errD", "fatal"]) if (R[k]) { fail++; console.error(`FAIL  장면이 던졌다(${k}) — ${R[k].split("\n")[0]}`); }
const a = R.a || {}, m = R.m || {}, r = R.r || {}, h = R.h || {}, i = R.i || {}, d = R.d || {};

check(J(a.store0) === J({ bottom: [], act: null, seeded: { tasks: 1, bottom: 1 } }) && down(a.b0), "A1 처음 쓰는 브라우저: 아래 칸은 비고 숨었다 · 옛 기본 걷기 표식", { store: a.store0, b: a.b0 });
check(a.clickOpen && a.pickHead === "아래 칸에 넣기" && down(a.b1), "A2 «아래 칸 열기» — 비었으면 빈 칸을 펴지 않고 넣을 것부터 고른다", { head: a.pickHead, b: a.b1 });
check(a.picked && up(a.b2) && J(a.bottomTabs2) === J(["타임라인"]), "A3 고른 것이 아래 칸에 서야 아래 칸이 열린다", { b: a.b2, tabs: a.bottomTabs2 });
check(down(a.b3) && a.reopenHead === null && up(a.b4), "A4 ✕ 로 닫은 뒤 «아래 칸 열기» — 내용이 있으니 고르기 없이 연다", { closed: a.b3, head: a.reopenHead, b: a.b4 });
check(down(a.b5) && a.emptyHead === "아래 칸에 넣기", "A5 마지막 탭을 닫으면 빈 칸이 남지 않고, 다시 열기는 고르기부터", { b: a.b5, head: a.emptyHead });
check(Array.isArray(a.footVisible) && !a.footVisible.includes("아래 칸 열기") && a.footVisible.includes("기본 배치로"), "A6 아래 칸이 보이는 동안 «아래 칸 열기» 가 없다", a.footVisible);
check(!!a.reset && down(a.reset.b) && J(a.reset.bottom) === "[]" && J(a.reset.side) === J(["자료", "프로젝트", "지식", "앱"]), "A7 «기본 배치로 되돌리기» — 아래 칸이 비고 숨는다", a.reset);
check(down(a.remembered) && a.sendRow && !!a.afterSend && up(a.afterSend.b) && J(a.afterSend.bottom) === J(["지식"]), "A8 다른 세션의 «열림» 기억 + 빈 내용 → 안 올라온다 · «아래 칸으로 보내기» 하면 그 순간 선다", { remembered: a.remembered, send: a.afterSend });
check(!!m.store && J(m.store.last) === "[]" && J(m.store.p7) === "[]" && J(m.store.p8) === J(["timeline"]) && m.store.seeded?.bottom === 1 && J(m.store.side) === J(["files", "knowledge", "apps"]), "M1 옛 기본을 걷는다 — 열린 프로젝트(p8)는 그대로 · 곁칸은 손대지 않는다", m.store);
check(down(m.b), "M2 이 세션이 «열림» 을 기억해도 걷은 뒤엔 아무것도 안 올라온다", m.b);
check(m.same === true && J(m.afterMarker) === J(["timeline"]) && !!m.p8 && up(m.p8.b) && J(m.p8.tabs) === J(["타임라인"]), "M3 한 번 걷으면 저장소를 다시 쓰지 않는다 · 표식 뒤 둔 타임라인 · 열린 p8 은 그대로", { same: m.same, afterMarker: m.afterMarker, p8: m.p8 });
check(r.in === "자료/docs" && r.R1 === "자료" && r.R1back === "자료/docs", "R1 켜진 자료 탭을 다시 누르면 맨 위 폴더 · «뒤로» 로 하위 폴더에 돌아간다", { in: r.in, R1: r.R1, back: r.R1back });
check(r.scrolled > 0 && !!r.R2 && r.R2.top === 0 && r.R2.crumb === "자료", "R2 이미 맨 위면 목록만 맨 위로(폴더 그대로)", { scrolled: r.scrolled, R2: r.R2 });
check(!!r.R3 && r.R3.act === "자료" && r.R3.crumb === "자료/docs", "R3 다른 탭에서 자료 탭으로 돌아오면 보던 폴더 그대로", r.R3);
check(r.in4 === "자료/docs" && r.R4 === "자료/docs", "R4 끌고 놓은 뒤의 click 은 «다시 누르기» 가 아니다", { in: r.in4, R4: r.R4 });
check(r.R7 === "프로젝트", "R7 «처음으로» 가 없는 탭은 다시 눌러도 켜진 채 그대로", r.R7);
check(h.H1 === "자료", "H1 머리줄 [자료] — 보이고 켜져 있으면 맨 위 폴더", h.H1);
check(h.collapsed === true && !!h.H2a && h.H2a.side && h.H2a.crumb === "자료/docs" && !!h.H2b && h.H2b.act === "자료" && h.H2b.crumb === "자료/docs", "H2 곁칸이 접혀 있거나 다른 탭이 켜져 있으면 보이게만(폴더 그대로)", { a: h.H2a, b: h.H2b });
check(i.count === 2 && i.first === "자료" && i.second === "자료/docs", "I1 자료가 둘이면 누른 탭의 자료만 맨 위로", i);
const WANT = ["자료", "세션 파일", "지식", "프로젝트", "타임라인", "리브", "지난 세션", "웹", "미리보기", "앱"];
check(J(d.sideTabs) === J(["자료"]) && !!d.open && d.open.has && d.open.focus && d.open.top >= 0 && d.open.top <= 12 && d.open.inPane, "AD1 [＋] = 앱 서랍 — [＋] 바로 아래 · 곁칸 안 · 열리면 검색칸에 초점", d.open);
check(Array.isArray(d.tiles) && J(d.tiles.map((t) => t.n)) === J(WANT) && d.tiles.every((t) => t.gi) && d.tiles.filter((t) => t.plus).map((t) => t.n).join() === "자료"
  && d.tiles[0].sel && d.tiles.filter((t) => t.sel).length === 1 && /^자료 하나 더/.test(d.desc0 || ""), "AD2 타일 열 개 — 독과 같은 앱 색 타일 · 이미 열린 자료엔 ＋ · 첫 타일이 Enter 의 과녁 · 설명 한 줄", { tiles: d.tiles, desc: d.desc0 });
check(d.noNewTab === true, "AD3 «새 탭으로 여는 앱» 이 없다 — 여기서 여는 것은 모두 사이드바에 선다");
check(!!d.typed && J(d.typed.tiles) === J(["타임라인*"]) && /^타임라인/.test(d.typed.desc || "") && !!d.entered && d.entered.closed && d.entered.tabs.includes("타임라인") && d.entered.act === "타임라인",
  "AD4 치면 거르고 Enter 로 연다 — 그 칸에 탭 · 서랍 닫힘", { typed: d.typed, entered: d.entered });
check(d.imeKept === true, "AD5 한글 조합 중의 Enter 는 열지 않는다(글자 확정)");
check(!!d.none && d.none.tiles === 0 && d.none.desc === "「zzz」에 맞는 앱이 없어요.", "AD6 없는 이름 — 타일 없이 안내 한 줄", d.none);
check(!!d.arrows && d.arrows.first === "자료" && d.arrows.now === "세션 파일" && /^세션 파일/.test(d.arrows.desc || "") && d.backToInput === true, "AD7 ↓ 로 타일에 들어가 → 로 옮기면 설명이 따라간다 · 첫 줄에서 ↑ 면 검색칸", { arrows: d.arrows, back: d.backToInput });
check(/^웹/.test(d.hover || "") && !!d.more && d.more.closed && d.more.tabs.includes("자료 2"), "AD8 올리면 그 앱의 설명 · 이미 열린 자료를 누르면 «자료 2» 가 선다", { hover: d.hover, more: d.more });
check(d.esc === true, "AD9 Esc 로 닫힌다");
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "E1 페이지 오류 없음(마운트 · 그리기)", R.pageErrors);

console.log(fail ? `\n${fail}건 실패 · ${pass}건 통과` : `\n${pass}건 통과`);
process.exit(fail ? 1 : 0);
