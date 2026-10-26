// 태블릿 셸 CSS (#4678, 원준 2026-10-26 «모바일 말고 태블릿에서도 대응되게»)
//
//  배경: 40-v2.css 의 `@media (max-width: 1100px)` (아이패드 가로에서 사이드바·우패널을 좁히는 규칙)는 레일이 없던 시절의 5열이라,
//  6열 + 더 구체적인 `#v2-root.rail-mode` 규칙(47-v2-rail.css)에 밀려 **레일 모드에선 한 번도 안 먹었다**(1024px 실측: 사이드바 316px 그대로).
//  «조용히 안 먹는 규칙» 이 이 버그의 정체라, 시험은 문장이 아니라 **실제 크롬에서 잰 칸 폭**을 본다(iframe 폭을 바꿔 문턱을 넘나든다).
//
// 사양(엣지 표, 행마다 단언 하나 이상):
//  R1 1024 · 레일 모드 · 우패널 있음 → 사이드바 ≤ 248 · 우패널 ≤ 300
//  R2 1024 · 우패널 없음 → 사이드바 = 248 · 본문 ≥ 690(종전 사이드바 316 → 본문 ≈ 630)
//  R3 경계 — 901 · 1180 은 상한을 받고 · 1181 은 316 그대로 · 900 은 그리드가 아니라 서랍 셸(사이드바 열이 없다)
//  R4 손잡이 — 사용자가 줄인 폭(200)은 그대로 · 넓힌 폭(500)은 상한(248)으로(변수를 덮지 않고 min() 으로 상한만 건다)
//  R5 새로 도입한 변수가 비었거나 다른 값인 경우 — 레일 숨김(--v2-rail-w:0) → 사이드바가 x=0 에서 시작 · 레일 펼침(232px) → 사이드바가 232 에서 시작(레일 폭을 76 으로 못박지 않는다)
//      · 같은 변수를 쓰는 규칙은 셋이다(우패널 있음 · 없음 · 접힘/맥락앱) — 하나만 고정값으로 새도 다른 둘이 가려 주므로 셋을 따로 잰다(변이 시험에서 «우패널 있음» 만 76 으로 못박았더니 초록이었다)
//  R6 사이드바 접힘(.side-closed) · 맥락 앱(.app-ctx) + 우패널 → 우패널 ≤ 300 · 사이드바 열 0
//  R7 768(태블릿 세로) → 본문 왼쪽 여백 = 레일 폭 = 서랍 left = 64(네 자리가 한 값으로 옮겨졌다)
//  R8 390(폰) → 레일이 없고 여백 0 — 태블릿 CSS 가 폰 블록을 건드리지 않는다
//  S1 index.html 이 51-tablet.css 를 50-mobile.css 뒤 · 90-dark.css 앞에 건다(순서가 틀리면 같은 선택자 싸움에서 진다)
//  S2 51-tablet.css 의 모든 @media 는 641px 이상에서만 선다(폰 ≤640 은 50-mobile.css 몫) · 터치 단추 블록은 (pointer: coarse) 안에만 있다(마우스 노트북은 그대로)
//  S3 손가락 단추 최소 크기 — ×·압정·휴지통 32px 이상(붙어 있는 22px 휴지통 오탭 → 삭제 위험이 있었다) · 아이콘 단추 바닥 36px
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;   // 변이(mutation) 시험용: 복사본의 CSS 를 본다
const STYLES = path.join(SRC_ROOT, "public/styles");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const near = (got, want, tol, n) => (Math.abs(got - want) <= tol ? ok(n) : bad(n, `기대 ${want}±${tol} · 실제 ${got}`));

const read = (p) => readFileSync(path.join(SRC_ROOT, p), "utf8");

