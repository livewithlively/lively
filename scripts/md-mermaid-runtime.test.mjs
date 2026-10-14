#!/usr/bin/env node
// 본문 속 ```mermaid 를 그림으로(#4685, 상민 2026-10-14 «프로젝트나 태스크 본문에 mermaid 그래프 … 렌더좀 되게해줘. 지식이나 자료 md 뷰어도»)
//  종전: renderMarkdown 은 코드 펜스의 언어를 보지 않고 전부 <pre> 로 그렸다 — mermaid 도 코드 글자로만 보였다.
//  이제 ```mermaid 는 격리 프레임(sandbox=allow-scripts)이 그린 svg 를 <img> 로 띄운다(web/lib/mermaid.ts 머리말).
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  R1  닫힌 ```mermaid(앱 토큰 CSS 없는 문서 포함) → 그림 칸 · data:image/svg+xml 그림이 실제로 그려진다
//  R2  한글 라벨이 그림(svg)에 그대로 남는다
//  R3  ~~~mermaid · ```Mermaid(대문자) · ```mermaid 뒤 꼬리말 → 그림
//  R4  안 닫힌 펜스 → 코드 그대로(쓰는 중이거나 잘린 본문)          R5 빈 ```mermaid(공백뿐) → 코드 그대로
//  R6  ```js → 코드 그대로
//  R7  문법 오류 → is-err · «문법을 읽지 못했습니다» + 줄 번호 · 코드가 칸 안에 보인다 · 그림 없음
//  R8  라벨 HTML 공격(<img onerror> · <script> · click javascript:) → 그림에 on*·script·javascript: 없음 · 부모 창 흔적 없음
//  R9  그리는 프레임은 하나 · sandbox 가 정확히 «allow-scripts» · 부모 문서에 svg 를 심지 않는다
//  R10 같은 본문을 다시 렌더 → 기다림 없이 바로 그림(캐시)
//  R11 테마가 바뀌면(lv:theme-change) 떠 있는 그림을 새 토큰 색으로 다시 그린다
//  R12 에디터 미리보기 — 맞는 코드 → 틀린 코드 → [코드 편집]: onState true→false · 틀릴 때 직전 그림 유지 · onEdit 1회 · contenteditable=false
//  R13 도구(mermaid.min.js)가 없는 자리 → 코드 그대로 + «불러오지 못해» 한 줄
//  R14 그리는 프레임이 다른 문서로 옮겨 가면 → 옮겨 간 문서는 다음 그림의 코드를 못 받는다 · 새 프레임이 그린다
//  R15 에디터 미리보기에 빈 코드 → «코드를 적으면…» · 그림 없음 · onState(false)
//  B1~B4 본문 칸 폭 정책(경계): 칸이 넓으면 원래 폭 · 0.7배~원래 폭 사이면 칸에 맞춤 · 칸=ceil(0.7배)이면 그 값 · 더 좁으면 0.7배(가로로 민다)
//  E1  블록 에디터 — 그림이 서서 코드 칸이 접힌 채로도 저장 마크다운 = 원문(코드 칸을 숨기는 방식이 innerText 를 바꾸면 여기서 깨진다)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const VENDOR = path.join(ROOT, "node_modules/mermaid/dist/mermaid.min.js");

const chrome = findChrome();
if (!chrome || typeof WebSocket === "undefined") {
  console.log("skip  크롬(또는 WebSocket 전역)이 없어 건너뜁니다(CHROME_BIN 으로 지정) — mermaid 렌더 런타임 검증 미실행");
  process.exit(0);
}
if (!existsSync(VENDOR)) {
  console.log("skip  node_modules/mermaid 가 없어 건너뜁니다(`npm ci` 먼저) — mermaid 렌더 런타임 검증 미실행");
  process.exit(0);
}

