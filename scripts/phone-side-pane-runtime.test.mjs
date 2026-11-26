#!/usr/bin/env node
// 폰 곁칸(붙은 앱) 대응을 실제 크롬에 셸을 통째로 세워 본다 (#4443, 원준 2026-10-08 «이런 곁칸도 모바일에서 좀 대응되게 … 문제부터 파악해서 해결»)
//
//  실측(고치기 전, 매니지드 · 402×672): ① 폰 세션 화면에 붙은 앱으로 가는 단추가 없다 ② 서랍 아래 독(가림 80px)과 아래 탭 바(56px)가
//   함께 서서 장표 수정 앱의 장 · 글 칸이 369px(화면의 55%) ③ 앱 안에서 글을 고쳐도 탭 바가 자판 위에 남는다 ④ 16px 보다 작은 글 상자
//   ⑤ «크게 보기» 가 폰에서 서랍보다 작다(352×538). 값 시험(SDK 신호 · 다리 · 아이폰 확대 · 배선)은 phone-side-pane.test.mjs.
//  가짜는 fetch 하나(붙은 앱 목록 · 앱 화면 · 자료)뿐이다. 셸 · 부품 · 세션 머리줄 · 앱 다리 · SDK 런타임 · CSS 는 제품 그대로. 폭마다 크롬을 따로 띄운다.
//
// 사양(엣지 표, 행마다 단언 하나 이상):
//  폰(폭 ≤640)
//   D1 칸 셸이 주는 appDoor: 붙은 앱 1개 → {제목 «장표 수정», 수 1, 아이콘} · D2 하나 더 붙음 → «앱 2개» · 수 2 · D3 다 뗌 → null
//   D1b appDoor.open() → 서랍이 열리고(onOpenDrawer) 곁칸의 붙은 앱 탭이 켜진다
//   H0 실제 세션 머리줄(mountSessionChat): [붙은 앱] 단추가 있고 처음엔 숨었다 · H1 watch 가 앱을 주면 보이고 이름표 «붙은 앱 장표 수정 열기» · 글자 · 아이콘
//   H2 누르면 appDoor.open() · H3 앱 2개면 이름표 «붙은 앱 2개 열기» · H4 연결 이상(data-term=wait)이면 걷음 · H5 null 이면 숨음 · H6 머리줄을 내리면 구독을 끊는다
//   A1 서랍에 독이 없다(독 숨음 · 가림 폭 0px)
//   B0 쓰기 전: 탭 바가 서고 서랍 바닥 = 탭 바 위 · B1 앱 화면 안 글 칸 초점 → 탭 바 숨음 · 서랍 바닥 = 화면 끝 · B3 앱 안 단추로 옮기면 돌아온다
//   B2 앱 안 체크 상자 초점 → 그대로 · B6 곁칸 글 입력칸 · B6t 글 칸(textarea) · B6c 편집 가능한 글 초점 → 숨음
//   B6r 읽기 전용 입력칸 · B6s 고르기 상자 · B7 체크 상자 초점 → 그대로
//   B8 서랍이 닫혀 있으면 «쓰는 중» 표시가 남아도 탭 바 그대로 · B9 붙은 앱 부품이 숨으면(다른 탭) 표시가 남아도 그대로
//   B10 숨은 셸 탭(.v2-tabpane[hidden])에 남은 표시는 지금 탭의 탭 바를 숨기지 않는다
//   F1 폰 곁칸의 태스크 추가 입력칸 16px(칸 안 규칙 12.5 · 13px 를 이긴다)
//   C1 «크게 보기» = 화면 전체 · «앱 UI» 배지는 남는다 · 단추 «닫기»(«(Esc)» 안내는 모든 폭에서 없다 — 2026-10-16 상민님)
//  눕힌 폰(폭 641~900 · 높이 ≤500): A4 서랍에 독이 없다 · C2 «크게 보기» 화면 전체
//  태블릿(폭 641~900 · 높이 >500): A3 서랍에 독이 선다(가림 폭 > 0) · C 크게 보기는 종전 창(여백 24px)
//  데스크톱: A7 독이 선다 · H7 머리줄 [붙은 앱] 숨음(곁칸에 그 탭이 보인다) · C3 크게 보기 화면 가득 · «닫기»
//  E 페이지 오류 없음
//
//  fail-first(2026-10-08 PR #1284): 바꾸기 전 판(SRC_ROOT = origin/main ac51ab1b)에서 D1 · D2 · D3 · D1b · A1 · B1 · B6 · F1 · C1 · A4 · C2 빨강
//   (B0 · B2 · B3 · B7 · B8 · A3 · C(태블릿) · A7 · C3 는 «그대로여야 하는» 행이라 옛 판에서도 초록). 그 행들은 돌연변이로 빨강을 봤다:
//   입력칸 :not(체크 상자 …) 를 빼면 B7 · 규칙의 .m-aside 를 빼면 B8 · 독 끄기를 narrow() 로 넓히면 A3 · «났다» 를 버리면 B3 ·
//   크게 보기 문턱을 넓히면 C(태블릿) · C3.
//  fail-first(후속, 격리 리뷰): 머리줄 단추를 headR 에서 빼면 H0~H5 · 넓은 폭 숨김을 풀면 H7 · 부품의 :not([hidden]) 을 빼면 B9 ·
//   보이는 탭(.v2-tabpane:not([hidden])) 한정을 빼면 B10 · 고르기 상자를 목록에 넣으면 B6s · 읽기 전용 제외를 빼면 B6r ·
//   textarea · contenteditable 갈래를 빼면 B6t · B6c 가 빨갛다.
//  흔들림(2026-11-26): B1 이 CI 에서 가끔, 맥 크롬 158 에서는 늘 빨갰다(실제 {"kb":false,"mtabs":"flex","bottom":501,"vh":557}).
//   크롬 158 이 불투명 오리진 프레임에서 사람 동작 없이 부른 el.focus() 를 막는다(BlockingFocusWithoutUserActivation 기본 켜짐). 시험 앱이 제 칸에
//   초점을 못 가져가 장면이 일어나지 않았다. 사람이 누르는 제품 길은 이 막음에 걸리지 않는다(누르면 브라우저가 초점을 준다). CI 는 러너 이미지가
//   섞여 20261122(크롬 158.0.8127.36) 잡만 빨갛고 20261116(157.0.8103.78) 잡은 초록이었다. 셸이 프레임에 먼저 초점을 주고(사람이 누를 때
//   브라우저가 하는 일) 앱이 옮긴 초점을 답한다(tell).
//   fail-first: 고치기 전 판은 크롬 158 에서 B1 이 빨갛고(B3 · B2 는 아무 일도 없어 거짓 초록), 그 기능을 끄면
//   (--disable-blink-features=BlockingFocusWithoutUserActivation) 고치기 전 판도 초록이다. 고친 판은 SDK 런타임에서 체크 상자를 글 상자로 치면
//   B2 가, «났다»(on:false)를 버리면 B3 이 빨갛다(고치기 전 판은 크롬 158 에서 둘 다 초록이었다).
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정). 폰 곁칸 런타임 검증 미실행"); process.exit(0); }
const CSS = ["01-base.css", "03-components.css", "20-dashboard.css", "36-chat.css", "40-v2.css", "42-v2-dock.css", "42-v2-panes.css", "45-v2-side-swap.css", "49-v2-ctx.css", "49-v2-projpane.css", "50-mobile.css"]
  .map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
