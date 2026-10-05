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
//  ★ 아래 칸에는 새로 열지 않는다(원준 10-05 «아래칸에 여는거 우리 안하기로 했잖음») — [＋] · 탭 우클릭 · 빈 자리 메뉴 어디에도 길이 없다.
//  A1 처음 쓰는 브라우저: 아래 칸은 비고 숨었다(경계선 · no-bottom 까지) · 기본 곁칸 = 자료 · 프로젝트 · 지식(«앱» 없음) · 한 번 걷기 표식 셋
//  A2 [＋] 발치엔 «기본 배치로» 만 — «아래 칸 열기» 가 없다
//  A3 탭 우클릭에 «아래 칸으로 보내기» 가 없다
//  A4 옛 배치(아래 칸에 사람이 둔 탭)는 그대로 보이되 그 탭 줄엔 [＋] 가 없다
//  A5 아래 칸의 옛 탭은 우클릭으로 곁칸에 보낼 수 있다 · A6 마지막 탭을 닫으면 빈 칸이 남지 않는다
//  A7 «기본 배치로» — 아래 칸이 비고 숨는다 · 곁칸 = 자료 · 프로젝트 · 지식
//  A8 다른 세션이 «열림» 을 기억해도 내용이 비었으면 빈 칸이 올라오지 않는다
//  ★ 아래 칸은 줄기만 한다(같은 말 · lib landZone) — 옛 배치에 남은 아래 칸이 보일 때 닿던 남은 길도 새 탭을 곁칸에 세운다.
//  B0 (배선) 옛 배치 — 아래 칸에 타임라인 · 웹 · 뷰어가 보인다(아래 행들이 헛돌지 않는다)
//  B1 아래 칸 «웹» 탭 우클릭 › «웹 하나 더» — 새 웹 탭은 곁칸에 서고 켜진다 · 아래 칸 그대로
//  B2 곁칸 탭(지식)을 끌어 아래 칸 탭 줄에 놓아도 아무 일 없다(놓기 표시도 안 뜬다) · B2w (배선) 아래 칸 «웹» 을 끌어 곁칸에 놓으면 옮겨진다
//  B3 열린 아래 칸에 뷰어(readme.md)가 있을 때 다른 파일을 열면 새 뷰어는 곁칸 · B3b 같은 파일을 다시 열면 아래 칸의 그 뷰어를 켠다(새 탭 없음)
//  B4 아래 칸에서 닫은 탭을 «닫은 탭 다시 열기» 하면 곁칸 맨 끝으로 돌아온다 · B4b 마지막 탭(경계)이면 아래 칸은 다시 서지 않는다
//  B3c 닫힌 아래 칸에 그 파일의 뷰어가 있으면 펼치지 않고 곁칸으로 데려와 켠다
//  B5 다시 열 탭과 같은 파일의 뷰어가 닫힌 아래 칸에 있으면 — 아래 칸을 펼치지 않고 그 뷰어를 곁칸으로 데려와 켠다(격리 리뷰)
//  B6 배치를 저장한 적 없는 프로젝트가 옛 아래 칸이 있는 배치를 물려받으면 — 아래 칸은 서지 않고 그 탭은 곁칸 뒤에 선다(격리 리뷰)
//  N1 좁은 폭(서랍) — 아래 칸에 뷰어만 있을 때 다른 파일을 열어도 저장된 아래 칸은 그대로, 새 뷰어는 곁칸 배치에 적힌다
//  M1 옛 기본(닫힌 아래 칸에 타임라인 하나)을 걷는다 — 열린 프로젝트(p8)는 그대로 · «앱» 탭도 한 번 걷는다(원준 10-05 «기본배치 아니게»)
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
//  AD2 묶음 둘(원준 10-05 «세션에 붙인다는 개념으로 두개 나눈건 … 살려줘») — «사이드바 앱» 아홉(독과 같은 앱 색 타일 · 이미 열린 자료엔 ＋
//      · 첫 타일이 Enter 의 과녁 · 설명 한 줄) + «이 세션에 붙이기»(화면 · 데이터가 있는 설치 앱 — 시스템 · ai-session · 도구만 · 꺼짐 제외,
//      세션이 없으면 흐리고 고를 수 없다)
//  AD3 «새 탭으로 여는 앱» 도, «앱» 칸도 없다 — 여기서 여는 것은 모두 사이드바에 선다
//  AD4 치면 거르고 Enter 로 연다(그 칸에 탭 · 서랍 닫힘) · AD5 한글 조합 중의 Enter 는 열지 않는다 · AD6 없는 이름 — 타일 0 · 안내 한 줄
//  AD7 ↓ 로 타일에 들어가 → 로 옮기면 설명이 따라간다 · 첫 줄에서 ↑ 면 검색칸 · AD8 올리면 설명 · 이미 열린 자료를 누르면 «자료 2» · AD9 Esc 로 닫힌다
//  T1 세션이 있으면 «이 세션에 붙이기» 타일을 고를 수 있고, 누르면 그 세션에 붙이기 요청(POST …/apps/attach {app_id})이 나가고 서랍이 닫힌다
//  E1 페이지 오류 없음(그리는 중에 던진 것). 마운트 자체가 던지면(TDZ 등) 그 장면이 «장면이 던졌다» 로 실패한다
//
//  fail-first(2026-10-01): 변경 전 판(SRC_ROOT 로 cc81bfd7~1 을 세움)에서 A1–A3 · A5 · A7 · A8 · M1 · M2 · R1 · R2 · H1 · H2 · I1 빨강,
//   paintPane 의 `pane.act = act;` 를 지운 돌연변이에서 R1 · R2 · H1 · H2 · I1 빨강(소스 정규식 X 행은 그대로 초록이던 고리),
//   bottomVisible 을 첫 paintAll 아래로 옮긴 돌연변이에서 마운트가 던져 모든 장면 빨강(S11 도 함께).
//  fail-first(2026-10-05 앱 서랍): 바꾸기 전 판(옛 고르기)에서 AD1–AD9 빨강. 돌연변이 — 한글 조합 중 Enter 막기를 빼면 AD4 · AD5,
//   격자 화살표를 빼면 AD7, ＋(하나 더) 배지를 빼면 AD2 가 빨갛다.
//  fail-first(2026-10-05 두 묶음 · 아래 칸 · «앱» 탭): 바꾸기 전 판에서 A1–A4 · A7 · M1 · AD2 · AD2b · AD3 · T1 빨강(A5 · A6 · A8 은 원래 그랬다).
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
  //  설치 앱 — 붙일 수 있는 것은 화면(ui.pages)이나 데이터(data.tables)가 있는 것. 나머지는 묶음에 서면 안 된다.
  const APPS = [
    { id: "memo", title: "메모", status: "active", manifest: { ui: { pages: [{ key: "main", title: "메모" }] } } },
    { id: "check", title: "보고서 점검표", status: "active", manifest: { data: { tables: [{ name: "checks" }] } } },
    { id: "ai-session", title: "AI 세션", status: "active", manifest: { ui: { pages: [{ key: "m" }] } } },
    { id: "sys", title: "시스템 앱", status: "active", source: { kind: "builtin" }, manifest: { system: "inbox", ui: { pages: [{ key: "m" }] } } },
    { id: "tool", title: "도구만", status: "active", manifest: { permissions: { tools: ["t"] } } },
    { id: "off", title: "꺼진 앱", status: "disabled", manifest: { ui: { pages: [{ key: "m" }] } } },
  ];
  window.__attach = [];
  window.fetch = async (url, init) => {
    const u = new URL(url, "http://x/");
    if (u.pathname === "/api/ui/apps") return J({ apps: APPS });
    const sa = /^\/api\/ui\/terminal\/sessions\/([^/]+)\/apps(\/attach)?$/.exec(u.pathname);
    if (sa && sa[2] && (init?.method || "GET") === "POST") { window.__attach.push({ sid: decodeURIComponent(sa[1]), body: JSON.parse(init.body || "{}") }); return J({ ok: true }); }
    if (sa && !sa[2]) return J({ apps: [] });
    const mm = /\/projects\/(\d+)(\/.*)?$/.exec(u.pathname);
    if (mm && mm[2] === "/files") { const q = u.searchParams.get("path") || ""; return J({ items: kids(q).map((p) => { const e = FS.get(p); return { name: p.split("/").pop(), type: e.type, size: e.size, mtime: e.mtime }; }) }); }
    if (mm && !mm[2]) return J({ project: { id: Number(mm[1]), name: "P", status_category: "started" } });
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(e) { setTimeout(() => this.cb([{ target: e, isIntersecting: true }]), 0); } unobserve() {} disconnect() {} };

  let handle = null;
  const mount = async (id = 7, sid = null) => {
    if (handle) { try { handle.destroy(); } catch (_) { /* 이미 */ } handle = null; }
    document.getElementById("app")?.remove();
    const host = document.createElement("div");
    host.id = "app"; host.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;display:flex;flex-direction:column;background:var(--bg)";
    document.body.append(host);
    const PN = (new Function(SRC + "\n;return PN;"))();
    handle = PN.mountPanes(host, { id, detail: { project: { id, name: "P" } }, data: () => ({ projects: [{ id, name: "P" }], sessions: [], loadedAt: Date.now() }), sessionId: sid, onOpenDrawer: () => {}, onCloseDrawer: () => {} });
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
  const fresh = () => { for (const k of [LAYOUT, VIEW, "pn_act_by_sess", "pn_ed_path"]) localStorage.removeItem(k); seedFs(); };   // 장면끼리 기억을 물려주지 않는다

  // ── A — 처음 쓰는 브라우저 · 아래 칸에는 새로 열지 않는다 ──
  try {
    fresh(); await mount();
    const a = {}; R.a = a;
    const s0 = store(); a.store0 = { bottom: s0?.last?.bottom ?? null, act: s0?.last?.act?.bottom ?? null, seeded: s0?.seeded || null };
    a.b0 = bottomUp(); a.side0 = tabNames("side");
    await openAdd(); a.foot0 = popFoot(); popClose();
    const menuOf = async (z, nm) => { tabBtn(z, nm).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })); await sleep(80); return $$(".pn-ctx .pn-ctx-i, .pn-ctx button").filter((b) => b.textContent.trim()); };
    a.menu = (await menuOf("side", "지식")).map((b) => b.textContent.trim());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(60);
    //  옛 배치 — 아래 칸에 사람이 둔 탭(이 판 전에 둔 것)
    const legacy = { main: ["sessions"], side: ["files", "knowledge"], bottom: ["timeline", "web"], act: { main: "sessions", side: "files", bottom: "timeline" }, sideOn: true, bottomOn: true, pin: [] };
    localStorage.setItem(LAYOUT, JSON.stringify({ last: legacy, p: { 7: legacy }, seeded: { tasks: 1, bottom: 1, apps: 1 } })); localStorage.removeItem(VIEW);
    await mount();
    a.legacy = { b: bottomUp(), add: !!$('#app .pn-pane[data-zone="bottom"] .pn-tab-add'), tabs: tabNames("bottom") };
    const send = (await menuOf("bottom", "웹")).find((b) => /로 보내기/.test(b.textContent));
    a.sendLabel = send ? send.textContent.trim() : null;
    if (send) { send.click(); await sleep(150); }
    a.afterSend = { side: tabNames("side"), bottom: tabNames("bottom"), b: bottomUp() };
    tabBtn("bottom", "타임라인").parentElement.querySelector(".pn-tab-x").click(); await sleep(120);
    a.lastClosed = bottomUp();
    await openAdd(); await clickFoot("기본 배치로"); await sleep(150);
    const sr = store(); a.reset = { b: bottomUp(), bottom: sr.last.bottom, side: tabNames("side") };
    localStorage.setItem(VIEW, JSON.stringify({ p7: { bottomOn: true } }));          // 다른 세션의 «열림» 기억 + 빈 내용
    await mount(); a.remembered = bottomUp();
  } catch (e) { R.errA = String(e && e.stack || e); }

  // ── B — 아래 칸은 줄기만 한다(원준 10-05 «아래칸에 여는거 우리 안하기로 했잖음») ──
  try {
    fresh();
    const legacy = { main: ["sessions"], side: ["files", "knowledge"], bottom: ["timeline", "web", "editor"], act: { main: "sessions", side: "files", bottom: "web" }, sideOn: true, bottomOn: true, pin: [] };
    localStorage.setItem(LAYOUT, JSON.stringify({ last: legacy, p: { 7: legacy }, seeded: { tasks: 1, bottom: 1, apps: 1 } })); localStorage.removeItem(VIEW);
    localStorage.setItem("pn_ed_path", JSON.stringify({ p7: "readme.md" }));       // 아래 칸의 뷰어가 펴 둔 파일(세션 없음 → 기억 열쇠 p7)
    await mount();
    const b = {}; R.b = b;
    const keys = (z) => $$(`#app .pn-pane[data-zone="${z}"] .pn-tabwrap`).map((w) => w.dataset.tab);
    const actKey = (z) => $$(`#app .pn-pane[data-zone="${z}"] .pn-tabwrap`).find((w) => w.querySelector('.pn-tab[aria-selected="true"]'))?.dataset.tab || null;
    const wrapOf = (z, k) => $(`#app .pn-pane[data-zone="${z}"] .pn-tabwrap[data-tab="${k}"]`);
    const menuKey = async (z, k) => { popClose(); wrapOf(z, k).querySelector(".pn-tab").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); await sleep(80); return $$(".pn-ctx .pn-ctx-i, .pn-ctx button").filter((x) => x.textContent.trim()); };
    const pick = async (z, k, re) => { const it = (await menuKey(z, k)).find((x) => re.test(x.textContent.trim())); if (it) { it.click(); await sleep(150); } else popClose(); return !!it; };
    const snap = () => ({ side: keys("side"), bottom: keys("bottom"), actSide: actKey("side"), actBottom: actKey("bottom"), up: bottomUp() });
    b.start = snap();
    //  B1 «하나 더» — 아래 칸의 옛 웹 탭에서
    b.moreItem = await pick("bottom", "web", /^웹 하나 더$/);
    b.B1 = snap();
    //  B3 뷰어 — 아래 칸에 readme.md 뷰어가 있다
    //  stage 판엔 #4135(파일마다 뷰어 하나)가 없다 — 다른 파일도 보던 뷰어에 편다. 새 뷰어는 newTab 으로만 선다.
    const viewer = (p, newTab) => { $("#app .pn-wrap").dispatchEvent(new CustomEvent("pn-viewer-open", { detail: { path: p, ...(newTab ? { newTab: true } : {}) } })); return sleep(200); };
    await viewer("notes.txt", true); b.B3 = snap();
    await viewer("readme.md"); b.B3b = snap();
    //  B2 끌기 — 포인터로(R4 와 같은 손). 곁칸 → 아래 칸 줄(막힘), 아래 칸 → 곁칸 줄(된다)
    const dragTo = async (z, k, toZone) => {
      const w = wrapOf(z, k); const r0 = w.getBoundingClientRect(); const bar = $(`#app .pn-pane[data-zone="${toZone}"] .pn-tabs`).getBoundingClientRect();
      const P = (type, x, y) => (type === "pointerdown" ? w.querySelector(".pn-tab") : window).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 7, pointerType: "mouse" }));
      const x0 = r0.left + r0.width / 2, y0 = r0.top + r0.height / 2, x1 = bar.left + Math.min(40, bar.width / 2), y1 = bar.top + bar.height / 2;
      P("pointerdown", x0, y0); P("pointermove", x0 + 8, y0 + 30); P("pointermove", (x0 + x1) / 2, (y0 + y1) / 2); P("pointermove", x1, y1); await sleep(30);
      const lit = !!$(`#app .pn-pane[data-zone="${toZone}"] .pn-tabbar.drop`);
      P("pointerup", x1, y1); await sleep(150);
      return lit;
    };
    b.litToBottom = await dragTo("side", "knowledge", "bottom"); b.B2 = snap();
    b.litToSide = await dragTo("bottom", "web", "side"); b.B2w = snap();
    //  B4 닫은 탭 다시 열기 — 아래 칸의 타임라인을 닫고 되살린다
    wrapOf("bottom", "timeline").querySelector(".pn-tab-x").click(); await sleep(150); b.B4closed = snap();
    b.reopen1 = await pick("side", "files", /^닫은 탭 다시 열기/); b.B4 = snap();
    //  B4b 마지막 탭 — 아래 칸에 남은 뷰어 하나를 닫으면 칸이 사라지고, 되살려도 곁칸이다
    const lastKey = keys("bottom")[0]; b.lastKey = lastKey;
    if (lastKey) { wrapOf("bottom", lastKey).querySelector(".pn-tab-x").click(); await sleep(150); }
    b.B4bClosed = snap();
    b.reopen2 = await pick("side", "files", /^닫은 탭 다시 열기/); b.B4b = snap();
    const plant = async (lay, ed, id = 7) => {
      fresh(); localStorage.setItem(LAYOUT, JSON.stringify({ last: lay, p: { [id]: lay }, seeded: { tasks: 1, bottom: 1, apps: 1 } }));
      localStorage.setItem("pn_ed_path", JSON.stringify(ed)); await mount(id);
    };
    //  B3c 닫힌 아래 칸에 readme.md 뷰어 — 같은 파일을 연다
    await plant({ main: ["sessions"], side: ["files"], bottom: ["timeline", "editor"], act: { main: "sessions", side: "files", bottom: "timeline" }, sideOn: true, bottomOn: false, pin: [] }, { p7: "readme.md" });
    b.B3c0 = snap(); await viewer("readme.md"); b.B3c = snap();
    //  B5 같은 파일(notes.txt)의 뷰어가 곁칸(editor#2)과 닫힌 아래 칸(editor)에 하나씩 — 곁칸 것을 닫고 되살린다
    await plant({ main: ["sessions"], side: ["files", "editor#2"], bottom: ["timeline", "editor"], act: { main: "sessions", side: "files", bottom: "timeline" }, sideOn: true, bottomOn: false, pin: [] }, { p7: "notes.txt", "p7#2": "notes.txt" });
    b.B50 = snap();
    wrapOf("side", "editor#2").querySelector(".pn-tab-x").click(); await sleep(150);
    b.reopen5 = await pick("side", "files", /^닫은 탭 다시 열기/); b.B5 = snap();
    //  B6 새 프로젝트(9) — last 에 옛 아래 칸이 있다
    fresh();
    const old7 = { main: ["sessions"], side: ["files", "knowledge"], bottom: ["timeline", "web"], act: { main: "sessions", side: "files", bottom: "web" }, sideOn: true, bottomOn: true, pin: [] };
    localStorage.setItem(LAYOUT, JSON.stringify({ last: old7, p: { 7: old7 }, seeded: { tasks: 1, bottom: 1, apps: 1 } }));
    await mount(9); b.B6 = snap(); await clk(tabBtn("side", "지식")); const s6 = store(); b.B6store = { p9: s6.p && s6.p[9] ? s6.p[9].bottom : null, p7: s6.p[7].bottom };
    //  N1 좁은 폭 — 모바일 질의만 맞다고 답한다(셸은 matchMedia(MOBILE_MQ) 로 좁은 폭을 안다)
    const realMM = window.matchMedia.bind(window);
    window.matchMedia = (q) => (/max-width/.test(q) ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } } : realMM(q));
    try {
      await plant({ main: ["sessions"], side: ["files"], bottom: ["timeline", "editor"], act: { main: "sessions", side: "files", bottom: "timeline" }, sideOn: true, bottomOn: true, pin: [] }, { p7: "readme.md" });
      b.N1narrow = handle && $$("#app .pn-pane[data-zone=\"side\"] .pn-tabwrap").some((w) => w.dataset.tab === "timeline");   // 서랍이 아래 칸 탭까지 든다 = 좁은 폭으로 섰다
      await viewer("notes.txt", true); const sn = store(); b.N1 = { bottom: sn.p[7].bottom, side: sn.p[7].side };   // stage 판: 새 뷰어는 newTab 으로만(#4135 없음)
    } finally { window.matchMedia = realMM; }
  } catch (e) { R.errB = String(e && e.stack || e); }

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
    await waitFor(() => !$(DR + " .pn-adraw-wait"));                              // «이 세션에 붙이기» 목록이 온다
    const info = (t) => ({ n: t.querySelector(".pn-dock-tile-n").textContent, plus: !!t.querySelector(".pn-adraw-plus"), sel: t.getAttribute("aria-selected") === "true", off: t.disabled,
      gi: !!t.querySelector('svg.v2-gi .v2-gi-glyph[stroke^="var(--gi-c-"]') });
    const tiles = () => $$(DR + " .pn-dock-tile:not([disabled])").map(info);
    d.secs = $$(DR + " .pn-dock-more-sec").map((sec) => ({ t: sec.querySelector(".pn-dock-more-sh b").textContent, note: sec.querySelector(".pn-dock-more-sh .pn-fine").textContent, tiles: [...sec.querySelectorAll(".pn-dock-tile")].map(info) }));
    d.desc0 = descNow();
    d.noNewTab = !!dr && !dr.querySelector("a") && !/새 탭으로/.test(dr.textContent) && !tileOf("앱");
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

  // ── T — 세션이 있으면 «이 세션에 붙이기» 를 고른다 ──
  try {
    fresh(); await mount(7, "s1");
    const t = {}; R.t = t;
    await openAdd(); await waitFor(() => !$(DR + " .pn-adraw-wait"));
    const memo = tileOf("메모");
    t.enabled = !!memo && !memo.disabled;
    t.note = ($$(DR + " .pn-dock-more-sec")[1]?.querySelector(".pn-dock-more-sh .pn-fine") || {}).textContent || null;
    memo?.dispatchEvent(new MouseEvent("mouseenter")); await sleep(20); t.desc = descNow();
    memo?.click(); await sleep(250);
    t.closed = !$(DR); t.calls = window.__attach.slice();
  } catch (e) { R.errT = String(e && e.stack || e); }

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
for (const k of ["errA", "errB", "errM", "errR", "errH", "errI", "errD", "errT", "fatal"]) if (R[k]) { fail++; console.error(`FAIL  장면이 던졌다(${k}) — ${R[k].split("\n")[0]}`); }
const a = R.a || {}, b = R.b || {}, m = R.m || {}, r = R.r || {}, h = R.h || {}, i = R.i || {}, d = R.d || {}, t = R.t || {};