//  프로덕션 소스를 그대로 한 묶음으로(모듈 상태 — 그리는 프레임 — 가 하나여야 R9 가 뜻이 있다).
//  수정 전 판(mermaid.ts 없음)도 묶이게 mermaidPreview 는 있을 때만 싣는다(fail-first).
//  import.meta.url 은 iife 에 없다 → 시험 페이지가 정한 주소(globalThis.__MMD_URL__)로 바꿔 끼운다. 그 주소 기준
//  '../vendor/mermaid/mermaid.min.js' 를 아래 작은 http 서버가 내준다(실서비스의 app/lib → app/vendor 배치와 같은 모양).
//  ⚠ file:// 로 내주면 안 된다 — 불투명 오리진(격리) 프레임은 file:// 스크립트를 싣지 못한다(2026-10-14 실측: «불러오지 못해»).
//   실서비스도 http(s) 다.
//  ⚠ 구식 헤드리스(--dump-dom · headless-chrome.mjs)를 쓰지 않는다 — 가상 시간이 다른 프로세스(격리 프레임)의 일을 기다리지
//   않고 타이머를 당겨, mermaid 를 싣는 동안 «준비» 상한이 먼저 터졌다(2026-10-14 실측). frame-scroll-keep 처럼 headless=new + CDP 로
//   **실제 시간**에 결과 표지를 기다린다.
const hasMermaid = existsSync(path.join(SRC_ROOT, "web/lib/mermaid.ts"));
const bundle = buildSync({
  stdin: {
    contents: "export { renderMarkdown } from './web/lib/markdown.ts'; export { createBlockEditor } from './web/block-editor.ts';"
      + (hasMermaid ? " export { mermaidPreview } from './web/lib/mermaid.ts';" : ""),
    resolveDir: SRC_ROOT, loader: "ts",
  },
  bundle: true, format: "iife", globalName: "MD", write: false, platform: "browser", target: "es2020", logLevel: "silent",
  define: { "import.meta.url": "globalThis.__MMD_URL__" },
}).outputFiles[0].text;
//  E1 은 실제 CSS(코드 칸 접기 규칙)가 있어야 뜻이 있다 — 서빙하는 스타일 그대로 싣는다.
const CSS = ["03-components.css", "21-wiki-notion.css"].map((f) => readFileSync(path.join(SRC_ROOT, "public/styles", f), "utf8")).join("\n");

