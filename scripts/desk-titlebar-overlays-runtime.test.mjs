#!/usr/bin/env node
// 데스크톱 앱 창 맨 윗줄(창 끌기 · 창 단추)에 창 전체 층의 단추가 깔리지 않는다 — 런타임 회귀 테스트 (#4480, 상민님 실측 2026-10-16)
//
// 신고: 윈도우 데스크톱 앱에서 크게 보기(#/full)의 «닫기(Esc)» 를 눌러도 잘 안 닫혔다 — «막 esc 연타하면서 닫기 누르다보면 언젠가 닫혀».
// 원인: 데스크톱 창은 frameless 라 맨 윗줄(셸의 .v2-topbar, 팝아웃은 preload 띠 · 36px)이 창 끌기 자리(-webkit-app-region: drag)이고,
//  윈도우는 그 줄 오른쪽에 네이티브 창 단추(최소화 · 최대화 · 닫기 — WCO)를 얹는다. 끌기 영역은 덮개를 보지 않는다 — 덮개가 위에 있어도
//  그 밑이 끌기 자리면 누른 것이 창 끌기가 된다. body 에 붙는 창 전체 층의 머리줄은 그 줄 안에 있었고, 닫기 단추는 오른쪽 위 —
//  창 단추(최대화 · 닫기) 자리 밑이었다(운영 화면을 데스크톱 흉내로 잰 값: «새 탭에서 열기» · «닫기(Esc)» 둘 다 y 5~32 · 오른쪽 138px 안).
//  결국 닫힌 것은 Esc 가 셸 문서에 초점이 있을 때 먹은 경우로 보인다(추정 — 앱 화면을 한 번 누르면 Esc 는 앱 문서로 가서 셸이 못 받는다).
// 고친 것: 데스크톱이면 셸이 줄 높이를 :root 의 --v2-desk-tb 로 알리고(web/v2/titlebar.ts announceDeskTitlebar — 셸이 줄을 가져갈 때와
//  팝아웃 · 못 가져간 창 모두), body 에 붙어 그 줄을 덮는 층은 안쪽 위를 그만큼 비운다(padding-top). 층은 그대로 창 전체를 덮어 열린 동안
//  줄의 탭 · 검색칸은 눌리지 않고, 머리줄 단추만 줄 아래로 내려온다. 브라우저에선 값이 없어 종전과 같다.
//  층 다섯: 크게 보기(.v2-appui-ov) · 그림 크게 보기(.md-mmv) · 화면 흐름 보드(.v2-wb) · 오른쪽 시트(.pn-modal — 닫기 X 가 창 닫기 단추
//  밑이었다) · 앱 만들기 창(.v2-studio — 지금 호출처는 앱빌더 안 자리 .v2-studio--in 로만 세운다).
//
// 장면(실제 titlebar.ts · 실제 스타일시트 · 넓은 창 1400px 과 좁은 창 600px — 본 창은 최소 900px 이지만 같은 출처 새 창(팝아웃 · 크게 보기
//  새 창, desktop/main/main.mjs setWindowOpenHandler)은 최소 폭이 없어 폰 폭 규칙(50-mobile.css)을 탈 수 있다):
//  B1 브라우저(livelyDesktop 없음) — --v2-desk-tb 가 없고 층 다섯 모두 위를 비우지 않는다(종전 그대로)
//  P1 팝아웃(preload 띠가 남은 창 · 셸이 줄을 안 가져감) — announceDeskTitlebar 가 36px 을 알리고 닫기 단추가 띠 아래 · 끌기 영역 밖
//  D1 데스크톱(가짜 livelyDesktop — 윈도우 · 36px · 창 단추 138px) — 셸이 줄을 가져가고 :root 에 --v2-desk-tb: 36px
//  D2 층 다섯 모두 창 전체를 덮고(위 0) 안쪽 위를 36px 비운다 — 닫기 단추가 줄 아래
//  D3 닫기 단추의 가운데가 끌기 영역이 아니다
//  D4 닫기 단추가 창 단추 자리(오른쪽 위 138×36)와 겹치지 않는다
//  D5 층이 열린 동안 줄 자리를 누르면 층이 받는다 — 줄의 탭 · 검색칸이 층 밑에서 눌리지 않는다
//  D6 앱빌더 안의 앱 만들기(.v2-studio--in)는 위를 비우지 않는다(창 맨 윗줄에 닿지 않는다)
//  W1 셸 시작(main.ts bootV2)이 팝아웃 갈래보다 앞에서 announceDeskTitlebar 를 부른다 · mountTitlebar 도 부른다
//
// fail-first(2026-10-16): 고치기 전 트리(SRC_ROOT)로 돌리면 46건이 빨갛다 — W1 2 · P1 12 · D1 2 · D2~D4 30(B1 · D5 · D6 은 종전에도 맞다).
//  셸 시작의 값 알리기 → W1 만 · mountTitlebar 의 값 알리기 → W1 · D1 · D2~D4 · 오른쪽 시트 규칙 → 그 층의 P1 · D2~D4 ·
//  앱빌더 안 자리의 padding-top: 0 → D6 · 폰 폭 규칙 → 좁은 창의 크게 보기만 — 각각 되돌리면 그 장면만 빨갛다.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;

