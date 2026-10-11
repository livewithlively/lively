#!/usr/bin/env node
// md 파일 뷰어의 상대경로 그림(#4582, 상민 2026-10-06 «md파일 뷰어에 png렌더가 안되는데 이거 되게좀해주삼»)
//  종전: `![](img/a.png)` 를 <img src="img/a.png"> 로 그대로 넣어 브라우저가 **앱 페이지 주소** 기준으로 풀었다
//   → 엉뚱한 주소(그리고 인증 없음)라 그림이 깨졌다. 이제 파일을 아는 화면이 fetchRel 을 주면 md 파일 폴더 기준으로 받는다.
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  R1 같은 폴더 하위(img/a.png) → 'docs/img/a.png' 로 받는다 · 그림이 실제로 그려진다(naturalWidth)
//  R2 ../ 로 루트까지 정확히 올라간다(../top.png) → 'top.png'
//  R3 ./ · %20 · "제목" 꼬리 → 'docs/img/a b.png' (제목은 떼고 % 는 푼다)
//  R4 <꺾쇠 감싼 주소> 공백 포함 → 'docs/img/c d.png'
//  R5 루트 위로 넘어감(../../x.png) → 받지 않고 «불러오기 실패» 표시
//  R6 data:image/png → 그대로 그린다(fetchRel 안 부름) · data:text/html 은 거부(그림 아님 — 대체 글자만)
//  R7 https 절대주소 → 그대로 src (fetchRel 안 부름)
//  R8 fetchRel 이 404 → md-img-missing
//  R9 imgFetch 없이 그린 md(지식·위키) → 종전 그대로 src="img/a.png" — 앞 렌더의 받는 법이 새지 않는다
//  R10 joinRel 순수 함수 표(루트 경계 · 루트 위 · 앞 / 는 지킨다 · ./..)
//  R11 받는 법(fetchRel)은 있는데 파일 좌표(path)가 없다 → 받지 않고 종전 그대로
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — md 상대경로 그림 런타임 검증 미실행");
  process.exit(0);
}

//  프로덕션 소스를 그대로 묶는다. joinRel 이 없는 판(수정 전)도 묶이게 네임스페이스로 받는다.
const bundle = buildSync({
  stdin: {
    contents: "export * as FP from './web/lib/file-preview.ts'; export { renderMarkdown } from './web/lib/markdown.ts';",
    resolveDir: SRC_ROOT, loader: "ts",
  },
  bundle: true, format: "iife", globalName: "MD", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = {};
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  (0, eval)(document.getElementById("mdsrc").textContent);
  const M = window.MD;
  const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 4; c.height = 3; c.toBlob((b) => res(b), "image/png"); });
  const PNG_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const md = [
    "![a](img/a.png)",
    "![b](../top.png)",
    "![c](./img/a%20b.png \"제목\")",
    "![d](<img/c d.png>)",
    "![e](../../escape.png)",
    "![f](" + PNG_DATA + ")",
    "![gee](data:text/html;base64,PHNjcmlwdD4=)",
    "![h](https://example.invalid/z.png)",
    "![i](img/missing.png)",
  ].join("\n\n");
  const mkBtn = (label, onClick) => { const b = document.createElement("button"); b.textContent = label; b.onclick = onClick; return b; };
  const snap = (root) => [...root.querySelectorAll("img")].map((im) => ({
    key: im.dataset.mdSrc || "", src: (im.getAttribute("src") || "").slice(0, 22), miss: im.classList.contains("md-img-missing"), w: im.naturalWidth,
  }));
  const asked = [];
  try {
    const out = await M.FP.buildFilePreview({
      name: "report.md", path: "docs/report.md",
      fetchView: async () => new Response(md),
      fetchDownload: async () => new Response(md),
      fetchRel: async (p) => { asked.push(p); return p.endsWith("missing.png") ? new Response("no", { status: 404 }) : new Response(png); },
      mkBtn,
    });
    document.body.append(out.body);
    //  그림이 다 서거나(그려짐·실패) 시간이 다 될 때까지 — 고정 시간 대신 조건으로 기다린다.
    await waitFor(() => [...out.body.querySelectorAll("img")].every((im) => im.classList.contains("md-img-missing") || (im.complete && im.naturalWidth > 0) || /^https:/.test(im.getAttribute("src") || "")));
    R.asked = asked;
    R.imgs = snap(out.body);
    R.texts = out.body.textContent;
  } catch (e) { R.errA = String(e && e.stack || e); }

  try {
    const plain = M.renderMarkdown("![a](img/a.png)");
    R.plain = plain.querySelector("img") ? plain.querySelector("img").getAttribute("src") : null;
  } catch (e) { R.errB = String(e && e.stack || e); }

  try {
    const J = M.FP.joinRel;
    R.join = typeof J === "function"
      ? [J("docs/a.md", "b.png"), J("docs/a.md", "../b.png"), J("a.md", "./x/../y.png"), J("a.md", "../b.png"), J("/abs/d/a.md", "e.png"), J("a/b/c.md", "../../z/./w.png")]
      : "joinRel 없음";
  } catch (e) { R.errC = String(e && e.stack || e); }

  try {
    const asked2 = [];
    const out2 = await M.FP.buildFilePreview({
      name: "x.md", fetchView: async () => new Response("![a](img/a.png)"), fetchDownload: async () => new Response(""),
      fetchRel: async (p) => { asked2.push(p); return new Response(png); }, mkBtn,
    });
    await sleep(100);
    const im = out2.body.querySelector("img");
    R.nopath = { asked: asked2, src: im ? im.getAttribute("src") : null };
  } catch (e) { R.errD = String(e && e.stack || e); }

  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html><meta charset="utf-8"><pre id="out">PENDING</pre>