const VENDOR_JS = readFileSync(VENDOR);
const served = [];   // 배선 — 프레임이 실제로 무엇을 받아 갔나(주소)
const srv = http.createServer((req, res) => {
  const u = String(req.url || "");
  served.push(u);
  if (u === "/main.html" || u === "/bad.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(u === "/main.html" ? page(PAGE_MAIN, GOOD_URL) : page(PAGE_BAD, BAD_URL));
    return;
  }
  if (u.split("?")[0] === "/app/vendor/mermaid/mermaid.min.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
    res.end(VENDOR_JS);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${srv.address().port}`;
const GOOD_URL = ORIGIN + "/app/lib/mermaid.js?v=t1";      // 판 표지(?v=)도 실서비스처럼 — vendor 주소에 이어 붙는지 본다
const BAD_URL = ORIGIN + "/nowhere/lib/mermaid.js";        // ../vendor 가 없는 자리(404)

const MD = [
  "```mermaid", "sequenceDiagram", "  participant U as 사용자", "  participant G as 게이트웨이", "  U->>G: 본문 열기", "```", "",
  "~~~mermaid", "graph LR", "  A[물결] --> B[펜스]", "~~~", "",
  "```Mermaid title", "graph TD", "  C[대문자] --> D[꼬리말]", "```", "",
  "```mermaid", "graph LR", "  A -->", "  B -->> C(((", "```", "",
  "```mermaid", "graph LR", "  X[\"<img src=x onerror=parent.__pwned=1>\"] --> Y[\"<script>parent.__pwned=2</script>\"]",
  "  click X \"javascript:parent.__pwned=3\"", "```", "",
  "```mermaid", "   ", "```", "",
  "```js", "console.log('그대로');", "```", "",
  "```mermaid", "graph LR", "  Z --> W",
].join("\n");
const EDIT_MD = ["앞 문단입니다.", "", "```mermaid", "graph LR", "  A[시작] --> B{확인}", "  B -- 예 --> C[끝]", "```", "", "뒤 문단입니다."].join("\n");

async function PAGE_MAIN() {
  const R = {};
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 20000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(30); } return false; };
  globalThis.__MMD_URL__ = document.getElementById("mmdurl").textContent;
  (0, eval)(document.getElementById("mdsrc").textContent);
  const M = window.MD;
  const host = document.getElementById("host");
  const md = document.getElementById("md").textContent;
  const settled = (f) => /\bis-(ok|err)\b/.test(f.className);
  const svgOf = (im) => { const src = (im && im.getAttribute("src")) || ""; try { return decodeURIComponent(src.slice(src.indexOf(",") + 1)); } catch (_) { return ""; } };
  //  그림 안의 «실제로 도는» 것 — 글자 grep 이 아니라 XML 로 읽어 요소·속성을 본다(mermaid 는 라벨 HTML 을 글자로
  //   이스케이프해 남기므로 «onerror» 라는 글자 자체는 무해하게 들어 있을 수 있다). XML 로 안 읽히면 그것도 결함이다(<img> 가 빈다).
  const dangerous = (svg) => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (doc.getElementsByTagName("parsererror").length) return ["parsererror"];
    const out = [];
    for (const n of doc.getElementsByTagName("*")) {
      if (n.localName.toLowerCase() === "script") out.push("script");
      for (const a of n.attributes) {
        if (/^on/i.test(a.name)) out.push(n.localName + "@" + a.name);
        if (/(^|:)(href|src|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) out.push(n.localName + "@" + a.name + "=javascript:");
      }
    }
    return out;
  };
  const spy = [];
  window.addEventListener("message", (e) => { if (e.data && typeof e.data === "object" && "spy" in e.data) spy.push(String(e.data.spy)); });
  try {
    const root = M.renderMarkdown(md);
    host.append(root);
    const figs = () => [...root.querySelectorAll("figure.md-mermaid")];
    R.figCount = figs().length;
    R.pres = [...root.children].filter((n) => n.tagName === "PRE").map((p) => p.textContent.trim().slice(0, 24));
    //  화면에 들어와야 그린다(IntersectionObserver) — 하나씩 보이게 하며 기다린다.
    for (const f of figs()) { f.scrollIntoView(); await waitFor(() => settled(f)); }
    R.figs = figs().map((f) => {
      const im = f.querySelector("img.md-mermaid-img");
      const svg = svgOf(im);
      const code = f.querySelector(".md-mermaid-code");
      return {
        cls: f.className, w: im ? im.naturalWidth : 0, isData: !!im && (im.getAttribute("src") || "").startsWith("data:image/svg+xml"),
        note: f.querySelector(".md-mermaid-note").textContent, code: code ? code.textContent : "",
        codeShown: !!code && getComputedStyle(code).display !== "none",
        bad: svg ? dangerous(svg) : [], payload: svg.includes("__pwned"), svgHas: ["사용자", "물결", "대문자"].filter((k) => svg.includes(k)),
      };
    });
    R.frames = [...document.querySelectorAll("iframe")].map((f) => f.getAttribute("sandbox"));
    R.inlineSvg = host.querySelectorAll("svg").length;
    R.pwned = window.__pwned || null;

    //  B1~B4 — 같은 그림을 칸 폭만 바꿔 가며 잰다(그림 폭 W 는 실측 — 글꼴이 다른 기계에서도 정책만 본다).
    //  «칸 폭» = 그림 칸 안쪽 폭(여백·테두리 뺀 것) — 그 폭을 원하는 값으로 맞춰 가며 그림 폭을 잰다.
    const im0 = figs()[0].querySelector("img.md-mermaid-img");
    const view0 = figs()[0].querySelector(".md-mermaid-view");
    if (im0 && view0) {
      const W = im0.naturalWidth;
      const vs = getComputedStyle(view0);
      const inner = () => view0.clientWidth - parseFloat(vs.paddingLeft) - parseFloat(vs.paddingRight);
      const extra = host.clientWidth - inner();
      const at = (cw) => { host.style.width = (cw + extra) + "px"; return { cw: Math.round(inner()), w: Math.round(im0.getBoundingClientRect().width) }; };
      R.widths = { W, b1: at(W + 100), b2: at(Math.round(W * 0.85)), b3: at(Math.ceil(W * 0.7)), b4: at(Math.round(W * 0.5)) };
      host.style.width = "760px";
    }

    const again = M.renderMarkdown(md);
    R.cachedNow = [...again.querySelectorAll("figure.md-mermaid")].map((f) => (/\bis-ok\b/.test(f.className) ? "ok" : /\bis-err\b/.test(f.className) ? "err" : "wait"));

    const first = figs()[0];
    const before = first.querySelector("img").getAttribute("src");
    document.documentElement.style.setProperty("--ink", "#123456");
    document.documentElement.setAttribute("data-theme", "dark");
    document.dispatchEvent(new CustomEvent("lv:theme-change"));
    await waitFor(() => { const im = first.querySelector("img"); return !!im && im.getAttribute("src") !== before; });
    const im2 = first.querySelector("img");
    R.repaint = { changed: !!im2 && im2.getAttribute("src") !== before, hasInk: svgOf(im2).includes("#123456") };
  } catch (e) { R.errA = String(e && e.stack || e); }

  try {
    if (typeof M.mermaidPreview === "function") {
      const states = [];
      let edited = 0;
      const pv = M.mermaidPreview({ onEdit: () => { edited++; }, onState: (ok) => states.push(ok) });
      host.append(pv.el);
      pv.el.scrollIntoView();
      pv.set("graph TD\n  P[가] --> Q[나]");
      await waitFor(() => settled(pv.el));
      const ok1 = pv.el.className;
      pv.set("graph TD\n  P[가] -->> (((");
      await waitFor(() => /\bis-err\b/.test(pv.el.className));
      const editBtn = [...pv.el.querySelectorAll("button")].find((b) => b.textContent === "코드 편집");
      if (editBtn) editBtn.click();
      R.pv = { ok1, err: pv.el.className, keptImg: !!pv.el.querySelector("img.md-mermaid-img"), states, edited,
        ce: pv.el.getAttribute("contenteditable"), note: pv.el.querySelector(".md-mermaid-note").textContent };

      const st0 = [];
      const pv0 = M.mermaidPreview({ onEdit: () => {}, onState: (ok) => st0.push(ok) });
      host.append(pv0.el);
      pv0.el.scrollIntoView();
      pv0.set("   ");
      await waitFor(() => st0.length > 0, 5000);
      R.pv0 = { states: st0, note: pv0.el.querySelector(".md-mermaid-note").textContent, img: !!pv0.el.querySelector("img") };
    } else R.pv = "mermaidPreview 없음";
  } catch (e) { R.errB = String(e && e.stack || e); }

  try {
    //  R14 — 그리는 프레임을 다른 문서로 옮긴다(공격자가 프레임 안에서 할 법한 일을 밖에서 흉내). 옮겨 간 문서는 받는 말을
    //   모두 부모에게 «spy» 로 되돌린다. 그 뒤 새 그림을 그리게 하고, 그 코드가 옮겨 간 문서에 닿았는지 본다.
    const fr = document.querySelector("iframe");
    if (fr) {
      fr.srcdoc = "<script>addEventListener('message',function(e){parent.postMessage({spy:JSON.stringify(e.data)},'*')});"
        + "parent.postMessage({spy:'up'},'*')<\/script>";
      await waitFor(() => spy.includes("up") || !fr.isConnected, 5000);
      const r2 = M.renderMarkdown("```mermaid\ngraph LR\n  S1[비밀코드] --> S2[끝]\n```");
      host.append(r2);
      const f2 = r2.querySelector("figure.md-mermaid");
      f2.scrollIntoView();
      await waitFor(() => settled(f2), 30000);
      await sleep(300);
      R.hijack = { spy: spy.slice(0, 5), leaked: spy.some((s) => s.includes("비밀코드")), cls: f2.className,
        frames: document.querySelectorAll("iframe").length, oldGone: !fr.isConnected };
    } else R.hijack = "프레임 없음";
  } catch (e) { R.errC = String(e && e.stack || e); }

  try {
    //  E1 — 블록 에디터. 그림이 서면 코드 칸이 접힌다(CSS) — 그 상태로 저장 마크다운을 뽑는다.
    const emd = document.getElementById("emd").textContent;
    const ed = M.createBlockEditor({ initial: emd });
    host.append(ed.el);
    const blk = ed.el.querySelector('.be-block[data-type="code"]');
    if (blk) blk.scrollIntoView();
    await waitFor(() => !!blk && blk.classList.contains("be-mmd-ok"), 20000);
    const wrap = blk && blk.querySelector(".be-codewrap");
    R.e1 = { collapsed: !!blk && blk.classList.contains("be-mmd-ok"), wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : -1,
      fig: !!(blk && blk.querySelector("figure.md-mermaid img")), md: ed.getMarkdown() };
  } catch (e) { R.errD = String(e && e.stack || e); }

  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

//  도구를 못 싣는 페이지 — 주소만 다르다(../vendor 가 없는 자리).
async function PAGE_BAD() {
  const R = {};
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  globalThis.__MMD_URL__ = document.getElementById("mmdurl").textContent;
  (0, eval)(document.getElementById("mdsrc").textContent);
  try {
    const root = window.MD.renderMarkdown("```mermaid\ngraph LR\n  A[가] --> B[나]\n```");
    document.getElementById("host").append(root);
    const f = root.querySelector("figure.md-mermaid");
    R.fig = !!f;
    const t0 = performance.now();
    while (f && !/\bis-(ok|err)\b/.test(f.className) && performance.now() - t0 < 25000) await sleep(50);
    if (f) {
      const code = f.querySelector(".md-mermaid-code");
      R.cls = f.className;
      R.note = f.querySelector(".md-mermaid-note").textContent;
      R.codeShown = !!code && getComputedStyle(code).display !== "none" && code.textContent.includes("A[가]");
    }
  } catch (e) { R.err = String(e && e.stack || e); }
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const page = (main, url) => `<!doctype html><html><meta charset="utf-8"><style>${CSS}</style>
<pre id="out">PENDING</pre><div id="toasts"></div><div id="host" style="width:760px"></div>
<script type="text/plain" id="mmdurl">${url}</script>
<script type="text/plain" id="md">${esc(MD)}</script>
<script type="text/plain" id="emd">${esc(EDIT_MD)}</script>
<script type="text/plain" id="mdsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${main.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

let R, B, runErr = null;
const dir = mkdtempSync(path.join(tmpdir(), "md-mermaid-"));
const child = spawn(chrome, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  // ⚠ 맥에서 새 프로필 크롬이 «키체인» 모달을 사람 화면에 띄우지 않게(headless-chrome.mjs 와 같은 이유)
  "--use-mock-keychain", "--password-store=basic", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--disable-extensions", "--mute-audio", "--disable-breakpad",
  `--user-data-dir=${path.join(dir, "profile")}`, "--remote-debugging-port=0", "--window-size=1280,900", "about:blank",
], { env: { ...process.env, HOME: dir }, stdio: ["ignore", "ignore", "ignore"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws = null;
try {
  const pf = path.join(dir, "profile", "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(pf); i++) await sleep(50);
  if (!existsSync(pf)) throw new Error("크롬 디버깅 포트가 안 열렸다");
  const port = readFileSync(pf, "utf8").split("\n")[0];
  let targets = [];
  for (let i = 0; i < 40 && !targets.some((t) => t.type === "page"); i++) {
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
    if (!targets.some((t) => t.type === "page")) await sleep(100);
  }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
  await cdp("Page.enable");
  //  결과 표지(ENDRESULT)가 설 때까지 실제 시간으로 기다린다 — 장면 하나에 상한 120초.
  const run = async (url, tag) => {
    await cdp("Page.navigate", { url });
    const t0 = Date.now();
    let out = "";
    while (Date.now() - t0 < 120_000) {
      out = String((await ev("(document.getElementById('out') || {}).textContent")) || "");
      if (out.endsWith("ENDRESULT")) break;
      await sleep(150);
    }
    if (!out.endsWith("ENDRESULT")) throw new Error(`${tag}: 페이지가 결과를 안 냈다 — ${out.slice(0, 300)}`);
    return JSON.parse(out.slice(0, -"ENDRESULT".length));
  };
  R = await run(ORIGIN + "/main.html", "본 장면");
  B = await run(ORIGIN + "/bad.html", "도구 없음 장면");
} catch (e) {
  runErr = e;
} finally {
  try { ws?.close(); } catch (_) { /* 이미 닫혔다 */ }
  child.kill("SIGKILL");
  srv.close();
  await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("close", r)));
  for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (_) { await sleep(200); } }
}
if (runErr) { console.error("FAIL  " + String(runErr && runErr.stack || runErr)); process.exit(1); }
if (process.env.DEBUG) console.log(JSON.stringify({ R, B, served }, null, 1));

let pass = 0, fail = 0;
const J = (v) => JSON.stringify(v);
const check = (cond, n, why) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
for (const k of ["fatal", "errA", "errB", "errC", "errD"]) if (R[k]) check(false, `장면 오류 ${k}`, R[k].slice(0, 400));
if (B.fatal || B.err) check(false, "장면 오류(도구 없음)", String(B.fatal || B.err).slice(0, 400));

const F = R.figs || [];
const drawn = (f) => !!f && /\bis-ok\b/.test(f.cls) && f.isData && f.w > 0;
check(served.some((u) => u === "/app/vendor/mermaid/mermaid.min.js?v=t1"), "W0 배선 — 프레임이 도구를 판 표지(?v=)째 받아 갔다", J(served));
check(R.figCount === 5, "W1 배선 — 닫히고 비지 않은 ```mermaid 다섯이 그림 칸이 됐다", J({ figCount: R.figCount, pres: R.pres }));
check(drawn(F[0]), "R1 ```mermaid → data:image/svg+xml 그림이 실제로 그려진다(토큰 CSS 없음)", J(F[0]));
check(!!F[0] && F[0].svgHas.includes("사용자"), "R2 한글 라벨이 그림에 남는다", J(F[0] && F[0].svgHas));
check(drawn(F[1]) && F[1].svgHas.includes("물결") && drawn(F[2]) && F[2].svgHas.includes("대문자"), "R3 ~~~mermaid · ```Mermaid 꼬리말 → 그림", J([F[1], F[2]]));
check((R.pres || []).some((t) => t.startsWith("graph LR") && t.includes("Z --> W")), "R4 안 닫힌 펜스는 코드 그대로", J(R.pres));
check((R.pres || []).includes(""), "R5 빈 ```mermaid 는 코드 그대로", J(R.pres));
check((R.pres || []).some((t) => t.startsWith("console.log")), "R6 ```js 는 코드 그대로", J(R.pres));
const E = F[3];
check(!!E && /\bis-err\b/.test(E.cls) && /^다이어그램 문법을 읽지 못했습니다/.test(E.note) && /line 3/.test(E.note) && E.codeShown && E.code.includes("B -->> C(((") && !E.w,
  "R7 문법 오류 → 까닭 한 줄(줄 번호) + 코드 그대로 · 그림 없음", J(E));
const X = F[4];
check(drawn(X) && X.payload && J(X.bad) === "[]" && R.pwned === null && F.every((f) => J(f.bad) === "[]"),
  "R8 라벨 HTML 공격 → 그림(XML)에 script 요소·on* 속성·javascript: 주소 없음 · 부모 흔적 없음(공격 글은 그림까지 갔다)", J({ X, pwned: R.pwned }));
check(J(R.frames) === J(["allow-scripts"]) && R.inlineSvg === 0, "R9 프레임 하나 · sandbox=allow-scripts 만 · 부모 문서에 svg 없음", J({ frames: R.frames, inlineSvg: R.inlineSvg }));
const Wd = R.widths || {};
const near = (a, b) => Math.abs(a - b) <= 1;
const b = (k) => Wd[k] || { cw: -1, w: -1 };
check(Wd.W > 0 && b("b1").cw > Wd.W && near(b("b1").w, Wd.W), "B1 칸이 그림보다 넓으면 원래 폭(키우지 않는다)", J(Wd));
check(Wd.W > 0 && b("b2").cw < Wd.W && near(b("b2").w, b("b2").cw), "B2 0.7배~원래 폭 사이면 칸 폭에 맞춘다", J(Wd));
check(Wd.W > 0 && near(b("b3").cw, Math.ceil(Wd.W * 0.7)) && near(b("b3").w, b("b3").cw), "B3 칸 = ceil(0.7×폭) 경계 → 칸에 꼭 맞는다(가로 스크롤 없음)", J(Wd));
check(Wd.W > 0 && near(b("b4").w, Math.ceil(Wd.W * 0.7)) && b("b4").w > b("b4").cw + 1, "B4 칸이 더 좁으면 0.7배에서 멈추고 가로로 민다", J(Wd));
check(J(R.cachedNow) === J(["ok", "ok", "ok", "err", "ok"]), "R10 같은 본문 다시 렌더 — 렌더 직후 바로 그림(캐시)", J(R.cachedNow));
check(!!R.repaint && R.repaint.changed && R.repaint.hasInk, "R11 테마가 바뀌면 새 토큰 색으로 다시 그린다", J(R.repaint));
const P = R.pv || {};
check(typeof P === "object" && /\bis-ok\b/.test(P.ok1 || "") && /\bis-err\b/.test(P.err || "") && P.keptImg && J(P.states) === J([true, false]) && P.edited === 1 && P.ce === "false",
  "R12 에디터 미리보기 — onState(true→false) · 오류 때 직전 그림 유지 · [코드 편집]=onEdit", J(P));
check(B.fig === true && /\bis-err\b/.test(B.cls || "") && /불러오지 못해/.test(B.note || "") && B.codeShown === true,
  "R13 도구를 못 실으면 코드 그대로 + «불러오지 못해»", J(B));
const H = R.hijack || {};
check(typeof H === "object" && H.spy && H.spy.includes("up") && !H.leaked && /\bis-ok\b/.test(H.cls || "") && H.oldGone && H.frames === 1,
  "R14 옮겨 간 프레임 문서는 다음 코드를 못 받는다 · 새 프레임이 그린다(옮겨 간 문서가 실제로 돌았음 = spy 'up')", J(H));
const P0 = R.pv0 || {};
check(J(P0.states) === J([false]) && /^코드를 적으면/.test(P0.note || "") && P0.img === false, "R15 에디터 미리보기 빈 코드 → 안내 · 그림 없음 · onState(false)", J(P0));
const E1 = R.e1 || {};
check(E1.collapsed && E1.wrapH === 0 && E1.fig && (E1.md || "").trim() === EDIT_MD.trim(),
  "E1 코드 칸이 접힌 채로도 저장 마크다운 = 원문", J({ ...E1, want: EDIT_MD }));

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