let pass = 0, fail = 0;
const check = (cond, n, why) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
//  주석은 빼고 코드만 본다 — 걷어낸 식을 주석으로 인용해도 거짓 초록이 나지 않게(app-open-transient.test.mjs 와 같은 꼴).
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => { const i = l.indexOf("//"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");

// ── W1 배선 — 크롬 없이도 잰다 ──
{
  const main = code(readFileSync(path.join(SRC_ROOT, "web/v2/main.ts"), "utf8"));
  const iAnn = main.indexOf("announceDeskTitlebar();"), iSolo = main.indexOf("if (!SOLO) {");
  check(/import \{[^}]*\bannounceDeskTitlebar\b[^}]*\} from '\.\/titlebar\.js';/.test(main) && iAnn > 0 && iSolo > iAnn,
    "W1 셸 시작이 팝아웃 갈래(if (!SOLO))보다 앞에서 announceDeskTitlebar 를 부른다", JSON.stringify({ iAnn, iSolo }));
  const tb = code(readFileSync(path.join(SRC_ROOT, "web/v2/titlebar.ts"), "utf8"));
  const mount = tb.slice(tb.indexOf("export function mountTitlebar"));
  check(/announceDeskTitlebar\(\);/.test(mount), "W1 mountTitlebar 도 announceDeskTitlebar 를 부른다(셸이 줄을 가져간 창)", "mountTitlebar 안에 호출 없음");
}

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 데스크톱 맨 윗줄 런타임 검증 미실행");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
const STYLES = path.join(SRC_ROOT, "public/styles");
const CSS = ["01-base.css", "03-components.css", "40-v2.css", "42-v2-panes.css", "43-v2-topbar-search.css", "50-mobile.css"].map((f) => path.join(STYLES, f));
for (const f of CSS) if (!existsSync(f)) { console.error(`FAIL  스타일시트 없음: ${f}`); process.exit(1); }