<script type="text/plain" id="mdsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "md-relimg-", virtualTimeBudget: 10000 });
const m = /<pre id="out">([\s\S]*?)ENDRESULT/.exec(dom);
if (!m) { console.error("FAIL  페이지가 결과를 안 냈다\n" + dom.slice(0, 1500)); process.exit(1); }
const R = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const J = (v) => JSON.stringify(v);
const check = (cond, n, why) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — ${why}`); } };
for (const k of ["fatal", "errA", "errB", "errC", "errD"]) if (R[k]) check(false, `장면 오류 ${k}`, R[k].slice(0, 400));

//  그림은 md 에 적힌 원래 주소(data-md-src)로 찾는다 — alt 는 실패 시 문구가 바뀐다.
const imgs = R.imgs || [];
const img = (prefix) => imgs.find((x) => x.key.startsWith(prefix)) || null;
const drawn = (x) => !!x && /^blob:/.test(x.src) && x.w === 4 && !x.miss;
const asked = R.asked || [];
check(imgs.length === 8, "W1 배선 — md 의 그림 여덟(거부된 data:text/html 빼고)이 섰다", J(imgs.map((x) => x.key)));
check(asked.includes("docs/img/a.png") && drawn(img("img/a.png")), "R1 같은 폴더 하위 → docs/img/a.png 로 받아 그린다", J({ asked, a: img("img/a.png") }));
check(asked.includes("top.png") && drawn(img("../top.png")), "R2 ../ 로 루트까지 → top.png", J({ asked, b: img("../top.png") }));
check(asked.includes("docs/img/a b.png") && drawn(img("./img/a%20b.png")), "R3 ./ · %20 · \"제목\" 꼬리 → docs/img/a b.png", J({ asked, c: img("./img/a%20b") }));
check(asked.includes("docs/img/c d.png") && drawn(img("img/c d.png")), "R4 <꺾쇠 주소> → docs/img/c d.png", J({ asked, d: img("img/c d.png") }));
check(!asked.some((p) => /escape/.test(p)) && !!img("../../escape") && img("../../escape").miss, "R5 루트 위로 넘어가면 받지 않고 «불러오기 실패»", J({ asked, e: img("../../escape") }));
check(!!img("data:image/png") && img("data:image/png").w === 1, "R6a data:image/png 는 그대로 그린다", J(img("data:image/png")));
check(!img("data:text") && /gee/.test(R.texts || ""), "R6b data:text/html 은 그림으로 받지 않는다(대체 글자만)", J(img("data:text")));
check(!!img("https:") && img("https:").src.startsWith("https://example.inval") && !asked.some((p) => /example/.test(p)), "R7 https 절대주소는 그대로 src · fetchRel 안 부름", J(img("https:")));
check(asked.includes("docs/img/missing.png") && !!img("img/missing") && img("img/missing").miss, "R8 fetchRel 404 → md-img-missing", J(img("img/missing")));
check(asked.length === 5, "R1~R8 fetchRel 은 상대경로 다섯에만 불렸다", J(asked));
check(R.plain === "img/a.png", "R9 imgFetch 없이 그린 md 는 종전 그대로(앞 렌더의 받는 법이 새지 않는다)", J(R.plain));
check(J(R.join) === J(["docs/b.png", "b.png", "y.png", null, "/abs/d/e.png", "z/w.png"]), "R10 joinRel 표", J(R.join));
check(!!R.nopath && R.nopath.asked.length === 0 && R.nopath.src === "img/a.png", "R11 path 없이 fetchRel 만 → 받지 않고 종전 그대로", J(R.nopath));

console.log(fail ? `\n${fail}건 실패 · ${pass}건 통과` : `\n${pass}건 통과`);
process.exit(fail ? 1 : 0);
