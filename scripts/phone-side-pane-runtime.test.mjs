#!/usr/bin/env node
// 폰 곁칸 대응을 실제 크롬에 셸을 통째로 세워 본다 (#4443, 원준 2026-10-08 «이런 곁칸도 모바일에서 좀 대응되게 … 문제부터 파악해서 해결»)
//  ⚠ stage 판: 붙은 앱(#4225 · session-app-pane)이 아직 없어 appDoor(D) · 머리줄 단추(H) · 앱 화면 안 쓰는 중(B1 · B2 · B3 · B8 · B9) 행은 뺐다.
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
//   C1 «크게 보기» = 화면 전체 · «(Esc)» 숨음 · «앱 UI» 배지는 남는다 · 단추 «닫기»
//  눕힌 폰(폭 641~900 · 높이 ≤500): A4 서랍에 독이 없다 · C2 «크게 보기» 화면 전체
//  태블릿(폭 641~900 · 높이 >500): A3 서랍에 독이 선다(가림 폭 > 0) · C 크게 보기는 종전 창(여백 24px)
//  데스크톱: A7 독이 선다 · H7 머리줄 [붙은 앱] 숨음(곁칸에 그 탭이 보인다) · C3 크게 보기 종전 창 · «닫기 (Esc)»
//  E 페이지 오류 없음
//
//  fail-first(2026-10-08 PR #1284): 바꾸기 전 판(SRC_ROOT = origin/main ac51ab1b)에서 D1 · D2 · D3 · D1b · A1 · B1 · B6 · F1 · C1 · A4 · C2 빨강
//   (B0 · B2 · B3 · B7 · B8 · A3 · C(태블릿) · A7 · C3 는 «그대로여야 하는» 행이라 옛 판에서도 초록). 그 행들은 돌연변이로 빨강을 봤다:
//   입력칸 :not(체크 상자 …) 를 빼면 B7 · 규칙의 .m-aside 를 빼면 B8 · 독 끄기를 narrow() 로 넓히면 A3 · «났다» 를 버리면 B3 ·
//   크게 보기 문턱을 넓히면 C(태블릿) · C3.
//  fail-first(후속, 격리 리뷰): 머리줄 단추를 headR 에서 빼면 H0~H5 · 넓은 폭 숨김을 풀면 H7 · 부품의 :not([hidden]) 을 빼면 B9 ·
//   보이는 탭(.v2-tabpane:not([hidden])) 한정을 빼면 B10 · 고르기 상자를 목록에 넣으면 B6s · 읽기 전용 제외를 빼면 B6r ·
//   textarea · contenteditable 갈래를 빼면 B6t · B6c 가 빨갛다.
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정). 폰 곁칸 런타임 검증 미실행"); process.exit(0); }
const CSS = ["01-base.css", "03-components.css", "20-dashboard.css", "36-chat.css", "40-v2.css", "42-v2-dock.css", "42-v2-panes.css", "45-v2-side-swap.css", "49-v2-ctx.css", "49-v2-projpane.css", "50-mobile.css"]
  .map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