check(J(a.store0) === J({ bottom: [], act: null, seeded: { tasks: 1, bottom: 1, apps: 1 } }) && down(a.b0) && J(a.side0) === J(["자료", "프로젝트", "지식"]), "A1 처음 쓰는 브라우저: 아래 칸은 비고 숨었다 · 기본 곁칸에 «앱» 이 없다 · 한 번 걷기 표식", { store: a.store0, b: a.b0, side: a.side0 });
check(J(a.foot0) === J(["기본 배치로"]), "A2 [＋] 발치엔 «기본 배치로» 만 — «아래 칸 열기» 가 없다", a.foot0);
check(Array.isArray(a.menu) && a.menu.some((x) => /닫기/.test(x)) && !a.menu.some((x) => /아래 칸으로/.test(x)), "A3 탭 우클릭에 «아래 칸으로 보내기» 가 없다", a.menu);
check(!!a.legacy && up(a.legacy.b) && a.legacy.add === false && J(a.legacy.tabs) === J(["타임라인", "웹"]), "A4 옛 배치의 아래 칸 탭은 그대로 보이되 그 탭 줄엔 [＋] 가 없다", a.legacy);
check(/사이드바로 보내기$/.test(a.sendLabel || "") && !!a.afterSend && a.afterSend.side.includes("웹") && J(a.afterSend.bottom) === J(["타임라인"]) && up(a.afterSend.b), "A5 아래 칸의 옛 탭은 우클릭으로 곁칸에 보낼 수 있다", { label: a.sendLabel, after: a.afterSend });
check(down(a.lastClosed), "A6 아래 칸의 마지막 탭을 닫으면 빈 칸이 남지 않는다", a.lastClosed);
check(!!a.reset && down(a.reset.b) && J(a.reset.bottom) === "[]" && J(a.reset.side) === J(["자료", "프로젝트", "지식"]), "A7 «기본 배치로» — 아래 칸이 비고 숨는다 · 곁칸 = 자료 · 프로젝트 · 지식", a.reset);
check(down(a.remembered), "A8 다른 세션의 «열림» 기억 + 빈 내용 → 아무것도 안 올라온다", a.remembered);
const B0 = ["timeline", "web", "editor"];
check(!!b.start && J(b.start.bottom) === J(B0) && up(b.start.up) && J(b.start.side) === J(["files", "knowledge"]), "B0 (배선) 옛 배치 — 아래 칸에 타임라인 · 웹 · 뷰어가 보인다", b.start);
check(b.moreItem === true && !!b.B1 && J(b.B1.bottom) === J(B0) && J(b.B1.side) === J(["files", "knowledge", "web#2"]) && b.B1.actSide === "web#2", "B1 아래 칸 «웹 하나 더» — 새 웹 탭은 곁칸에 서고 켜진다 · 아래 칸 그대로", { item: b.moreItem, B1: b.B1 });
check(!!b.B3 && J(b.B3.bottom) === J(B0) && b.B3.side.length === 4 && /^editor#\d+$/.test(b.B3.side[3]) && b.B3.actSide === b.B3.side[3], "B3 열린 아래 칸에 뷰어가 있어도 다른 파일의 새 뷰어는 곁칸에 선다", b.B3);
check(!!b.B3b && J(b.B3b.bottom) === J(B0) && J(b.B3b.side) === J(b.B3 && b.B3.side), "B3b 새 탭이 아니면 보던 뷰어에 편다 — 새 탭 없음 · 아래 칸 그대로(stage 판: #4135 없음)", b.B3b);
check(b.litToBottom === false && !!b.B2 && J(b.B2.bottom) === J(B0) && b.B2.side.includes("knowledge"), "B2 곁칸 탭을 끌어 아래 칸 줄에 놓아도 아무 일 없다 — 놓기 표시도 안 뜬다", { lit: b.litToBottom, B2: b.B2 });
check(b.litToSide === true && !!b.B2w && J(b.B2w.bottom) === J(["timeline", "editor"]) && b.B2w.side.includes("web"), "B2w (배선) 아래 칸의 옛 탭은 끌어서 곁칸으로 옮길 수 있다 — 끌기 장치가 실제로 돈다", { lit: b.litToSide, B2w: b.B2w });
check(!!b.B4closed && J(b.B4closed.bottom) === J(["editor"]) && b.reopen1 === true && !!b.B4 && J(b.B4.bottom) === J(["editor"]) && b.B4.side.at(-1) === "timeline" && b.B4.actSide === "timeline",
  "B4 아래 칸에서 닫은 탭을 다시 열면 곁칸 맨 끝으로 돌아온다 · 아래 칸 다른 탭 그대로", { closed: b.B4closed, B4: b.B4 });
check(b.lastKey === "editor" && !!b.B4bClosed && down(b.B4bClosed.up) && b.reopen2 === true && !!b.B4b && J(b.B4b.bottom) === "[]" && down(b.B4b.up) && b.B4b.side.at(-1) === "editor" && b.B4b.actSide === "editor",
  "B4b 마지막 탭(경계)을 닫고 다시 열어도 아래 칸은 다시 서지 않는다 — 곁칸 맨 끝으로", { closed: b.B4bClosed, B4b: b.B4b });
check(!!b.B3c0 && J(b.B3c0.side) === J(["files"]) && down(b.B3c0.up) && !!b.B3c && J(b.B3c.bottom) === J(["timeline"]) && down(b.B3c.up) && J(b.B3c.side) === J(["files", "editor"]) && b.B3c.actSide === "editor",
  "B3c 닫힌 아래 칸에 그 파일의 뷰어가 있으면 펼치지 않고 그 뷰어만 곁칸으로 데려와 켠다(남은 타임라인은 닫힌 칸에 그대로)", { before: b.B3c0, after: b.B3c });
check(!!b.B50 && J(b.B50.side) === J(["files", "editor#2"]) && b.reopen5 === true && !!b.B5 && down(b.B5.up) && J(b.B5.bottom) === J(["timeline"]) && b.B5.side.includes("editor") && b.B5.actSide === "editor" && !b.B5.side.includes("editor#2"),
  "B5 다시 열 탭과 같은 파일의 뷰어가 닫힌 아래 칸에 있으면 — 펼치지 않고 그 뷰어를 곁칸으로 데려와 켠다", { before: b.B50, after: b.B5 });
check(!!b.B6 && down(b.B6.up) && J(b.B6.bottom) === "[]" && J(b.B6.side) === J(["files", "knowledge", "timeline", "web"]) && !!b.B6store && J(b.B6store.p9) === "[]" && J(b.B6store.p7) === J(["timeline", "web"]),
  "B6 저장한 적 없는 프로젝트가 옛 아래 칸을 물려받으면 — 아래 칸은 서지 않고 그 탭은 곁칸 뒤에 · 원래 프로젝트(p7)는 그대로", { ui: b.B6, store: b.B6store });
check(b.N1narrow === true && !!b.N1 && J(b.N1.bottom) === J(["timeline", "editor"]) && b.N1.side.length === 2 && /^editor#\d+$/.test(b.N1.side[1]),
  "N1 좁은 폭 — 저장된 아래 칸은 그대로, 새 뷰어는 곁칸 배치에 적힌다", { narrow: b.N1narrow, N1: b.N1 });
check(!!m.store && J(m.store.last) === "[]" && J(m.store.p7) === "[]" && J(m.store.p8) === J(["timeline"]) && m.store.seeded?.bottom === 1 && J(m.store.side) === J(["files", "knowledge"]) && m.store.seeded?.apps === 1, "M1 옛 기본을 걷는다 — 열린 프로젝트(p8)는 그대로 · «앱» 탭도 한 번 걷는다", m.store);
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
//  stage 판엔 부품의 pickable(#4135 — 뷰어는 파일에서만 열린다)이 없어 뷰어도 고를 수 있다 — main 은 아홉.
const WANT = ["자료", "세션 파일", "지식", "프로젝트", "타임라인", "리브", "지난 세션", "웹", "미리보기", "뷰어"];
check(J(d.sideTabs) === J(["자료"]) && !!d.open && d.open.has && d.open.focus && d.open.top >= 0 && d.open.top <= 12 && d.open.inPane, "AD1 [＋] = 앱 서랍 — [＋] 바로 아래 · 곁칸 안 · 열리면 검색칸에 초점", d.open);
const s1 = (d.secs || [])[0] || { tiles: [] }, s2 = (d.secs || [])[1] || { tiles: [] };
check(J((d.secs || []).map((x) => x.t)) === J(["사이드바 앱"]) && J(s1.tiles.map((x) => x.n)) === J(WANT) && s1.tiles.every((x) => x.gi && !x.off)
  && s1.tiles.filter((x) => x.plus).map((x) => x.n).join() === "자료" && s1.tiles[0].sel && s1.tiles.filter((x) => x.sel).length === 1 && /^자료 하나 더/.test(d.desc0 || ""),
  "AD2 묶음 둘 — «사이드바 앱» 아홉(독과 같은 타일 · 이미 열린 자료엔 ＋ · 첫 타일이 Enter 의 과녁 · 설명 한 줄)", { secs: d.secs && d.secs.map((x) => [x.t, x.tiles.map((y) => y.n + (y.plus ? "+" : "") + (y.sel ? "*" : "") + (y.off ? "~" : ""))]), desc: d.desc0 });
console.log("skip  AD2b «이 세션에 붙이기» — stage 판엔 붙은 앱(#4225)이 아직 없다(main 에서 잰다)");
check(d.noNewTab === true, "AD3 «새 탭으로 여는 앱» 도, «앱» 칸도 없다 — 여기서 여는 것은 모두 사이드바에 선다");
check(!!d.typed && J(d.typed.tiles) === J(["타임라인*"]) && /^타임라인/.test(d.typed.desc || "") && !!d.entered && d.entered.closed && d.entered.tabs.includes("타임라인") && d.entered.act === "타임라인",
  "AD4 치면 거르고 Enter 로 연다 — 그 칸에 탭 · 서랍 닫힘", { typed: d.typed, entered: d.entered });
check(d.imeKept === true, "AD5 한글 조합 중의 Enter 는 열지 않는다(글자 확정)");
check(!!d.none && d.none.tiles === 0 && d.none.desc === "「zzz」에 맞는 앱이 없어요.", "AD6 없는 이름 — 타일 없이 안내 한 줄", d.none);
check(!!d.arrows && d.arrows.first === "자료" && d.arrows.now === "세션 파일" && /^세션 파일/.test(d.arrows.desc || "") && d.backToInput === true, "AD7 ↓ 로 타일에 들어가 → 로 옮기면 설명이 따라간다 · 첫 줄에서 ↑ 면 검색칸", { arrows: d.arrows, back: d.backToInput });
check(/^웹/.test(d.hover || "") && !!d.more && d.more.closed && d.more.tabs.includes("자료 2"), "AD8 올리면 그 앱의 설명 · 이미 열린 자료를 누르면 «자료 2» 가 선다", { hover: d.hover, more: d.more });
check(d.esc === true, "AD9 Esc 로 닫힌다");
console.log("skip  T1 «이 세션에 붙이기» 고르기 — stage 판엔 붙은 앱(#4225)이 아직 없다(main 에서 잰다)");
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "E1 페이지 오류 없음(마운트 · 그리기)", R.pageErrors);

console.log(fail ? `\n${fail}건 실패 · ${pass}건 통과` : `\n${pass}건 통과`);
process.exit(fail ? 1 : 0);