// ── S — 배선(소스) ─────────────────────────────────────────────────────────────────
const html = read("public/index.html");
const tabletPath = path.join(STYLES, "51-tablet.css");
check(existsSync(tabletPath), "S0 public/styles/51-tablet.css 가 있다");
const css = existsSync(tabletPath) ? readFileSync(tabletPath, "utf8") : "";
{
  const at = (n) => html.indexOf(`styles/${n}`);
  check(at("51-tablet.css") > 0 && at("50-mobile.css") < at("51-tablet.css") && at("51-tablet.css") < at("90-dark.css"),
    "S1 index.html 순서: 50-mobile < 51-tablet < 90-dark", `50=${at("50-mobile.css")} 51=${at("51-tablet.css")} 90=${at("90-dark.css")}`);
}
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = [];
for (const m of body.matchAll(/@media\s*([^{]+)\{/g)) {
  let depth = 1, i = m.index + m[0].length;
  while (i < body.length && depth) { const c = body[i++]; if (c === "{") depth++; else if (c === "}") depth--; }
  blocks.push({ query: m[1].trim(), text: body.slice(m.index + m[0].length, i - 1) });
}
{
  const phone = blocks.filter((b) => !/prefers-/.test(b.query) && !/min-width:\s*(641|901)px/.test(b.query));
  check(blocks.length > 0 && phone.length === 0, "S2a 모든 @media 가 641px 이상에서만 선다", phone.map((b) => b.query).join(" | ") || "@media 가 하나도 없다");
  const touch = blocks.find((b) => /(close|trash|pin)/.test(b.text) && /v2-navb/.test(b.text));
  check(!!touch && /pointer:\s*coarse/.test(touch.query), "S2b 손가락 단추 블록은 (pointer: coarse) 안에 있다", touch ? touch.query : "블록이 없다");
  const px = (re) => { const m = (touch ? touch.text : "").match(re); return m ? Number(m[1]) : 0; };
  check(px(/:not\(\.on\)\)[^{]*\{[^}]*width:\s*(\d+)px/) >= 32 && px(/:not\(\.on\)\)[^{]*\{[^}]*height:\s*(\d+)px/) >= 32, "S3a ×·압정·휴지통 ≥ 32px");
  check(px(/\.v2-navb[^{]*\{[^}]*min-width:\s*(\d+)px/) >= 36 && px(/\.v2-navb[^{]*\{[^}]*min-height:\s*(\d+)px/) >= 36, "S3b 아이콘 단추 바닥 ≥ 36px");
}

// ── R — 실제 크롬에서 잰 칸 폭 ───────────────────────────────────────────────────────
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 런타임 검증(R)을 건너뜁니다(CHROME_BIN 으로 지정)"); console.log(`\n태블릿 셸 CSS: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`); process.exit(fail ? 1 : 0); }
const cssText = ["01-base.css", "40-v2.css", "43-v2-topbar-search.css", "47-v2-rail.css", "50-mobile.css", "51-tablet.css"]
  .map((f) => (existsSync(path.join(STYLES, f)) ? readFileSync(path.join(STYLES, f), "utf8") : "")).join("\n").replace(/<\/style/gi, "<\\/style");
//  ⚠ 전환을 끈다 — 셸은 `grid-template-columns 160ms` 로 열을 미끄러뜨리므로(47-v2-rail.css:25) 클래스를 바꾼 직후에 재면 **전환 도중 값**을 읽는다
//   (첫 판이 그렇게 6건을 빨갛게 냈다 · 계산된 열 문자열이 클래스를 바꿔도 안 변해 보인다).
const INNER = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${cssText}\nhtml,body{margin:0} *{transition:none !important;animation:none !important}</style>
<div id="v2-root" class="rail-mode"><nav class="v2-rail"><div class="v2-rail-top"></div><div class="v2-rail-mid"><button class="v2-rail-it"><span class="v2-rail-t">세션 목록</span></button></div><div class="v2-rail-foot"></div></nav><nav class="v2-side" id="side"></nav><div class="v2-split" id="s1"></div><main class="v2-main" id="main"></main><div class="v2-split" id="s2"></div><aside class="v2-aside" id="aside"></aside></div>`;
async function PAGE(inner) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = {};
  const probe = async (key, w, { cls = "", style = "" } = {}) => {
    const f = document.createElement("iframe");
    f.style.cssText = `width:${w}px;height:700px;border:0;display:block`;
    f.srcdoc = inner;
    document.body.append(f);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    const D = f.contentDocument, W = f.contentWindow, root = D.getElementById("v2-root");
    if (cls) cls.split(" ").forEach((c) => root.classList.add(c));
    if (style) root.setAttribute("style", style);
    await sleep(40);
    const r = (id) => D.getElementById(id).getBoundingClientRect();
    const rail = D.querySelector(".v2-rail").getBoundingClientRect();
    const side = D.getElementById("side");
    R[key] = {
      rail: Math.round(rail.width), side: Math.round(r("side").width), sideX: Math.round(r("side").left),
      main: Math.round(r("main").width), mainX: Math.round(r("main").left), aside: Math.round(r("aside").width),
      padL: Math.round(parseFloat(W.getComputedStyle(root).paddingLeft) || 0), sideLeft: W.getComputedStyle(side).left,
      railDisp: W.getComputedStyle(D.querySelector(".v2-rail")).display, rootDisp: W.getComputedStyle(root).display,
    };
    f.remove();
  };
  await probe("r1", 1024);
  await probe("r2", 1024, { cls: "no-aside" });
  await probe("b901", 901, { cls: "no-aside" }); await probe("b1180", 1180, { cls: "no-aside" }); await probe("b1181", 1181, { cls: "no-aside" }); await probe("b900", 900, { cls: "no-aside" });
  await probe("r4a", 1024, { cls: "no-aside", style: "--v2-side-w:200px" }); await probe("r4b", 1024, { cls: "no-aside", style: "--v2-side-w:500px" });
  await probe("r5a", 1024, { cls: "no-aside rail-hidden" }); await probe("r5b", 1024, { cls: "no-aside rail-open" });
  await probe("r5c", 1024, { cls: "rail-hidden" }); await probe("r5d", 1024, { cls: "rail-open" });
  await probe("r5e", 1024, { cls: "side-closed rail-open" }); await probe("r5f", 1024, { cls: "app-ctx no-aside rail-hidden" });
  await probe("r6a", 1024, { cls: "side-closed" }); await probe("r6b", 1024, { cls: "app-ctx" });
  await probe("r7", 768, { cls: "no-aside" });
  await probe("r8", 390, { cls: "no-aside" });
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE_HTML = `<!doctype html><meta charset="utf-8"><body><pre id="out">PENDING</pre><script>(${PAGE.toString()})(${JSON.stringify(INNER).replace(/</g, "\\u003c")});</script>`;
const dom = await dumpDom(chrome, { html: PAGE_HTML, prefix: "tablet-shell-", virtualTimeBudget: 30000, args: ["--window-size=1400,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-600)); process.exit(1); }
const R = JSON.parse(m[1]);

check(R.r1.side <= 248 && R.r1.aside <= 300 && R.r1.aside > 0, "R1 1024 + 우패널: 사이드바 ≤248 · 우패널 ≤300", JSON.stringify(R.r1));
near(R.r2.side, 248, 1, "R2a 1024 우패널 없음: 사이드바 = 248");
check(R.r2.main >= 690, "R2b 1024 우패널 없음: 본문 ≥ 690", `본문 ${R.r2.main}`);
check(R.b901.side <= 248, "R3a 901: 상한을 받는다", `사이드바 ${R.b901.side}`);
check(R.b1180.side <= 248, "R3b 1180: 상한을 받는다", `사이드바 ${R.b1180.side}`);
near(R.b1181.side, 316, 1, "R3c 1181: 상한 없이 316 그대로(데스크톱)");
check(R.b900.rootDisp === "flex" && R.b900.side !== 248, "R3d 900: 그리드가 아니라 서랍 셸(flex)", JSON.stringify(R.b900));
near(R.r4a.side, 200, 1, "R4a 줄여 둔 폭(200)은 그대로");
near(R.r4b.side, 248, 1, "R4b 넓혀 둔 폭(500)은 248 로 상한");
near(R.r5a.sideX, 0, 1, "R5a 레일 숨김: 사이드바가 x=0 에서 시작");
near(R.r5b.sideX, 232, 1, "R5b 레일 펼침(232): 사이드바가 232 에서 시작");
near(R.r5c.sideX, 0, 1, "R5c 레일 숨김 + 우패널 있음(기본 규칙): 사이드바가 x=0 에서 시작");
near(R.r5d.sideX, 232, 1, "R5d 레일 펼침 + 우패널 있음(기본 규칙): 사이드바가 232 에서 시작");
near(R.r5e.mainX, 232, 1, "R5e 레일 펼침 + 사이드바 접힘: 본문이 232 에서 시작");
near(R.r5f.mainX, 0, 1, "R5f 레일 숨김 + 맥락 앱(우패널 없음): 본문이 x=0 에서 시작");
check(R.r6a.aside <= 300 && R.r6a.side === 0, "R6a 사이드바 접힘 + 우패널: 우패널 ≤300 · 사이드바 열 0", JSON.stringify(R.r6a));
check(R.r6b.aside <= 300 && R.r6b.side === 0, "R6b 맥락 앱 + 우패널: 우패널 ≤300 · 사이드바 열 0", JSON.stringify(R.r6b));
check(R.r7.padL === 64 && R.r7.rail === 64 && R.r7.sideLeft === "64px", "R7 768: 여백 = 레일 폭 = 서랍 left = 64", JSON.stringify(R.r7));
check(R.r8.railDisp === "none" && R.r8.padL === 0, "R8 390(폰): 레일 없음 · 여백 0", JSON.stringify(R.r8));

console.log(`\n태블릿 셸 CSS: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