//  같은 모듈 한 벌을 셸 · 세션 머리줄 · 앱 창이 나눠 쓴다(묶음 하나).
const bundle = buildSync({
  stdin: { contents: "export { mountPanes } from './web/v2/panes.ts'; export { openAppUi, closeAppUi, openAppBig } from './web/v2/app-ui.ts'; export { refreshSessionApps } from './web/v2/session-app-pane.ts'; export { mountSessionChat } from './web/session-chat.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "PN", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { mode: window.__MODE };
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 4000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch (_) { /* 아직 */ } await sleep(25); } return false; };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  const APP = (id, title) => ({ app_id: id, title, attached_at: "2026-10-08T00:00:00Z", attached_by: "me", usable: true, has_ui: true, pages: [{ key: "main", title }], tables: [] });
  window.__apps = [APP("deck", "장표 수정")];
  //  앱 화면: 부모가 보내는 시험 명령으로 제 칸에 초점을 옮긴다(샌드박스 프레임이라 부모가 안을 만질 수 없다).
  //   옮긴 뒤 한 박자 뒤에 지금 초점을 답한다(__ack). 그 한 박자는 SDK 런타임이 ui/typing 을 판정하는 setTimeout 0 보다 뒤에 걸리고,
  //   같은 창이 보낸 메시지는 보낸 차례대로 닿는다. 그래서 답이 왔으면 그 초점 변화의 ui/typing 도 이미 셸에 왔다.
  const APP_HTML = "<!doctype html><html><body><textarea id=\"t\"></textarea><button id=\"b\">b</button><input type=\"checkbox\" id=\"c\">"
    + "<script>addEventListener('message', function (e) { var d = e.data || {}; var id = d.__test; if (!id) return; var el = document.getElementById(id); if (el) el.focus();"
    + " setTimeout(function () { var a = document.activeElement; parent.postMessage({ __ack: d.n, active: (a && a.id) || null, hasFocus: document.hasFocus() }, '*'); }, 0); });<\/script></body></html>";
  window.fetch = async (url) => {
    const u = new URL(url, "http://x/");
    if (/^\/api\/ui\/terminal\/sessions\/[^/]+\/apps$/.test(u.pathname)) return J({ apps: window.__apps });
    if (/^\/api\/ui\/apps\/[^/]+\/ui(\/.*)?$/.test(u.pathname)) return J({ html: APP_HTML, title: "장표 수정", page_key: "main" });
    if (u.pathname === "/api/ui/apps") return J({ apps: [] });
    const mm = /\/projects\/(\d+)(\/.*)?$/.exec(u.pathname);
    if (mm && mm[2] === "/files") return J({ items: [] });
    if (mm && !mm[2]) return J({ project: { id: Number(mm[1]), name: "P", status_category: "started" } });
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  const PN = (new Function(document.getElementById("pfsrc").textContent + "\n;return PN;"))();

  //  셸 뼈대: #v2-root(.m-aside = 서랍 열림) > .v2-main > .v2-tabpane(셸 탭 하나) > 칸 셸, 그리고 아래 탭 바(.v2-mtabs).
  //   main.ts · tabs.ts 가 세우는 것과 같은 이름 · 같은 부모 자식(매니지드 실측: section.pn-pane < .pn-body < .pn-wrap < .v2-tabpane < #v2-main < #v2-root).
  const root = document.createElement("div"); root.id = "v2-root"; root.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
  const main = document.createElement("main"); main.className = "v2-main"; main.style.cssText = "flex:1;min-height:0;position:relative;display:flex;flex-direction:column";
  const pane = document.createElement("div"); pane.className = "v2-tabpane"; pane.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column";
  const host = document.createElement("div"); host.id = "app"; host.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column;background:var(--bg)";
  const tabs = document.createElement("nav"); tabs.className = "v2-mtabs"; tabs.innerHTML = "<button class=\"v2-mtab\">홈</button>";
  pane.append(host); main.append(pane); root.append(main, tabs); document.body.append(root);
  let drawerOpens = 0;
  window.__door = null;
  const handle = PN.mountPanes(host, { id: 7, detail: { project: { id: 7, name: "P" } }, data: () => ({ projects: [{ id: 7, name: "P" }], sessions: [{ id: "box-a", projectId: 7, label: "세션", live: true, alive: true }], loadedAt: Date.now() }),
    sessionId: "box-a", onOpenDrawer: () => { drawerOpens++; root.classList.add("m-aside"); }, onCloseDrawer: () => root.classList.remove("m-aside"),
    mountSession: (h, sid, o) => { window.__door = (o && o.appDoor) || null; h.append(Object.assign(document.createElement("p"), { textContent: "세션 " + sid })); return { destroy() {} }; } });
  await sleep(500);
  const side = () => $('#app .pn-pane[data-zone="side"]');
  const dockState = () => { const d = side() && side().querySelector(".pn-dock") || $("#app .pn-dock"); return { shown: !!d && !d.hidden && getComputedStyle(d).display !== "none", inset: side() ? getComputedStyle(side()).getPropertyValue("--pn-dock-b").trim() : null }; };
  const paneBottom = () => { const p = side(); if (!p) return null; const r = p.getBoundingClientRect(); return r.width ? Math.round(r.bottom) : 0; };
  const mtabs = () => getComputedStyle(tabs).display;
  const tabsTop = () => Math.round(tabs.getBoundingClientRect().top);
  const actTab = () => { const b = $$('#app .pn-pane[data-zone="side"] .pn-tab').find((x) => x.getAttribute("aria-selected") === "true"); return b ? b.closest(".pn-tabwrap")?.getAttribute("data-tab") : null; };
  const pickTab = (k) => $$('#app .pn-pane[data-zone="side"] .pn-tab').find((b) => b.closest(".pn-tabwrap")?.getAttribute("data-tab") === k)?.click();
  const frameEl = () => $('#app .pn-pane[data-zone="side"] .pn-sessapp .v2-appui-frame');
  //  앱 화면 안 칸 하나를 사람이 누른 꼴로 초점을 옮기고, 앱이 답한 지금 초점({ active, hasFocus })을 돌려준다.
  //   ⚠ 크롬 158 부터 불투명 오리진(샌드박스) 프레임은 사람 동작 없이 제 칸에 초점을 가져가지 못한다(BlockingFocusWithoutUserActivation 이
  //    기본으로 켜졌다). 앱의 el.focus() 가 아무 일도 안 해서 B1 이 늘 빨갰다(머리말 «흔들림»). 사람이 누르면 브라우저가 먼저 그 프레임에
  //    초점을 준다. 그래서 셸 쪽에서 프레임에 먼저 초점을 주고, 앱은 이미 초점을 가진 프레임 안에서 제 칸으로 옮긴다(이건 158 에서도 된다).
  //   앱 문서가 아직 다리를 안 걸었으면 명령이 버려진다. 고정 대기 대신 답이 올 때까지 다시 보낸다(같은 칸에 다시 초점을 줘도 그대로다).
  const acks = new Map(); let tellN = 0;
  window.addEventListener("message", (e) => { const d = e.data; const f = frameEl(); if (d && typeof d === "object" && d.__ack && f && e.source === f.contentWindow) acks.set(d.__ack, { active: d.active, hasFocus: d.hasFocus }); });
  const tell = async (id) => {
    const f = frameEl();
    if (!f || !f.contentWindow) return null;
    if (document.activeElement !== f) f.focus();
    const n = ++tellN;
    for (let i = 0; i < 20 && !acks.has(n); i++) { f.contentWindow.postMessage({ __test: id, n }, "*"); await waitFor(() => acks.has(n), 150); }
    return acks.get(n) || null;
  };
  const visiblePart = () => $$('#app .pn-pane[data-zone="side"] .pn-pane-body > .pn-part').find((n) => !n.hidden) || null;
  const bigView = async () => {
    const okOpen = await PN.openAppUi("deck", { title: "장표 수정" });
    await waitFor(() => $(".v2-appui"));
    const o = $(".v2-appui"); const r = o ? o.getBoundingClientRect() : null;
    const out = { open: okOpen, box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
      esc: o && o.querySelector(".v2-appui-esc") ? getComputedStyle(o.querySelector(".v2-appui-esc")).display : "absent", badge: o ? getComputedStyle(o.querySelector(".v2-appui-badge")).display : null,
      btn: o ? [...o.querySelectorAll(".v2-appui-h button")].pop().innerText.replace(/\s+/g, " ").trim() : null };   // 닫기 단추(머리줄 맨 끝) — 크게 보기는 늘 화면 가득이라 토글 단추가 없다(2026-10-12)
    PN.closeAppUi();
    return out;
  };
  //  「크게 보기」 단추가 부르는 것 — 새 탭(window.open 을 가로채 주소만 본다) 또는 그 자리에서 가득(폰 · 팝업 막힘)
  const bigTab = async (blocked) => {
    let url = null; const orig = window.open; window.open = (u) => { url = u; return blocked ? null : { closed: false }; };
    try { PN.openAppBig("deck", { title: "장표 수정", sessionId: "s1", page: "main" }); await sleep(120); } finally { window.open = orig; }
    const inPlace = !!$(".v2-appui"); PN.closeAppUi(); await sleep(30);
    return { url, inPlace };
  };
  //  실제 세션 머리줄(session-chat.ts mountSessionChat) + 시험용 appDoor. 셸 고리는 위 D 행이, main.ts · views.ts 고리는 phone-side-pane W 행이 본다.
  const headReal = async () => {
    const box = document.createElement("div"); box.style.cssText = "position:fixed;left:0;top:0;width:100%;height:120px;z-index:99;background:var(--bg)";
    document.body.append(box);
    const door = { fn: null, opens: 0, watch(fn) { this.fn = fn; return () => { this.fn = null; }; }, open() { this.opens++; } };
    const icon = () => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", "sc-act-ic"); return s; };
    const h = PN.mountSessionChat(box, { id: "box-a", label: "세션", projectId: 7, live: true, alive: true, raw: {} }, { appDoor: door, onOpenFiles() {}, onOpenSidebar() {} });
    await sleep(120);
    const bt = () => box.querySelector(".sc-head .sc-act-app");
    const disp = () => (bt() ? getComputedStyle(bt()).display : "absent");
    const out = {};
    out.h0 = { exists: !!bt(), hidden: !!bt() && bt().hidden, disp: disp() };
    door.fn && door.fn({ title: "장표 수정", count: 1, icon: icon() });
    out.h1 = { disp: disp(), label: bt() && bt().getAttribute("aria-label"), text: bt() && bt().textContent.trim(), svg: !!(bt() && bt().querySelector("svg")) };
    bt() && bt().click();
    out.h2 = door.opens;
    door.fn && door.fn({ title: "앱 2개", count: 2, icon: icon() });
    out.h3 = { label: bt() && bt().getAttribute("aria-label"), text: bt() && bt().textContent.trim() };
    const hd = box.querySelector(".sc-head");
    if (hd) { hd.dataset.term = "wait"; out.h4 = disp(); hd.dataset.term = "ok"; out.h4ok = disp(); }
    door.fn && door.fn(null);
    out.h5 = { hidden: !!bt() && bt().hidden, disp: disp() };
    door.fn && door.fn({ title: "장표 수정", count: 1, icon: icon() });
    out.wide = disp();
    try { h && h.destroy(); } catch (e) { out.destroyErr = String(e); }
    out.h6 = door.fn === null;
    box.remove();
    return out;
  };

  try {
    if (window.__MODE === "phone") {
      const p = {}; R.p = p;
      //  D: 칸 셸이 주는 appDoor
      await waitFor(() => window.__door, 3000);
      p.hasDoor = !!window.__door;
      const seen = [];
      const off = window.__door ? window.__door.watch((d) => seen.push(d ? { title: d.title, count: d.count, icon: d.icon ? d.icon.tagName.toLowerCase() : null } : null)) : null;
      await waitFor(() => seen.some(Boolean));
      p.d1 = seen.filter(Boolean)[0] || null;
      window.__apps = [APP("deck", "장표 수정"), APP("memo", "메모")]; PN.refreshSessionApps("box-a");
      await waitFor(() => seen.length && seen[seen.length - 1] && seen[seen.length - 1].title === "앱 2개");
      p.d2 = seen[seen.length - 1];
      window.__apps = []; PN.refreshSessionApps("box-a");
      await waitFor(() => seen.length && seen[seen.length - 1] === null);
      p.d3 = seen[seen.length - 1] === null ? "null" : seen[seen.length - 1];
      window.__apps = [APP("deck", "장표 수정")]; PN.refreshSessionApps("box-a");
      await waitFor(() => seen.length && seen[seen.length - 1] && seen[seen.length - 1].title === "장표 수정");
      off && off();
      //  누르기 → 서랍 + 앱 탭
      await waitFor(() => $('#app .pn-pane[data-zone="side"] .pn-tabwrap[data-tab="sessapp"]'));
      //  붙자마자(«새로 붙음») 셸이 서랍을 열어 앱 탭을 켰다. 닫고 다른 탭(자료)을 켠 상태에서 누른다
      pickTab("files");
      await sleep(150);
      root.classList.remove("m-aside");
      p.before = { mAside: root.classList.contains("m-aside"), opens: drawerOpens, act: actTab() };
      window.__door && window.__door.open();
      await sleep(300);
      p.after = { mAside: root.classList.contains("m-aside"), opens: drawerOpens, act: actTab() };
      //  아래 행들은 위 배선과 따로 선다. 서랍을 열고 붙은 앱 탭을 손으로 켠다(옛 판에서도 같은 자리에서 잰다)
      root.classList.add("m-aside");
      pickTab("sessapp");
      //  A1: 서랍에 독이 없다
      await waitFor(() => frameEl());
      await sleep(400);
      p.dock = dockState();
      //  B: 쓰는 동안
      p.b0 = { mtabs: mtabs(), bottom: paneBottom(), tabsTop: tabsTop() };
      await waitFor(() => frameEl() && frameEl().contentWindow);
      //  tell 은 앱의 답을 기다린다. 답이 왔으면 그 초점 변화의 ui/typing 도 이미 왔다(APP_HTML). 그래서 첫 명령 앞의 고정 대기와
      //   B2 의 고정 대기는 두지 않는다. inner = 앱이 답한 초점이다. 초점이 그 칸에 안 섰으면 장면이 일어나지 않은 것이라 B1 · B3 · B2 가 빨갛다
      //   (B3 · B2 는 «그대로» 를 재는 행이라, 초점이 안 서면 아무 일도 없어 거짓 초록이 났다).
      const it = await tell("t"); await waitFor(() => $(".pn-sessapp.pn-kb"), 2500); await sleep(100);
      p.b1 = { kb: !!$(".pn-sessapp.pn-kb"), mtabs: mtabs(), bottom: paneBottom(), inner: it };
      const ib = await tell("b"); await waitFor(() => !$(".pn-sessapp.pn-kb"), 2500); await sleep(100);
      p.b3 = { kb: !!$(".pn-sessapp.pn-kb"), mtabs: mtabs(), bottom: paneBottom(), inner: ib };
      const ic = await tell("c");
      p.b2 = { kb: !!$(".pn-sessapp.pn-kb"), mtabs: mtabs(), inner: ic };
      await tell("b");
      //  곁칸의 입력칸(셸 쪽): 보이는 부품 안에 둔다
      const part = visiblePart();
      const mk = (html) => { const w = document.createElement("div"); w.innerHTML = html; const n = w.firstElementChild; part.append(n); return n; };
      const probe = async (n) => { n.focus(); await sleep(60); const v = { mtabs: mtabs(), bottom: paneBottom(), focused: document.activeElement === n }; n.blur(); await sleep(30); return v; };
      p.b6 = await probe(mk("<input type=\"text\">"));
      p.b6t = await probe(mk("<textarea></textarea>"));
      p.b6c = await probe(mk("<div contenteditable=\"true\">글</div>"));
      p.b6r = await probe(mk("<input type=\"text\" readonly>"));
      p.b6s = await probe(mk("<select><option>하나</option></select>"));
      p.b7 = await probe(mk("<input type=\"checkbox\">"));
      //  B8: 서랍을 닫은 뒤에 «쓰는 중» 표시가 늦게 남아 있어도(앱이 «났다» 를 늦게 보냄) 탭 바는 그대로. 닫힌 서랍 안의 입력칸은
      //   초점을 못 받으므로(display:none) 표시를 손으로 남겨 잰다.
      root.classList.remove("m-aside");
      const sp = $(".pn-sessapp"); sp && sp.classList.add("pn-kb"); await sleep(60);
      p.b8 = { mtabs: mtabs(), staleKb: !!$(".pn-sessapp.pn-kb") };
      root.classList.add("m-aside");
      //  B9: 표시가 남은 채 다른 탭(자료)으로 → 붙은 앱 부품은 숨는다(hidden). 숨은 부품의 표시는 규칙이 안 본다
      pickTab("files"); await sleep(150);
      p.b9 = { mtabs: mtabs(), bottom: paneBottom(), tabsTop: tabsTop(), partHidden: !!sp && sp.hidden, staleKb: !!sp && sp.classList.contains("pn-kb") };
      sp && sp.classList.remove("pn-kb");
      pickTab("sessapp"); await sleep(150);
      //  B10: 숨은 셸 탭에 «쓰는 중» 표시가 남은 곁칸이 있다(탭은 숨겨도 부품이 산다, tabs.ts)
      const ghost = document.createElement("div"); ghost.className = "v2-tabpane"; ghost.hidden = true;
      ghost.innerHTML = "<div class=\"pn-wrap\"><div class=\"pn-body\"><section class=\"pn-pane\" data-zone=\"side\"><div class=\"pn-pane-body\"><div class=\"pn-part pn-sessapp pn-kb\"></div></div></section></div></div>";
      main.append(ghost); await sleep(60);
      p.b10 = { mtabs: mtabs(), bottom: paneBottom(), tabsTop: tabsTop() };
      ghost.remove();
      //  F1: 태스크 추가 입력칸(칸 안 규칙과 겨룬다)
      const add = mk("<div class=\"pn-tk-add\"><input class=\"pn-tk-add-in\" type=\"text\"></div>");
      p.f1 = getComputedStyle(add.querySelector("input")).fontSize;
      p.big = await bigView();
      p.bigTab = await bigTab(false);
      p.head = await headReal();
    } else {
      const q = {}; R.q = q;
      //  서랍(좁은 폭)이면 머리줄 [자료] 와 같은 함수(showPart)로 연다 · 데스크톱은 곁칸이 늘 보인다
      if (window.__MODE !== "desktop") { handle.showPart("files"); await sleep(400); }
      await sleep(400);
      q.dock = dockState();
      q.mAside = root.classList.contains("m-aside");
      q.big = await bigView();
      q.bigTab = await bigTab(false);
      q.bigTabBlocked = await bigTab(true);
      q.head = await headReal();
    }
  } catch (e) { R.err = String(e && e.stack || e); }
  R.vp = [innerWidth, innerHeight];
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = (mode) => `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="pfsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>window.__MODE = ${JSON.stringify(mode)};</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

async function run(mode, w, h) {
  //  ⚠ 앱 화면은 샌드박스(불투명 오리진) 프레임이다. 사이트 격리를 켜 두면 그 프레임이 다른 프로세스로 떠서 가상 시간을 안 따르고
  //   (부모가 끝난 뒤에야 뜬다) 초점도 못 받는다(document.hasFocus() = false). 같은 프로세스로 띄운다(실측 2026-10-08).
  //  창 크기 = 보이는 영역 + 크롬 머리(맥 헤드리스 143px, 다른 곳은 다를 수 있다). 문턱(폭 ≤640 · 높이 ≤500)이 머리 크기와 무관하게 맞도록 고른다.
  //   기대값은 페이지 안의 innerWidth · innerHeight 로 잰다(폭은 크롬 최소 500).
  const dom = await dumpDom(chrome, { html: page(mode), copy: CSS, prefix: "phone-side-", virtualTimeBudget: 60000,
    args: [`--window-size=${w},${h}`, "--disable-site-isolation-trials", "--disable-features=IsolateOrigins,site-per-process"] });
  const res = readOut(dom);
  if (res.text === null) return { fatal: `페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ` + dom.slice(0, 600) };
  return JSON.parse(res.text);
}
const [P, F, T, D] = await Promise.all([run("phone", 402, 700), run("flat", 844, 480), run("tablet", 768, 1100), run("desktop", 1440, 1000)]);
if (process.env.DEBUG) console.log(JSON.stringify({ P, F, T, D }, null, 1));

let pass = 0, fail = 0;
const Js = (v) => JSON.stringify(v);
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${Js(got)}`); } };
for (const [nm, r] of [["폰", P], ["눕힌 폰", F], ["태블릿", T], ["데스크톱", D]]) {
  if (r.fatal || r.err) { fail++; console.error(`FAIL  ${nm} 장면이 던졌다: ${String(r.fatal || r.err).split("\n")[0]}`); }
}
const p = P.p || {};
const [pw, ph] = P.vp || [0, 0];
const hp = p.head || {};
check(p.hasDoor && Js(p.d1) === Js({ title: "장표 수정", count: 1, icon: "svg" }), "D1 칸 셸의 appDoor: 붙은 앱 1개면 그 앱 이름 · 수 1 · 아이콘", { has: p.hasDoor, d1: p.d1 });
check(Js(p.d2) === Js({ title: "앱 2개", count: 2, icon: "svg" }), "D2 하나 더 붙으면 «앱 2개» · 수 2", p.d2);
check(p.d3 === "null", "D3 다 떼면 null", p.d3);
check(!!p.before && !p.before.mAside && p.before.act === "files" && !!p.after && p.after.mAside && p.after.opens > p.before.opens && p.after.act === "sessapp", "D1b appDoor.open() → 서랍이 열리고 붙은 앱 탭이 켜진다", { before: p.before, after: p.after });
check(!!hp.h0 && hp.h0.exists && hp.h0.hidden && hp.h0.disp === "none", "H0 실제 세션 머리줄에 [붙은 앱] 단추가 있고 처음엔 숨었다", hp.h0);
check(!!hp.h1 && hp.h1.disp !== "none" && hp.h1.label === "붙은 앱 장표 수정 열기" && hp.h1.text === "장표 수정" && hp.h1.svg, "H1 watch 가 앱을 주면 보인다 · 이름표 · 글자 · 아이콘", hp.h1);
check(hp.h2 === 1, "H2 누르면 appDoor.open()", hp.h2);
check(!!hp.h3 && hp.h3.label === "붙은 앱 2개 열기" && hp.h3.text === "앱 2개", "H3 앱 2개면 이름표 «붙은 앱 2개 열기»(«붙은 앱 앱 2개» 로 겹치지 않는다)", hp.h3);
check(hp.h4 === "none" && hp.h4ok !== "none", "H4 연결 이상(data-term=wait)이면 걷고, 돌아오면 다시 선다", { wait: hp.h4, ok: hp.h4ok });
check(!!hp.h5 && hp.h5.hidden && hp.h5.disp === "none", "H5 null 이면 숨는다", hp.h5);
check(hp.h6 === true && !hp.destroyErr, "H6 머리줄을 내리면 구독을 끊는다", { h6: hp.h6, err: hp.destroyErr });
check(!!p.dock && !p.dock.shown && p.dock.inset === "0px", "A1 폰 서랍엔 독이 없다(가림 폭 0px)", p.dock);
check(!!p.b0 && p.b0.mtabs !== "none" && p.b0.bottom === p.b0.tabsTop && p.b0.tabsTop < ph, "B0 쓰기 전: 아래 탭 바가 서고 서랍 바닥 = 탭 바 위", { ...p.b0, vh: ph });
//  inAt: 앱이 답한 초점이 그 칸이고 프레임이 초점을 가졌나(장면이 정말 일어났나)
const inAt = (v, id) => !!v && !!v.inner && v.inner.active === id && v.inner.hasFocus === true;
check(inAt(p.b1, "t") && p.b1.kb && p.b1.mtabs === "none" && p.b1.bottom === ph, "B1 앱 화면 안 글 칸 초점 → 탭 바 숨음 · 서랍 바닥 = 화면 끝", { ...p.b1, vh: ph });
check(inAt(p.b3, "b") && !p.b3.kb && p.b3.mtabs !== "none" && !!p.b0 && p.b3.bottom === p.b0.bottom, "B3 앱 안 단추로 옮기면 탭 바 · 바닥이 돌아온다", p.b3);
check(inAt(p.b2, "c") && !p.b2.kb && p.b2.mtabs !== "none", "B2 앱 안 체크 상자 초점 → 그대로", p.b2);
const hid = (v) => !!v && v.focused && v.mtabs === "none" && v.bottom === ph;
const kept = (v) => !!v && v.focused && v.mtabs !== "none" && !!p.b0 && v.bottom === p.b0.bottom;
check(hid(p.b6), "B6 곁칸 글 입력칸 초점 → 탭 바 숨음 · 바닥 = 화면 끝", p.b6);
check(hid(p.b6t), "B6t 곁칸 글 칸(textarea) 초점 → 숨음", p.b6t);
check(hid(p.b6c), "B6c 곁칸 편집 가능한 글 초점 → 숨음", p.b6c);
check(kept(p.b6r), "B6r 읽기 전용 입력칸 초점 → 그대로(자판이 안 뜬다)", p.b6r);
check(kept(p.b6s), "B6s 고르기 상자 초점 → 그대로(고르기 판은 자판이 아니다)", p.b6s);
check(kept(p.b7), "B7 곁칸 체크 상자 초점 → 그대로", p.b7);
check(!!p.b8 && p.b8.staleKb && p.b8.mtabs !== "none", "B8 서랍이 닫혀 있으면 «쓰는 중» 표시가 남아도 탭 바 그대로", p.b8);
check(!!p.b9 && p.b9.partHidden && p.b9.staleKb && p.b9.mtabs !== "none" && p.b9.bottom === p.b9.tabsTop, "B9 붙은 앱 부품이 숨으면(다른 탭) 남은 표시를 안 본다", p.b9);
check(!!p.b10 && p.b10.mtabs !== "none" && p.b10.bottom === p.b10.tabsTop, "B10 숨은 셸 탭에 남은 표시는 지금 탭의 탭 바를 숨기지 않는다", p.b10);
check(p.f1 === "16px", "F1 폰 곁칸 태스크 추가 입력칸 16px", p.f1);
check(pw <= 640 && !!p.big && Js(p.big.box) === Js([0, 0, pw, ph]) && p.big.esc === "absent" && p.big.badge !== "none" && p.big.btn === "닫기", "C1 폰 «크게 보기» = 화면 전체 · «(Esc)» 안내 없음 · «앱 UI» 배지는 남는다", { ...p.big, vp: P.vp });
const f = F.q || {};
check(!!f.dock && f.mAside && !f.dock.shown && f.dock.inset === "0px", "A4 눕힌 폰 서랍엔 독이 없다", f.dock);
const [fw, fh] = F.vp || [0, 0];
check(fw > 640 && fh <= 500 && !!f.big && Js(f.big.box) === Js([0, 0, fw, fh]), "C2 눕힌 폰 «크게 보기» = 화면 전체", { ...f.big, vp: F.vp });
const t = T.q || {};
check(!!t.dock && t.mAside && t.dock.shown && t.dock.inset !== "0px", "A3 태블릿 서랍엔 독이 선다", t.dock);
check(!!t.big && !!t.big.box && t.big.box[0] === 0 && t.big.box[1] === 0 && t.big.box[2] === 768 && t.big.esc === "absent" && t.big.btn === "닫기", "C 태블릿 «크게 보기» 도 화면 가득(여백 없이 — 2026-10-12 «완전 전체화면으로») · 단추 «닫기»", t.big);
const d = D.q || {};
check(!!d.dock && d.dock.shown, "A7 데스크톱 독 그대로", d.dock);
check(!!d.head && d.head.wide === "none", "H7 데스크톱 머리줄 [붙은 앱] 숨음(곁칸에 그 탭이 보인다)", d.head && d.head.wide);
const dh = (D.vp || [0, 0])[1];
check(!!d.big && Js(d.big.box) === Js([0, 0, D.vp[0], D.vp[1]]) && d.big.esc === "absent" && d.big.btn === "닫기", "C3 ★ 데스크톱 «크게 보기» 는 화면 가득(창이 아니라 뷰포트 전체 · 토글 없음) · 단추 «닫기»(«(Esc)» 안내 없음 — 앱 화면을 누르면 Esc 가 앱으로 간다)", { ...d.big, vp: D.vp });
const tabUrl = (v) => !!v && typeof v.url === "string" && /#\/full\/deck\?s=s1&page=main&t=/.test(v.url) && !v.inPlace;
check(!!p.bigTab && p.bigTab.url === null && p.bigTab.inPlace, "C4 폰 «크게 보기» 는 새 탭이 아니라 그 자리에서 화면 전체(되돌아오기 쉽게)", p.bigTab);
check(tabUrl(t.bigTab), "C5 태블릿 «크게 보기» 는 새 탭(#/full/<앱>?s=<세션>&page=…) — 모달을 띄우지 않는다", t.bigTab);
check(tabUrl(d.bigTab), "C6 ★ 데스크톱 «크게 보기» 는 새 탭(#/full/<앱>?s=<세션>&page=…) — 모달을 띄우지 않는다(2026-10-12 «바로 거기로»)", d.bigTab);
check(!!d.bigTabBlocked && d.bigTabBlocked.inPlace, "C7 팝업이 막히면 이 탭 위에 화면 가득", d.bigTabBlocked);
const errs = [P, F, T, D].flatMap((r) => r.pageErrors || []);
check(errs.length === 0, "E 페이지 오류 없음", errs);
console.log(`\nphone-side-pane-runtime: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