//  같은 모듈 한 벌을 셸 · 세션 머리줄 · 앱 창이 나눠 쓴다(묶음 하나).
const bundle = buildSync({
  stdin: { contents: "export { mountPanes } from './web/v2/panes.ts'; export { openAppUi, closeAppUi } from './web/v2/app-ui.ts';", resolveDir: ROOT, loader: "ts" },
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
  //  앱 화면: 부모가 보내는 시험 명령으로 제 칸에 초점을 옮긴다(샌드박스 프레임이라 부모가 안을 만질 수 없다)
  const APP_HTML = "<!doctype html><html><body><textarea id=\"t\"></textarea><button id=\"b\">b</button><input type=\"checkbox\" id=\"c\">"
    + "<script>addEventListener('message', function (e) { var d = e.data || {}; var id = d.__test; if (id) { var el = document.getElementById(id); if (el) el.focus(); } });<\/script></body></html>";
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
  const handle = PN.mountPanes(host, { id: 7, detail: { project: { id: 7, name: "P" } }, data: () => ({ projects: [{ id: 7, name: "P" }], sessions: [{ id: "box-a", projectId: 7, label: "세션", live: true, alive: true }], loadedAt: Date.now() }),
    sessionId: "box-a", onOpenDrawer: () => { drawerOpens++; root.classList.add("m-aside"); }, onCloseDrawer: () => root.classList.remove("m-aside"),
    mountSession: (h, sid) => { h.append(Object.assign(document.createElement("p"), { textContent: "세션 " + sid })); return { destroy() {} }; } });
  await sleep(500);
  const side = () => $('#app .pn-pane[data-zone="side"]');
  const dockState = () => { const d = side() && side().querySelector(".pn-dock") || $("#app .pn-dock"); return { shown: !!d && !d.hidden && getComputedStyle(d).display !== "none", inset: side() ? getComputedStyle(side()).getPropertyValue("--pn-dock-b").trim() : null }; };
  const paneBottom = () => { const p = side(); if (!p) return null; const r = p.getBoundingClientRect(); return r.width ? Math.round(r.bottom) : 0; };
  const mtabs = () => getComputedStyle(tabs).display;
  const tabsTop = () => Math.round(tabs.getBoundingClientRect().top);
  const actTab = () => { const b = $$('#app .pn-pane[data-zone="side"] .pn-tab').find((x) => x.getAttribute("aria-selected") === "true"); return b ? b.closest(".pn-tabwrap")?.getAttribute("data-tab") : null; };
  const pickTab = (k) => $$('#app .pn-pane[data-zone="side"] .pn-tab').find((b) => b.closest(".pn-tabwrap")?.getAttribute("data-tab") === k)?.click();
  const visiblePart = () => $$('#app .pn-pane[data-zone="side"] .pn-pane-body > .pn-part').find((n) => !n.hidden) || null;
  const bigView = async () => {
    const okOpen = await PN.openAppUi("deck", { title: "장표 수정" });
    await waitFor(() => $(".v2-appui"));
    const o = $(".v2-appui"); const r = o ? o.getBoundingClientRect() : null;
    const out = { open: okOpen, box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
      esc: o && o.querySelector(".v2-appui-esc") ? getComputedStyle(o.querySelector(".v2-appui-esc")).display : "absent", badge: o ? getComputedStyle(o.querySelector(".v2-appui-badge")).display : null,
      btn: o ? o.querySelector(".v2-appui-h button").innerText.replace(/\s+/g, " ").trim() : null };
    PN.closeAppUi();
    return out;
  };
  try {
    if (window.__MODE === "phone") {
      const p = {}; R.p = p;
      //  서랍을 연다(머리줄 [자료] 와 같은 함수)
      handle.showPart("files"); await sleep(400);
      p.dock = dockState();
      p.b0 = { mtabs: mtabs(), bottom: paneBottom(), tabsTop: tabsTop() };
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
    } else {
      const q = {}; R.q = q;
      //  서랍(좁은 폭)이면 머리줄 [자료] 와 같은 함수(showPart)로 연다 · 데스크톱은 곁칸이 늘 보인다
      if (window.__MODE !== "desktop") { handle.showPart("files"); await sleep(400); }
      await sleep(400);
      q.dock = dockState();
      q.mAside = root.classList.contains("m-aside");
      q.big = await bigView();
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
  const m = /<pre id="out"[^>]*>([\s\S]*?)ENDRESULT/.exec(dom);
  if (!m) return { fatal: "페이지가 결과를 안 냈다: " + dom.slice(0, 600) };
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
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
check(!!p.dock && !p.dock.shown && p.dock.inset === "0px", "A1 폰 서랍엔 독이 없다(가림 폭 0px)", p.dock);
check(!!p.b0 && p.b0.mtabs !== "none" && p.b0.bottom === p.b0.tabsTop && p.b0.tabsTop < ph, "B0 쓰기 전: 아래 탭 바가 서고 서랍 바닥 = 탭 바 위", { ...p.b0, vh: ph });
const hid = (v) => !!v && v.focused && v.mtabs === "none" && v.bottom === ph;
const kept = (v) => !!v && v.focused && v.mtabs !== "none" && !!p.b0 && v.bottom === p.b0.bottom;
check(hid(p.b6), "B6 곁칸 글 입력칸 초점 → 탭 바 숨음 · 바닥 = 화면 끝", p.b6);
check(hid(p.b6t), "B6t 곁칸 글 칸(textarea) 초점 → 숨음", p.b6t);
check(hid(p.b6c), "B6c 곁칸 편집 가능한 글 초점 → 숨음", p.b6c);
check(kept(p.b6r), "B6r 읽기 전용 입력칸 초점 → 그대로(자판이 안 뜬다)", p.b6r);
check(kept(p.b6s), "B6s 고르기 상자 초점 → 그대로(고르기 판은 자판이 아니다)", p.b6s);
check(kept(p.b7), "B7 곁칸 체크 상자 초점 → 그대로", p.b7);
check(!!p.b10 && p.b10.mtabs !== "none" && p.b10.bottom === p.b10.tabsTop, "B10 숨은 셸 탭에 남은 표시는 지금 탭의 탭 바를 숨기지 않는다", p.b10);
check(p.f1 === "16px", "F1 폰 곁칸 태스크 추가 입력칸 16px", p.f1);
check(pw <= 640 && !!p.big && Js(p.big.box) === Js([0, 0, pw, ph]) && p.big.esc === "none" && p.big.badge !== "none" && p.big.btn === "닫기", "C1 폰 «크게 보기» = 화면 전체 · «(Esc)» 숨음 · «앱 UI» 배지는 남는다", { ...p.big, vp: P.vp });
const f = F.q || {};
check(!!f.dock && f.mAside && !f.dock.shown && f.dock.inset === "0px", "A4 눕힌 폰 서랍엔 독이 없다", f.dock);
const [fw, fh] = F.vp || [0, 0];
check(fw > 640 && fh <= 500 && !!f.big && Js(f.big.box) === Js([0, 0, fw, fh]), "C2 눕힌 폰 «크게 보기» = 화면 전체", { ...f.big, vp: F.vp });
const t = T.q || {};
check(!!t.dock && t.mAside && t.dock.shown && t.dock.inset !== "0px", "A3 태블릿 서랍엔 독이 선다", t.dock);
check(!!t.big && !!t.big.box && t.big.box[0] === 24 && t.big.esc !== "none", "C 태블릿 «크게 보기» 는 종전 창(여백 24px · «(Esc)»)", t.big);
const d = D.q || {};
check(!!d.dock && d.dock.shown, "A7 데스크톱 독 그대로", d.dock);
const dh = (D.vp || [0, 0])[1];
check(!!d.big && Js(d.big.box && d.big.box.slice(2)) === Js([960, Math.round(Math.min(680, dh * 0.88))]) && d.big.esc !== "none" && d.big.btn === "닫기 (Esc)", "C3 데스크톱 «크게 보기» 종전 창(최대 960×680 · 88vh) · «닫기 (Esc)»", { ...d.big, vp: D.vp });
const errs = [P, F, T, D].flatMap((r) => r.pageErrors || []);
check(errs.length === 0, "E 페이지 오류 없음", errs);
console.log(`\nphone-side-pane-runtime: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