//  titlebar.ts 는 core.js 의 el 하나만 쓴다 — 셸 전체를 끌어오지 않게 그 자리만 dom.ts 로 갈아 끼운다. `export *` 라 고치기 전 소스
//   (announceDeskTitlebar 없음)로도 묶인다 — 그때는 장면이 빨갛게 나온다(fail-first).
const bundle = (await build({
  stdin: { contents: "export * from './web/v2/titlebar.ts';", resolveDir: SRC_ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "TB", write: false, platform: "browser", target: "es2020", logLevel: "silent",
  plugins: [{
    name: "core-stub",
    setup(b) {
      b.onResolve({ filter: /^\.\.\/core\.js$/ }, () => ({ path: "core", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `export { el } from ${JSON.stringify(path.join(SRC_ROOT, "web/lib/dom.ts"))};`, loader: "ts", resolveDir: SRC_ROOT }));
    },
  }],
})).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { errors: [], vw: innerWidth, vh: innerHeight };
  window.addEventListener("error", (e) => R.errors.push(String(e.message || e)));
  const WCO_W = 138, TB_H = 36;
  const mk = (cls, ...kids) => { const n = document.createElement("div"); n.className = cls; n.append(...kids); return n; };
  const closeBtn = () => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = "닫기(Esc)"; return b; };
  const spacer = () => { const s = document.createElement("span"); s.style.flex = "1"; return s; };
  //  실제 머리줄과 같은 꼴 — 이름 · 빈 칸 · 맨 오른쪽 닫기
  const LAYERS = {
    appui: () => mk("v2-appui-ov", mk("v2-appui", mk("v2-appui-h", Object.assign(document.createElement("b"), { className: "v2-appui-t", textContent: "앱" }), spacer(), closeBtn()))),
    mmv: () => mk("md-mmv", mk("md-mmv-bar", spacer(), closeBtn())),
    wb: () => mk("v2-wb", mk("v2-wb-head", spacer(), closeBtn())),
    pnmodal: () => mk("pn-modal", mk("pn-modal-h", Object.assign(document.createElement("h2"), { textContent: "프로젝트 정보" }), closeBtn())),
    studio: () => mk("v2-studio", mk("v2-studio-top", spacer(), closeBtn())),
  };
  //  끌기 영역 흉내 — 그 점에 겹친 요소를 위에서부터 보아 처음 만나는 app-region 값(drag · no-drag)이 답이다. 값이 없는 요소(덮개)는
  //   구멍을 내지 못한다. 실제 크로미움은 겹침 순서가 아니라 그리는 순서로 모으지만(나중 no-drag 가 앞 drag 를 뺀다) 이 장면들에선 같은 답이다.
  const dragAt = (x, y) => {
    for (const n of document.elementsFromPoint(x, y)) {
      const v = getComputedStyle(n).getPropertyValue("-webkit-app-region").trim();
      if (v === "drag") return true;
      if (v === "no-drag") return false;
    }
    return false;
  };
  const measure = () => {
    const out = {};
    for (const [k, make] of Object.entries(LAYERS)) {
      const layer = make();
      document.body.append(layer);
      const lr = layer.getBoundingClientRect();
      const br = layer.querySelector("button").getBoundingClientRect();
      const cx = br.left + br.width / 2, cy = br.top + br.height / 2;
      const atBar = document.elementFromPoint(cx, TB_H / 2);
      out[k] = {
        top: Math.round(lr.top), padTop: getComputedStyle(layer).paddingTop,
        btn: { top: Math.round(br.top), bottom: Math.round(br.bottom), left: Math.round(br.left), right: Math.round(br.right) },
        dragAtBtn: dragAt(cx, cy),
        inWco: br.right > innerWidth - WCO_W && br.top < TB_H,
        barHitsLayer: !!atBar && layer.contains(atBar),
      };
      layer.remove();
    }
    return out;
  };
  const deskVar = () => getComputedStyle(document.documentElement).getPropertyValue("--v2-desk-tb").trim();

  // B1 브라우저 — 데스크톱 다리가 없다
  if (typeof TB.announceDeskTitlebar === "function") TB.announceDeskTitlebar();   // 브라우저에선 아무것도 안 해야 한다
  R.browser = { deskVar: deskVar(), layers: measure() };

  // P1 팝아웃 — preload 띠(web.cjs ③ 의 #lively-desktop-titlebar)가 남은 창. 셸은 줄을 안 가져가고 값만 알린다.
  const strip = document.createElement("div");
  strip.id = "lively-desktop-titlebar";
  strip.style.cssText = `position:fixed;top:0;left:0;right:0;height:${TB_H}px;z-index:2147483000;-webkit-app-region:drag`;
  document.body.prepend(strip);
  window.livelyDesktop = { platform: "win32", titlebar: { height: TB_H }, claimTitlebar: () => true };
  R.hasAnnounce = typeof TB.announceDeskTitlebar === "function";
  if (R.hasAnnounce) TB.announceDeskTitlebar();
  R.popout = { deskVar: deskVar(), layers: measure() };
  strip.remove();
  document.documentElement.style.removeProperty("--v2-desk-tb");

  // D 데스크톱 — 셸이 줄을 가져간다(윈도우 WCO 흉내: 오른쪽 138px 이 네이티브 창 단추)
  Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, value: {
    visible: true, getTitlebarAreaRect: () => ({ x: 0, y: 0, width: innerWidth - WCO_W, height: TB_H }), addEventListener() {},
  } });
  const root = document.createElement("div");
  root.id = "v2-root";
  document.body.prepend(root);
  const tb = TB.mountTitlebar(root);
  const bar = root.querySelector(".v2-topbar");
  const barR = bar ? bar.getBoundingClientRect() : null;
  R.desk = {
    mounted: !!(tb && tb.on), deskVar: deskVar(),
    barBottom: barR ? Math.round(barR.bottom) : null, barDrag: bar ? getComputedStyle(bar).getPropertyValue("-webkit-app-region").trim() : null,
    tbRight: root.style.getPropertyValue("--v2-tb-right"),
    layers: measure(),
  };
  // D6 앱빌더 안의 자리 — 셸 가운데 칸을 흉내 낸 자리(위 200px)
  const host = document.createElement("div");
  host.style.cssText = "position:relative;margin-top:200px;height:300px";
  const inStudio = mk("v2-studio v2-studio--in", mk("v2-studio-top", spacer(), closeBtn()));
  host.append(inStudio);
  document.body.append(host);
  R.desk.hosted = { hostTop: Math.round(host.getBoundingClientRect().top), top: Math.round(inStudio.getBoundingClientRect().top), padTop: getComputedStyle(inStudio).paddingTop };

  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const NAMES = { appui: "크게 보기", mmv: "그림 크게 보기", wb: "화면 흐름 보드", pnmodal: "오른쪽 시트", studio: "앱 만들기 창" };
for (const [label, size] of [["넓은 창", "1400,900"], ["좁은 창 600px", "600,800"]]) {
  const dom = await dumpDom(chrome, { html: PAGE, copy: CSS, prefix: "desk-titlebar-", args: [`--window-size=${size}`] });
  const res = readOut(dom);
  if (res.text === null) { check(false, `${label} — 결과 표지`, `out=${JSON.stringify(res.out)} ${dom.slice(0, 600)}`); continue; }
  const R = JSON.parse(res.text);
  if (process.env.DEBUG) console.log(label, JSON.stringify(R, null, 1));
  if (R.fatal) { check(false, `${label} — 장면 오류`, String(R.fatal).slice(0, 600)); continue; }
  check(!R.errors.length, `${label} — 페이지 오류 없음`, JSON.stringify(R.errors));
  const L = (scene, k) => (R[scene] && R[scene].layers[k]) || null;

  // B1
  check(R.browser.deskVar === "", `B1 ${label} — 브라우저에선 --v2-desk-tb 가 없다`, JSON.stringify(R.browser.deskVar));
  for (const [k, n] of Object.entries(NAMES)) {
    const x = L("browser", k);
    check(x && x.top === 0 && x.padTop === "0px", `B1 ${label} — ${n} 은 종전 그대로(위 0 · 안쪽 위 비움 없음)`, JSON.stringify(x));
  }
  // P1
  check(R.hasAnnounce && R.popout.deskVar === "36px", `P1 ${label} — 팝아웃(preload 띠)도 36px 을 알린다`, JSON.stringify({ has: R.hasAnnounce, v: R.popout.deskVar }));
  for (const [k, n] of Object.entries(NAMES)) {
    const x = L("popout", k);
    check(x && x.btn.top >= 36 && !x.dragAtBtn, `P1 ${label} — 팝아웃에서 ${n} 닫기 단추가 띠 아래 · 끌기 영역 밖`, JSON.stringify(x));
  }
  // D1
  //  좁은 폭은 폰 규칙이 줄을 content-box 로 잡아 아래 테두리 1px 이 더해진다(37) — 창 단추(WCO)는 36 그대로라 층은 36 만 비운다.
  check(R.desk.mounted && R.desk.barBottom >= 36 && R.desk.barBottom <= 37 && R.desk.barDrag === "drag", `D1 ${label} — 셸이 맨 윗줄(36px · 끌기)을 가져갔다`, JSON.stringify({ m: R.desk.mounted, b: R.desk.barBottom, d: R.desk.barDrag }));
  check(R.desk.deskVar === "36px", `D1 ${label} — :root 에 --v2-desk-tb: 36px`, JSON.stringify(R.desk.deskVar));
  check(R.desk.tbRight === "138px", `D1 ${label} — 창 단추 자리(오른쪽 138px)를 셸이 안다 — 흉내가 실제 경로를 탔다`, JSON.stringify(R.desk.tbRight));
  for (const [k, n] of Object.entries(NAMES)) {
    const x = L("desk", k);
    check(x && x.top === 0 && x.padTop === "36px" && x.btn.top >= 36, `D2 ${label} — ${n} 은 창 전체를 덮고 안쪽 위 36px 을 비운다(닫기 단추가 줄 아래)`, JSON.stringify(x));
    check(x && !x.dragAtBtn, `D3 ${label} — ${n} 닫기 단추 자리가 창 끌기 영역이 아니다`, JSON.stringify(x));
    check(x && !x.inWco, `D4 ${label} — ${n} 닫기 단추가 창 단추(오른쪽 위 138×36)와 겹치지 않는다`, JSON.stringify(x));
    check(x && x.barHitsLayer, `D5 ${label} — ${n} 이 열린 동안 줄 자리를 누르면 층이 받는다(줄의 탭 · 검색칸이 밑에서 안 눌린다)`, JSON.stringify(x));
  }
  // D6
  const h = R.desk.hosted;
  check(h && h.top === h.hostTop && h.padTop === "0px", `D6 ${label} — 앱빌더 안의 앱 만들기(.v2-studio--in)는 위를 비우지 않는다`, JSON.stringify(h));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
